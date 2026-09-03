/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Public, credential-free heartbeat-silence projection for registered A2A agents.
 *
 * On 2026-05-24 the trios-agent went silent for 330 seconds and nothing noticed
 * until a person looked at a menu bar and clicked reconnect. The registry had
 * every fact needed to say so itself - each registered agent carries the time
 * of its last heartbeat - but no reader ever turned that into a number. This
 * route is that reader: one credential-free GET that says, per registered
 * agent, when it last beat and how many seconds of silence have passed since.
 *
 * The reconnect half of the fix lives in the Swift client; this half lives
 * here so the dashboard and the alert can read one number instead of a person
 * watching a menu bar.
 *
 * Sanitization is the same contract as the other /queen/public-* projections.
 * The registry rows carry a name (free text - "Queen Autonomous Test", a
 * person's machine), capabilities, a metadata blob with an endpoint (a host),
 * and whatever a registration put in metadata. None of it leaves this file.
 * Each agent is projected to exactly four fields:
 *
 *   id              the agent id, the key the client registers under
 *   kind            one closed word derived from that same id, so the
 *                   dashboard can group without a name
 *   lastHeartbeatAt the last heartbeat, ISO 8601
 *   silentSeconds   integer seconds since that heartbeat, floored, never
 *                   negative
 *
 * `kind` is derived from the id because the id is already public here, so the
 * classification discloses nothing new, while a closed set keeps the
 * projection bounded however agents name themselves.
 */

import { Hono } from 'hono'
import { Pool } from 'pg'
import { logger } from '../../lib/logger'

interface QueryResult {
  rowCount: number | null
  rows: Array<Record<string, unknown>>
}

interface AgentsPool {
  query(sql: string, values?: unknown[]): Promise<QueryResult>
  end(): Promise<void>
}

interface QueenPublicAgentsDeps {
  databaseUrl?: () => string | undefined
  createPool?: (url: string) => AgentsPool
  now?: () => number
}

function configuredDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || undefined
}

/**
 * Every value `kind` can carry.
 *
 * Closed on purpose, like the skip categories and swarm states in the other
 * public projections: an open vocabulary is not a contract a public consumer
 * can rely on, and a free-text kind would just be the agent name wearing a
 * new key. The words classify by who runs the agent, derived only from the
 * id this response already publishes:
 *
 *   trios     the macOS chat app agent (`trios-agent`), the one the
 *             2026-05-24 alert was about
 *   queen     supervisor-side agents, including the autonomous test ones
 *   worker    swarm bees and worker agents
 *   external  anything the swarm does not recognize - reported, not hidden,
 *             because an unknown agent that has gone silent is still silence
 *             worth a number
 */
const AGENT_KINDS = ['trios', 'queen', 'worker', 'external'] as const

type AgentKind = (typeof AGENT_KINDS)[number]

function agentKind(id: string): AgentKind {
  const lowered = id.toLowerCase()
  if (lowered.startsWith('trios')) return 'trios'
  if (lowered.startsWith('queen')) return 'queen'
  if (lowered.startsWith('bee') || lowered.startsWith('worker')) {
    return 'worker'
  }
  return 'external'
}

/**
 * A heartbeat time, as pg hands it over: a Date for TIMESTAMPTZ, an ISO
 * string from a hand-run query, or epoch milliseconds.
 *
 * A row whose heartbeat is missing or unparseable cannot answer either half
 * of this route's question - when, and how long since - so it yields null
 * and the caller drops it. The schema defaults the column to NOW(), so in
 * practice every registered agent has one; this guard is for the registry
 * that has not been ensured yet, not for a state the writer can produce.
 */
function heartbeatTime(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/**
 * The four public fields for one registry row, or nothing.
 *
 * Built by explicit assignment, never by spreading the row: a spread would
 * carry every column the query happens to select (and anything added to the
 * table later) straight into a public response. FR-002 is enforced by the
 * shape of this function, not by the SELECT list above it.
 */
function projectAgent(
  row: Record<string, unknown>,
  referenceMs: number,
): {
  id: string
  kind: AgentKind
  lastHeartbeatAt: string
  silentSeconds: number
} | null {
  if (typeof row.id !== 'string' || row.id.length === 0) return null
  const heartbeatMs = heartbeatTime(row.last_heartbeat)
  if (heartbeatMs === null) return null
  return {
    id: row.id,
    kind: agentKind(row.id),
    lastHeartbeatAt: new Date(heartbeatMs).toISOString(),
    // Floored, never rounded: 330.9 seconds of silence is reported as 330,
    // so the number never overstates the outage. A heartbeat that arrived
    // after the reference clock (query latency or clock skew) reads as 0,
    // not negative - a fresh agent is silent for zero seconds, not minus
    // some.
    silentSeconds: Math.max(0, Math.floor((referenceMs - heartbeatMs) / 1000)),
  }
}

export function createQueenPublicAgentsRoute(deps: QueenPublicAgentsDeps = {}) {
  const databaseUrl = deps.databaseUrl ?? configuredDatabaseUrl
  const createPool =
    deps.createPool ??
    ((url: string) => new Pool({ connectionString: url }) as AgentsPool)
  const now = deps.now ?? Date.now

  return new Hono().get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const url = databaseUrl()
    if (!url) return c.json({ error: 'Queen database is not configured' }, 503)

    const pool = createPool(url)
    try {
      // Every registered agent, offline ones included: an agent the watchdog
      // has marked offline is exactly the agent whose silence this page
      // exists to measure, so filtering by status here would hide the rows
      // the alert most needs. Ordering is re-done in JavaScript below, where
      // silence is known; the SQL order only keeps page contents stable.
      const result = await pool.query(
        `SELECT id, last_heartbeat
           FROM agents
          ORDER BY last_heartbeat DESC`,
      )

      // One clock for the whole projection: taken after the rows arrive, so
      // every silentSeconds in the response is measured against the same
      // instant and the total ordering is consistent. Each number absorbs at
      // most the request's own latency, which is the tolerance the
      // projection promises.
      const reference = now()
      const agents = result.rows
        .flatMap((row) => {
          const projected = projectAgent(row, reference)
          return projected ? [projected] : []
        })
        // Longest silence first: the number an alert reads is the first
        // entry, and the agent most overdue for a heartbeat leads the page.
        // The id tiebreak keeps the order deterministic for agents that
        // share a heartbeat instant.
        .sort(
          (left, right) =>
            right.silentSeconds - left.silentSeconds ||
            left.id.localeCompare(right.id),
        )

      return c.json({ agents })
    } catch (error) {
      logger.warn('Queen public agents query failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Queen agent registry is unavailable' }, 503)
    } finally {
      await pool.end()
    }
  })
}
