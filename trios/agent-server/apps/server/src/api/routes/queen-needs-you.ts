/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The reader for a message that was written to nobody.
 *
 * queen-tick composes a report at the end of every round and stores it in
 * queen_report - a headline that can literally read "N waiting on you" - and
 * until this file no route served that table. The message was composed, stored,
 * and addressed to nobody: on 2026-09-04 six dispatches sat in `escalate`, the
 * oldest for 3.7 days, each with a recorded reason the system knew precisely,
 * and the only trace was a row nobody read.
 *
 * WHAT LEAVES HERE. An issue number, a state, an age, and the recorded reason
 * are the whole escalation payload, plus the report headlines with their
 * needs_you flag and time. Not the report bodies: they name stray file paths
 * and holder issues, which is what an operator needs behind the dashboard and
 * is wrong to publish - the same line every sibling public route draws. No
 * transcripts, no issue bodies, no conversation ids, no tokens, no connection
 * details, ever.
 *
 * WHAT THIS ROUTE DOES NOT DO. It does not resolve, retry or alter anything.
 * `sendBack` and `wait` were released by a clock because their input can never
 * change; an escalation means a PERSON is needed, and no timer is a person.
 * This route surfaces; it does not act.
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

interface QueenNeedsYouDeps {
  databaseUrl?: () => string | undefined
  createPool?: (url: string) => NeedsYouPool
  /** Injectable clock, so ages are asserted against a fixed instant. */
  now?: () => number
}

function configuredDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || undefined
}

/**
 * How many reports one answer carries when the caller states no preference.
 *
 * The limit is stated in the response, not only applied to the query, because
 * "the most recent reports" is a claim about truncation as much as about
 * order: a consumer that cannot see the limit cannot know the list ended by
 * design rather than by exhaustion.
 */
export const DEFAULT_REPORT_LIMIT = 20

/** The ceiling for a caller-supplied limit, so one query cannot ask for all. */
export const MAX_REPORT_LIMIT = 100

const DAY_MS = 24 * 60 * 60 * 1000

const asIssue = (value: unknown): number | null => {
  const issue = Number(value)
  return Number.isInteger(issue) && issue > 0 ? issue : null
}

/**
 * Days waited, to one decimal, never negative.
 *
 * Negative would mean the row's clock is ahead of ours - a skew, not a wait -
 * and publishing "waited -0.2 days" would dress a clock problem up as news.
 * A row with no readable moment at all waits an unknown time, which is null
 * and not zero: unknown is not nothing.
 */
function waitedDays(since: unknown, now: number): number | null {
  const at = Date.parse(String(since ?? ''))
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.round(((now - at) / DAY_MS) * 10) / 10)
}

/** The moment as ISO text, or the raw value when it is not a date we know. */
function asIso(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  return value
}

export function createQueenNeedsYouRoute(deps: QueenNeedsYouDeps = {}) {
  const databaseUrl = deps.databaseUrl ?? configuredDatabaseUrl
  const createPool =
    deps.createPool ??
    ((url: string) => new Pool({ connectionString: url }) as NeedsYouPool)
  const now = deps.now ?? Date.now

  return new Hono().get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const url = databaseUrl()
    if (!url) return c.json({ error: 'Queen database is not configured' }, 503)

    const requested = Number(c.req.query('limit'))
    const limit = Number.isFinite(requested)
      ? Math.min(MAX_REPORT_LIMIT, Math.max(1, Math.floor(requested)))
      : DEFAULT_REPORT_LIMIT

    const pool = createPool(url)
    try {
      // Newest first is the database's job and stays there; this route does
      // not re-sort what it is handed, so a bad ORDER BY reads as a bad
      // answer rather than being quietly repaired into a good one.
      const reports = await pool.query(
        `SELECT at, headline, needs_you
           FROM queen_report
          ORDER BY at DESC
          LIMIT $1`,
        [limit],
      )
      // Every outstanding escalation, oldest first, with no cutoff: these are
      // the items a person is owed, and an age window here would be this
      // route deciding an escalation stops mattering - which is resolving it
      // by another name.
      const escalated = await pool.query(
        `SELECT issue, review_state, review_note,
               coalesce(reviewed_at, finished_at) AS since
           FROM queen_dispatch
          WHERE review_state = 'escalate'
          ORDER BY since ASC NULLS LAST`,
      )

      const current = now()
      const items = escalated.rows.map((row) => ({
        issue: asIssue(row.issue),
        state: String(row.review_state ?? ''),
        since: asIso(row.since),
        waitedDays: waitedDays(row.since, current),
        reason: typeof row.review_note === 'string' ? row.review_note : null,
      }))

      return c.json({
        status: 'ok',
        reports: {
          limit,
          returned: reports.rows.length,
          items: reports.rows.map((row) => ({
            at: asIso(row.at),
            headline:
              typeof row.headline === 'string'
                ? row.headline
                : String(row.headline ?? ''),
            needsYou: row.needs_you === true,
          })),
        },
        // Explicit at every edge: an empty swarm answers count 0, an empty
        // array, and a null oldest wait - never an omitted field, because a
        // consumer cannot tell "none" from "not checked" from an absence.
        escalations: {
          count: items.length,
          oldestWaitedDays: items.length > 0 ? items[0].waitedDays : null,
          items,
        },
      })
    } catch (error) {
      logger.warn('Queen needs-you query failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      // A fixed sentence, exactly like the sibling public routes: the real
      // error names hosts and connection detail that belongs in the log and
      // nowhere near a response body.
      return c.json({ error: 'Queen needs-you is unavailable' }, 503)
    } finally {
      await pool.end()
    }
  })
}
