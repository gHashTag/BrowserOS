/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'

import {
  isAllowedCorsOrigin,
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
