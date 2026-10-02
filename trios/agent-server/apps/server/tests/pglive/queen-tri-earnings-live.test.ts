/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The earnings record, run against a real PostgreSQL.
 *
 * recordEarnings is two statements of SQL over jsonb snapshots, a DISTINCT ON
 * and a sha256 - nothing a fake pool can say anything about. So it runs here,
 * in the live group, next to the migration gate and for the same reason: other
 * test files mock `pg` at module scope, and a group is its own bun process
 * (pg-migrate-live.test.ts explains the measurement).
 *
 * Like that gate, this FAILS when no server is reachable, unless
 * TRIOS_PG_MIGRATE_GATE=offline asks for a printed skip.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { Pool } from 'pg'
import {
  EARNING_SCHEME,
  earningsLedger,
  readEarnings,
  recordEarnings,
} from '../../src/api/services/queen-tri-earnings'
import { runPgMigrations } from '../../src/lib/db/pg-migrate'
import { createQueenPool } from '../../src/lib/db/queen-pool'

const REPO = 'gHashTag/trios'

function adminUrl(): string {
  return (
    process.env.TRIOS_PG_TEST_URL ??
    `postgres://${userInfo().username}@127.0.0.1:5432/postgres`
  )
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

const offline =
  (process.env.TRIOS_PG_MIGRATE_GATE ?? '').toLowerCase() === 'offline'

/** What anybody outside can compute from the repository, issue and commit. */
const workIdOf = (issue: number, commit: string) =>
  createHash('sha256')
    .update(`${EARNING_SCHEME}|${REPO}|${issue}|${commit}`, 'utf8')
    .digest('hex')

const at = (minutes: number) =>
  new Date(Date.UTC(2026, 9, 1, 12, minutes)).toISOString()

let admin: Pool | undefined
let pool: Pool | undefined
let scratchName = ''
let skipped = false

beforeAll(async () => {
  const url = adminUrl()
  if (!isLocal(url) && process.env.TRIOS_PG_TEST_ALLOW_REMOTE !== '1') {
    throw new Error(
      'TRIOS_PG_TEST_URL is not local; this test creates and drops a database.',
    )
  }
  admin = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 4000,
  })
  try {
    await admin.query('SELECT 1')
  } catch (error) {
    await admin.end().catch(() => {})
    admin = undefined
    if (offline) {
      skipped = true
      console.error(
        '\n  THE EARNINGS LIVE TEST COULD NOT REACH A POSTGRESQL; TRIOS_PG_MIGRATE_GATE=offline, so it is a SKIP.\n',
      )
      return
    }
    throw error
  }

  scratchName = `trios_earn_${process.pid}_${randomBytes(4).toString('hex')}`
  await admin.query(`CREATE DATABASE ${scratchName}`)
  const scratch = new URL(url)
  scratch.pathname = `/${scratchName}`

  const saved = process.env.DATABASE_URL
  const savedRailway = process.env.RAILWAY_SSOT_URL
  process.env.DATABASE_URL = scratch.toString()
  delete process.env.RAILWAY_SSOT_URL
  try {
    await runPgMigrations()
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved
    if (savedRailway !== undefined) process.env.RAILWAY_SSOT_URL = savedRailway
  }

  pool = createQueenPool(scratch.toString(), { max: 1 })
  // judged_head is added by the round's own boot (queen-tick
  // ensureQueenColumns), not by MIGRATION_SQL, so a scratch database built
  // from the migration alone does not have it.
  await pool.query(
    'ALTER TABLE queen_dispatch ADD COLUMN IF NOT EXISTS judged_head text',
  )
  // The whole migration block runs here, which takes longer than bun's
  // default five-second hook budget.
}, 60_000)

afterAll(async () => {
  await pool?.end().catch(() => {})
  if (admin && scratchName) {
    await admin
      .query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`)
      .catch(() => {})
  }
  await admin?.end().catch(() => {})
})

async function dispatch(
  issue: number,
  state: string,
  head: string,
  key: number,
  paths: string[],
  reviewedAt: string,
) {
  await pool!.query(
    `INSERT INTO queen_dispatch
       (issue, branch, started, detail, owned_paths, key_index,
        review_state, reviewed_at, judged_head)
     VALUES ($1, 'b', true, 'd', $2::jsonb, $3, $4, $5, $6)
     ON CONFLICT (issue) DO UPDATE
       SET owned_paths = EXCLUDED.owned_paths, key_index = EXCLUDED.key_index,
           review_state = EXCLUDED.review_state,
           reviewed_at = EXCLUDED.reviewed_at,
           judged_head = EXCLUDED.judged_head`,
    [issue, JSON.stringify(paths), key, state, reviewedAt, head],
  )
}

async function archive(
  issue: number,
  state: string,
  head: string,
  key: number,
  paths: string[],
  reviewedAt: string,
) {
  await pool!.query(
    'INSERT INTO queen_dispatch_history (issue, snapshot) VALUES ($1, $2::jsonb)',
    [
      issue,
      JSON.stringify({
        review_state: state,
        judged_head: head,
        key_index: key,
        owned_paths: paths,
        reviewed_at: reviewedAt,
      }),
    ],
  )
}

describe('the earnings record, on a real PostgreSQL', () => {
  it('records each accepted spec commit once, revokes on take-back, and never forgets', async () => {
    if (skipped) return

    // Issue 10: accepted on h1 twice - once in an archived attempt, once live.
    // One commit, one earning, dated by the FIRST acceptance.
    await archive(10, 'accept', 'h1', 0, ['specs/a.t27'], at(1))
    await dispatch(10, 'accept', 'h1', 0, ['specs/a.t27', 'src/x.ts'], at(5))
    // Issue 11: accepted, but its boundary names no .t27 file.
    await dispatch(11, 'accept', 'h2', 1, ['src/only.ts'], at(5))
    // Issue 12: accepted only in the archive. A send-back of the same commit
    // that came BEFORE the acceptance does not revoke it.
    await archive(12, 'sendBack', 'h3', 2, ['b.t27'], at(0))
    await archive(12, 'accept', 'h3', 2, ['b.t27'], at(2))
    // Issue 13: still waiting; nothing to record.
    await dispatch(13, 'wait', 'h9', 3, ['c.t27'], at(5))

    expect(await recordEarnings(pool!, REPO)).toEqual({
      recorded: 2,
      revoked: 0,
    })
    // Idempotent: the round calls this every tick.
    expect(await recordEarnings(pool!, REPO)).toEqual({
      recorded: 0,
      revoked: 0,
    })

    let rows = await readEarnings(pool!)
    const byIssue = (issue: number) => rows.filter((r) => r.issue === issue)
    expect(rows.map((r) => r.issue).sort()).toEqual([10, 12])
    const [ten] = byIssue(10)
    expect(ten.workId).toBe(workIdOf(10, 'h1'))
    expect(ten.commit).toBe('h1')
    expect(ten.acceptedAt).toBe(at(1))
    expect(ten.revokedAt).toBeNull()
    expect(byIssue(12)[0].specPaths).toEqual(['b.t27'])

    // A CI take-back edits the live row in place: same commit, now refused.
    await dispatch(10, 'sendBack', 'h1', 0, ['specs/a.t27'], at(10))
    expect(await recordEarnings(pool!, REPO)).toEqual({
      recorded: 0,
      revoked: 1,
    })
    rows = await readEarnings(pool!)
    expect(byIssue(10)[0].revokedReason).toBe(
      'a later verdict on the same commit: sendBack',
    )
    // The earning is still there, beside its revocation.
    expect(rows).toHaveLength(2)

    // Accepting the same commit again does not resurrect it.
    await dispatch(10, 'accept', 'h1', 0, ['specs/a.t27'], at(15))
    expect(await recordEarnings(pool!, REPO)).toEqual({
      recorded: 0,
      revoked: 0,
    })
    expect(
      (await readEarnings(pool!)).find((r) => r.issue === 10)?.revokedAt,
    ).not.toBeNull()

    // A NEW commit accepted after the send-back is a new earning.
    await archive(10, 'accept', 'h1', 0, ['specs/a.t27'], at(15))
    await dispatch(10, 'accept', 'h4', 0, ['specs/a.t27'], at(20))
    expect(await recordEarnings(pool!, REPO)).toEqual({
      recorded: 1,
      revoked: 0,
    })

    const saved = process.env.TRIOS_KEY_OWNERS
    process.env.TRIOS_KEY_OWNERS = '0=@dmitrii'
    try {
      const ledger = await earningsLedger(pool!)
      expect(ledger.totals).toEqual({ earned: 2, revoked: 1 })
      expect(ledger.earners).toEqual([
        {
          name: '@dmitrii',
          claimed: true,
          github: 'dmitrii',
          keys: [0],
          earned: 1,
          revoked: 1,
        },
        { name: 'key #2', claimed: false, keys: [2], earned: 1, revoked: 0 },
      ])
      // Newest first.
      expect(ledger.recent[0].commit).toBe('h4')
    } finally {
      if (saved === undefined) delete process.env.TRIOS_KEY_OWNERS
      else process.env.TRIOS_KEY_OWNERS = saved
    }
  })
})
