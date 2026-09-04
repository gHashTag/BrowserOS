/**
 * The escalations that ask for a person, served where a person can read them.
 *
 * THE DEFECT THIS CLOSES. `queen-tick.ts` composes a report at the end of every
 * round and stores it with a `needs_you` boolean and a headline that literally
 * reads "N waiting on you". Until this route, `git grep -l queen_report` over
 * the whole server returned exactly two files: the tick that writes it and the
 * migration that declares the table. The message was composed, stored, and
 * addressed to nobody.
 *
 * Measured 2026-09-04: six dispatches in `escalate`, the oldest 3.7 days, with
 * reasons that were genuinely useful - three said the task had no acceptance
 * criteria, so there was nothing to judge it against. The system knew precisely
 * what was wrong with each and told no one.
 *
 * A SECOND DEFECT, IN THE SAME INSERT. Of the 40 most recent reports, ZERO had
 * `needs_you = true` while six escalations were outstanding, because the flag
 * was computed from the escalations raised in THAT round rather than from those
 * still unresolved. The one boolean whose whole job is to say "a person is
 * needed" was false whenever the need was not brand new. `outstandingEscalations`
 * below is what the flag should have been asking, and the tick now asks it.
 *
 * WHAT THIS IS NOT. It does not resolve, retry or alter an escalation.
 * `sendBack` and `wait` are released by a clock because their input can never
 * change; an escalation means a PERSON is needed and no timer is a person. This
 * route surfaces; it does not act.
 *
 * WHAT IT WILL NOT SAY. No issue body, no transcript, no path, no branch, no
 * connection detail. An issue number, a state, an age and the recorded reason
 * are the whole payload - this is served to a browser, and an escalation reason
 * is written by a worker, so it is truncated rather than trusted for length.
 */

import { Hono } from 'hono'
import { Pool } from 'pg'
import { logger } from '../../lib/logger'

interface QueryResult {
  rowCount: number | null
  rows: Array<Record<string, unknown>>
}

interface NeedsYouPool {
  query(sql: string, values?: unknown[]): Promise<QueryResult>
  end(): Promise<void>
}

export interface QueenNeedsYouDeps {
  databaseUrl?: () => string | undefined
  createPool?: (url: string) => NeedsYouPool
  now?: () => Date
}

/** The public sentence, identical for every failure, exactly as the siblings do. */
const UNAVAILABLE = 'Queen escalations are unavailable'

/** A worker writes these; a browser reads them. Bound the length here. */
const REASON_MAX = 400
const REPORT_LIMIT = 20

/**
 * The age of a verdict, measured from a field NOTHING rewrites.
 *
 * `reviewed_at` is refreshed on every round for any row the review sweep
 * re-reads, which is how a six-hour floor elsewhere in this service could never
 * be reached (#109). `finished_at` is written once, when the bee stops.
 */
const ESCALATIONS_SQL = `
  SELECT d.issue,
         d.review_note,
         d.send_backs,
         EXTRACT(EPOCH FROM (now() - d.finished_at)) / 3600 AS age_hours
    FROM queen_dispatch d
   WHERE d.review_state = 'escalate'
     AND d.finished_at IS NOT NULL
   ORDER BY d.finished_at ASC`

const REPORTS_SQL = `
  SELECT id, at, headline, needs_you
    FROM queen_report
   ORDER BY at DESC
   LIMIT ${REPORT_LIMIT}`

export function createQueenNeedsYouRoute(deps: QueenNeedsYouDeps = {}) {
  const databaseUrl =
    deps.databaseUrl ??
    (() => process.env.QUEEN_LEASE_DATABASE_URL ?? process.env.DATABASE_URL)
  const createPool =
    deps.createPool ??
    ((url: string) =>
      new Pool({ connectionString: url }) as unknown as NeedsYouPool)

  return new Hono().get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const url = databaseUrl()
    if (!url) return c.json({ error: UNAVAILABLE }, 503)

    let pool: NeedsYouPool | null = null
    try {
      pool = createPool(url)
      const [escalations, reports] = await Promise.all([
        pool.query(ESCALATIONS_SQL),
        pool.query(REPORTS_SQL),
      ])

      const waiting = escalations.rows.map((row) => ({
        issue: Number(row.issue),
        attempts: Number(row.send_backs ?? 0),
        hoursWaiting: Math.round(Number(row.age_hours ?? 0) * 10) / 10,
        // A reason the worker never recorded is reported as absent rather than
        // as an empty string: "no reason was recorded" and "the reason is
        // blank" are different facts and a reader should not have to guess.
        reason: row.review_note
          ? String(row.review_note).slice(0, REASON_MAX)
          : null,
      }))

      return c.json({
        // Always present, even when empty. An omitted field reads as an error
        // to a page that expected it, and the empty state is the one a healthy
        // swarm is in most of the time.
        waiting,
        waitingCount: waiting.length,
        oldestHours: waiting.length ? waiting[0].hoursWaiting : 0,
        needsYou: waiting.length > 0,
        reports: reports.rows.map((row) => ({
          at: row.at,
          headline: String(row.headline ?? '').slice(0, 200),
          needsYou: Boolean(row.needs_you),
        })),
      })
    } catch (error) {
      // The real error goes to the log and nowhere else. A sibling route once
      // returned `getaddrinfo ENOTFOUND queen-postgres.railway.internal` to any
      // browser on any origin, because it had a `finally` and no `catch`.
      logger.warn('Queen escalation view is unavailable', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: UNAVAILABLE }, 503)
    } finally {
      if (pool) await pool.end().catch(() => undefined)
    }
  })
}

/**
 * Whether a person is needed RIGHT NOW, rather than whether one was newly
 * needed this round.
 *
 * Exported so the tick can ask the same question the route answers, and so the
 * two cannot drift into disagreeing about what "waiting on you" means.
 */
export async function outstandingEscalations(pool: {
  query(sql: string, values?: unknown[]): Promise<QueryResult>
}): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM queen_dispatch WHERE review_state = 'escalate'`,
  )
  return Number(result.rows[0]?.n ?? 0)
}
