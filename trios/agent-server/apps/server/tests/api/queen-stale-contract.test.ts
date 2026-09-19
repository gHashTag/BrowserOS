import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import {
  releaseStaleContracts,
  stateOfDispatch,
} from '../../src/api/services/queen-tick'

/**
 * WHY THIS EXISTS. A dispatch freezes the issue's criteria so a bee is judged
 * by what it was told. When the issue is rewritten, the frozen text and the
 * live text disagree, and the verdict on that row answers a question nobody is
 * asking - while the row holds its issue and its files.
 *
 * Measured 2026-09-19: 126 open issues quoted a compiler the container does not
 * have and, in 119 of them, a criterion that prints nothing there. After they
 * were rewritten, 72 of the 86 rows still holding an issue had been judged
 * against the old text, and the tick refused 673 candidates with "nothing to
 * choose" while 84 issues sat claimed.
 */

/** Postgres, answering the two shapes the release asks for and recording them. */
function releasePool(boardRows: number, released: number[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      queries.push({ sql: text, params })
      if (text.includes('count(*)') && text.includes('queen_issues')) {
        return { rowCount: 1, rows: [{ n: String(boardRows) }] }
      }
      if (text.includes('UPDATE queen_dispatch')) {
        return {
          rowCount: released.length,
          rows: released.map((issue) => ({ issue })),
        }
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, queries }
}

describe('a row judged against criteria that have changed', () => {
  it('is released at once, with no floor to wait out', () => {
    expect(stateOfDispatch(true, 'stale-contract', { idleMs: 0 })).toBe(
      'failed',
    )
    expect(
      stateOfDispatch(true, 'stale-contract', { idleMs: 0, sendBacks: 9 }),
    ).toBe('failed')
  })

  it('is not confused with the states that DO wait', () => {
    // An empty attempt keeps its half-hour floor, a send-back its hour, and a
    // wait its six hours. Only a rewritten contract has nothing to wait for.
    expect(stateOfDispatch(true, 'empty', { idleMs: 0 })).toBe('rejected')
    expect(stateOfDispatch(true, 'sendBack', { idleMs: 0 })).toBe('rejected')
    expect(stateOfDispatch(true, 'wait', { idleMs: 0 })).toBe('awaitingReview')
    expect(stateOfDispatch(true, 'escalate', { idleMs: 9e9 })).toBe(
      'awaitingReview',
    )
  })

  it('names the rows it released, and says so once', async () => {
    const { pool, queries } = releasePool(400, [3726, 3773, 3856])
    const issues = await releaseStaleContracts(pool)
    expect(issues).toEqual([3726, 3773, 3856])
    const update = queries.find((q) => q.sql.includes('UPDATE queen_dispatch'))
    expect(update).toBeDefined()
  })

  it('compares the frozen criteria with the live ones, and only those', async () => {
    const { pool, queries } = releasePool(400, [])
    await releaseStaleContracts(pool)
    const sql =
      queries.find((q) => q.sql.includes('UPDATE queen_dispatch'))?.sql ?? ''
    // The comparison itself.
    expect(sql).toContain('i.criteria IS DISTINCT FROM d.criteria')
    // Accepted work is never re-opened, whatever the text says now.
    expect(sql).toContain("NOT IN ('accept', 'stale-contract')")
    // An issue with no criteria recorded cannot disagree with anything.
    expect(sql).toContain('jsonb_array_length(i.criteria) > 0')
    // Only a finished attempt: a bee that is writing right now is not stale.
    expect(sql).toContain('d.finished_at IS NOT NULL')
    // The counters counted attempts against a contract that no longer exists.
    expect(sql).toContain('send_backs = 0')
    expect(sql).toContain('free_attempts = 0')
  })

  it('refuses to release anything when the issue board is empty', async () => {
    // An empty board means the sync has not run in this process. Every row
    // would look stale, and the whole swarm would be released at once.
    const { pool, queries } = releasePool(0, [1, 2, 3])
    const issues = await releaseStaleContracts(pool)
    expect(issues).toEqual([])
    expect(queries.some((q) => q.sql.includes('UPDATE queen_dispatch'))).toBe(
      false,
    )
  })
})
