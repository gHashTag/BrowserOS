/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it } from 'bun:test'
import assert from 'node:assert'
import type { Context } from 'hono'
import type { Env } from '../types'
import { requireTrustedAppOrigin } from './request-auth'

interface MockContextExtras {
  responseStatus?: number
  responseBody?: unknown
}

function createMockContext(options: {
  origin?: string
  host?: string
  referer?: string
  remoteAddress?: string
}): Context<Env> & MockContextExtras {
  const headers: Record<string, string | undefined> = {}
  if (options.origin !== undefined) headers.origin = options.origin
  if (options.host !== undefined) headers.host = options.host
  if (options.referer !== undefined) headers.referer = options.referer

  const ctx = {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      raw: new Request('http://localhost:8080/'),
    },
    env: {
      server: {
        requestIP: () =>
          options.remoteAddress ? { address: options.remoteAddress } : null,
      },
    },
    json: (body: unknown, status?: number) => {
      ;(ctx as unknown as MockContextExtras).responseStatus = status
      ;(ctx as unknown as MockContextExtras).responseBody = body
      return body
    },
  }

  return ctx as unknown as Context<Env> & MockContextExtras
}

describe('requireTrustedAppOrigin', () => {
  it('rejects an evil localhost Origin from a non-loopback socket', async () => {
    const ctx = createMockContext({
      origin: 'http://localhost:8080',
      host: 'localhost:8080',
      remoteAddress: '192.168.1.1',
    })
    let calledNext = false
    const middleware = requireTrustedAppOrigin()

    await middleware(ctx, async () => {
      calledNext = true
    })

    assert.strictEqual(calledNext, false)
    assert.strictEqual(ctx.responseStatus, 403)
  })

  it('accepts a real loopback socket without an Origin header', async () => {
    const ctx = createMockContext({
      host: 'localhost:8080',
      remoteAddress: '127.0.0.1',
    })
    let calledNext = false
    const middleware = requireTrustedAppOrigin()

    await middleware(ctx, async () => {
      calledNext = true
    })

    assert.strictEqual(calledNext, true)
  })
})
