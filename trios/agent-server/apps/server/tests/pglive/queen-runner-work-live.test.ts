/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The runner hand-off, against a real PostgreSQL.
 *
 * queen-runner-work.test.ts holds the logic to its promises with a fake that
 * answers by statement shape - which proves what is SENT, not that PostgreSQL
 * accepts it or that the rows come back as the code reads them. This file runs
 * the whole life of one runner task on a scratch database built by the same
 * migration the container boots with: registered, idle, offered, claimed,
 * renewed, completed, judged ready for review - and a second one reaped.
 *
 * Like the migration gate beside it, it FAILS when no server is reachable;
 * TRIOS_PG_MIGRATE_GATE=offline turns that into a printed skip.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { Pool } from 'pg'
import {
  claimRunnerWork,
  completeRunnerWork,
  idleRunner,
  offerToRunner,
  type RunnerGit,
  reapSilentRunners,
  renewRunnerLease,
} from '../../src/api/services/queen-runner-work'
import {
  createRunner,
  heartbeatRunner,
  laneOf,
} from '../../src/api/services/queen-runners'
import { ensureQueenColumns } from '../../src/api/services/queen-tick'
import { runPgMigrations } from '../../src/lib/db/pg-migrate'
import { createQueenPool } from '../../src/lib/db/queen-pool'

const BASE = 'b'.repeat(40)
const HEAD = 'c'.repeat(40)

/** Git that agrees with everything: this file is about the SQL. */
const agreeableGit: RunnerGit = {
  root: () => '/nowhere',
  exists: () => false,
  base: async () => BASE,
  git: async (_cwd, args) =>
    args[0] === 'rev-parse' && args.includes('--quiet')
      ? { code: 1, out: '' } // no queen-<issue> branch yet
      : args[0] === 'rev-parse'
        ? { code: 0, out: HEAD }
        : { code: 0, out: '' },
}

function adminUrl(): string {
  return (
    process.env.TRIOS_PG_TEST_URL ||
    `postgres://${userInfo().username}@127.0.0.1:5432/postgres`
  )
}

const offline =
  (process.env.TRIOS_PG_MIGRATE_GATE ?? '').toLowerCase() === 'offline'

let admin: Pool
let pool: Pool
let name = ''
let skipped = false
const savedUrl = process.env.DATABASE_URL
const savedRailway = process.env.RAILWAY_SSOT_URL

beforeAll(async () => {
  admin = new Pool({
    connectionString: adminUrl(),
    max: 1,
    connectionTimeoutMillis: 4000,
  })
  try {
    await admin.query('SELECT 1')
  } catch (error) {
    if (offline) {
      skipped = true
      console.error(
        `\n  RUNNER HAND-OFF LIVE TEST SKIPPED: no PostgreSQL (${error instanceof Error ? error.message : error})\n`,
      )
      return
    }
    throw error
  }
  name = `trios_runner_${process.pid}_${randomBytes(4).toString('hex')}`
  await admin.query(`CREATE DATABASE ${name}`)
  const scratch = new URL(adminUrl())
  scratch.pathname = `/${name}`
  process.env.DATABASE_URL = scratch.toString()
  delete process.env.RAILWAY_SSOT_URL
  await runPgMigrations()
  pool = createQueenPool(scratch.toString())
  // The round adds the columns it reads before every round; the dispatch row
  // needs them as much as the offer does.
  await ensureQueenColumns(pool)
})

afterAll(async () => {
  if (savedUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = savedUrl
  if (savedRailway === undefined) delete process.env.RAILWAY_SSOT_URL
  else process.env.RAILWAY_SSOT_URL = savedRailway
  await pool?.end().catch(() => {})
  if (name) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin?.end().catch(() => {})
})

describe('one runner task, start to review', () => {
  it('is offered, claimed, renewed and handed back, then waits for the review', async () => {
    if (skipped) return
    const made = await createRunner(
      pool,
      { telegramId: '111', name: 'Alice' },
      'laptop',
    )
    if (!made.ok) throw new Error('could not create a runner')
    const id = made.runner.id

    // Never seen: not idle.
    expect(await idleRunner(pool)).toBeNull()
    expect(await heartbeatRunner(pool, made.token)).not.toBeNull()
    expect(await idleRunner(pool)).toEqual({
      id,
      lane: laneOf(id),
      label: 'laptop',
      ownerName: 'Alice',
    })

    const offered = await offerToRunner(
      pool,
      {
        issue: 4242,
        branch: 'queen-4242',
        brief: 'Do issue 4242.',
        ownedPaths: ['docs/4242.md'],
        criteria: ['the page exists'],
        criteriaSource: 'stated',
      },
      agreeableGit,
    )
    expect(offered?.started).toBe(true)
    expect(offered?.keyIndex).toBe(laneOf(id))
    // Holding a task: no longer idle.
    expect(await idleRunner(pool)).toBeNull()

    expect(await renewRunnerLease(pool, id)).toEqual({
      issue: 4242,
      conversationId: offered?.conversationId as string,
      claimed: false,
    })
    const work = await claimRunnerWork(pool, id)
    expect(work?.issue).toBe(4242)
    expect(work?.brief).toBe('Do issue 4242.')
    expect(work?.start).toEqual({ sha: BASE })
    expect(work?.ownedPaths).toEqual(['docs/4242.md'])
    expect(work?.criteria).toEqual(['the page exists'])
    // Another runner cannot claim it.
    expect(await claimRunnerWork(pool, id + 1)).toBeNull()

    const done = await completeRunnerWork(
      pool,
      id,
      {
        conversationId: offered?.conversationId as string,
        remoteUrl: 'https://github.com/alice/trios.git',
        branch: 'queen-4242',
        headSha: HEAD,
        said: '## VERDICT\n- 1. the page exists: met',
        tokens: { inputTokens: 1000, outputTokens: 200 },
      },
      {
        ...agreeableGit,
        git: async (_cwd, args) =>
          args[0] === 'rev-parse'
            ? { code: 0, out: HEAD }
            : { code: 0, out: '' },
      },
    )
    expect(done).toEqual({ ok: true, issue: 4242, closed: true })

    // What the review reads: a finished, started row with a transcript that
    // carries the verdict, no provider (nobody's spend cap counts it), and
    // the runner's push remembered for a send-back.
    const { rows } = await pool.query(
      `SELECT d.started, d.finished_at IS NOT NULL AS finished, d.outcome,
              d.provider, d.input_tokens, d.runner_head, d.runner_remote,
              (SELECT string_agg(t.text, '' ORDER BY t.seq)
                 FROM queen_transcript t
                WHERE t.conversation_id = d.conversation_id
                  AND t.kind = 'say') AS said
         FROM queen_dispatch d WHERE d.issue = 4242`,
    )
    expect(rows[0]).toEqual({
      started: true,
      finished: true,
      outcome: 'finished',
      provider: null,
      input_tokens: '1000',
      runner_head: HEAD,
      runner_remote: 'https://github.com/alice/trios.git',
      said: '## VERDICT\n- 1. the page exists: met',
    })
    // Free again.
    expect((await idleRunner(pool))?.id).toBe(id)
    // And a second completion of the same task is refused, not repeated.
    const again = await completeRunnerWork(
      pool,
      id,
      {
        conversationId: offered?.conversationId as string,
        gaveUp: true,
      },
      agreeableGit,
    )
    expect(again.ok).toBe(false)
  })

  it('reaps an offer nobody claimed, and leaves a live lease alone', async () => {
    if (skipped) return
    const made = await createRunner(
      pool,
      { telegramId: '222', name: 'Bob' },
      'desktop',
    )
    if (!made.ok) throw new Error('could not create a runner')
    await heartbeatRunner(pool, made.token)
    const offered = await offerToRunner(
      pool,
      {
        issue: 4343,
        branch: 'queen-4343',
        brief: 'Do issue 4343.',
        ownedPaths: [],
        criteria: [],
        criteriaSource: 'none',
      },
      agreeableGit,
    )
    expect(offered?.started).toBe(true)

    // Fresh: nothing to reap.
    expect(await reapSilentRunners(pool)).toEqual([])
    // Claimed with a live lease: still nothing.
    await claimRunnerWork(pool, made.runner.id)
    expect(await reapSilentRunners(pool)).toEqual([])
    // The lease goes stale: released, with the label that releases an issue.
    await pool.query(
      `UPDATE queen_dispatch SET runner_lease_at = now() - interval '1 hour'
        WHERE issue = 4343`,
    )
    expect(await reapSilentRunners(pool)).toEqual([4343])
    const { rows } = await pool.query(
      'SELECT outcome FROM queen_dispatch WHERE issue = 4343',
    )
    expect(rows[0].outcome).toMatch(/^reaped/)
  })
})
