/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE QUEEN SHAPES ISSUES, against PostgreSQL (gHashTag/t27
 * specs/queen/shaping.t27, t27#7714).
 *
 * GitHub, the repository and the model are fakes. The database is real,
 * because "an issue is tried at most SHAPE_ATTEMPT_LIMIT times, then its
 * author is told once" and "a refused shape is not retried every round" are
 * properties of the rows. Same harness as the other pg-live suites.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { Pool } from 'pg'
import {
  advanceShaping,
  missingBits,
  type ShapeIo,
  type ShapeIssue,
  shapingStatus,
} from '../../src/api/services/queen-shaper'
import {
  SHAPE_ATTEMPT_LIMIT,
  SHAPE_RETRY_MINUTES,
} from '../../src/api/services/queen-shaping.gen'
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
  const name = `queen_shape_${randomBytes(6).toString('hex')}`
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

const GOOD = (paths: string[]) =>
  [
    '## User Scenarios',
    '- Given the spec, When gen-c runs, Then it compiles.',
    '## Requirements',
    '- FR-001: the generated C MUST compile.',
    '## Success Criteria',
    '- `./target/release/t27c gen-c specs/queen/app.t27` returns exit 0',
    '## Boundary',
    ...paths.map((p) => `- ${p}`),
  ].join('\n')

/** GitHub, the checkout and the model, as the shaper sees them. */
class FakeWorld implements ShapeIo {
  repo = new Set([
    'specs/queen/app.t27',
    'specs/queen/control.t27',
    'bootstrap/src/codegen_zig.rs',
  ])
  bodies = new Map<number, string>()
  states = new Map<number, string>()
  labels = new Map<number, string[]>()
  comments = new Map<number, string[]>()
  answers: string[] = []
  modelCalls = 0
  /** Edit the issue while the model is "thinking". */
  editDuringModel: number | null = null

  constructor(issues: ShapeIssue[]) {
    for (const i of issues) {
      this.bodies.set(i.number, i.body)
      this.states.set(i.number, 'open')
    }
  }
  async files() {
    return this.repo
  }
  llm = async () => {
    this.modelCalls += 1
    if (this.editDuringModel !== null)
      this.bodies.set(
        this.editDuringModel,
        `${this.bodies.get(this.editDuringModel)}\n(edited by a person)`,
      )
    const text = this.answers.shift() ?? 'NOT_A_TASK: no answer scripted'
    if (text === 'NOT-NOW')
      return { ok: false as const, error: '1302 busy', transient: true }
    return { ok: true as const, text, model: 'fake/model' }
  }
  async readIssue(n: number) {
    return {
      body: this.bodies.get(n) ?? '',
      state: this.states.get(n) ?? 'closed',
    }
  }
  async writeBody(n: number, body: string) {
    this.bodies.set(n, body)
  }
  async addLabel(n: number, label: string) {
    this.labels.set(n, [...(this.labels.get(n) ?? []), label])
  }
  async comment(n: number, text: string) {
    this.comments.set(n, [...(this.comments.get(n) ?? []), text])
    return `c/${n}`
  }
  async findComment(n: number, marker: string) {
    return (this.comments.get(n) ?? []).some((c) => c.includes(marker))
      ? `c/${n}`
      : null
  }
}

describe('the Queen shapes issues, against Postgres', () => {
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

  const unready: ShapeIssue = {
    number: 7703,
    title: 'gen-zig: CSE hoists an expression over a reassigned local',
    body: '## Goal\nFix the CSE pass in specs/queen/app.t27.\n\n## Boundary\n\nThe CSE pass, plus a test.\n',
    labels: [],
  }

  it('shapes an unready issue into one the rule accepts, and labels it', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const w = new FakeWorld([unready])
    w.answers.push(GOOD(['specs/queen/app.t27']))
    const r = await advanceShaping(pool, [unready], w)
    expect(r.shaped).toEqual([7703])
    const body = w.bodies.get(7703) ?? ''
    expect(missingBits(body)).toBe(0)
    expect(body.startsWith('## Goal\nFix the CSE pass')).toBe(true)
    expect(w.labels.get(7703)).toEqual(['queen-shaped'])
    const status = await shapingStatus(pool)
    expect(status.shaped).toBe(1)
    expect(status.lastRound).toMatchObject({ ready: 0, unready: 1 })
  })

  it('refuses an invented boundary path and writes nothing', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const w = new FakeWorld([unready])
    w.answers.push(GOOD(['specs/queen/invented.t27']))
    const r = await advanceShaping(pool, [unready], w)
    expect(r.shaped).toEqual([])
    expect(r.refused[0].note).toContain(
      'refused paths: specs/queen/invented.t27',
    )
    expect(w.bodies.get(7703)).toBe(unready.body)
  })

  it('accepts a new spec the issue itself cites, beside its siblings', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const issue = {
      ...unready,
      body: `${unready.body}\nAdd specs/queen/new_card.t27 for the test.\n`,
    }
    const w = new FakeWorld([issue])
    w.answers.push(GOOD(['specs/queen/app.t27', 'specs/queen/new_card.t27']))
    expect((await advanceShaping(pool, [issue], w)).shaped).toEqual([7703])
  })

  it('leaves an issue alone when a person edited it while the model thought', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const w = new FakeWorld([unready])
    w.answers.push(GOOD(['specs/queen/app.t27']))
    w.editDuringModel = 7703
    const r = await advanceShaping(pool, [unready], w)
    expect(r.refused[0].note).toContain('the body changed while shaping')
    expect(w.bodies.get(7703)).toContain('(edited by a person)')
    expect(w.bodies.get(7703)).not.toContain('queen-shaped')
  })

  it('does not count "not now" from the model as an attempt', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const w = new FakeWorld([unready])
    w.answers.push('NOT-NOW')
    await advanceShaping(pool, [unready], w)
    const row = (
      await pool.query('SELECT attempts FROM queen_shape WHERE issue = 7703')
    ).rows[0]
    expect(row.attempts).toBe(0)
  })

  it('tries at most SHAPE_ATTEMPT_LIMIT times, spaced out, then tells the author once', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const w = new FakeWorld([unready])
    let clock = Date.parse('2026-10-08T08:00:00Z')
    const now = () => clock
    w.answers.push('NOT_A_TASK: a discussion')
    await advanceShaping(pool, [unready], w, now)
    // the same round again: not due, no model call
    await advanceShaping(pool, [unready], w, now)
    expect(w.modelCalls).toBe(1)
    // the database stamps last_at with its own clock; age it past the spacing
    await pool.query(
      `UPDATE queen_shape SET last_at = now() - interval '${SHAPE_RETRY_MINUTES + 1} minutes'`,
    )
    clock = Date.now()
    w.answers.push(GOOD(['specs/queen/invented.t27']))
    await advanceShaping(pool, [unready], w, now)
    expect(w.modelCalls).toBe(SHAPE_ATTEMPT_LIMIT)
    // now the author is told, once
    const told = await advanceShaping(pool, [unready], w, now)
    expect(told.told).toEqual([7703])
    await advanceShaping(pool, [unready], w, now)
    const comments = w.comments.get(7703) ?? []
    expect(comments).toHaveLength(1)
    expect(comments[0]).toContain('The Queen cannot take this issue yet')
    expect(comments[0]).toContain('missing: ## Boundary')
    expect(w.modelCalls).toBe(SHAPE_ATTEMPT_LIMIT)
  })

  it('does not count a failure of ours as an attempt, and repairs the rows the old code left', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    // a row the first production batch left: counted, never noted
    await pool.query(
      "CREATE TABLE IF NOT EXISTS queen_shape (issue int PRIMARY KEY, attempts int NOT NULL DEFAULT 0, told boolean NOT NULL DEFAULT false, last_at timestamptz, shaped_at timestamptz, paths jsonb NOT NULL DEFAULT '[]'::jsonb, note text)",
    )
    await pool.query(
      'INSERT INTO queen_shape (issue, attempts, last_at) VALUES (7702, 1, now())',
    )
    const w = new FakeWorld([unready])
    w.files = async () => {
      throw new Error('the checkout could not be listed: dubious ownership')
    }
    const r = await advanceShaping(pool, [unready], w)
    expect(r.refused[0].note).toContain('dubious ownership')
    const rows = (
      await pool.query(
        'SELECT issue, attempts, note FROM queen_shape ORDER BY issue',
      )
    ).rows
    expect(rows).toEqual([
      { issue: 7702, attempts: 0, note: null },
      {
        issue: 7703,
        attempts: 0,
        note: expect.stringContaining('dubious ownership'),
      },
    ])
    expect(w.modelCalls).toBe(0)
  })

  it('leaves a ready issue and a container alone, and writes nothing without a writer', async () => {
    if (!pool) return expect(offlineRequested()).toBe(true)
    const ready = {
      number: 1,
      title: 'ready',
      body: GOOD(['specs/queen/app.t27']),
      labels: [],
    }
    const epic = {
      number: 2,
      title: 'an epic',
      body: 'big plans',
      labels: ['epic'],
    }
    const w = new FakeWorld([ready, epic])
    const r = await advanceShaping(pool, [ready, epic], w)
    expect(r.ready).toBe(1)
    expect(r.unready).toBe(0)
    expect(w.modelCalls).toBe(0)
    const dormant = await advanceShaping(pool, [unready], null)
    expect(dormant.blocked).toContain('no writer')
    expect(dormant.unready).toBe(1)
  })
})
