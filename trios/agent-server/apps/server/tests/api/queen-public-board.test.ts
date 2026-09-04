/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The public board through its injectable dependencies.
 *
 * /queen/public-board is one of the five routes a cross-origin browser may
 * read under the wildcard CORS middleware, so its FAILURE answers are as
 * public as its success answers. This file pins both:
 *
 *   - a database that refuses the connection gets the same fixed sentence and
 *     503 the four sibling routes answer, with `error` as a string - not the
 *     driver's own words, which name the internal hostname and would publish
 *     it to every origin on the internet;
 *   - a healthy database gets the same projection as before, byte for byte.
 *
 * The pools here are stands-in. No test in this file opens a socket: the
 * route's dependencies are injected, the way the four sibling public routes
 * already accept theirs.
 */

import { describe, expect, it } from 'bun:test'
import { createQueenPublicBoardRoute } from '../../src/api/routes/queen-kanban'
import { logger } from '../../src/lib/logger'

/**
 * A pool that answers the five queries `build` runs from canned rows, so the
 * healthy path can be asserted against data chosen here rather than against a
 * live swarm.
 */
function healthyPool(answers: {
  registry: Array<Record<string, unknown>>
  dispatches: Array<Record<string, unknown>>
  issues: Array<Record<string, unknown>>
  tick: Array<Record<string, unknown>>
  day: Array<Record<string, unknown>>
}) {
  let ended = false
  const pool = {
    query: async (sql: string) => {
      // Distinguished by substrings unique to each of the five statements,
      // because the answer shapes differ and only build knows which is which.
      if (sql.includes('FROM queen_registry')) {
        return { rowCount: answers.registry.length, rows: answers.registry }
      }
      if (sql.includes('AS rounds')) {
        return { rowCount: answers.day.length, rows: answers.day }
      }
      if (sql.includes('ORDER BY decided_at DESC')) {
        return { rowCount: answers.tick.length, rows: answers.tick }
      }
      if (sql.includes('FROM queen_issues')) {
        return { rowCount: answers.issues.length, rows: answers.issues }
      }
      return { rowCount: answers.dispatches.length, rows: answers.dispatches }
    },
    end: async () => {
      ended = true
    },
    wasEnded: () => ended,
  }
  return pool
}

/**
 * A pool whose every query rejects the way a Railway deploy does when the
 * database host is internal to a network this server is not on.
 */
function unreachablePool(message: string) {
  let ended = false
  const pool = {
    query: async () => {
      throw Object.assign(new Error(message), { code: 'ENOTFOUND' })
    },
    end: async () => {
      ended = true
    },
    wasEnded: () => ended,
  }
  return pool
}

describe('GET /queen/public-board', () => {
  it('answers a fixed 503 sentence when the database refuses the connection', async () => {
    const pool = unreachablePool(
      'getaddrinfo ENOTFOUND queen-postgres.railway.internal',
    )

    // The server keeps the diagnosis even though the public does not get it:
    // exactly one warning, carrying the real error.
    const spyLogger = logger as unknown as {
      warn: (message: string, meta?: Record<string, unknown>) => void
    }
    const originalWarn = spyLogger.warn
    const warnings: Array<[string, Record<string, unknown> | undefined]> = []
    spyLogger.warn = (message, meta) => {
      warnings.push([message, meta])
    }

    let response: Response
    let text: string
    try {
      response = await createQueenPublicBoardRoute({
        databaseUrl: () =>
          'postgres://queen:secret@queen-postgres.railway.internal/queen',
        createPool: () => pool,
      }).request('/')
      text = await response.text()
    } finally {
      spyLogger.warn = originalWarn
    }

    expect(response.status).toBe(503)
    expect(text).toBe('{"error":"Queen board is unavailable"}')
    expect(text).not.toContain('railway.internal')
    expect(text).not.toContain('ENOTFOUND')
    expect(text).not.toContain('queen-postgres')
    expect(text).not.toContain('secret')
    expect(pool.wasEnded()).toBe(true)

    expect(warnings.length).toBe(1)
    expect(warnings[0]?.[0]).toBe('Queen public board query failed')
    expect(JSON.stringify(warnings[0]?.[1] ?? null)).toContain(
      'getaddrinfo ENOTFOUND queen-postgres.railway.internal',
    )
  })

  it('answers the same public projection as before when the database is healthy', async () => {
    // Deterministic env for the three values build reads from it.
    const saved = {
      repo: process.env.TRIOS_GITHUB_REPO,
      variant: process.env.TRIOS_VARIANT,
      tick: process.env.TRIOS_QUEEN_TICK_SECONDS,
    }
    process.env.TRIOS_GITHUB_REPO = 'gHashTag/trios'
    process.env.TRIOS_VARIANT = 'prod'
    process.env.TRIOS_QUEEN_TICK_SECONDS = '300'

    const pool = healthyPool({
      registry: [
        {
          tasks: [
            {
              issue: { owner: 'gHashTag', repo: 'trios', number: 1301 },
              title: 'Ship the board',
              state: 'running',
              worker: 'zai/glm-5.3',
              ownedPaths: ['rings/SR-00/QueenReview.swift'],
            },
          ],
        },
      ],
      dispatches: [
        {
          issue: 1303,
          branch: 'queen-1303',
          started: true,
          detail: 'ran the suite',
          finished_at: '2026-09-03T09:00:00.000Z',
          outcome: 'ok',
          review_state: 'accept',
          review_note: 'landed cleanly',
          owned_paths: ['tools/deploy.sh'],
          dispatched_at: '2026-09-03T08:00:00.000Z',
        },
      ],
      issues: [
        {
          number: 1301,
          title: 'Ship the board',
          owned_paths: ['rings/SR-00/QueenReview.swift'],
          criteria: ['it ships'],
          criteria_source: 'issue',
          missing: [],
        },
        {
          number: 1302,
          title: 'Free work',
          owned_paths: ['docs/plan.md'],
          criteria: [],
          criteria_source: 'none',
          missing: ['requirements'],
        },
        {
          number: 1303,
          title: 'Cloud work',
          owned_paths: ['tools/deploy.sh'],
          criteria: ['two', 'criteria'],
          criteria_source: 'issue',
          missing: [],
        },
      ],
      tick: [
        {
          decision: { skipped: ['#1302: not yet a spec'] },
          decided_at: new Date('2026-09-04T00:00:00.000Z'),
        },
      ],
      day: [
        {
          rounds: 3,
          bees: 2,
          verdicts: 1,
          input_tokens: 1200,
          output_tokens: 3400,
        },
      ],
    })

    let response: Response
    let body: Record<string, unknown>
    try {
      response = await createQueenPublicBoardRoute({
        databaseUrl: () => 'postgres://configured',
        createPool: () => pool,
      }).request('/')
      body = (await response.json()) as Record<string, unknown>
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual({
      repo: 'gHashTag/trios',
      columns: [
        {
          key: 'backlog',
          title: 'backlog',
          blurb: 'declared a boundary, nobody on it',
        },
        { key: 'blocked', title: 'blocked', blurb: 'its files are held' },
        { key: 'running', title: 'running', blurb: 'a bee has it now' },
        {
          key: 'review',
          title: 'in review',
          blurb: 'holds its boundary until judged',
        },
        { key: 'done', title: 'done', blurb: 'accepted or merged' },
        { key: 'dropped', title: 'dropped', blurb: 'failed or cancelled' },
      ],
      cards: [
        { number: 1303, title: 'Cloud work', column: 'done', criteria: 2 },
        {
          number: 1302,
          title: 'Free work',
          column: 'backlog',
          criteria: 0,
          needs: ['requirements'],
        },
        {
          number: 1301,
          title: 'Ship the board',
          column: 'running',
          criteria: 1,
        },
      ],
      pulse: {
        rounds: 3,
        bees: 2,
        verdicts: 1,
        lastRoundAt: '2026-09-04T00:00:00.000Z',
        roundSeconds: 300,
      },
    })
    expect(pool.wasEnded()).toBe(true)

    // Operational state stays behind /queen/board, as the file's own header
    // promises: workers, paths, holders, verdicts' prose and token counts.
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('zai/glm-5.3')
    expect(serialized).not.toContain('QueenReview.swift')
    expect(serialized).not.toContain('tools/deploy.sh')
    expect(serialized).not.toContain('cloud tick')
    expect(serialized).not.toContain('landed cleanly')
    expect(serialized).not.toContain('not yet a spec')
    expect(serialized).not.toContain('lastRefusal')
    expect(serialized).not.toContain('workerKeys')
    expect(serialized).not.toContain('inputTokens')
  })
})
