import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import {
  type CheckRun,
  type CiDeps,
  ciRefusalNote,
  errorLinesOf,
  type PullRequest,
  refusedRequired,
  takeBackRefusedAcceptances,
} from '../../src/api/services/queen-ci-verdict'

/**
 * An acceptance whose pull request a required check refused is taken back.
 *
 * 2026-09-22, gHashTag/t27: #4385 was accepted, publish opened #4578, and the
 * required `parse-ratchet` refused it. The pull request sat red, the issue
 * was skipped as "the work already landed", and no bee ever saw the error.
 */

const REQUIRED = ['validate', 'check-linked-issue', 'parse-ratchet']

// The shape of the real log of #4578's parse-ratchet job.
const PARSE_RATCHET_LOG = [
  '2026-09-22T06:18:01.1023264Z ##[group]Run python3 tools/ci/check_specs_still_parse.py',
  '2026-09-22T06:18:04.0000000Z changed specs: 1; newly unparseable: 1; repaired: 0',
  "2026-09-22T06:18:04.1000000Z ##[error]this spec parsed at the base and does not now -- Error: Parse error: parse error in fn 'is_coq' near line 17: unexpected token after expression statement: Ident",
  '2026-09-22T06:18:04.2000000Z A spec that does not parse generates nothing, so every test it carries',
  '2026-09-22T06:18:04.3000000Z ##[error]Process completed with exit code 1.',
].join('\n')

const run = (
  id: number,
  name: string,
  conclusion: string | null,
  status = 'completed',
): CheckRun => ({ id, name, status, conclusion, url: `https://ci/${id}` })

describe('which required checks refused', () => {
  it('counts only required checks that completed red', () => {
    const red = refusedRequired(
      [
        run(1, 'parse-ratchet', 'failure'),
        run(2, 'validate', 'success'),
        run(3, 'coverage', 'failure'), // advisory, red on most pull requests
        run(4, 'check-linked-issue', null, 'in_progress'),
      ],
      REQUIRED,
    )
    expect(red.map((r) => r.name)).toEqual(['parse-ratchet'])
  })

  it('lets the newest run of a check decide, so a green re-run clears a red one', () => {
    expect(
      refusedRequired(
        [
          run(10, 'parse-ratchet', 'failure'),
          run(11, 'parse-ratchet', 'success'),
        ],
        REQUIRED,
      ),
    ).toEqual([])
    expect(
      refusedRequired(
        [
          run(11, 'parse-ratchet', 'success'),
          run(12, 'parse-ratchet', 'failure'),
        ],
        REQUIRED,
      ).map((r) => r.id),
    ).toEqual([12])
  })
})

describe('what the check said', () => {
  it('keeps the error line and drops the runner epilogue', () => {
    const error = errorLinesOf(PARSE_RATCHET_LOG)
    expect(error).toContain("parse error in fn 'is_coq' near line 17")
    expect(error).not.toContain('Process completed with exit code')
    expect(error).not.toContain('2026-09-22T')
  })

  it('puts the error first in the note the next bee reads', () => {
    const note = ciRefusalNote(4578, 'queen-4385', [
      {
        name: 'parse-ratchet',
        error: errorLinesOf(PARSE_RATCHET_LOG),
        url: null,
      },
    ])
    expect(note.split('\n')[0]).toBe(
      'A required check refused pull request #4578 for queen-4385:',
    )
    expect(note).toContain('- parse-ratchet: this spec parsed at the base')
    expect(note.length).toBeLessThanOrEqual(1500)
  })
})

/** A pool that answers the SELECT with `rows` and records every statement. */
function fakePool(
  rows: Array<{ issue: number; branch: string; send_backs: number }>,
) {
  const statements: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      statements.push({ sql, params })
      if (/^\s*SELECT/.test(sql)) return { rows, rowCount: rows.length }
      return { rows: [], rowCount: 1 }
    },
  }
  return { pool: pool as unknown as Pool, statements }
}

function deps(over: Partial<CiDeps> = {}): CiDeps {
  const pull: PullRequest = {
    number: 4578,
    state: 'open',
    merged: false,
    headSha: 'abc',
  }
  return {
    requiredChecks: async () => REQUIRED,
    pullsForBranch: async () => [pull],
    checkRuns: async () => [
      run(7, 'parse-ratchet', 'failure'),
      run(8, 'validate', 'success'),
    ],
    jobLog: async () => PARSE_RATCHET_LOG,
    ...over,
  }
}

const verdictWrites = (statements: Array<{ sql: string; params: unknown[] }>) =>
  statements.filter((s) => /SET review_state/.test(s.sql))

describe('taking an acceptance back', () => {
  it('turns a refused acceptance into a send-back carrying the check error', async () => {
    const { pool, statements } = fakePool([
      { issue: 4385, branch: 'queen-4385', send_backs: 0 },
    ])
    const taken = await takeBackRefusedAcceptances(pool, deps())
    expect(taken).toEqual([
      { issue: 4385, pull: 4578, state: 'sendBack', checks: ['parse-ratchet'] },
    ])
    const [write] = verdictWrites(statements)
    expect(write.params[0]).toBe(4385)
    expect(write.params[1]).toBe('sendBack')
    expect(String(write.params[2])).toContain("fn 'is_coq' near line 17")
    expect(write.params[3]).toBe(1)
    // Guarded on the state it read: a row the review moved is not overwritten.
    expect(write.sql).toContain("review_state = 'accept'")
  })

  it('escalates the refusal that reaches the send-back ceiling', async () => {
    const { pool } = fakePool([
      { issue: 4385, branch: 'queen-4385', send_backs: 1 },
    ])
    const [taken] = await takeBackRefusedAcceptances(pool, deps())
    expect(taken.state).toBe('escalate')
  })

  it('takes nothing back when the required checks cannot be read', async () => {
    const { pool, statements } = fakePool([
      { issue: 4385, branch: 'queen-4385', send_backs: 0 },
    ])
    const taken = await takeBackRefusedAcceptances(
      pool,
      deps({ requiredChecks: async () => null }),
    )
    expect(taken).toEqual([])
    expect(statements).toEqual([])
  })

  for (const [what, over] of [
    [
      'a green pull request',
      { checkRuns: async () => [run(7, 'parse-ratchet', 'success')] },
    ],
    [
      'a pending check',
      { checkRuns: async () => [run(7, 'parse-ratchet', null, 'queued')] },
    ],
    [
      'a merged pull request',
      {
        pullsForBranch: async () => [
          { number: 1, state: 'closed', merged: true, headSha: 'x' },
        ],
      },
    ],
    ['no pull request', { pullsForBranch: async () => [] }],
    ['an unreadable pull request list', { pullsForBranch: async () => null }],
    ['unreadable check runs', { checkRuns: async () => null }],
  ] as Array<[string, Partial<CiDeps>]>) {
    it(`leaves the acceptance alone for ${what}, and remembers it asked`, async () => {
      const { pool, statements } = fakePool([
        { issue: 4385, branch: 'queen-4385', send_backs: 0 },
      ])
      expect(await takeBackRefusedAcceptances(pool, deps(over))).toEqual([])
      expect(verdictWrites(statements)).toEqual([])
      expect(
        statements.some((s) => /ci_checked_at = now\(\)/.test(s.sql)),
      ).toBe(true)
    })
  }

  it('still takes it back when the log cannot be read, and says so', async () => {
    const { pool, statements } = fakePool([
      { issue: 4385, branch: 'queen-4385', send_backs: 0 },
    ])
    await takeBackRefusedAcceptances(pool, deps({ jobLog: async () => null }))
    const [write] = verdictWrites(statements)
    expect(String(write.params[2])).toContain('its log held no error line')
  })
})
