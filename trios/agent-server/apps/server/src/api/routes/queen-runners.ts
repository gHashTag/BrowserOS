/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE RUNNER CABINET, AND THE DOOR A RUNNER KNOCKS ON.
 *
 * Two routes, two credentials that never meet:
 *
 *   /queen/me/runners   the PERSON, with the bearer token app.t27.ai issued
 *                       them (verified by asking its issuer, see
 *                       queen-app-identity.ts). Lists, mints and revokes that
 *                       person's runner tokens - nobody else's.
 *
 *   /queen/runner       the RUNNER, with the token minted above. It says it is
 *                       alive (renewing the lease on what it holds), claims the
 *                       task the round offered its lane, and hands the work
 *                       back as a pushed branch (queen-runner-work.ts).
 *
 * Neither route accepts, stores or returns a provider key. The key stays on
 * the runner's machine; that is the whole point of a runner.
 */
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import {
  bearerOf,
  createAppIdentity,
  type Identify,
  IdentityUnavailableError,
} from '../services/queen-app-identity'
import {
  claimRunnerWork,
  completeRunnerWork,
  parseCompleteBody,
  renewRunnerLease,
  runnersEnabled,
} from '../services/queen-runner-work'
import {
  cleanLabel,
  createRunner,
  heartbeatRunner,
  laneOf,
  listRunners,
  MAX_RUNNERS_PER_PERSON,
  revokeRunner,
  viewOf,
} from '../services/queen-runners'

/**
 * What a runner speaks. 1 was "registered, nothing to take"; 2 is heartbeat,
 * claim and complete. A runner that reads a protocol it does not know stops.
 */
export const RUNNER_PROTOCOL = 2

type Queryable = Pick<Pool, 'query'>

export interface RunnerRouteDeps {
  /** The database, or null when none is configured (503). */
  pool: () => Queryable | null
  identify: Identify
  /** Brings a runner's branch home and closes its task; injectable for tests. */
  complete: typeof completeRunnerWork
}

/**
 * One pool for the life of the process, created on first use. A pool per
 * request that is never ended is a connection leak with a delay on it.
 */
let sharedPool: Pool | undefined
function defaultPool(): Queryable | null {
  const url = process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL
  if (!url) return null
  if (!sharedPool) sharedPool = createQueenPool(url)
  return sharedPool
}

function defaults(deps: Partial<RunnerRouteDeps>): RunnerRouteDeps {
  return {
    pool: deps.pool ?? defaultPool,
    identify: deps.identify ?? createAppIdentity(),
    complete: deps.complete ?? completeRunnerWork,
  }
}

const NO_DATABASE = { error: 'No database configured' } as const

export function createQueenCabinetRoute(given: Partial<RunnerRouteDeps> = {}) {
  const deps = defaults(given)
  return new Hono<{
    Variables: { person: { telegramId: string; name: string } }
  }>()
    .use('/*', async (c, next) => {
      const bearer = bearerOf(c.req.header('authorization'))
      if (!bearer) return c.json({ error: 'Sign in to app.t27.ai first' }, 401)
      try {
        const person = await deps.identify(bearer)
        if (!person) return c.json({ error: 'The session was refused' }, 401)
        c.set('person', person)
      } catch (error) {
        if (!(error instanceof IdentityUnavailableError)) throw error
        logger.warn('Runner cabinet could not verify a session', {
          error: error.message,
        })
        return c.json({ error: 'Sign-in service did not answer' }, 503)
      }
      await next()
      return
    })
    .get('/', async (c) => {
      const pool = deps.pool()
      if (!pool) return c.json(NO_DATABASE, 503)
      const rows = await listRunners(pool, c.get('person').telegramId)
      return c.json(
        {
          runners: rows.map((r) => viewOf(r)),
          limit: MAX_RUNNERS_PER_PERSON,
          protocol: RUNNER_PROTOCOL,
        },
        200,
        { 'Cache-Control': 'no-store' },
      )
    })
    .post('/', async (c) => {
      const pool = deps.pool()
      if (!pool) return c.json(NO_DATABASE, 503)
      const body = await c.req.json().catch(() => null)
      const label = cleanLabel(body?.label)
      if (!label) return c.json({ error: 'A runner needs a name' }, 400)
      const made = await createRunner(pool, c.get('person'), label)
      if (!made.ok) {
        return c.json(
          {
            error: `At most ${MAX_RUNNERS_PER_PERSON} runners; revoke one first`,
          },
          409,
        )
      }
      // The only answer that ever carries the token. The page shows it once.
      return c.json({ runner: viewOf(made.runner), token: made.token }, 201, {
        'Cache-Control': 'no-store',
      })
    })
    .delete('/:id', async (c) => {
      const pool = deps.pool()
      if (!pool) return c.json(NO_DATABASE, 503)
      const id = Number(c.req.param('id'))
      if (!Number.isSafeInteger(id) || id <= 0)
        return c.json({ error: 'No such runner' }, 404)
      const done = await revokeRunner(pool, c.get('person').telegramId, id)
      // Someone else's runner and no runner at all are the same answer: the
      // cabinet does not confirm which ids exist.
      return done ? c.body(null, 204) : c.json({ error: 'No such runner' }, 404)
    })
}

export function createQueenRunnerRoute(given: Partial<RunnerRouteDeps> = {}) {
  const deps = defaults(given)
  const noStore = { 'Cache-Control': 'no-store' }
  return new Hono<{
    Variables: { pool: Queryable; runner: { id: number; label: string } }
  }>()
    .use('/*', async (c, next) => {
      const pool = deps.pool()
      if (!pool) return c.json(NO_DATABASE, 503)
      const token = bearerOf(c.req.header('authorization'))
      // Every call is a heartbeat: a runner that is talking is alive.
      const runner = token ? await heartbeatRunner(pool, token) : null
      if (!runner) return c.json({ error: 'Unknown or revoked runner' }, 401)
      c.set('pool', pool)
      c.set('runner', { id: runner.id, label: runner.label })
      await next()
      return
    })
    .post('/heartbeat', async (c) => {
      const runner = c.get('runner')
      const holding = await renewRunnerLease(c.get('pool'), runner.id)
      return c.json(
        {
          runner: { ...runner, lane: laneOf(runner.id) },
          protocol: RUNNER_PROTOCOL,
          work: holding,
          note: !runnersEnabled()
            ? 'This swarm is not handing tasks to runners right now.'
            : holding
              ? holding.claimed
                ? 'Lease renewed.'
                : 'A task is waiting for you: claim it.'
              : 'Nothing for you yet; the next round may offer a task.',
        },
        200,
        noStore,
      )
    })
    .post('/claim', async (c) => {
      const work = await claimRunnerWork(c.get('pool'), c.get('runner').id)
      return c.json({ protocol: RUNNER_PROTOCOL, work }, 200, noStore)
    })
    .post('/complete', async (c) => {
      const parsed = parseCompleteBody(await c.req.json().catch(() => null))
      if ('error' in parsed) return c.json({ error: parsed.error }, 400)
      const done = await deps.complete(
        c.get('pool') as Pool,
        c.get('runner').id,
        parsed,
      )
      if (!done.ok) return c.json({ error: done.error }, done.status)
      return c.json(
        { issue: done.issue, closed: done.closed, protocol: RUNNER_PROTOCOL },
        200,
        noStore,
      )
    })
}
