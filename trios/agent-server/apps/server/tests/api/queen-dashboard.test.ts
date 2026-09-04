import { describe, expect, it } from 'bun:test'
import { createQueenDashboardRoute } from '../../src/api/routes/queen-dashboard'

/**
 * The first suite for src/api/routes/queen-dashboard.ts.
 *
 * The module exports exactly one symbol, `createQueenDashboardRoute`, which
 * builds a Hono app serving one page: an empty shell of markup, styling and a
 * script that knows how to ask `/queen/lease` for every byte of state. The
 * contract worth pinning therefore has two halves, and both are exercised
 * here through the export alone:
 *
 *  - what the route answers over HTTP (status, content type, no caching,
 *    no framing, the same empty shell to every caller), and
 *  - what the script the route serves does once a browser runs it (asks
 *    without a credential first, shows the token form on a 403, sends the
 *    pasted token as a header and never in the URL, remembers it only when
 *    asked, paints the swarm, keeps asking while connected).
 *
 * The script half is measured the way a browser would measure it: the exact
 * bytes the route serves are executed against a DOM small enough to fit in
 * this file, with `fetch`, the two web stores and `setInterval` stubbed at
 * their boundaries. Nothing here needs a database, a container or the
 * network.
 *
 * Export accounting for this module:
 *
 *   exercised by assertions: 1
 *     - createQueenDashboardRoute - every test below drives it
 *   listed as blocked by a live dependency: 0
 *
 * Nothing had to be skipped: the route runs in-process under Hono's test
 * request(), and the page's own network access is stubbed, so no export
 * needed a live dependency to be exercised. The subject was not modified.
 */

/** What `/queen/lease` says. Only the parts the page reads are modelled. */
type LeasePayload = {
  lease: { holder: string; fence: number; expiresAt: string } | null
  lastTick: {
    decidedAt: string
    decision: { chosen?: number; refusal?: string; skipped?: string[] } | null
  } | null
  dispatches?: Array<{
    issue: number
    branch: string
    started: string | null
    finishedAt: string | null
    outcome?: string | null
    detail?: string | null
  }>
}

type Reply = { status: number; body?: LeasePayload }

type El = {
  id: string
  innerHTML: string
  textContent: string
  hidden: boolean
  value: string
  checked: boolean
  addEventListener: (event: string, fn: (e: { key?: string }) => void) => void
  click: () => void
}

/** Let the page's fetch promise chains settle; a macrotask flushes them all. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A web store that records every write so tests need no key names. */
function memoryStore(which: 'local' | 'session', seed?: string) {
  const written = new Map<string, string>()
  const ops: Array<{ store: string; op: string; key: string; value?: string }> =
    []
  return {
    ops,
    getItem: (key: string) =>
      seed !== undefined ? seed : (written.get(key) ?? null),
    setItem: (key: string, value: string) => {
      written.set(key, value)
      ops.push({ store: which, op: 'set', key, value })
    },
    removeItem: (key: string) => {
      written.delete(key)
      ops.push({ store: which, op: 'remove', key })
    },
  }
}

/** Serve the shell through the real route and run the script it ships. */
async function runDashboardPage(opts: {
  replies: Reply[]
  seedLocal?: string
  seedSession?: string
  host?: string
}) {
  const html = await (await createQueenDashboardRoute().request('/')).text()
  const open = html.indexOf('<script>') + '<script>'.length
  const script = html.slice(open, html.lastIndexOf('</script>'))

  const els = new Map<string, El>()
  const listeners = new Map<string, (event: { key?: string }) => void>()
  // Elements the served document ships with the hidden attribute start out
  // hidden, exactly as a browser would parse them; the script relies on that
  // for the app section until a load succeeds.
  const startsHidden = new Set(
    [...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)]
      .filter((m) => /\bhidden\b/.test(m[0]))
      .map((m) => m[1]),
  )
  const element = (id: string): El => {
    const found = els.get(id)
    if (found) return found
    const made: El = {
      id,
      innerHTML: '',
      textContent: '',
      hidden: startsHidden.has(id),
      value: '',
      checked: false,
      addEventListener: (event, fn) => listeners.set(`${id}:${event}`, fn),
      click: () => listeners.get(`${id}:click`)?.(),
    }
    els.set(id, made)
    return made
  }
  const document = { getElementById: element }

  const local = memoryStore('local', opts.seedLocal)
  const session = memoryStore('session', opts.seedSession)

  const calls: Array<{ url: string; headers?: Record<string, string> }> = []
  const fetchStub = (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => {
    calls.push({ url, headers: init?.headers })
    const reply =
      opts.replies[Math.min(calls.length - 1, opts.replies.length - 1)]
    return Promise.resolve({
      status: reply.status,
      ok: reply.status === 200,
      json: () => Promise.resolve(reply.body ?? {}),
    })
  }

  let refresh: (() => void) | undefined
  const run = new Function(
    'document',
    'location',
    'localStorage',
    'sessionStorage',
    'fetch',
    'setInterval',
    script,
  )
  run(
    document,
    { host: opts.host ?? 'queen.t27.ai' },
    local,
    session,
    fetchStub,
    (fn: () => void) => {
      refresh = fn
      return 1
    },
  )
  await settle()

  const press = async (token: string, remember: boolean) => {
    element('token').value = token
    element('remember').checked = remember
    listeners.get('go:click')?.()
    await settle()
  }

  return {
    calls,
    local,
    session,
    el: element,
    press,
    refreshNow: async () => {
      refresh?.()
      await settle()
    },
    typeEnter: async () => {
      listeners.get('token:keydown')?.({ key: 'Enter' })
      await settle()
    },
  }
}

/** The minutes-ago helper is pinned against clock edges, so stay mid-range. */
const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString()
const secondsAhead = (s: number) =>
  new Date(Date.now() + s * 1000).toISOString()

/** One honest answer from `/queen/lease`, varied per test. */
function answering(over: Partial<LeasePayload> = {}): LeasePayload {
  return {
    lease: {
      holder: 'queen-1417 on studio',
      fence: 3,
      expiresAt: secondsAhead(90),
    },
    lastTick: {
      decidedAt: minutesAgo(5),
      decision: { chosen: 1417, skipped: [] },
    },
    dispatches: [
      {
        issue: 1417,
        branch: 'queen-1417',
        started: minutesAgo(4),
        finishedAt: null,
        detail: 'pinning the dashboard',
        outcome: null,
      },
    ],
    ...over,
  }
}

describe('queenDashboardContract', () => {
  describe('createQueenDashboardRoute', () => {
    it('serves the shell at GET /: HTML, uncached, unframed', async () => {
      const res = await createQueenDashboardRoute().request('/')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      // A cached supervisor dashboard reports a swarm that has moved on.
      expect(res.headers.get('cache-control')).toBe('no-store')
      // The shell holds a token in memory, so nothing else may frame it.
      expect(res.headers.get('x-frame-options')).toBe('DENY')

      const body = await res.text()
      expect(body).toContain('<title>Queen')
      // The token is typed into a password field, and the page says where
      // its state comes from: the guarded lease endpoint, not this shell.
      expect(body).toContain('type="password"')
      expect(body).toContain('/queen/lease')
      expect(body).toContain('/queen/kanban')
      expect(body).toContain('/queen/tree')
    })

    it('serves the same empty shell to every caller and nothing else', async () => {
      const app = createQueenDashboardRoute()
      const first = await (await app.request('/')).text()
      const second = await (await app.request('/')).text()
      expect(first).toBe(second)
      // The lease slot ships as the placeholder, not as baked-in state.
      expect(second).toContain('id="lease">&#8212;')
      // Only the shell itself lives here; anything deeper is not served.
      expect((await app.request('/state')).status).toBe(404)
    })

    it('asks /queen/lease on load, with no credential first', async () => {
      const page = await runDashboardPage({
        replies: [{ status: 200, body: answering() }],
      })
      expect(page.calls[0]?.url).toBe('/queen/lease')
      // A local dev server has no token configured, so the first ask is bare.
      expect(page.calls[0]?.headers).toBeUndefined()
      // Once it answers, the form is gone and the swarm is on screen.
      expect(page.el('auth').hidden).toBe(true)
      expect(page.el('app').hidden).toBe(false)
      expect(page.el('err').textContent).toBe('')
      expect(page.el('stamp').textContent).toContain('refreshed ')
    })

    it('paints a held lease with its holder and term', async () => {
      const page = await runDashboardPage({
        replies: [{ status: 200, body: answering() }],
      })
      const lease = page.el('lease').innerHTML
      expect(lease).toContain('queen-1417 on studio')
      expect(lease).toContain('term 3')
    })

    it('calls a lease past its expiry free between rounds', async () => {
      const stale = answering({
        lease: {
          holder: 'a supervisor that stopped hours ago',
          fence: 7,
          expiresAt: minutesAgo(60),
        },
      })
      const page = await runDashboardPage({
        replies: [{ status: 200, body: stale }],
      })
      const lease = page.el('lease').innerHTML
      expect(lease).toContain('free between rounds')
      // Printing the last holder without checking the clock is the bug this
      // card exists not to have.
      expect(lease).not.toContain('a supervisor that stopped hours ago')
      expect(lease).not.toContain('term 7')
    })

    it('escapes whatever the lease says before it becomes markup', async () => {
      const hostile = answering({
        lease: {
          holder: '<script>alert(1)</script>',
          fence: 1,
          expiresAt: secondsAhead(90),
        },
      })
      const page = await runDashboardPage({
        replies: [{ status: 200, body: hostile }],
      })
      const lease = page.el('lease').innerHTML
      expect(lease).toContain('&lt;script&gt;')
      expect(lease).not.toContain('<script>')
    })

    it('shows when the last round decided and what it chose', async () => {
      const page = await runDashboardPage({
        replies: [{ status: 200, body: answering() }],
      })
      expect(page.el('tick').innerHTML).toContain('5m ago')
      expect(page.el('decision').innerHTML).toContain('#1417')
    })

    it('shows a refusal instead of a choice when nothing was dispatched', async () => {
      const refused = answering({
        lastTick: {
          decidedAt: minutesAgo(9),
          decision: { chosen: undefined, refusal: 'nothing to choose' },
        },
      })
      const page = await runDashboardPage({
        replies: [{ status: 200, body: refused }],
      })
      expect(page.el('tick').innerHTML).toContain('9m ago')
      expect(page.el('decision').innerHTML).toContain('nothing to choose')
      expect(page.el('decision').innerHTML).not.toContain('#')
    })

    it('says never when no round has decided yet', async () => {
      const page = await runDashboardPage({
        replies: [{ status: 200, body: answering({ lastTick: null }) }],
      })
      expect(page.el('tick').innerHTML).toContain('never')
      expect(page.el('decision').innerHTML).toContain('&#8212;')
    })

    it('counts only running dispatches as in flight and states each row', async () => {
      const busy = answering({
        dispatches: [
          {
            issue: 1401,
            branch: 'queen-1401',
            started: minutesAgo(30),
            finishedAt: minutesAgo(2),
            detail: null,
            outcome: null,
          },
          {
            issue: 1417,
            branch: 'queen-1417',
            started: minutesAgo(4),
            finishedAt: null,
            detail: 'pinning the dashboard',
            outcome: null,
          },
          {
            issue: 1420,
            branch: 'queen-1420',
            started: null,
            finishedAt: null,
            detail: null,
            outcome: null,
          },
        ],
      })
      const page = await runDashboardPage({
        replies: [{ status: 200, body: busy }],
      })
      expect(page.el('inflight').innerHTML).toContain('>1<')
      const rows = page.el('rows').innerHTML
      expect(rows).toContain('#1401')
      expect(rows).toContain('finished 2m ago')
      expect(rows).toContain('#1417')
      expect(rows).toContain('running')
      expect(rows).toContain('pinning the dashboard')
      expect(rows).toContain('#1420')
      expect(rows).toContain('refused')
    })

    it('trims a dispatch detail and a lease holder to what fits', async () => {
      const long = answering({
        lease: {
          holder: 'h'.repeat(40),
          fence: 3,
          expiresAt: secondsAhead(90),
        },
        dispatches: [
          {
            issue: 1417,
            branch: 'queen-1417',
            started: minutesAgo(4),
            finishedAt: null,
            detail: null,
            outcome: 'x'.repeat(200),
          },
        ],
      })
      const page = await runDashboardPage({
        replies: [{ status: 200, body: long }],
      })
      const rows = page.el('rows').innerHTML
      expect(rows).toContain('x'.repeat(120))
      expect(rows).not.toContain('x'.repeat(121))
      const lease = page.el('lease').innerHTML
      expect(lease).toContain('h'.repeat(22))
      expect(lease).not.toContain('h'.repeat(23))
    })

    it('names the reasons the last round skipped', async () => {
      const bounded = answering({
        lastTick: {
          decidedAt: minutesAgo(5),
          decision: {
            chosen: undefined,
            refusal: 'nothing to choose',
            skipped: [
              '#1204: not yet a spec - missing boundary, scenarios, requirements',
              '#1210: a worker has it or is expected back (running)',
            ],
          },
        },
      })
      const page = await runDashboardPage({
        replies: [{ status: 200, body: bounded }],
      })
      const bounds = page.el('bounds').innerHTML
      expect(bounds).toContain('#1204')
      expect(bounds).toContain('not yet a spec - missing boundary')
      expect(bounds).toContain('#1210')
      expect(bounds).toContain('a worker has it or is expected back')
    })

    it('says so when the last round skipped nothing', async () => {
      const page = await runDashboardPage({
        replies: [{ status: 200, body: answering() }],
      })
      expect(page.el('bounds').innerHTML).toContain(
        'the last round skipped nothing',
      )
    })

    it('shows the token form when the deployment answers 403', async () => {
      const page = await runDashboardPage({ replies: [{ status: 403 }] })
      expect(page.el('err').textContent).toBe(
        'the deployment refused that token',
      )
      expect(page.el('auth').hidden).toBe(false)
      expect(page.el('app').hidden).toBe(true)
    })

    it("reports the server's answer when the lease endpoint fails otherwise", async () => {
      const page = await runDashboardPage({ replies: [{ status: 500 }] })
      expect(page.el('err').textContent).toBe('server answered 500')
      expect(page.el('auth').hidden).toBe(false)
      expect(page.el('app').hidden).toBe(true)
    })

    it('sends the pasted token as a header, never in the URL', async () => {
      const page = await runDashboardPage({
        replies: [{ status: 403 }, { status: 200, body: answering() }],
      })
      await page.press('deploy-token-9f2', true)
      expect(page.calls[1]?.url).toBe('/queen/lease')
      expect(page.calls[1]?.headers?.Authorization).toBe(
        'Bearer deploy-token-9f2',
      )
      expect(page.el('auth').hidden).toBe(true)
      expect(page.el('app').hidden).toBe(false)
    })

    it('submits from the keyboard too', async () => {
      const page = await runDashboardPage({
        replies: [{ status: 403 }, { status: 200, body: answering() }],
      })
      page.el('token').value = 'deploy-token-9f2'
      page.el('remember').checked = true
      await page.typeEnter()
      expect(page.calls[1]?.headers?.Authorization).toBe(
        'Bearer deploy-token-9f2',
      )
    })

    it('keeps the token on this device only when asked', async () => {
      const asked = await runDashboardPage({
        replies: [{ status: 403 }, { status: 200, body: answering() }],
      })
      await asked.press('deploy-token-9f2', true)
      expect(asked.local.ops).toContainEqual(
        expect.objectContaining({ op: 'set', value: 'deploy-token-9f2' }),
      )
      expect(asked.session.ops).toContainEqual(
        expect.objectContaining({ op: 'remove' }),
      )

      const notAsked = await runDashboardPage({
        replies: [{ status: 403 }, { status: 200, body: answering() }],
      })
      await notAsked.press('deploy-token-9f2', false)
      expect(notAsked.session.ops).toContainEqual(
        expect.objectContaining({ op: 'set', value: 'deploy-token-9f2' }),
      )
      expect(notAsked.local.ops).toContainEqual(
        expect.objectContaining({ op: 'remove' }),
      )
    })

    it('finds a stored token on the next visit, from either store', async () => {
      const fromLocal = await runDashboardPage({
        replies: [{ status: 200, body: answering() }],
        seedLocal: 'kept-in-local',
      })
      expect(fromLocal.calls[0]?.headers?.Authorization).toBe(
        'Bearer kept-in-local',
      )

      const fromSession = await runDashboardPage({
        replies: [{ status: 200, body: answering() }],
        seedSession: 'kept-in-session',
      })
      expect(fromSession.calls[0]?.headers?.Authorization).toBe(
        'Bearer kept-in-session',
      )
    })

    it('keeps asking while connected, and not before', async () => {
      const anonymous = await runDashboardPage({
        replies: [{ status: 200, body: answering() }],
      })
      await anonymous.refreshNow()
      // No token, no polling: an anonymous shell does not hammer the lease.
      expect(anonymous.calls).toHaveLength(1)

      const connected = await runDashboardPage({
        replies: [{ status: 403 }, { status: 200, body: answering() }],
      })
      await connected.press('deploy-token-9f2', true)
      await connected.refreshNow()
      expect(connected.calls).toHaveLength(3)
      expect(connected.calls[2]?.headers?.Authorization).toBe(
        'Bearer deploy-token-9f2',
      )
    })

    it('says where she runs', async () => {
      const page = await runDashboardPage({
        replies: [{ status: 200, body: answering() }],
        host: 'supervisor.internal:3000',
      })
      expect(page.el('where').textContent).toBe('supervisor.internal:3000')
    })
  })
})
