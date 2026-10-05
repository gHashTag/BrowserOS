import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { rankIssues, topPickLine } from '../../src/api/services/queen-priority'
import {
  type OpenIssue,
  openIssues,
  rememberIssues,
} from '../../src/api/services/queen-tick'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** One GitHub issue, with only the fields the fetch reads. */
function item(number: number, isPullRequest = false) {
  return {
    number,
    title: `#${number}`,
    body: '',
    ...(isPullRequest ? { pull_request: { url: 'x' } } : {}),
  }
}

/** Serve the given pages, and record which URLs were asked for. */
function serve(pages: Array<Array<ReturnType<typeof item>>>): string[] {
  const asked: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    asked.push(url.search)
    const page = Number(url.searchParams.get('page') ?? '1')
    return {
      ok: true,
      json: async () => pages[page - 1] ?? [],
    } as Response
  }) as typeof fetch
  return asked
}

function recordingPool() {
  const statements: string[] = []
  const pool = {
    query: async (text: string) => {
      statements.push(String(text))
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, statements }
}

describe('open issue pagination', () => {
  /**
   * One page of 50 with no `page` parameter was the whole list, and the very
   * next step deletes every stored row not in it. The repository had 44 open
   * items on 2026-08-31 - 40 issues and 4 pull requests sharing the page - so
   * the horizon was six items away, and crossing it would have erased the
   * oldest backlog issues from the board on every round with no signal at all.
   */
  it('follows the pages instead of taking the first one as the list', async () => {
    const asked = serve([
      Array.from({ length: 100 }, (_, i) => item(i + 1)),
      [item(101), item(102)],
    ])
    const { issues, complete } = await openIssues('gHashTag/BrowserOS')
    expect(issues.length).toBe(102)
    expect(complete).toBe(true)
    expect(asked.length).toBe(2)
    expect(asked[1]).toContain('page=2')
  })

  /**
   * The issues endpoint returns pull requests too, and they are dropped - but a
   * page that was all pull requests is still a FULL page with more behind it.
   * Deciding on the filtered count would stop paging there and call the short
   * list complete, which is the same erasure by another route.
   */
  it('measures the page by what GitHub sent, not by what survived the filter', async () => {
    serve([
      Array.from({ length: 100 }, (_, i) => item(i + 1, true)),
      [item(101)],
    ])
    const { issues, complete } = await openIssues('gHashTag/BrowserOS')
    expect(issues.map((i) => i.number)).toEqual([101])
    expect(complete).toBe(true)
  })

  it('stops at the page cap and says the list is not everything', async () => {
    const full = () => Array.from({ length: 100 }, (_, i) => item(i + 1))
    const asked = serve([full(), full(), full(), full(), full(), full()])
    const { issues, complete } = await openIssues('gHashTag/BrowserOS')
    expect(complete).toBe(false)
    expect(asked.length).toBe(5)
    expect(issues.length).toBe(500)
  })
})

describe('remembering the issue list', () => {
  it('drops issues that closed, when it has the whole list', async () => {
    const { pool, statements } = recordingPool()
    await rememberIssues(pool, [{ number: 1, title: 't', body: '' }], true)
    expect(statements.some((s) => s.includes('DELETE FROM queen_issues'))).toBe(
      true,
    )
  })

  /**
   * "Not in the list I was given" means closed only if the list is everything.
   * Against a truncated one it means "past the horizon", and deleting on that
   * reading turns a paging limit into work vanishing off the board.
   */
  it('deletes nothing when the list was truncated', async () => {
    const { pool, statements } = recordingPool()
    await rememberIssues(pool, [{ number: 1, title: 't', body: '' }], false)
    expect(statements.some((s) => s.includes('INSERT INTO queen_issues'))).toBe(
      true,
    )
    expect(statements.some((s) => s.includes('DELETE FROM queen_issues'))).toBe(
      false,
    )
  })
})

/**
 * gHashTag/t27 specs/queen/priority.t27, as the round applies it. Each case
 * below is one of the spec's own tests or the failure it names.
 */
describe('taking open issues in priority order', () => {
  const NOW = new Date('2026-10-05T00:00:00Z')
  const daysAgo = (n: number) =>
    new Date(NOW.getTime() - n * 86_400_000).toISOString()

  /** One open issue, in the shape `openIssues` returns. */
  function open(
    number: number,
    labels: string[] = [],
    opts: { age?: number; blockedBy?: number } = {},
  ): OpenIssue {
    return {
      number,
      title: `#${number}`,
      body: '',
      labels,
      createdAt: daysAgo(opts.age ?? 1),
      blockedBy: opts.blockedBy ?? 0,
    }
  }
  /** The candidate list the round hands `queend choose`. */
  const order = (issues: OpenIssue[]) =>
    rankIssues(issues, NOW)
      .filter((r) => r.eligible)
      .map((r) => r.issue.number)

  it('keeps the listing order exactly when nothing is labelled', () => {
    const listing = [9, 7, 5, 3, 1].map((n, i) => open(n, [], { age: i * 30 }))
    expect(order(listing)).toEqual([9, 7, 5, 3, 1])
  })

  /** stokowski sorted Linear's 0 = "no priority" ahead of 1 = urgent. */
  it('never puts an unlabelled issue ahead of a P0', () => {
    const listing = [
      open(50),
      open(49, ['bug']),
      open(10, ['P0'], { age: 400 }),
    ]
    expect(order(listing)[0]).toBe(10)
    expect(order([open(50), open(11, ['priority/high'])])[0]).toBe(11)
  })

  it('runs the fourth critical of a listing as HIGH', () => {
    const listing = [
      open(1, ['P0']),
      open(2, ['priority/critical']),
      open(3, ['critical']),
      open(4, ['P0']),
      open(5, ['P1']),
    ]
    const ranked = rankIssues(listing, NOW)
    const fourth = ranked.find((r) => r.issue.number === 4)
    expect(fourth?.level).toBe(1)
    expect(fourth?.why).toBe('capped')
    // A capped critical still beats a real HIGH listed after it only by the
    // listing; it is HIGH now, and #5 is HIGH listed later.
    expect(order(listing)).toEqual([1, 2, 3, 4, 5])
  })

  it('skips an issue with an open blocker instead of waiting on it', () => {
    const listing = [open(1, ['P0'], { blockedBy: 2 }), open(2), open(3)]
    expect(order(listing)).toEqual([2, 3])
    const blocked = rankIssues(listing, NOW).find((r) => r.issue.number === 1)
    expect(blocked?.why).toBe('blocked')
  })

  /** Aging one step, not more: "low" must not become the fast lane. */
  it('never lets an aged priority/low pass unlabelled work', () => {
    const listing = [open(1, ['priority/low'], { age: 9000 }), open(2)]
    expect(order(listing)).toEqual([2, 1])
    const aged = rankIssues(listing, NOW).find((r) => r.issue.number === 1)
    expect(aged?.eff).toBe(2)
    expect(aged?.why).toBe('aged')
  })

  it('takes the more urgent label when an issue carries two', () => {
    expect(order([open(1), open(2, ['P3', 'P1'])])).toEqual([2, 1])
  })

  it('logs the top pick with its level and reason', () => {
    const line = topPickLine(
      rankIssues(
        [open(1), open(2, ['P0']), open(3, [], { blockedBy: 1 })],
        NOW,
      ),
    )
    expect(line).toContain('#2 CRITICAL')
    expect(line).toContain('why=label')
    expect(line).toContain('1 blocked skipped')
  })

  it('reads labels, age and blockers from the same GitHub response', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        json: async () => [
          {
            number: 7,
            title: 't',
            body: '',
            labels: [{ name: 'P0' }, 'P1'],
            created_at: '2026-09-01T00:00:00Z',
            issue_dependencies_summary: { blocked_by: 2 },
          },
          { number: 8, title: 'u', body: null },
        ],
      }) as Response) as typeof fetch
    const { issues } = await openIssues('gHashTag/BrowserOS')
    expect(issues[0]).toMatchObject({
      number: 7,
      labels: ['P0', 'P1'],
      createdAt: '2026-09-01T00:00:00Z',
      blockedBy: 2,
    })
    expect(issues[1]).toMatchObject({ labels: [], createdAt: '', blockedBy: 0 })
  })

  /** The vocabulary is generated, not copied: the file must say so. */
  it('imports the vocabulary from the generated module', () => {
    const dir = join(import.meta.dir, '../../src/api/services')
    const gen = readFileSync(join(dir, 'queen-priority.gen.js'), 'utf8')
    expect(
      gen.startsWith('// Generated by `t27c gen-js` from priority.t27.'),
    ).toBe(true)
    const rule = readFileSync(join(dir, 'queen-priority.ts'), 'utf8')
    expect(rule).toContain("from './queen-priority.gen'")
    expect(rule).not.toContain('priority/critical')
  })
})
