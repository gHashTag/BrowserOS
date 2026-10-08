/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE BUS, against PostgreSQL (gHashTag/t27 specs/queen/events.t27 section 1).
 *
 * Whether two writers at once get consecutive numbers, and whether a reader
 * past a cursor ever misses one, is a property of how Postgres locks the
 * counter row - so it is asked of Postgres. Same harness as
 * queen-control-live.test.ts: a scratch database per test, migrated by the
 * boot migration, and no silent skip unless TRIOS_PG_MIGRATE_GATE=offline.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { Pool } from 'pg'
import { publishEvent } from '../../src/api/services/queen-control'
import {
  LogFollower,
  logBounds,
  pruneEvents,
  publicEventsPage,
} from '../../src/api/services/queen-events'
import { KEEP_AT_LEAST } from '../../src/api/services/queen-events.gen'
import { runPgMigrations } from '../../src/lib/db/pg-migrate'
import { createQueenPool, queenSchema } from '../../src/lib/db/queen-pool'

const OFFLINE_KEY = 'TRIOS_PG_MIGRATE_GATE'
const URL_KEY = 'TRIOS_PG_TEST_URL'

function offlineRequested(): boolean {
  return (process.env[OFFLINE_KEY] ?? '').toLowerCase() === 'offline'
}

function adminUrl(): string {
  return (
    process.env[URL_KEY] ??
    `postgres://${userInfo().username}@127.0.0.1:5432/postgres`
  )
}

async function scratchDatabase(): Promise<{
  url: string
  drop: () => Promise<void>
} | null> {
  const name = `queen_events_${randomBytes(6).toString('hex')}`
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

describe('the event log numbers without a gap and loses nothing', () => {
  let scratch: { url: string; drop: () => Promise<void> } | null = null
  let pool: Pool | null = null
  const previousUrl = process.env.DATABASE_URL

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

  const seqs = async (): Promise<number[]> =>
    (
      await (pool as Pool).query(
        `SELECT seq FROM queen_event_log WHERE stream = 'queen' ORDER BY seq`,
      )
    ).rows.map((r) => Number(r.seq))

  it('gives forty writers at once forty consecutive numbers', async () => {
    if (!pool) return
    const p = pool
    const got = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        publishEvent(p, 'queen/task.assign', { issue: 1000 + i }),
      ),
    )
    expect([...got].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    )
    expect(await seqs()).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
    const counter = await p.query(
      `SELECT last FROM queen_event_counter WHERE stream = 'queen'`,
    )
    expect(Number(counter.rows[0].last)).toBe(40)
  })

  it('a reader that follows forty writers sees every number once, in order', async () => {
    if (!pool) return
    const p = pool
    const seen: number[] = []
    const reader = new LogFollower(p, 'queen', 'reader', (e) =>
      seen.push(e.seq),
    )
    await reader.start(5)
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        publishEvent(p, 'queen/task.cancel', { issue: 2000 + i }),
      ),
    )
    for (let i = 0; i < 100 && seen.length < 40; i++)
      await new Promise((r) => setTimeout(r, 20))
    reader.stop()
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
  })

  it('numbers past rows a writer from before the bus left', async () => {
    if (!pool) return
    const p = pool
    // The old writer: MAX(seq)+1, no counter, no origin.
    const old = () =>
      p.query(
        `INSERT INTO queen_event_log (stream, seq, kind, payload)
         SELECT 'queen', COALESCE(MAX(seq), 0) + 1, 1, '{}'::jsonb
           FROM queen_event_log WHERE stream = 'queen'`,
      )
    await old()
    await old()
    expect(await publishEvent(p, 'queen/task.ended', { issue: 1 })).toBe(3)
    await old()
    expect(await publishEvent(p, 'queen/task.ended', { issue: 2 })).toBe(5)
    expect(await seqs()).toEqual([1, 2, 3, 4, 5])
  })

  it('the first write of a stream numbers past the rows already in the log', async () => {
    if (!pool) return
    const p = pool
    await p.query(
      `INSERT INTO queen_event_log (stream, seq, kind) VALUES ('queen', 1, 0), ('queen', 2, 0), ('queen', 7, 0)`,
    )
    await runPgMigrations()
    expect(await publishEvent(p, 'queen/task.created', { issue: 9 })).toBe(8)
    expect(await publishEvent(p, 'queen/task.created', { issue: 10 })).toBe(9)
  })

  it('writes who wrote each row', async () => {
    if (!pool) return
    await publishEvent(pool, 'queen/task.cancel', { issue: 4 })
    const r = await pool.query(`SELECT origin FROM queen_event_log`)
    expect(typeof r.rows[0].origin).toBe('string')
    expect(String(r.rows[0].origin)).toContain(':')
  })

  it('prunes old rows but keeps the newest KEEP_AT_LEAST', async () => {
    if (!pool) return
    const p = pool
    const n = KEEP_AT_LEAST + 3
    await p.query(
      `INSERT INTO queen_event_log (stream, seq, kind, recorded_at)
       SELECT 'queen', g, 9, now() - interval '4 days' FROM generate_series(1, $1) g`,
      [n],
    )
    expect(await pruneEvents(p, 'queen')).toBe(3)
    expect(await logBounds(p, 'queen')).toEqual({ oldest: 4, newest: n })
    // a reader resuming from before the pruned rows is told to resync
    const page = await publicEventsPage(p, 'queen', 1, 0, [], 'o/r')
    expect(page.resync).toBe(true)
    expect(page.cursor).toBe(n)
  })
})
