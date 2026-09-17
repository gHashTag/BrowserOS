/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'

import {
  isAllowedCorsOrigin,
  publicReadCorsMiddleware,
  trustedCorsMiddleware,
} from '../../../src/api/utils/cors'

describe('cors allowlist', () => {
  it('allows loopback origins', () => {
    expect(isAllowedCorsOrigin('http://127.0.0.1:9105')).toBe(
      'http://127.0.0.1:9105',
    )
    expect(isAllowedCorsOrigin('http://localhost:3000')).toBe(
      'http://localhost:3000',
    )
  })

  it('allows extension origins', () => {
    expect(isAllowedCorsOrigin('chrome-extension://browseros')).toBe(
      'chrome-extension://browseros',
    )
  })

  it('rejects remote and missing origins', () => {
    expect(isAllowedCorsOrigin('https://evil.example')).toBeNull()
    expect(isAllowedCorsOrigin(undefined)).toBeNull()
  })
})

describe('default CORS middleware', () => {
  const app = new Hono().use('/*', trustedCorsMiddleware())

  it('reflects a loopback origin and emits credentials header', async () => {
    const res = await app.request('http://localhost/any', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:9105',
        'Access-Control-Request-Method': 'POST',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://127.0.0.1:9105',
    )
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  })

  it('does not reflect an evil remote origin or credentials header', async () => {
    const res = await app.request('http://localhost/any', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })
})

/**
 * The public-read middleware exists because of a measured gap, not a theory:
 * on 2026-09-03 both `/queen/status` and `/queen/public-board` answered HTTP 200
 * with no token from `curl`, and carried no `Access-Control-Allow-Origin` at
 * all - so the page at t27.ai that is meant to be the Queen's public face could
 * not read a byte of it and said "brain not connected" instead.
 */
describe('public-read CORS on the sanitized Queen projections', () => {
  // Mount order mirrors server.ts, and it is load-bearing: trustedCorsMiddleware
  // answers OPTIONS itself and returns, so a public-read middleware registered
  // after it would never see a preflight. This test caught exactly that.
  const app = new Hono()
    .use('/queen/status', publicReadCorsMiddleware())
    .use('/*', trustedCorsMiddleware())
    .get('/queen/status', (c) => c.json({ status: 'ok' }))

  it('lets any origin read it, which is what makes it public', async () => {
    const res = await app.request('http://localhost/queen/status', {
      headers: { Origin: 'https://t27.ai' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  // The whole safety of a wildcard rests on this one header being absent. With
  // credentials the browser would attach cookies and Authorization, and `*`
  // would become a hole rather than a projection; without them it grants
  // exactly what an unauthenticated `curl` already grants.
  it('never offers credentials, which is what keeps the wildcard safe', async () => {
    const res = await app.request('http://localhost/queen/status', {
      headers: { Origin: 'https://t27.ai' },
    })

    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })

  // If someone adds https://t27.ai to TRUSTED_ORIGINS, the trusted middleware
  // emits that origin plus credentials:true. Overwriting it with `*` produces a
  // pair every browser rejects - the public read would break for the single
  // origin most likely to be configured. So the wildcard steps aside.
  it('yields to the trusted allowlist instead of breaking it', async () => {
    const previous = process.env.TRUSTED_ORIGINS
    process.env.TRUSTED_ORIGINS = 'https://t27.ai'
    try {
      const res = await app.request('http://localhost/queen/status', {
        headers: { Origin: 'https://t27.ai' },
      })

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
        'https://t27.ai',
      )
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    } finally {
      if (previous === undefined) delete process.env.TRUSTED_ORIGINS
      else process.env.TRUSTED_ORIGINS = previous
    }
  })

  it('answers the preflight so a browser will send the real request', async () => {
    const res = await app.request('http://localhost/queen/status', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://t27.ai',
        'Access-Control-Request-Method': 'GET',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET')
  })
})
