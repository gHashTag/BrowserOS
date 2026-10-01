/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * POST /queen/move - a person moves ONE card (t27 spec kanban-card-chat v4:
 * MOVE_DOOR_ONE_CARD, MOVE_SAYS_FROM, MOVE_ANSWER_HAS_REASON).
 *
 * The defect this door must not have is the board-only drop: a card drawn in
 * DROPPED while the next round hands the issue to a bee. So the rules are
 * pinned here, and so is the round's side - `withoutDropped` on its
 * candidates - against the same rows the board reads.
 */

import { describe, expect, it } from 'bun:test'
import { createQueenCardMoveRoute } from '../../src/api/routes/queen-card-move'
import {
  applyCardMoves,
  type CardMove,
  decideMove,
  droppedByPeople,
  MOVE_REASON_MAX,
  withoutDropped,
  writeCardMove,
} from '../../src/api/services/queen-card-move'

const move = (number: number, reason = ''): CardMove => ({
  number,
  fromColumn: 'backlog',
  reason,
  movedBy: 'owner',
  movedAt: '2026-10-01T00:00:00.000Z',
})

describe('decideMove', () => {
  const backlog = { number: 7, column: 'backlog' }

  it('drops backlog and blocked work', () => {
    expect(
      decideMove({ number: 7, from: 'backlog', to: 'dropped' }, backlog, false),
    ).toEqual({ ok: true, action: 'drop' })
    expect(
      decideMove(
        { number: 7, from: 'blocked', to: 'dropped' },
        { number: 7, column: 'blocked' },
        false,
      ),
    ).toEqual({ ok: true, action: 'drop' })
  })

  it('refuses every target a person does not own, with a reason', () => {
    for (const to of ['running', 'review', 'blocked', 'done', 'nonsense']) {
      const d = decideMove({ number: 7, from: 'backlog', to }, backlog, false)
      expect(d.ok).toBe(false)
      if (!d.ok) {
        expect(d.status).toBe(400)
        expect(d.reason.length).toBeGreaterThan(10)
      }
    }
  })

  it('refuses a card that is not on the board', () => {
    const d = decideMove(
      { number: 9, from: 'backlog', to: 'dropped' },
      undefined,
      false,
    )
    expect(d).toMatchObject({ ok: false, status: 404 })
  })

  it('refuses a tap about a column the card has left (MOVE_SAYS_FROM)', () => {
    const d = decideMove(
      { number: 7, from: 'backlog', to: 'dropped' },
      { number: 7, column: 'running' },
      false,
    )
    expect(d).toMatchObject({ ok: false, status: 409 })
    if (!d.ok) expect(d.reason).toContain('running')
  })

  it('refuses dropping work a bee or her verdict holds', () => {
    for (const column of ['running', 'review', 'done']) {
      const d = decideMove(
        { number: 7, from: column, to: 'dropped' },
        { number: 7, column },
        false,
      )
      expect(d).toMatchObject({ ok: false, status: 409 })
    }
  })

  it('refuses a move to where the card already is', () => {
    const d = decideMove(
      { number: 7, from: 'backlog', to: 'backlog' },
      backlog,
      false,
    )
    expect(d).toMatchObject({ ok: false, status: 409 })
  })

  it('takes back a person drop, never her verdict', () => {
    const dropped = { number: 7, column: 'dropped' }
    expect(
      decideMove({ number: 7, from: 'dropped', to: 'backlog' }, dropped, true),
    ).toEqual({ ok: true, action: 'undrop' })
    const hers = decideMove(
      { number: 7, from: 'dropped', to: 'backlog' },
      dropped,
      false,
    )
    expect(hers).toMatchObject({ ok: false, status: 409 })
    if (!hers.ok) expect(hers.reason).toContain('her verdict')
  })
})

describe('the board and the round read the same drops', () => {
  it('the board draws a drop on free work, with the reason', () => {
    const cards = applyCardMoves(
      [
        { number: 7, column: 'backlog' },
        { number: 8, column: 'blocked' },
        { number: 9, column: 'backlog' },
      ],
      [move(7, 'duplicate of #5'), move(8)],
    )
    expect(cards.map((c) => c.column)).toEqual([
      'dropped',
      'dropped',
      'backlog',
    ])
    expect(cards[0].detail).toBe('dropped by a person - duplicate of #5')
  })

  it('a bee already on the issue is the newer fact', () => {
    const cards = applyCardMoves(
      [
        { number: 7, column: 'running' },
        { number: 8, column: 'review' },
      ],
      [move(7), move(8)],
    )
    expect(cards.map((c) => c.column)).toEqual(['running', 'review'])
  })

  it('the round leaves dropped issues out of its candidates', () => {
    expect(withoutDropped([9, 8, 7], new Set([8]))).toEqual([9, 7])
    expect(withoutDropped([9, 8], new Set())).toEqual([9, 8])
  })

  it('both read by repository: another repo of the same number is not dropped', async () => {
    const seen: unknown[][] = []
    const pool = {
      query: async (_sql: string, values?: unknown[]) => {
        seen.push(values ?? [])
        return { rowCount: 1, rows: [{ number: 7, from_column: 'backlog' }] }
      },
    }
    expect([...(await droppedByPeople(pool, 'gHashTag/t27'))]).toEqual([7])
    expect(seen[0]).toEqual(['gHashTag/t27'])
  })
})

describe('writeCardMove is conditional', () => {
  it('a second drop of the same card is told it lost', async () => {
    const rows = new Set<string>()
    const pool = {
      query: async (sql: string, values: unknown[] = []) => {
        const key = `${values[0]}#${values[1]}`
        if (sql.startsWith('INSERT')) {
          if (rows.has(key)) return { rowCount: 0, rows: [] }
          rows.add(key)
          return { rowCount: 1, rows: [] }
        }
        return { rowCount: rows.delete(key) ? 1 : 0, rows: [] }
      },
    }
    const m = {
      repo: 'gHashTag/t27',
      number: 7,
      fromColumn: 'backlog',
      reason: '',
      by: 'a',
    }
    expect(await writeCardMove(pool, 'drop', m)).toBe(true)
    expect(await writeCardMove(pool, 'drop', m)).toBe(false)
    expect(await writeCardMove(pool, 'undrop', m)).toBe(true)
    expect(await writeCardMove(pool, 'undrop', m)).toBe(false)
  })
})

/** A board with #7 in backlog, #8 running, #9 dropped by a person. */
function boardPool() {
  const writes: string[] = []
  let ended = false
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      // Writes first: a DELETE names the same table a read does.
      if (sql.startsWith('INSERT') || sql.startsWith('DELETE')) {
        writes.push(`${sql.split(' ')[0]} ${values.slice(0, 2).join('#')}`)
        return { rowCount: 1, rows: [] }
      }
      if (sql.includes('FROM queen_card_move')) {
        return {
          rowCount: 1,
          rows: [{ number: 9, from_column: 'backlog', reason: '' }],
        }
      }
      if (sql.includes('FROM queen_registry')) {
        return {
          rowCount: 1,
          rows: [
            {
              tasks: [
                {
                  issue: { owner: 'gHashTag', repo: 't27', number: 8 },
                  title: 'In flight',
                  state: 'running',
                  worker: 'w',
                  ownedPaths: ['a.ts'],
                },
              ],
            },
          ],
        }
      }
      if (sql.includes('FROM queen_issues')) {
        return {
          rowCount: 2,
          rows: [
            { number: 7, title: 'Free', owned_paths: ['b.ts'], criteria: 3 },
            { number: 9, title: 'Dropped', owned_paths: ['c.ts'], criteria: 3 },
          ],
        }
      }
      if (sql.includes('AS rounds')) return { rowCount: 1, rows: [{}] }
      return { rowCount: 0, rows: [] }
    },
    end: async () => {
      ended = true
    },
  }
  return { pool, writes, wasEnded: () => ended }
}

function post(app: ReturnType<typeof createQueenCardMoveRoute>, body: unknown) {
  return app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /queen/move', () => {
  const withRepo =
    <T>(fn: () => Promise<T>) =>
    async () => {
      const before = process.env.TRIOS_GITHUB_REPO
      process.env.TRIOS_GITHUB_REPO = 'gHashTag/t27'
      try {
        await fn()
      } finally {
        if (before === undefined) delete process.env.TRIOS_GITHUB_REPO
        else process.env.TRIOS_GITHUB_REPO = before
      }
    }

  it(
    'drops a backlog card and says what it means',
    withRepo(async () => {
      const b = boardPool()
      const app = createQueenCardMoveRoute({
        databaseUrl: () => 'postgres://stub',
        createPool: () => b.pool,
      })
      const res = await post(app, {
        number: 7,
        from: 'backlog',
        to: 'dropped',
        reason: 'duplicate',
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { moved: boolean; reason: string }
      expect(json.moved).toBe(true)
      expect(json.reason).toContain('will not hand it to a bee')
      expect(b.writes).toEqual(['INSERT gHashTag/t27#7'])
      expect(b.wasEnded()).toBe(true)
    }),
  )

  it(
    'refuses a card a bee has, and writes nothing',
    withRepo(async () => {
      const b = boardPool()
      const app = createQueenCardMoveRoute({
        databaseUrl: () => 'postgres://stub',
        createPool: () => b.pool,
      })
      const res = await post(app, { number: 8, from: 'backlog', to: 'dropped' })
      expect(res.status).toBe(409)
      const json = (await res.json()) as { reason: string; column: string }
      expect(json.column).toBe('running')
      expect(json.reason.length).toBeGreaterThan(10)
      expect(b.writes).toEqual([])
    }),
  )

  it(
    'takes back a person drop',
    withRepo(async () => {
      const b = boardPool()
      const app = createQueenCardMoveRoute({
        databaseUrl: () => 'postgres://stub',
        createPool: () => b.pool,
      })
      const res = await post(app, { number: 9, from: 'dropped', to: 'backlog' })
      expect(res.status).toBe(200)
      expect(b.writes).toEqual(['DELETE gHashTag/t27#9'])
    }),
  )

  it(
    'refuses another repository, a long reason and a bad body before any read',
    withRepo(async () => {
      let opened = 0
      const app = createQueenCardMoveRoute({
        databaseUrl: () => 'postgres://stub',
        createPool: () => {
          opened++
          return boardPool().pool
        },
      })
      const cases: Array<[unknown, number]> = [
        [
          { number: 7, from: 'backlog', to: 'dropped', repo: 'gHashTag/trios' },
          409,
        ],
        [
          {
            number: 7,
            from: 'backlog',
            to: 'dropped',
            reason: 'x'.repeat(MOVE_REASON_MAX + 1),
          },
          400,
        ],
        [{ number: 0, from: 'backlog', to: 'dropped' }, 400],
        [{ number: 7, to: 'dropped' }, 400],
      ]
      for (const [body, status] of cases) {
        const res = await post(app, body)
        expect(res.status).toBe(status)
        const json = (await res.json()) as { moved: boolean; reason: string }
        expect(json.moved).toBe(false)
        expect(json.reason.length).toBeGreaterThan(10)
      }
      expect(opened).toBe(0)
    }),
  )

  it('a database that fails answers a fixed sentence, not pg', async () => {
    const app = createQueenCardMoveRoute({
      databaseUrl: () => 'postgres://stub',
      createPool: () => ({
        query: async () => {
          throw new Error('getaddrinfo ENOTFOUND postgres.railway.internal')
        },
        end: async () => {},
      }),
    })
    const res = await post(app, { number: 7, from: 'backlog', to: 'dropped' })
    expect(res.status).toBe(503)
    expect(await res.text()).not.toContain('railway.internal')
  })
})
