/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The supervision round, running where there is no laptop.
 *
 * Everything this loop needs was moved into the container one piece at a time:
 * the checkout, the tools, the git credentials, the registry, and finally the
 * policy itself as a Linux binary. What stayed behind was the thing that wakes
 * up - so the whole apparatus was cloud-resident and still could not start a
 * round unless a Mac was awake to tell it to. This is that last piece.
 *
 * A round is: hold the lease, read the registry, ask GitHub what is open, let
 * `queend` decide, and write down what was decided. The deciding is deliberately
 * not here. It is in `queend`, compiled from the same eleven Swift files the Mac
 * app uses, because a second implementation of "which bee starts next" written
 * in TypeScript would be a second policy - agreeing at first, drifting later,
 * and impossible to tell apart from the first when they disagree.
 *
 * IT ALSO STARTS THE BEE. This header used to end "WHAT THIS LOOP DOES NOT DO:
 * start the bee ... the dispatch path is still driven from the app", and that
 * stopped being true the moment `dispatchBee` was called from `runRound` below.
 * The sentence survived the change by several commits and was caught by a sweep
 * rather than by anyone reading it - which is the whole argument for keeping a
 * comment's claim narrow enough to notice when it dies.
 *
 * IT ALSO JUDGES WHAT COMES BACK. This header said "nothing asks it one" of the
 * `review` question, and that too outlived its truth - which is the second time
 * on this file, so the pattern is the file's and not an accident. A claim about
 * what a module does not do decays silently; the fix is to keep such claims
 * narrow enough that a reader notices.
 *
 * AND IT RE-OPENS WHAT WAS SENT BACK, up to a ceiling (#1362). The paragraph
 * that used to close this header said the loop does not send a bee back - and
 * it outlived its truth exactly the way the two claims above did, which is why
 * it is replaced rather than amended. `redispatchSentBackWork` returns a
 * sent-back issue to a bee while `send_backs` is under
 * `SEND_BACK_RETRY_CEILING`, and escalates it once the ceiling is reached;
 * `classifyParkedEscalations` names an escalation's cause where the evidence
 * determines one. What this loop still does not do is act on an escalation:
 * naming a kind is a label for the operator, and nothing here retries,
 * abandons or closes work on the strength of it.
 */

import { spawn, spawnSync } from 'node:child_process'
import { Pool } from 'pg'
import { logger } from '../../lib/logger'
import {
  committedFiles,
  dispatchBee,
  reapDispatchesFromPreviousBoot,
  reapStalledDispatches,
  setDurableCloseListener,
  workspaceRoot,
} from './queen-dispatch'
import {
  acquireQueenLease,
  logLeaseOutcome,
  queenHolderName,
  queenLeaseDatabaseUrl,
  releaseQueenLease,
} from './queen-lease'

const LEASE_NAME = 'queen-tick'
/**
 * Where the policy binary is, with an override no deployment sets.
 *
 * The container installs it at `/usr/local/bin/queend` and that stays the
 * answer there. The override exists so a test can drive the SAME binary this
 * file drives, out of `queen-core/.build/release/queend` on a machine that has
 * built it - which is the difference between a test that exercises the round
 * and a test that exercises a stub of the round. Read per call rather than at
 * import, because a constant frozen at module load cannot be pointed anywhere
 * by a test that imports the module.
 */
function queendPath(): string {
  return process.env.TRIOS_QUEEND_PATH || '/usr/local/bin/queend'
}
/// A task shaped for the policy needs an id; a dispatch that never opened a
/// conversation has none. All-zeroes is a UUID that decodes and can collide
/// with nothing real.
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

interface SpecVerdict {
  delegatable: boolean
  isSpec: boolean
  missing: string[]
  remedy: string
  /** What the issue says "done" looks like, parsed by `queend`. */
  criteria?: string[]
  /** `stated`, `requirements` or `none`. */
  criteriaSource?: string
}

interface QueendChoice {
  verdicts?: Record<string, SpecVerdict>
  /** For `review`: accept, sendBack, escalate or wait. */
  verdict?: string
  note?: string
  unmet?: string[]
  allowed: boolean
  chosen?: number | null
  chosenPaths?: string[] | null
  refusal?: string | null
  skipped?: string[] | null
  /** For `boundary`: the committed paths that fall outside what was owned. */
  strays?: string[] | null
}

/**
 * The TTL is a LIVENESS window, not a work window. I had these confused.
 *
 * The first version reasoned "the TTL must outlive a round" and set it to three
 * times the tick interval - ninety minutes - renewing only when a round ran.
 * That is sound only if renewal and work are the same event, and it produced
 * exactly the failure it looks like it should: a deploy replaced the container,
 * the old holder died without releasing, and its lease went on holding the hive
 * for ninety minutes while the new one correctly stood down every round.
 *
 *   14:36:18 Queen tick starting          holder="f2375165-...:1"
 *   14:36:18 Queen lease held elsewhere    holder="9680f61f-...:1"
 *            self="f2375165-...:1" expiresAt="15:52:42"
 *
 * Nothing there is malfunctioning. The exclusion did its job; the lease was
 * simply describing a process that no longer existed.
 *
 * Separating the two fixes it. A heartbeat renews far more often than the tick
 * runs, so the TTL only has to outlive a couple of missed heartbeats - and a
 * holder that dies frees the hive in minutes rather than in whatever the work
 * interval happens to be. The round may then take as long as it likes.
 */
const LEASE_TTL_SECONDS = 180
const HEARTBEAT_SECONDS = 60

function tickIntervalSeconds(): number {
  const raw = Number(process.env.TRIOS_QUEEN_TICK_SECONDS ?? '0')
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/** GitHub's maximum, so the fewest requests per round. */
const ISSUE_PAGE_SIZE = 100
/**
 * How many pages a round will follow before it calls the list untrustworthy.
 *
 * Five pages is 500 open items against a repository that had 44 on 2026-08-31,
 * and five requests against an anonymous rate limit of 60/hour on a loop that
 * ticks at most a few times an hour. A repository that really has more than 500
 * open items is not one this loop should be silently guessing about.
 */
const ISSUE_PAGE_CAP = 5

/**
 * How many times an issue may be returned to a bee before it becomes a
 * person's problem (#1362). The counter is `queen_dispatch.send_backs`.
 *
 * WHY TWO. The same number, for the same stated reason, as
 * `QueenReviewDecision.maximumSendBacks` in the policy: the first return is
 * the one that can teach - it names criteria the worker had not satisfied -
 * and a bee that has failed the same named criteria twice is telling you
 * about the criteria, not about itself. A third attempt is not information,
 * it is the daily budget burning on one issue while the rest of the backlog
 * waits, so at the ceiling the retry pass stops dispatching and escalates.
 *
 * It must not drift from the Swift constant: the review policy escalates on
 * its own arm once `priorSendBacks` reaches 2, and a container ceiling higher
 * than the policy's would grant attempts the policy has already refused to
 * grant. `review-valves.test.ts` reads the Swift source and pins the two
 * together, the way `tests/t27/ring00_parity.sh` pins the constants it cares
 * about.
 */
export const SEND_BACK_RETRY_CEILING = 2

/**
 * How many bees may run at once, for the retry pass's own throttle.
 *
 * The number is `QueenDelegationPolicy.maximumConcurrentWorkers` in the
 * policy, stated again here because `queend` exposes no question that answers
 * it and the retry path cannot go through `kind: "choose"` - the policy
 * deliberately holds an issue whose task is `rejected` ("the same bee is
 * expected back"), so a send-back can never be re-chosen, only re-opened
 * directly. Without a local copy of the limit, seven parked send-backs would
 * become seven bees on top of a busy swarm in one round. The parity test in
 * `review-valves.test.ts` reads the Swift source and fails if the two ever
 * disagree, which is the honest substitute for one shared constant living in
 * a language this file cannot import.
 */
export const MAXIMUM_CONCURRENT_WORKERS = 4

/**
 * Open issues, read without a credential.
 *
 * Anonymous on purpose: the repository is public, this is a read, and a token
 * here would be a credential in a container for no gain. GitHub's anonymous
 * rate limit is 60/hour against a loop that ticks at most a few times an hour.
 *
 * PAGINATED, and it says whether it got everything. One page of 50 was the
 * whole list for as long as the repository stayed under the horizon - 44 open
 * items on 2026-08-31, of which 4 were pull requests taking slots on the same
 * page - and `rememberIssues` deletes every stored row that is not in the list
 * it is handed. So at 51 open items the oldest backlog issue would have been
 * erased from the board on every round, with nothing anywhere saying so.
 * `complete` is what stops that: a truncated list is still worth deciding
 * against, but it must never be treated as the whole truth.
 */
export async function openIssues(repo: string): Promise<{
  issues: Array<{ number: number; body: string; title: string }>
  complete: boolean
}> {
  const collected: Array<{ number: number; body: string; title: string }> = []
  let complete = false
  for (let page = 1; page <= ISSUE_PAGE_CAP; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues` +
        `?state=open&per_page=${ISSUE_PAGE_SIZE}&page=${page}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    )
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
    const batch = (await response.json()) as Array<{
      number: number
      title?: string
      body?: string | null
      pull_request?: unknown
    }>
    // The issues endpoint returns pull requests too, and a PR is not work to
    // delegate - it is work already done waiting for a verdict.
    //
    // The BODY comes along, because the boundary lives in it. Fetching numbers
    // here and bodies later would be a second round trip per candidate against
    // an anonymous rate limit that is 60 an hour.
    for (const i of batch) {
      if (i.pull_request) continue
      collected.push({
        number: i.number,
        body: i.body ?? '',
        title: i.title ?? `#${i.number}`,
      })
    }
    // The RAW page length decides, not the filtered one: a page that was all
    // pull requests is still a full page and there is more behind it.
    if (batch.length < ISSUE_PAGE_SIZE) {
      complete = true
      break
    }
  }
  return { issues: collected, complete }
}

/**
 * Columns the round needs, added if they are not there yet.
 *
 * The queen tables were created by hand against the live database, so every
 * column added since exists only because someone ran the ALTER - and a database
 * restored from backup, or a second environment, would have the code without
 * the columns and fail on the first round. `IF NOT EXISTS` makes that a
 * no-op on the machine that already has them and a repair everywhere else.
 *
 * Columns only. The tables themselves are not created here on purpose: a round
 * that finds no `queen_dispatch` at all is in a situation a silent CREATE would
 * hide, and losing the swarm's history to a typo in a schema name is exactly
 * the kind of quiet damage worth failing loudly over.
 */
async function ensureQueenColumns(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE queen_issues
      ADD COLUMN IF NOT EXISTS criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS criteria_source text NOT NULL DEFAULT 'none';
    ALTER TABLE queen_dispatch
      ADD COLUMN IF NOT EXISTS criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS criteria_source text NOT NULL DEFAULT 'none',
      -- Who ran this bee and on what.
      --
      -- The spend cap added for the cloud could not see a single cloud
      -- bee: DelegatedTask.estimatedCostUSD returns nil unless the task
      -- carries BOTH provider and model, and the board record carried
      -- neither. So the ceiling measured the Mac app's spend and called
      -- it the swarm's - a gate reading zero for the only work it was
      -- built to govern.
      ADD COLUMN IF NOT EXISTS provider text,
      ADD COLUMN IF NOT EXISTS model text,
      -- How many times THIS issue has been returned to a bee.
      --
      -- The escalation ceiling depends on it: QueenReviewDecision escalates
      -- once priorSendBacks reaches maximumSendBacks (2). The container used to
      -- send the literal 0 with every review, so 0 < 2 always held, the
      -- escalate arm was unreachable from the cloud, and an issue whose
      -- criteria stayed unmet would be returned for ever and never become a
      -- person's problem - which is the exact failure the constant exists to
      -- stop.
      --
      -- On queen_dispatch rather than in a table of its own because the row is
      -- already keyed by issue and already survives a redispatch: the upsert in
      -- recordDispatch names every column it overwrites and this is not one of
      -- them, so the count accumulates across attempts instead of resetting
      -- with the bee it is counting.
      ADD COLUMN IF NOT EXISTS send_backs integer NOT NULL DEFAULT 0,
      -- Whether THIS dispatch was a retry of a send-back rather than a first
      -- attempt (#1362). A retry must be distinguishable in the record from a
      -- first attempt, or the board cannot say whether an issue is new work
      -- coming back or old work going round. recordDispatch does not name
      -- this column, so the retry pass writes it after the dispatch lands -
      -- the same arrangement that keeps send_backs accumulating across
      -- attempts.
      ADD COLUMN IF NOT EXISTS send_back_retry boolean NOT NULL DEFAULT false,
      -- The cause of a parked escalation, classified - never guessed (#1362).
      -- NULL means not yet classified; once set it stays, because a kind is a
      -- statement about why a verdict was reached, and re-deriving it later
      -- against a since-edited issue would answer a different question.
      -- needs-a-person is the value for a cause that could not be determined,
      -- and is the default the classifier falls back to.
      ADD COLUMN IF NOT EXISTS escalation_kind text,
      -- Which criterion, tool or path made an issue-unworkable escalation so,
      -- in the classifier's own words. Kept beside the kind rather than folded
      -- into review_note, which belongs to the review that raised the
      -- escalation and can say something else.
      ADD COLUMN IF NOT EXISTS escalation_reason text,
      -- The committed paths that fell outside the boundary this bee was given.
      ADD COLUMN IF NOT EXISTS strays jsonb NOT NULL DEFAULT '[]'::jsonb;
  `)
}

/**
 * Store the issue list, boundary included.
 *
 * The boundary is parsed HERE by the same rule everything else uses, rather
 * than re-derived in the page. A board that computed its own idea of which
 * files an issue claims would be a second parser, and the two would agree until
 * one was edited.
 *
 * Issues that have closed since the last round are dropped, so the board does
 * not accumulate work nobody can do. Written in one statement per issue rather
 * than a bulk upsert because the list is tens of rows, once every half hour.
 *
 * The drop happens ONLY against a complete list. "Not in the list I was given"
 * means closed only if the list is everything GitHub has; against a truncated
 * one it means "past the horizon", and deleting on that reading turns a paging
 * limit into an issue disappearing off the board. The rows go stale instead,
 * which is the failure that leaves evidence.
 */
export async function rememberIssues(
  pool: Pool,
  issues: Array<{ number: number; body: string; title: string }>,
  complete: boolean,
  verdicts?: Record<string, SpecVerdict>,
): Promise<void> {
  if (issues.length === 0) return
  for (const issue of issues) {
    const boundary = boundaryPathsOf(issue.body)
    const v = verdicts?.[String(issue.number)]
    await pool.query(
      `INSERT INTO queen_issues
         (number, title, state, owned_paths, seen_at, is_spec, delegatable,
          missing, criteria, criteria_source)
       VALUES ($1, $2, 'open', $3::jsonb, now(), $4, $5, $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (number) DO UPDATE
         SET title = EXCLUDED.title, state = 'open',
             owned_paths = EXCLUDED.owned_paths, seen_at = now(),
             is_spec = EXCLUDED.is_spec,
             delegatable = EXCLUDED.delegatable,
             missing = EXCLUDED.missing,
             criteria = EXCLUDED.criteria,
             criteria_source = EXCLUDED.criteria_source`,
      [
        issue.number,
        issue.title.slice(0, 300),
        JSON.stringify(boundary),
        v?.isSpec ?? false,
        v?.delegatable ?? boundary.length > 0,
        JSON.stringify(v?.missing ?? []),
        JSON.stringify(v?.criteria ?? []),
        v?.criteriaSource ?? 'none',
      ],
    )
  }
  if (!complete) {
    logger.warn('Open issue list was truncated; keeping the board as it is', {
      fetched: issues.length,
      pages: ISSUE_PAGE_CAP,
    })
    return
  }
  await pool.query(`DELETE FROM queen_issues WHERE number <> ALL($1::int[])`, [
    issues.map((i) => i.number),
  ])
}

/// Seconds, no fraction.
///
/// Postgres hands back a JS Date and JSON.stringify writes it with
/// milliseconds - "2026-08-29T16:13:06.821Z". Swift's `.iso8601` decoding
/// strategy does not accept a fractional second, so `queend` refused the whole
/// question the moment there was anything in flight to report:
///
///   codingPath: ["tasks", "Index 67"]
///   "Expected date string to be ISO8601-formatted."
///
/// Index 67 is the first of MINE, after the registry's own sixty-seven - which
/// is what made it obvious. The app's tasks encode without the fraction because
/// Swift wrote them; mine have to match that, not merely be valid ISO 8601.
const isoSeconds = (value: unknown): string =>
  new Date(value as string).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * A running bee as `DelegatedTask`, for the board `queend` is asked to reason
 * about. EVERY non-optional field of that Swift type, not the ones that seemed
 * interesting.
 *
 * Swift's synthesised Codable refuses the whole document for one missing key,
 * and `queend` names which - so both defects here were found the honest way,
 * one refusal at a time:
 *
 *   codingPath: ["tasks", "Index 67"]  "Expected date string to be ISO8601"
 *   codingPath: ["tasks", "Index 70"]  keyNotFound("acceptanceCriteria")
 *
 * ONE builder, because there were two, sixty lines apart, and the second was
 * written by copying the first and dropping the three fields at the bottom. It
 * decoded fine for weeks: it only ran when a bee was ALREADY running, and until
 * the concurrency fix that never happened. So the first round that ever started
 * a second bee was the first round to fail, and the fix and the failure looked
 * like the same commit.
 *
 * `queen-board-record.test.ts` compares these keys against the Swift struct, so
 * a field added there fails here rather than in a live round.
 */
/**
 * What a dispatch IS to the policy, from its ending and its verdict.
 *
 * Every finished dispatch used to become `awaitingReview`, whatever the Queen
 * had decided about it - so work she had ACCEPTED went on holding its files
 * for the full 48-hour review window, against issues that could otherwise have
 * been started. Measured the night it was found: #1111 was accepted at 15:26,
 * two criteria judged, and `rings/SR-00/QueenInterfaceDivergence.swift` stayed
 * reserved for a task that was over.
 *
 * That is the starvation this whole file has been chasing, arriving from the
 * one place nobody looks: a task that SUCCEEDED.
 *
 *   accept    -> accepted, which is terminal and holds nothing at all
 *   sendBack  -> rejected: the same bee is expected back on those files
 *   escalate  -> awaitingReview: a person is needed, and the 48-hour clock runs
 *   wait/none -> awaitingReview: not judged yet, so the hold stands
 */
export function stateOfDispatch(
  finished: boolean,
  reviewState: unknown,
): 'running' | 'accepted' | 'rejected' | 'awaitingReview' {
  if (!finished) return 'running'
  const verdict = String(reviewState ?? '')
  if (verdict === 'accept') return 'accepted'
  if (verdict === 'sendBack') return 'rejected'
  return 'awaitingReview'
}

export function boardTask(
  owner: string,
  repoName: string,
  task: {
    conversationId: string | null
    issue: number
    ownedPaths: string[]
    branch: string | null
    at: string
    title: string
    /**
     * `running` while a bee holds it, `awaitingReview` once its turn ended.
     *
     * The distinction is the whole difference between a busy swarm and a stuck
     * one, and it was missing: every dispatch went on the board as `running`
     * for as long as its row survived, so three finished-and-judged tasks held
     * three of four worker slots with nobody at the keyboard. The refusal read
     * "4 workers already running (limit 4)" while exactly one bee existed.
     *
     * `awaitingReview` is the state the policy already knows how to handle: it
     * is not counted by `canStartAnother`, it still blocks its own issue from
     * being chosen twice, and `stillHoldsBoundary` expires its file claim after
     * 48 hours rather than never.
     */
    state?: 'running' | 'accepted' | 'rejected' | 'awaitingReview'
    provider?: string
    model?: string
    inputTokens?: number
    outputTokens?: number
  },
) {
  return {
    id: task.conversationId ?? ZERO_UUID,
    conversationId: task.conversationId ?? ZERO_UUID,
    issue: { owner, repo: repoName, number: task.issue },
    title: task.title,
    worker: 'cloud-tick',
    state: task.state ?? 'running',
    ownedPaths: task.ownedPaths,
    virtualBranch: task.branch,
    createdAt: isoSeconds(task.at),
    updatedAt: isoSeconds(task.at),
    // Empty, and empty is the truthful value: the cloud tick does not yet read
    // acceptance criteria out of the issue, so claiming any here would be
    // inventing a contract the bee was never given.
    acceptanceCriteria: [] as string[],
    interventions: [] as string[],
    criterionVerdicts: {} as Record<string, unknown>,
    provider: task.provider,
    model: task.model,
    inputTokens: task.inputTokens,
    outputTokens: task.outputTokens,
  }
}

/**
 * The declared boundary of one issue body.
 *
 * A deliberate second implementation of a rule `QueenIssueBoundary` owns in
 * Swift, and the only one in this file - it exists so the board can be drawn
 * without spawning `queend` per issue. Kept to the same two headings; if the
 * Swift rule grows a case, this must follow it or the board will disagree with
 * the Queen about what an issue claims.
 *
 * It does NOT keep Swift's nil-versus-empty distinction, and the comment here
 * used to claim it did while the body had no `found` flag at all: both "no
 * boundary section" and "an empty boundary section" return `[]`. That is
 * deliberate rather than merely unfixed, because no caller in either language
 * branches on the difference - `queend/main.swift` guards
 * `let owned = ..., !owned.isEmpty`, `QueenSpecQuality` computes
 * `boundary?.isEmpty == false`, `ChatViewModel` writes `?? []`, and this file
 * derives `delegatable` from `boundary.length > 0`. Every one of them collapses
 * nil into []. If a caller ever needs the difference, the flag goes back in
 * HERE and in `rememberIssues`, which currently JSON-stringifies the result
 * into `owned_paths` with no way to say "the issue never said".
 */
function boundaryPathsOf(body: string): string[] {
  const lines = body.split('\n')
  let inside = false
  const paths: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('## ')) {
      if (inside) break
      inside = line.startsWith('## Boundary') || line.startsWith('## Границы')
      continue
    }
    if (!inside || line.length === 0) continue
    for (const token of line.split(/\s+/)) {
      const cleaned = token
        .replace(/^[`"'(]+/, '')
        .replace(/[`"'.,;:!?)]+$/, '')
      if (cleaned.includes('/') || /\.\w{1,10}$/.test(cleaned)) {
        paths.push(cleaned)
        break
      }
    }
  }
  return paths
}

/** One body per candidate, keyed as queend expects. */
async function bodiesFor(
  repo: string,
  numbers: number[],
): Promise<Record<string, string>> {
  const bodies: Record<string, string> = {}
  for (const number of numbers) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues/${number}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    )
    if (!response.ok) continue
    const issue = (await response.json()) as { body?: string | null }
    bodies[String(number)] = issue.body ?? ''
  }
  return bodies
}

/**
 * Hand the decision to the Queen's own policy binary.
 *
 * Rejects rather than defaulting when queend is missing or fails. A tick that
 * silently substitutes its own judgement for the policy's is worse than a tick
 * that stops: the first produces decisions nobody can trace to a rule.
 */
function askQueend(question: unknown): Promise<QueendChoice> {
  return new Promise((resolve, reject) => {
    const child = spawn(queendPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`queend exited ${code}: ${err.trim() || out.trim()}`))
        return
      }
      try {
        resolve(JSON.parse(out) as QueendChoice)
      } catch {
        reject(
          new Error(`queend returned unparseable output: ${out.slice(0, 200)}`),
        )
      }
    })
    child.stdin.end(JSON.stringify(question))
  })
}

/**
 * Whether the round that owns this watch is still the Queen.
 *
 * Read by `runRound` before every dispatch. It is an object rather than a
 * returned boolean because the answer changes WHILE the round runs - that is
 * the entire point - and a value copied out at the start would be the stale
 * belief this exists to correct.
 */
export interface LeaseWatch {
  held: boolean
}

/**
 * Every heartbeat currently beating, so shutdown can stop all of them.
 *
 * This was one module-scoped variable, and two overlapping rounds in one
 * process is a reachable state, not a theoretical one: `POST /queen/lease/tick`
 * runs `runQueenTickOnce` on demand alongside the `setInterval` loop, both
 * calls get `acquired: true` because `queenHolderName()` is stable within a
 * process and acquisition renews on `queen_lease.holder = EXCLUDED.holder`, and
 * a round now takes minutes. With one variable the second round's assignment
 * overwrote the first's handle: the first finisher cleared the LATER round's
 * interval and nulled the variable, the other finisher cleared nothing, and the
 * orphan went on renewing the lease every 60 seconds for the life of the
 * process - pinning the hive to a container that had stopped working.
 *
 * The handle is local to the round now; this set exists only so `handover` can
 * still reach a beat it does not own.
 */
const heartbeats = new Set<ReturnType<typeof setInterval>>()

/**
 * Renew the lease while the work runs, and notice when the renewal is refused.
 *
 * `acquireQueenLease` does not throw when the lease has moved - it returns
 * `{ acquired: false, holder: <someone else> }`. The heartbeat used to call it
 * for effect and drop the verdict on the floor, so a round that lost the lease
 * carried on through `askQueend`, `dispatchBee` and `recordDispatch` believing
 * it was the Queen. `recordDispatch` carries no fence (only `recordTick` does),
 * so its upsert would overwrite the legitimate Queen's row for the same issue,
 * `conversation_id` included, and point the feed at the wrong bee.
 *
 * Losing it takes three consecutive refusals or a stall past the TTL
 * (HEARTBEAT_SECONDS 60 against LEASE_TTL_SECONDS 180). A rejection is LOGGED
 * rather than swallowed: `pool.query` rejects on connection errors, which is
 * precisely the failure that goes on to lose the lease, so the empty catch was
 * hiding the signal and not an impossible case.
 *
 * `everyMs` is a parameter so a test can watch a whole heartbeat lifecycle
 * without waiting a minute for the first beat.
 */
export function startLeaseHeartbeat(
  pool: Pool,
  holder: string,
  everyMs: number = HEARTBEAT_SECONDS * 1000,
): { watch: LeaseWatch; stop: () => void } {
  const watch: LeaseWatch = { held: true }
  const beat = setInterval(() => {
    acquireQueenLease(pool, LEASE_NAME, holder, LEASE_TTL_SECONDS)
      .then((renewal) => {
        if (renewal.acquired) return
        watch.held = false
        logger.warn('Queen lease moved while a round was running', {
          holder: renewal.holder,
          self: holder,
        })
        stop()
      })
      .catch((error) => {
        logger.warn('Queen lease renewal failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }, everyMs)
  heartbeats.add(beat)
  function stop(): void {
    clearInterval(beat)
    heartbeats.delete(beat)
  }
  return { watch, stop }
}

export async function runQueenTickOnce(
  pool: Pool,
  candidateOverride?: number[],
): Promise<{
  ran: boolean
  reason?: string
  choice?: QueendChoice
  dispatch?: unknown
}> {
  const holder = queenHolderName()
  const grant = await acquireQueenLease(
    pool,
    LEASE_NAME,
    holder,
    LEASE_TTL_SECONDS,
  )
  logLeaseOutcome(grant, holder)
  if (!grant.acquired) return { ran: false, reason: `held by ${grant.holder}` }

  // Renew while the work runs. A round that outlives its TTL would finish as a
  // private citizen: still delegating, while a second supervisor legitimately
  // holds the lease and delegates too.
  const { watch, stop } = startLeaseHeartbeat(pool, holder)
  try {
    return await runRound(pool, holder, grant.fence, watch, candidateOverride)
  } finally {
    stop()
    // Give it back even when the round threw. A round that fails still had its
    // turn; holding the lease through the failure would make one bad minute
    // cost the other supervisor its next three.
    await releaseQueenLease(pool, LEASE_NAME, holder).catch(() => {})
  }
}

/**
 * The work of a round, with the lease already in hand.
 *
 * EXPORTED FOR THE SUITE, and the reason is the defect it covers. Every write
 * below the `askQueend` for a choice is unfenced, so `watch.held` is the only
 * thing standing between a round that has lost its lease and a round that goes
 * on dispatching bees against the real Queen's board. Nothing tested it: a
 * critic deleted `watch.held &&` from the dispatch loop and all 364 tests
 * stayed green, because no test in the repository called this function or
 * `runQueenTickOnce` at all. `runQueenTickOnce` cannot stand in for it - it
 * builds its own heartbeat on a sixty-second interval, so a test driving it
 * would be a test that waits a minute to lose a lease it can lose here by
 * passing `{ held: false }`.
 */
export async function runRound(
  pool: Pool,
  holder: string,
  fence: number,
  watch: LeaseWatch,
  candidateOverride?: number[],
): Promise<{
  ran: boolean
  reason?: string
  choice?: QueendChoice
  dispatch?: unknown
}> {
  const grant = { fence }

  const registry = await pool.query(
    'SELECT tasks FROM queen_registry WHERE variant = $1',
    [process.env.TRIOS_VARIANT || 'prod'],
  )
  if (!registry.rowCount) {
    // No mirror means no idea what the swarm is doing. Choosing anyway would be
    // choosing against an empty board, which reads as "nothing is running" and
    // starts a bee on an issue that already has one.
    await recordTick(pool, holder, grant.fence, {
      skipped: ['no registry mirror published yet'],
      allowed: false,
    })
    return { ran: true, reason: 'no registry mirror' }
  }

  // NO FALLBACK. A supervisor that guesses which repository it serves is a
  // supervisor that can dispatch bees at a stranger's issues, and the guess it
  // used to make was `gHashTag/BrowserOS` - the monorepo this checkout happens
  // to be, which is NOT where the issues live. That mistake has already been
  // made by a reader: two rounds of "0 open issues, confirmed twice" were both
  // counted against BrowserOS while trios had forty.
  //
  // Unset is a configuration error and must stop the round, loudly. Reading the
  // wrong repository looks like working.
  const repo = process.env.TRIOS_GITHUB_REPO
  if (!repo) {
    throw new Error(
      'TRIOS_GITHUB_REPO is not set. The round refuses to guess which ' +
        'repository it supervises: the old default was gHashTag/BrowserOS, ' +
        'which is the checkout, not the issue tracker.',
    )
  }
  // An override still goes through `queend`. The point of a diagnostic round is
  // to exercise the real decision on chosen inputs, not to bypass it - a probe
  // that skipped the policy would prove the probe.
  let candidates: number[]
  let candidateBodies: Record<string, string>
  await ensureQueenColumns(pool)
  // Kept out of the `else` branch below: the dispatch loop reads criteria from
  // it, and a variable scoped to the branch that fills it is a variable the
  // dispatch cannot see.
  let specVerdicts: Record<string, SpecVerdict> = {}
  if (candidateOverride) {
    candidates = candidateOverride
    candidateBodies = await bodiesFor(repo, candidateOverride)
    specVerdicts =
      (await askQueend({ kind: 'spec', candidateBodies }).catch(() => null))
        ?.verdicts ?? {}
  } else {
    const { issues: open, complete } = await openIssues(repo)
    candidates = open.map((i) => i.number)
    candidateBodies = Object.fromEntries(
      open.map((i) => [String(i.number), i.body]),
    )
    // Keep what GitHub showed us. The round reads this list anyway, and a board
    // that had to fetch it per page view would burn the anonymous rate limit
    // (60/hour) on being looked at.
    // One call for forty verdicts. The rule lives in queend, so the board and
    // the Queen cannot disagree about what a spec is.
    const specs = await askQueend({
      kind: 'spec',
      candidateBodies,
    }).catch(() => null)
    specVerdicts = specs?.verdicts ?? {}
    await rememberIssues(pool, open, complete, specs?.verdicts).catch(
      (error) => {
        logger.warn('Could not store the open issue list', {
          error: error instanceof Error ? error.message : String(error),
        })
      },
    )
  }
  // Reap before reading the board, not after.
  //
  // A dispatch that has stopped without saying so still holds its paths, so a
  // board read before the sweep is a board with phantom work on it - and the
  // round would skip a candidate on behalf of a bee that died in a redeploy an
  // hour ago. Same ordering the app's own review scheduler uses, for the same
  // reason: housekeeping first, then decide.
  // Judge what came back, before choosing anything new.
  //
  // The operator's rule: she works autonomously and is told afterwards. So a
  // finished turn cannot wait for a human - it is reviewed here, by the Queen's
  // own policy, and only an ESCALATION reaches a person. Without this the hold
  // added to stop the six-times loop would have become a different starvation:
  // every issue she finished would be locked out of the pool for ever.
  const reviewed = await reviewFinishedDispatches(pool)
  if (reviewed.acted.length > 0) {
    logger.info('Queen reviewed her own work', { verdicts: reviewed.acted })
  }

  const reaped = await reapStalledDispatches(pool)
  if (reaped.length > 0) {
    logger.info('Queen tick reaped stalled dispatches', { issues: reaped })
  }

  // The board the container decides against is the app's mirror PLUS this
  // container's own dispatches.
  //
  // The mirror is written by the app and knows nothing about what the tick
  // started. Without this the round would choose an issue, dispatch a bee, and
  // thirty minutes later find the same issue unclaimed and dispatch another -
  // forever, with each new bee cutting a branch over the last one's. The
  // symptom would have been a swarm that looks busy and a registry that never
  // grows.
  //
  // Shaped as tasks rather than handled specially, so BOTH guards apply: the
  // "a task already exists for it" check and the boundary conflict check. That
  // is why the boundary is stored at dispatch - a task holding no paths holds
  // nothing against anyone.
  const inFlight = await pool.query(
    `SELECT issue, branch, owned_paths, conversation_id, dispatched_at,
            key_index, finished_at, review_state,
            provider, model, input_tokens, output_tokens
       FROM queen_dispatch
      WHERE started = true
        -- A reaped dispatch releases its issue: its container died, so nothing
        -- was finished and the work must be retried. Everything else stays on
        -- the board, and the STATE below decides what that costs.
        --
        -- Releasing an issue the moment its turn ended was a loop: the bee
        -- committed, the dispatch closed, the issue was choosable again, and
        -- thirty minutes later another bee arrived to find the work already
        -- done. It verified it and committed a record saying so. Six times, on
        -- #1244, in one afternoon:
        --
        --   sixth verification record for #1244 - all checks hold
        --   fifth verification record for #1244 - all checks hold
        --   fourth verification record ...
        --
        -- coalesce, because outcome is NULL while a bee runs and
        -- NULL NOT LIKE 'reaped%' is NULL - which excludes the row. The
        -- previous clause escaped that only by ORing on finished_at.
        AND coalesce(outcome, '') NOT LIKE 'reaped%'
        AND dispatched_at > now() - interval '7 days'`,
  )
  const [owner, repoName] = repo.split('/')
  const containerTasks = inFlight.rows.map((row) => {
    const finished = row.finished_at != null
    return boardTask(owner, repoName, {
      conversationId: row.conversation_id,
      issue: row.issue,
      ownedPaths: row.owned_paths ?? [],
      branch: row.branch,
      // A finished task's clock starts when it FINISHED, not when it was
      // dispatched: `stillHoldsBoundary` measures the wait for a verdict from
      // `updatedAt`, and dating it from dispatch would expire the boundary of a
      // long task the moment its turn ended.
      at: finished ? row.finished_at : row.dispatched_at,
      title: finished
        ? 'finished by the cloud tick, waiting for a verdict'
        : 'dispatched by the cloud tick',
      state: stateOfDispatch(finished, row.review_state),
      // The price, so the daily cap can see the work it exists to govern.
      // `estimatedCostUSD` returns nil unless BOTH provider and model are
      // present, so a record missing either contributes nothing to the sum and
      // the ceiling silently measures somebody else's spend.
      provider: (row.provider as string) ?? undefined,
      model: (row.model as string) ?? undefined,
      inputTokens:
        row.input_tokens == null ? undefined : Number(row.input_tokens),
      outputTokens:
        row.output_tokens == null ? undefined : Number(row.output_tokens),
    })
  })

  // THE SEND-BACK VALVE (#1362). Until this pass existed, a `sendBack` verdict
  // was a full stop: the row sat parked with its issue held and nothing ever
  // re-opened it, so an issue got exactly one attempt and its remaining work
  // was stranded. Thirteen sat that way on 2026-09-03, the oldest four days.
  //
  // It runs BEFORE the choice, deliberately, so that a re-opened issue is on
  // the board as `running` by the time the policy is asked what is new - a
  // re-dispatch the choice does not know about would leave the board able to
  // double-book the very files the retry just handed a bee. The whole pass,
  // keys and fold included, lives in `reopenSentBackWork` below.
  const { retry, reopened, keysInUse } = await reopenSentBackWork(
    pool,
    repo,
    candidates,
    candidateBodies,
    specVerdicts,
    [...registry.rows[0].tasks, ...containerTasks],
    inFlight.rows,
    owner,
    repoName,
    watch,
  )
  // Fold the re-opened work into the board the policy reasons about, the same
  // way the dispatch loop folds its own starts.
  containerTasks.push(...reopened)

  // THE ESCALATION LEDGER (#1362). An escalation waits for a person, and no
  // person is watching a Postgres column - the least this loop can do is say
  // WHICH person-shaped question each one is, where the evidence determines
  // it. Classification only writes the kind and the reason; nothing is
  // re-dispatched, retried or closed on the strength of a kind.
  const classifiedEscalations = await classifyParkedEscalations(pool)
  if (classifiedEscalations.length > 0) {
    logger.info('Queen classified parked escalations', {
      classified: classifiedEscalations.map((c) => `#${c.issue}:${c.kind}`),
    })
  }

  const choice = await askQueend({
    kind: 'choose',
    candidates,
    candidateBodies,
    tasks: [...registry.rows[0].tasks, ...containerTasks],
  })

  await recordTick(pool, holder, grant.fence, choice)
  logger.info('Queen tick decided', {
    chosen: choice.chosen ?? null,
    refusal: choice.refusal ?? null,
    candidates: candidates.length,
  })

  // And then start it. A supervisor that only chooses is a supervisor in name:
  // the choice was the visible half of the round, and for several deploys it
  // was the only half, which reads in a log exactly like a working loop.
  // Keep choosing until the Queen's own limit, not one and stop.
  //
  // `queend` answers with ONE candidate, which is correct - it is a decision,
  // not a plan - and the round then dispatched it and returned. So the ceiling
  // was 1 per half hour while QueenDelegationPolicy.maximumConcurrentWorkers
  // has said 4 all along, and the key rotation built for four bees could never
  // hand out a second key.
  //
  // The loop asks again with the new dispatch folded into the board, so every
  // answer accounts for what the previous one started. That is what makes the
  // bees help rather than collide: the second choice already knows the first
  // one's boundary is taken.
  // Typed, because the report reads these back. `unknown[]` compiled and then
  // made the reporter unable to say which issues it had started.
  const started: Array<{
    started: boolean
    issue: number
    branch: string
    detail: string
    conversationId?: string
    keyIndex?: number
  }> = []
  let board = [...registry.rows[0].tasks, ...containerTasks]
  let current: QueendChoice | null = choice
  // Only a bee that is still running is spending its key. A finished dispatch
  // waiting for a verdict holds its issue and its files; it is not making
  // requests, so withholding its key from the next bee would shrink the swarm
  // for nothing - the same mistake as counting it as a running worker, one
  // layer down.
  // keysInUse already carries the keys the send-back retries took (the helper
  // adds them), so the loop starts from the full set.
  let takenKeys = [...keysInUse]

  // `watch.held` first, and re-read on every pass: the heartbeat can refuse a
  // renewal in the minutes a single dispatch takes, and every write below this
  // point is unfenced. `recordTick` above needs no such guard - its
  // `WHERE queen_tick.fence <= EXCLUDED.fence` already refuses a stale term,
  // and a second copy of that rule here is how the two come to disagree.
  while (watch.held && current?.allowed && typeof current.chosen === 'number') {
    const issue = current.chosen
    const paths = current.chosenPaths ?? []
    const spec = specVerdicts[String(issue)]
    const criteria = spec?.criteria ?? []
    const criteriaSource = spec?.criteriaSource ?? 'none'
    const dispatch = await dispatchBee(
      pool,
      issue,
      briefFor(
        issue,
        repo,
        paths,
        candidateBodies[String(issue)] ?? '',
        criteria,
        criteriaSource,
      ),
      paths,
      takenKeys,
      criteria,
      criteriaSource,
    )
    started.push(dispatch)
    if (!dispatch.started) break

    // Fold it into the board so the next answer treats its files as held, and
    // mark its key as taken so the next bee gets a different one.
    board = [
      ...board,
      boardTask(owner, repoName, {
        conversationId: dispatch.conversationId ?? null,
        issue,
        ownedPaths: paths,
        branch: dispatch.branch,
        at: new Date().toISOString(),
        title: 'just dispatched by this round',
      }),
    ]
    if (typeof dispatch.keyIndex === 'number') {
      takenKeys = [...takenKeys, dispatch.keyIndex]
    }
    // `queend` applies canStartAnother itself, so the loop ends when the policy
    // says so rather than on a count kept here - two places counting workers is
    // how they come to disagree.
    current = await askQueend({
      kind: 'choose',
      candidates,
      candidateBodies,
      tasks: board,
    })
    if (!current?.allowed) {
      logger.info('Queen tick stopped dispatching', {
        started: started.length,
        why: current?.refusal ?? 'no answer',
      })
    }
  }

  if (!watch.held) {
    logger.warn('Queen tick stood down mid-round; the lease moved', {
      started: started.length,
    })
  }

  await report(
    pool,
    reviewed,
    retry,
    classifiedEscalations,
    started,
    choice,
    candidates.length,
  )
  if (started.length > 0) {
    return { ran: true, choice, dispatch: started }
  }
  return { ran: true, choice }
}

/**
 * What the bee is told, and what it is told NOT to do.
 *
 * The push prohibition is not caution, it is the shape of the deployment: this
 * container holds no push credential by design, so a bee that tries will fail
 * confusingly, and one that believes it succeeded is worse. Work leaves here as
 * a patch the Mac replays - proven end to end - and the bee's job ends at a
 * commit on its own branch.
 */
export function briefFor(
  issue: number,
  repo: string,
  ownedPaths: string[],
  issueBody: string,
  criteria: string[] = [],
  criteriaSource = 'none',
  /**
   * Present when this is a retry of a send-back rather than a first attempt
   * (#1362), so the second bee is handed the first one's failure instead of a
   * blind repeat: the criteria the previous attempt was returned for, and the
   * send-back count the ceiling is measured against.
   */
  previous?: { unmet: string[]; sendBacks: number },
): string {
  // The boundary, in the words the Mac uses.
  //
  // It was computed FOR this bee - `queend` parsed it out of the issue and
  // refused three other candidates on the strength of it - and then was the one
  // thing the bee itself was never told. A rule enforced against everyone
  // except the party it constrains is not a rule, it is a trap.
  //
  // AND IT NO LONGER PROMISES SOMETHING THAT DOES NOT HAPPEN. This sentence
  // read "Work outside them is dropped rather than reviewed", and nothing in
  // either the container or the app drops anything: a bee's commit is its
  // commit, whatever it touched. What actually happens is that the review asks
  // `queend`'s `boundary` question about the files the branch changed and
  // records the ones outside the boundary. A promise the system does not keep
  // is worse than no promise - a bee told its stray work will be discarded has
  // been told the cheapest possible lie, and will believe an out-of-boundary
  // edit costs nothing.
  const boundary =
    ownedPaths.length > 0
      ? 'You may create or edit files under these paths and nowhere else: ' +
        ownedPaths.join(', ') +
        '. Files you change outside them are not discarded - they are ' +
        'compared against this boundary when your work is reviewed, named ' +
        'in the record of it, and reported.'
      : 'No paths were assigned to you. Say so in this chat before editing ' +
        'anything, rather than guessing at a boundary nobody set.'

  // The issue text, inlined, because the bee cannot go and get it.
  //
  // The old brief opened with "Read the issue first" - an instruction this
  // container makes impossible. The image installs git, ca-certificates and
  // openssh-client and no `gh`; the agent shell's environment is scrubbed to a
  // ten-entry allowlist with GITHUB_TOKEN deliberately excluded. So the bee's
  // first instruction could never be followed, and the only description of the
  // task it actually received was the number. Meanwhile the tick had already
  // fetched every candidate's body to decide with - it was one variable away.
  const body = issueBody.trim()
  const description = body
    ? ['## The issue, in full', '', body].join('\n')
    : '## The issue\n\nIts body could not be read. Say so rather than guessing ' +
      'at what it wanted.'

  // Why this bee is here twice. A retry that is not told what the last
  // attempt failed on is the same attempt with a new conversation id - the
  // issue asked for exactly this and the second bee repeats the first one's
  // blind spots. The unmet list is what the Queen's own review named when it
  // returned the work, read back from the previous attempt's verdict block.
  //
  // When the previous verdict could not be re-read, that is SAID rather than
  // papered over: the bee knows the count and the ceiling even when the list
  // is missing, and an honest gap is one it can report around.
  const again =
    previous === undefined
      ? []
      : [
          '## Why you are here again',
          '',
          'This is a retry, not a first attempt: a previous attempt at this',
          "issue was returned by the Queen's review. This is send-back " +
            `${previous.sendBacks} of ${SEND_BACK_RETRY_CEILING}, and at ` +
            `${SEND_BACK_RETRY_CEILING} the issue becomes a person's problem ` +
            'and no further bee is dispatched - so this attempt is the last',
          'word a bee gets to say on it.',
          '',
          ...(previous.unmet.length > 0
            ? [
                "What was unmet last time, in the previous bee's own words:",
                '',
                ...previous.unmet.map((c, i) => `${i + 1}. ${c}`),
              ]
            : [
                "The previous attempt's verdict block could not be re-read, so",
                'no unmet criteria are named here. Judge the work against the',
                'criteria below as if fresh, and say plainly if one of them',
                'cannot be met.',
              ]),
          '',
        ]

  return [
    `# ${repo}#${issue}`,
    '',
    description,
    '',
    '## Boundary',
    '',
    boundary,
    `Your branch is queen-${issue} and this worktree is yours alone - no other`,
    'worker and no build reads or writes it while you have it.',
    '',
    ...again,
    '## What you will be judged by',
    '',
    // Named here, in the brief, because the Queen judges the finished work
    // against exactly this list and nothing else. She used to send an empty
    // list with every task: the review then had zero criteria, answered "there
    // is nothing to judge it against", and escalated finished work to a person
    // - for every bee, every time. The criteria existed in the issue the whole
    // while; nobody carried them the last few inches.
    ...criteriaBlock(criteria, criteriaSource),
    '',
    '## Verification',
    '',
    'When you stop, answer every criterion above in turn: met, not met, or',
    'could not check. Do not summarise and do not shorten this part - an',
    'unchecked criterion is not a pass, and saying so plainly costs you',
    'nothing.',
    '',
    '## Out of scope',
    '',
    'Anything the issue does not ask for. Work that seems obviously needed and',
    'is not asked for is a thing to raise here, not to do quietly.',
    '',
    '## Finishing',
    '',
    'Everything you write is English - source, comments, documentation, commit',
    'messages. Finish with a commit on your branch. Do NOT push: this machine',
    'holds no push credential by design, and the work is carried out as a patch',
    'by the operator. A failed push reads as a failed task; a commit is the',
    'deliverable.',
    '',
    '## Your verdict, which the Queen reads',
    '',
    'End your LAST message with exactly this block and nothing after it:',
    '',
    '## VERDICT',
    "- <the criterion, in the issue's own words>: met | unmet | could-not-check",
    '- <the next one>: met | unmet | could-not-check',
    '',
    'One line per criterion in "What you will be judged by", in that order. A',
    'criterion you could not check is could-not-check, never met - claiming met',
    'for work you did not verify is the one failure nothing downstream can',
    'catch, because the reviewer has only your word for it.',
  ].join('\n')
}

/**
 * The criteria, numbered, or an instruction to state them.
 *
 * When the issue names none, the bee writes the criteria it will be judged by
 * BEFORE working and repeats them in its verdict. That is weaker than the
 * author's own words and the board says so - `criteriaSource` records where
 * they came from. It is still far better than the alternative, which was a
 * finished task nobody could judge and an escalation to the operator, who had
 * asked in plain terms not to be the bottleneck.
 */
function criteriaBlock(criteria: string[], source: string): string[] {
  if (criteria.length === 0) {
    return [
      'The issue states no acceptance criteria and none could be derived from',
      'its requirements. So begin by writing, in this chat, the criteria you',
      'will be judged by - drawn from what the issue asks for, each one',
      'something a person could check. Three or four is usually right. Then do',
      'the work, and answer those same criteria in your verdict.',
      '',
      "They will be recorded as YOUR criteria, not the issue author's.",
    ]
  }
  const provenance =
    source === 'requirements'
      ? "Taken from the issue's numbered requirements, because it states no"
      : "Taken from the issue's own acceptance criteria."
  const tail =
    source === 'requirements'
      ? [
          'Success Criteria section. An obligation is a criterion: it is met or',
          'it is not.',
        ]
      : []
  return [provenance, ...tail, '', ...criteria.map((c, i) => `${i + 1}. ${c}`)]
}

/**
 * Who the bee is, sent in the field the server actually reads.
 *
 * Separate from the briefing because they are different things: the brief is
 * the task, this is the standing identity that should hold across every turn of
 * it. The Mac composes an equivalent and - until today - threw it away on the
 * wire, so neither side has ever had one arrive.
 */
export function workerSystemPrompt(
  issue: number,
  repo: string,
  workingDirectory: string,
  ownedPaths: string[],
): string {
  const lines = [
    `You are a Trinity worker bee, supervised by the Queen. You work on exactly one issue: ${repo}#${issue}.`,
    `Your repository is ${workingDirectory}. Work only inside it: other checkouts of this project exist on this machine, and editing one of those puts your work where nobody looks for it.`,
    'This checkout is yours alone. Do the work yourself: do not delegate and do not open other chats.',
  ]
  if (ownedPaths.length > 0) {
    lines.push(
      `You may create or edit files under these paths and nowhere else: ${ownedPaths.join(', ')}. Files you change outside them are not discarded - they are compared against this boundary when your work is reviewed and named in the record of it.`,
    )
  }
  lines.push(
    'Everything you write is English. When you stop, answer every acceptance criterion in turn: met, not met, or could not check.',
  )
  return lines.join(' ')
}

/**
 * Which of a bee's committed files fell outside the boundary it was given.
 *
 * `queend` has been able to answer the `boundary` question since it was
 * written and nothing has ever asked it: the one place holding both halves of
 * the comparison threw the file names away at `.length`. This is the caller,
 * and deliberately only that - the comparison itself stays in
 * `QueenBoundaryPaths`, one rule for the container and the Mac.
 *
 * The ROOT is the project directory, not the checkout root, and that is the
 * whole subtlety. `committedFiles` runs `git diff --name-only` from the
 * repository root, so a path arrives as `trios/docs/x.md` while an owned path
 * may be spelled either repository-relative (`trios/docs/x.md`, as #1306's
 * own boundary is) or project-relative (`docs/x.md`). The policy reduces BOTH
 * halves to the project-relative namespace before comparing, so either
 * spelling of a boundary accepts the writes it names.
 * `QueenBoundaryPaths.strippingProject` drops the LAST component of the root
 * it is handed, so handing it `/workspace/BrowserOS` would strip nothing and
 * report every correct write as a stray - the same false accusation that
 * file's own header records being paid for on #1286.
 *
 * Empty on any failure, and empty when the issue declared no boundary: a task
 * that owns no paths is not a task that owns everything, and `strays` says so
 * on the Swift side too. A boundary question that cannot be asked must not
 * invent an accusation.
 */
async function boundaryStrays(
  files: string[],
  ownedPaths: string[],
): Promise<string[]> {
  if (files.length === 0 || ownedPaths.length === 0) return []
  const answer = await askQueend({
    kind: 'boundary',
    writes: files,
    ownedPaths,
    root: `${workspaceRoot()}/trios`,
  }).catch((error) => {
    logger.warn('Queen could not check the boundary of finished work', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })
  return answer?.strays ?? []
}

/**
 * Read each finished turn's own verdict block and decide on it.
 *
 * The bee ends its last message with a VERDICT block: one line per acceptance
 * criterion, met / unmet / could-not-check. That is parsed here and handed to
 * `QueenReviewDecision` through queend - the same policy the Mac uses, so a
 * task judged in the cloud and a task judged on a laptop get the same answer.
 *
 * `could-not-check` counts as UNMET. A criterion nobody verified has not been
 * satisfied, and treating "I could not tell" as "yes" is how work closes on
 * faith. The bee is told this in its brief so the accounting is not a surprise.
 *
 * Only an escalation reaches a person. accept releases the issue, sendBack
 * frees it to be dispatched again with the note, and wait leaves it alone.
 *
 * AND IT COUNTS THE RETURNS. `priorSendBacks` was the literal 0 here, which is
 * the sort of placeholder that reads as harmless and is not: the policy
 * escalates once the count reaches `QueenReviewDecision.maximumSendBacks` (2),
 * so a constant 0 made `0 < 2` permanently true and deleted the escalate arm
 * from the cloud path entirely. An issue whose criteria stayed unmet would be
 * returned for ever and never reach a person - and the note it was returned
 * with said "Returning this for a second pass" every single time, because
 * `sendBackNote` is given `priorSendBacks + 1`. The count now comes off the
 * row, so the fifth return says "sixth pass" and the third does not happen.
 */
interface ReviewRound {
  /** `#1234:accept`, one per dispatch judged this round. */
  acted: string[]
  /** Issues whose commit reached outside the boundary, and where. */
  strays: Array<{ issue: number; paths: string[] }>
}

async function reviewFinishedDispatches(pool: Pool): Promise<ReviewRound> {
  // TWO THINGS ABOUT THIS QUERY, BOTH MEASURED ON 2026-09-03.
  //
  // The say rows are joined with NOTHING between them, not a newline. The
  // scribe flushes the bee's text on a size-or-time bound (400 chars or 2.5 s),
  // so a row boundary can fall inside a word - and did: #1335's closing block
  // was stored as `## VERD` + `ICT`, the join put a newline between them, and
  // `parseVerdictBlock` found no header. The review recorded "0 of 5 criteria
  // judged so far" against a bee that had answered all five. Joining with the
  // empty string restores the stream the bee actually wrote; re-run against
  // every finished dispatch, exactly two headers came back whole (#1309, #1335)
  // and no intact one changed.
  //
  // `wait` is revisited, not just NULL. A wait verdict means "not judged yet",
  // and nothing ever judged it again: the sweep took `review_state IS NULL`
  // only, so a bee whose verdict was unreadable for any reason - a torn
  // header, a parser gap - held its boundary for the full 48 hours and then
  // fell off the board. Three sat that way today. A wait row is re-read each
  // round and rejudged; the UPDATE below overwrites it in place, so an
  // unchanged transcript yields the same wait and costs one query.
  const done = await pool.query(
    `SELECT d.issue, d.conversation_id, d.review_state,
            d.criteria, d.criteria_source, d.send_backs, d.owned_paths,
            (SELECT string_agg(t.text, '' ORDER BY t.seq)
               FROM queen_transcript t
              WHERE t.conversation_id = d.conversation_id AND t.kind = 'say')
              AS said
       FROM queen_dispatch d
      WHERE d.started = true AND d.finished_at IS NOT NULL
        AND (d.review_state IS NULL OR d.review_state = 'wait')
        AND d.outcome NOT LIKE 'reaped%'`,
  )
  const acted: string[] = []
  const strayed: Array<{ issue: number; paths: string[] }> = []
  for (const row of done.rows) {
    const said = String(row.said ?? '')
    const verdicts = parseVerdictBlock(said)
    // The contract this bee was given, read from ITS dispatch row rather than
    // from the issue as it stands now - an issue edited mid-flight would
    // otherwise judge a worker against a criterion it was never told.
    //
    // `totalCriteria` was `verdicts.length` and that made the check circular: a
    // bee that reported nothing was judged against nothing, so the policy saw
    // zero criteria and escalated to a person. Three finished bees went that
    // way on 2026-08-31 with the operator having said in plain terms that the
    // Queen must not wait on their review.
    const promised = Array.isArray(row.criteria)
      ? (row.criteria as string[])
      : []
    // A bee that wrote MORE lines than it was given is judged on what it wrote:
    // that is the case where the Queen supplied none and the bee stated its
    // own, which the brief asks for.
    const totalCriteria = Math.max(promised.length, verdicts.length)
    // ONE git diff, asked once and used twice. The count is what the review
    // policy weighs; the names are what the boundary rule compares. Calling
    // `committedFileCount` and then `committedFiles` would run the same diff
    // against the same branch twice and could, between the two, disagree.
    const files = await committedFiles(row.issue as number)
    const strays = await boundaryStrays(files, row.owned_paths ?? [])
    if (strays.length > 0) {
      strayed.push({ issue: row.issue as number, paths: strays })
      logger.warn('Queen found work outside the boundary she gave', {
        issue: row.issue,
        strays: strays.slice(0, 20),
      })
    }
    // The real count, not the literal 0 that used to sit here.
    //
    // Postgres hands an `integer` back as a JS number, but the column is read
    // through a driver that has returned strings for wider integer types in
    // this same file, so it is coerced rather than trusted: `'2' < 2` is true
    // in JSON only after Number() has been applied on the Swift side, and it
    // is not - `priorSendBacks` decodes as Int and a string would make queend
    // refuse the whole question.
    const priorSendBacks = Number(row.send_backs ?? 0) || 0
    const answer = await askQueend({
      kind: 'review',
      verdicts: verdicts.map((v) => ({ criterion: v.criterion, met: v.met })),
      totalCriteria,
      committedFiles: files.length,
      priorSendBacks,
    }).catch(() => null)
    const state = String(answer?.verdict ?? 'wait')
    logger.info('Queen reviewed her own work', {
      issue: row.issue,
      verdict: state,
      criteria: totalCriteria,
      judged: verdicts.length,
      source: row.criteria_source ?? 'none',
      priorSendBacks,
      strays: strays.length,
    })
    await pool.query(
      // The increment is part of the same statement that records the verdict,
      // because a count kept by a second write is a count that a crash between
      // the two makes wrong in the direction that matters: an issue whose
      // send-backs are undercounted is an issue that never escalates.
      `UPDATE queen_dispatch
          SET review_state = $2, review_note = $3, reviewed_at = now(),
              strays = $4::jsonb,
              send_backs = CASE WHEN $2::text = 'sendBack'
                                THEN send_backs + 1 ELSE send_backs END
        WHERE issue = $1`,
      [
        row.issue,
        state,
        String(answer?.note ?? answer?.refusal ?? '').slice(0, 900),
        JSON.stringify(strays),
      ],
    )
    acted.push(`#${row.issue}:${state}`)
  }
  return { acted, strays: strayed }
}

/** The bee's own VERDICT block, or nothing. */
export function parseVerdictBlock(
  text: string,
): Array<{ criterion: string; met: boolean }> {
  const at = text.lastIndexOf('## VERDICT')
  if (at < 0) return []
  const out: Array<{ criterion: string; met: boolean }> = []
  // A WRAPPED CRITERION IS STILL ONE CRITERION.
  //
  // Read line by line, a bullet that runs onto a second line did not match, and
  // the loop then BROKE - so one wrap silently discarded the whole rest of the
  // block. Measured on #1272: the bee wrote all nine criteria and marked every
  // one met; the fourth was
  //
  //   - `grep -c "why is
  //    it green at this number" Makefile` prints `1`: met
  //
  // and the review counted "3 of 9 criteria judged so far" and answered wait.
  // Finished, correct work was held because a line was too long.
  //
  // Joining first, and only then splitting on bullets, keeps the original rule
  // intact: a line that follows a COMPLETE bullet still ends the block, because
  // the bee was told nothing follows it. Only a line continuing an unfinished
  // bullet is glued on.
  const joined: string[] = []
  for (const raw of text.slice(at).split('\n').slice(1)) {
    const isBullet = /^\s*[-*]\s/.test(raw)
    const previous = joined[joined.length - 1]
    const previousIsComplete =
      previous === undefined ||
      /:\s*(met|unmet|could-not-check)\s*$/i.test(previous)
    if (!isBullet && !previousIsComplete && raw.trim() !== '') {
      joined[joined.length - 1] = `${previous} ${raw.trim()}`
      continue
    }
    joined.push(raw)
  }
  for (const line of joined) {
    const m = line.match(/^\s*[-*]\s*(.+?):\s*(met|unmet|could-not-check)\s*$/i)
    if (!m) {
      // A blank line inside the block is fine; anything else ends it, because
      // the bee was told nothing follows the block.
      if (line.trim() === '') continue
      break
    }
    out.push({
      criterion: m[1].trim().slice(0, 300),
      // could-not-check is UNMET. An unverified criterion is not a satisfied
      // one, and this is the line that decides whether the swarm can close its
      // own work honestly.
      met: m[2].toLowerCase() === 'met',
    })
  }
  return out
}

/**
 * The kinds a parked escalation can be sorted into (#1362).
 *
 * An escalation raised because every criterion was met but nothing was
 * committed is not a question for a person at all - it is a defect in the
 * bee's run, and the operator who reads "escalate" deserves to know that
 * immediately rather than after opening the transcript. An escalation raised
 * because the ISSUE cannot be satisfied is the opposite: no bee will ever fix
 * it, and retrying is exactly the wrong answer. Everything else is a person's
 * decision, and guessing a cause there is worse than admitting one is unknown
 * - a wrong kind is acted on with more confidence than no kind at all.
 */
export const ESCALATION_KINDS = [
  /** Every criterion met, no files committed: the run is the defect. */
  'no-files-produced',
  /** A criterion names an unavailable tool, or the boundary names no path a
   *  bee can reach: no attempt can satisfy the issue as written. */
  'issue-unworkable',
  /** The cause was not determined. The default, and it keeps waiting. */
  'needs-a-person',
] as const
export type EscalationKind = (typeof ESCALATION_KINDS)[number]

/** What the classifier is allowed to look at, and nothing else. */
export interface EscalationEvidence {
  /** The bee's own verdict lines, as parsed from its transcript. */
  verdicts: Array<{ criterion: string; met: boolean }>
  /** How many files the finished branch committed. */
  committedFiles: number
  /** The criteria the dispatch was judged against, as recorded with it. */
  criteria?: string[]
  /** The boundary paths the issue declared. */
  boundaryPaths?: string[]
  /**
   * Whether a tool named by a criterion exists in the worker container.
   * Injectable so a test can decide the answer; the default actually asks
   * the shell, because a kind assigned without checking is a guess.
   */
  toolAvailable?: (tool: string) => boolean
  /**
   * Whether a boundary path is one a bee can reach in its checkout. Relative
   * paths are reachable (a bee may create files that do not exist yet - most
   * boundaries NAME files the work is about to add); absolute paths elsewhere,
   * and paths that escape the checkout, are not. Injectable for the same
   * reason as `toolAvailable`.
   */
  pathReachable?: (path: string) => boolean
}

/**
 * The first command-looking word of the first backtick span in a criterion,
 * or nothing.
 *
 * Criteria in this repository quote their commands - "`bun test` exits 0",
 * "`grep -c ... Makefile` prints `1`" - and the command is the first word of
 * the span. Only the FIRST word, because "make check" names `make`, and a
 * later word like `check` is an argument that `command -v` will not find and
 * a false accusation would be built on. Only command-shaped words (lowercase,
 * no dot, no slash) so a span that opens with a file or an option cannot be
 * read as a tool.
 */
function commandNamedBy(criterion: string): string | null {
  const spans = criterion.match(/`[^`]+`/g) ?? []
  for (const span of spans) {
    const first = span.slice(1, -1).trim().split(/\s+/)[0] ?? ''
    if (/^[a-z][a-z0-9_-]+$/.test(first)) return first
  }
  return null
}

/** The default tool check: ask the shell, do not assume. */
function shellHasTool(tool: string): boolean {
  return (
    spawnSync('sh', ['-c', `command -v ${JSON.stringify(tool)}`]).status === 0
  )
}

/**
 * The default reachability check: can a bee in its checkout create or edit a
 * file at this path?
 *
 * Existence is deliberately NOT the test - a boundary that names a file the
 * work is about to add is the ordinary case, and a checker that called every
 * not-yet-existing path unreachable would condemn nearly every legitimate
 * boundary. What a bee cannot reach is a path outside its checkout: absolute
 * paths elsewhere, home-directory shortcuts, empty names, or anything that
 * climbs out with `..` or is spelled with a glob or a variable.
 */
function reachableFromCheckout(path: string): boolean {
  if (path.length === 0) return false
  if (path.startsWith('/') || path.startsWith('~')) return false
  const parts = path.split('/').filter((s) => s.length > 0)
  if (parts.length === 0) return false
  return parts.every(
    (s) =>
      s !== '.' &&
      s !== '..' &&
      !s.includes('*') &&
      !s.includes('$') &&
      !s.includes('"') &&
      !s.includes("'"),
  )
}

/**
 * Say which kind of escalation this is, from the evidence, and say nothing
 * specific when the evidence does not determine it (#1362).
 *
 * The two named kinds are the only ones assigned, and each needs POSITIVE
 * evidence: every criterion met against zero committed files (the exact
 * condition the review policy escalates on), a criterion naming a tool the
 * container verifiably lacks, or a boundary whose every path a bee cannot
 * reach. Anything short of that is `needs-a-person` - the default is the
 * unknown, not the best guess, because the kinds exist to be acted on by an
 * operator and a confident wrong label is the most expensive thing here.
 *
 * Pure on its inputs; the environment checks are parameters with honest
 * defaults, so a test can decide what the container knows.
 */
export function classifyEscalation(evidence: EscalationEvidence): {
  kind: EscalationKind
  reason: string
} {
  const verdicts = evidence.verdicts ?? []
  const everyCriterionMet = verdicts.length > 0 && verdicts.every((v) => v.met)
  if (everyCriterionMet && evidence.committedFiles === 0) {
    return {
      kind: 'no-files-produced',
      reason:
        'every criterion was marked met but no files were committed - the ' +
        "defect is in the bee's run, not a question for a person",
    }
  }
  const toolAvailable = evidence.toolAvailable ?? shellHasTool
  for (const criterion of evidence.criteria ?? []) {
    const tool = commandNamedBy(criterion)
    if (tool !== null && !toolAvailable(tool)) {
      return {
        kind: 'issue-unworkable',
        reason:
          `criterion "${criterion}" names \`${tool}\`, which is not ` +
          'available in the worker container - the issue cannot be satisfied ' +
          'as written',
      }
    }
  }
  const boundary = evidence.boundaryPaths ?? []
  if (boundary.length > 0) {
    const pathReachable = evidence.pathReachable ?? reachableFromCheckout
    if (boundary.every((p) => !pathReachable(p))) {
      return {
        kind: 'issue-unworkable',
        reason:
          'the boundary names no path a bee can reach in its checkout: ' +
          boundary.join(', '),
      }
    }
  }
  return {
    kind: 'needs-a-person',
    reason: 'the cause was not determined',
  }
}

/** What one round's send-back pass did, for the report and the log. */
export interface RetryRound {
  /** Issues handed to a bee again, with what the dispatch answered. */
  retried: Array<{
    issue: number
    started: boolean
    conversationId?: string
    keyIndex?: number
  }>
  /** Issues whose send-backs reached the ceiling and became escalations. */
  ceilinged: number[]
  /** Issues left alone because they are no longer open: the work is not
   *  wanted, and neither a retry nor an escalation is. */
  skippedClosed: number[]
}

/**
 * Re-open the send-back valve (#1362): return parked `sendBack` verdicts to a
 * bee, up to `SEND_BACK_RETRY_CEILING`, and escalate the ones past it.
 *
 * WHY THIS IS NOT A `choose` QUESTION. The policy holds an issue whose task
 * is `rejected` on purpose - "the same bee is expected back" - so a sent-back
 * issue can never be re-chosen, and before this pass the expectation was
 * recorded and then nothing came: an issue got one attempt, and its remaining
 * work was stranded. Seven sat that way on 2026-09-03. This pass re-opens
 * them directly, which is why it carries its own copy of the worker limit
 * rather than borrowing the policy's `canStartAnother`.
 *
 * WHAT KEEPS IT FROM LOOPING. `send_backs` - the counter the review
 * increments on every return and that the dispatch upsert deliberately does
 * not reset. Under the ceiling the issue is re-dispatched with fresh criteria
 * and the previous unmet list; at the ceiling it is NOT re-dispatched and its
 * state becomes an escalation whose recorded reason names the ceiling. A bee
 * that cannot satisfy a criterion will not satisfy it on the fourth attempt
 * either, and the ceiling is what stops the budget burning on one issue.
 *
 * WHAT IT NEVER DOES: touch an escalation. Only `review_state = 'sendBack'`
 * rows are read, so a verdict that is waiting for a person keeps waiting -
 * an escalation automatically retried is worse than one parked, if the cause
 * was a person's decision.
 *
 * CRITERIA ARE RE-READ AT RETRY TIME from the issue body this round fetched,
 * not from the previous dispatch row: an operator may have corrected the
 * issue between attempts, and judging the second bee against criteria the
 * first one was failed on is how a retry becomes unfixable by construction.
 */
export async function redispatchSentBackWork(
  pool: Pool,
  repo: string,
  /** The issues GitHub says are open this round. */
  candidates: number[],
  /** Their bodies, fetched this round - the retry's criteria come from here. */
  candidateBodies: Record<string, string>,
  /** This round's spec verdicts, so criteria are parsed from the CURRENT body. */
  specVerdicts: Record<string, SpecVerdict>,
  /** Bees already running, so retries respect the worker limit. */
  running: number = 0,
  /** Provider keys already held by running bees. */
  takenKeyIndices: number[] = [],
  /** The lease watch: a round that has lost the lease dispatches nothing. */
  watch?: LeaseWatch,
): Promise<RetryRound> {
  const round: RetryRound = { retried: [], ceilinged: [], skippedClosed: [] }
  // Oldest first, so the issue stranded longest gets the next attempt before
  // the budget does anything else with itself.
  const parked = await pool.query(
    `SELECT d.issue, d.send_backs, d.conversation_id,
            (SELECT string_agg(t.text, '' ORDER BY t.seq)
               FROM queen_transcript t
              WHERE t.conversation_id = d.conversation_id AND t.kind = 'say')
              AS said
       FROM queen_dispatch d
      WHERE d.started = true AND d.finished_at IS NOT NULL
        AND d.review_state = 'sendBack'
        AND d.outcome NOT LIKE 'reaped%'
        AND d.dispatched_at > now() - interval '7 days'
      ORDER BY d.finished_at`,
  )
  let inFlightBees = running
  let taken = [...takenKeyIndices]
  for (const row of parked.rows) {
    const issue = Number(row.issue)
    // The work is no longer wanted: no retry, and no escalation either - a
    // closed issue does not become a person's problem by queueing behind
    // eleven open ones.
    if (!candidates.includes(issue)) {
      round.skippedClosed.push(issue)
      logger.info('Sent-back work skipped: the issue is no longer open', {
        issue,
      })
      continue
    }
    const sendBacks = Number(row.send_backs ?? 0) || 0
    if (sendBacks >= SEND_BACK_RETRY_CEILING) {
      await pool.query(
        // The WHERE re-checks the verdict it is replacing, so a row a second
        // process has already moved on is left alone rather than stamped
        // twice - and so this statement is idempotent on a re-run.
        `UPDATE queen_dispatch
            SET review_state = 'escalate',
                review_note = $2,
                reviewed_at = now()
          WHERE issue = $1 AND review_state = 'sendBack'`,
        [
          issue,
          `send-back retry ceiling of ${SEND_BACK_RETRY_CEILING} reached: ` +
            `returned ${sendBacks} time(s) and not re-dispatched - a further ` +
            `attempt would repeat a conversation that has not moved, so this ` +
            `needs a person`,
        ],
      )
      round.ceilinged.push(issue)
      continue
    }
    if (watch && !watch.held) {
      logger.warn(
        'Queen lease moved before a send-back retry; not dispatched',
        {
          issue,
        },
      )
      continue
    }
    if (inFlightBees >= MAXIMUM_CONCURRENT_WORKERS) {
      logger.info('Sent-back work waits: the swarm is at its worker limit', {
        issue,
        running: inFlightBees,
      })
      continue
    }
    // Everything the second bee is told is re-read NOW: the criteria from the
    // issue body this round fetched, the boundary re-parsed from the same
    // body, and the previous unmet list from the previous attempt's own
    // verdict block.
    const body = candidateBodies[String(issue)] ?? ''
    const spec = specVerdicts[String(issue)]
    const criteria = spec?.criteria ?? []
    const criteriaSource = spec?.criteriaSource ?? 'none'
    const paths = boundaryPathsOf(body)
    const unmet = parseVerdictBlock(String(row.said ?? ''))
      .filter((v) => !v.met)
      .map((v) => v.criterion)
    const dispatch = await dispatchBee(
      pool,
      issue,
      briefFor(issue, repo, paths, body, criteria, criteriaSource, {
        unmet,
        sendBacks,
      }),
      paths,
      taken,
      criteria,
      criteriaSource,
    )
    round.retried.push({
      issue,
      started: dispatch.started,
      conversationId: dispatch.conversationId,
      keyIndex: dispatch.keyIndex,
    })
    // Mark the attempt as a retry, AFTER the dispatch row exists. The upsert
    // in `recordDispatch` does not name this column - the same deliberate
    // omission that keeps `send_backs` accumulating - so it survives as the
    // one thing saying this row is a second attempt and not a first.
    //
    // Whether or not the dispatch STARTED: a refusal is still a retry
    // attempt, recorded on this same row, and a first attempt that could not
    // start must stay distinguishable from a retry that could not.
    await pool.query(
      `UPDATE queen_dispatch
          SET send_back_retry = true,
              escalation_kind = NULL,
              escalation_reason = NULL
        WHERE issue = $1`,
      [issue],
    )
    if (!dispatch.started) break
    inFlightBees += 1
    if (typeof dispatch.keyIndex === 'number') {
      taken = [...taken, dispatch.keyIndex]
    }
  }
  return round
}

/**
 * The send-back valve's share of one round, extracted from `runRound` whole:
 * measure what is running, re-open what was sent back, and say what started.
 *
 * The extraction is not cosmetic. `runRound` grew past the complexity the
 * linter holds it to the moment this pass landed in it inline, and the honest
 * fix was to name the pass rather than to suppress the rule - a round that
 * reads as six inline blocks is a round whose order nobody can check.
 *
 * Returns the retry round (for the report), a board task for every bee the
 * pass started (the round folds them in the same way its own dispatch loop
 * folds its starts), and the keys in use WITH the ones the retries took - so
 * the dispatch loop that follows can never hand a retry's key to a second bee.
 */
async function reopenSentBackWork(
  pool: Pool,
  repo: string,
  candidates: number[],
  candidateBodies: Record<string, string>,
  specVerdicts: Record<string, SpecVerdict>,
  /** The board as the round has drawn it: the registry mirror plus its own dispatches. */
  tasksOnBoard: Array<{ state?: string }>,
  /** The round's own dispatch rows, for the keys still held by running bees. */
  inFlight: Array<{ finished_at: unknown; key_index: unknown }>,
  owner: string,
  repoName: string,
  watch: LeaseWatch,
): Promise<{
  retry: RetryRound
  reopened: ReturnType<typeof boardTask>[]
  keysInUse: number[]
}> {
  const running = tasksOnBoard.filter((t) => t.state === 'running').length
  const heldKeys = inFlight
    .filter((r) => r.finished_at == null)
    .map((r) => r.key_index)
    .filter((i): i is number => typeof i === 'number')
  const retry = await redispatchSentBackWork(
    pool,
    repo,
    candidates,
    candidateBodies,
    specVerdicts,
    running,
    heldKeys,
    watch,
  )
  if (retry.retried.length > 0) {
    logger.info('Queen re-opened sent-back work', {
      issues: retry.retried.map((r) => r.issue),
    })
  }
  if (retry.ceilinged.length > 0) {
    logger.info('Sent-back work reached the retry ceiling and escalated', {
      issues: retry.ceilinged,
      ceiling: SEND_BACK_RETRY_CEILING,
    })
  }
  const reopened: ReturnType<typeof boardTask>[] = []
  for (const again of retry.retried) {
    if (!again.started) continue
    reopened.push(
      boardTask(owner, repoName, {
        conversationId: again.conversationId ?? null,
        issue: again.issue,
        ownedPaths: boundaryPathsOf(candidateBodies[String(again.issue)] ?? ''),
        branch: `queen-${again.issue}`,
        at: new Date().toISOString(),
        title: 're-opened by this round after a send-back',
      }),
    )
  }
  return {
    retry,
    reopened,
    keysInUse: [
      ...heldKeys,
      ...retry.retried
        .filter((r) => r.started && typeof r.keyIndex === 'number')
        .map((r) => r.keyIndex as number),
    ],
  }
}

/** One classified escalation. */
export interface EscalationClassification {
  issue: number
  kind: EscalationKind
  reason: string
}

/**
 * Name the cause of every parked escalation that has none (#1362).
 *
 * An escalation waits for a person, and the queue was invisible: six sat on
 * 2026-09-03, one of them the very issue about the stuck valve. This pass
 * writes `escalation_kind` and `escalation_reason` on rows the review
 * escalated and nobody ever looked at again, using `classifyEscalation` on
 * the evidence the row and its transcript still hold.
 *
 * IT DISPATCHES NOTHING. Classification is a label for the operator; acting
 * on a kind - retrying a run defect, closing an unworkable issue - is a
 * separate decision, made by a person, on a queue they can finally see.
 *
 * The seven-day horizon matches the board's: past it a row is not on the
 * board at all, and the reporter (`tools/parked-dispatch-report.mjs`) is the
 * tool for those. Inside it, a branch's files are still measurable, which
 * matters because `no-files-produced` leans on that count.
 */
export async function classifyParkedEscalations(
  pool: Pool,
): Promise<EscalationClassification[]> {
  const parked = await pool.query(
    `SELECT d.issue, d.conversation_id, d.criteria, d.owned_paths,
            (SELECT string_agg(t.text, '' ORDER BY t.seq)
               FROM queen_transcript t
              WHERE t.conversation_id = d.conversation_id AND t.kind = 'say')
              AS said
       FROM queen_dispatch d
      WHERE d.started = true AND d.finished_at IS NOT NULL
        AND d.review_state = 'escalate'
        AND d.escalation_kind IS NULL
        AND d.outcome NOT LIKE 'reaped%'
        AND d.dispatched_at > now() - interval '7 days'
      ORDER BY d.finished_at`,
  )
  const classified: EscalationClassification[] = []
  for (const row of parked.rows) {
    const issue = Number(row.issue)
    const verdicts = parseVerdictBlock(String(row.said ?? ''))
    const files = await committedFiles(issue)
    const answer = classifyEscalation({
      verdicts,
      committedFiles: files.length,
      criteria: Array.isArray(row.criteria) ? (row.criteria as string[]) : [],
      boundaryPaths: Array.isArray(row.owned_paths)
        ? (row.owned_paths as string[])
        : [],
    })
    await pool.query(
      // The WHERE re-checks kind IS NULL, so two rounds overlapping cannot
      // overwrite each other's classification and a re-run is a no-op.
      `UPDATE queen_dispatch
          SET escalation_kind = $2, escalation_reason = $3
        WHERE issue = $1 AND review_state = 'escalate'
          AND escalation_kind IS NULL`,
      [issue, answer.kind, answer.reason.slice(0, 900)],
    )
    classified.push({ issue, kind: answer.kind, reason: answer.reason })
  }
  return classified
}

/**
 * One round, in sentences, for whoever is not reading the logs.
 *
 * The operator gives the direction and is told afterwards, so being told has to
 * be a thing the system does rather than a thing they go and find. A log line
 * is not a report: reading it means already knowing which lines matter.
 *
 * Written even when the round did nothing. "Nothing happened and here is why"
 * is the most useful sentence this can produce, because it is the question
 * somebody actually opens the page with.
 */
async function report(
  pool: Pool,
  reviewed: ReviewRound,
  retry: RetryRound,
  classified: EscalationClassification[],
  started: Array<{ started?: boolean; issue?: number; detail?: string }>,
  choice: QueendChoice,
  candidates: number,
): Promise<void> {
  const lines: string[] = []
  const escalated = reviewed.acted.filter((r) => r.endsWith(':escalate'))
  const accepted = reviewed.acted.filter((r) => r.endsWith(':accept'))
  const sentBack = reviewed.acted.filter((r) => r.endsWith(':sendBack'))

  if (retry.retried.length > 0) {
    lines.push(
      `Re-opened ${retry.retried.length} sent-back issue(s) for another pass: ` +
        retry.retried.map((r) => `#${r.issue}`).join(', ') +
        '.',
    )
  }
  if (retry.ceilinged.length > 0) {
    lines.push(
      `${retry.ceilinged.length} sent-back issue(s) reached the retry ceiling ` +
        `of ${SEND_BACK_RETRY_CEILING} and now wait for you: ` +
        retry.ceilinged.map((i) => `#${i}`).join(', ') +
        '.',
    )
  }
  if (classified.length > 0) {
    const byKind: Record<string, number> = {}
    for (const c of classified) {
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1
    }
    lines.push(
      `Classified ${classified.length} parked escalation(s): ` +
        Object.entries(byKind)
          .map(([kind, count]) => `${kind}=${count}`)
          .join(', ') +
        '.',
    )
  }
  if (started.length > 0) {
    lines.push(
      `Started ${started.length} bee(s): ` +
        started.map((d) => `#${d.issue}`).join(', ') +
        '.',
    )
  }
  if (accepted.length > 0) {
    lines.push(`Accepted ${accepted.length}: ${accepted.join(', ')}.`)
  }
  if (sentBack.length > 0) {
    lines.push(
      `Sent back ${sentBack.length} for another pass: ${sentBack.join(', ')}.`,
    )
  }
  if (escalated.length > 0) {
    lines.push(
      `ESCALATED ${escalated.length} to you - the policy would not decide these ` +
        `on its own: ${escalated.join(', ')}.`,
    )
  }
  // The boundary, reported rather than only recorded.
  //
  // The brief tells a bee its out-of-boundary work is named and reported. That
  // sentence replaced one saying such work is "dropped", which nothing did -
  // and replacing an unkept promise with a second unkept promise would be the
  // same defect wearing a different word. This is the line that makes it true.
  for (const stray of reviewed.strays) {
    lines.push(
      `#${stray.issue} committed ${stray.paths.length} file(s) outside the ` +
        `boundary it was given: ${stray.paths.slice(0, 8).join(', ')}` +
        (stray.paths.length > 8 ? ', ...' : '') +
        '.',
    )
  }
  if (started.length === 0) {
    // The refusal, verbatim. A round that started nothing is the case where a
    // summary in my own words would be the least trustworthy thing on the page.
    lines.push(
      `Started nothing. ${choice.refusal ?? 'No reason given'}. ` +
        `${candidates} issue(s) were on the table.`,
    )
    const skipped = (choice.skipped ?? []).slice(0, 6)
    if (skipped.length > 0) lines.push('', ...skipped.map((s) => `  ${s}`))
  }

  const headline =
    escalated.length > 0
      ? `${escalated.length} waiting on you`
      : started.length > 0
        ? `${started.length} bee(s) working`
        : (choice.refusal ?? 'nothing to do')

  await pool
    .query(
      `INSERT INTO queen_report (headline, body, needs_you)
       VALUES ($1, $2, $3)`,
      [
        headline.slice(0, 200),
        lines.join('\n').slice(0, 4000),
        escalated.length > 0,
      ],
    )
    .catch(() => {
      // A report that will not save must not take the round down with it.
    })
}

/**
 * The tick's own record, fenced.
 *
 * `fence >= excluded.fence` is what makes a stalled holder harmless: it wakes,
 * writes its decision from a term that has ended, and the row refuses it because
 * a later term has already written. Without this the last writer wins, and the
 * last writer is exactly the process that was too slow to still be the Queen.
 */
async function recordTick(
  pool: Pool,
  holder: string,
  fence: number,
  choice: QueendChoice,
): Promise<void> {
  await pool.query(
    `INSERT INTO queen_tick (name, holder, fence, decided_at, decision)
     VALUES ($1, $2, $3, now(), $4::jsonb)
     ON CONFLICT (name) DO UPDATE
       SET holder = EXCLUDED.holder,
           fence = EXCLUDED.fence,
           decided_at = EXCLUDED.decided_at,
           decision = EXCLUDED.decision
       WHERE queen_tick.fence <= EXCLUDED.fence`,
    [LEASE_NAME, holder, fence, JSON.stringify(choice)],
  )
}

/**
 * The refill gate (#1295): one local round at a time, woken by finished bees.
 *
 * WHY IT EXISTS. A bee's completion frees a healthy paid key, and until this
 * the next eligible mission waited for the periodic tick - up to 1,800 seconds
 * of idle capacity per finished bee, on a swarm whose whole point is that no
 * laptop has to be awake to keep it busy. The timer stays; it is the
 * guarantee that rounds happen even when nothing finishes. The gate only
 * decides WHEN a round starts.
 *
 * WHY A GATE AND NOT A CALL. Two rounds in one process is a reachable state,
 * not a theoretical one - the heartbeat comment above records the timer and
 * the on-demand route overlapping, and a refill signal arriving mid-round
 * would have made it routine. Both rounds would hold the lease as the SAME
 * holder (acquisition renews on `holder = EXCLUDED.holder`), so nothing
 * stops the second one, and it reads a board the first round is still
 * writing - dispatches recorded, keys taken. One round at a time is the only
 * shape that cannot race itself.
 *
 * WORK-CONSERVING AND SINGLE-FLIGHT, by construction: a request while a
 * round runs sets ONE flag, and the round's own ending starts at most ONE
 * follow-up. A burst of completions coalesces; a signal arriving during the
 * follow-up starts another after it, so nothing that asks is ever dropped.
 *
 * NOT A SECOND SCHEDULER. There is no clock in here - no interval, no delay,
 * no queue that outlives a round. Every round runs through the one runner it
 * was handed, which in production is `runQueenTickOnce`: the same lease, the
 * same fencing, the same `queend`, the same dispatch loop. The periodic timer
 * remains the only thing that wakes the gate on its own.
 */
export interface RoundGate {
  /** Ask for one round: start it now if idle, coalesce if one is running. */
  request(why: string): void
  /** Resolves once no round is running and none is queued. */
  idle(): Promise<void>
  /** Rounds this gate has started, so tests and logs can count them. */
  roundsStarted(): number
  /** The most rounds this gate has ever had in flight at once. Must be 1. */
  maxInFlight(): number
  /** Refuse further rounds (shutdown). A round already running finishes. */
  stop(): void
}

export function createRoundGate(runOneRound: () => Promise<void>): RoundGate {
  let running = false
  let wanted = false
  let stopped = false
  let started = 0
  let inFlight = 0
  let peak = 0
  let waiters: Array<() => void> = []

  /** Wake everyone once the gate is truly empty: nothing running, nothing
   *  queued. Called from the one place those two facts can both be true. */
  const settle = () => {
    if (running || wanted) return
    const due = waiters
    waiters = []
    for (const wake of due) wake()
  }

  async function turn(why: string): Promise<void> {
    running = true
    started += 1
    inFlight += 1
    peak = Math.max(peak, inFlight)
    logger.info('Queen round starting', { why, round: started })
    try {
      await runOneRound()
    } catch (error) {
      // The production runner catches its own failures; this is the belt
      // under that, because a gate whose turn rejects would drop every
      // follow-up signal with it.
      logger.warn('Queen round failed inside the refill gate', {
        why,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    inFlight -= 1
    running = false
    if (wanted && !stopped) {
      // ONE follow-up, started here and not awaited: awaiting it would
      // chain every later round onto the first caller's stack, and the
      // caller - a stream that just ended - has nothing left to wait for.
      wanted = false
      void turn('follow-up: a bee finished while a round was running')
      return
    }
    settle()
  }

  return {
    request(why: string): void {
      if (stopped) return
      if (running) {
        // The flag, not a count: however many bees finished, the board is
        // read once and the follow-up sees them all.
        wanted = true
        return
      }
      void turn(why)
    },
    idle(): Promise<void> {
      return new Promise((resolve) => {
        waiters.push(resolve)
        settle()
      })
    },
    roundsStarted: () => started,
    maxInFlight: () => peak,
    stop(): void {
      // Mirror of `handover` clearing the interval: no round may START after
      // the process has given the hive away. A refill round that re-acquired
      // the lease after SIGTERM would pin the hive to a dying container for
      // the TTL, which is the failure the handover exists to prevent.
      stopped = true
      wanted = false
      settle()
    },
  }
}

/**
 * Connect a durable bee completion to the round gate.
 *
 * EXPORTED FOR THE SUITE: the wiring is the feature. A gate that exists while
 * nothing signals it is indistinguishable from no gate, and the one line
 * `startQueenTick` adds is otherwise unreachable without a real timer - so
 * this is the seam the suite drives instead.
 */
export function refillOnBeeCompletion(request: (why: string) => void): void {
  setDurableCloseListener((issue) => request(`bee #${issue} finished`))
}

let timer: ReturnType<typeof setInterval> | undefined

/**
 * Start the loop, or explain why not.
 *
 * Off unless `TRIOS_QUEEN_TICK_SECONDS` is set, so that running the server
 * locally - for a test, for development, on a laptop alongside the app - does
 * not quietly enrol a second Queen. Enabling it is a deployment decision, made
 * once, on the deployment that is meant to hold the hive.
 */
export function startQueenTick(): void {
  const interval = tickIntervalSeconds()
  if (!interval) return
  const url = queenLeaseDatabaseUrl()
  if (!url) {
    logger.warn('Queen tick requested but no database is configured')
    return
  }

  const pool = new Pool({ connectionString: url })
  logger.info('Queen tick starting', {
    intervalSeconds: interval,
    holder: queenHolderName(),
  })

  // Clear the previous container's phantoms before the first round reads the
  // board. A row still in flight belongs to a process that died with the
  // deployment it ran in, and it holds its boundary against real work until
  // somebody notices.
  reapDispatchesFromPreviousBoot(pool)
    .then((issues) => {
      if (issues.length > 0) {
        logger.info('Queen tick reaped dispatches from a previous boot', {
          issues,
        })
      }
    })
    .catch(() => {})

  const round = async (): Promise<void> => {
    await runQueenTickOnce(pool).catch((error) => {
      // A failed round must not kill the loop. The next one may well succeed -
      // GitHub rate limits reset, a database blips - and a supervisor that stops
      // supervising on its first bad minute is worse than no supervisor, because
      // the app still reports one as running.
      logger.warn('Queen tick round failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  // THE GATE (#1295). One local round at a time, fed by the timer below AND
  // by finished bees: a durable completion asks for a round here instead of
  // waiting out the interval for one. The timer is unchanged - same interval,
  // same guard, still the only clock - and the gate holds no clock of its
  // own, so this adds no scheduler, only a queue of at most one.
  const gate = createRoundGate(round)
  refillOnBeeCompletion(gate.request)

  gate.request('service starting')
  timer = setInterval(() => gate.request('periodic tick'), interval * 1000)

  const handover = () => {
    if (timer) clearInterval(timer)
    // The gate with it, for the same reason as the timer: no round may start
    // after the process has handed the hive back.
    gate.stop()
    // Every beat, not one: a round in flight owns its own handle, and on
    // SIGTERM nobody is going to reach its `finally` before the process ends.
    for (const beat of heartbeats) clearInterval(beat)
    heartbeats.clear()
    releaseQueenLease(pool, LEASE_NAME, queenHolderName()).catch(() => {})
  }
  process.once('SIGTERM', handover)
  process.once('SIGINT', handover)
}
