import { afterEach, describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import { openIssues, rememberIssues } from '../../src/api/services/queen-tick'

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
