import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
  isTrustedAppOrigin,
  requireTrustedAppOrigin,
} from '../../src/api/utils/request-auth'

describe('request auth', () => {
  it('accepts loopback and extension origins', () => {
    expect(isTrustedAppOrigin('http://127.0.0.1:9105')).toBe(true)
    expect(isTrustedAppOrigin('http://localhost:3000')).toBe(true)
    expect(isTrustedAppOrigin('chrome-extension://browseros')).toBe(true)
    expect(isTrustedAppOrigin('moz-extension://browseros')).toBe(true)
  })

  it('rejects missing and untrusted origins', () => {
    expect(isTrustedAppOrigin(undefined)).toBe(false)
    expect(isTrustedAppOrigin('https://example.com')).toBe(false)
    expect(isTrustedAppOrigin('file:///tmp/app.html')).toBe(false)
  })

  it('blocks requests from untrusted origins', async () => {
    const app = new Hono()
      .use('/*', requireTrustedAppOrigin())
      .get('/claw/status', (c) => c.json({ ok: true }))

    const res = await app.request('http://localhost/claw/status', {
      headers: { Origin: 'https://evil.example' },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  // This asserted 200 until 2026-08-28, and the assertion was the bug.
  //
  // An extension Origin used to be sufficient on its own, because a browser
  // will not let a web page forge one. Nothing else honours that rule: once the
  // server was put on a public URL, `curl -H 'Origin: chrome-extension://aaaa'`
  // against /mcp returned the full tool list, filesystem and shell included.
  // A trusted origin now also needs a loopback socket, which this harness
  // cannot present - and could not, since it is not a socket at all.
  it('refuses a trusted origin that cannot prove a loopback socket', async () => {
    const app = new Hono()
      .use('/*', requireTrustedAppOrigin())
      .get('/claw/status', (c) => c.json({ ok: true }))

    const res = await app.request('http://localhost/claw/status', {
      headers: { Origin: 'chrome-extension://browseros' },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('accepts a valid bearer token with no origin and no loopback socket', async () => {
    process.env.TRIOS_API_TOKEN = 'test-token-value'
    try {
      const app = new Hono()
        .use('/*', requireTrustedAppOrigin())
        .get('/claw/status', (c) => c.json({ ok: true }))

      const res = await app.request('http://localhost/claw/status', {
        headers: { Authorization: 'Bearer test-token-value' },
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      delete process.env.TRIOS_API_TOKEN
    }
  })

  // The loopback carve-out is what an agent's own shell is on the inside of.
  // Measured from the deployed container with no credential: a fetch to
  // 127.0.0.1:8080/mcp returned the full tool list.
  it('refuses an unauthenticated caller once a token is configured', async () => {
    process.env.TRIOS_API_TOKEN = 'test-token-value'
    try {
      const app = new Hono()
        .use('/*', requireTrustedAppOrigin())
        .get('/claw/status', (c) => c.json({ ok: true }))

      const noCredentials = await app.request('http://localhost/claw/status')
      expect(noCredentials.status).toBe(403)

      const trustedOrigin = await app.request('http://localhost/claw/status', {
        headers: { Origin: 'chrome-extension://browseros' },
      })
      expect(trustedOrigin.status).toBe(403)
    } finally {
      delete process.env.TRIOS_API_TOKEN
    }
  })

  it('refuses a wrong token, and a right token when none is configured', async () => {
    const app = new Hono()
      .use('/*', requireTrustedAppOrigin())
      .get('/claw/status', (c) => c.json({ ok: true }))

    process.env.TRIOS_API_TOKEN = 'test-token-value'
    try {
      // Same length as the real one: a length check alone must not be what
      // rejects this.
      const wrong = await app.request('http://localhost/claw/status', {
        headers: { Authorization: 'Bearer test-token-valuX' },
      })
      expect(wrong.status).toBe(403)
    } finally {
      delete process.env.TRIOS_API_TOKEN
    }

    // With no token configured, presenting one must not become a way in.
    const unconfigured = await app.request('http://localhost/claw/status', {
      headers: { Authorization: 'Bearer test-token-value' },
    })
    expect(unconfigured.status).toBe(403)
  })
})

describe('the deployment token satisfies the local-auth gate too', () => {
  // Measured on the first autonomous delegation into the cloud: the Queen
  // chose an issue, cut the bee's worktree in the container, opened a turn -
  // and /chat answered 403 "Local authorization required". That gate proves
  // "you are on this machine" by handing a token to trusted origins over
  // loopback and checking it back, which a container caller can never do.
  // Two attempts failed that way and the issue was retired as exhausted,
  // blaming the work rather than the perimeter.
  it('accepts a bearer token where local auth would otherwise refuse', async () => {
    const { requireLocalAuth } = await import(
      '../../src/api/utils/require-local-auth'
    )
    process.env.TRIOS_API_TOKEN = 'deployment-token-value'
    try {
      const app = new Hono()
        // No validator at all: the strictest starting point, where the gate
        // would answer 503 "not configured".
        .use('/*', requireLocalAuth(undefined))
        .get('/chat', (c) => c.json({ ok: true }))

      const withToken = await app.request('http://localhost/chat', {
        headers: { Authorization: 'Bearer deployment-token-value' },
      })
      expect(withToken.status).toBe(200)

      const without = await app.request('http://localhost/chat')
      expect(without.status).toBe(503)
    } finally {
      delete process.env.TRIOS_API_TOKEN
    }
  })

  it('refuses a wrong bearer where local auth applies', async () => {
    const { requireLocalAuth } = await import(
      '../../src/api/utils/require-local-auth'
    )
    process.env.TRIOS_API_TOKEN = 'deployment-token-value'
    try {
      const app = new Hono()
        .use('/*', requireLocalAuth(undefined))
        .get('/chat', (c) => c.json({ ok: true }))
      const res = await app.request('http://localhost/chat', {
        headers: { Authorization: 'Bearer deployment-token-valuX' },
      })
      expect(res.status).toBe(503)
    } finally {
      delete process.env.TRIOS_API_TOKEN
    }
  })
})
