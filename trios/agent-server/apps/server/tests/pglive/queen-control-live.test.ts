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
  reclaimExpiredLeases,
  renewRunningLeases,
  renewTaskLeases,
  requestAssign,
  taskLeasedLive,
} from '../../src/api/services/queen-control'
import {
  DISPATCH_OUTCOME_LABELS,
  finishDispatch,
} from '../../src/api/services/queen-dispatch'
import { claimQueuedBee } from '../../src/api/services/queen-runner'
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

describe('a runtime that stops beating loses its task within one TTL', () => {
  let scratch: { url: string; drop: () => Promise<void> } | null = null
  let pool: Pool | null = null
  const previousUrl = process.env.DATABASE_URL
  const TTL = 180
  const LABEL = DISPATCH_OUTCOME_LABELS.reapedLeaseExpired

  beforeEach(async () => {
    scratch = await scratchDatabase()
    if (!scratch) return
    process.env.DATABASE_URL = scratch.url
    await runPgMigrations()
    pool = createQueenPool(scratch.url)
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

  /**
   * A started bee on `issue`, its lease claimed by the Queen. `who` says what
   * runs it; `pulse` how long its older heartbeat has been silent.
   */
  const bee = async (
    issue: number,
    who: 'queen' | 'bee-runner' | 'lent-runner',
    pulseSilentSeconds: number,
  ): Promise<void> => {
    const db = pool as Pool
    await db.query(
      `INSERT INTO queen_dispatch
         (issue, branch, started, detail, owned_paths, conversation_id,
          key_index, dispatched_at)
       VALUES ($1, $2, true, 'running', '[]'::jsonb, $3, 0,
               now() - interval '1 hour')`,
      [issue, `queen-${issue}`, `conv-${issue}`],
    )
    if (who === 'bee-runner') {
      await db.query(
        `UPDATE queen_dispatch
            SET claimed_by = 'runner-1',
                claimed_at = now() - make_interval(secs => $2)
          WHERE issue = $1`,
        [issue, pulseSilentSeconds],
      )
    }
    if (who === 'lent-runner') {
      await db.query(
        `UPDATE queen_dispatch
            SET runner_claimed_at = now() - interval '1 hour',
                runner_lease_at = now() - make_interval(secs => $2)
          WHERE issue = $1`,
        [issue, pulseSilentSeconds],
      )
    }
    await claimTaskLease(db, issue, 'queen-a', TTL)
  }

  const lapse = async (issue: number): Promise<void> => {
    await (pool as Pool).query(
      `UPDATE queen_task_lease SET expires_at = now() - interval '1 minute'
        WHERE issue = $1`,
      [issue],
    )
  }

  const outcome = async (issue: number) =>
    (
      await (pool as Pool).query(
        'SELECT outcome, finished_at FROM queen_dispatch WHERE issue = $1',
        [issue],
      )
    ).rows[0]

  it('hands back a bee runner that went silent', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await bee(4400, 'bee-runner', 600)
    await lapse(4400)
    const back = await reclaimExpiredLeases(pool, TTL, LABEL)
    expect(back.map((r) => r.issue)).toEqual([4400])
    expect((await outcome(4400)).outcome).toBe(LABEL)
    // and a second pass finds nothing left to reclaim
    expect(await reclaimExpiredLeases(pool, TTL, LABEL)).toEqual([])
  })

  it('hands back a lent runner that went silent', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await bee(4401, 'lent-runner', 600)
    await lapse(4401)
    const back = await reclaimExpiredLeases(pool, TTL, LABEL)
    expect(back.map((r) => r.issue)).toEqual([4401])
  })

  it('keeps a draining runner whose older pulse still beats', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await bee(4402, 'bee-runner', 5)
    await lapse(4402)
    expect(await reclaimExpiredLeases(pool, TTL, LABEL)).toEqual([])
    expect((await outcome(4402)).finished_at).toBeNull()
  })

  it('keeps a runner whose lease is still renewed', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await bee(4403, 'bee-runner', 600)
    expect(await renewTaskLeases(pool, [4403], TTL)).toEqual([4403])
    expect(await reclaimExpiredLeases(pool, TTL, LABEL)).toEqual([])
  })

  it("leaves the Queen's own bee to the reapers that salvage", async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await bee(4404, 'queen', 0)
    await lapse(4404)
    expect(await reclaimExpiredLeases(pool, TTL, LABEL)).toEqual([])
  })

  it('renews only what the Queen herself runs', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await bee(4405, 'queen', 0)
    await bee(4406, 'bee-runner', 0)
    await bee(4407, 'lent-runner', 0)
    expect(await renewRunningLeases(pool, 'queen-a', TTL)).toBe(1)
    const renewed = await pool.query(
      `SELECT issue FROM queen_task_lease
        WHERE renewed_at > acquired_at ORDER BY issue`,
    )
    expect(renewed.rows.map((r) => Number(r.issue))).toEqual([4405])
  })

  it('never revives a lease that already lapsed', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await bee(4408, 'bee-runner', 0)
    await lapse(4408)
    expect(await renewTaskLeases(pool, [4408], TTL)).toEqual([])
    expect(await renewTaskLeases(pool, [], TTL)).toEqual([])
  })
})

describe('a runner takes its own domain first, and never waits for it', () => {
  let scratch: { url: string; drop: () => Promise<void> } | null = null
  let pool: Pool | null = null
  const previousUrl = process.env.DATABASE_URL

  beforeEach(async () => {
    scratch = await scratchDatabase()
    if (!scratch) return
    process.env.DATABASE_URL = scratch.url
    await runPgMigrations()
    pool = createQueenPool(scratch.url)
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

  /** An order queued `ageSeconds` ago, in `domain`. */
  const order = async (
    issue: number,
    domain: number | null,
    ageSeconds: number,
  ): Promise<void> => {
    await (pool as Pool).query(
      `INSERT INTO queen_dispatch
         (issue, branch, started, detail, owned_paths, conversation_id,
          key_index, queued_at, brief, domain)
       VALUES ($1, $2, true, 'queued for a runner', '[]'::jsonb, $3, 0,
               now() - make_interval(secs => $4), 'do it', $5)`,
      [issue, `queen-${issue}`, `conv-${issue}`, ageSeconds, domain],
    )
  }

  it('takes an order of its own domain before an older one', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await order(4500, 2, 300)
    await order(4501, 1, 200)
    await order(4502, 1, 100)
    const first = await claimQueuedBee(pool, 'runner-a', 1)
    expect(first?.issue).toBe(4501)
    expect(first?.domain).toBe(1)
  })

  it('takes the oldest order when it has no domain yet', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await order(4510, 2, 300)
    await order(4511, 1, 200)
    expect((await claimQueuedBee(pool, 'runner-a', null))?.issue).toBe(4510)
  })

  it('takes another domain rather than wait for its own', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await order(4520, 2, 300)
    await order(4521, null, 200)
    expect((await claimQueuedBee(pool, 'runner-a', 3))?.issue).toBe(4520)
    expect((await claimQueuedBee(pool, 'runner-a', 3))?.issue).toBe(4521)
    expect(await claimQueuedBee(pool, 'runner-a', 3)).toBeNull()
  })
})
