/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The /a2a/stream teardown path.
 *
 * The only disconnect signal this route can observe on the runtime image
 * (oven/bun:1.3.6) is `StreamingApi.onAbort`, fired from the `cancel` handler of
 * `responseReadable` when the socket goes away. Hono's `StreamingApi.write`
 * swallows every write error (hono@4.12.3 dist/utils/stream.js: `try { await
 * this.writer.write(input) } catch {}`), and the `c.req.raw.signal` abort
 * listener is registered only when `isOldBunVersion()` is true - Bun "1.1",
 * "1.0" or "0.x". So a route that waits for `write` to throw never tears down.
 *
 * This test needs a real socket. Measured while writing it: over `app.request`
 * the response body is detached from `responseReadable`, so cancelling the
 * reader fires nothing and the test would pass on any implementation. Aborting
 * a real `fetch` fires onAbort with 0 ms of latency.
 */

import { describe, expect, it } from 'bun:test'
import { createA2aRoutes } from '../../../src/api/routes/a2a'
import type { A2aRegistryService } from '../../../src/api/services/a2a/a2a-registry-service'

function makeService(unsubscribed: string[]): A2aRegistryService {
  return {
    subscribe: () => {},
    unsubscribe: (agentId: string) => {
      unsubscribed.push(agentId)
    },
  } as unknown as A2aRegistryService
}

describe('GET /stream', () => {
  it('requires an agentId', async () => {
    const app = createA2aRoutes({ service: makeService([]) })
    const res = await app.request('/stream')
    expect(res.status).toBe(400)
  })

  it('unsubscribes the agent when the client hangs up', async () => {
    const unsubscribed: string[] = []
    const app = createA2aRoutes({ service: makeService(unsubscribed) })
    const server = Bun.serve({ port: 0, fetch: app.fetch })

    try {
      const controller = new AbortController()
      const res = await fetch(
        `http://localhost:${server.port}/stream?agentId=bee-1`,
        { signal: controller.signal },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/event-stream')

      const reader = res.body?.getReader()
      if (!reader) throw new Error('expected a response body')

      // The first heartbeat is written eagerly, so the client can confirm the
      // stream is live before hanging up.
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toBe(':heartbeat\n\n')

      controller.abort()

      for (let i = 0; i < 100 && unsubscribed.length === 0; i++) {
        await Bun.sleep(10)
      }

      expect(unsubscribed).toEqual(['bee-1'])
    } finally {
      server.stop(true)
    }
  })
})
