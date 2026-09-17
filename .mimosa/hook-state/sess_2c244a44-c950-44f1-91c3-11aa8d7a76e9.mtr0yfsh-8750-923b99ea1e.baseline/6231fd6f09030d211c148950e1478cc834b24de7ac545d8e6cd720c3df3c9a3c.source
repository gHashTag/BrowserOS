import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import {
  acquireQueenLease,
  queenHolderName,
  releaseQueenLease,
} from '../../src/api/services/queen-lease'

/**
 * A stand-in for Postgres that answers what Postgres would.
 *
 * These tests deliberately do NOT assert the SQL text. A test that checks the
 * query string passes when the string is right and the semantics are wrong,
 * which is the failure mode that matters here - the exclusion is a property of
 * how Postgres executes the statement, not of how it reads. What they DO pin is
 * the behaviour on either side of that statement: zero rows must mean "you did
 * not get it, and here is who did", and a contended lease must never be reported
 * as acquired.
 *
 * Exclusion itself is proven against a real database, on the deployment, by two
 * concurrent contenders.
 */
function fakePool(
  responses: Array<{ rowCount: number; rows: unknown[] }>,
): Pool {
  let call = 0
  return {
    query: async () => responses[call++] ?? { rowCount: 0, rows: [] },
  } as unknown as Pool
}

describe('queen lease', () => {
  it('reports acquisition when the insert returned a row', async () => {
    const expires = new Date('2026-08-29T12:00:00Z')
    const pool = fakePool([
      {
        rowCount: 1,
        rows: [{ holder: 'me', fence: '7', expires_at: expires }],
      },
    ])
    const grant = await acquireQueenLease(pool, 'queen-tick', 'me', 300)
    expect(grant.acquired).toBe(true)
    expect(grant.holder).toBe('me')
    expect(grant.fence).toBe(7)
  })

  // The case the whole file exists for. Zero rows back from the insert is not
  // an error and not an empty lease - it is somebody else holding it, and a
  // caller that read this as "acquired" would start a second Queen.
  it('reports the incumbent when the insert was refused', async () => {
    const expires = new Date('2026-08-29T13:00:00Z')
    const pool = fakePool([
      { rowCount: 0, rows: [] },
      {
        rowCount: 1,
        rows: [{ holder: 'the-other-one', fence: '4', expires_at: expires }],
      },
    ])
    const grant = await acquireQueenLease(pool, 'queen-tick', 'me', 300)
    expect(grant.acquired).toBe(false)
    expect(grant.holder).toBe('the-other-one')
    expect(grant.fence).toBe(4)
  })

  // A lease row that vanished between the two statements must still not read as
  // acquired. Anything else turns a race into a second supervisor.
  it('does not claim acquisition when the incumbent row is gone', async () => {
    const pool = fakePool([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
    ])
    const grant = await acquireQueenLease(pool, 'queen-tick', 'me', 300)
    expect(grant.acquired).toBe(false)
    expect(grant.holder).toBe('unknown')
  })

  it('reports a release that matched no row as not released', async () => {
    const pool = fakePool([{ rowCount: 0, rows: [] }])
    expect(await releaseQueenLease(pool, 'queen-tick', 'not-the-holder')).toBe(
      false,
    )
  })

  // A restarted process must be a NEW contender. If it came back under the same
  // name it would match the `holder = EXCLUDED.holder` renewal branch and be
  // handed a lease that a surviving instance legitimately holds.
  it('names this process distinctly from another on the same host', () => {
    const name = queenHolderName()
    expect(name).toContain(`:${process.pid}`)
    expect(name.split(':')[0].length).toBeGreaterThan(0)
  })
})
