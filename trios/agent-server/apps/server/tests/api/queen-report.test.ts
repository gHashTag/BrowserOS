import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
  classifyMounts,
  readServerSource,
} from '../../../../../tools/route-guard-audit.mjs'
import {
  createQueenReportRoute,
  createSourceLimiter,
  type QueenReportDeps,
} from '../../src/api/routes/queen-report'
import { requireTrustedAppOrigin } from '../../src/api/utils/request-auth'

// What these pin, and why each one exists:
//
//   - the route is mounted the way server.ts mounts it: inside a sub-app that
//     carries requireTrustedAppOrigin(). `/queen/needs-you` was once mounted as
//     a bare factory and answered 200 to a hostile Origin in production; a
//     route that WRITES must not repeat that.
//   - a bad body is a 400 and never reaches the database.
//   - a good body is one INSERT into queen_report with the source as a
//     `[source] ` headline prefix, and a 201 with the new id.
//   - past 60 reports per source per hour the answer is 429, per source.

const TOKEN = 'test-queen-report-token'
const savedToken = process.env.TRIOS_API_TOKEN

afterEach(() => {
  if (savedToken === undefined) delete process.env.TRIOS_API_TOKEN
  else process.env.TRIOS_API_TOKEN = savedToken
})

function recordingPool(id = 41) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  let ended = 0
  return {
    calls,
    ended: () => ended,
    pool: {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values })
        return { rowCount: 1, rows: [{ id: String(id) }] }
      },
      async end() {
        ended += 1
      },
    },
  }
}

/** The route as server.ts mounts it: the guard inside its own sub-app. */
function guarded(deps: QueenReportDeps) {
  return new Hono().route(
    '/queen/report',
    new Hono()
      .use('/*', requireTrustedAppOrigin())
      .route('/', createQueenReportRoute(deps)),
  )
}

const good = {
  source: 'relay-watch',
  headline: 'bot -> render relay: 1 of 3 roads down',
  body: 'POST /api/agent/relay answered 401 at the render guard.',
  needs_you: true,
}

function post(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` },
) {
  return app.request('http://localhost/queen/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /queen/report - the guard', () => {
  it('refuses a caller without the token and never touches the database', async () => {
    process.env.TRIOS_API_TOKEN = TOKEN
    const { calls, pool } = recordingPool()
    const app = guarded({
      databaseUrl: () => 'postgres://x',
      createPool: () => pool,
    })

    const none = await post(app, good, {})
    expect([401, 403]).toContain(none.status)

    const wrong = await post(app, good, {
      Authorization: 'Bearer test-queen-report-tokeX',
    })
    expect([401, 403]).toContain(wrong.status)
    expect(calls).toHaveLength(0)
  })

  it('does not let a hostile Origin through, with or without a token configured', async () => {
    const { calls, pool } = recordingPool()
    const app = guarded({
      databaseUrl: () => 'postgres://x',
      createPool: () => pool,
    })

    delete process.env.TRIOS_API_TOKEN
    const unconfigured = await post(app, good, {
      Origin: 'https://evil.example',
    })
    expect(unconfigured.status).toBe(403)

    process.env.TRIOS_API_TOKEN = TOKEN
    const configured = await post(app, good, {
      Origin: 'https://evil.example',
    })
    expect(configured.status).toBe(403)
    // A trusted-looking Origin is a string anyone can write.
    const spoofed = await post(app, good, {
      Origin: 'chrome-extension://browseros',
    })
    expect(spoofed.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('is mounted in server.ts inside a guarded sub-app, not as a bare factory', () => {
    const mount = classifyMounts(readServerSource()).find(
      (m: { path: string }) => m.path === '/queen/report',
    )
    expect(mount?.classification).toBe('wrapper')
    expect(mount?.via).toBe('queenReportRoutes')
  })
})

describe('POST /queen/report - the body', () => {
  const bad: Array<[string, unknown]> = [
    ['not JSON', '{nope'],
    ['an array', [good]],
    ['null', null],
    ['a missing source', { ...good, source: undefined }],
    ['an empty source', { ...good, source: '' }],
    ['an upper-case source', { ...good, source: 'Relay' }],
    ['a source with a space', { ...good, source: 'relay watch' }],
    ['a 65-char source', { ...good, source: 'a'.repeat(65) }],
    ['an empty headline', { ...good, headline: '' }],
    ['a blank headline', { ...good, headline: '   ' }],
    ['a 201-char headline', { ...good, headline: 'h'.repeat(201) }],
    ['a missing body', { ...good, body: undefined }],
    ['an 8001-char body', { ...good, body: 'b'.repeat(8001) }],
    ['a string needs_you', { ...good, needs_you: 'true' }],
    ['a missing needs_you', { ...good, needs_you: undefined }],
    ['an unknown field', { ...good, needsYou: true }],
  ]

  for (const [label, body] of bad) {
    it(`answers 400 for ${label}`, async () => {
      process.env.TRIOS_API_TOKEN = TOKEN
      const { calls, pool } = recordingPool()
      const res = await post(
        guarded({ databaseUrl: () => 'postgres://x', createPool: () => pool }),
        body,
      )
      expect(res.status).toBe(400)
      expect(calls).toHaveLength(0)
    })
  }

  it('accepts the edges: 64-char source, 200-char headline, empty and 8000-char body', async () => {
    process.env.TRIOS_API_TOKEN = TOKEN
    const { pool } = recordingPool()
    const app = guarded({
      databaseUrl: () => 'postgres://x',
      createPool: () => pool,
    })
    for (const body of [
      { ...good, source: 'a'.repeat(64) },
      { ...good, headline: 'h'.repeat(200) },
      { ...good, body: '' },
      { ...good, body: 'b'.repeat(8000) },
    ]) {
      expect((await post(app, body)).status).toBe(201)
    }
  })
})

describe('POST /queen/report - the row', () => {
  it('writes one queen_report row with the source prefixed and answers 201 {id}', async () => {
    process.env.TRIOS_API_TOKEN = TOKEN
    const rec = recordingPool(4242)
    const res = await post(
      guarded({
        databaseUrl: () => 'postgres://x',
        createPool: () => rec.pool,
      }),
      good,
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 4242 })

    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0].sql).toContain('INSERT INTO queen_report')
    expect(rec.calls[0].sql).toContain('(headline, body, needs_you)')
    expect(rec.calls[0].values).toEqual([
      '[relay-watch] bot -> render relay: 1 of 3 roads down',
      good.body,
      true,
    ])
    expect(rec.ended()).toBe(1)
  })

  it('answers 503 with a fixed sentence when the database fails, and leaks nothing', async () => {
    process.env.TRIOS_API_TOKEN = TOKEN
    let ended = 0
    const res = await post(
      guarded({
        databaseUrl: () => 'postgres://x',
        createPool: () => ({
          async query() {
            throw new Error(
              'getaddrinfo ENOTFOUND queen-postgres.railway.internal',
            )
          },
          async end() {
            ended += 1
          },
        }),
      }),
      good,
    )
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(text).toBe(JSON.stringify({ error: 'Queen report is unavailable' }))
    expect(ended).toBe(1)
  })

  it('answers 503 when no database is configured', async () => {
    process.env.TRIOS_API_TOKEN = TOKEN
    const res = await post(guarded({ databaseUrl: () => undefined }), good)
    expect(res.status).toBe(503)
  })
})

describe('POST /queen/report - the rate limit', () => {
  it('answers 429 past 60 per source per hour, and only for that source', async () => {
    process.env.TRIOS_API_TOKEN = TOKEN
    let clock = 1_000_000
    const rec = recordingPool()
    const app = guarded({
      databaseUrl: () => 'postgres://x',
      createPool: () => rec.pool,
      now: () => clock,
    })

    for (let i = 0; i < 60; i += 1) {
      expect((await post(app, good)).status).toBe(201)
      clock += 1000
    }
    const over = await post(app, good)
    expect(over.status).toBe(429)
    expect(over.headers.get('Retry-After')).toBe('3600')
    expect(rec.calls).toHaveLength(60)

    // Another source has its own hour.
    expect((await post(app, { ...good, source: 'other-watch' })).status).toBe(
      201,
    )

    // The window slides: an hour after the first report, one slot frees up.
    clock = 1_000_000 + 60 * 60 * 1000
    expect((await post(app, good)).status).toBe(201)
    expect((await post(app, good)).status).toBe(429)
  })

  it('slides its window rather than resetting on the hour', () => {
    const limiter = createSourceLimiter(2, 1000)
    expect(limiter.take('a', 0)).toBe(true)
    expect(limiter.take('a', 1)).toBe(true)
    expect(limiter.take('a', 2)).toBe(false)
    expect(limiter.take('a', 1000)).toBe(true)
  })
})
