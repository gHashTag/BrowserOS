/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A PERSON'S CANCEL AND ASSIGN, against PostgreSQL (specs/queen/control.t27
 * section 3, gHashTag/t27#6657).
 *
 * The cancel is one statement over a row picked FOR UPDATE, and whether it
 * frees the files, spares the retry counters and makes the bee's own late
 * ending a no-op is a property of how Postgres runs it - so it is asked of
 * Postgres. Same harness as queen-runner-live.test.ts: a scratch database per
 * test, migrated by the boot migration, and no silent skip unless
 * TRIOS_PG_MIGRATE_GATE=offline says the absence is deliberate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { Pool } from 'pg'
import {
  cancelTask,
  claimTaskLease,
  clearAssigns,
  pendingAssigns,
  requestAssign,
  taskLeasedLive,
} from '../../src/api/services/queen-control'
import { finishDispatch } from '../../src/api/services/queen-dispatch'
import {
  dispatchRowState,
  ensureQueenColumns,
} from '../../src/api/services/queen-tick'
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
  const name = `queen_control_${randomBytes(6).toString('hex')}`
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

describe('a person cancels and assigns through the same machine', () => {
  let scratch: { url: string; drop: () => Promise<void> } | null = null
  let pool: Pool | null = null
  const previousUrl = process.env.DATABASE_URL

  beforeEach(async () => {
    scratch = await scratchDatabase()
    if (!scratch) return
    process.env.DATABASE_URL = scratch.url
    await runPgMigrations()
    pool = createQueenPool(scratch.url)
    // The columns a round adds before it reads the table (send_backs,
    // judged_note...), as production has them.
    await ensureQueenColumns(pool)
  })

  afterEach(async () => {
    await pool?.end().catch(() => undefined)
    pool = null
    await scratch?.drop()
    scratch = null
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
  })

  /** A bee in flight on `issue`, with counters that a cancel must not touch. */
  const running = async (issue: number): Promise<void> => {
    await pool?.query(
      `INSERT INTO queen_dispatch
         (issue, branch, started, detail, owned_paths, conversation_id,
          key_index, send_backs, free_attempts, ceiling_releases)
       VALUES ($1, $2, true, 'running', '["docs/a.md"]'::jsonb, $3, 0, 1, 2, 0)`,
      [issue, `queen-${issue}`, `conv-${issue}`],
    )
  }

  const row = async (issue: number) =>
    (
      await (pool as Pool).query(
        `SELECT review_state, judged_note, finished_at, outcome, send_backs,
                free_attempts, ceiling_releases
           FROM queen_dispatch WHERE issue = $1`,
        [issue],
      )
    ).rows[0]

  it('ends a running bee, frees its files and spends no retry', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await running(4300)
    const lease = await claimTaskLease(pool, 4300, 'queen-a', 180)
    expect(lease.landed).toBe(true)
    expect(await taskLeasedLive(pool, 4300)).toBe(true)
    await requestAssign(pool, 4300, 'owner')

    const result = await cancelTask(pool, 4300, 'owner', 'wrong issue')
    expect(result).toEqual({
      status: 'cancelled',
      wasRunning: true,
      conversationId: 'conv-4300',
      fence: lease.fence + 1,
    })
    const after = await row(4300)
    expect(after.review_state).toBe('cancelled')
    expect(after.finished_at).not.toBeNull()
    expect(after.outcome).toBe('cancelled')
    expect(String(after.judged_note)).toContain(
      'Cancelled by owner: wrong issue',
    )
    // cancel_counts_against_issue is false
    expect(Number(after.send_backs)).toBe(1)
    expect(Number(after.free_attempts)).toBe(2)
    expect(Number(after.ceiling_releases)).toBe(0)
    // the files are free: the board and claimOnIssue read it as `failed`
    expect(dispatchRowState(after)).toBe('failed')
    // the lease is fenced out and no longer live, the assignment withdrawn
    expect(await taskLeasedLive(pool, 4300)).toBe(false)
    expect(await pendingAssigns(pool)).toEqual([])
  })

  it('lets the interrupted bee write no ending of its own', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await running(4301)
    await cancelTask(pool, 4301, 'owner', '')
    await finishDispatch(
      pool,
      4301,
      'stream ended badly',
      undefined,
      'conv-4301',
    )
    expect((await row(4301)).outcome).toBe('cancelled')
  })

  it('leaves an accept alone', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await running(4302)
    await pool.query(
      `UPDATE queen_dispatch SET finished_at = now(), review_state = 'accept'
        WHERE issue = 4302`,
    )
    expect(await cancelTask(pool, 4302, 'owner', '')).toEqual({
      status: 'accepted',
    })
    expect((await row(4302)).review_state).toBe('accept')
  })

  it('answers none for an issue never dispatched', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    expect(await cancelTask(pool, 4399, 'owner', '')).toEqual({
      status: 'none',
    })
  })

  it('takes a finished task out of review without a second note', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await running(4303)
    await pool.query(
      `UPDATE queen_dispatch SET finished_at = now(), review_state = 'wait'
        WHERE issue = 4303`,
    )
    const first = await cancelTask(pool, 4303, 'owner', 'once')
    expect(first).toMatchObject({ status: 'cancelled', wasRunning: false })
    await cancelTask(pool, 4303, 'owner', 'twice')
    const note = String((await row(4303)).judged_note)
    expect(note).toContain('once')
    expect(note).not.toContain('twice')
  })

  it('keeps assignments in the order they were asked for', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await requestAssign(pool, 30, 'owner')
    await requestAssign(pool, 10, 'owner')
    await requestAssign(pool, 30, 'someone else')
    expect(await pendingAssigns(pool)).toEqual([30, 10])
    await clearAssigns(pool, [30])
    expect(await pendingAssigns(pool)).toEqual([10])
    await clearAssigns(pool, [])
    expect(await pendingAssigns(pool)).toEqual([10])
  })
})
