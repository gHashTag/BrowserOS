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
 * What the loop still does NOT do: send a bee back. The policy answers
 * `sendBack` with the unmet criteria named, and nothing yet reopens the worker
 * on them - such a verdict is recorded and the task waits.
 */

import { spawn } from 'node:child_process'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import { outstandingEscalations } from '../routes/queen-needs-you'
import {
  type CriterionRun,
  criteriaCounts,
  criteriaWitness,
  isCriterionRuns,
  measurementLines,
  parseCriterionChecks,
} from './queen-criteria-run'
import {
  DISPATCH_OUTCOME_LABELS,
  dispatchBee,
  reapDispatchesFromPreviousBoot,
  reapStalledDispatches,
  setDurableCloseListener,
  type Witness,
  type WorkerProvider,
  witnessVerdicts,
  workspaceRoot,
} from './queen-dispatch'
import {
  acquireQueenLease,
  logLeaseOutcome,
  queenHolderName,
  queenLeaseDatabaseUrl,
  releaseQueenLease,
} from './queen-lease'
import {
  type DispatchReportOutcome,
  dispatchesThatStarted,
  nothingStartedLine,
  refusedLines,
  reportHeadline,
  startedLine,
} from './queen-report-lines'
import {
  chooseReviewerLane,
  criterionText,
  defaultReviewDeps,
  hasStatedReason,
  judgeReviewerText,
  markReviewerLaneFailed,
  measurementsPerRound,
  REVIEW_PATCH_MAX_CHARS,
  REVIEWER_SYSTEM_PROMPT,
  type ReviewDeps,
  type ReviewerAnswer,
  reviewerAnswers,
  reviewerFingerprint,
  reviewerLaneBackedOff,
  reviewerMessage,
  sameModelAs,
  visiblePatchPaths,
} from './queen-reviewer'

/**
 * The last non-secret allocator cursor already written durably. It survives a
 * scheduler cycle and makes a pool wider than the concurrency ceiling rotate
 * instead of starting at credential zero forever.
 */
export function latestProviderKeyIndex(
  rows: Array<{ key_index?: unknown; dispatched_at?: unknown }>,
): number | undefined {
  let latestAt = Number.NEGATIVE_INFINITY
  let latestIndex: number | undefined
  for (const row of rows) {
    const index = row.key_index
    const at =
      row.dispatched_at instanceof Date
        ? row.dispatched_at.getTime()
        : typeof row.dispatched_at === 'string'
          ? Date.parse(row.dispatched_at)
          : Number.NaN
    if (
      typeof index === 'number' &&
      Number.isInteger(index) &&
      index >= 0 &&
      Number.isFinite(at) &&
      at > latestAt
    ) {
      latestAt = at
      latestIndex = index
    }
  }
  return latestIndex
}

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

/**
 * Where RING-00 is, resolved exactly like `queend` above and for the same
 * reason: the container installs it, a test points at a build.
 *
 * `t27core` is the generated Rust reading of `rings/T27-00/queen_core.t27`
 * behind an argv CLI. Until this call site existed the ring was proven and
 * decorative - `tests/t27/ring00_parity.sh` ran fourteen rows through it and
 * nothing in production ran a single one.
 */
function t27corePath(): string {
  return process.env.TRIOS_T27CORE_PATH || '/usr/local/bin/t27core'
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
 *
 * It became one. Measured 2026-09-16: 751 open issues and 20 open pull requests
 * on the same endpoint, so the walk stopped at 500 and `complete` was false on
 * every round -- permanently. That is worse than guessing, because the drop in
 * `rememberIssues` is gated on `complete`: the board stopped retiring closed
 * issues entirely and became a graveyard. ~200 issues from July and August,
 * merged or closed months earlier, were re-reviewed on every tick, each one
 * holding a `claimed` slot and returning `wait` forever because their branches
 * no longer carry a spec for the compiler to judge. The queue drained into the
 * dead and the bees sat at 0 with 277 real cards waiting.
 *
 * The cap exists to protect the rate limit, so it is sized by what the limit
 * actually is. With `TRIOS_GITHUB_API_TOKEN` the ceiling is 5,000/hour and
 * thirty pages costs at most thirty of them; anonymous it stays at five, and a
 * repository this size will keep reporting a truncated list -- which is the
 * honest answer rather than a silent partial delete.
 */
const ISSUE_PAGE_CAP_ANON = 5
const ISSUE_PAGE_CAP_TOKEN = 30
const issuePageCap = (): number =>
  process.env.TRIOS_GITHUB_API_TOKEN?.trim()
    ? ISSUE_PAGE_CAP_TOKEN
    : ISSUE_PAGE_CAP_ANON

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
/**
 * Headers for a GitHub READ.
 *
 * Anonymous is 60 requests an hour per EGRESS IP, and on Railway that address
 * is shared with every other deployment on the host - so the budget this
 * server actually gets is an unknowable fraction of 60. Paginating the open
 * issues every TRIOS_QUEEN_TICK_SECONDS exhausts it, `openIssues` throws
 * `GitHub returned 403`, and the whole round dies before any bee is
 * dispatched. Measured on the live swarm: four such rounds between 16:50 and
 * 17:08 UTC on 2026-09-08, each one a tick that looked like it simply chose
 * nothing.
 *
 * A token lifts the ceiling to 5,000/hr. Read-only suffices - nothing on this
 * path writes - so it is deliberately a DIFFERENT variable from anything a bee
 * commits with, and it is optional: unset, this returns exactly the headers
 * this code sent before, and the anonymous limit applies as it always did.
 */
function githubReadHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  }
  const token = process.env.TRIOS_GITHUB_API_TOKEN?.trim()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/**
 * One word for what the oracle said about a review, for the log line.
 *
 * Without it the only way to know whether `zig test` ran in production was to
 * read the criterion text, and nothing logs or exposes that: a gate nobody can
 * observe is indistinguishable from one that is not running. Distinguishing
 * `not measured` from `pass` is the whole point -- an unmeasured spec must
 * never be reported as a passing one.
 */
export function oracleOutcome(witness: Witness | null): string {
  if (witness?.kind !== 'witnessed') return 'no witness'
  const measured = witness.specs.filter((s) => s.oracle !== null)
  if (measured.length === 0) {
    return witness.specs.some((s) => s.oraclePreBroken)
      ? 'pre-broken'
      : 'not measured'
  }
  const failing = measured.filter((s) => !s.oracle)
  if (failing.length === 0) return 'pass'
  // A failure the base already had is not this branch's failure, and
  // `witnessVerdicts` already refuses to charge the bee for it. The log word
  // said `fail` regardless, so the one line an operator reads contradicted
  // the verdict it sat next to - the disagreement recorded 2026-09-16 between
  // production `fail` and a local `pre-broken` on the same branches.
  return failing.every((s) => s.oraclePreBroken) ? 'pre-broken' : 'fail'
}

export async function openIssues(repo: string): Promise<{
  issues: Array<{ number: number; body: string; title: string }>
  complete: boolean
}> {
  const collected: Array<{ number: number; body: string; title: string }> = []
  let complete = false
  const cap = issuePageCap()
  for (let page = 1; page <= cap; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues` +
        `?state=open&per_page=${ISSUE_PAGE_SIZE}&page=${page}`,
      { headers: githubReadHeaders() },
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
      ADD COLUMN IF NOT EXISTS criteria_source text NOT NULL DEFAULT 'none',
      -- Whether this issue's boundary reaches beyond documentation (#1358):
      -- true when at least one owned path is not a .md file. Stored BESIDE
      -- delegatable and deliberately not consulted by it - the tick
      -- records the distinction so an operator can see how much of the
      -- backlog can only produce prose; whether the Queen may be steered by
      -- it is a separate decision that has not been made. A boundary of one
      -- .md file still delegates exactly as it did before.
      ADD COLUMN IF NOT EXISTS boundary_reaches_source boolean NOT NULL DEFAULT false;
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
      -- The committed paths that fell outside the boundary this bee was given.
      ADD COLUMN IF NOT EXISTS strays jsonb NOT NULL DEFAULT '[]'::jsonb,
      -- Consecutive attempts that produced nothing judgeable: no commit, or
      -- no criterion anyone could establish. send_backs is deliberately
      -- not spent on those (#1420), and measured 2026-09-17 that made the
      -- loop free - an empty attempt was released after six hours and
      -- redispatched for ever. This is the counter that ends it: at
      -- FREE_ATTEMPT_CEILING the issue escalates to a person. It survives
      -- the redispatch it is counting: recordDispatch names it only to reset
      -- it when an issue that escalated or failed is dispatched again (a
      -- person's retry), and otherwise keeps the stored value.
      ADD COLUMN IF NOT EXISTS free_attempts integer NOT NULL DEFAULT 0,
      -- The adversarial reviewer's answer (#1127), cached by the commit it
      -- judged. A wait row is re-read every round; a review of an unchanged
      -- head is the same review, and buying it again costs a lane.
      ADD COLUMN IF NOT EXISTS reviewer_fingerprint text,
      ADD COLUMN IF NOT EXISTS reviewer_text text,
      ADD COLUMN IF NOT EXISTS reviewer_model text,
      ADD COLUMN IF NOT EXISTS reviewer_provider text,
      ADD COLUMN IF NOT EXISTS reviewer_at timestamptz,
      -- Consecutive rounds in which a review was bought for this attempt and
      -- never delivered (a call refused for good on every lane tried, or an
      -- answer that left criteria unanswered). A commit is never accepted on
      -- the worker's word, so without a count a reviewer that can never
      -- answer held the row in wait, released it every six hours, and took
      -- the next bee's commit into the same hold for ever.
      ADD COLUMN IF NOT EXISTS reviewer_misses integer NOT NULL DEFAULT 0,
      -- The branch head and the conversation of the last attempt that was
      -- DECIDED (anything but wait), and the note of the last finding. A
      -- redispatch reuses the worktree, so a retry that commits nothing still
      -- diffs as the previous attempt's files - and the cached refutation of
      -- that unchanged commit was charged to send_backs a second time: one
      -- real finding and one turn killed in seconds by a 1302 used the whole
      -- retry budget. A head that has not moved since another attempt was
      -- judged is no new work, and is handled as an empty attempt.
      ADD COLUMN IF NOT EXISTS judged_head text,
      ADD COLUMN IF NOT EXISTS judged_conversation text,
      ADD COLUMN IF NOT EXISTS judged_note text,
      -- The issue's own criterion commands, run by the Queen on the commit,
      -- keyed like the reviewer cache (branch head, merge base, criteria). A
      -- wait row is re-read every 60 s, and a measurement is a temporary
      -- worktree and up to 20 commands; an unchanged head is the same
      -- measurement, so it is read from here instead of run again.
      ADD COLUMN IF NOT EXISTS criteria_fingerprint text,
      ADD COLUMN IF NOT EXISTS criteria_runs jsonb,
      -- The salvage commit: what the container committed on the bee's behalf
      -- when the turn ended with its work uncommitted, and what it left
      -- outside the boundary. The boot migration adds these too, because the
      -- boot reaper salvages before the first round runs - they are repeated
      -- here because the review's own SELECT names them, and a column the
      -- sweep names and the database lacks stops every review rather than one.
      ADD COLUMN IF NOT EXISTS salvaged_at timestamptz,
      ADD COLUMN IF NOT EXISTS salvaged_sha text,
      ADD COLUMN IF NOT EXISTS salvaged_files jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS salvage_left jsonb NOT NULL DEFAULT '[]'::jsonb;
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
    const reachesSource = boundaryReachesSource(boundary)
    const v = verdicts?.[String(issue.number)]
    await pool.query(
      `INSERT INTO queen_issues
         (number, title, state, owned_paths, seen_at, is_spec, delegatable,
          boundary_reaches_source, missing, criteria, criteria_source)
       VALUES ($1, $2, 'open', $3::jsonb, now(), $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       ON CONFLICT (number) DO UPDATE
         SET title = EXCLUDED.title, state = 'open',
             owned_paths = EXCLUDED.owned_paths, seen_at = now(),
             is_spec = EXCLUDED.is_spec,
             delegatable = EXCLUDED.delegatable,
             boundary_reaches_source = EXCLUDED.boundary_reaches_source,
             missing = EXCLUDED.missing,
             criteria = EXCLUDED.criteria,
             criteria_source = EXCLUDED.criteria_source`,
      [
        issue.number,
        issue.title.slice(0, 300),
        JSON.stringify(boundary),
        v?.isSpec ?? false,
        // NOT `... && boundaryReachesSource(boundary)` - see #1358. Making
        // the distinction visible and acting on it are different decisions,
        // and the second belongs to the operator: silently narrowing what
        // the Queen will pick up would stop the swarm, which is the opposite
        // of the intent. tests/api/boundary-reach.test.ts fails if this line
        // ever narrows.
        v?.delegatable ?? boundary.length > 0,
        reachesSource,
        JSON.stringify(v?.missing ?? []),
        JSON.stringify(v?.criteria ?? []),
        v?.criteriaSource ?? 'none',
      ],
    )
  }
  if (!complete) {
    logger.warn('Open issue list was truncated; keeping the board as it is', {
      fetched: issues.length,
      pages: issuePageCap(),
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
/**
 * The lease on a send-back, and why `rejected` cannot be permanent.
 *
 * `QueenDelegationPolicy.claimOnIssue` counts `rejected` as a LIVE claim, and
 * says why in its own comment: "the same bee is expected to return to those
 * files". Nothing returns. The header of this file states it plainly - a
 * send-back verdict is recorded and the task waits - so `rejected` is a promise
 * the system does not keep, and the issue is held for as long as it stands.
 *
 * Measured in production 2026-09-04: 18 of 28 open issues were skipped as
 * `claimed`, and every one of the send-backs among them was holding ITSELF.
 * An issue blocked by its own failed attempt can never be retried.
 *
 * The repair needs no new policy, because the policy already has the right
 * state. `failed` is free in `claimOnIssue`, over the comment "A failure is the
 * state that most obviously means 'do this again'". So a send-back that has sat
 * past the idle floor, and still has attempts left under
 * `QueenRetryPolicy.maximumRealAttempts`, is reported as `failed` rather than
 * `rejected` - which is what it is: an attempt that did not land.
 *
 * WHAT IS DELIBERATELY NOT CHANGED.
 *   - `escalate` and `wait` still map to `awaitingReview`. An escalation wants
 *     a person, and a wait is re-read by the reviewer each round, so neither is
 *     the false promise this fixes.
 *   - The ceiling is not a new number. Past it the claim stands, and a person
 *     decides - the same quarantine a message queue gives an item whose
 *     delivery count is exhausted.
 *   - `idle` defaults to 0, so every existing caller and test keeps today's
 *     behaviour until it passes the new argument.
 */
export const SEND_BACK_IDLE_FLOOR_MS = 60 * 60 * 1000

/**
 * The same defect in the third state, with a much longer floor.
 *
 * `wait` means "not judged yet", and the sweep deliberately re-reads wait rows
 * so a torn or unparsed verdict gets another look. Its own comment states the
 * limit of that: "an unchanged transcript yields the same wait". The transcript
 * of a FINISHED bee never changes, so re-reading is not re-judging - the same
 * input gives the same answer every round, while the policy's reason reads
 * "N of M criteria judged SO FAR" and there is no later.
 *
 * Measured 2026-09-04: #1361 and #1362 sat in `wait` for hours, holding their
 * boundaries and counted in `claimed` against every candidate touching them.
 *
 * Six hours, not one. A wait CAN resolve by itself - a transcript merely slow
 * to flush will parse on a later sweep - so the clock must be long enough that
 * only a genuinely frozen one is released. A send-back gets no second look at
 * all, which is why its floor is an hour.
 */
export const WAIT_FROZEN_FLOOR_MS = 6 * 60 * 60 * 1000

/** The floor on an empty attempt; see `stateOfDispatch`. */
export const EMPTY_ATTEMPT_FLOOR_MS = 30 * 60 * 1000

export function stateOfDispatch(
  finished: boolean,
  reviewState: unknown,
  lease: { idleMs?: number; sendBacks?: number; ceiling?: number } = {},
): 'running' | 'accepted' | 'rejected' | 'awaitingReview' | 'failed' {
  if (!finished) return 'running'
  const verdict = String(reviewState ?? '')
  if (verdict === 'accept') return 'accepted'
  const idleMs = lease.idleMs ?? 0
  const sendBacks = lease.sendBacks ?? 0
  // Read from QueenRetryPolicy.maximumRealAttempts rather than restated, so
  // there is one ceiling and not two that agree until someone edits one.
  const ceiling = lease.ceiling ?? 2

  // A verdict that SAYS failed is a failure. This case was missing, so
  // `review_state = 'failed'` fell through to `awaitingReview` at the bottom -
  // a LIVE claim in `QueenDelegationPolicy.claimOnIssue` - and the issue stayed
  // held by the very row that recorded its release.
  //
  // Measured 2026-09-04: five dispatches were deliberately set to `failed` to
  // return their issues to the pool (#1133, #1175, #1216, #1240, #1311). All
  // five stayed in `claimed`, the tick kept refusing with "nothing to choose"
  // against 22 candidates, and the swarm sat at zero bees of four. The write
  // was correct; the reader had no case for it.
  //
  // The function already RETURNS 'failed' two lines below for a send-back that
  // outlived its floor. It could produce the state and not recognise it.
  if (verdict === 'failed' || verdict === 'cancelled') return 'failed'
  // An EMPTY attempt committed nothing and said nothing, so there is no work
  // to hold files for and no bee expected back to them. Measured 2026-09-17,
  // most of the live waits on the board were exactly this - turns killed by a
  // deploy or ended in seconds by a 1302 - each holding its boundary for six
  // hours before the wait valve let go, while 30 of 32 worker lanes sat idle.
  //
  // Released after a SHORT floor, not at once. With no floor the same issue
  // was chosen again in the same round, and a bee's close asks for the next
  // round immediately: during a z.ai quota window (1308/1316, hours long)
  // three empty attempts - and an escalation no timer releases - took
  // minutes, and every lane moved one issue a cycle out of the backlog into
  // needs-you. Half an hour lets a rate limit pass and a quota window be
  // retried a handful of times, not a hundred.
  if (verdict === 'empty') {
    return idleMs >= EMPTY_ATTEMPT_FLOOR_MS ? 'failed' : 'rejected'
  }

  if (verdict === 'sendBack') {
    if (idleMs >= SEND_BACK_IDLE_FLOOR_MS && sendBacks < ceiling)
      return 'failed'
    return 'rejected'
  }
  // A wait that has outlasted the frozen floor was never judged and never will
  // be, because nothing about its input can change. `escalate` is deliberately
  // excluded: it asks for a person, and a timer is not a person.
  if (verdict === '' || verdict === 'wait') {
    if (idleMs >= WAIT_FROZEN_FLOOR_MS && sendBacks < ceiling) return 'failed'
  }
  return 'awaitingReview'
}

/**
 * The same state, read straight off a `queen_dispatch` row.
 *
 * EXPORTED FOR THE BOARD. The kanban drew its columns with a rule of its own -
 * every non-accept verdict in `review`, no valve, no clock - and measured
 * 2026-09-17 it showed ~180 cards in review of which ~41 were live waits: the
 * rest were send-backs and waits the Queen had already released, and empty
 * attempts. Two readings of one row is the defect; one function is the fix,
 * and the valve constants stay here, in one place.
 */
export function dispatchRowState(
  row: {
    finished_at?: unknown
    review_state?: unknown
    send_backs?: unknown
  },
  now: number = Date.now(),
): ReturnType<typeof stateOfDispatch> {
  const finished = row.finished_at != null
  const at = finished ? Date.parse(String(row.finished_at)) : Number.NaN
  return stateOfDispatch(finished, row.review_state, {
    // An unreadable clock is not evidence of age: 0 keeps the hold, as the
    // board's 48-hour rule already does for a timestamp that will not parse.
    idleMs: Number.isFinite(at) ? Math.max(0, now - at) : 0,
    sendBacks: Number(row.send_backs ?? 0) || 0,
  })
}

/**
 * Work the repository has already measured and nobody has written down.
 *
 * THE BLOCKER THIS ANSWERS. Of the issues a bee has ever worked here, not one
 * was written by the Queen: every single one came from a person or an agent
 * outside the loop. So each time the backlog is fed she drains it within the
 * hour and returns to `nothing to choose` - which is not a defect in the
 * scheduler, it is the absence of a supply. Measured 2026-09-03: 41 done, 17
 * in backlog, 0 she may start.
 *
 * WHY FILE LENGTH AND NOT SOMETHING CLEVERER. It is the one backlog this
 * repository already computes and already complains about: the pre-commit gate
 * prints a warning for every file over 400 lines, on every commit, and has for
 * as long as the files have been long. That makes each entry EVIDENCE rather
 * than an opinion - a count anyone can reproduce with `wc -l` - and it gives
 * the one thing a candidate needs to be delegatable at all: a boundary, which
 * is the file itself.
 *
 * SCOPED TO WHAT THIS PROJECT OWNS. Forty-six files in the tree are over the
 * threshold and most of them are BrowserOS upstream - openclaw, the container
 * runtime, klavis. Splitting those would create merge pain in someone else's
 * code for a gate they did not write. Only the queen and ring files are ours.
 *
 * IT DOES NOT FILE ANYTHING. The container holds no GitHub credential, by
 * design, so it could not publish an issue if it wanted to. Deriving and
 * reporting is the whole job here; publishing stays with a machine that has
 * the credential, and that separation is a feature rather than a limitation -
 * a supervisor that files its own work list unsupervised is a different and
 * much larger decision.
 */
export interface DerivedCandidate {
  /** The boundary, and the reason, in one: the file is both. */
  path: string
  lines: number
  /** The command that produced it, so the claim can be re-run. */
  source: string
}

/** Files this project owns, as prefixes. Everything else belongs to upstream. */
const OWNED = [
  'apps/server/src/api/routes/queen-',
  'apps/server/src/api/services/queen-',
  'apps/server/tests/api/queen-',
  'apps/server/tests/api/ring00-',
  'apps/server/tests/api/pg-migrate',
  'apps/server/tests/api/queend-',
]

/** The threshold the pre-commit gate uses. Read from one place or it drifts. */
export const FILE_LENGTH_THRESHOLD = 400

export async function deriveCandidates(
  root: string,
  read: (path: string) => Promise<string> = async (p) =>
    (await import('node:fs/promises')).readFile(p, 'utf8'),
): Promise<DerivedCandidate[]> {
  const out: DerivedCandidate[] = []
  for (const prefix of OWNED) {
    const dir = `${root}/trios/agent-server/${prefix.slice(0, prefix.lastIndexOf('/'))}`
    let names: string[]
    try {
      const fs = await import('node:fs/promises')
      names = await fs.readdir(dir)
    } catch {
      continue
    }
    const leaf = prefix.slice(prefix.lastIndexOf('/') + 1)
    for (const name of names) {
      if (!name.startsWith(leaf) || !name.endsWith('.ts')) continue
      const rel = `${prefix.slice(0, prefix.lastIndexOf('/'))}/${name}`
      let text: string
      try {
        text = await read(`${root}/trios/agent-server/${rel}`)
      } catch {
        continue
      }
      const lines = text.split('\n').length
      if (lines <= FILE_LENGTH_THRESHOLD) continue
      out.push({
        path: `agent-server/${rel}`,
        lines,
        source: `wc -l agent-server/${rel} -> ${lines}, over the ${FILE_LENGTH_THRESHOLD}-line threshold the pre-commit gate warns on`,
      })
    }
  }
  // Biggest first: the longest file is the one the gate has complained about
  // most often and the one a split helps most.
  return out.sort((a, b) => b.lines - a.lines)
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
    // `failed` belongs here. `stateOfDispatch` gained that case so a verdict
    // that SAYS failed stops being read as a live claim, and this parameter was
    // not widened with it - so the one call site that passes the result did not
    // typecheck. `bun test` does not typecheck, every test passed, and the
    // error shipped. Two gates, and only one of them was run.
    state?: 'running' | 'accepted' | 'rejected' | 'awaitingReview' | 'failed'
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
 *
 * EXPORTED so `tests/api/boundary-reach.test.ts` can run it against the very
 * same bodies as its twin in `trios/tools/doc-only-boundary-audit.mjs` and
 * fail if the two parsers ever disagree about which paths an issue claims.
 */
export function boundaryPathsOf(body: string): string[] {
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

// The suffixes that make a boundary path count as documentation (#1358).
// One array, one place to disagree with; the audit prints it at the top of
// every run so a reader can.
const DOC_FILE_SUFFIXES = ['.md']

/// Whether one boundary path is documentation. The FILE NAME decides, not
/// the directory: `trios/docs/x.md` is documentation and `docs/diagram.png`
/// is not. Case-insensitive, so `README.MD` is documentation.
function isDocumentationPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return DOC_FILE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix))
}

/**
 * Whether a boundary reaches beyond documentation (#1358).
 *
 * TRUE when at least one path in it is not documentation. A boundary of one
 * `.md` file has length 1, so `delegatable` as derived today calls it work -
 * and an issue worked exactly as written changes no behaviour, which is how
 * "there is no target queue depth" (#1333) was accepted and closed while the
 * defect it names stayed in the code.
 *
 * THIS VALUE IS RECORDED, NOT ACTED ON. `delegatable` keeps its meaning and
 * its value (`v?.delegatable ?? boundary.length > 0`): whether the Queen may
 * be pointed away from prose-only tasks is the operator's decision, not this
 * change's, and silently narrowing what she picks up would stop the swarm.
 *
 * The rule is a PINNED TWIN of the one `trios/tools/doc-only-boundary-audit.mjs`
 * exports under the same name - not an import, and the reason is the
 * deployment: the agent-server image is built from `agent-server/` alone
 * (its Dockerfile copies `apps/server` and `packages/*` and nothing from the
 * repository root), so a static import of that tool would die at boot with
 * "module not found" and take the whole round with it. The twin cannot drift
 * silently: `tests/api/boundary-reach.test.ts` imports the audit's export
 * and fails unless both agree on every shape a boundary can take, and both
 * parsers against the same bodies.
 */
export function boundaryReachesSource(paths: string[]): boolean {
  return paths.some((path) => !isDocumentationPath(path))
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
      { headers: githubReadHeaders() },
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
 * RING-00, asked the same question `queend` was just asked.
 *
 * WHY ARGV AND NOT JSON. The ring's stated contract is bare `rustc` - no cargo,
 * no dependencies - and a JSON parser is a dependency. Every input and output
 * of the generated code is an integer or a bool, so argv in and `key=value`
 * out is enough, and keeping it enough is what keeps the contract true.
 *
 * Rejects on anything unexpected. The caller catches, because the cross-check
 * is an observer and an observer that can stop a round is not an observer.
 */
function askT27Core(args: string[]): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(t27corePath(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // AN OBSERVER MUST NOT BE ABLE TO HANG THE THING IT OBSERVES.
    //
    // This is awaited inline while the round holds the Queen's lease, so a
    // binary that never exits would hold the whole hive. Measured on the real
    // shim: 200 invocations in 1.645 s, 8.22 ms each - so two seconds is three
    // orders of magnitude of headroom and still bounded.
    const done = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('t27core did not answer within 2s'))
    }, 2_000)
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', (e) => {
      clearTimeout(done)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(done)
      if (code !== 0) {
        reject(
          new Error(
            `t27core exited ${code}: ${(err.trim() || out.trim()).slice(0, 200)}`,
          ),
        )
        return
      }
      const pairs: Record<string, string> = {}
      for (const line of out.split('\n')) {
        const at = line.indexOf('=')
        if (at <= 0) continue
        pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim()
      }
      if (Object.keys(pairs).length === 0) {
        reject(
          new Error(`t27core answered nothing parseable: ${out.slice(0, 200)}`),
        )
        return
      }
      resolve(pairs)
    })
  })
}

/**
 * The number `queend` counts for `canStartAnother`, counted here on the SAME
 * array that was sent to it.
 *
 * `main.swift` does `tasks.filter { $0.state == .running }.count`, and
 * `DelegatedTaskState` is a String enum, so `running` is the literal on the
 * wire. Counted from the array rather than tracked alongside it: a second
 * count kept in step by hand is the defect this whole cross-check exists to
 * catch, and it would be embarrassing to introduce one while looking for one.
 */
export function runningOnBoard(tasks: readonly unknown[]): number {
  return tasks.filter(
    (task) => (task as { state?: unknown } | null)?.state === 'running',
  ).length
}

/** What Swift answered about capacity, and the count it answered about. */
export interface SwiftCapacityAnswer {
  /** `QueenDelegationPolicy.canStartAnother`, as this choice reveals it. */
  answer: boolean
  /**
   * The running count `queend` itself named, or null when it never said.
   *
   * Only a capacity refusal carries it. When it is there it is the one chance
   * to check that both implementations were asked about the same board, which
   * is the difference between a cross-check and two answers to two questions.
   */
  runningNamed: number | null
}

/**
 * Read the capacity answer back out of a choice.
 *
 * `queend` does not report `canStartAnother` as a field; the capacity gate is
 * the FIRST guard in the `choose` case and it exits immediately with a refusal
 * of a fixed shape. So a choice carrying that refusal is Swift saying false,
 * and any other choice - allowed, or refused for money, boundaries or order -
 * is Swift having already passed the gate, which is Swift saying true.
 *
 * The shape is matched exactly rather than by substring: a loose match on
 * "running" would read a future refusal about something else as a capacity
 * refusal and quietly invert this answer.
 */
export function swiftCapacityAnswer(choice: QueendChoice): SwiftCapacityAnswer {
  const refusal = (choice.refusal ?? '').trim()
  const named = /^(\d+) workers already running \(limit \d+\)$/.exec(refusal)
  if (named) return { answer: false, runningNamed: Number(named[1]) }
  return { answer: true, runningNamed: null }
}

/** What the cross-check found, for the caller and for the tests. */
export type Ring00Outcome = 'agree' | 'disagree' | 'unavailable'

/**
 * Run RING-00 on the round's real capacity question and say whether it agrees.
 *
 * THIS IS A CROSS-CHECK, NOT A HANDOVER. The Swift answer stays authoritative:
 * nothing here feeds back into what the round does. The point is that the ring
 * is executed on live inputs every round instead of only in a test, so the day
 * authority moves it will move onto a path with a production record behind it.
 *
 * Three outcomes, three volumes:
 *   agree       - info, so "the ring runs in production" is an observation
 *                 somebody can read rather than a claim in a document
 *   disagree    - error, naming both answers and the input. Two implementations
 *                 of one rule disagreeing is the exact failure L0 exists to
 *                 prevent, and it must never pass quietly
 *   unavailable - warn, and the round goes on. A missing or broken observer
 *                 must not be able to stop the swarm
 */
export async function crossCheckRing00Capacity(
  running: number,
  swift: SwiftCapacityAnswer,
): Promise<Ring00Outcome> {
  let pairs: Record<string, string>
  try {
    pairs = await askT27Core(['capacity', String(running)])
  } catch (error) {
    logger.warn('Ring-00 cross-check did not run', {
      path: t27corePath(),
      running,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'unavailable'
  }

  const said = pairs.can_start_another
  if (said !== 'true' && said !== 'false') {
    logger.warn('Ring-00 cross-check did not run', {
      path: t27corePath(),
      running,
      error: `can_start_another was ${said === undefined ? 'absent' : `"${said}"`}`,
    })
    return 'unavailable'
  }
  const ring = said === 'true'

  // Both implementations must have been asked about the same board. When
  // `queend` named its own count and it is not this one, the comparison below
  // is two answers to two questions and its agreement would mean nothing.
  if (swift.runningNamed !== null && swift.runningNamed !== running) {
    logger.error('Ring-00 cross-check was fed a different board than queend', {
      queendCounted: swift.runningNamed,
      tickCounted: running,
    })
  }

  if (ring !== swift.answer) {
    logger.error('RING-00 DISAGREES WITH THE SWIFT POLICY', {
      question: 'canStartAnother',
      running,
      swift: swift.answer,
      ring,
      freeSlots: pairs.free_slots ?? null,
      authoritative: 'swift',
      path: t27corePath(),
    })
    return 'disagree'
  }

  logger.info('Ring-00 agrees with the Swift policy', {
    question: 'canStartAnother',
    running,
    answer: ring,
    freeSlots: pairs.free_slots ?? null,
  })
  return 'agree'
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
  /**
   * Seams for the suite, defaulting to the real thing: the review's git, lanes
   * and model, and the dispatch itself - so a test can read the brief a
   * redispatched bee would be handed without starting one.
   */
  deps: {
    review?: Partial<ReviewDeps>
    dispatch?: typeof dispatchBee
  } = {},
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
  const reviewed = await reviewFinishedDispatches(pool, deps.review)
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
    // `reviewed_at` and `send_backs` are the lease's two inputs and were not
    // selected here before. Without them the ceiling check reads 0 for every
    // row, so `0 < 2` always holds and a send-back would be released no matter
    // how many attempts it had already burned - the unbounded retry the ceiling
    // exists to prevent.
    `SELECT issue, branch, owned_paths, conversation_id, dispatched_at,
            key_index, finished_at, review_state, reviewed_at, send_backs,
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
      state: stateOfDispatch(finished, row.review_state, {
        // THE CLOCK MUST BE ONE NOTHING TOUCHES.
        //
        // This read `reviewed_at ?? finished_at` and the wait valve could
        // therefore never fire. `reviewFinishedDispatches` re-reads every
        // `wait` row each round and UPDATEs it in place - its own comment says
        // so - which refreshes `reviewed_at` every five minutes. Measured in
        // production 2026-09-04: #1327 and #1329 had been frozen for 18.4
        // hours and reported 0.06 hours of idle, because the sweep had touched
        // them a moment earlier. A six-hour floor against a clock reset every
        // five minutes is a floor that cannot be reached.
        //
        // `finished_at` is written once, when the bee stops, and never again.
        // It is the only honest measure of how long a verdict has stood.
        idleMs: finished ? Date.now() - Date.parse(String(row.finished_at)) : 0,
        sendBacks: Number(row.send_backs ?? 0),
      }),
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

  // Named, because RING-00 is asked about this exact array a few lines below
  // and "the same number" has to be the same number, not a second reading of
  // the same idea.
  const openingBoard = [...registry.rows[0].tasks, ...containerTasks]

  const choice = await askQueend({
    kind: 'choose',
    candidates,
    candidateBodies,
    tasks: openingBoard,
  })

  await recordTick(pool, holder, grant.fence, choice)
  logger.info('Queen tick decided', {
    chosen: choice.chosen ?? null,
    refusal: choice.refusal ?? null,
    candidates: candidates.length,
  })

  // RING-00, on the round's real capacity question. Here rather than only in
  // the dispatch loop below because this call happens in EVERY round - the
  // loop's re-asks happen only in rounds that started a bee - and "the ring is
  // exercised in production" has to be true of every round or it is a claim
  // about a subset. Awaited so its verdict is in the log next to the decision
  // it shadows; it cannot throw, so it cannot delay one either.
  await crossCheckRing00Capacity(
    runningOnBoard(openingBoard),
    swiftCapacityAnswer(choice),
  )

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
  let takenKeys = inFlight.rows
    .filter((r) => r.finished_at == null)
    .map((r) => r.key_index)
    .filter((i): i is number => typeof i === 'number')
  let keyCursor = latestProviderKeyIndex(inFlight.rows)

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
    // Read BEFORE the dispatch, because the dispatch erases it: the upsert in
    // `recordDispatch` resets review_state and review_note for a bee that
    // starts. A send-back note was therefore written for a worker and read by
    // nobody - the retried bee got the same brief as the first one and was
    // judged against the same findings it was never shown.
    const previous = await previousReview(pool, issue)
    const dispatch = await (deps.dispatch ?? dispatchBee)(
      pool,
      issue,
      briefFor(
        issue,
        repo,
        paths,
        candidateBodies[String(issue)] ?? '',
        criteria,
        criteriaSource,
        previous,
      ),
      paths,
      takenKeys,
      keyCursor,
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
      keyCursor = dispatch.keyIndex
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
    // And again on the board that grew. This is the ONLY place the capacity
    // gate actually bites - the opening board is at the limit only when the
    // round has nothing to do anyway - so a cross-check that skipped it would
    // compare the two implementations exclusively on the easy answer.
    await crossCheckRing00Capacity(
      runningOnBoard(board),
      swiftCapacityAnswer(current),
    )
    if (!current?.allowed) {
      logger.info('Queen tick stopped dispatching', {
        // Counted from the booleans, not the array: the array also holds the
        // refusal that stopped the loop, and counting that as a bee is the
        // #1379 defect in miniature.
        started: dispatchesThatStarted(started).length,
        why: current?.refusal ?? 'no answer',
      })
    }
  }

  if (!watch.held) {
    logger.warn('Queen tick stood down mid-round; the lease moved', {
      started: dispatchesThatStarted(started).length,
    })
  }

  await report(pool, reviewed, started, choice, candidates.length)
  // A round every one of whose dispatches was refused started nothing, so it
  // reports no dispatch - the tick response agrees with the report, and a
  // caller cannot mistake a refusal for a bee in flight.
  if (dispatchesThatStarted(started).length > 0) {
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
/** What the last review of an issue said, as its dispatch row still holds it. */
export interface PreviousReview {
  state: string
  note: string
}

/**
 * The previous verdict on an issue, when it is one a bee should be shown.
 *
 * `sendBack` and `empty` only. An accept is not redispatched, an escalation is
 * a person's, and a wait said nothing yet. Never throws: a brief without the
 * last findings is the brief every bee got until now, and not worth a round.
 */
async function previousReview(
  pool: Pool,
  issue: number,
): Promise<PreviousReview | undefined> {
  const found = await pool
    .query(
      'SELECT review_state, review_note FROM queen_dispatch WHERE issue = $1',
      [issue],
    )
    .catch(() => null)
  const row = found?.rows?.[0]
  const state = String(row?.review_state ?? '')
  if (state !== 'sendBack' && state !== 'empty') return undefined
  return { state, note: String(row?.review_note ?? '') }
}

/** The bound on the last-review section, so a long note cannot crowd the task. */
export const PREVIOUS_REVIEW_MAX_CHARS = 1500

function previousReviewSection(previous?: PreviousReview): string[] {
  if (!previous) return []
  const note = previous.note.trim()
  const bounded =
    note.length > PREVIOUS_REVIEW_MAX_CHARS
      ? `${note.slice(0, PREVIOUS_REVIEW_MAX_CHARS)}\n[truncated ${note.length - PREVIOUS_REVIEW_MAX_CHARS} chars]`
      : note
  const lead =
    previous.state === 'empty'
      ? 'The previous attempt on this issue committed nothing, so there was nothing to judge. Commit your work - an uncommitted edit is not a deliverable.'
      : 'The previous attempt on this issue was reviewed and sent back. What the review found is below; answer it rather than repeating the attempt.'
  return [
    '## What the last review found',
    '',
    lead,
    '',
    bounded || '(the review left no note)',
    '',
  ]
}

export function briefFor(
  issue: number,
  repo: string,
  ownedPaths: string[],
  issueBody: string,
  criteria: string[] = [],
  criteriaSource = 'none',
  previous?: PreviousReview,
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

  return [
    `# ${repo}#${issue}`,
    '',
    description,
    '',
    ...previousReviewSection(previous),
    '## Boundary',
    '',
    boundary,
    `Your branch is queen-${issue} and this worktree is yours alone - no other`,
    'worker and no build reads or writes it while you have it.',
    '',
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
    // The compiler, named, and the fact that the review runs it. Harvested
    // 2026-09-10 (gHashTag/t27#3560): 34 branches whose bees had written
    // "met", 9 of which parsed clean when `t27c` was actually run. The other 25
    // bees were not lying so much as guessing, because nothing told them the
    // compiler was on the machine or that anyone would run it after them.
    'The T27 compiler is installed: `t27c` is on your PATH (/usr/local/bin/t27c).',
    'For every `.t27` file you change, run `t27c parse <file>` and',
    '`t27c typecheck <file>` yourself before you answer, and quote the result.',
    'The review runs the same commands on your COMMIT - parse, parse-complete',
    "and typecheck - and the compiler's answer stands above your verdict line.",
    'A file with a parse error, a DISCARDED token run, or a `TODO: Implement`',
    'stub marker is unmet whatever the line says.',
    '',
    "## The Queen's scheduler",
    '',
    // The scheduler is a tool the Queen holds, not one the bee holds
    // (gHashTag/t27 specs/tools/mcp/inngest-dev.t27, AGENTS = ["T"];
    // specs/automation/inngest-queen-scheduler.t27). Every cron and skill card
    // under specs/crons and specs/skills is an Inngest function of the app
    // `t27-queen`, served by this server at /api/inngest. A bee meets the
    // scheduler in two places: as the author of a `[skill] <ID>` issue, and as
    // the thing it must not try to drive.
    'Crons and skills are functions of the Inngest app `t27-queen`, one per',
    'card under `specs/crons/` and `specs/skills/` (gHashTag/t27), and the',
    'scheduler is a tool the Queen holds (`mcp/inngest-dev`), not one you hold.',
    'If this issue is titled `[skill] <ID>` with the label `queen-skill`, the',
    'scheduler opened it from the event `skill/<ID>.run`: the card',
    '`specs/skills/<file>.t27` named in the body is the contract, and the skill',
    'body it points at (SKILL.md) is what you follow. To change WHEN something',
    'runs, change its card (SCHEDULE, TZ, ENABLED, RUNS) - never a workflow',
    '`schedule:` or a setInterval; the app re-reads the cards on deploy. Do not',
    'send `cron/<ID>.tick` or `skill/<ID>.run` events and do not call the',
    'Inngest MCP yourself: it needs `Authorization: Bearer <INNGEST_SIGNING_KEY>`,',
    'which this machine does not hold by design. If your task needs a run to',
    'happen, say so in your verdict and the Queen fires it.',
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
    // The trailer, in the exact form the repository's traceability gate
    // accepts. The 9 bee commits carried into gHashTag/t27#3560 all had to be
    // rewritten by hand: they closed with "Resolves gHashTag/t27#N", which
    // reads well and matches nothing - the L1 gate wants a bare `#N`.
    `End your commit message with the line \`Closes #${issue}\` - exactly that`,
    'form, on its own line, bare issue number. "Resolves owner/repo#N" does not',
    "pass the repository's traceability gate and the commit is rewritten by hand.",
    "Sealing (`t27c seal`) and the `docs/now/` entry are the operator's at",
    'harvest time, not yours: they fall outside your boundary.',
    '',
    // The template, one numbered slot per criterion (#1421). Emitted only when
    // the task states criteria, so a task with none is unchanged: its bee
    // states its own criteria first and still needs the standing generic
    // request to answer them in.
    ...verdictSection(criteria),
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
  // ONE NUMBERING, THE SLOT'S. An issue whose bullets carry their own labels
  // - gHashTag/t27#4246 writes `1.`, `1b.`, `2.`, `3.` - rendered as "3. 2.
  // `python3 tools/...`", and a worker or a reviewer that answers with the
  // number the criterion itself shows addresses a slot it never read.
  return [
    provenance,
    ...tail,
    '',
    ...criteria.map((c, i) => `${i + 1}. ${criterionText(c)}`),
  ]
}

/**
 * The VERDICT template the bee fills in, one numbered slot per criterion
 * (#1421).
 *
 * Five dispatches on 2026-09-04 came back or escalated with the reviewer
 * reporting "Finished work omitted N verdict lines", where N was exactly the
 * number of criteria the reviewer called unmet. The workers had not refused
 * to answer. The brief already numbered the criteria - but it never required
 * the report to be numbered the same way, so a worker writing prose about
 * its work satisfied the letter of the instruction and none of its purpose,
 * and nothing checked before the turn ended.
 *
 * A template with one numbered slot per criterion closes the first half: a
 * slot is either filled or visibly empty, the numbers are the ones the
 * criteria already carry, and the brief says in words which reading an empty
 * slot gets. The bee is also told to check itself before stopping - the one
 * moment an omission is still free to fix. `missingVerdictSlots` below is
 * the same check as a function, for whatever tells a bee that has already
 * stopped.
 *
 * NUMBERED ONLY WHEN THERE ARE CRITERIA TO NUMBER. A task with none keeps
 * the standing generic request, unchanged: its bee is asked by
 * `criteriaBlock` to state its own criteria before working, and numbering
 * slots here would number criteria nobody has written yet.
 */
function verdictSection(criteria: string[]): string[] {
  // THE BLOCK GOES FIRST, and this is the measurement that moved it.
  //
  // Only 17% of dispatches in a three-hour window were accepted; 33% came back
  // as sendBack and 28% as `wait`, which means the review could not judge them
  // at all. Reading the transcripts settles why. #1429 discussed all four of
  // its criteria in prose - "Criterion 4 ... **Met.**" - and then wrote a
  // VERDICT block containing two lines. #1427 the same. #1430 wrote three of
  // four. The accepted ones wrote exactly one line per criterion.
  //
  // The block was required to come LAST, after 25-35 kB of prose. So the ONLY
  // machine-read part of the report sat in the position where a turn that runs
  // short loses it first, and a worker treating it as a closing summary rather
  // than the deliverable trims it exactly there.
  //
  // Putting it first costs nothing the worker knows: it has done the work and
  // taken its measurements before it composes the message. What it changes is
  // what survives when something is cut - prose, which nothing reads
  // mechanically, instead of the verdict, on which every downstream decision
  // depends.
  const head = [
    '## Your verdict, which the Queen reads',
    '',
    'BEGIN your LAST message with exactly this block, before anything else you',
    'write. Not at the end - at the very top. Everything after it is prose for a',
    'person; this block is the only part read by machine, and a report that runs',
    'long loses whatever is last.',
    '',
    '## VERDICT',
  ]
  if (criteria.length === 0) {
    return [
      ...head,
      "- <the criterion, in the issue's own words>: met | unmet | could-not-check",
      '- <the next one>: met | unmet | could-not-check',
      '',
      'One line per criterion in "What you will be judged by", in that order. A',
      'criterion you could not check is could-not-check, never met - claiming met',
      'for work you did not verify is the one failure nothing downstream can',
      'catch, because the reviewer has only your word for it.',
    ]
  }
  return [
    ...head,
    ...criteria.map(
      (_, i) =>
        `- ${i + 1}. <criterion ${i + 1}, in the issue's own words>: ` +
        'met | unmet | could-not-check',
    ),
    '',
    'One numbered slot per criterion in "What you will be judged by", same',
    'numbers, same order. A slot you leave out is read as unmet, so answer',
    'every number - including one you could not check, which is',
    'could-not-check, never met. Claiming met for work you did not verify is',
    'the one failure nothing downstream can catch, because the reviewer has',
    'only your word for it. Before you stop, re-read this block against your',
    'last message and fill in every number you have not answered, while you',
    'still can.',
  ]
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
    // Said twice on purpose - once here, once in the brief - because the
    // system prompt survives a context that the brief may have scrolled out
    // of. A bee that finishes without the trailer costs a hand rewrite.
    `The T27 compiler t27c is installed on this machine; run \`t27c parse\` and \`t27c typecheck\` on every .t27 file you change, because the review runs them on your commit. Your final commit message ends with the line \`Closes #${issue}\`.`,
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
 * What the verdict says when the container committed for the bee.
 *
 * A SALVAGED COMMIT IS JUDGED LIKE ANY OTHER. The reviewer reads the same
 * patch, the compiler runs on the same files, and the criteria are measured on
 * the same head - this sentence adds a FACT to the note and takes no decision:
 * whoever reads the verdict, worker or person, should know that the work
 * reached the branch because the turn ended without committing it, not because
 * the bee said it was done.
 *
 * Empty when nothing was salvaged, so a note that says nothing about salvage
 * is a note about a bee that committed its own work.
 */
export function salvageSentence(row: {
  salvaged_at?: unknown
  salvaged_sha?: unknown
  salvaged_files?: unknown
  salvage_left?: unknown
}): string {
  if (row.salvaged_at == null) return ''
  const files = Array.isArray(row.salvaged_files) ? row.salvaged_files : []
  if (files.length === 0) return ''
  const left = Array.isArray(row.salvage_left) ? row.salvage_left : []
  const sha = row.salvaged_sha == null ? '' : String(row.salvaged_sha)
  return (
    `\n\n${files.length} file(s) on this branch were committed by the container ` +
    `as salvage${sha ? ` (${sha.slice(0, 12)})` : ''}, not by the bee: the turn ` +
    'ended with them edited and never committed, so there would otherwise have ' +
    'been nothing to judge. They are judged exactly like any other commit.' +
    (left.length > 0
      ? ` ${left.length} path(s) were left uncommitted because they fall ` +
        'outside the boundary this dispatch was given.'
      : '')
  )
}

/**
 * The criteria a bee never wrote a verdict line for.
 *
 * SILENCE IS NOT FAILURE. The review marks a criterion unmet when the VERDICT
 * block carries no line for it, and that default is correct - an unanswered
 * criterion is not a satisfied one. But it is a different FACT from a criterion
 * the bee tested and reported unmet, and until #1420 nothing in the round could
 * tell the two apart: a send-back that said "4 criterion(s) not met" was read
 * by the worker as "I failed four things" when four things had merely never
 * been mentioned. Measured 2026-09-04, from the six dispatches parked at the
 * retry ceiling, the unmet count was the omitted count in every one - #1133,
 * #1175, #1316, #1318, #1311 - and three of the six had escalated to a person
 * without the work ever being assessed. The oldest had waited 91 hours.
 *
 * MATCHING. A bee quotes the criteria "in the issue's own words", but a quote
 * is not a copy: backticks, punctuation and case all drift, and
 * `parseVerdictBlock` slices a line's criterion at 300 characters, so a line
 * quoting a long criterion holds only its beginning. Comparing punctuation and
 * case exactly would mark a faithfully quoted criterion as omitted. Both sides
 * are reduced to letters, digits and single spaces, and a criterion counts as
 * judged when one side contains the other - containment in EITHER direction,
 * because the 300-character slice means the promised text may contain the
 * line's text and not the other way round. The containment guard exists
 * because a one-word line would otherwise be contained by everything and mark
 * every criterion judged; an exact match always counts, however short.
 */
export function unjudgedCriteria(
  promised: string[],
  judged: Array<{ criterion: string; met: boolean }>,
): string[] {
  const normalize = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const said = judged.map((v) => normalize(v.criterion))
  return promised.filter((criterion) => {
    const want = normalize(criterion)
    if (want.length === 0) return false
    return !said.some(
      (line) =>
        line === want ||
        (Math.min(line.length, want.length) >= 12 &&
          (line.includes(want) || want.includes(line))),
    )
  })
}

/**
 * The send-back message, with silence and failure named as the two different
 * things they are (#1420, FR-002).
 *
 * The opener and the closing instruction are taken from the policy's own note
 * rather than restated here - the pass number ("for a third pass") is the
 * policy's ordinal, and a second copy of it in TypeScript would be the second
 * implementation of one rule this file is otherwise careful never to have. What
 * is composed here is the middle: the unmet criteria under two distinct
 * headings, so a worker reading the message can tell "you did not do this"
 * from "you did not say whether you did this". The first heading is a verdict
 * the bee wrote itself; the second is a default applied against it, and a
 * worker must be able to see which is which to answer either.
 */
function sendBackMessage(
  policyNote: string,
  failed: string[],
  unjudged: string[],
): string {
  const lines = policyNote.split('\n')
  const opener = lines[0] ?? ''
  const closer = lines[lines.length - 1] ?? ''
  const list = (items: string[]): string[] =>
    items.length === 0
      ? ['  (none)']
      : items.map((criterion, i) => `  ${i + 1}. ${criterion}`)
  return [
    opener,
    '',
    'Criteria that were tested and failed:',
    ...list(failed),
    '',
    'Criteria you never wrote a verdict line for, judged unmet because you',
    'said nothing:',
    ...list(unjudged),
    '',
    closer,
  ].join('\n')
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
 * A CRITERION THE BEE SAID NOTHING ABOUT COUNTS AS UNMET TOO - the correct
 * default, for the same reason - but as a different fact (#1420). Once the bee
 * has judged SOME of its criteria, the ones with no line are added to the
 * question as unmet verdicts, so the policy itself decides sendBack or
 * escalate on the complete picture; the tally records judged and unjudged
 * separately, and the send-back message names them under two headings. A bee
 * whose block is missing ENTIRELY is still read as a wait rather than a
 * wall of omissions, because an absent block is the signature of a torn or
 * slow transcript (#1335) and the frozen-wait valve already handles a verdict
 * that can never change; a bee that judged half its criteria read the
 * instruction and chose silence on the rest.
 *
 * THE RETRY BUDGET IS SPENT ON THE WORK (FR-003). An attempt whose unmet
 * criteria are ALL unjudged - the bee attempted no criterion it was given - is
 * returned without counting against `QueenRetryPolicy.maximumRealAttempts`,
 * because a ceiling spent on silence is a ceiling that retires issues nobody
 * ever worked. The count still advances when any unmet criterion was judged,
 * and only then.
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

/** Judged and unjudged counts for one dispatch, as the round records them. */
export interface ReviewTally {
  issue: number
  /** Criteria the bee wrote a verdict line for, whatever the verdict said. */
  judged: number
  /** Criteria the bee never wrote a verdict line for. */
  unjudged: number
}

interface ReviewRound {
  /** `#1234:accept`, one per dispatch judged this round. */
  acted: string[]
  /** Issues whose commit reached outside the boundary, and where. */
  strays: Array<{ issue: number; paths: string[] }>
  /** Judged and unjudged, per dispatch reviewed this round (#1420, FR-001). */
  tally: ReviewTally[]
}

/**
 * How many consecutive attempts may produce nothing judgeable before the issue
 * becomes a person's.
 *
 * Nothing judgeable is an EMPTY attempt (no commit, no verdict) or one whose
 * only unmet lines are could-not-check or unjudged. Neither spends `send_backs`
 * (#1420: a ceiling spent on silence retires issues nobody worked), and
 * measured 2026-09-17 that made them free: 188 of 541 dispatches in 24h never
 * finished, the attempts they left were released after six hours and
 * redispatched, and nothing ever counted how often. Three is the retry
 * policy's own order of magnitude (`maximumSendBacks` 2, plus the first try).
 *
 * What it does NOT count: an attempt the provider or the transport ended
 * (`endedOnTheProvider`). Those are paced by the empty-attempt floor instead,
 * because a quota window ends every turn at once and three of them are
 * minutes, not evidence about the issue. Reaped attempts are not counted
 * either, for the same reason: a deploy restart reaps every running bee.
 */
export const FREE_ATTEMPT_CEILING = 3

/** The note a send-back carries when an adversarial reviewer judged it. */
function reviewedSendBackMessage(
  policyNote: string,
  reviewer: { model: string; provider: string },
  refuted: Array<{ criterion: string; reason: string }>,
  unestablished: Array<{ criterion: string; reason: string }>,
  admitted: string[],
  machineFailed: string[],
): string {
  const lines = policyNote.split('\n')
  const opener = lines[0] ?? ''
  const closer = lines[lines.length - 1] ?? ''
  const list = (items: string[]): string[] =>
    items.length === 0
      ? ['  (none)']
      : items.map((item, i) => `  ${i + 1}. ${item}`)
  const withReason = (items: Array<{ criterion: string; reason: string }>) =>
    items.map((i) => (i.reason ? `${i.criterion} - ${i.reason}` : i.criterion))
  return [
    opener,
    '',
    `An adversarial reviewer (${reviewer.provider}/${reviewer.model}) read your commit and refuted:`,
    ...list(withReason(refuted)),
    '',
    'It could not establish these from the commit (counted unmet; make them visible in the change):',
    ...list(withReason(unestablished)),
    '',
    'You reported these unmet yourself:',
    ...list(admitted),
    '',
    'The machine measured these failures:',
    ...list(machineFailed),
    '',
    closer,
  ].join('\n')
}

/** A bee's `- 3. criterion` line, without the slot number. */
const withoutSlot = (criterion: string): string =>
  criterion.replace(/^\d{1,3}\.\s+/, '')

/**
 * EXPORTED FOR THE SUITE, as `runRound` is: the review is the half of the
 * round the unjudged accounting lives in, and a test that cannot call it can
 * only assert around it. The pool is the same recording fake the round's own
 * suite drives, so what the assertions read is exactly what a round writes.
 *
 * `deps` carries git, the reviewer lanes and the model, each defaulting to the
 * real one - so a suite can drive the adversarial review with a fake model and
 * a fake branch and still get the real policy's answer.
 */
export async function reviewFinishedDispatches(
  pool: Pool,
  overrides: Partial<ReviewDeps> = {},
): Promise<ReviewRound> {
  const deps: ReviewDeps = { ...defaultReviewDeps(), ...overrides }
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
  // A `wait` row is revisited forever, and until now nothing ever asked whether
  // its issue still existed. Measured 2026-09-16: 406 of the 488 rows re-judged
  // in a single log window were issues closed in July and August. Their
  // branches no longer carry a spec, so the witness reports `t27c="absent"`,
  // nothing can be judged, the verdict is `wait` again, and the row returns
  // next tick -- one `queend` call each, every round, forever. That is what
  // "review is overflowing" actually was.
  //
  // `queen_issues` is the open set, and since the paging fix it is complete
  // enough to subtract against. Guarded on a NON-EMPTY board: an empty one
  // means the sync has not run yet in this process, and filtering against it
  // would silently stop every review rather than fewer of them.
  const board = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM queen_issues',
  )
  const boardIsTrustworthy = Number(board.rows[0]?.n ?? 0) > 0
  const stillOpen = boardIsTrustworthy
    ? 'AND EXISTS (SELECT 1 FROM queen_issues i WHERE i.number = d.issue)'
    : ''
  const done = await pool.query(
    `SELECT d.issue, d.conversation_id, d.review_state,
            d.criteria, d.criteria_source, d.send_backs, d.owned_paths,
            d.free_attempts, d.key_index, d.provider, d.model,
            d.reviewer_fingerprint, d.reviewer_text, d.reviewer_model,
            d.reviewer_provider, d.reviewer_misses, d.outcome,
            d.judged_head, d.judged_conversation, d.judged_note,
            d.criteria_fingerprint, d.criteria_runs,
            -- What the container committed on the bee's behalf when the turn
            -- ended with its work uncommitted. Read so the verdict can say the
            -- work was salvaged rather than written; it changes NOTHING about
            -- how the work is judged.
            d.salvaged_at, d.salvaged_sha, d.salvaged_files, d.salvage_left,
            (SELECT string_agg(t.text, '' ORDER BY t.seq)
               FROM queen_transcript t
              WHERE t.conversation_id = d.conversation_id AND t.kind = 'say')
              AS said,
            EXISTS (SELECT 1 FROM queen_transcript t
                     WHERE t.conversation_id = d.conversation_id
                       AND t.kind = 'error') AS errored
       FROM queen_dispatch d
      WHERE d.started = true AND d.finished_at IS NOT NULL
        AND (d.review_state IS NULL OR d.review_state = 'wait')
        AND d.outcome NOT LIKE 'reaped%'
        ${stillOpen}
      -- The review budget is a few calls a round, so the rows that have waited
      -- longest for one go first; without an order, rows whose review keeps
      -- failing could spend the budget every round ahead of the rest.
      ORDER BY d.reviewer_at ASC NULLS FIRST, d.finished_at ASC`,
  )
  if (!boardIsTrustworthy) {
    logger.warn(
      'Review ran against every dispatch row: the issue board is empty',
    )
  }
  const acted: string[] = []
  const strayed: Array<{ issue: number; paths: string[] }> = []
  const tally: ReviewTally[] = []
  // The reviewer's lane budget for this sweep, and the keys running bees hold,
  // read once and only if a review is actually bought.
  let reviewsLeft = deps.reviewsPerRound()
  // The measurement's own budget, and the wall clock it may not outlive. The
  // sweep is awaited before the round reaps stalled dispatches and before the
  // board read that hands out work, so an unbounded sweep is a swarm that
  // dispatches nothing while its lease looks healthy.
  let measurementsLeft = deps.measurementsPerRound?.() ?? measurementsPerRound()
  const measurementDeadline = Date.now() + MEASUREMENT_SWEEP_MS
  let takenKeys: number[] | null = null
  const repo = process.env.TRIOS_GITHUB_REPO || 'gHashTag/trios'

  for (const row of done.rows) {
    const issue = row.issue as number
    const said = String(row.said ?? '')
    const beeLines = parseVerdictBlockDetailed(said)
    const verdicts = beeLines.map(({ criterion, met }) => ({ criterion, met }))
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
    // The half of the contract the bee never answered. #1420: the six
    // dispatches parked at the retry ceiling that morning all had an unmet
    // count that was exactly their omitted count - criteria that were never
    // judged at all, indistinguishable in the record from criteria that were
    // judged and failed.
    const unjudged = unjudgedCriteria(promised, verdicts)
    // A bee that wrote MORE lines than it was given is judged on what it wrote:
    // that is the case where the Queen supplied none and the bee stated its
    // own, which the brief asks for. (Once an adversary has answered, the
    // count is the adversary's contract instead - see `policyTotal` below.)
    const totalCriteria = Math.max(promised.length, verdicts.length)
    // The real count, not the literal 0 that used to sit here.
    //
    // Postgres hands an `integer` back as a JS number, but the column is read
    // through a driver that has returned strings for wider integer types in
    // this same file, so it is coerced rather than trusted: `'2' < 2` is true
    // in JSON only after Number() has been applied on the Swift side, and it
    // is not - `priorSendBacks` decodes as Int and a string would make queend
    // refuse the whole question.
    const priorSendBacks = Number(row.send_backs ?? 0) || 0
    const priorFreeAttempts = Number(row.free_attempts ?? 0) || 0
    const priorMisses = Number(row.reviewer_misses ?? 0) || 0
    const conversation =
      row.conversation_id == null ? null : String(row.conversation_id)

    // ONE git diff, asked once and used twice. The count is what the review
    // policy weighs; the names are what the boundary rule compares.
    const diff = await deps.committedFilesResult(issue)
    if (!diff.ok) {
      // A DIFF THAT COULD NOT BE READ DECIDES NOTHING. It used to arrive as
      // `[]`, and a bee that had written verdict lines was then judged as if
      // its branch were empty: all met became "met but nothing was committed"
      // and an escalation, one could-not-check became a free send-back whose
      // note blamed the work - and three git timeouts dead-lettered an issue
      // as "no commit". Neither counter moves; the next round reads the diff
      // again, and the frozen-wait valve bounds a diff that never reads.
      logger.warn('Queen could not read the diff of finished work', {
        issue,
        error: diff.error,
      })
      await recordVerdict(pool, issue, {
        state: 'wait',
        note:
          `The diff of queen-${issue} could not be read (${diff.error.slice(0, 300)}), ` +
          'so nothing was judged this round and nothing was counted.',
        strays: [],
        countsAgainstTheIssue: false,
        freeAttempts: priorFreeAttempts,
        reviewerMisses: priorMisses,
        judgedHead: null,
        conversation,
        reviewAttempted: false,
      })
      acted.push(`#${issue}:wait`)
      tally.push({
        issue,
        judged: verdicts.length,
        unjudged: unjudged.length,
      })
      continue
    }
    const files = diff.files
    // The fact, not a decision: whether these files reached the branch because
    // the bee committed them or because the container salvaged a turn that
    // ended without committing. It is appended to whatever verdict the policy
    // reaches, below and in the empty path.
    const salvaged = salvageSentence(row)
    const strays = await boundaryStrays(files, row.owned_paths ?? [])
    if (strays.length > 0) {
      strayed.push({ issue, paths: strays })
      logger.warn('Queen found work outside the boundary she gave', {
        issue,
        strays: strays.slice(0, 20),
      })
    }

    // Whether the turn was ended by the provider or the transport rather than
    // by the bee: a quota stop, a broken or missing stream, a close with no
    // completion, or an error frame in the transcript (a 1302 can arrive as
    // one inside a stream that otherwise closes normally). Such an attempt is
    // not evidence about the ISSUE.
    const providerEnded = endedOnTheProvider(row.outcome, row.errored)
    const branchHead = files.length > 0 ? await deps.branchHeadSha(issue) : null
    // NO NEW WORK. The worktree is reused on redispatch, so a retry that
    // committed nothing diffs exactly as the attempt before it. When another
    // attempt was already decided at this very head, this one added nothing.
    const unchangedSinceJudged =
      branchHead !== null &&
      row.judged_head === branchHead &&
      row.judged_conversation != null &&
      String(row.judged_conversation) !== conversation

    // AN EMPTY ATTEMPT IS RELEASED, AND COUNTED ONLY WHEN IT IS THE ISSUE'S.
    //
    // The diff ran, the branch holds no commit (or none since the last judged
    // attempt), and the bee wrote no verdict: there is nothing for anyone to
    // judge, today or in six hours. Measured 2026-09-17, most live waits on the
    // board were this - turns cut by deploy restarts, z.ai 1302 ending a turn
    // in seconds, edits never committed - and each held its files for the full
    // wait floor while lanes sat idle. So it is written `empty`, which
    // `stateOfDispatch` releases after a short floor.
    //
    // `free_attempts` counts it only when the bee ended its own turn. A quota
    // window or a rate-limit storm ends EVERY turn in seconds; counted, three
    // of them escalated an issue within minutes and moved the backlog into
    // needs-you one lane at a time. Uncounted, the floor paces the retries.
    if ((files.length === 0 || unchangedSinceJudged) && verdicts.length === 0) {
      const dirty = await deps.worktreeDirtCount(issue)
      const counted = !providerEnded
      const freeAttempts = counted ? priorFreeAttempts + 1 : priorFreeAttempts
      const deadLetter = counted && freeAttempts >= FREE_ATTEMPT_CEILING
      const state = deadLetter ? 'escalate' : 'empty'
      const priorFinding = String(row.judged_note ?? '').trim()
      const emptyNote =
        (files.length === 0
          ? `Nothing was committed on queen-${issue} and no verdict was written, ` +
            'so there was nothing to judge.'
          : `Nothing new was committed on queen-${issue} since the last attempt ` +
            `was judged (the branch is still at ${String(branchHead).slice(0, 12)}) ` +
            'and no verdict was written, so there was nothing new to judge.') +
        (dirty && dirty > 0
          ? ` ${dirty} uncommitted file(s) remain in the worktree; the next ` +
            'attempt reuses it, so they are not lost - commit them.'
          : '') +
        (providerEnded
          ? ` The turn ended as "${String(row.outcome ?? 'an error frame')}" - ` +
            'the provider or the transport, not the issue - so this attempt ' +
            'is not counted against it.'
          : '') +
        (files.length > 0 && priorFinding
          ? `\n\nThe last review's findings still stand:\n${priorFinding}`
          : '')
      const note =
        (deadLetter
          ? `${freeAttempts} consecutive attempts produced nothing judgeable ` +
            '(no commit, or no criterion anyone could establish), so this is ' +
            'handed to a person instead of being retried again. Last attempt: ' +
            emptyNote
          : emptyNote) + salvaged
      logger.info('Queen reviewed her own work', {
        issue,
        verdict: state,
        criteria: totalCriteria,
        judged: 0,
        unjudged: unjudged.length,
        source: row.criteria_source ?? 'none',
        priorSendBacks,
        strays: strays.length,
        specs: 0,
        t27c: 'absent',
        machineUnmet: 0,
        oracle: oracleOutcome(null),
        oracleDetail: '',
        reviewerModel: null,
        reviewerProvider: null,
        reviewerSameVendor: null,
        reviewerCached: false,
        files: files.length,
        diffOk: true,
        // How many of those files the container committed for the bee.
        salvaged: Array.isArray(row.salvaged_files)
          ? row.salvaged_files.length
          : 0,
        dirty,
        freeAttempts,
        providerEnded,
        unchangedSinceJudged,
        criteriaChecks: 0,
        criteriaPassed: 0,
        criteriaFailed: 0,
        criteriaUnrunnable: 0,
        criteriaCached: false,
      })
      await recordVerdict(pool, issue, {
        state,
        note,
        strays,
        countsAgainstTheIssue: false,
        freeAttempts,
        reviewerMisses: priorMisses,
        judgedHead: branchHead,
        conversation,
        reviewAttempted: false,
      })
      acted.push(`#${issue}:${state}`)
      tally.push({ issue, judged: 0, unjudged: unjudged.length })
      continue
    }

    // The machine's answer, next to the bee's. Every `.t27` file the branch changed is read
    // from the COMMIT and run through `t27c parse`, `parse-complete` and
    // `typecheck`; each measurement becomes a verdict line the policy weighs
    // exactly like the bee's own. Measured 2026-09-10 (gHashTag/t27#3560): 34
    // branches this review had passed on the bee's word, 9 held up under the
    // compiler - 20 did not parse at all. A review that reads "met" and does
    // not run the compiler is not a review.
    //
    // Taken only once the bee has judged anything: a bee with no verdict block
    // is the torn-transcript case, and a compiler's yes must not stand in for
    // the answers the bee never wrote.
    // THE COMPILER MAY REFUSE WORK THE BEE DID NOT DEFEND. IT MAY NOT PASS IT.
    //
    // The rule above this was: witness only once the bee has judged something,
    // because "a compiler's yes must not stand in for the answers the bee never
    // wrote". That reasoning is kept whole - and it is one-directional. A yes
    // stands in for an answer; a NO stands in for nothing. If the branch left
    // 21 function bodies empty, no verdict block the bee might have written
    // would have made that untrue.
    //
    // What it costs to keep waiting instead: a finished-but-unjudged dispatch
    // holds its file boundary for reviewBoundaryHoldHours (48), and the
    // frozen-wait valve only releases it after six. Measured 2026-09-16: 50
    // dispatches claimed, 11 more refused for fileConflict behind them, and the
    // swarm idle at 2 of 10 lanes with work it could not reach. Every one of
    // those waits was for an answer that was never coming - the model in use
    // writes a verdict block in about 1 turn in 400.
    //
    // So: measure either way, and use the measurement only to fail. When the
    // bee said nothing and the compiler finds nothing wrong, this still reads
    // `wait` exactly as before, because that is the case the original rule was
    // written for.
    const witness: Witness | null =
      verdicts.length > 0 || files.some((f) => f.endsWith('.t27'))
        ? await deps.witness(issue, files)
        : null
    const witnessLines = witness ? witnessVerdicts(witness) : []
    const specCount = files.filter((f) => f.endsWith('.t27')).length
    // No compiler on this image while the branch changed specs: nothing was
    // measured, so nothing is accepted. This asks a PERSON rather than waiting,
    // because a wait here would never resolve on its own - the frozen-wait
    // valve would fail the dispatch after six hours and return the issue to
    // the pool, losing a finished branch to a missing binary. `escalate` keeps
    // the branch on the board with the reason written down.
    const unwitnessed = witness?.kind === 'absent' && specCount > 0

    // The merge base is half of both cache keys below; read once, when needed.
    let mergeBaseRead = false
    let mergeBase: string | null = null
    const readMergeBase = async (): Promise<string | null> => {
      if (!mergeBaseRead) {
        mergeBase = await deps.mergeBaseSha(issue)
        mergeBaseRead = true
      }
      return mergeBase
    }

    // THE CRITERIA, RUN. In the t27 swarm nearly every criterion is a command
    // and the output it must print, and a reviewer with no tools can only
    // answer could-not-check for those - which escalated correct work to a
    // person (`beyondThePatch`). So the Queen runs them herself, on the
    // COMMIT, in a clean temporary checkout (queen-criteria-run.ts).
    //
    // Only the dispatch row's criteria are run, never criteria a bee stated
    // for itself: a defendant that writes the command also writes what it
    // prints. Cached by the reviewer's own key, so a wait row re-read every
    // round measures nothing twice.
    let criteriaRuns: CriterionRun[] = []
    let criteriaCached = false
    let measurementSkipped = ''
    if (
      files.length > 0 &&
      branchHead !== null &&
      !unwitnessed &&
      promised.some((c) => parseCriterionChecks(c).length > 0)
    ) {
      const base = await readMergeBase()
      const fingerprint = base
        ? reviewerFingerprint(branchHead, base, promised)
        : null
      if (!fingerprint) {
        logger.warn('Queen could not key a criteria measurement; none ran', {
          issue,
        })
      } else if (
        row.criteria_fingerprint === fingerprint &&
        isCriterionRuns(row.criteria_runs)
      ) {
        criteriaRuns = row.criteria_runs
        criteriaCached = true
      } else if (
        // NOT AHEAD OF THE BUDGET IT FEEDS. The measurement is evidence for a
        // review, and a row that cannot buy a review this round used to pay
        // for the measurement anyway: a ten-row probe made ten measurements
        // and three reviews, seven of them logging "the review budget for
        // this round is spent" AFTER their worktree had been cut and
        // removed. A cached answer needs no budget, so it still measures.
        reviewsLeft <= 0 &&
        !(
          row.reviewer_fingerprint === fingerprint &&
          typeof row.reviewer_text === 'string' &&
          row.reviewer_text.length > 0
        )
      ) {
        measurementSkipped = 'the review budget for this round is spent'
      } else if (measurementsLeft <= 0) {
        measurementSkipped = 'the measurement budget for this round is spent'
      } else if (Date.now() >= measurementDeadline) {
        measurementSkipped = 'the round has measured for as long as it may'
      } else {
        measurementsLeft -= 1
        const measured = await deps.measureCriteria(
          issue,
          branchHead,
          promised,
          base,
        )
        if (!measured.ok) {
          // Nothing measured is nothing decided, and nothing is cached: the
          // next round tries again.
          logger.warn('Queen could not measure the criteria on the commit', {
            issue,
            error: measured.error,
          })
        } else {
          criteriaRuns = measured.criteria
          // AN ENVIRONMENT FAULT IS NOT A MEASUREMENT. Every check coming
          // back unrunnable - t27c missing from a half-built image, a mount
          // that is not there yet, a spent budget - established nothing, and
          // caching it under the commit's fingerprint froze that emptiness:
          // the image was repaired ten minutes later and nothing re-measured,
          // because the key still matched. The reviewer then answered
          // could-not-check on commands it could not run and correct,
          // finished work escalated to a person, in a batch, across a whole
          // sweep. A run that settled nothing is retried next round, exactly
          // as a failed one already is.
          const established = criteriaCounts(criteriaRuns).checks > 0
          if (!established) {
            logger.warn('Queen measured the criteria and established nothing', {
              issue,
              criteria: criteriaRuns.length,
            })
          } else {
            await pool
              .query(
                `UPDATE queen_dispatch
                  SET criteria_fingerprint = $2, criteria_runs = $3::jsonb
                WHERE issue = $1`,
                [issue, fingerprint, JSON.stringify(criteriaRuns)],
              )
              .catch((error) => {
                logger.warn('Queen could not cache the criteria measurement', {
                  issue,
                  error: error instanceof Error ? error.message : String(error),
                })
              })
          }
        }
      }
    }
    const criteriaLines = criteriaWitness(criteriaRuns)
    // Criteria whose every command passed on the commit. The machine
    // established them; a reviewer's could-not-check does not undo that, and
    // only a refutation with a reason does.
    const measuredPassed = criteriaLines
      .filter((line) => line.met)
      .map((line) => line.number)
    // ...AND THE ONES THAT WERE ALREADY TRUE. A criterion that passes at the
    // merge base too says "this is true", never "this commit made it true",
    // and t27 criteria are routinely guard-shaped ("the name still exists",
    // "does not print NOPARSE") or stale. Those passes are still shown and
    // still counted, but they cannot carry an accept on their own below.
    const measuredBaseTrue = criteriaRuns
      .filter((run) => run.basePassed === true)
      .map((run) => run.number)
    const counts = criteriaCounts(criteriaRuns)

    // Every machine line, the compiler's and the criteria's. They obey the
    // compiler's rule: without a bee verdict only a failure is weighed - the
    // machine may refuse work the bee did not defend, never pass it.
    const machineAll = [
      ...witnessLines,
      ...criteriaLines.map(({ criterion, met }) => ({ criterion, met })),
    ]
    const machine =
      verdicts.length > 0 ? machineAll : machineAll.filter((v) => !v.met)
    const machineFailed = machine.filter((v) => !v.met).map((v) => v.criterion)

    // THE ADVERSARY (#1127). Until here the only per-criterion judgement was
    // the bee grading itself. A second reading, by a model told to refute,
    // shown the work and never the worker's own account of it.
    //
    // The criteria it is asked about are the dispatch row's; a task that was
    // given none is judged on the criteria its bee STATED - the criterion part
    // of its lines only, never their verdicts and never the evidence prose a
    // bee appends. Measured in a probe: a whole line went into the CRITERIA
    // fence as "A file src/x.ts exists; I ran bun test and it printed 14 pass
    // 0 fail, verified", so the defendant was writing its own charges with its
    // defence attached.
    const reviewCriteria =
      promised.length > 0
        ? promised
        : beeLines.map((line) => statedCriterion(line.criterion))
    let reviewer: {
      answers: Map<number, ReviewerAnswer>
      model: string
      provider: string
      sameVendor: boolean | null
      cached: boolean
    } | null = null
    let reviewerSkipped = ''
    // A review was bought and did not arrive in a form anyone can use - the
    // only kind of skip that counts towards `REVIEWER_MISS_CEILING`. No lane,
    // a spent budget and a transient refusal are the round's circumstances,
    // not a fact about the reviewer.
    let reviewerMissed = false
    let reviewAttempted = false
    let patchTruncated = false
    const bee = {
      provider: row.provider as string | null,
      model: row.model as string | null,
      keyIndex: row.key_index as number | null,
    }
    if (files.length > 0 && reviewCriteria.length > 0 && !unwitnessed) {
      const reviewBase = await readMergeBase()
      const fingerprint =
        branchHead && reviewBase
          ? reviewerFingerprint(branchHead, reviewBase, reviewCriteria)
          : null
      if (!fingerprint) {
        reviewerSkipped = 'the branch head or its merge base could not be read'
      } else if (
        row.reviewer_fingerprint === fingerprint &&
        typeof row.reviewer_text === 'string' &&
        row.reviewer_text.length > 0
      ) {
        reviewer = {
          answers: reviewerAnswers(row.reviewer_text, reviewCriteria.length),
          model: String(row.reviewer_model ?? ''),
          provider: String(row.reviewer_provider ?? ''),
          sameVendor: sameModelAs(bee, {
            provider: row.reviewer_provider,
            model: row.reviewer_model,
          }),
          cached: true,
        }
      } else if (measurementSkipped !== '') {
        // MEASURE FIRST, THEN ASK. A row whose mechanical criteria went
        // unmeasured for a budget would be shown to a reviewer that can only
        // answer could-not-check about a command, and a review that
        // establishes nothing escalates finished work to a person
        // (`beyondThePatch`). The budget is meant to spread the round's cost,
        // not to send correct work to the operator, so the row waits exactly
        // as one past the review budget does: nothing spent, nothing charged,
        // measured next round.
        reviewerSkipped = `the criteria were not measured this round (${measurementSkipped})`
      } else if (reviewsLeft <= 0) {
        reviewerSkipped = 'the review budget for this round is spent'
      } else {
        // THE SAME LANE ARITHMETIC AS DISPATCH. A review is a request on a
        // credential; the keys running bees hold are counted exactly as
        // `runRound` counts them before it hands out a key.
        takenKeys ??= await runningKeys(pool)
        const taken = takenKeys
        const pick = () =>
          chooseReviewerLane(
            deps
              .laneCandidates(taken)
              .filter((lane) => !reviewerLaneBackedOff(lane)),
            bee,
          )
        let choice = pick()
        if (!choice) {
          reviewerSkipped = 'no reviewer lane is free'
        } else {
          const patch = await deps.branchPatch(issue, REVIEW_PATCH_MAX_CHARS)
          if (patch === null) {
            // Not asked at all. A reviewer shown no patch can only answer
            // could-not-check - or, disobeying, met with nothing behind it -
            // and either answer would then be cached against a head it never
            // read.
            reviewerSkipped =
              'the patch could not be read, so there was nothing to review'
          } else {
            reviewsLeft -= 1
            reviewAttempted = true
            patchTruncated = /\n\[truncated \d+\+? chars\]$/.test(patch)
            const visible = visiblePatchPaths(patch)
            const message = reviewerMessage({
              repo,
              issue,
              criteria: reviewCriteria,
              files,
              patch,
              machine: witnessLines,
              measurements: measurementLines(criteriaRuns),
            })
            // FALL BACK ON A REFUSAL THAT WILL NOT PASS. The choice is
            // deterministic, so a lane that can never answer was chosen again
            // every round; a lane refused for good is backed off and the next
            // one is tried, down to the bee's own model as a last resort.
            let lastTransient = false
            for (
              let tries = 0;
              choice && tries < REVIEWER_LANE_TRIES;
              tries++
            ) {
              const lane: WorkerProvider = choice.lane
              const answer = await deps.llm(
                lane,
                REVIEWER_SYSTEM_PROMPT,
                message,
              )
              if (!answer.ok) {
                // Nothing spent: a 1302 or a timeout is the provider saying
                // "not now", and it must not read as a finding about the work.
                reviewerSkipped = `the reviewer call failed: ${answer.error}`
                lastTransient = answer.transient
                logger.warn('Queen reviewer call failed; nothing was spent', {
                  issue,
                  reviewerModel: lane.model,
                  reviewerProvider: lane.provider,
                  transient: answer.transient,
                  error: answer.error,
                })
                if (answer.transient) break
                markReviewerLaneFailed(lane)
                choice = pick()
                continue
              }
              lastTransient = false
              // THE COMPILER'S LINES ONLY, as `reviewerMessage` is given
              // them. `citesEvidence` harvests every file-shaped token out of
              // a met machine line and makes it citable for EVERY criterion,
              // which is sound for a witness line (it can only name a .t27
              // file the branch changed) and not for a criteria line, which
              // embeds the criterion's own command and so can name any path
              // in the tree - including one whose diff was cut from the patch
              // the reviewer was shown. A measurement establishes a criterion
              // through `citesMeasurement`, which is scoped to its own
              // number, and through `establishedByMeasurement` below.
              const judged = judgeReviewerText(
                answer.text,
                reviewCriteria.length,
                visible,
                witnessLines,
                measuredPassed,
              )
              if (judged.unanswered.length > 0) {
                // Silence is not a pass, and it is not a finding either: a
                // review that skipped criteria is not cached, and not charged
                // to the bee. It is a miss.
                reviewerSkipped =
                  `the reviewer left criteria ${judged.unanswered.join(', ')} ` +
                  'without a usable verdict line'
                reviewerMissed = true
                break
              }
              reviewer = {
                answers: judged.answers,
                model: lane.model,
                provider: lane.provider,
                sameVendor: choice.sameVendor,
                cached: false,
              }
              // Cached in canonical form - the answers as they were COUNTED,
              // an uncited met already read as could-not-check - because the
              // citation check needs the patch, and a cache that had to fetch
              // the patch again would not be a cache.
              await pool
                .query(
                  `UPDATE queen_dispatch
                      SET reviewer_fingerprint = $2, reviewer_text = $3,
                          reviewer_model = $4, reviewer_provider = $5,
                          reviewer_at = now()
                    WHERE issue = $1`,
                  [
                    issue,
                    fingerprint,
                    judged.canonical.slice(0, 20_000),
                    lane.model,
                    lane.provider,
                  ],
                )
                .catch((error) => {
                  // The verdict still stands for this round; only the cache is
                  // lost, and the next round pays for one more review.
                  logger.warn('Queen could not cache the reviewer answer', {
                    issue,
                    error:
                      error instanceof Error ? error.message : String(error),
                  })
                })
              break
            }
            if (!reviewer && !reviewerMissed && !lastTransient) {
              reviewerMissed = true
            }
          }
        }
      }
    }

    // What the bee ADMITTED. Its `met` lines are claims and are ignored once
    // an adversary has read the work; its `unmet` lines are admissions and are
    // kept whoever else judges - a reviewer cannot un-fail what the worker says
    // it did not do. Its `could-not-check` lines are the reviewer's to settle.
    const admitted = beeLines
      .filter((line) => line.verdict === 'unmet')
      .map((line) => line.criterion)
    const refuted: Array<{ criterion: string; reason: string }> = []
    const unestablished: Array<{ criterion: string; reason: string }> = []
    // Criterion numbers the reviewer did not establish and the machine did.
    const establishedByMeasurement: number[] = []
    if (reviewer) {
      reviewCriteria.forEach((criterion, i) => {
        const answer = reviewer?.answers.get(i + 1)
        if (answer?.verdict === 'met') return
        if (answer?.verdict === 'unmet' && hasStatedReason(answer)) {
          // A refutation with a reason wins over a passing measurement: the
          // command is what the issue's author could write down, and a
          // reviewer can still find why it does not cover the criterion.
          refuted.push({ criterion, reason: answer.reason })
        } else if (
          // A MEASUREMENT OUTRANKS SILENCE, NEVER A REFUSAL. This branch used
          // to catch every `unmet` whose reason was shorter than eight
          // alphanumerics - "no tests", "stub only", "not done" - and count
          // it MET because the command passed. Measured against the release
          // queend: `- 2. not done: unmet` over two passing measurements
          // produced accept with no send-back and no person, while the same
          // answer with a longer reason produced a send-back. The adversary
          // saying no about the very criterion the machine passed is the
          // self-grading inversion #1127 exists to end; a terse refusal falls
          // through to `unestablished`, counted unmet and charged to nobody,
          // exactly as it did before the measurement existed.
          answer?.verdict !== 'unmet' &&
          promised.length > 0 &&
          measuredPassed.includes(i + 1)
        ) {
          // Not "beyond the patch": the Queen ran it. Counted met, so a
          // could-not-check here neither escalates nor sends the bee back.
          establishedByMeasurement.push(i + 1)
        } else {
          unestablished.push({
            criterion,
            reason: answer ? answer.reason : 'the reviewer did not answer it',
          })
        }
      })
    }

    const questioned = reviewer
      ? // THE COMBINATION RULE. The reviewer decides met; a criterion it did
        // not answer is unmet (silence is not a pass, from either side); the
        // bee's admissions stand; and EVERY machine line goes in, met and
        // unmet, because the reviewer was shown them and the policy should
        // weigh what the reviewer weighed.
        [
          ...reviewCriteria.map((criterion, i) => ({
            criterion,
            met:
              reviewer?.answers.get(i + 1)?.verdict === 'met' ||
              establishedByMeasurement.includes(i + 1),
          })),
          ...admitted.map((criterion) => ({ criterion, met: false })),
          ...machineAll,
        ]
      : verdicts.length > 0
        ? [
            ...verdicts.map((v) => ({ criterion: v.criterion, met: v.met })),
            ...unjudged.map((criterion) => ({ criterion, met: false })),
            ...machine,
          ]
        : machine.length === 0
          ? // Silent bee, nothing measurably wrong: unchanged. queend sees an
            // empty list, answers wait, and the frozen-wait valve handles it
            // exactly as before. This is the case the original rule protects.
            []
          : // Silent bee AND the compiler proved a fault. The policy will not
            // decide on a partial set - `verdicts.count >= totalCriteria` or it
            // waits - so a lone proven failure would sit for 48 hours beside
            // the criteria nobody looked at.
            //
            // Those criteria are not unknown, they are UNVERIFIED, and this
            // codebase already rules on that: "`could-not-check` counts as
            // UNMET. A criterion nobody verified has not been satisfied, and
            // treating 'I could not tell' as 'yes' is how work closes on
            // faith." Counting them unmet is that rule applied, not a new one.
            //
            // Nothing is passed on faith here. The verdict this produces can
            // only be a send-back or an escalation: every line in the set is a
            // failure, so `unmet.isEmpty` is never true and the accept branch
            // is unreachable by construction.
            [
              ...machine,
              ...promised.map((criterion) => ({ criterion, met: false })),
            ]
    // Once an adversary has answered, the contract is ITS criteria. The bee's
    // line count used to stay in the total: a bee that wrote three lines
    // against two criteria (an extra "lint passes: met") made queend see 2
    // verdicts of 3, answer "2 of 3 criteria judged so far" and wait - with the
    // answer cached, every round, until the valve threw the finished work
    // back. Every line in `questioned` is still weighed; only the count that
    // gates the decision stops including the bee's extra claims.
    const policyTotal = reviewer ? reviewCriteria.length : totalCriteria
    const answer = unwitnessed
      ? null
      : await askQueend({
          kind: 'review',
          verdicts: questioned,
          totalCriteria: policyTotal,
          committedFiles: files.length,
          priorSendBacks,
        }).catch(() => null)
    let state = unwitnessed ? 'escalate' : String(answer?.verdict ?? 'wait')

    // NEVER ON THE BEE'S WORD ALONE. A commit exists, so an adversary could
    // read it - and has not yet (no lane, a provider refusal, the round's
    // budget). An accept here would be the self-grading #1127 exists to end,
    // so it waits for the reviewer instead. A send-back grounded in something
    // other than the bee's say-so - the compiler's refusal, or the bee's own
    // admission - still goes back as it always did; one grounded only in
    // silence waits too, because the reviewer may yet establish those
    // criteria.
    let heldForReviewer = false
    if (!reviewer && files.length > 0) {
      if (
        // A wait the policy chose itself (a silent bee) is held for the
        // same reason when a review was due and did not happen - and must
        // reach the same ceiling, or a silent bee over a broken reviewer
        // loops through the frozen-wait valve exactly as before.
        (state === 'wait' && reviewerSkipped !== '') ||
        state === 'accept' ||
        (state === 'sendBack' &&
          machineFailed.length === 0 &&
          admitted.length === 0)
      ) {
        state = 'wait'
        heldForReviewer = true
      }
    }
    // ...AND NOT FOR EVER. A review bought and never delivered, round after
    // round, is a reviewer that cannot judge this commit; holding it would
    // throw the finished work back every six hours and take the next commit
    // into the same hold. At the ceiling it becomes a person's, with the
    // reason written down.
    const reviewerMisses = reviewer
      ? 0
      : reviewerMissed
        ? priorMisses + 1
        : priorMisses
    const reviewerGaveUp =
      heldForReviewer && reviewerMisses >= REVIEWER_MISS_CEILING
    if (reviewerGaveUp) state = 'escalate'

    // Judged versus unjudged, recorded per dispatch (#1420, FR-001): "2 of 5
    // judged" is a fact about the worker's reporting, not about the work, and
    // the two belong in the record as separate numbers. The compiler's failed
    // lines join the judged-and-failed list: they were checked, and found
    // wanting, which is what that list means.
    const failed = [
      ...verdicts.filter((v) => !v.met).map((v) => v.criterion),
      ...machineFailed,
    ]

    // Whether this attempt counts against the retry ceiling (#1420, FR-003).
    //
    // `send_backs` measures how many times work has been judged and FOUND
    // WANTING, so only a finding spends it: a machine failure, an unmet the bee
    // admitted, or an unmet the reviewer refuted with a stated reason. An
    // attempt whose only unmet lines are could-not-check or unjudged was not
    // found wanting - nobody could tell - and counting that was how three of
    // the six dispatches measured on 2026-09-04 reached maximumRealAttempts
    // and escalated without the work ever being assessed, the oldest after 91
    // hours. The attempt still comes back (the criteria are still unmet); it
    // spends `free_attempts` instead, which has a ceiling of its own.
    //
    // And a finding is charged ONCE per commit: at a head another attempt was
    // already judged at, the same finding is not new, whoever repeats it.
    const countsAgainstTheIssue =
      !unchangedSinceJudged &&
      (machineFailed.length > 0 || admitted.length > 0 || refuted.length > 0)

    // BEYOND WHAT A PATCH SHOWS. The reviewer read the commit, refuted
    // nothing, and could not establish the rest - a criterion that needs a
    // test run, a deployment, or more than the patch it was shown. Sending the
    // bee back cannot change what a patch-only reviewer can see: measured
    // with the real queend, correct work with a "bun test passes" criterion
    // went sendBack, sendBack, escalate - three bee turns and two hour-long
    // floors to reach the person it was always going to reach. So it goes to
    // the person now, and the note names what could not be seen.
    const beyondThePatch =
      reviewer !== null &&
      state === 'sendBack' &&
      !countsAgainstTheIssue &&
      !unchangedSinceJudged &&
      unestablished.length > 0
    if (beyondThePatch) state = 'escalate'

    // NOTHING THE COMMIT DID. Every criterion that carried this accept was
    // established by a measurement alone - the reviewer established none of
    // them itself - and every one of those commands ALSO passed at the merge
    // base. That is an issue whose spec was implemented on master before the
    // bee started, or one whose criteria are all guards ("the name still
    // exists"), and one unrelated edit is enough to reach it: `files.length`
    // is non-zero, every command passes at the head, the reviewer can only
    // answer could-not-check off the patch, and the branch would be accepted
    // with no send-back and nobody looking. Before the measurement existed
    // this was a person's escalation, and it goes back to being one. A
    // reviewer that established a criterion ITSELF is judgement, not
    // arithmetic, and is left alone.
    const acceptedOnBaseTruthAlone =
      reviewer !== null &&
      state === 'accept' &&
      establishedByMeasurement.length > 0 &&
      establishedByMeasurement.every((n) => measuredBaseTrue.includes(n)) &&
      !reviewCriteria.some(
        (_, i) => reviewer?.answers.get(i + 1)?.verdict === 'met',
      )
    if (acceptedOnBaseTruthAlone) state = 'escalate'

    const freeAttempt = state === 'sendBack' && !countsAgainstTheIssue
    const freeAttempts = freeAttempt
      ? priorFreeAttempts + 1
      : (state === 'sendBack' && countsAgainstTheIssue) || state === 'accept'
        ? 0
        : priorFreeAttempts
    const deadLetter = freeAttempt && freeAttempts >= FREE_ATTEMPT_CEILING
    if (deadLetter) state = 'escalate'

    logger.info('Queen reviewed her own work', {
      issue,
      verdict: state,
      criteria: policyTotal,
      judged: verdicts.length,
      unjudged: unjudged.length,
      source: row.criteria_source ?? 'none',
      priorSendBacks,
      strays: strays.length,
      specs: specCount,
      t27c: witness?.kind === 'witnessed' ? witness.t27c : 'absent',
      machineUnmet: machineFailed.length,
      oracle: oracleOutcome(witness),
      // The verdict alone was not enough to settle a disagreement: production
      // reported `fail` on branches a local run of the same witness called
      // `pre-broken`, and with no error text logged there was no way to tell
      // which base each was measuring against. One word is a signal; the
      // reason is evidence.
      oracleDetail:
        witness?.kind === 'witnessed'
          ? (
              witness.specs.find((sp) => sp.oracleError)?.oracleError ?? ''
            ).slice(0, 180)
          : '',
      // WHO JUDGED (#1127). A verdict is only as independent as the model
      // behind it, so the log names it, says whether it was the bee's own
      // model, and whether this round bought it or reused it.
      reviewerModel: reviewer?.model ?? null,
      reviewerProvider: reviewer?.provider ?? null,
      reviewerSameVendor: reviewer?.sameVendor ?? null,
      // The bee's own model beside the reviewer's, because `sameVendor` is a
      // conservative default: with the bee's model missing from the row it
      // reads `true` (no separation claimed) even when the reviewer ran on
      // another vendor entirely - #3972 was judged by nemotron over a z.ai bee
      // and still logged sameVendor=true. The two names let a reader tell
      // "we could not know" from "it really was the same model".
      beeModel: (row.model as string | null) ?? null,
      reviewerCached: reviewer?.cached ?? false,
      reviewerSkipped: reviewer ? '' : reviewerSkipped,
      reviewerMisses,
      files: files.length,
      diffOk: true,
      // How many of those files the container committed for the bee.
      salvaged: Array.isArray(row.salvaged_files)
        ? row.salvaged_files.length
        : 0,
      dirty: null,
      freeAttempts,
      providerEnded,
      unchangedSinceJudged,
      // The criteria the Queen ran herself: checks that ran (passed plus
      // failed), and whether this round ran them or read the cache.
      criteriaChecks: counts.checks,
      criteriaPassed: counts.passed,
      criteriaFailed: counts.failed,
      criteriaUnrunnable: counts.unrunnable,
      criteriaCached,
      // Why a row was not measured this round, and which of its passes were
      // already true before the branch existed.
      criteriaSkipped: measurementSkipped,
      criteriaBaseTrue: measuredBaseTrue.length,
    })
    if (unwitnessed) {
      logger.warn(
        'Queen could not witness the specs: t27c is not on this image',
        {
          issue,
          specs: specCount,
          detail: witness?.kind === 'absent' ? witness.detail : '',
        },
      )
    }
    // The send-back message the worker reads, with the two lists under distinct
    // headings (#1420, FR-002): what it tested and failed, and what it never
    // wrote a verdict line for at all.
    const policyNote = String(answer?.note ?? answer?.refusal ?? '')
    const judgedNote = unwitnessed
      ? `${specCount} .t27 file(s) changed but t27c is not available on this ` +
        'image, so the review could not run t27c parse / parse-complete / ' +
        'typecheck on the commit; a reviewer with t27c must, before merging. ' +
        (witness?.kind === 'absent' ? witness.detail : '')
      : reviewerGaveUp
        ? `The adversarial reviewer did not deliver a usable verdict on this ` +
          `commit ${reviewerMisses} rounds running (last: ${reviewerSkipped || 'no answer'}). ` +
          "A commit is never accepted on the worker's word, so a person must " +
          'judge it or repair the reviewer lane.'
        : acceptedOnBaseTruthAlone
          ? 'Every criterion that would have carried this accept was ' +
            'established only by running its own command, and every one of ' +
            `those commands already passed at the merge base (${measuredBaseTrue.join(', ')}). ` +
            'Nothing measured shows this commit did the work, and the ' +
            'reviewer established none of them from the patch, so a person ' +
            'with a checkout decides.'
          : beyondThePatch && reviewer
            ? `An adversarial reviewer (${reviewer.provider}/${reviewer.model}) ` +
              'read the commit, refuted nothing, and could not establish:\n' +
              unestablished
                .map(
                  (u, i) =>
                    `  ${i + 1}. ${u.criterion}${u.reason ? ` - ${u.reason}` : ''}`,
                )
                .join('\n') +
              (patchTruncated
                ? `\nThe patch it was shown was cut at ${REVIEW_PATCH_MAX_CHARS} characters.`
                : '') +
              '\nA reviewer that only reads the patch cannot run tests or see ' +
              'beyond it, and sending the bee back cannot change that, so a ' +
              'person with a checkout decides.'
            : state === 'sendBack' || deadLetter
              ? reviewer
                ? reviewedSendBackMessage(
                    String(answer?.note ?? ''),
                    reviewer,
                    refuted,
                    unestablished,
                    admitted,
                    machineFailed,
                  )
                : sendBackMessage(String(answer?.note ?? ''), failed, unjudged)
              : heldForReviewer
                ? `Waiting for the adversarial reviewer before judging a commit on the worker's word (${reviewerSkipped || 'no reviewer verdict yet'}).`
                : policyNote
    const note =
      (deadLetter
        ? `${freeAttempts} consecutive attempts produced nothing judgeable ` +
          '(no commit, or no criterion anyone could establish), so this is ' +
          'handed to a person instead of being retried again. Last review: ' +
          judgedNote
        : judgedNote) + salvaged
    await recordVerdict(pool, issue, {
      state,
      note,
      strays,
      countsAgainstTheIssue,
      freeAttempts,
      reviewerMisses,
      judgedHead: branchHead,
      conversation,
      reviewAttempted,
    })
    acted.push(`#${issue}:${state}`)
    tally.push({
      issue,
      judged: verdicts.length,
      unjudged: unjudged.length,
    })
  }
  return { acted, strays: strayed, tally }
}

/** Lanes one review may try before the round moves on. */
export const REVIEWER_LANE_TRIES = 3

/**
 * How long one sweep may spend measuring criteria, all rows together.
 *
 * A second bound beside the per-round count, because the count alone bounds
 * the number of worktrees and not the time: a row whose commands each sit on
 * the 60 s ceiling can spend five minutes on its own. `runRound` awaits this
 * sweep before it reaps and before it dispatches, so the number that matters
 * is how long the swarm is willing to hand out no work at all.
 */
export const MEASUREMENT_SWEEP_MS = 4 * 60 * 1000

/**
 * Rounds a bought review may fail to arrive for one commit before a person is
 * asked. Three, the same order as `FREE_ATTEMPT_CEILING`: enough for a lane to
 * be backed off and another tried, not enough to hold finished work for hours.
 */
export const REVIEWER_MISS_CEILING = 3

/**
 * Whether a finished turn was ended by the provider or the transport rather
 * than by the bee. See the empty-attempt rule in `reviewFinishedDispatches`.
 */
export function endedOnTheProvider(
  outcome: unknown,
  errored: unknown,
): boolean {
  if (errored === true) return true
  const text = String(outcome ?? '')
  return text !== '' && text !== DISPATCH_OUTCOME_LABELS.finished
}

/**
 * The criterion a bee STATED, without the evidence it appended.
 *
 * The brief asks for "<the criterion, in the issue's own words>: met", and a
 * bee that adds "; I ran the tests and they pass" has written its defence into
 * the line. Cut at the first clause separator and bounded, so a contract built
 * from bee lines carries the claim's subject and not its argument.
 */
export function statedCriterion(criterion: string): string {
  const text = withoutSlot(criterion)
  const head = text.split(/;\s|\s+-{1,2}\s+|\s+because\s+|,\s*(?:i|we)\s+/i)[0]
  return (head ?? text).trim().slice(0, 160)
}

/**
 * The verdict, the note and every counter, in ONE statement.
 *
 * The increments are part of the same statement that records the verdict,
 * because a count kept by a second write is a count that a crash between the
 * two makes wrong in the direction that matters: an issue whose send-backs are
 * undercounted is an issue that never escalates.
 *
 * `free_attempts` and `reviewer_misses` are written as the values the sweep
 * computed rather than as SQL arithmetic. The sweep runs under the Queen's
 * lease, so the row it read is the row it writes; and a CASE that only a live
 * database evaluates was a CASE no test could see - its parameter could be
 * rewired and every suite still passed.
 *
 * The note is bounded at 1500, which is also what the next bee's brief shows
 * of it (`PREVIOUS_REVIEW_MAX_CHARS`): a reviewer's reasons with citations do
 * not fit the 900 a bare list of criteria used to.
 */
async function recordVerdict(
  pool: Pool,
  issue: number,
  verdict: {
    state: string
    note: string
    strays: string[]
    countsAgainstTheIssue: boolean
    freeAttempts: number
    reviewerMisses: number
    judgedHead: string | null
    conversation: string | null
    reviewAttempted: boolean
  },
): Promise<void> {
  await pool.query(
    `UPDATE queen_dispatch
        SET review_state = $2, review_note = $3, reviewed_at = now(),
            strays = $4::jsonb,
            send_backs = CASE WHEN $2::text = 'sendBack' AND $5::boolean
                              THEN send_backs + 1 ELSE send_backs END,
            free_attempts = $6::integer,
            reviewer_misses = $7::integer,
            judged_head = CASE WHEN $2::text <> 'wait' AND $8::text IS NOT NULL
                               THEN $8::text ELSE judged_head END,
            judged_conversation = CASE
              WHEN $2::text <> 'wait' AND $8::text IS NOT NULL
              THEN $9::text ELSE judged_conversation END,
            judged_note = CASE WHEN $2::text IN ('sendBack', 'escalate')
                               THEN $3 ELSE judged_note END,
            reviewer_at = CASE WHEN $10::boolean THEN now()
                               ELSE reviewer_at END
      WHERE issue = $1`,
    [
      issue,
      verdict.state,
      verdict.note.slice(0, PREVIOUS_REVIEW_MAX_CHARS),
      JSON.stringify(verdict.strays),
      verdict.countsAgainstTheIssue,
      verdict.freeAttempts,
      verdict.reviewerMisses,
      verdict.judgedHead,
      verdict.conversation,
      verdict.reviewAttempted,
    ],
  )
}

/**
 * The key indices running bees hold, counted as `runRound` counts them: a bee
 * that is still running is spending its key; a finished one is not.
 */
async function runningKeys(pool: Pool): Promise<number[]> {
  const running = await pool
    .query(
      `SELECT key_index FROM queen_dispatch
        WHERE started = true AND finished_at IS NULL
          AND coalesce(outcome, '') NOT LIKE 'reaped%'`,
    )
    .catch(() => null)
  return (running?.rows ?? [])
    .map((r) => r.key_index)
    .filter((i): i is number => typeof i === 'number')
}

/** One VERDICT line with its three-state answer kept. */
export interface VerdictLine {
  criterion: string
  met: boolean
  verdict: 'met' | 'unmet' | 'could-not-check'
}

/** The bee's own VERDICT block, or nothing. */
export function parseVerdictBlock(
  text: string,
): Array<{ criterion: string; met: boolean }> {
  return parseVerdictBlockDetailed(text).map(({ criterion, met }) => ({
    criterion,
    met,
  }))
}

/**
 * The same block with `unmet` and `could-not-check` told apart.
 *
 * Both are UNMET to the policy and stay so - `met` is computed exactly as
 * before. The difference matters to the retry budget and nowhere else: "I
 * checked and it fails" is an admission worth a send-back, "I could not tell"
 * is not (the adversarial review settles it instead). The same parser serves
 * the bee and the reviewer, so a line one of them counts is a line the other
 * would have counted.
 */
/**
 * Every `## VERDICT` block in a text, each parsed on its own.
 *
 * The reviewer's reader needs all of them: the bee's rule below keeps the
 * longest, and a draft block ahead of a corrected one of the same length won.
 */
export function parseVerdictBlocks(text: string): VerdictLine[][] {
  const out: VerdictLine[][] = []
  for (
    let i = text.indexOf('## VERDICT');
    i >= 0;
    i = text.indexOf('## VERDICT', i + 1)
  ) {
    out.push(parseVerdictFrom(text, i))
  }
  return out
}

export function parseVerdictBlockDetailed(text: string): VerdictLine[] {
  // EVERY occurrence is tried, and the most complete one wins.
  //
  // This took `lastIndexOf`, which was right while the block was required to be
  // last. The block is now required to be FIRST, and a report that quotes the
  // words "## VERDICT" later - in a summary, in a quoted brief, in an
  // explanation of this very rule - would otherwise hand the parser a heading
  // with no bullets under it and yield nothing at all.
  //
  // Trying each and keeping the longest parse is stable under either
  // convention, so a worker running an older brief is not punished for it.
  const starts: number[] = []
  for (
    let i = text.indexOf('## VERDICT');
    i >= 0;
    i = text.indexOf('## VERDICT', i + 1)
  ) {
    starts.push(i)
  }
  if (!starts.length) return []
  let best: VerdictLine[] = []
  for (const start of starts) {
    const found = parseVerdictFrom(text, start)
    if (found.length > best.length) best = found
  }
  return best
}

/** One VERDICT block, read from a known offset. */
function parseVerdictFrom(text: string, at: number): VerdictLine[] {
  const out: VerdictLine[] = []
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
      verdict: m[2].toLowerCase() as VerdictLine['verdict'],
    })
  }
  return out
}

/**
 * Which numbered slots of the VERDICT template a report leaves unanswered
 * (#1421).
 *
 * The second half of the same defect: the brief now hands the bee a template
 * with numbered slots, and this is the check that names the numbers a given
 * report did not fill. It reads the SAME block `parseVerdictBlock` reads -
 * one parser, so a line this counts as answered is exactly a line the review
 * counts as judged - and calls a slot covered only when a parsed verdict
 * line carries its number.
 *
 * A NUMBER, NOT A POSITION. The old contract was order-based: the third
 * verdict line was the third criterion whether or not it said so, which is
 * how prose about the work came to satisfy the letter of the instruction
 * while the reviewer counted "Finished work omitted N verdict lines". Under
 * the numbered template, a report that answers in prose without numbers has
 * covered nothing: every slot is missing, and the answer that follows is
 * "fill these in", never a guess about which sentence meant which criterion.
 *
 * Not yet wired past this file: the path that would tell a still-running bee
 * which numbers it owes lives in `queen-dispatch.ts`, outside this change's
 * boundary. The brief tells the bee to run this check on itself before it
 * stops; the wiring, when it arrives, calls this same function so the two
 * can never disagree about what "missing" means.
 */
export function missingVerdictSlots(text: string, total: number): number[] {
  const covered = new Set<number>()
  for (const verdict of parseVerdictBlock(text)) {
    const slot = verdict.criterion.match(/^(\d{1,3})\.\s/)
    if (slot) covered.add(Number(slot[1]))
  }
  const missing: number[] = []
  for (let i = 1; i <= total; i++) {
    if (!covered.has(i)) missing.push(i)
  }
  return missing
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
  started: Array<DispatchReportOutcome>,
  choice: QueendChoice,
  candidates: number,
): Promise<void> {
  const lines: string[] = []
  const escalated = reviewed.acted.filter((r) => r.endsWith(':escalate'))
  const accepted = reviewed.acted.filter((r) => r.endsWith(':accept'))
  const sentBack = reviewed.acted.filter((r) => r.endsWith(':sendBack'))

  // The sentences about dispatch are built in queen-report-lines.ts, which
  // counts bees from the `started` boolean at the point each sentence is
  // built. Counting the array here instead counted refusals as workers, and
  // a round that started nothing was reported as a bee in flight (#1379).
  const dispatchSentence = startedLine(started)
  if (dispatchSentence !== '') lines.push(dispatchSentence)
  for (const refused of refusedLines(started)) lines.push(refused)
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
  if (dispatchesThatStarted(started).length === 0) {
    // The refusal, verbatim. A round that started nothing is the case where a
    // summary in my own words would be the least trustworthy thing on the page.
    // This fires for a round that dispatched and was refused as it does for a
    // round that never dispatched - the sentence is the same because the fact
    // (no bee started) is the same. The refused dispatches above carry the why.
    lines.push(nothingStartedLine(choice.refusal, candidates))
    const skipped = (choice.skipped ?? []).slice(0, 6)
    if (skipped.length > 0) lines.push('', ...skipped.map((s) => `  ${s}`))
  }

  const headline = reportHeadline(escalated.length, started, choice.refusal)

  await pool
    .query(
      `INSERT INTO queen_report (headline, body, needs_you)
       VALUES ($1, $2, $3)`,
      [
        headline.slice(0, 200),
        lines.join('\n').slice(0, 4000),
        // OUTSTANDING, not new. This read `escalated.length > 0` - the
        // escalations raised in THIS round - so a round that raised none wrote
        // `needs_you = false` while six were still waiting. Measured
        // 2026-09-04: of the 40 most recent reports, ZERO carried the flag
        // against six outstanding escalations. The one boolean whose whole job
        // is to say a person is needed was false whenever the need was not
        // brand new.
        //
        // The count comes from the same function `/queen/needs-you` answers
        // with, so the flag and the page cannot drift into disagreeing about
        // what "waiting on you" means.
        (await outstandingEscalations(pool).catch(() =>
          escalated.length > 0 ? 1 : 0,
        )) > 0,
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

  const pool = createQueenPool(url)
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
