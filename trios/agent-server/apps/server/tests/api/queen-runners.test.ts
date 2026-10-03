import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'

import {
  createQueenCabinetRoute,
  createQueenRunnerRoute,
} from '../../src/api/routes/queen-runners'
import {
  type AppPerson,
  bearerOf,
  createAppIdentity,
  IdentityUnavailableError,
  personFromWhoami,
} from '../../src/api/services/queen-app-identity'
import { rank } from '../../src/api/services/queen-leaderboard'
import {
  cleanLabel,
  hashRunnerToken,
  isRunnerLane,
  laneOf,
  looksLikeRunnerToken,
  MAX_RUNNERS_PER_PERSON,
  mintRunnerToken,
  RUNNER_KEY_BASE,
  runnerOwners,
} from '../../src/api/services/queen-runners'
import {
  APP_CABINET_ORIGIN,
  appCabinetCorsMiddleware,
} from '../../src/api/utils/cors'

/**
 * A runner is a lane that runs on its lender's machine with the lender's key.
 * The server keeps only who minted which runner token, and a hash of it: these
 * tests hold it to that, and to never mixing one person's runners with
 * another's.
 */

// ---------------------------------------------------------------------------
// An in-memory queen_runner table that answers the statements the service
// sends, by shape. Anything it does not recognise fails the test loudly.
// ---------------------------------------------------------------------------
interface Row {
  id: number
  telegram_id: string
  owner_name: string
  label: string
  token_hash: string
  token_hint: string
  created_at: Date
  last_seen_at: Date | null
  revoked_at: Date | null
}

function fakePool() {
  const table: Row[] = []
  let next = 1
  const live = (tg: string) =>
    table.filter((r) => r.telegram_id === tg && r.revoked_at === null)
  const pool = {
    table,
    async query(sql: string, params: unknown[] = []) {
      if (/^\s*INSERT INTO queen_runner/.test(sql)) {
        const [tg, name, label, hash, hint, limit] = params as [
          string,
          string,
          string,
          string,
          string,
          number,
        ]
        if (live(tg).length >= limit) return { rows: [], rowCount: 0 }
        const row: Row = {
          id: next++,
          telegram_id: tg,
          owner_name: name,
          label,
          token_hash: hash,
          token_hint: hint,
          created_at: new Date('2026-10-01T00:00:00Z'),
          last_seen_at: null,
          revoked_at: null,
        }
        table.push(row)
        return { rows: [row], rowCount: 1 }
      }
      if (/^\s*SELECT id, telegram_id, owner_name, label/.test(sql)) {
        return { rows: live(params[0] as string), rowCount: 0 }
      }
      if (/^\s*UPDATE queen_runner SET revoked_at/.test(sql)) {
        const [id, tg] = params as [number, string]
        const row = table.find(
          (r) => r.id === id && r.telegram_id === tg && r.revoked_at === null,
        )
        if (row) row.revoked_at = new Date()
        return { rows: [], rowCount: row ? 1 : 0 }
      }
      if (/^\s*UPDATE queen_runner SET last_seen_at/.test(sql)) {
        const row = table.find(
          (r) => r.token_hash === params[0] && r.revoked_at === null,
        )
        if (row) row.last_seen_at = new Date()
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      // No task is open on any lane in this table: the lease renewal a
      // heartbeat sends matches nothing (queen-runner-work.test.ts has the
      // table that does).
      if (/^\s*UPDATE queen_dispatch/.test(sql))
        return { rows: [], rowCount: 0 }
      if (
        /^\s*SELECT id, telegram_id, owner_name FROM queen_runner/.test(sql)
      ) {
        return { rows: table, rowCount: table.length }
      }
      throw new Error(`fake pool: unexpected SQL ${sql}`)
    },
  }
  return pool
}

const ALICE: AppPerson = { telegramId: '111', name: 'Alice' }
const BOB: AppPerson = { telegramId: '222', name: 'Bob' }
const TOKENS: Record<string, AppPerson> = {
  'alice-session-token-0001': ALICE,
  'bob-session-token-000002': BOB,
}
const identify = async (bearer: string) => TOKENS[bearer] ?? null

function app(pool = fakePool()) {
  const deps = { pool: () => pool, identify }
  const server = new Hono()
    .use('/queen/me/*', appCabinetCorsMiddleware())
    .route('/queen/me/runners', createQueenCabinetRoute(deps))
    .route('/queen/runner', createQueenRunnerRoute(deps))
  return { server, pool }
}

const as = (bearer: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: {
    Authorization: `Bearer ${bearer}`,
    'Content-Type': 'application/json',
    ...(init.headers ?? {}),
  },
})

// ---------------------------------------------------------------------------

describe('who is asking', () => {
  it('reads telegram_id and a name out of a whoami answer', () => {
    const answer = {
      jsonrpc: '2.0',
      result: {
        structuredContent: {
          telegram_id: 144022504,
          профиль: { display_name: '  Dmitrii  ', username: 'd' },
        },
      },
    }
    expect(personFromWhoami(answer)).toEqual({
      telegramId: '144022504',
      name: 'Dmitrii',
    })
  })

  it('reads the same answer when it arrives as a JSON text block', () => {
    const answer = {
      result: {
        content: [{ type: 'text', text: '{"telegram_id":"42"}' }],
      },
    }
    expect(personFromWhoami(answer)).toEqual({
      telegramId: '42',
      name: 'tg 42',
    })
  })

  it('names nobody when the answer is an error or carries no usable id', () => {
    expect(personFromWhoami({ error: { code: -32001 } })).toBeNull()
    expect(personFromWhoami({ result: { isError: true } })).toBeNull()
    expect(
      personFromWhoami({ result: { structuredContent: { telegram_id: 'x' } } }),
    ).toBeNull()
    expect(
      personFromWhoami({ result: { structuredContent: { telegram_id: -1 } } }),
    ).toBeNull()
    expect(personFromWhoami(null)).toBeNull()
  })

  it('takes only a well-formed bearer', () => {
    expect(bearerOf('Bearer abcdefghijklmnop')).toBe('abcdefghijklmnop')
    expect(bearerOf('Basic abcdefghijklmnop')).toBeNull()
    expect(bearerOf('Bearer short')).toBeNull()
    expect(bearerOf('Bearer has space in it xx')).toBeNull()
    expect(bearerOf(undefined)).toBeNull()
  })

  it('tells a refused session from an issuer that did not answer', async () => {
    const answering = (status: number, body: unknown = {}) =>
      createAppIdentity({
        baseUrl: 'https://issuer.invalid',
        fetch: async () => ({
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
        }),
      })
    expect(await answering(401)('a-token-of-enough-length')).toBeNull()
    await expect(
      answering(502)('a-token-of-enough-length'),
    ).rejects.toBeInstanceOf(IdentityUnavailableError)
    const offline = createAppIdentity({
      baseUrl: 'https://issuer.invalid',
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    })
    await expect(offline('a-token-of-enough-length')).rejects.toBeInstanceOf(
      IdentityUnavailableError,
    )
  })

  it('asks the issuer once a minute per session, and sends the token only there', async () => {
    const calls: { url: string; auth: string }[] = []
    let now = 0
    const identifyOnce = createAppIdentity({
      baseUrl: 'https://issuer.invalid/',
      now: () => now,
      fetch: async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization })
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: { structuredContent: { telegram_id: 7 } },
          }),
        }
      },
    })
    await identifyOnce('session-token-abcdef')
    await identifyOnce('session-token-abcdef')
    expect(calls).toEqual([
      {
        url: 'https://issuer.invalid/mcp',
        auth: 'Bearer session-token-abcdef',
      },
    ])
    now = 61_000
    await identifyOnce('session-token-abcdef')
    expect(calls.length).toBe(2)
  })
})

describe('a runner token', () => {
  it('is long, random, recognisable, and stored only as a hash', () => {
    const a = mintRunnerToken()
    const b = mintRunnerToken()
    expect(a.token).not.toBe(b.token)
    expect(looksLikeRunnerToken(a.token)).toBe(true)
    expect(a.hash).toBe(hashRunnerToken(a.token))
    expect(a.hash).not.toContain(a.token)
    expect(a.hint).toBe(a.token.slice(-4))
    expect(looksLikeRunnerToken('qr_short')).toBe(false)
    expect(looksLikeRunnerToken(`sk-${'a'.repeat(43)}`)).toBe(false)
  })

  it('lives in a block of lanes no operator pool reaches', () => {
    expect(laneOf(1)).toBe(RUNNER_KEY_BASE + 1)
    expect(isRunnerLane(laneOf(1))).toBe(true)
    // The highest index an operator pool can produce well before the block.
    expect(isRunnerLane(99 * 10_000 + 9_999)).toBe(false)
  })

  it('keeps a label to a few plain words', () => {
    expect(cleanLabel('  my   laptop ')).toBe('my laptop')
    expect(cleanLabel('<script>x</script>')).toBe('scriptx/script')
    expect(cleanLabel('a\u0000b\nc')).toBe('abc')
    expect(cleanLabel('x'.repeat(100))?.length).toBe(40)
    expect(cleanLabel('   ')).toBeNull()
    expect(cleanLabel(42)).toBeNull()
  })
})

describe('the cabinet', () => {
  it('refuses anyone who is not signed in', async () => {
    const { server } = app()
    expect((await server.request('/queen/me/runners')).status).toBe(401)
    const stranger = await server.request(
      '/queen/me/runners',
      as('not-a-known-session-x'),
    )
    expect(stranger.status).toBe(401)
  })

  it('says the sign-in service is down rather than that you are signed out', async () => {
    const server = new Hono().route(
      '/queen/me/runners',
      createQueenCabinetRoute({
        pool: () => fakePool(),
        identify: async () => {
          throw new IdentityUnavailableError('http 502')
        },
      }),
    )
    const res = await server.request(
      '/queen/me/runners',
      as('alice-session-token-0001'),
    )
    expect(res.status).toBe(503)
  })

  it('mints a runner, shows its token once, and lists it without the token', async () => {
    const { server, pool } = app()
    const made = await server.request(
      '/queen/me/runners',
      as('alice-session-token-0001', {
        method: 'POST',
        body: JSON.stringify({ label: 'laptop' }),
      }),
    )
    expect(made.status).toBe(201)
    const { runner, token } = (await made.json()) as {
      runner: { id: number; lane: number; tokenHint: string; state: string }
      token: string
    }
    expect(looksLikeRunnerToken(token)).toBe(true)
    expect(runner.lane).toBe(laneOf(runner.id))
    expect(runner.tokenHint).toBe(token.slice(-4))
    expect(runner.state).toBe('never-seen')
    // What the database holds is the hash, and the owner Telegram named.
    expect(pool.table[0].token_hash).toBe(hashRunnerToken(token))
    expect(pool.table[0].owner_name).toBe('Alice')

    const listed = await server.request(
      '/queen/me/runners',
      as('alice-session-token-0001'),
    )
    const text = await listed.text()
    expect(text).not.toContain(token)
    expect(text).not.toContain(pool.table[0].token_hash)
    expect(text).not.toContain('111')
    const body = JSON.parse(text)
    expect(body.limit).toBe(MAX_RUNNERS_PER_PERSON)
    expect(body.runners.map((r: { label: string }) => r.label)).toEqual([
      'laptop',
    ])
  })

  it('refuses a runner without a name', async () => {
    const { server } = app()
    const res = await server.request(
      '/queen/me/runners',
      as('alice-session-token-0001', {
        method: 'POST',
        body: JSON.stringify({ label: '   ' }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('stops at the limit, and a revoked runner frees its place', async () => {
    const { server } = app()
    const create = () =>
      server.request(
        '/queen/me/runners',
        as('alice-session-token-0001', {
          method: 'POST',
          body: JSON.stringify({ label: 'box' }),
        }),
      )
    for (let i = 0; i < MAX_RUNNERS_PER_PERSON; i++)
      expect((await create()).status).toBe(201)
    expect((await create()).status).toBe(409)
    const revoked = await server.request(
      '/queen/me/runners/1',
      as('alice-session-token-0001', { method: 'DELETE' }),
    )
    expect(revoked.status).toBe(204)
    expect((await create()).status).toBe(201)
  })

  it('shows and revokes only your own runners', async () => {
    const { server } = app()
    await server.request(
      '/queen/me/runners',
      as('alice-session-token-0001', {
        method: 'POST',
        body: JSON.stringify({ label: 'alice box' }),
      }),
    )
    const bobsList = await server.request(
      '/queen/me/runners',
      as('bob-session-token-000002'),
    )
    expect(((await bobsList.json()) as { runners: unknown[] }).runners).toEqual(
      [],
    )
    const bobRevokes = await server.request(
      '/queen/me/runners/1',
      as('bob-session-token-000002', { method: 'DELETE' }),
    )
    expect(bobRevokes.status).toBe(404)
    const nonsense = await server.request(
      '/queen/me/runners/abc',
      as('alice-session-token-0001', { method: 'DELETE' }),
    )
    expect(nonsense.status).toBe(404)
  })
})

describe('the runner', () => {
  it('heartbeats with its token, learns its lane, and is told there is no work yet', async () => {
    const { server } = app()
    const made = await server.request(
      '/queen/me/runners',
      as('alice-session-token-0001', {
        method: 'POST',
        body: JSON.stringify({ label: 'laptop' }),
      }),
    )
    const { token, runner } = (await made.json()) as {
      token: string
      runner: { id: number }
    }
    const beat = await server.request(
      '/queen/runner/heartbeat',
      as(token, { method: 'POST' }),
    )
    expect(beat.status).toBe(200)
    const body = (await beat.json()) as {
      runner: { lane: number }
      work: unknown
      protocol: number
    }
    expect(body.runner.lane).toBe(laneOf(runner.id))
    expect(body.work).toBeNull()
    expect(body.protocol).toBe(2)

    const list = await server.request(
      '/queen/me/runners',
      as('alice-session-token-0001'),
    )
    const [shown] = ((await list.json()) as { runners: { state: string }[] })
      .runners
    expect(shown.state).toBe('online')
  })

  it('is refused once revoked, and a session token is not a runner token', async () => {
    const { server } = app()
    const made = await server.request(
      '/queen/me/runners',
      as('alice-session-token-0001', {
        method: 'POST',
        body: JSON.stringify({ label: 'laptop' }),
      }),
    )
    const { token } = (await made.json()) as { token: string }
    await server.request(
      '/queen/me/runners/1',
      as('alice-session-token-0001', { method: 'DELETE' }),
    )
    const beat = await server.request(
      '/queen/runner/heartbeat',
      as(token, { method: 'POST' }),
    )
    expect(beat.status).toBe(401)
    const wrongKind = await server.request(
      '/queen/runner/heartbeat',
      as('alice-session-token-0001', { method: 'POST' }),
    )
    expect(wrongKind.status).toBe(401)
  })
})

describe('the cabinet CORS', () => {
  it('lets exactly app.t27.ai send a bearer, without cookies', async () => {
    const { server } = app()
    const pre = await server.request('/queen/me/runners', {
      method: 'OPTIONS',
      headers: {
        Origin: APP_CABINET_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe(
      APP_CABINET_ORIGIN,
    )
    expect(pre.headers.get('access-control-allow-headers')).toContain(
      'Authorization',
    )
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('grants nothing to any other origin', async () => {
    const { server } = app()
    const res = await server.request('/queen/me/runners', {
      headers: {
        Origin: 'https://evil.example',
        Authorization: 'Bearer alice-session-token-0001',
      },
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('runner lanes on the leaderboard', () => {
  const work = (keyIndex: number, accepted: number) => ({
    keyIndex,
    accepted,
    specs: 0,
    finished: accepted,
    hours: 1,
  })

  it('gathers one person’s runners into one row, apart from operator names', () => {
    const rows = rank(
      [work(0, 1), work(laneOf(1), 2), work(laneOf(2), 1), work(laneOf(3), 1)],
      { 0: 'Dmitrii' },
      {
        [laneOf(1)]: { name: 'Dmitrii', person: '111' },
        [laneOf(2)]: { name: 'Dmitrii', person: '111' },
        [laneOf(3)]: { name: 'Bob', person: '222' },
      },
    )
    const runnerRow = rows.find((r) => r.runner && r.name === 'Dmitrii')
    const operatorRow = rows.find((r) => !r.runner && r.name === 'Dmitrii')
    expect(runnerRow?.keys).toEqual([laneOf(1), laneOf(2)])
    expect(runnerRow?.accepted).toBe(3)
    expect(operatorRow?.keys).toEqual([0])
    expect(rows.length).toBe(3)
  })

  it('never turns a runner name into a GitHub link', () => {
    const [row] = rank(
      [work(laneOf(1), 1)],
      {},
      {
        [laneOf(1)]: { name: '@torvalds', person: '111' },
      },
    )
    expect(row.github).toBeUndefined()
    expect(row.claimed).toBe(true)
  })

  it('maps every runner ever minted, revoked ones included', async () => {
    const pool = fakePool()
    pool.table.push({
      id: 5,
      telegram_id: '111',
      owner_name: 'Alice',
      label: 'old',
      token_hash: 'h',
      token_hint: 'xxxx',
      created_at: new Date(),
      last_seen_at: null,
      revoked_at: new Date(),
    })
    expect(await runnerOwners(pool)).toEqual({
      [laneOf(5)]: { name: 'Alice', person: '111' },
    })
  })
})
