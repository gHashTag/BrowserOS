/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'

import {
  isAllowedCorsOrigin,
  publicReadCorsMiddleware,
  trustedCorsMiddleware,
} from '../../src/api/utils/cors'

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

/**
 * Three public projections were mounted on 2026-09-01 without this
 * middleware, and nothing noticed: the routes answered curl and returned 404
 * from the browser at t27.ai just the same, because a missing CORS header and
 * a missing route look identical from a page. This reads server.ts and holds
 * that every /queen/public-* and /queen/status mount has its public-read
 * middleware registered ABOVE the trusted catch-all.
 */
describe('every public Queen projection is mounted with public-read CORS', () => {
  // `server.ts` lives one directory above the middleware this suite imports.
  // Rather than hard-code how many levels separate this file from it, resolve
  // the middleware module itself and go up from there - the suite then finds
  // server.ts no matter where under tests/ it ends up living.
  const corsModuleDir = dirname(
    fileURLToPath(import.meta.resolve('../../src/api/utils/cors')),
  )
  const source = readFileSync(
    resolve(corsModuleDir, '..', 'server.ts'),
    'utf8',
  )
  const mounted = [
    ...source.matchAll(/\.route\('(\/queen\/(?:status|public-[a-z-]+))'/g),
  ].map((m) => m[1])
  const publicRead = [
    ...source.matchAll(
      /\.use\('(\/queen\/[a-z-]+)', publicReadCorsMiddleware\(\)\)/g,
    ),
  ].map((m) => m[1])
  const catchAll = source.indexOf(".use('/*', trustedCorsMiddleware())")

  it('mounts at least the five the page reads', () => {
    for (const path of [
      '/queen/status',
      '/queen/public-board',
      '/queen/public-activity',
      '/queen/public-hardware',
      '/queen/public-research',
    ]) {
      expect(mounted).toContain(path)
    }
  })

  it('gives each of them public-read CORS, registered before the catch-all', () => {
    for (const path of mounted) {
      expect(publicRead).toContain(path)
      const at = source.indexOf(`.use('${path}', publicReadCorsMiddleware())`)
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(catchAll)
    }
  })
})
