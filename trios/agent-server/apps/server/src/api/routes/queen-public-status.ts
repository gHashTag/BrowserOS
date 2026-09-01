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
 * and is wrong to publish - so only the category counts leave this file, and
 * the category set is closed, which keeps the projection bounded however many
 * candidates a round passed over.
 */

import { Hono } from 'hono'
import { Pool } from 'pg'
import { logger } from '../../lib/logger'

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
}

function configuredDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || undefined
}

function configuredTickIntervalSeconds(): number {
  const raw = Number(process.env.TRIOS_QUEEN_TICK_SECONDS ?? '0')
  return Number.isFinite(raw) && raw > 0 ? raw : 0
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
 * One stored skip reason, filed under a category.
 *
 * The reasons are `queend`'s sentences (queen-core/Sources/queend/main.swift)
 * and the matchers pin their stable wording, never their payloads: a reason
 * names its issue, its paths and its holders after that wording, and none of
 * it is echoed here. ` held by ` is matched first because it is the only
 * reason whose free text - file paths - could contain one of the shorter
 * markers; the fixed-template reasons cannot contain a path.
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
 * Only non-zero categories appear, in the fixed order above, so two reads of
 * the same tick serialize identically and the object never grows past the
 * closed category set. Every entry is filed exactly once - unrecognized
 * sentences under `other` rather than dropped - so the counts always sum to
 * `skippedCount`. An absent skip array summarises to `{}`: an older tick
 * stays a valid response, just with nothing to say.
 */
function summarizeSkips(
  skipped: unknown[],
): Partial<Record<SkipCategory, number>> {
  const counts = new Map<SkipCategory, number>()
  for (const entry of skipped) {
    // jsonb holds whatever was put in it; a non-string reason is counted,
    // never trusted to carry meaning.
    const line = typeof entry === 'string' ? entry : String(entry)
    const category = classifySkipReason(line)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  const summary: Partial<Record<SkipCategory, number>> = {}
  for (const category of SKIP_CATEGORIES) {
    const count = counts.get(category)
    if (count) summary[category] = count
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
 *   waiting_for_review  nothing running, but a finished dispatch still has no
 *                       verdict - the Queen has not judged her bee
 *   healthy_idle        nothing running, nothing owed, the scheduler enabled
 *                       and a readable tick explaining the quiet: the latest
 *                       round found no eligible candidate, or its choice has
 *                       since finished and been judged
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
 * The one closed word for what the swarm is, from aggregate facts alone.
 *
 * Nothing but the counts, the scheduler interval and the presence of a
 * readable tick decision feeds it - never a stored sentence, never a skip
 * reason. The order below is the contract, and it is the order of how
 * directly each fact speaks about the present:
 *
 *   1. `working` - an unfinished dispatch is observable now; a disabled
 *      scheduler or a missing tick says nothing against work the table
 *      itself vouches for.
 *   2. `waiting_for_review` - a finished dispatch with no verdict outranks
 *      the idle reading: a swarm that looks empty but owes a review is not
 *      idle, and the backlog is what an operator must act on.
 *   3. `unavailable` - with the swarm empty and nothing owed, quiet is only
 *      healthy if this page can say why; a disabled scheduler or a tick
 *      whose decision cannot be read means nobody vouches for the queue.
 *   4. `healthy_idle` - the scheduler is enabled, a tick decision is
 *      readable, and the table says the queue is empty: the round started
 *      nothing because nothing was eligible (or its choice already
 *      completed its cycle), which is health, not failure.
 */
function classifySwarmState(facts: {
  running: number
  unreviewed: number
  schedulerEnabled: boolean
  trustworthyTick: boolean
}): SwarmState {
  if (facts.running > 0) return 'working'
  if (facts.unreviewed > 0) return 'waiting_for_review'
  if (!facts.schedulerEnabled || !facts.trustworthyTick) return 'unavailable'
  return 'healthy_idle'
}

export function createQueenPublicStatusRoute(deps: QueenPublicStatusDeps = {}) {
  const databaseUrl = deps.databaseUrl ?? configuredDatabaseUrl
  const createPool =
    deps.createPool ??
    ((url: string) => new Pool({ connectionString: url }) as StatusPool)
  const tickIntervalSeconds =
    deps.tickIntervalSeconds ?? configuredTickIntervalSeconds

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
        }),
        scheduler: {
          enabled: schedulerEnabled,
          intervalSeconds,
        },
        lastTick: tickRow
          ? {
              decidedAt: tickRow.decided_at,
              allowed: decision?.allowed === true,
              refusal:
                typeof decision?.refusal === 'string' ? decision.refusal : null,
              skippedCount: skipped.length,
              skipSummary: summarizeSkips(skipped),
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
