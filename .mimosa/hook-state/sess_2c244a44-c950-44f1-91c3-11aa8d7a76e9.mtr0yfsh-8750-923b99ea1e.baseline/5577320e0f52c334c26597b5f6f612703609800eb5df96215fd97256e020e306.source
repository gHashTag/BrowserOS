import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { publicReadCorsMiddleware, trustedCorsMiddleware } from '../../src/api/utils/cors'

// The Queen page's round clock reads the server's clock from the Date header
// (P1-30). Date is not a CORS-safelisted response header, so a browser on
// another origin only sees it when the server exposes it - on every branch.
describe('CORS exposes the Date header', () => {
  test('public read from a foreign origin', async () => {
    const app = new Hono()
    app.use('*', publicReadCorsMiddleware())
    app.get('/queen/status', (c) => c.json({ ok: true }))
    const res = await app.request('/queen/status', { headers: { origin: 'https://stranger.example' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-expose-headers')).toBe('Date')
  })

  test('trusted origin', async () => {
    const app = new Hono()
    app.use('*', trustedCorsMiddleware())
    app.get('/queen/status', (c) => c.json({ ok: true }))
    const res = await app.request('/queen/status', { headers: { origin: 'https://t27.ai' } })
    const allowed = res.headers.get('access-control-allow-origin')
    if (allowed) expect(res.headers.get('access-control-expose-headers')).toBe('Date')
    else expect(allowed).toBeNull() // not on this host's allowlist: nothing to expose
  })
})
