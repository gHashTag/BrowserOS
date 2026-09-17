import { describe, expect, it } from 'bun:test'
import { createQueenFeedRoute } from '../../src/api/routes/queen-feed'

/**
 * The watch page went silent on any issue that had been dispatched twice.
 *
 * Measured on the live server against issue #1244: the issue-scoped first
 * batch came back holding 500 rows from two conversations - 29e3a1de, the one
 * the dispatch names, with 433 rows and a maximum `seq` of 433, and 0781ce2f,
 * an older attempt, with 67 rows and a maximum `seq` of 677. `seq` is counted
 * per conversation, so taking the maximum over the mixed batch set the cursor
 * to 677 and pinned it to 29e3a1de, whose rows stop at 433. The replayed
 * second request returned 0 entries, and so did every one after it.
 *
 * These tests drive the real script the route serves, so they measure what a
 * browser would do rather than what the source looks like.
 */

type El = {
  id: string
  innerHTML: string
  textContent: string
  className: string
  hidden: boolean
  value: string
  checked: boolean
  children: El[]
  appendChild: (child: El) => void
  addEventListener: () => void
}

function element(id: string): El {
  const el: El = {
    id,
    innerHTML: '',
    textContent: '',
    className: '',
    hidden: false,
    value: '',
    checked: false,
    children: [],
    appendChild: (child: El) => {
      el.children.push(child)
    },
    addEventListener: () => {},
  }
  return el
}

interface FeedEntry {
  conversationId: string
  seq: number
  issue: number
  at: string
  kind: string
  text: string
}

interface FeedPayload {
  entries: FeedEntry[]
  dispatch: {
    issue: number
    branch: string
    detail: string
    conversationId: string
    finishedAt: string | null
    outcome: string | null
    dispatchedAt: string
  } | null
}

/** Let the fetch promise chain settle; a macrotask flushes all microtasks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Run the page's own script with a DOM small enough to fit in this file.
 * `responses` is consumed one per poll, the last one repeating.
 */
async function runFeedPage(responses: FeedPayload[]) {
  const html = await (await createQueenFeedRoute().request('/')).text()
  const open = html.indexOf('<script>') + '<script>'.length
  const script = html.slice(open, html.lastIndexOf('</script>'))

  const urls: string[] = []
  const els = new Map<string, El>()
  const document = {
    getElementById: (id: string) => {
      const found = els.get(id)
      if (found) return found
      const made = element(id)
      els.set(id, made)
      return made
    },
    createElement: () => element(''),
    body: { offsetHeight: 0, scrollHeight: 0 },
  }
  const emptyStore = () => {
    const held = new Map<string, string>()
    return {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => held.set(k, v),
      removeItem: (k: string) => held.delete(k),
    }
  }
  const fetchStub = (url: string) => {
    urls.push(url)
    const at = Math.min(urls.length - 1, responses.length - 1)
    return Promise.resolve({
      status: 200,
      ok: true,
      json: () => Promise.resolve(responses[at]),
    })
  }
  let poll: (() => void) | undefined
  const run = new Function(
    'document',
    'location',
    'localStorage',
    'sessionStorage',
    'fetch',
    'setInterval',
    'clearInterval',
    'scrollTo',
    'innerHeight',
    'scrollY',
    script,
  )
  run(
    document,
    { search: '?issue=1244' },
    emptyStore(),
    emptyStore(),
    fetchStub,
    (fn: () => void) => {
      poll = fn
      return 1
    },
    () => {},
    () => {},
    0,
    0,
  )
  await settle()
  return {
    urls,
    feed: () => document.getElementById('feed').children,
    pollAgain: async () => {
      poll?.()
      await settle()
    },
  }
}

const row = (
  conversationId: string,
  seq: number,
  at: string,
  text: string,
): FeedEntry => ({ conversationId, seq, issue: 1244, at, kind: 'say', text })

/** Newest first, exactly as `ORDER BY at DESC, seq DESC` hands it over. */
const retriedIssue: FeedPayload = {
  entries: [
    row('conv-new', 3, '2026-08-31T10:00:03Z', 'new-3'),
    row('conv-new', 2, '2026-08-31T10:00:02Z', 'new-2'),
    row('conv-new', 1, '2026-08-31T10:00:01Z', 'new-1'),
    row('conv-old', 677, '2026-08-30T09:00:02Z', 'old-677'),
    row('conv-old', 676, '2026-08-30T09:00:01Z', 'old-676'),
  ],
  dispatch: {
    issue: 1244,
    branch: 'queen/1244',
    detail: 'a bee',
    conversationId: 'conv-new',
    finishedAt: null,
    outcome: null,
    dispatchedAt: '2026-08-31T10:00:00Z',
  },
}

describe('the watch feed keeps polling an issue that was dispatched twice', () => {
  it('carries the cursor forward from the pinned conversation only', async () => {
    const page = await runFeedPage([retriedIssue])
    expect(page.urls[0]).toBe('/queen/feed/data?issue=1244')

    await page.pollAgain()
    // 3 is where conv-new stops. 677 belongs to conv-old and is past the end
    // of conv-new, so asking for it returns nothing for the life of the page.
    expect(page.urls[1]).toBe(
      '/queen/feed/data?issue=1244&conversation=conv-new&since=3',
    )
  })

  it('renders the first, issue-scoped batch oldest first', async () => {
    const page = await runFeedPage([retriedIssue])
    const texts = page.feed().map((el) => el.innerHTML)
    expect(texts).toHaveLength(5)
    expect(texts[0]).toContain('old-676')
    expect(texts[4]).toContain('new-3')
  })

  it('still polls by conversation when the page was opened on one', async () => {
    const page = await runFeedPage([retriedIssue])
    await page.pollAgain()
    expect(page.urls[1]).toContain('conversation=conv-new')
  })
})
