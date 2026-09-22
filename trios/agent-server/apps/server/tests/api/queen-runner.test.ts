/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The parts of the handover that are this code's own logic rather than
 * PostgreSQL's. Whether two runners can take one order is the database's answer
 * and is asked of a real one in tests/pglive/queen-runner-live.test.ts.
 */
import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import {
  RUNNER_SILENT_MINUTES,
  reapStalledDispatches,
} from '../../src/api/services/queen-dispatch'
import {
  runnerName,
  runnerSlots,
  waitForEnding,
} from '../../src/api/services/queen-runner'

/** A database that returns the given rows to the reaper's SELECT and records everything. */
function reaperPool(rows: Array<{ issue: number; queued_at: Date | null }>) {
  const asked: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      asked.push({ sql: String(sql), params })
      if (
        String(sql).startsWith('SELECT issue, queued_at FROM queen_dispatch')
      ) {
        return { rowCount: rows.length, rows }
      }
      return {
        rowCount: rows.length,
        rows: rows.map(({ issue }) => ({ issue })),
      }
    },
  } as unknown as Pool
  return { pool, asked }
}

describe('the stall reaper and bees that run elsewhere', () => {
  it('releases a runner bee without reaching for a worktree this disk does not have', async () => {
    // #7 ran here; #8 was an order a runner took. Both are past the line.
    const { pool, asked } = reaperPool([
      { issue: 7, queued_at: null },
      { issue: 8, queued_at: new Date() },
    ])
    const salvaged: number[] = []
    const released = await reapStalledDispatches(pool, 120, {
      salvage: async (_pool, issue) => {
        salvaged.push(issue)
        return {
          committed: false,
          detail: 'nothing',
          left: [],
          sha: null,
          files: [],
        } as never
      },
    })
    // Both rows are released - a dead runner's issue must go back to the swarm
    // - but only the bee that ran HERE is salvaged: git on the other one's
    // worktree would be git on a directory that does not exist.
    expect(salvaged).toEqual([7])
    expect(released).toEqual([7, 8])
    const release = asked.find((q) => q.sql.includes('UPDATE queen_dispatch'))
    expect(release?.params).toEqual([120, [7, 8], RUNNER_SILENT_MINUTES])
  })

  it('counts a runner that stopped vouching as dead long before two hours', () => {
    // Forty missed renewals at fifteen seconds each. Not a slow network.
    expect(RUNNER_SILENT_MINUTES).toBeGreaterThanOrEqual(5)
    expect(RUNNER_SILENT_MINUTES).toBeLessThan(120)
  })
})

describe('a runner vouching for its bee', () => {
  it('renews its claim until the row stops matching, then stops', async () => {
    const asked: Array<{ sql: string; params: unknown[] }> = []
    let alive = 3
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        asked.push({ sql: String(sql), params })
        alive -= 1
        // Three renewals find the row; then the drain writes the ending and
        // the renewal matches nothing.
        return alive > 0 ? { rows: [{ issue: 9 }] } : { rows: [] }
      },
    } as unknown as Pool
    await waitForEnding(
      pool,
      {
        issue: 9,
        branch: 'queen-9',
        brief: '',
        ownedPaths: [],
        conversationId: 'conv-9',
        keyIndex: 0,
      },
      'runner-a',
      1,
    )
    expect(asked).toHaveLength(3)
    for (const q of asked) {
      expect(q.sql).toContain('SET claimed_at = now()')
      // Only its OWN claim, on its own turn: a re-dispatched issue belongs to
      // whoever claimed the new order.
      expect(q.params).toEqual([9, 'conv-9', 'runner-a'])
    }
  })

  it('keeps vouching through a database that blips', async () => {
    let calls = 0
    const pool = {
      query: async () => {
        calls += 1
        if (calls === 1) throw new Error('Connection terminated unexpectedly')
        return { rows: [] }
      },
    } as unknown as Pool
    await waitForEnding(
      pool,
      {
        issue: 10,
        branch: 'queen-10',
        brief: '',
        ownedPaths: [],
        conversationId: 'conv-10',
        keyIndex: 0,
      },
      'runner-a',
      1,
    )
    // One failed renewal is not a dead runner; it tried again.
    expect(calls).toBe(2)
  })
})

describe('what a runner calls itself and how much it carries', () => {
  it('says who it is, and carries one bee unless told otherwise', () => {
    const previous = {
      name: process.env.TRIOS_BEE_RUNNER_NAME,
      slots: process.env.TRIOS_BEE_RUNNER_SLOTS,
    }
    try {
      delete process.env.TRIOS_BEE_RUNNER_NAME
      delete process.env.TRIOS_BEE_RUNNER_SLOTS
      expect(runnerName()).toContain(String(process.pid))
      expect(runnerSlots()).toBe(1)
      process.env.TRIOS_BEE_RUNNER_NAME = 'replica-3'
      process.env.TRIOS_BEE_RUNNER_SLOTS = '4'
      expect(runnerName()).toBe('replica-3')
      expect(runnerSlots()).toBe(4)
      for (const bad of ['0', '-2', 'many', '1.5']) {
        process.env.TRIOS_BEE_RUNNER_SLOTS = bad
        expect(runnerSlots()).toBe(1)
      }
      process.env.TRIOS_BEE_RUNNER_SLOTS = '1000'
      expect(runnerSlots()).toBe(64)
    } finally {
      if (previous.name === undefined) delete process.env.TRIOS_BEE_RUNNER_NAME
      else process.env.TRIOS_BEE_RUNNER_NAME = previous.name
      if (previous.slots === undefined)
        delete process.env.TRIOS_BEE_RUNNER_SLOTS
      else process.env.TRIOS_BEE_RUNNER_SLOTS = previous.slots
    }
  })
})
