import { describe, expect, it } from 'bun:test'
import { createQueenPublicStatusRoute } from '../../src/api/routes/queen-public-status'

type QueryResult = { rowCount: number; rows: Array<Record<string, unknown>> }

function fakePool(results: QueryResult[]) {
  let at = 0
  let ended = false
  return {
    query: async () => results[at++] ?? { rowCount: 0, rows: [] },
    end: async () => {
      ended = true
    },
    wasEnded: () => ended,
  }
}

describe('GET /queen/status', () => {
  it('returns only the public runtime summary', async () => {
    const pool = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            decided_at: '2026-09-01T04:17:42.983Z',
            decision: {
              allowed: false,
              refusal: 'nothing to choose',
              skipped: ['accepted', 'awaiting review'],
              privateNote: 'must not escape',
            },
          },
        ],
      },
      {
        rowCount: 1,
        rows: [{ total: '8', finished: '8', running: '0' }],
      },
      {
        rowCount: 1,
        rows: [
          {
            issue: 1290,
            dispatched_at: '2026-08-31T17:07:16.580Z',
            finished_at: '2026-08-31T17:11:21.414Z',
            outcome: 'finished',
            branch: 'queen-1290',
            conversation_id: 'secret-conversation',
            detail: 'provider and model detail',
          },
        ],
      },
    ])

    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: () => 1800,
    }).request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      status: 'ok',
      scheduler: { enabled: true, intervalSeconds: 1800 },
      lastTick: {
        decidedAt: '2026-09-01T04:17:42.983Z',
        allowed: false,
        refusal: 'nothing to choose',
        skippedCount: 2,
      },
      dispatches: {
        total: 8,
        finished: 8,
        running: 0,
        latest: {
          issue: 1290,
          dispatchedAt: '2026-08-31T17:07:16.580Z',
          finishedAt: '2026-08-31T17:11:21.414Z',
          outcome: 'finished',
        },
      },
    })
    expect(pool.wasEnded()).toBe(true)
  })

  it('returns 503 when no Queen database is configured', async () => {
    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => undefined,
    }).request('/')
    expect(response.status).toBe(503)
  })

  it('reports an enabled scheduler only for a positive interval', async () => {
    const pool = fakePool([
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ total: '0', finished: '0', running: '0' }] },
      { rowCount: 0, rows: [] },
    ])
    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: () => 0,
    }).request('/')
    const body = await response.json()
    expect(body.scheduler).toEqual({ enabled: false, intervalSeconds: 0 })
    expect(body.lastTick).toBeNull()
    expect(body.dispatches.latest).toBeNull()
  })
})
