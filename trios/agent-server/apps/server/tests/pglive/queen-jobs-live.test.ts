/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A RELEASE THE QUEEN RUNS, against PostgreSQL (gHashTag/t27
 * specs/queen/jobs.t27 and control.t27 section 7, t27#7676).
 *
 * GitHub and the registry are a fake that answers what they would; the
 * database is real, because "one running job per card" and "a Queen that
 * restarts mid-publish never publishes twice" are properties of the rows.
 * Same harness as the other pg-live suites: a scratch database per test, no
 * silent skip unless TRIOS_PG_MIGRATE_GATE=offline.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { Pool } from 'pg'
import {
  advanceJobs,
  cancelJob,
  getJob,
  type JobIo,
  startJob,
} from '../../src/api/services/queen-jobs'
import {
  J_CANCELLED,
  J_DONE,
  J_FAILED,
  J_RUNNING,
} from '../../src/api/services/queen-jobs-rules'
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
  const name = `queen_jobs_${randomBytes(6).toString('hex')}`
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

const HEAD = 'a'.repeat(40)
const b64 = (s: string): string => Buffer.from(s).toString('base64')

/** GitHub and crates.io, as a release sees them. */
class FakeWorld implements JobIo {
  manifests = { cargo: '0.6.0', zenodo: '0.6.0' }
  tags = new Set<string>()
  releases = new Map<string, number>()
  crates = new Set<string>()
  workflow: { status: string; conclusion: string | null } | null = null
  token = true
  posts = 0
  crashAfterPublish = false

  async get(url: string): Promise<{ status: number; body: unknown }> {
    const u = new URL(url)
    const p = u.pathname
    if (p.endsWith('/commits/master'))
      return { status: 200, body: { sha: HEAD } }
    if (p.endsWith('/contents/bootstrap/Cargo.toml'))
      return {
        status: 200,
        body: {
          content: b64(
            `[package]\nname = "t27c"\nversion = "${this.manifests.cargo}"\n`,
          ),
        },
      }
    if (p.endsWith('/contents/.zenodo.json'))
      return {
        status: 200,
        body: {
          content: b64(JSON.stringify({ version: this.manifests.zenodo })),
        },
      }
    const tag = p.match(/\/git\/ref\/tags\/(.+)$/)
    if (tag) return { status: this.tags.has(tag[1]) ? 200 : 404, body: null }
    const rel = p.match(/\/releases\/tags\/(.+)$/)
    if (rel)
      return this.releases.has(rel[1])
        ? { status: 200, body: { id: this.releases.get(rel[1]) } }
        : { status: 404, body: null }
    const crate = p.match(/\/api\/v1\/crates\/([^/]+)\/([^/]+)$/)
    if (crate)
      return {
        status: this.crates.has(`${crate[1]}@${crate[2]}`) ? 200 : 404,
        body: null,
      }
    if (p.includes('/actions/workflows/release.yml/runs'))
      return {
        status: 200,
        body: {
          workflow_runs: this.workflow
            ? [{ ...this.workflow, html_url: 'run' }]
            : [],
        },
      }
    return { status: 404, body: null }
  }

  async postRelease(
    _url: string,
    payload: unknown,
  ): Promise<{ status: number; body: unknown }> {
    this.posts += 1
    const tag = String((payload as { tag_name: string }).tag_name)
    if (this.releases.has(tag))
      return { status: 422, body: { message: 'already_exists' } }
    this.releases.set(tag, 99)
    this.tags.add(tag)
    if (this.crashAfterPublish) throw new Error('the Queen died mid-publish')
    return { status: 201, body: { id: 99, html_url: 'release' } }
  }

  hasReleaseToken(): boolean {
    return this.token
  }
}

describe('a release the Queen runs, with no session open', () => {
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

  const begin = async (rehearsal: boolean, version = '0.6.0') => {
    const started = await startJob(
      pool as Pool,
      'release-t27c',
      { version },
      rehearsal,
      'test',
    )
    if (!started.ok) throw new Error(started.error)
    return started.job.id
  }

  it('walks a rehearsal to done and publishes nothing', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const world = new FakeWorld()
    world.token = false
    const id = await begin(true)
    await advanceJobs(pool, world)
    const job = await getJob(pool, id)
    expect(job?.state).toBe(J_DONE)
    expect(job?.subject).toBe(HEAD)
    expect(job?.log.length).toBe(5)
    expect(String(job?.note)).toContain('rehearsal')
    expect(world.posts).toBe(0)
  })

  it('publishes once, then waits for the pipeline and the registry', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const world = new FakeWorld()
    const id = await begin(false)
    await advanceJobs(pool, world)
    let job = await getJob(pool, id)
    expect(world.posts).toBe(1)
    expect(job?.state).toBe(J_RUNNING)
    expect(job?.step).toBe(3)
    world.workflow = { status: 'in_progress', conclusion: null }
    await advanceJobs(pool, world)
    expect((await getJob(pool, id))?.step).toBe(3)
    world.workflow = { status: 'completed', conclusion: 'success' }
    await advanceJobs(pool, world)
    job = await getJob(pool, id)
    expect(job?.step).toBe(4)
    world.crates.add('t27c@0.6.0')
    await advanceJobs(pool, world)
    job = await getJob(pool, id)
    expect(job?.state).toBe(J_DONE)
    expect(world.posts).toBe(1)
  })

  it('never publishes twice when the Queen dies mid-publish', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const world = new FakeWorld()
    world.crashAfterPublish = true
    const id = await begin(false)
    await advanceJobs(pool, world)
    expect(world.posts).toBe(1)
    expect((await getJob(pool, id))?.step).toBe(2)
    // the next round: the journal holds an intent, so the Queen looks first
    world.crashAfterPublish = false
    await advanceJobs(pool, world)
    const job = await getJob(pool, id)
    expect(world.posts).toBe(1)
    expect(job?.step).toBe(3)
    expect(JSON.stringify(job?.log)).toContain('journal look-up')
  })

  it('waits, visibly, for a release credential', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const world = new FakeWorld()
    world.token = false
    const id = await begin(false)
    await advanceJobs(pool, world)
    const job = await getJob(pool, id)
    expect(job?.state).toBe(J_RUNNING)
    expect(job?.step).toBe(2)
    expect(String(job?.note)).toContain('TRIOS_QUEEN_RELEASE_TOKEN')
    expect(world.posts).toBe(0)
  })

  it('fails a version the manifests do not say, publishing nothing', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const world = new FakeWorld()
    world.manifests.zenodo = '0.5.0'
    const id = await begin(false)
    for (let i = 0; i < 3; i += 1) await advanceJobs(pool, world)
    const job = await getJob(pool, id)
    expect(job?.state).toBe(J_FAILED)
    expect(String(job?.note)).toContain('.zenodo.json says 0.5.0')
    expect(world.posts).toBe(0)
  })

  it('refuses to release a tag that already exists', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const world = new FakeWorld()
    world.tags.add('t27c-v0.6.0')
    const id = await begin(false)
    for (let i = 0; i < 3; i += 1) await advanceJobs(pool, world)
    const job = await getJob(pool, id)
    expect(job?.state).toBe(J_FAILED)
    expect(String(job?.note)).toContain('already exists')
    expect(world.posts).toBe(0)
  })

  it('runs one job per card, and a cancel stops it', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const id = await begin(false)
    const second = await startJob(
      pool,
      'release-t27c',
      { version: '0.7.0' },
      false,
      'test',
    )
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.status).toBe(409)
    expect(await cancelJob(pool, id, 'test')).toBe('cancelled')
    expect((await getJob(pool, id))?.state).toBe(J_CANCELLED)
    expect(await cancelJob(pool, id, 'test')).toBe('not-running')
    const world = new FakeWorld()
    await advanceJobs(pool, world)
    expect(world.posts).toBe(0)
    // a new job of the card may start once the last one stopped
    expect(
      (await startJob(pool, 'release-t27c', { version: '0.6.0' }, true, 'test'))
        .ok,
    ).toBe(true)
  })

  it('refuses a start without its parameter', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const r = await startJob(pool, 'release-t27c', {}, true, 'test')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })
})
