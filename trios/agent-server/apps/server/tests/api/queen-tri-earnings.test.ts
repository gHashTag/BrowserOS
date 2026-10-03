import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'

import { createQueenPublicEarningsRoute } from '../../src/api/routes/queen-public-earnings'
import {
  EARNING_SCHEME,
  EARNINGS_STATUS,
  type Earning,
  earnersOf,
  earningByWorkId,
  earningsLedger,
  earningsOfLogin,
  recordEarnings,
  TRI_PER_SPEC,
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

  it('says in words that a mint is testnet-only and not trustless, and publishes the amount', async () => {
    const { pool } = spy()
    const ledger = await earningsLedger(pool)
    expect(ledger.status).toBe(EARNINGS_STATUS)
    expect(EARNINGS_STATUS).toContain('testnet only')
    expect(EARNINGS_STATUS).toContain('NOT trustless')
    // O2, 2026-10-01. A signer refuses any other amount.
    expect(ledger.triPerSpec).toBe(27)
    expect(TRI_PER_SPEC).toBe(27)
    expect(ledger.scheme).toBe(EARNING_SCHEME)
    expect(ledger.totals).toEqual({ earned: 0, revoked: 0 })
    // O4: the merge is checked by the signers on GitHub, not asserted here.
    expect(ledger.rules.notYet.join(' ')).toContain('merged')
    expect(ledger.rules.notYet.join(' ')).toContain('no mainnet token')
  })

  it('looks one earning up by its id and names who it is credited to', async () => {
    const seen: unknown[][] = []
    const row = {
      work_id: 'a'.repeat(64),
      repo: 'gHashTag/t27',
      issue: 5429,
      judged_head: '7808383a3ca84c8a7ec813ae0869d8f3f7dc6309',
      key_index: 6,
      spec_paths: ['specs/x.t27'],
      accepted_at: '2026-10-01T00:00:00.000Z',
      revoked_at: null,
      revoked_reason: null,
    }
    const pool = {
      query: (_text: string, params: unknown[] = []) => {
        seen.push(params)
        return Promise.resolve({ rows: params[0] === row.work_id ? [row] : [] })
      },
    } as unknown as Pool
    const found = await earningByWorkId(pool, row.work_id, { 6: '@gHashTag' })
    expect(found).toMatchObject({
      triPerSpec: 27,
      earning: { issue: 5429, commit: row.judged_head, revokedAt: null },
      earner: { name: '@gHashTag', claimed: true, github: 'gHashTag' },
    })
    expect(await earningByWorkId(pool, 'b'.repeat(64), {})).toBeNull()
    expect(seen).toEqual([[row.work_id], ['b'.repeat(64)]])
  })

  it('credits an unclaimed lane to nobody on GitHub', async () => {
    const pool = {
      query: () =>
        Promise.resolve({
          rows: [
            {
              work_id: 'c'.repeat(64),
              repo: 'r',
              issue: 1,
              judged_head: 'h',
              key_index: 21,
              spec_paths: [],
              accepted_at: '2026-10-01T00:00:00.000Z',
            },
          ],
        }),
    } as unknown as Pool
    const found = await earningByWorkId(pool, 'c'.repeat(64), {})
    expect(found?.earner).toEqual({ name: 'key #21', claimed: false })
  })
})

describe('the earnings of one GitHub login', () => {
  const owners = { 0: '@gHashTag', 1: '@dmitrii-f-t27', 6: '@gHashTag' }

  it('asks only for the keys lent under that login, case-blind', async () => {
    const seen: unknown[][] = []
    const pool = {
      query: (_text: string, params: unknown[] = []) => {
        seen.push(params)
        return Promise.resolve({
          rows: [
            {
              work_id: 'a'.repeat(64),
              repo: 'gHashTag/t27',
              issue: 5429,
              judged_head: 'h',
              key_index: 6,
              spec_paths: ['specs/x.t27'],
              accepted_at: '2026-10-01T00:00:00.000Z',
            },
          ],
        })
      },
    } as unknown as Pool
    const found = await earningsOfLogin(pool, 'ghashtag', owners)
    expect(seen).toEqual([[[0, 6]]])
    expect(found).toMatchObject({ triPerSpec: 27, github: 'ghashtag' })
    expect(found.earnings.map((e) => e.issue)).toEqual([5429])
  })

  it('answers none, without a query, for a login no key is lent under', async () => {
    const pool = {
      query: () => {
        throw new Error('should not query')
      },
    } as unknown as Pool
    expect((await earningsOfLogin(pool, 'stranger', owners)).earnings).toEqual(
      [],
    )
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

  it('refuses a malformed work id before touching any database', async () => {
    const response =
      await createQueenPublicEarningsRoute().request('/not-a-work-id')
    expect(response.status).toBe(400)
  })

  it('answers 503 for a well-formed id when there is no database', async () => {
    const response = await createQueenPublicEarningsRoute().request(
      `/${'d'.repeat(64)}`,
    )
    expect(response.status).toBe(503)
  })

  it('refuses something that is not a GitHub login before any database', async () => {
    const response =
      await createQueenPublicEarningsRoute().request('/by/-not-a-login-')
    expect(response.status).toBe(400)
  })

  it('answers 503 for a real login when there is no database', async () => {
    const response =
      await createQueenPublicEarningsRoute().request('/by/gHashTag')
    expect(response.status).toBe(503)
  })
})
