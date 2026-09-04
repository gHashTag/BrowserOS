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
 * The other half of `running: 0` is HOW BIG the swarm is at all, and `workers`
 * answers it: no capacity configured, capacity all idle, or telemetry that
 * says nothing. Its capacity comes from the same `configuredWorkerCapacity`
 * authority `/queen/public-research` reads - one count of the provider
 * environment, never a second parser of it - so the two public pages cannot
 * tell two different stories about how many paid slots exist. Four numbers
 * leave and nothing else: the count's source is the credential environment,
 * and a provider's name, an environment-variable name or a key value has no
 * business on a public page when the count alone says whether capacity is
 * idle.
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
  workerCapacity?: () => number
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
 * The paid worker-slot reading of `dispatches.running`.
 *
 * `running` counts every unfinished dispatch; `active` counts only the ones
 * that actually started - `started = true` and `finished_at IS NULL` - because
 * a dispatch that never got a turn holds no paid slot. Capacity is read
 * through the same `configuredWorkerCapacity` authority `/queen/public-research`
 * uses, never a second parser of the provider environment, so the two public
 * pages can never disagree about how many slots exist.
 *
 * The clamp is total because a count can only arrive wrong: a non-numeric
 * string, a negative, a float, the same row counted twice. Active above
 * capacity would promise slots the swarm does not have and a negative idle
 * would read as over-subscription, so every malformed value folds into the
 * closed range `0 <= active <= capacity` with `idle = capacity - active` and
 * an integer percentage from 0 through 100.
 */
function workerProjection(
  capacity: number,
  startedUnfinished: number,
): {
  capacity: number
  active: number
  idle: number
  utilization: number
} {
  const safeCapacity =
    Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 0
  const active = Math.min(
    safeCapacity,
    Math.floor(
      Number.isFinite(startedUnfinished) && startedUnfinished > 0
        ? startedUnfinished
        : 0,
    ),
  )
  return {
    capacity: safeCapacity,
    active,
    idle: safeCapacity - active,
    utilization:
      safeCapacity > 0 ? Math.round((active / safeCapacity) * 100) : 0,
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
                ) AS unreviewed,
                -- A paid slot is spent only by a dispatch that actually started
                -- and has not finished. running counts dispatches that never
                -- got a turn too, and those spend nothing, so workers.active
                -- is counted here rather than derived from running.
                count(*) FILTER (
                  WHERE started = true AND finished_at IS NULL
                ) AS started_running
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
      // Read once, quoted twice: `lastTick.refusal` and the swarmState
      // classification must be two readings of the same tick decision, or
      // the state could name a cause the tick never measured.
      const refusal =
        typeof decision?.refusal === 'string' ? decision.refusal : null

      return c.json({
        status: 'ok',
        swarmState: classifySwarmState({
          running: asCount(countRow.running),
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
        workers: workerProjection(
          workerCapacity(),
          asCount(countRow.started_running),
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
