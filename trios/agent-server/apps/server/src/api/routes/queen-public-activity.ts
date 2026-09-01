/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Sanitized, read-only activity for the public Queen control room.
 *
 * The authenticated feed exposes transcript text, tool inputs, branches and
 * conversation ids. None of those belong on t27.ai. This projection returns
 * only the event class, issue, public title and time, which is enough to show
 * that a Bee is moving without exposing how or where it is working.
 *
 * Retention: a verbose Bee can emit well over 120 tool/progress rows and push
 * its own `finished` or the Queen's `review` fact out of a plain newest-120
 * window, which makes the dashboard look permanently busy or never reviewed.
 * The single bounded query therefore ranks terminal lifecycle events
 * (`finished`, `review`) ahead of `progress`/`tool`/`result`/`usage`/`error`
 * rows before applying `LIMIT 120`, then re-sorts the retained rows so the
 * response stays newest-first. The query stays bounded; no transcript is
 * pulled into application memory.
 */

import { Hono } from 'hono'
import { Pool } from 'pg'
import { logger } from '../../lib/logger'

interface QueryResult {
  rowCount: number | null
  rows: Array<Record<string, unknown>>
}

interface ActivityPool {
  query(sql: string, values?: unknown[]): Promise<QueryResult>
  end(): Promise<void>
}

interface QueenPublicActivityDeps {
  databaseUrl?: () => string | undefined
  createPool?: (url: string) => ActivityPool
  now?: () => number
}

function configuredDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || undefined
}

const PUBLIC_KINDS = new Set([
  'dispatch',
  'progress',
  'tool',
  'result',
  'usage',
  'error',
  'finished',
  'review',
])

function publicKind(value: unknown): string {
  const kind = String(value ?? 'progress')
  return PUBLIC_KINDS.has(kind) ? kind : 'progress'
}

function asIssue(value: unknown): number | null {
  const issue = Number(value)
  return Number.isInteger(issue) && issue > 0 ? issue : null
}

export function createQueenPublicActivityRoute(
  deps: QueenPublicActivityDeps = {},
) {
  const databaseUrl = deps.databaseUrl ?? configuredDatabaseUrl
  const createPool =
    deps.createPool ??
    ((url: string) => new Pool({ connectionString: url }) as ActivityPool)
  const now = deps.now ?? Date.now

  return new Hono().get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const url = databaseUrl()
    if (!url) return c.json({ error: 'Queen database is not configured' }, 503)

    const current = now()
    const requested = Number(c.req.query('since'))
    const since = Number.isFinite(requested)
      ? Math.max(current - 86_400_000, Math.min(requested, current))
      : current - 900_000
    const pool = createPool(url)

    try {
      const result = await pool.query(
        `WITH public_events AS (
           SELECT 'dispatch'::text AS kind, d.issue, i.title,
                  d.dispatched_at AS at, NULL::text AS state, 0::int AS seq
             FROM queen_dispatch d
             LEFT JOIN queen_issues i ON i.number = d.issue
            WHERE d.dispatched_at >= to_timestamp($1 / 1000.0)
           UNION ALL
           SELECT CASE WHEN t.kind IN ('tool', 'result', 'usage', 'error')
                       THEN t.kind ELSE 'progress' END,
                  t.issue, i.title, t.at, NULL::text, t.seq
             FROM queen_transcript t
             LEFT JOIN queen_issues i ON i.number = t.issue
            WHERE t.at >= to_timestamp($1 / 1000.0)
           UNION ALL
           SELECT 'finished', d.issue, i.title, d.finished_at, d.outcome, 0
             FROM queen_dispatch d
             LEFT JOIN queen_issues i ON i.number = d.issue
            WHERE d.finished_at >= to_timestamp($1 / 1000.0)
           UNION ALL
           SELECT 'review', d.issue, i.title, d.reviewed_at, d.review_state, 0
             FROM queen_dispatch d
             LEFT JOIN queen_issues i ON i.number = d.issue
            WHERE d.reviewed_at >= to_timestamp($1 / 1000.0)
          ),
          prioritized AS (
            SELECT kind, issue, title, at, state, seq,
                   CASE WHEN kind IN ('finished', 'review')
                        THEN 0 ELSE 1 END AS priority
              FROM public_events
          ),
          bounded AS (
            SELECT kind, issue, title, at, state, seq
              FROM prioritized
             ORDER BY priority ASC, at DESC, seq DESC
             LIMIT 120
          )
          SELECT kind, issue, title, at, state, seq
            FROM bounded
           ORDER BY at DESC, seq DESC`,
        [since],
      )

      return c.json({
        cursor: current,
        // The query is already bounded by LIMIT 120; the slice keeps the
        // endpoint's at-most-120 contract true even if that bound regresses.
        events: result.rows.slice(0, 120).map((row) => {
          const issue = asIssue(row.issue)
          const at = new Date(String(row.at)).toISOString()
          const kind = publicKind(row.kind)
          const seq = Number(row.seq) || 0
          return {
            id: `${kind}-${issue ?? 0}-${Date.parse(at)}-${seq}`,
            kind,
            issue,
            title:
              typeof row.title === 'string'
                ? row.title.slice(0, 240)
                : issue
                  ? `Issue #${issue}`
                  : 'Queen activity',
            at,
            state:
              typeof row.state === 'string' ? row.state.slice(0, 80) : null,
          }
        }),
      })
    } catch (error) {
      logger.warn('Queen public activity query failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Queen activity is unavailable' }, 503)
    } finally {
      await pool.end()
    }
  })
}
