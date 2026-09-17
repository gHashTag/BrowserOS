import { describe, expect, it } from 'bun:test'
import { createQueenPublicActivityRoute } from '../../src/api/routes/queen-public-activity'

function fakePool(rows: Array<Record<string, unknown>>) {
  let ended = false
  let values: unknown[] | undefined
  return {
    query: async (_sql: string, nextValues?: unknown[]) => {
      values = nextValues
      return { rowCount: rows.length, rows }
    },
    end: async () => {
      ended = true
    },
    wasEnded: () => ended,
    values: () => values,
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
})
