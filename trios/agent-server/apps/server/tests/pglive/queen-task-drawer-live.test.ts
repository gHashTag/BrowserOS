/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * ONE TASK, OPENED, against PostgreSQL (gHashTag/t27 specs/queen/dashboard.t27
 * section 2): the events that name it through the payload index, its lease,
 * its retry counters, and a job's effects. Same harness as queen-tasks-live.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { Pool } from 'pg'
import { publishEvent } from '../../src/api/services/queen-control'
import { ensureJobTables } from '../../src/api/services/queen-jobs'
import { buildTaskDrawer } from '../../src/api/services/queen-task-drawer'
import { ensureQueenColumns } from '../../src/api/services/queen-tick'
import { runPgMigrations } from '../../src/lib/db/pg-migrate'
import { createQueenPool, queenSchema } from '../../src/lib/db/queen-pool'

const OFFLINE_KEY = 'TRIOS_PG_MIGRATE_GATE'
const URL_KEY = 'TRIOS_PG_TEST_URL'
const offlineRequested = (): boolean =>
  (process.env[OFFLINE_KEY] ?? '').toLowerCase() === 'offline'
const adminUrl = (): string =>
  process.env[URL_KEY] ??
  `postgres://${userInfo().username}@127.0.0.1:5432/postgres`

async function scratchDatabase(): Promise<{
  url: string
  drop: () => Promise<void>
} | null> {
  const name = `queen_drawer_${randomBytes(6).toString('hex')}`
  const admin = new Pool({ connectionString: adminUrl(), max: 1 })
  try {
    await admin.query(`CREATE DATABASE ${name}`)
  } catch (error) {
    await admin.end().catch(() => undefined)
    if (offlineRequested()) return null
    throw error
  }
  const url = new URL(adminUrl())
  url.pathname = `/${name}`
  const fresh = new Pool({ connectionString: url.toString(), max: 1 })
  try {
    await fresh.query(`CREATE SCHEMA IF NOT EXISTS ${queenSchema()}`)
  } finally {
    await fresh.end().catch(() => undefined)
  }
  return {
    url: url.toString(),
    drop: async () => {
      await admin
        .query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        .catch(() => undefined)
      await admin.end().catch(() => undefined)
    },
  }
}

describe('the drawer against Postgres', () => {
  let scratch: { url: string; drop: () => Promise<void> } | null = null
  let pool: Pool | null = null
  const previousUrl = process.env.DATABASE_URL
  const names = [
    'queen/task.created',
    'queen/task.ended',
    'queen/worker.idle',
    'queen/lease.expired',
    'queen/task.evidence',
    'queen/task.reviewed',
    'queen/task.assign',
    'queen/task.cancel',
    'queen/lease.heartbeat',
    'queen/tick',
  ]

  beforeEach(async () => {
    scratch = await scratchDatabase()
    if (!scratch) return
    process.env.DATABASE_URL = scratch.url
    await runPgMigrations()
    pool = createQueenPool(scratch.url)
  })

  afterEach(async () => {
    await pool?.end().catch(() => undefined)
    pool = null
    await scratch?.drop()
    scratch = null
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
  })

  it('opens an issue: its task, bee, timeline, lease and attempts', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const p = pool
    await ensureQueenColumns(p)
    await p.query(
      `INSERT INTO queen_issues (number, title, state) VALUES (7513, 'Port gen_w310.py to t27', 'open')`,
    )
    await p.query(
      `INSERT INTO queen_dispatch (issue, branch, started, detail, conversation_id, key_index, queued_at, claimed_by, claimed_at, send_backs, review_state, outcome)
       VALUES (7513, 'queen-7513', true, 'claimed', 'c7513', 3, now() - interval '20 minutes', 'runner-1:42', now(), 1, 'sendBack', 'needs a rewrite of section 2')`,
    )
    await p.query(
      `INSERT INTO queen_task_lease (issue, holder, expires_at, fence) VALUES (7513, 'replica:1', now() + interval '2 minutes', 4)`,
    )
    await publishEvent(p, 'queen/task.created', { issue: 7513, holder: 'r:1' })
    await publishEvent(p, 'queen/task.reviewed', {
      issue: 7513,
      verdict: 'sendBack',
    })
    await publishEvent(p, 'queen/task.created', { issue: 9999 })
    await publishEvent(p, 'queen/tick', {})
    const d = await buildTaskDrawer(p, { issue: 7513 }, 'gHashTag/t27', names)
    expect(d.key).toBe('gHashTag/t27#7513')
    expect(d.task?.number).toBe(7513)
    expect(d.bee?.id).toBe('b7513')
    // only the events that name this issue, newest first, projected
    expect(d.timeline.map((e) => [e.seq, e.name])).toEqual([
      [2, 'queen/task.reviewed'],
      [1, 'queen/task.created'],
    ])
    expect(d.timeline[1]).not.toHaveProperty('holder')
    expect(d.lease).toMatchObject({ state: 'live', fence: 4 })
    expect(d.attempts).toMatchObject({ sendBacks: 1, reviewState: 'sendBack' })
    // a note is not a token, and is not public
    expect(d.attempts?.outcome).toBe(null)
  })

  it('says an expired lease is expired and a missing one is none', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const p = pool
    await ensureQueenColumns(p)
    await p.query(
      `INSERT INTO queen_task_lease (issue, holder, expires_at, fence) VALUES (7400, 'replica:1', now() - interval '1 minute', 2)`,
    )
    const gone = await buildTaskDrawer(
      p,
      { issue: 7400 },
      'gHashTag/t27',
      names,
    )
    expect(gone.lease?.state).toBe('expired')
    const none = await buildTaskDrawer(
      p,
      { issue: 7401 },
      'gHashTag/t27',
      names,
    )
    expect(none.lease).toBe(null)
    expect(none.attempts).toBe(null)
    expect(none.timeline).toEqual([])
  })

  it('opens a job: its effects by step, never their results', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const p = pool
    await ensureQueenColumns(p)
    await ensureJobTables(p)
    await p.query(
      `INSERT INTO queen_job (card, params, state, started_by) VALUES ('release-t27c', '{"version":"0.5.1"}', 0, 'test')`,
    )
    await p.query(
      `INSERT INTO queen_effect (key, kind, state, runs, result) VALUES
         ('job:1:step:3:release:t27c-v0.5.1', 1, 2, 1, '{"secret":"x"}'),
         ('job:2:step:1:release:other', 1, 2, 1, NULL)`,
    )
    const d = await buildTaskDrawer(p, { job: 1 }, 'gHashTag/t27', names)
    expect(d.key).toBe('job:1')
    expect(d.task?.kind).toBe('job')
    expect(d.effects).toEqual([
      expect.objectContaining({ step: 3, kind: 1, state: 2, runs: 1 }),
    ])
    expect(JSON.stringify(d)).not.toContain('secret')
  })
})
