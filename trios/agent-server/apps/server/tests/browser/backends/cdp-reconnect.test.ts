import { afterEach, beforeEach, describe, it } from 'bun:test'
import assert from 'node:assert'
import { TIMEOUTS } from '@browseros/shared/constants/timeouts'
import { CdpBackend } from '../../../src/browser/backends/cdp'
import { Browser } from '../../../src/browser/browser'
import { logger } from '../../../src/lib/logger'

/**
 * gHashTag/trios#1368 — after the CDP socket reconnects, the dead session ids
 * are cached forever and every page tool fails until restart.
 *
 * These tests drive the real `CdpBackend` and the real `Browser` against a
 * mock CDP endpoint that answers a stale sessionId exactly the way Chrome
 * does: an error response reading "Session with given id not found.".
 *
 * Run against the unfixed tree, the first test fails with that exact error
 * (the reconnect notification does not exist yet, so the guard in
 * `subscribeReconnected` falls back to a short settle and the stale cached
 * id is used); run against the fixed tree it passes. That pairing is the
 * point: the failing run must be the defect itself, not a TypeError.
 */

/** One CDP connection. Each `MockWebSocket` belongs to an "era"; session ids
 * issued in one era are rejected in every later era, the way Chrome behaves
 * after the browser-side end of the socket goes away. */
class MockCdpEndpoint {
  static instances: MockWebSocket[] = []

  /** Every command ever received, tagged with the era of its socket. */
  received: { era: number; method: string; sessionId?: string }[] = []
  private nextEra = 0

  sessionIdForEra(era: number): string {
    return `S${era}`
  }

  createSocket(url: string): MockWebSocket {
    this.nextEra += 1
    const ws = new MockWebSocket(this, this.nextEra, url)
    MockCdpEndpoint.instances.push(ws)
    return ws
  }

  /** Chrome semantics: a sessionId is only valid on the connection that
   * issued it. */
  private isLiveSession(sessionId: string, era: number): boolean {
    return sessionId === this.sessionIdForEra(era)
  }

  handleMessage(ws: MockWebSocket, era: number, data: string): void {
    const message = JSON.parse(data) as {
      id?: number
      method: string
      params?: Record<string, unknown>
      sessionId?: string
    }
    this.received.push({
      era,
      method: message.method,
      sessionId: message.sessionId,
    })

    const respond = (result: unknown): void => {
      ws.deliver({ id: message.id, result })
    }
    const respondError = (errorMessage: string): void => {
      ws.deliver({ id: message.id, error: { message: errorMessage } })
    }

    if (message.sessionId && !this.isLiveSession(message.sessionId, era)) {
      // Exactly what Chrome sends for an id from a dead connection.
      respondError('Session with given id not found.')
      return
    }

    switch (message.method) {
      case 'Target.attachToTarget':
        respond({ sessionId: this.sessionIdForEra(era) })
        return
      case 'Browser.getTabs':
        respond({
          tabs: [
            {
              tabId: 1,
              targetId: 'T1',
              url: 'about:blank',
              title: 'Blank',
              isActive: true,
              isLoading: false,
              loadProgress: 1,
              isPinned: false,
              isHidden: false,
            },
          ],
        })
        return
      default:
        respond({})
    }
  }
}

class MockWebSocket {
  onopen: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  readonly url: string
  readonly era: number
  private readonly endpoint: MockCdpEndpoint

  constructor(endpoint: MockCdpEndpoint, era: number, url: string) {
    this.endpoint = endpoint
    this.era = era
    this.url = url
  }

  send(data: string): void {
    this.endpoint.handleMessage(this, this.era, data)
  }

  deliver(payload: unknown): void {
    // Chrome answers on a later tick, not inside send(); the backend
    // registers its pending request before sending, so delivering on a
    // microtask exercises the same protocol logic.
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify(payload) })
    })
  }

  close(): void {
    this.onclose?.()
  }

  open(): void {
    this.onopen?.()
  }
}

/** `new WebSocket(url)` must work, so the global needs a constructible; a
 * plain function returning the socket object satisfies `new`. */

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error('Timed out waiting for condition')
}

describe('CDP reconnect vs. cached sessions (trios#1368)', () => {
  const originalFetch = globalThis.fetch
  const originalWebSocket = globalThis.WebSocket
  const originalInfo = logger.info.bind(logger)
  const originalConnectTimeout = TIMEOUTS.CDP_CONNECT
  const originalReconnectDelay = TIMEOUTS.CDP_RECONNECT_DELAY
  let endpoint: MockCdpEndpoint
  let infoLines: string[] = []
  /** Reconnect notifications observed by the test itself. */
  let reconnectedCount = 0

  /**
   * Subscribe to the reconnect notification when it exists (fixed tree).
   * On the unfixed tree — where the defect lives — fall back to nothing so
   * the failing run surfaces the actual "Session with given id not found."
   * error rather than a missing-method TypeError.
   */
  function subscribeReconnected(cdp: CdpBackend): void {
    const maybe = cdp as Partial<CdpBackend>
    if (typeof maybe.onReconnected === 'function') {
      maybe.onReconnected(() => {
        reconnectedCount++
      })
    }
  }

  /**
   * Drive one full connection cycle: wait for the socket of `expectedEra`
   * to be created by the backend (initial connect or its own reconnect
   * machinery), open it, and wait for the reconnect notification to have
   * fired when one is owed.
   */
  async function waitForEraOpened(
    cdp: CdpBackend,
    expectedEra: number,
  ): Promise<void> {
    await waitFor(() => MockCdpEndpoint.instances.length >= expectedEra)
    const ws = MockCdpEndpoint.instances[expectedEra - 1]
    if (ws && !cdp.isConnected()) ws.open()
    const expectedNotifications = expectedEra - 1
    if (expectedNotifications === 0) return
    try {
      // Fixed tree: wait for the notification that clears the caches.
      await waitFor(() => reconnectedCount >= expectedNotifications, 1_000)
    } catch {
      // Unfixed tree: no notification will ever arrive. Settle so the next
      // command runs against the cached (dead) session id — the defect.
    }
    await Bun.sleep(5)
  }

  beforeEach(() => {
    MockCdpEndpoint.instances = []
    endpoint = new MockCdpEndpoint()
    reconnectedCount = 0
    infoLines = []

    ;(TIMEOUTS as unknown as { CDP_CONNECT: number }).CDP_CONNECT = 200
    ;(
      TIMEOUTS as unknown as { CDP_RECONNECT_DELAY: number }
    ).CDP_RECONNECT_DELAY = 1

    logger.info = ((message: string, meta?: Record<string, unknown>) => {
      infoLines.push(message)
      originalInfo(message, meta)
    }) as typeof logger.info

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/browser/${url}`,
        }),
      } as Response
    }) as typeof fetch

    // biome-ignore lint/complexity/useArrowFunction: must stay a function expression — the backend invokes it with `new WebSocket(url)`
    globalThis.WebSocket = function (url: string) {
      return endpoint.createSocket(url) as unknown as WebSocket
    } as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalWebSocket
    logger.info = originalInfo
    ;(TIMEOUTS as unknown as { CDP_CONNECT: number }).CDP_CONNECT =
      originalConnectTimeout
    ;(
      TIMEOUTS as unknown as { CDP_RECONNECT_DELAY: number }
    ).CDP_RECONNECT_DELAY = originalReconnectDelay
  })

  it('re-attaches after a reconnect instead of reusing the dead session id', async () => {
    const cdp = new CdpBackend({ port: 9222, exitOnReconnectFailure: false })
    subscribeReconnected(cdp)
    const connectPromise = cdp.connect()
    await waitForEraOpened(cdp, 1)
    await connectPromise
    assert.strictEqual(cdp.isConnected(), true)

    const browser = new Browser(cdp)
    const pages = await browser.listPages()
    assert.strictEqual(pages.length, 1)
    assert.strictEqual(pages[0]?.targetId, 'T1')

    // Establish the session on era 1.
    await browser.pressKey(1, 'a')
    const attachCallsInEra1 = endpoint.received.filter(
      (m) => m.era === 1 && m.method === 'Target.attachToTarget',
    )
    assert.strictEqual(attachCallsInEra1.length, 1)

    // Fast path unchanged: with no reconnect, the second pressKey reuses the
    // cached session id and does not attach again.
    await browser.pressKey(1, 'a')
    assert.strictEqual(
      endpoint.received.filter(
        (m) => m.era === 1 && m.method === 'Target.attachToTarget',
      ).length,
      1,
      'no reconnect must mean no re-attach',
    )

    // The socket dies and the backend's own machinery reconnects it.
    const ws1 = MockCdpEndpoint.instances[0]
    ws1?.close()
    await waitForEraOpened(cdp, 2)
    assert.strictEqual(cdp.isConnected(), true)

    // THE assertion of trios#1368: the next page operation succeeds. On the
    // unfixed tree this call fails with "CDP error: Session with given id
    // not found." because the era-1 session id is still cached.
    await browser.pressKey(1, 'a')

    const era2 = endpoint.received.filter((m) => m.era === 2)
    const reattach = era2.filter((m) => m.method === 'Target.attachToTarget')
    assert.strictEqual(
      reattach.length,
      1,
      'after a reconnect the page must be re-attached',
    )
    const staleDispatches = era2.filter(
      (m) =>
        m.method === 'Input.dispatchKeyEvent' &&
        m.sessionId === endpoint.sessionIdForEra(1),
    )
    assert.strictEqual(
      staleDispatches.length,
      0,
      'no era-2 command may carry an era-1 session id',
    )
    const liveDispatches = era2.filter(
      (m) =>
        m.method === 'Input.dispatchKeyEvent' &&
        m.sessionId === endpoint.sessionIdForEra(2),
    )
    assert.ok(liveDispatches.length > 0, 'the key went out on the new session')

    // The clearing is observable in the log, exactly once for one reconnect.
    const clearLines = infoLines.filter(
      (line) => line.includes('cleared') && line.includes('cached session'),
    )
    assert.strictEqual(clearLines.length, 1, `got: ${infoLines.join(' | ')}`)
  })

  it('does not accumulate reconnect subscriptions across three reconnects', async () => {
    const cdp = new CdpBackend({ port: 9222, exitOnReconnectFailure: false })
    subscribeReconnected(cdp)
    const connectPromise = cdp.connect()
    await waitForEraOpened(cdp, 1)
    await connectPromise
    assert.strictEqual(cdp.isConnected(), true)

    const browser = new Browser(cdp)
    await browser.listPages()
    await browser.pressKey(1, 'a')

    const handlerCount = () => {
      const internals = cdp as unknown as {
        reconnectedHandlers?: unknown[]
      }
      assert.ok(
        Array.isArray(internals.reconnectedHandlers),
        'backend must keep its reconnect handlers in an array field named reconnectedHandlers',
      )
      return internals.reconnectedHandlers?.length ?? -1
    }

    const counts: number[] = []
    for (let reconnect = 1; reconnect <= 3; reconnect++) {
      const current = MockCdpEndpoint.instances.at(-1)
      current?.close()
      await waitForEraOpened(cdp, reconnect + 1)
      await waitFor(() => cdp.isConnected())
      await Bun.sleep(5)
      counts.push(handlerCount())
    }

    // Browser's single handler + this test's single handler: never more.
    assert.strictEqual(
      counts[0],
      2,
      'expected exactly two handlers after the first reconnect',
    )
    assert.deepStrictEqual(
      counts,
      [counts[0], counts[0], counts[0]],
      `handler count must not grow across reconnects, got ${counts.join(',')}`,
    )
    // One notification per reconnect — no double-firing either.
    assert.strictEqual(reconnectedCount, 3)
  })
})
