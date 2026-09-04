import { describe, expect, it } from 'bun:test'
import {
  createQueenNeedsYouRoute,
  outstandingEscalations,
} from '../../src/api/routes/queen-needs-you'

// What these pin, and why each one exists:
//
//   - the empty state is EXPLICIT. An omitted field reads as an error to a page
//     that expected it, and empty is the state a healthy swarm is in most of
//     the time.
//   - a database failure answers 503 with a fixed sentence and leaks nothing. A
//     sibling route once returned `getaddrinfo ENOTFOUND
//     queen-postgres.railway.internal` to any browser on any origin.
//   - `needsYou` counts OUTSTANDING escalations, not new ones. Of 40 recent
//     reports, zero carried the flag while six escalations waited.
//   - the age is measured from `finished_at`. `reviewed_at` is rewritten by the
//     review sweep, which is how a six-hour floor elsewhere could never be
//     reached (#109).

const rows = (r: Array<Record<string, unknown>>) => ({
  rowCount: r.length,
  rows: r,
})

function poolWith(
  escalations: Array<Record<string, unknown>>,
  reports: Array<Record<string, unknown>> = [],
) {
  const seen: string[] = []
  return {
    seen,
    pool: {
      async query(sql: string) {
        seen.push(sql)
        if (/queen_dispatch/.test(sql)) return rows(escalations)
        return rows(reports)
      },
      async end() {},
    },
  }
}

const call = async (deps: Parameters<typeof createQueenNeedsYouRoute>[0]) =>
  createQueenNeedsYouRoute(deps).request('/')

describe('createQueenNeedsYouRoute', () => {
  it('reports an empty state explicitly rather than omitting the fields', async () => {
    const { pool } = poolWith([])
    const res = await call({
      databaseUrl: () => 'postgres://x',
      createPool: () => pool,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.waiting).toEqual([])
    expect(body.waitingCount).toBe(0)
    expect(body.needsYou).toBe(false)
    expect(body.oldestHours).toBe(0)
    expect(Object.keys(body)).toContain('reports')
  })

  it('names each escalation with its age and its recorded reason', async () => {
    const { pool } = poolWith([
      {
        issue: 1244,
        send_backs: 0,
        age_hours: 89.37,
        review_note: 'no acceptance criteria',
      },
      {
        issue: 1175,
        send_backs: 2,
        age_hours: 38.4,
        review_note: 'returned twice already',
      },
    ])
    const res = await call({
      databaseUrl: () => 'postgres://x',
      createPool: () => pool,
    })
    const body = (await res.json()) as any
    expect(body.waitingCount).toBe(2)
    expect(body.needsYou).toBe(true)
    expect(body.oldestHours).toBe(89.4)
    expect(body.waiting[0]).toEqual({
      issue: 1244,
      attempts: 0,
      hoursWaiting: 89.4,
      reason: 'no acceptance criteria',
    })
  })

  it('distinguishes a reason that was never recorded from an empty one', async () => {
    const { pool } = poolWith([
      { issue: 9, send_backs: 0, age_hours: 1, review_note: null },
    ])
    const res = await call({
      databaseUrl: () => 'postgres://x',
      createPool: () => pool,
    })
    const body = (await res.json()) as any
    expect(body.waiting[0].reason).toBeNull()
  })

  it('measures age from finished_at, which nothing rewrites', async () => {
    const { seen, pool } = poolWith([])
    await call({ databaseUrl: () => 'postgres://x', createPool: () => pool })
    const dispatchQuery = seen.find((s) => /queen_dispatch/.test(s)) ?? ''
    expect(dispatchQuery).toContain('finished_at')
    // The whole point of #109: a clock the review sweep resets cannot expire.
    expect(dispatchQuery).not.toContain('reviewed_at')
  })

  it('answers 503 with a fixed sentence when the database fails, and leaks nothing', async () => {
    const secret = 'getaddrinfo ENOTFOUND queen-postgres.railway.internal'
    const res = await call({
      databaseUrl: () => 'postgres://x',
      createPool: () => ({
        async query() {
          throw new Error(secret)
        },
        async end() {},
      }),
    })
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(text).toBe(
      JSON.stringify({ error: 'Queen escalations are unavailable' }),
    )
    expect(text).not.toContain('ENOTFOUND')
    expect(text).not.toContain('railway.internal')
  })

  it('answers 503 when no database is configured at all', async () => {
    const res = await call({ databaseUrl: () => undefined })
    expect(res.status).toBe(503)
  })

  it('closes the pool on both the success and the failure path', async () => {
    let closed = 0
    const make = (fail: boolean) => ({
      async query() {
        if (fail) throw new Error('down')
        return rows([])
      },
      async end() {
        closed += 1
      },
    })
    await call({
      databaseUrl: () => 'postgres://x',
      createPool: () => make(false),
    })
    await call({
      databaseUrl: () => 'postgres://x',
      createPool: () => make(true),
    })
    expect(closed).toBe(2)
  })

  it('truncates a worker-written reason rather than trusting its length', async () => {
    const { pool } = poolWith([
      { issue: 1, send_backs: 0, age_hours: 1, review_note: 'x'.repeat(5000) },
    ])
    const res = await call({
      databaseUrl: () => 'postgres://x',
      createPool: () => pool,
    })
    const body = (await res.json()) as any
    expect(body.waiting[0].reason.length).toBe(400)
  })
})

describe('outstandingEscalations', () => {
  it('counts escalations that are still open, not those raised this round', async () => {
    let asked = ''
    const n = await outstandingEscalations({
      async query(sql: string) {
        asked = sql
        return rows([{ n: 6 }])
      },
    })
    expect(n).toBe(6)
    // The defect it replaces: the flag was set from the escalations raised in
    // the current round, so a round that raised none wrote `needs_you = false`
    // while six were outstanding.
    expect(asked).toContain("review_state = 'escalate'")
    expect(asked).not.toContain('finished_at >')
  })

  it('returns 0 rather than NaN when the count comes back empty', async () => {
    const n = await outstandingEscalations({
      async query() {
        return rows([])
      },
    })
    expect(n).toBe(0)
  })
})
