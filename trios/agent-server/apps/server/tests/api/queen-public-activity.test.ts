import { describe, expect, it } from 'bun:test'
import { createQueenPublicActivityRoute } from '../../src/api/routes/queen-public-activity'

function fakePool(rows: Array<Record<string, unknown>>) {
  let ended = false
  let values: unknown[] | undefined
  let sql: string | undefined
  let queries = 0
  return {
    query: async (nextSql: string, nextValues?: unknown[]) => {
      queries += 1
      sql = nextSql
      values = nextValues
      return { rowCount: rows.length, rows }
    },
    end: async () => {
      ended = true
    },
    wasEnded: () => ended,
    values: () => values,
    sql: () => sql,
    queryCount: () => queries,
  }
}

describe('GET /queen/public-activity', () => {
  it('projects live work without transcript, branch or conversation secrets', async () => {
    const pool = fakePool([
      {
        kind: 'tool',
        issue: 1290,
        title: 'A public issue title',
        at: '2026-09-01T04:17:42.983Z',
        state: null,
        seq: 7,
        text: 'cat /workspace/private-token',
        branch: 'queen-1290-secret',
        conversation_id: 'private-conversation',
      },
      {
        kind: 'review',
        issue: 1289,
        title: 'Another public title',
        at: '2026-09-01T04:18:42.983Z',
        state: 'accept',
        seq: 0,
        review_note: 'private review detail',
      },
    ])

    const response = await createQueenPublicActivityRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      now: () => Date.parse('2026-09-01T04:20:00.000Z'),
    }).request('/?since=1788236000000')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.events).toEqual([
      {
        id: 'tool-1290-1788236262983-7',
        kind: 'tool',
        issue: 1290,
        title: 'A public issue title',
        at: '2026-09-01T04:17:42.983Z',
        state: null,
      },
      {
        id: 'review-1289-1788236322983-0',
        kind: 'review',
        issue: 1289,
        title: 'Another public title',
        at: '2026-09-01T04:18:42.983Z',
        state: 'accept',
      },
    ])
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('private-token')
    expect(serialized).not.toContain('queen-1290-secret')
    expect(serialized).not.toContain('private-conversation')
    expect(serialized).not.toContain('private review detail')
    expect(pool.wasEnded()).toBe(true)
  })

  it('bounds an old cursor to one day', async () => {
    const now = Date.parse('2026-09-01T04:20:00.000Z')
    const pool = fakePool([])
    await createQueenPublicActivityRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      now: () => now,
    }).request('/?since=0')
    expect(pool.values()).toEqual([now - 86_400_000])
  })

  it('returns 503 when no Queen database is configured', async () => {
    const response = await createQueenPublicActivityRoute({
      databaseUrl: () => undefined,
    }).request('/')
    expect(response.status).toBe(503)
  })

  it('retains terminal lifecycle rows before LIMIT 120 and restores newest-first order', async () => {
    const pool = fakePool([])
    await createQueenPublicActivityRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      now: () => Date.parse('2026-09-01T04:20:00.000Z'),
    }).request('/?since=0')

    const sql = pool.sql() ?? ''
    // One bounded activity query per successful request.
    expect(pool.queryCount()).toBe(1)
    expect(pool.wasEnded()).toBe(true)

    // Terminal lifecycle kinds are ranked ahead of progress-class rows...
    const terminalRank = sql.indexOf("kind IN ('finished', 'review')")
    expect(terminalRank).toBeGreaterThan(-1)
    // ...the priority ordering feeds the 120-row bound...
    const retainedOrder = sql.indexOf(
      'ORDER BY priority ASC, at DESC, seq DESC',
    )
    expect(retainedOrder).toBeGreaterThan(terminalRank)
    const bound = sql.indexOf('LIMIT 120')
    expect(bound).toBeGreaterThan(retainedOrder)
    // ...and the bounded set is re-sorted newest-first for the response.
    const outputOrder = sql.lastIndexOf('ORDER BY at DESC, seq DESC')
    expect(outputOrder).toBeGreaterThan(bound)
  })

  it('keeps finished and review events eligible when a verbose Bee floods the window', async () => {
    // 130 transcript rows newer than the terminal facts: a plain newest-120
    // window would evict both. The prioritized query keeps the two terminal
    // rows plus the 118 newest tool rows, then re-sorts newest-first.
    const toolRows = Array.from({ length: 130 }, (_, index) => ({
      kind: 'tool',
      issue: 1304,
      title: 'A verbose Bee issue',
      at: new Date(
        Date.parse('2026-09-01T04:10:00.000Z') + index * 1000,
      ).toISOString(),
      state: null,
      seq: index + 1,
    }))
    const finishedRow = {
      kind: 'finished',
      issue: 1291,
      title: 'A landed issue',
      at: '2026-09-01T04:05:00.000Z',
      state: 'landed',
      seq: 0,
    }
    const reviewRow = {
      kind: 'review',
      issue: 1290,
      title: 'A reviewed issue',
      at: '2026-09-01T04:00:00.000Z',
      state: 'accept',
      seq: 0,
    }
    const pool = fakePool([
      ...toolRows.slice(12).reverse(),
      finishedRow,
      reviewRow,
    ])

    const response = await createQueenPublicActivityRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      now: () => Date.parse('2026-09-01T04:20:00.000Z'),
    }).request(`/?since=${Date.parse('2026-09-01T03:00:00.000Z')}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.events).toHaveLength(120)
    expect(body.events[0]).toEqual({
      id: 'tool-1304-1788235929000-130',
      kind: 'tool',
      issue: 1304,
      title: 'A verbose Bee issue',
      at: '2026-09-01T04:12:09.000Z',
      state: null,
    })
    expect(body.events[117]).toEqual({
      id: 'tool-1304-1788235812000-13',
      kind: 'tool',
      issue: 1304,
      title: 'A verbose Bee issue',
      at: '2026-09-01T04:10:12.000Z',
      state: null,
    })
    expect(body.events[118]).toEqual({
      id: 'finished-1291-1788235500000-0',
      kind: 'finished',
      issue: 1291,
      title: 'A landed issue',
      at: '2026-09-01T04:05:00.000Z',
      state: 'landed',
    })
    expect(body.events[119]).toEqual({
      id: 'review-1290-1788235200000-0',
      kind: 'review',
      issue: 1290,
      title: 'A reviewed issue',
      at: '2026-09-01T04:00:00.000Z',
      state: 'accept',
    })
    // Output stays newest-first by timestamp regardless of retention priority.
    const timestamps = body.events.map((event: { at: string }) =>
      Date.parse(event.at),
    )
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]).toBeLessThanOrEqual(timestamps[i - 1])
    }
    // No transcript payload leaks through the terminal-event guarantee.
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('conversation')
    expect(serialized).not.toContain('review_note')
  })

  it('never returns more than 120 events', async () => {
    const flood = Array.from({ length: 500 }, (_, index) => ({
      kind: 'progress',
      issue: 1305,
      title: 'Flooding issue',
      at: new Date(
        Date.parse('2026-09-01T03:30:00.000Z') + index * 1000,
      ).toISOString(),
      state: null,
      seq: index,
    }))
    const pool = fakePool(flood)

    const response = await createQueenPublicActivityRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      now: () => Date.parse('2026-09-01T04:20:00.000Z'),
    }).request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.events.length).toBeLessThanOrEqual(120)
    expect(body.events).toHaveLength(120)
    expect(
      new Set(body.events.map((event: { id: string }) => event.id)).size,
    ).toBe(120)
    expect(pool.queryCount()).toBe(1)
    expect(pool.wasEnded()).toBe(true)
  })
})
