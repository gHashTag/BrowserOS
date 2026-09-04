/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Public, read-only proof that the Queen supervisor is alive.
 *
 * Detailed state stays behind /queen/lease. This projection is deliberately
 * small enough for a public status page: no holder identity, branch,
 * conversation, transcript, provider detail, or mutation route escapes it.
 *
 * The one question it answers about an idle-looking swarm is WHY the last
 * round started nothing, and it answers two ways: `swarmState`, one closed
 * word for what the swarm IS, and `skipSummary`, counts by fixed category for
 * why the last round started nothing. The stored reasons name their issue, its
 * paths and its holders, which is what an operator needs behind the dashboard
 * and is wrong to publish in full - so what leaves this file is the category
 * count plus the bare issue number behind it, capped by SKIP_ISSUE_LIST_CAP so
 * the projection stays bounded however many candidates a round passed over.
 * A count nobody can act on was the defect this projection shipped with: the
 * count said two issues lacked a boundary and could not say which two. The
 * number alone is inert - paths, holders, titles and prose never leave.
 *
 * `queue` is the same answer for the paid slots themselves: `workers`-style
 * utilization says HOW MANY slots are busy, `queue.state` says why the rest
 * are not - no eligible work, a full hive, work in flight, or evidence this
 * page refuses to interpret. One closed word and one timestamp, nothing else,
 * because the second anything else rides along it becomes a channel.
 */

import { Hono } from 'hono'
import { Pool } from 'pg'
import { logger } from '../../lib/logger'
import { configuredWorkerCapacity } from '../services/queen-dispatch'

interface QueryResult {
  rowCount: number | null
  rows: Array<Record<string, unknown>>
}

interface StatusPool {
  query(sql: string, values?: unknown[]): Promise<QueryResult>
  end(): Promise<void>
}

interface QueenPublicStatusDeps {
  databaseUrl?: () => string | undefined
  createPool?: (url: string) => StatusPool
  tickIntervalSeconds?: () => number
  billingMode?: () => BillingMode
  /** Paid worker slots, from the same authority /queen/public-research reads. */
  workerCapacity?: () => number
  /** Clock, injectable so staleness is testable against fixed tick dates. */
  now?: () => number
}

type BillingMode = 'api_metered' | 'coding_plan'

function configuredDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || undefined
}

function configuredTickIntervalSeconds(): number {
  const raw = Number(process.env.TRIOS_QUEEN_TICK_SECONDS ?? '0')
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/**
 * Public projection of the explicit worker billing contract.
 *
 * This does not decide whether a Bee starts; queend owns that decision in
 * Swift. It only resolves the same closed environment value for status. An
 * absent or unknown value stays conservative and reports the metered gate.
 */
export function configuredBillingMode(
  raw = process.env.TRIOS_SWARM_BILLING_MODE,
): BillingMode {
  return raw?.trim().toLowerCase() === 'coding_plan'
    ? 'coding_plan'
    : 'api_metered'
}

const asCount = (value: unknown): number => {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? count : 0
}

/**
 * Every category `skipSummary` can carry.
 *
 * The set is closed on purpose. A category per sentence would grow with
 * every wording change in `queend`, and an open set is not a contract a
 * public consumer can rely on. These are the identifiers, not prose:
 *
 *   claimed          an existing claim - a worker has the issue or is
 *                    expected back on it
 *   completed        the work already landed and nobody closed the issue
 *   missingBoundary  the issue never said what it touches, so nothing can
 *                    be reserved for it
 *   fileConflict     its paths are held by another task
 *   incompleteSpec   delegatable but missing spec sections
 *   notFirst         a lower-priority candidate passed over because the
 *                    round starts one bee
 *   other            anything unrecognized, including the round-level
 *                    reasons a tick writes when it never reached a choice
 */
const SKIP_CATEGORIES = [
  'claimed',
  'completed',
  'missingBoundary',
  'fileConflict',
  'incompleteSpec',
  'notFirst',
  'other',
] as const

type SkipCategory = (typeof SKIP_CATEGORIES)[number]

/**
 * How many issue numbers one `skipSummary` category may list.
 *
 * Named because it is a contract, not an implementation detail: the payload
 * reports it (`lastTick.skipIssueListCap`) so a reader can tell a truncated
 * list from a complete one, and the remainder past the cap is reported as
 * `more` on the same entry. A literal at the call site could drift from the
 * number the payload claims.
 */
export const SKIP_ISSUE_LIST_CAP = 25

/**
 * What one `skipSummary` category carries.
 *
 * `count` is every reason filed under the category, `issues` the bare numbers
 * of at most SKIP_ISSUE_LIST_CAP of them in the order the round examined
 * them, and `more` every counted entry not listed - truncated by the cap or
 * never numbered at all. For every category `issues.length + more === count`,
 * so a reader never has to guess which of the two a missing number is.
 */
interface SkipReasonSummary {
  count: number
  issues: number[]
  more: number
}

/**
 * One stored skip reason, filed under a category.
 *
 * The reasons are `queend`'s sentences (queen-core/Sources/queend/main.swift)
 * and the matchers pin their stable wording, never their payloads: a reason
 * names its issue, its paths and its holders after that wording, and of all
 * of it only the leading issue number is ever echoed - paths and holders stay
 * behind. ` held by ` is matched first because it is the only reason whose
 * free text - file paths - could contain one of the shorter markers; the
 * fixed-template reasons cannot contain a path.
 */
function classifySkipReason(line: string): SkipCategory {
  if (line.includes(' held by ')) return 'fileConflict'
  if (line.includes('a worker has it or is expected back')) return 'claimed'
  if (line.includes('the work already landed')) return 'completed'
  if (line.includes('no issue body was supplied')) return 'missingBoundary'
  if (line.includes('delegatable but')) return 'incompleteSpec'
  if (line.includes('not yet a spec')) return 'missingBoundary'
  if (line.includes('declares no boundary')) return 'missingBoundary'
  if (line.includes('not first')) return 'notFirst'
  return 'other'
}

/**
 * The public aggregate of one tick's skip reasons.
 *
 * Every entry is filed exactly once - unrecognized sentences under `other`
 * rather than dropped - so the counts always sum to `skippedCount`. Only
 * non-zero categories appear, in the fixed order above, so two reads of the
 * same tick serialize identically and the object never grows past the closed
 * category set. An absent skip array summarises to `{}`: an older tick stays
 * a valid response, just with nothing to say.
 *
 * Each category carries the issue numbers behind its count, taken from the
 * leading `#<number>` of `queend`'s per-issue template and nothing else: the
 * payload after the colon can hold other `#` tokens (a file conflict names
 * its holders, `gHashTag/trios#1188`), and a holder is not the skipped issue.
 * At most SKIP_ISSUE_LIST_CAP numbers leave per category; everything counted
 * but not listed is `more`, which keeps `issues.length + more === count` true
 * for every category - truncated by the cap or never numbered at all.
 */
function summarizeSkips(
  skipped: unknown[],
): Partial<Record<SkipCategory, SkipReasonSummary>> {
  const filed = new Map<SkipCategory, { count: number; issues: number[] }>()
  for (const entry of skipped) {
    // jsonb holds whatever was put in it; a non-string reason is counted,
    // never trusted to carry meaning.
    const line = typeof entry === 'string' ? entry : String(entry)
    const category = classifySkipReason(line)
    const bucket = filed.get(category) ?? { count: 0, issues: [] }
    bucket.count += 1
    const leading = line.match(/^#(\d+)/)
    if (leading && bucket.issues.length < SKIP_ISSUE_LIST_CAP) {
      bucket.issues.push(Number(leading[1]))
    }
    filed.set(category, bucket)
  }
  const summary: Partial<Record<SkipCategory, SkipReasonSummary>> = {}
  for (const category of SKIP_CATEGORIES) {
    const bucket = filed.get(category)
    if (!bucket) continue
    summary[category] = {
      count: bucket.count,
      issues: bucket.issues,
      more: bucket.count - bucket.issues.length,
    }
  }
  return summary
}

/**
 * Every value `swarmState` can carry.
 *
 * Closed for the same reason the skip categories are: a public consumer must
 * be able to rely on every value it will ever read, and an open vocabulary is
 * not a contract. The four values are the four honest answers to the question
 * `running: 0` used to leave ambiguous:
 *
 *   working             a dispatch has not finished; the table itself vouches
 *                       for the work, so nothing else is consulted
 *   waiting_for_review  nothing running, the tick did not measure an empty
 *                       backlog, and a finished dispatch still has no verdict
 *                       - the Queen has not judged her bee
 *   healthy_idle        nothing running, the scheduler enabled, and either
 *                       a readable tick that explicitly found no eligible
 *                       candidate or one whose refusal is `nothing to choose`
 *                       - the latest round examined the backlog and could
 *                       start none of it
 *   unavailable         nothing running and nothing owed, but the scheduler is
 *                       disabled or no readable tick exists, so this page
 *                       cannot say WHY the swarm is quiet and refuses to dress
 *                       the silence up as health
 */
type SwarmState =
  | 'working'
  | 'waiting_for_review'
  | 'healthy_idle'
  | 'unavailable'

/**
 * The one closed word for what the swarm is.
 *
 * The facts feeding it are the counts, the scheduler interval, and the same
 * tick decision `lastTick.refusal` quotes - so the state and the refusal are
 * two readings of one record and cannot disagree: a tick that refused with
 * `nothing to choose` measured the backlog empty, and no state may then name
 * a review as the reason the swarm is quiet. The order below is the contract,
 * and it is the order of how directly each fact speaks about the present:
 *
 *   1. `working` - an unfinished dispatch is observable now; a disabled
 *      scheduler or a missing tick says nothing against work the table
 *      itself vouches for.
 *   2. `healthy_idle` - the scheduler is enabled and the latest readable
 *      decision refused with `nothing to choose`: the round examined every
 *      candidate and could start none, so the quiet belongs to the backlog
 *      and the tick measured it. A verdict still owed is a real debt -
 *      `dispatches.unreviewed` keeps reporting it - but it is not why the
 *      swarm is quiet, and naming it the cause sends an operator to review
 *      work that unblocks nothing. That is an unmeasured cause, and this
 *      repository has a skill about those.
 *   3. `waiting_for_review` - nothing running, the tick has not measured the
 *      backlog empty, and a finished dispatch with no verdict is the most
 *      direct fact left: a swarm that looks empty but owes a review is not
 *      idle, and the backlog is what an operator must act on.
 *   4. `unavailable` - with the swarm empty and nothing owed, quiet is only
 *      healthy if this page can say why; a disabled scheduler, an unreadable
 *      tick, or a tick that says it chose work while no dispatch is observable
 *      means nobody vouches for the present snapshot.
 *   5. `healthy_idle` - the scheduler is enabled, the table says the queue is
 *      empty, and the latest readable decision found no eligible candidate by
 *      any other refusal. That is health, not failure.
 */
function classifySwarmState(facts: {
  running: number
  unreviewed: number
  schedulerEnabled: boolean
  trustworthyTick: boolean
  refusal: string | null
  decisionFoundNoEligibleCandidate: boolean
}): SwarmState {
  if (facts.running > 0) return 'working'
  if (
    facts.schedulerEnabled &&
    facts.trustworthyTick &&
    facts.refusal === 'nothing to choose'
  )
    return 'healthy_idle'
  if (facts.unreviewed > 0) return 'waiting_for_review'
  if (
    !facts.schedulerEnabled ||
    !facts.trustworthyTick ||
    !facts.decisionFoundNoEligibleCandidate
  )
    return 'unavailable'
  return 'healthy_idle'
}

/**
 * Every value `queue.state` can carry.
 *
 * Closed like `swarmState` and the skip categories: a public consumer must be
 * able to rely on every value it will ever read. These are the four honest
 * answers to "why is a paid slot idle":
 *
 *   capacity-full     every configured slot is carrying a worker; there is
 *                     no idle slot left to explain
 *   work-dispatched   at least one slot is busy and at least one is free -
 *                     the queue supplied work this round
 *   no-eligible-work  every slot idle AND the latest decision explicitly
 *                     found no eligible candidate
 *   unknown           idle slots this page cannot account for: no readable
 *                     or recent-enough decision, no configured capacity, a
 *                     disabled scheduler, or a refusal this projection does
 *                     not interpret
 */
type QueueState =
  | 'capacity-full'
  | 'work-dispatched'
  | 'no-eligible-work'
  | 'unknown'

/**
 * How many tick intervals a decision stays trustworthy, measured from
 * `decided_at`.
 *
 * The tick timer guarantees a decision at least every interval while the loop
 * lives, so a decision older than two intervals means nobody has decided for a
 * whole extra period - the scheduler stopped, and the last thing it said must
 * not go on explaining a present it never saw. One missed interval is
 * tolerated because a round that runs long can straddle the timer.
 */
const TICK_STALENESS_INTERVALS = 2

/**
 * `decided_at` as milliseconds, or null when the row never carried a date
 * this process could read.
 *
 * Postgres returns a timestamptz as a Date and the test fixtures carry ISO
 * strings; both are read here so the projection judges the same age whichever
 * shape the row arrives in. Anything else - a corrupt value, a non-date -
 * vouches for nothing.
 */
function decidedAtMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/**
 * The one closed word for what the paid slots are doing, from facts this
 * endpoint already holds.
 *
 * No second scheduler and no second eligibility rule feeds this - only the
 * dispatch counts the page already reads, the capacity the deployment already
 * declares through `configuredWorkerCapacity` (the same single authority
 * `/queen/public-research` reads), and the last tick row the page already
 * publishes. The order is the contract, and it is the order of how directly
 * each fact speaks about the present:
 *
 *   1. `capacity-full` - the dispatch table says every configured slot is
 *      busy, now. A full hive outranks everything the older tick might say
 *      about skipped candidates, because the skip story explains a past round
 *      while the table describes this instant; a hive that filled up after a
 *      no-choice decision must not keep explaining its busy slots as an empty
 *      queue.
 *   2. `work-dispatched` - the table says work is in flight with room to
 *      spare. The queue is demonstrably supplying work; how many slots remain
 *      idle is a question about the round that has not happened yet.
 *   3. `no-eligible-work` - every slot idle, and only now is the tick
 *      consulted: it must be readable, recent (a decision older than two
 *      intervals explains a scheduler that stopped, not a queue that is
 *      empty), produced under an enabled scheduler, with capacity configured,
 *      and it must be THE explicit no-candidate decision - `allowed: false`
 *      with queend's closed `nothing to choose` refusal. Any other refusal -
 *      a spent budget, a capacity limit - is work the queue HAD and money or
 *      slots refused, which is not this state's to claim.
 *   4. `unknown` - everything else. Silence, staleness and unreadable
 *      evidence are never dressed up as an empty queue: an idle slot with no
 *      explanation is an operator's restart trigger, and this word exists so
 *      the trigger is pulled for a reason.
 */
function classifyQueueState(facts: {
  activeWorkers: number
  capacity: number
  schedulerEnabled: boolean
  tickDecidedAtMs: number | null
  tickRefusedNothingToChoose: boolean
  nowMs: number
  intervalSeconds: number
}): QueueState {
  if (facts.capacity > 0 && facts.activeWorkers >= facts.capacity) {
    return 'capacity-full'
  }
  if (facts.activeWorkers > 0) return 'work-dispatched'
  const freshWithinMs = facts.intervalSeconds * 1000 * TICK_STALENESS_INTERVALS
  const tickVouchesForEmptyQueue =
    facts.schedulerEnabled &&
    facts.capacity > 0 &&
    facts.tickDecidedAtMs != null &&
    facts.tickDecidedAtMs >= facts.nowMs - freshWithinMs &&
    facts.tickRefusedNothingToChoose
  return tickVouchesForEmptyQueue ? 'no-eligible-work' : 'unknown'
}

/**
 * The public queue projection: a closed state and when the evidence behind it
 * was observed, and not one byte more.
 *
 * `observedAt` dates the evidence, not the HTTP response: the tick's decision
 * time whenever the state rests on the tick row (`no-eligible-work`, and
 * `unknown` whose reason is a row that has gone quiet - its age is the
 * finding), and the read time whenever the dispatch table is the evidence
 * (`capacity-full`, `work-dispatched`) or nothing was ever recorded. A
 * dashboard can therefore trust that a non-`unknown` state is either live or
 * freshly decided, and measure exactly how stale an `unknown` is.
 */
function queueProjection(
  state: QueueState,
  tickDecidedAtMs: number | null,
  readAtMs: number,
): { state: QueueState; observedAt: string } {
  const restsOnTick =
    state === 'no-eligible-work' ||
    (state === 'unknown' && tickDecidedAtMs != null)
  return {
    state,
    observedAt: new Date(
      restsOnTick && tickDecidedAtMs != null ? tickDecidedAtMs : readAtMs,
    ).toISOString(),
  }
}

export function createQueenPublicStatusRoute(deps: QueenPublicStatusDeps = {}) {
  const databaseUrl = deps.databaseUrl ?? configuredDatabaseUrl
  const createPool =
    deps.createPool ??
    ((url: string) => new Pool({ connectionString: url }) as StatusPool)
  const tickIntervalSeconds =
    deps.tickIntervalSeconds ?? configuredTickIntervalSeconds
  const billingMode = deps.billingMode ?? configuredBillingMode
  const workerCapacity = deps.workerCapacity ?? configuredWorkerCapacity
  const now = deps.now ?? Date.now

  return new Hono().get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const url = databaseUrl()
    if (!url) return c.json({ error: 'Queen database is not configured' }, 503)

    const pool = createPool(url)
    try {
      const tick = await pool.query(
        `SELECT decided_at, decision
           FROM queen_tick
          WHERE name = $1`,
        ['queen-tick'],
      )
      const counts = await pool.query(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE finished_at IS NOT NULL) AS finished,
                count(*) FILTER (WHERE finished_at IS NULL) AS running,
                -- Finished but never judged. review_state's only writer is the
                -- Queen's own review (queen-tick.ts), so a NULL on a finished
                -- row is a verdict still owed - and running 0 with a verdict
                -- owed is a different swarm from running 0 with nothing owed,
                -- though both read identically without this column.
                count(*) FILTER (
                  WHERE finished_at IS NOT NULL AND review_state IS NULL
                ) AS unreviewed
           FROM queen_dispatch`,
      )
      const latest = await pool.query(
        `SELECT issue, dispatched_at, finished_at, outcome
           FROM queen_dispatch
          ORDER BY dispatched_at DESC
          LIMIT 1`,
      )

      const intervalSeconds = tickIntervalSeconds()
      const resolvedBillingMode = billingMode()
      const tickRow = tick.rowCount ? tick.rows[0] : null
      const rawDecision = tickRow?.decision
      const decision =
        rawDecision && typeof rawDecision === 'object'
          ? (rawDecision as Record<string, unknown>)
          : null
      const skipped = Array.isArray(decision?.skipped) ? decision.skipped : []
      const countRow = counts.rows[0] ?? {}
      const latestRow = latest.rowCount ? latest.rows[0] : null
      const schedulerEnabled = intervalSeconds > 0
      const readAtMs = now()
      const activeWorkers = asCount(countRow.running)
      const capacity = workerCapacity()
      const tickDecidedAtMs = decidedAtMs(tickRow?.decided_at)
      // Read once, quoted twice: `lastTick.refusal` and the swarmState
      // classification must be two readings of the same tick decision, or
      // the state could name a cause the tick never measured.
      const refusal =
        typeof decision?.refusal === 'string' ? decision.refusal : null

      return c.json({
        status: 'ok',
        swarmState: classifySwarmState({
          running: activeWorkers,
          unreviewed: asCount(countRow.unreviewed),
          schedulerEnabled,
          // A decision that is not a readable object cannot explain the
          // quiet, so it vouches for nothing - `lastTick` still reports the
          // row itself, exactly as it always has.
          trustworthyTick: decision != null,
          refusal,
          // There is a real window between recordTick(allowed: true) and
          // recordDispatch. Calling that empty snapshot healthy would conceal
          // a failed dispatch write. Only an explicit no-choice decision can
          // vouch for healthy idle; the completion-triggered refill writes one
          // after accepted work finishes.
          decisionFoundNoEligibleCandidate: decision?.allowed === false,
        }),
        // The queue reading of the same three rows. `running` is the active
        // worker count: a dispatch that never started is written already
        // finished, so an unfinished dispatch is a bee holding a paid slot.
        queue: queueProjection(
          classifyQueueState({
            activeWorkers,
            capacity,
            schedulerEnabled,
            tickDecidedAtMs,
            // queend writes this refusal from one closed template when its
            // chooser found no candidate (main.swift); any other refusal -
            // budget, capacity - is not this page's to reinterpret.
            tickRefusedNothingToChoose:
              decision?.allowed === false &&
              decision?.refusal === 'nothing to choose',
            nowMs: readAtMs,
            intervalSeconds,
          }),
          tickDecidedAtMs,
          readAtMs,
        ),
        scheduler: {
          enabled: schedulerEnabled,
          intervalSeconds,
          billingMode: resolvedBillingMode,
          estimatedUSDGateEnabled: resolvedBillingMode === 'api_metered',
        },
        lastTick: tickRow
          ? {
              decidedAt: tickRow.decided_at,
              allowed: decision?.allowed === true,
              refusal,
              skippedCount: skipped.length,
              skipSummary: summarizeSkips(skipped),
              // Reported, not assumed: an issues list cut by the cap is only
              // knowably truncated because the cap travels beside it.
              skipIssueListCap: SKIP_ISSUE_LIST_CAP,
            }
          : null,
        dispatches: {
          total: asCount(countRow.total),
          finished: asCount(countRow.finished),
          running: asCount(countRow.running),
          unreviewed: asCount(countRow.unreviewed),
          latest: latestRow
            ? {
                issue: asCount(latestRow.issue),
                dispatchedAt: latestRow.dispatched_at,
                finishedAt: latestRow.finished_at ?? null,
                outcome:
                  typeof latestRow.outcome === 'string'
                    ? latestRow.outcome
                    : null,
              }
            : null,
        },
      })
    } catch (error) {
      logger.warn('Queen public status query failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Queen status is unavailable' }, 503)
    } finally {
      await pool.end()
    }
  })
}
