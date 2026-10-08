/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * EVERY TASK AND THE BEES ON THEM, against PostgreSQL (gHashTag/t27
 * specs/queen/tasks.t27). The rows are real: a dispatch a runner claimed, one
 * still queued, a job, and app reviews on a public and a private repository.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { Pool } from 'pg'
import { ensureAppTables } from '../../src/api/services/queen-app'
import { ensureJobTables } from '../../src/api/services/queen-jobs'
import {
  buildTasksView,
  parseTasksQuery,
} from '../../src/api/services/queen-tasks-view'
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
  const name = `queen_tasks_${randomBytes(6).toString('hex')}`
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

describe('the task view against Postgres', () => {
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

  const seed = async (p: Pool) => {
    await ensureQueenColumns(p)
    await p.query(
      `INSERT INTO queen_issues (number, title, state) VALUES
         (7513, 'Port gen_w310.py to t27', 'open'),
         (7500, 'Shape the board filters', 'open'),
         (7001, 'An old idea', 'open')`,
    )
    await p.query(
      `INSERT INTO queen_dispatch (issue, branch, started, detail, conversation_id, key_index, queued_at, claimed_by, claimed_at)
       VALUES (7513, 'queen-7513', true, 'claimed', 'c7513', 3, now() - interval '20 minutes', 'runner-1:42', now() - interval '19 minutes'),
              (7500, 'queen-7500', true, 'queued', 'c7500', 4, now() - interval '1 minute', NULL, NULL)`,
    )
    await p.query(
      `INSERT INTO queen_transcript (conversation_id, seq, issue, at, kind, text)
       VALUES ('c7513', 1, 7513, now() - interval '30 seconds', 'progress', 'writing')`,
    )
    await ensureJobTables(p)
    await p.query(
      `INSERT INTO queen_job (card, params, state, started_by) VALUES ('release-t27c', '{"version":"0.5.0","issue":"7700"}', 2, 'test')`,
    )
    await ensureAppTables(p)
    await p.query(
      `INSERT INTO queen_app_repo (repo, installation_id, private) VALUES ('gHashTag/trinity', 1, false), ('gHashTag/secret', 1, true)`,
    )
    await p.query(
      `INSERT INTO queen_app_review (repo, pr, head_sha, state, url) VALUES
         ('gHashTag/trinity', 12, '${'a'.repeat(40)}', 1, 'https://github.com/gHashTag/trinity/pull/12#c'),
         ('gHashTag/secret', 3, '${'b'.repeat(40)}', 1, 'https://github.com/gHashTag/secret/pull/3#c')`,
    )
  }

  it('shows issues, a job and public reviews together, with the bees on them', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await seed(pool)
    const view = await buildTasksView(pool, parseTasksQuery({}), 'gHashTag/t27')
    const keys = view.tasks.map((t) => `${t.kind}:${t.key}:${t.state}`)
    expect(keys).toContain('issue:gHashTag/t27#7513:running')
    expect(keys).toContain('job:job:1:failed')
    expect(keys.some((k) => k.startsWith('review:gHashTag/trinity#12@'))).toBe(
      true,
    )
    // a private repository is never named
    expect(JSON.stringify(view)).not.toContain('secret')
    expect(view.bees.map((b) => [b.id, b.kind, b.lane, b.state])).toEqual(
      expect.arrayContaining([
        ['b7513', 'runner', 3, 'working'],
        ['b7500', 'worker', 4, 'queued'],
      ]),
    )
    expect(view.tasks.find((t) => t.key === 'gHashTag/t27#7513')?.bee).toBe(
      'b7513',
    )
    expect(view.counts.bees).toBe(2)
  })

  it('filters by kind, state, repository and text', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    await seed(pool)
    const running = await buildTasksView(
      pool,
      parseTasksQuery({ state: 'running' }),
      'gHashTag/t27',
    )
    expect(running.tasks.every((t) => t.state === 'running')).toBe(true)
    const jobs = await buildTasksView(
      pool,
      parseTasksQuery({ kind: 'job' }),
      'gHashTag/t27',
    )
    expect(jobs.tasks.map((t) => t.kind)).toEqual(['job'])
    const trinity = await buildTasksView(
      pool,
      parseTasksQuery({ repo: 'ghashtag/TRINITY' }),
      'gHashTag/t27',
    )
    expect(trinity.tasks.map((t) => t.kind)).toEqual(['review'])
    expect(trinity.bees).toEqual([])
    const text = await buildTasksView(
      pool,
      parseTasksQuery({ q: 'filters' }),
      'gHashTag/t27',
    )
    expect(text.tasks.map((t) => t.number)).toEqual([7500])
    const one = await buildTasksView(
      pool,
      parseTasksQuery({ limit: '1' }),
      'gHashTag/t27',
    )
    expect(one.tasks).toHaveLength(1)
    expect(one.truncated).toBe(true)
    expect(one.counts.tasks).toBeGreaterThan(1)
  })
})
