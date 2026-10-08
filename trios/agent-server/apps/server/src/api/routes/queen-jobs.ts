/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A person starts, reads and cancels a job the Queen drives (gHashTag/t27
 * specs/queen/jobs.t27, t27#7676). Guarded like every route that writes:
 *
 *   POST /queen/jobs               { card, params: { version }, rehearsal?, by? }
 *   GET  /queen/jobs               the latest jobs
 *   GET  /queen/jobs/:id           one job, with its step log
 *   POST /queen/jobs/:id/cancel    { by? }
 *
 * Starting a job is the only thing a person does. The Queen advances it each
 * round, and a start publishes queen/tick so the first round does not wait for
 * the timer.
 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { publishEvent } from '../services/queen-control'
import {
  cancelJob,
  ensureJobTables,
  getJob,
  listJobs,
  startJob,
} from '../services/queen-jobs'
import { queenLeaseDatabaseUrl } from '../services/queen-lease'

export interface QueenJobsDeps {
  pool?: () => Pool | null
  startJob?: typeof startJob
  getJob?: typeof getJob
  listJobs?: typeof listJobs
  cancelJob?: typeof cancelJob
  publishEvent?: typeof publishEvent
  ensureTables?: (pool: Pool) => Promise<void>
}

let sharedPool: Pool | null = null

function defaultPool(): Pool | null {
  const url = queenLeaseDatabaseUrl()
  if (!url) return null
  if (!sharedPool) sharedPool = createQueenPool(url)
  return sharedPool
}

function idOf(raw: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null
  return Number(raw)
}

function nameOf(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return clean ? clean.slice(0, 80) : fallback
}

export function createQueenJobsRoute(deps: QueenJobsDeps = {}) {
  const poolOf = deps.pool ?? defaultPool
  const start = deps.startJob ?? startJob
  const get = deps.getJob ?? getJob
  const list = deps.listJobs ?? listJobs
  const cancel = deps.cancelJob ?? cancelJob
  const publish = deps.publishEvent ?? publishEvent
  const ensure = deps.ensureTables ?? ensureJobTables

  return new Hono()
    .get('/', async (c) => {
      const pool = poolOf()
      if (!pool) return c.json({ error: 'No database configured' }, 503)
      await ensure(pool)
      return c.json({ jobs: await list(pool) })
    })
    .post('/', async (c) => {
      const pool = poolOf()
      if (!pool) return c.json({ error: 'No database configured' }, 503)
      const body = await c.req.json().catch(() => ({}))
      const card = typeof body?.card === 'string' ? body.card : ''
      const params =
        body?.params && typeof body.params === 'object' ? body.params : {}
      const rehearsal = body?.rehearsal === true
      const by = nameOf(body?.by, 'operator')
      await ensure(pool)
      const result = await start(pool, card, params, rehearsal, by)
      if (!result.ok) return c.json({ error: result.error }, result.status)
      await publish(pool, 'queen/tick', { job: result.job.id }).catch(() => 0)
      return c.json({ job: result.job }, 201)
    })
    .get('/:id', async (c) => {
      const id = idOf(c.req.param('id'))
      if (id === null) return c.json({ error: 'not a job id' }, 400)
      const pool = poolOf()
      if (!pool) return c.json({ error: 'No database configured' }, 503)
      await ensure(pool)
      const job = await get(pool, id)
      if (!job) return c.json({ error: 'no such job' }, 404)
      return c.json({ job })
    })
    .post('/:id/cancel', async (c) => {
      const id = idOf(c.req.param('id'))
      if (id === null) return c.json({ error: 'not a job id' }, 400)
      const pool = poolOf()
      if (!pool) return c.json({ error: 'No database configured' }, 503)
      const body = await c.req.json().catch(() => ({}))
      await ensure(pool)
      const result = await cancel(pool, id, nameOf(body?.by, 'operator'))
      if (result === 'none') return c.json({ error: 'no such job' }, 404)
      if (result === 'not-running')
        return c.json({ error: 'the job is not running' }, 409)
      return c.json({ id, cancelled: true })
    })
}
