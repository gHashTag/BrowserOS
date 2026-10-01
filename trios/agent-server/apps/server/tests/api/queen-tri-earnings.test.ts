import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'

import { createQueenPublicEarningsRoute } from '../../src/api/routes/queen-public-earnings'
import {
  EARNING_SCHEME,
  type Earning,
  earnersOf,
  earningsLedger,
  recordEarnings,
} from '../../src/api/services/queen-tri-earnings'

/**
 * The SQL itself is exercised against a real PostgreSQL in
 * tests/pglive/queen-tri-earnings-live.test.ts. What is pinned here is what a
 * reader can see without a database: the grouping, the parameters each query
 * is given, and the words the public answer uses about money.
 */

const earning = (
  keyIndex: number,
  commit: string,
  revoked = false,
): Earning => ({
  workId: `id-${keyIndex}-${commit}`,
  repo: 'gHashTag/trios',
  issue: 1,
  commit,
  keyIndex,
  specPaths: ['specs/a.t27'],
  acceptedAt: '2026-10-01T00:00:00.000Z',
  revokedAt: revoked ? '2026-10-01T01:00:00.000Z' : null,
  revokedReason: revoked
    ? 'a later verdict on the same commit: sendBack'
    : null,
})

describe('who earned', () => {
  it('gathers lanes by their lender and counts a revoked earning apart', () => {
    const rows = earnersOf(
      [
        earning(0, 'a'),
        earning(2, 'b'),
        earning(0, 'c', true),
        earning(5, 'd'),
      ],
      { 0: '@dmitrii', 2: '@dmitrii' },
    )
    expect(rows).toEqual([
      {
        name: '@dmitrii',
        claimed: true,
        github: 'dmitrii',
        keys: [0, 2],
        earned: 2,
        revoked: 1,
      },
      { name: 'key #5', claimed: false, keys: [5], earned: 1, revoked: 0 },
    ])
  })

  it('ranks by standing earnings, then by revoked, then by name', () => {
    const rows = earnersOf(
      [
        earning(1, 'a'),
        earning(2, 'b'),
        earning(2, 'c', true),
        earning(3, 'd'),
      ],
      {},
    )
    expect(rows.map((r) => r.name)).toEqual(['key #2', 'key #1', 'key #3'])
  })

  it('shows a lane whose only earning was taken back, rather than hiding it', () => {
    const [row] = earnersOf([earning(4, 'a', true)], {})
    expect(row).toMatchObject({ name: 'key #4', earned: 0, revoked: 1 })
  })
})

describe('what the record asks the database', () => {
  const spy = () => {
    const seen: { text: string; params: unknown[] }[] = []
    const pool = {
      query: (text: string, params: unknown[] = []) => {
        seen.push({ text, params })
        return Promise.resolve({ rows: [], rowCount: seen.length })
      },
    } as unknown as Pool
    return { pool, seen }
  }

  it('inserts under the scheme and the repository, and never overwrites', async () => {
    const { pool, seen } = spy()
    const done = await recordEarnings(pool, 'gHashTag/trios')
    expect(done).toEqual({ recorded: 1, revoked: 2 })

    const [insert, revoke] = seen
    expect(insert.params).toEqual(['gHashTag/trios', EARNING_SCHEME])
    expect(insert.text).toContain('ON CONFLICT (work_id) DO NOTHING')
    expect(insert.text).toContain("LIKE '%.t27'")
    // Both the live row and the archive, or an overwritten accept is lost.
    expect(insert.text).toContain('FROM queen_dispatch\n')
    expect(insert.text).toContain('FROM queen_dispatch_history')

    expect(revoke.params).toEqual(['gHashTag/trios'])
    // Only a verdict AFTER the acceptance revokes it, and only once.
    expect(revoke.text).toContain('r.reviewed_at > e.accepted_at')
    expect(revoke.text).toContain('e.revoked_at IS NULL')
    // The reason is the verdict's state, never its note.
    expect(revoke.text).not.toContain('review_note')
  })

  it('says in words that nothing is withdrawable, and invents no amount', async () => {
    const { pool } = spy()
    const ledger = await earningsLedger(pool)
    expect(ledger.status).toBe(
      'recorded, not withdrawable: no token is deployed',
    )
    expect(ledger.triPerSpec).toBeNull()
    expect(ledger.scheme).toBe(EARNING_SCHEME)
    expect(ledger.totals).toEqual({ earned: 0, revoked: 0 })
    expect(ledger.rules.notYet.join(' ')).toContain('does not require a merge')
  })
})

describe('the public route', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved
  })

  it('answers 503 rather than an empty ledger when there is no database', async () => {
    const response = await createQueenPublicEarningsRoute().request('/')
    expect(response.status).toBe(503)
    // An empty list would read as "nobody has earned anything".
    expect(await response.json()).toEqual({ error: 'No database configured' })
  })
})
