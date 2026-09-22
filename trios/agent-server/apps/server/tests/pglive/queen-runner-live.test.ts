/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * TWO RUNNERS, ONE ORDER: only PostgreSQL can answer this.
 *
 * The whole of the handover's mutual exclusion is one statement - an UPDATE
 * over a row picked `FOR UPDATE SKIP LOCKED` - and nothing outside a real
 * server tells you whether it holds. A fake pool would answer whatever it was
 * written to answer, which is the shape of test that lets a double-claim ship:
 * two runners on one issue means two bees writing one branch and two rows'
 * worth of ledger for one boundary.
 *
 * So this runs against a scratch database, in the pglive GROUP for the reason
 * that group exists: `mock.module` is process-global in bun, and the api group
 * binds `pg` to a FakePool at module scope.
 *
 * Like its neighbour, this FAILS when no server is reachable rather than
 * skipping, unless TRIOS_PG_MIGRATE_GATE=offline says the absence is deliberate
 * - a silent skip is how a gate comes to report a success it never earned.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { Pool } from 'pg'
import {
  reapDispatchesFromPreviousBoot,
  reapStalledDispatches,
} from '../../src/api/services/queen-dispatch'
import { claimQueuedBee } from '../../src/api/services/queen-runner'
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

/** A fresh database per run, dropped afterwards. */
async function scratchDatabase(): Promise<{
  url: string
  drop: () => Promise<void>
} | null> {
  const name = `queen_runner_${randomBytes(6).toString('hex')}`
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
  // The schema every Queen connection selects. Production has it because a role
  // setting put it there years ago; a scratch database has to be told, and a
  // pool that selects a schema nobody created cannot create a table in it.
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

describe('a queued bee is claimed by exactly one runner', () => {
  let scratch: { url: string; drop: () => Promise<void> } | null = null
  let pool: Pool | null = null
  const previousUrl = process.env.DATABASE_URL

  beforeEach(async () => {
    scratch = await scratchDatabase()
    if (!scratch) return
    // `runPgMigrations` reads DATABASE_URL, as the server does at boot.
    process.env.DATABASE_URL = scratch.url
    await runPgMigrations()
    // The pool the server itself builds: it selects the Queen's schema on every
    // connection, and a plain `new Pool` here would read a different namespace
    // from the one the migration just wrote into - which is precisely the decoy
    // queen-pool.ts exists to end.
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

  const order = async (issue: number, keyIndex = 0): Promise<void> => {
    await pool?.query(
      `INSERT INTO queen_dispatch
         (issue, branch, started, detail, owned_paths, conversation_id,
          key_index, queued_at, brief)
       VALUES ($1, $2, true, 'queued for a runner', '["docs/a.md"]'::jsonb,
               $3, $4, now(), 'do the thing')`,
      [issue, `queen-${issue}`, `conv-${issue}`, keyIndex],
    )
  }

  it('hands one order to one runner, whatever else is asking', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await order(4100)

    // Eight runners reaching for one row at the same moment.
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        claimQueuedBee(pool as Pool, `runner-${i}`),
      ),
    )
    const took = claims.filter(Boolean)
    expect(took).toHaveLength(1)
    expect(took[0]).toMatchObject({
      issue: 4100,
      branch: 'queen-4100',
      brief: 'do the thing',
      ownedPaths: ['docs/a.md'],
      conversationId: 'conv-4100',
      keyIndex: 0,
    })
    const row = await pool.query(
      'SELECT claimed_by, claimed_at FROM queen_dispatch WHERE issue = 4100',
    )
    expect(row.rows[0].claimed_by).toMatch(/^runner-\d$/)
    expect(row.rows[0].claimed_at).not.toBeNull()
    // And nobody gets it twice.
    expect(await claimQueuedBee(pool, 'runner-late')).toBeNull()
  })

  it('gives each runner a different order, oldest first, and skips what is taken', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await order(4201, 1)
    await order(4202, 2)
    await order(4203, 3)
    // Reaching at the same moment: SKIP LOCKED means nobody waits behind
    // another runner's lock while an unclaimed row sits next to it.
    const claims = await Promise.all([
      claimQueuedBee(pool, 'a'),
      claimQueuedBee(pool, 'b'),
      claimQueuedBee(pool, 'c'),
    ])
    const issues = claims
      .filter(Boolean)
      .map((claim) => (claim as { issue: number }).issue)
      .sort()
    expect(issues).toEqual([4201, 4202, 4203])
    expect(await claimQueuedBee(pool, 'd')).toBeNull()
  })

  it('takes only what the Queen queued and left unclaimed', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    // A bee running inside the Queen herself: no queued_at, so no order.
    await pool.query(
      `INSERT INTO queen_dispatch (issue, branch, started, detail, conversation_id, key_index)
       VALUES (4301, 'queen-4301', true, 'running here', 'c1', 0)`,
    )
    // An order already finished, and one already claimed.
    await order(4302)
    await pool.query(
      "UPDATE queen_dispatch SET finished_at = now(), outcome = 'finished' WHERE issue = 4302",
    )
    await order(4303)
    await pool.query(
      "UPDATE queen_dispatch SET claimed_by = 'somebody', claimed_at = now() WHERE issue = 4303",
    )
    expect(await claimQueuedBee(pool, 'fresh')).toBeNull()
  })

  it('re-dispatching an order releases the claim the last one left', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await order(4400)
    expect(await claimQueuedBee(pool, 'first')).not.toBeNull()
    // The runner died. The reaper ends the row, and the next round queues the
    // issue again - which is the same upsert `recordDispatch` runs.
    await pool.query(
      `UPDATE queen_dispatch SET finished_at = now(), outcome = 'reaped' WHERE issue = 4400`,
    )
    await pool.query(
      `UPDATE queen_dispatch
          SET started = true, finished_at = NULL, outcome = NULL,
              queued_at = now(), claimed_by = NULL, claimed_at = NULL
        WHERE issue = 4400`,
    )
    const again = await claimQueuedBee(pool, 'second')
    expect(again?.issue).toBe(4400)
  })

  // A salvage runs git on this machine's volume; these cases are about which
  // ROWS a reaper takes, so it is replaced by a no-op that says nothing moved.
  const noSalvage = async () =>
    ({
      committed: false,
      detail: 'test',
      left: [],
      sha: null,
      files: [],
    }) as never

  it('the Queen restarting does not bury the bees that run on runners', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    // One bee the Queen ran herself - it died with her container.
    await pool.query(
      `INSERT INTO queen_dispatch (issue, branch, started, detail, conversation_id, key_index)
       VALUES (4501, 'queen-4501', true, 'running here', 'c-4501', 0)`,
    )
    // An order nobody has taken yet, and one a runner is working on.
    await order(4502)
    await order(4503)
    expect(await claimQueuedBee(pool, 'runner-x')).not.toBeNull()

    const reaped = await reapDispatchesFromPreviousBoot(pool, {
      salvage: noSalvage,
    })
    expect(reaped).toEqual([4501])
    const open = await pool.query(
      'SELECT issue FROM queen_dispatch WHERE finished_at IS NULL ORDER BY issue',
    )
    expect(open.rows.map((row) => row.issue)).toEqual([4502, 4503])
  })

  it('a runner that stops vouching loses its bee after ten minutes, not two hours', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await order(4601)
    await order(4602)
    expect(await claimQueuedBee(pool, 'silent')).not.toBeNull()
    expect(await claimQueuedBee(pool, 'alive')).not.toBeNull()
    // Both started a minute ago; one runner went quiet eleven minutes ago - its
    // container is gone - and the other renewed a second ago.
    await pool.query(
      `UPDATE queen_dispatch SET dispatched_at = now() - interval '1 minute'`,
    )
    await pool.query(
      `UPDATE queen_dispatch SET claimed_at = now() - interval '11 minutes'
        WHERE claimed_by = 'silent'`,
    )
    const reaped = await reapStalledDispatches(pool, 120, {
      salvage: noSalvage,
    })
    const silent = await pool.query(
      "SELECT issue FROM queen_dispatch WHERE claimed_by = 'silent'",
    )
    expect(reaped).toEqual([silent.rows[0].issue])
    const left = await pool.query(
      'SELECT claimed_by FROM queen_dispatch WHERE finished_at IS NULL',
    )
    expect(left.rows.map((row) => row.claimed_by)).toEqual(['alive'])
  })
})
