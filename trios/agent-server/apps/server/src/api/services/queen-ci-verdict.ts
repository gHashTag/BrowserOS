/**
 * A REQUIRED CHECK THAT REFUSES THE PULL REQUEST TAKES THE ACCEPTANCE BACK.
 *
 * The review accepts a bee's work in the container; the work lands only when
 * its pull request passes the repository's required checks. Nothing connected
 * the two. Measured 2026-09-22 on gHashTag/t27: the review accepted #4385
 * ("t27c 0.2.0", machineUnmet=0), publish opened #4578 for it, and the
 * required `parse-ratchet` refused it -
 *
 *   this spec parsed at the base and does not now -- Parse error in fn
 *   'is_coq' near line 17: unexpected token after expression statement
 *
 * - so the pull request sat red for ever, the issue stayed open with an
 * `accept` on it, and the Queen skipped it every round as "the work already
 * landed". 42 issues were in that state while the swarm ran 2 bees of 20. No
 * bee ever saw the error, because nothing handed it to one.
 *
 * So each round asks GitHub about a few accepted issues: is there an open
 * pull request for the branch, and did a REQUIRED check on its head come back
 * red? If so the acceptance becomes a send-back whose note is the check's own
 * error line, which the next bee reads in its brief (`judged_note`). The
 * required checks decide because they are what stops the work landing - an
 * acceptance that cannot land is not an acceptance.
 *
 * What it will not do:
 *   - decide on a check still running, or on a check that is not required
 *     (dozens of advisory checks are red on most pull requests);
 *   - take anything back when the required list cannot be read - a gate it
 *     cannot see is not a gate it may enforce;
 *   - touch a closed or merged pull request;
 *   - loop for ever: the second refusal escalates to a person, the same
 *     ceiling the review uses (QueenReviewDecision.maximumSendBacks = 2).
 */
import type { Pool } from 'pg'
import { logger } from '../../lib/logger'

/** Accepted issues asked about per round. Two GitHub reads each, plus a log per red check. */
export const CI_CHECKS_PER_ROUND = 8

/** The review's own ceiling: the send-back that reaches it escalates instead. */
export const CI_MAXIMUM_SEND_BACKS = 2

/** What the next bee's brief shows of a note (`PREVIOUS_REVIEW_MAX_CHARS`). */
const NOTE_MAX = 1500
const ERROR_MAX = 600

const RED = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
])

export interface CheckRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  url: string | null
}

export interface PullRequest {
  number: number
  state: string
  merged: boolean
  headSha: string
}

/**
 * The required checks that came back red on this head. A re-run leaves two runs
 * of one name; the newest decides. A check still running decides nothing.
 */
export function refusedRequired(
  runs: CheckRun[],
  required: readonly string[],
): CheckRun[] {
  const wanted = new Set(required)
  const newest = new Map<string, CheckRun>()
  for (const run of runs) {
    if (!wanted.has(run.name)) continue
    const seen = newest.get(run.name)
    if (!seen || run.id > seen.id) newest.set(run.name, run)
  }
  return [...newest.values()].filter(
    (run) =>
      run.status === 'completed' &&
      run.conclusion !== null &&
      RED.has(run.conclusion),
  )
}

/**
 * What the check said, from its Actions log: the `##[error]` lines, without
 * the runner's own "Process completed with exit code" epilogue, which names
 * no defect.
 */
export function errorLinesOf(log: string): string {
  return log
    .split('\n')
    .map((line) => line.replace(/^\s*\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').trim())
    .filter((line) => line.startsWith('##[error]'))
    .map((line) => line.slice('##[error]'.length).trim())
    .filter((line) => line && !/^Process completed with exit code/.test(line))
    .join(' | ')
    .slice(0, ERROR_MAX)
}

/** The note the next bee reads. The check's words first; ours are only the frame. */
export function ciRefusalNote(
  pull: number,
  branch: string,
  refused: Array<{ name: string; error: string; url: string | null }>,
): string {
  const lines = refused.map(
    (r) =>
      `- ${r.name}: ${r.error || 'failed; its log held no error line'}` +
      (r.url ? ` (${r.url})` : ''),
  )
  return [
    `A required check refused pull request #${pull} for ${branch}:`,
    ...lines,
    'The review had accepted this work, but the required checks are what let ' +
      'it land, so they decide. Fix it on the same branch; the pull request ' +
      'runs its checks again on the next push.',
  ]
    .join('\n')
    .slice(0, NOTE_MAX)
}

export interface CiDeps {
  /** Names of the required checks on the base branch, or null when unreadable. */
  requiredChecks(): Promise<string[] | null>
  /** The pull requests whose head is this branch, or null when unreadable. */
  pullsForBranch(branch: string): Promise<PullRequest[] | null>
  checkRuns(sha: string): Promise<CheckRun[] | null>
  jobLog(jobId: number): Promise<string | null>
}

export interface TakenBack {
  issue: number
  pull: number
  state: 'sendBack' | 'escalate'
  checks: string[]
}

export async function takeBackRefusedAcceptances(
  pool: Pool,
  deps: CiDeps,
  limit = CI_CHECKS_PER_ROUND,
): Promise<TakenBack[]> {
  const required = await deps.requiredChecks()
  if (!required || required.length === 0) return []

  // Oldest-asked first, so eight a round walks the whole accepted set rather
  // than asking about the same eight for ever.
  //
  // Only issues still OPEN (queen_issues is the round's mirror of them, the
  // same test the review sweep uses). The first deploy asked about every
  // accept ever recorded - 494 rows, 460 of them closed long ago - so the one
  // open issue this exists for (#4385) was an hour of rounds away.
  const rows = await pool.query(
    `SELECT issue, branch, send_backs
       FROM queen_dispatch
      WHERE review_state = 'accept' AND finished_at IS NOT NULL
        AND (
          NOT EXISTS (SELECT 1 FROM queen_issues)
          OR EXISTS (
            SELECT 1 FROM queen_issues i WHERE i.number = queen_dispatch.issue
          )
        )
      ORDER BY ci_checked_at ASC NULLS FIRST, issue
      LIMIT $1`,
    [limit],
  )

  const taken: TakenBack[] = []
  for (const row of rows.rows) {
    const issue = Number(row.issue)
    const branch = String(row.branch || `queen-${issue}`)
    await pool.query(
      `UPDATE queen_dispatch SET ci_checked_at = now() WHERE issue = $1`,
      [issue],
    )

    const pulls = await deps.pullsForBranch(branch)
    const open = pulls?.find((p) => p.state === 'open' && !p.merged)
    if (!open) continue
    const runs = await deps.checkRuns(open.headSha)
    if (!runs) continue
    const red = refusedRequired(runs, required)
    if (red.length === 0) continue

    const refused: Array<{ name: string; error: string; url: string | null }> =
      []
    for (const run of red) {
      const log = await deps.jobLog(run.id)
      refused.push({
        name: run.name,
        error: log ? errorLinesOf(log) : '',
        url: run.url,
      })
    }
    const note = ciRefusalNote(open.number, branch, refused)
    const sendBacks = Number(row.send_backs ?? 0) + 1
    const state: 'sendBack' | 'escalate' =
      sendBacks >= CI_MAXIMUM_SEND_BACKS ? 'escalate' : 'sendBack'

    // Guarded on the state it read, so a review that moved the row in the
    // meantime is never overwritten.
    const updated = await pool.query(
      `UPDATE queen_dispatch
          SET review_state = $2, review_note = $3, judged_note = $3,
              reviewed_at = now(), send_backs = $4::integer
        WHERE issue = $1 AND review_state = 'accept'`,
      [issue, state, note, sendBacks],
    )
    if (!updated.rowCount) continue
    const checks = red.map((r) => r.name)
    taken.push({ issue, pull: open.number, state, checks })
    logger.info('Queen took back an acceptance a required check refused', {
      issue,
      pull: open.number,
      state,
      checks,
    })
  }
  return taken
}

/**
 * GitHub, read with the round's token. Every failure is null - "could not
 * ask" - never an empty list, which would read as "asked, and found nothing".
 */
export function githubCiDeps(
  repo: string,
  baseBranch: string,
  headers: Record<string, string>,
): CiDeps {
  const api = `https://api.github.com/repos/${repo}`
  const owner = repo.split('/')[0]
  const json = async (url: string): Promise<unknown | null> => {
    try {
      const response = await fetch(url, { headers })
      return response.ok ? await response.json() : null
    } catch {
      return null
    }
  }
  return {
    async requiredChecks() {
      const rules = (await json(
        `${api}/rules/branches/${encodeURIComponent(baseBranch)}`,
      )) as Array<{
        type?: string
        parameters?: { required_status_checks?: Array<{ context?: string }> }
      }> | null
      if (!Array.isArray(rules)) return null
      return rules
        .filter((rule) => rule.type === 'required_status_checks')
        .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
        .map((check) => check.context)
        .filter((name): name is string => typeof name === 'string')
    },
    async pullsForBranch(branch) {
      const pulls = (await json(
        `${api}/pulls?state=all&per_page=5&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      )) as Array<{
        number: number
        state: string
        merged_at: string | null
        head: { sha: string }
      }> | null
      if (!Array.isArray(pulls)) return null
      return pulls.map((p) => ({
        number: p.number,
        state: p.state,
        merged: p.merged_at !== null,
        headSha: p.head.sha,
      }))
    },
    async checkRuns(sha) {
      const body = (await json(
        `${api}/commits/${sha}/check-runs?per_page=100`,
      )) as {
        check_runs?: Array<{
          id: number
          name: string
          status: string
          conclusion: string | null
          html_url: string | null
        }>
      } | null
      if (!body?.check_runs) return null
      return body.check_runs.map((run) => ({
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
      }))
    },
    async jobLog(jobId) {
      try {
        const response = await fetch(`${api}/actions/jobs/${jobId}/logs`, {
          headers,
        })
        return response.ok ? await response.text() : null
      } catch {
        return null
      }
    },
  }
}
