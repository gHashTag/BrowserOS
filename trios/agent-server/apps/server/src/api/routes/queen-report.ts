/**
 * A door for watchers outside the Queen to write into her report.
 *
 * WHY. Until this route the only writer of `queen_report` was her own tick
 * (`queen-tick.ts`, the INSERT at the end of a round). A watcher that runs
 * elsewhere - the first is a Railway cron in 999-multibots-telegraf that probes
 * the bot-to-render relay roads every hour - had nowhere to put a finding the
 * owner would see. The owner already reads `/queen/needs-you` and her report
 * lines, so a finding belongs in the same table, not in a new one.
 *
 * NO MIGRATION. The source is stored as a `[source] ` prefix on the headline.
 * `queen_report` has no column for it, the panel already shows the headline,
 * and a prefix is enough to tell "the Queen said" from "the relay watch said".
 *
 * AUTH IS NOT HERE. This file is mounted inside a sub-app that carries
 * `requireTrustedAppOrigin()` (see server.ts), exactly like `/queen/needs-you`
 * and `/queen/lease`. In production that means `Authorization: Bearer
 * <TRIOS_API_TOKEN>`.
 *
 * WHAT IT WILL NOT SAY. A database failure answers one fixed sentence; the real
 * error goes to the log. A sibling once returned a Railway internal hostname to
 * any browser on any origin.
 */

import { Hono } from 'hono'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'

interface QueryResult {
  rowCount: number | null
  rows: Array<Record<string, unknown>>
}

interface ReportPool {
  query(sql: string, values?: unknown[]): Promise<QueryResult>
  end(): Promise<void>
}

export interface QueenReportDeps {
  databaseUrl?: () => string | undefined
  createPool?: (url: string) => ReportPool
  now?: () => number
}

export interface QueenReportInput {
  source: string
  headline: string
  body: string
  needs_you: boolean
}

const UNAVAILABLE = 'Queen report is unavailable'

export const SOURCE_PATTERN = /^[a-z0-9-]{1,64}$/
export const HEADLINE_MAX = 200
export const BODY_MAX = 8000
export const REPORTS_PER_SOURCE_PER_HOUR = 60
const HOUR_MS = 60 * 60 * 1000

const FIELDS = ['source', 'headline', 'body', 'needs_you'] as const

// Closes with the backtick alone on its own line: the house convention that
// `tests/api/sql-template-literals.test.ts` reads.
const INSERT_SQL = `
  INSERT INTO queen_report (headline, body, needs_you)
  VALUES ($1, $2, $3)
  RETURNING id
`

/**
 * The body, or the reason it is refused. Exactly the four fields, each of its
 * own type and length; anything else is a 400. An unknown field is refused
 * rather than ignored so a client that misspells `needs_you` hears about it
 * instead of silently writing `false`.
 */
export function parseReport(
  raw: unknown,
): { ok: true; value: QueenReportInput } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const record = raw as Record<string, unknown>
  const extra = Object.keys(record).filter(
    (key) => !(FIELDS as readonly string[]).includes(key),
  )
  if (extra.length > 0) {
    return { ok: false, error: `unknown field: ${extra[0].slice(0, 32)}` }
  }
  const { source, headline, body, needs_you } = record
  if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) {
    return { ok: false, error: 'source must match [a-z0-9-]{1,64}' }
  }
  if (
    typeof headline !== 'string' ||
    headline.trim().length === 0 ||
    headline.length > HEADLINE_MAX
  ) {
    return { ok: false, error: `headline must be 1..${HEADLINE_MAX} chars` }
  }
  if (typeof body !== 'string' || body.length > BODY_MAX) {
    return { ok: false, error: `body must be 0..${BODY_MAX} chars` }
  }
  if (typeof needs_you !== 'boolean') {
    return { ok: false, error: 'needs_you must be a boolean' }
  }
  return { ok: true, value: { source, headline, body, needs_you } }
}

/**
 * At most `limit` reports per source in any sliding hour, in memory.
 *
 * In memory on purpose: one process serves this route, a restart forgets the
 * window, and the worst a restart buys is one extra hour of a watcher that
 * already holds the deployment token.
 */
export function createSourceLimiter(
  limit = REPORTS_PER_SOURCE_PER_HOUR,
  windowMs = HOUR_MS,
) {
  const seen = new Map<string, number[]>()
  return {
    /** Records the attempt and returns true, or returns false when full. */
    take(source: string, at: number): boolean {
      const recent = (seen.get(source) ?? []).filter((t) => at - t < windowMs)
      if (recent.length >= limit) {
        seen.set(source, recent)
        return false
      }
      recent.push(at)
      seen.set(source, recent)
      return true
    },
  }
}

export function createQueenReportRoute(deps: QueenReportDeps = {}) {
  const databaseUrl =
    deps.databaseUrl ??
    (() => process.env.QUEEN_LEASE_DATABASE_URL ?? process.env.DATABASE_URL)
  const createPool =
    deps.createPool ??
    ((url: string) => createQueenPool(url) as unknown as ReportPool)
  const now = deps.now ?? (() => Date.now())
  const limiter = createSourceLimiter()

  return new Hono().post('/', async (c) => {
    c.header('Cache-Control', 'no-store')

    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'body must be a JSON object' }, 400)
    }
    const parsed = parseReport(raw)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const report = parsed.value

    if (!limiter.take(report.source, now())) {
      c.header('Retry-After', '3600')
      return c.json({ error: 'Too many reports from this source' }, 429)
    }

    const url = databaseUrl()
    if (!url) return c.json({ error: UNAVAILABLE }, 503)

    let pool: ReportPool | null = null
    try {
      pool = createPool(url)
      const result = await pool.query(INSERT_SQL, [
        `[${report.source}] ${report.headline}`,
        report.body,
        report.needs_you,
      ])
      const id = Number(result.rows[0]?.id)
      return c.json({ id }, 201)
    } catch (error) {
      logger.warn('Queen report could not be stored', {
        source: report.source,
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: UNAVAILABLE }, 503)
    } finally {
      if (pool) await pool.end().catch(() => undefined)
    }
  })
}
