/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'

import { createA2aRoutes } from '../../../src/api/routes/a2a'
import { createChatRoutes } from '../../../src/api/routes/chat'
import { createHealthRoute } from '../../../src/api/routes/health'
import { createLocalAuthRoutes } from '../../../src/api/routes/local-auth'
import { createShutdownRoute } from '../../../src/api/routes/shutdown'
import { A2aRegistryService } from '../../../src/api/services/a2a/a2a-registry-service'
import type { ChatHistoryService } from '../../../src/api/services/chat-history-service'
import { LocalAuthService } from '../../../src/api/services/local-auth-service'
import { SqliteTokenFamilyStore } from '../../../src/api/services/token-family-store'
import { requireTrustedAppOrigin } from '../../../src/api/utils/request-auth'
import {
  LOCAL_AUTH_HEADER,
  requireLocalAuth,
} from '../../../src/api/utils/require-local-auth'
import type { Browser } from '../../../src/browser/browser'
import type { ToolRegistry } from '../../../src/tools/tool-registry'

function loopbackEnv() {
  return {
    server: {
      requestIP: () => ({ address: '127.0.0.1' }),
    },
  }
}

function remoteEnv() {
  return {
    server: {
      requestIP: () => ({ address: '192.168.1.1' }),
    },
  }
}

function loopbackIpv6Env() {
  return {
    server: {
      requestIP: () => ({ address: '::1' }),
    },
  }
}

function buildApp(options?: { feedbackExists?: boolean }) {
  const a2aService = new A2aRegistryService()
  const dummyProtected = new Hono()
    .get('/*', (c) => c.json({ ok: true }))
    .post('/*', (c) => c.json({ ok: true }))
    .put('/*', (c) => c.json({ ok: true }))

  const mockChatHistoryService = {
    storeFeedback: async (
      _conversationId: string,
      _messageId: string,
      _isPositive: boolean,
    ) => ({
      updated: options?.feedbackExists ?? true,
    }),
  } as unknown as ChatHistoryService

  return new Hono()
    .route('/health', createHealthRoute())
    .use('/agents/*', requireTrustedAppOrigin())
    .route('/agents', dummyProtected)
    .use('/soul/*', requireTrustedAppOrigin())
    .route('/soul', dummyProtected)
    .use('/monitoring/*', requireTrustedAppOrigin())
    .route('/monitoring', dummyProtected)
    .use('/acl-rules/*', requireTrustedAppOrigin())
    .route('/acl-rules', dummyProtected)
    .use('/shutdown/*', requireTrustedAppOrigin())
    .route('/shutdown', createShutdownRoute({ onShutdown: () => {} }))
    .use('/a2a/*', requireTrustedAppOrigin())
    .route('/a2a', createA2aRoutes({ service: a2aService }))
    .use('/chat/*', requireTrustedAppOrigin())
    .route(
      '/chat',
      createChatRoutes({
        browser: {} as Browser,
        registry: {} as ToolRegistry,
        chatHistoryService: mockChatHistoryService,
      }),
    )
    .use('/claw/*', requireTrustedAppOrigin())
    .route('/claw', dummyProtected)
}

describe('protected routes auth', () => {
  const app = buildApp()

  it('GET /health returns 200 from loopback without an Origin header', async () => {
    const res = await app.request(
      'http://127.0.0.1:9105/health',
      { headers: { Host: '127.0.0.1:9105' } },
      loopbackEnv(),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('POST /shutdown from a non-loopback socket with localhost Origin returns 403', async () => {
    const res = await app.request(
      'http://localhost:9105/shutdown',
      {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:9105',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      remoteEnv(),
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('GET /a2a/agents from loopback returns 200', async () => {
    const res = await app.request(
      'http://127.0.0.1:9105/a2a/agents',
      { headers: { Host: '127.0.0.1:9105' } },
      loopbackEnv(),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ agents: [] })
  })

  it('POST /chat from loopback returns 200 or 400, not 403', async () => {
    const res = await app.request(
      'http://127.0.0.1:9105/chat',
      {
        method: 'POST',
        headers: { Host: '127.0.0.1:9105', 'Content-Type': 'application/json' },
        body: JSON.stringify({ invalid: 'body' }),
      },
      loopbackEnv(),
    )

    expect(res.status).not.toBe(403)
    expect([200, 400, 503]).toContain(res.status)
  })

  const protectedRouteCases = [
    { method: 'GET', path: '/agents', body: undefined },
    {
      method: 'POST',
      path: '/agents',
      body: JSON.stringify({ name: 'x', adapter: 'claude' }),
    },
    { method: 'GET', path: '/soul', body: undefined },
    { method: 'PUT', path: '/soul', body: JSON.stringify({ content: 'x' }) },
    { method: 'GET', path: '/monitoring/runs', body: undefined },
    { method: 'GET', path: '/acl-rules', body: undefined },
    {
      method: 'PUT',
      path: '/acl-rules',
      body: JSON.stringify({ aclRules: [] }),
    },
    { method: 'GET', path: '/claw/status', body: undefined },
  ] as const

  for (const { method, path, body } of protectedRouteCases) {
    it(`${method} ${path} from a non-loopback socket with localhost Origin returns 403`, async () => {
      const headers: Record<string, string> = {
        Origin: 'http://localhost:9105',
        Host: 'localhost:9105',
      }
      if (body) headers['Content-Type'] = 'application/json'

      const res = await app.request(
        `http://localhost:9105${path}`,
        { method, headers, body },
        remoteEnv(),
      )

      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    })

    it(`${method} ${path} from loopback without Origin is allowed`, async () => {
      const headers: Record<string, string> = { Host: '127.0.0.1:9105' }
      if (body) headers['Content-Type'] = 'application/json'

      const res = await app.request(
        `http://127.0.0.1:9105${path}`,
        { method, headers, body },
        loopbackEnv(),
      )

      expect(res.status).not.toBe(403)
    })
  }

  describe('POST /chat/:conversationId/messages/:messageId/feedback', () => {
    it('stores feedback from loopback and returns success', async () => {
      const app = buildApp({ feedbackExists: true })
      const res = await app.request(
        'http://127.0.0.1:9105/chat/550e8400-e29b-41d4-a716-446655440000/messages/6ba7b810-9dad-11d1-80b4-00c04fd430c8/feedback',
        {
          method: 'POST',
          headers: {
            Host: '127.0.0.1:9105',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ isPositive: true }),
        },
        loopbackEnv(),
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
    })

    it('returns 404 when the target message does not exist', async () => {
      const app = buildApp({ feedbackExists: false })
      const res = await app.request(
        'http://127.0.0.1:9105/chat/550e8400-e29b-41d4-a716-446655440000/messages/6ba7b810-9dad-11d1-80b4-00c04fd431c8/feedback',
        {
          method: 'POST',
          headers: {
            Host: '127.0.0.1:9105',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ isPositive: false }),
        },
        loopbackEnv(),
      )

      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        success: false,
        message: 'Message 6ba7b810-9dad-11d1-80b4-00c04fd431c8 not found',
      })
    })

    it('returns 400 for an invalid request body', async () => {
      const app = buildApp()
      const res = await app.request(
        'http://127.0.0.1:9105/chat/550e8400-e29b-41d4-a716-446655440000/messages/6ba7b810-9dad-11d1-80b4-00c04fd430c8/feedback',
        {
          method: 'POST',
          headers: {
            Host: '127.0.0.1:9105',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ isPositive: 'maybe' }),
        },
        loopbackEnv(),
      )

      expect(res.status).toBe(400)
    })

    it('returns 403 from a remote origin', async () => {
      const app = buildApp()
      const res = await app.request(
        'http://localhost:9105/chat/550e8400-e29b-41d4-a716-446655440000/messages/6ba7b810-9dad-11d1-80b4-00c04fd430c8/feedback',
        {
          method: 'POST',
          headers: {
            Origin: 'http://localhost:9105',
            Host: 'localhost:9105',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ isPositive: true }),
        },
        remoteEnv(),
      )

      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    })
  })

  describe('local authorization gate', () => {
    const localAuthService = new LocalAuthService({
      store: new SqliteTokenFamilyStore({ dbPath: ':memory:' }),
    })
    const auditPath = join(
      mkdtempSync(join(tmpdir(), 'local-auth-audit-')),
      'audit.jsonl',
    )

    function buildLocalAuthApp() {
      const protectedRoute = new Hono().post(
        '/',
        requireLocalAuth(localAuthService, auditPath),
        (c) => c.json({ ok: true }),
      )

      return new Hono()
        .use('/auth/*', requireTrustedAppOrigin())
        .route('/auth', createLocalAuthRoutes({ service: localAuthService }))
        .use('/local-protected/*', requireTrustedAppOrigin())
        .route('/local-protected', protectedRoute)
    }

    const app = buildLocalAuthApp()

    it('GET /auth/local-token returns access token, refresh token, and metadata', async () => {
      const res = await app.request(
        'http://127.0.0.1:9105/auth/local-token',
        { headers: { Host: '127.0.0.1:9105' } },
        loopbackEnv(),
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(typeof body.token).toBe('string')
      expect(typeof body.refreshToken).toBe('string')
      expect(body.token).toBe(localAuthService.getToken())
      expect(typeof body.issuedAt).toBe('string')
      expect(typeof body.expiresAt).toBe('string')
      expect(typeof body.expiresInSeconds).toBe('number')
      expect(body.expiresInSeconds).toBeGreaterThan(0)
      expect(body.ttlSeconds).toBe(localAuthService.getTokenInfo().ttlSeconds)
    })

    it('GET /auth/local-token from remote origin returns 403', async () => {
      const res = await app.request(
        'http://localhost:9105/auth/local-token',
        {
          headers: {
            Origin: 'http://localhost:9105',
            Host: 'localhost:9105',
          },
        },
        remoteEnv(),
      )

      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    })

    it('POST to local-auth protected route without token returns 403', async () => {
      const res = await app.request(
        'http://127.0.0.1:9105/local-protected',
        {
          method: 'POST',
          headers: { Host: '127.0.0.1:9105' },
        },
        loopbackEnv(),
      )

      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({
        error: 'Local authorization required',
      })
    })

    it('POST to local-auth protected route with wrong token returns 403', async () => {
      const res = await app.request(
        'http://127.0.0.1:9105/local-protected',
        {
          method: 'POST',
          headers: {
            Host: '127.0.0.1:9105',
            [LOCAL_AUTH_HEADER]: 'bad-token',
          },
        },
        loopbackEnv(),
      )

      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({
        error: 'Local authorization required',
      })
    })

    it('POST to local-auth protected route with valid token is allowed', async () => {
      const tokenRes = await app.request(
        'http://127.0.0.1:9105/auth/local-token',
        { headers: { Host: '127.0.0.1:9105' } },
        loopbackEnv(),
      )
      const { token } = await tokenRes.json()

      const res = await app.request(
        'http://127.0.0.1:9105/local-protected',
        {
          method: 'POST',
          headers: {
            Host: '127.0.0.1:9105',
            [LOCAL_AUTH_HEADER]: token,
          },
        },
        loopbackEnv(),
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    })

    it('writes token-free audit records for local-auth requests', async () => {
      const before = await readFile(auditPath, 'utf8').then((text) =>
        text.split('\n').filter(Boolean),
      )
      const offset = before.length

      await app.request(
        'http://127.0.0.1:9105/local-protected',
        {
          method: 'POST',
          headers: { Host: '127.0.0.1:9105' },
        },
        loopbackEnv(),
      )

      const after = await readFile(auditPath, 'utf8').then((text) =>
        text.split('\n').filter(Boolean),
      )
      const newEntries = after.slice(offset).map((line) => JSON.parse(line))
      expect(newEntries.length).toBeGreaterThan(0)
      const entry = newEntries[newEntries.length - 1]
      expect(entry.path).toBe('/local-protected')
      expect(entry.socketAddress).toBe('127.0.0.1')
      expect(entry.result).toBe('invalid')
      expect(entry.token).toBeUndefined()
      expect(typeof entry.timestamp).toBe('string')
    })

    it('POST to local-auth protected route with expired token returns 401', async () => {
      const service = new LocalAuthService({
        ttlSeconds: 0,
        store: new SqliteTokenFamilyStore({ dbPath: ':memory:' }),
      })
      const testAuditPath = join(
        mkdtempSync(join(tmpdir(), 'local-auth-audit-')),
        'audit.jsonl',
      )
      const testApp = new Hono()
        .use('/auth/*', requireTrustedAppOrigin())
        .route('/auth', createLocalAuthRoutes({ service }))
        .use('/local-protected/*', requireTrustedAppOrigin())
        .route(
          '/local-protected',
          new Hono().post('/', requireLocalAuth(service, testAuditPath), (c) =>
            c.json({ ok: true }),
          ),
        )

      const tokenRes = await testApp.request(
        'http://127.0.0.1:9105/auth/local-token',
        { headers: { Host: '127.0.0.1:9105' } },
        loopbackEnv(),
      )
      const { token } = await tokenRes.json()

      const res = await testApp.request(
        'http://127.0.0.1:9105/local-protected',
        {
          method: 'POST',
          headers: {
            Host: '127.0.0.1:9105',
            [LOCAL_AUTH_HEADER]: token,
          },
        },
        loopbackEnv(),
      )

      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Local authorization expired' })
    })

    it('POST /auth/refresh returns a new access and refresh token pair', async () => {
      const tokenRes = await app.request(
        'http://127.0.0.1:9105/auth/local-token',
        { headers: { Host: '127.0.0.1:9105' } },
        loopbackEnv(),
      )
      const { token, refreshToken } = await tokenRes.json()

      const res = await app.request(
        'http://127.0.0.1:9105/auth/refresh',
        {
          method: 'POST',
          headers: {
            Host: '127.0.0.1:9105',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refreshToken }),
        },
        loopbackEnv(),
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(typeof body.accessToken).toBe('string')
      expect(typeof body.refreshToken).toBe('string')
      expect(body.accessToken).not.toBe(token)
      expect(body.refreshToken).not.toBe(refreshToken)
      expect(body.info.token).toBe(body.accessToken)
      expect(typeof body.info.issuedAt).toBe('string')
      expect(typeof body.info.expiresAt).toBe('string')
      expect(typeof body.info.expiresInSeconds).toBe('number')
      expect(body.info.expiresInSeconds).toBeGreaterThan(0)
      expect(body.info.ttlSeconds).toBe(
        localAuthService.getTokenInfo().ttlSeconds,
      )
    })

    it('POST /auth/refresh with reused old refresh token revokes family and returns 401', async () => {
      const tokenRes = await app.request(
        'http://127.0.0.1:9105/auth/local-token',
        { headers: { Host: '127.0.0.1:9105' } },
        loopbackEnv(),
      )
      const { refreshToken: oldRefreshToken } = await tokenRes.json()

      const rotateRes = await app.request(
        'http://127.0.0.1:9105/auth/refresh',
        {
          method: 'POST',
          headers: {
            Host: '127.0.0.1:9105',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refreshToken: oldRefreshToken }),
        },
        loopbackEnv(),
      )
      expect(rotateRes.status).toBe(200)

      const reuseRes = await app.request(
        'http://127.0.0.1:9105/auth/refresh',
        {
          method: 'POST',
          headers: {
            Host: '127.0.0.1:9105',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refreshToken: oldRefreshToken }),
        },
        loopbackEnv(),
      )
      expect(reuseRes.status).toBe(401)
      expect(await reuseRes.json()).toEqual({
        error: 'refresh token revoked/reused',
      })
    })

    it('token families persist across service restarts', async () => {
      const store = new SqliteTokenFamilyStore({ dbPath: ':memory:' })
      const firstService = new LocalAuthService({ store })
      const pair = firstService.issueInitialTokens()

      const secondService = new LocalAuthService({ store })
      const rotated = secondService.rotateRefreshToken(pair.refreshToken)

      expect(rotated).not.toBe('revoked')
      expect(rotated).not.toBeNull()
      if (rotated && rotated !== 'revoked') {
        expect(typeof rotated.accessToken).toBe('string')
        expect(typeof rotated.refreshToken).toBe('string')
        expect(rotated.accessToken).not.toBe(pair.accessToken)
      }
    })

    it('concurrent refresh with the same token is detected as reuse', async () => {
      const store = new SqliteTokenFamilyStore({ dbPath: ':memory:' })
      const service = new LocalAuthService({ store })
      const pair = service.issueInitialTokens()

      const results = await Promise.all([
        service.rotateRefreshToken(pair.refreshToken),
        service.rotateRefreshToken(pair.refreshToken),
      ])

      const successes = results.filter(
        (
          r,
        ): r is { accessToken: string; refreshToken: string; info: unknown } =>
          r !== null && r !== 'revoked',
      )
      const revocations = results.filter((r) => r === 'revoked')

      expect(successes.length).toBeLessThanOrEqual(1)
      expect(revocations.length + successes.length).toBe(2)
    })

    it('validate does not create a family when none is active', () => {
      const store = new SqliteTokenFamilyStore({ dbPath: ':memory:' })
      const service = new LocalAuthService({ store })
      expect(service.validate('any-token')).toBe(false)
      expect(service.getActiveFamily()).toBeNull()
    })

    it('rate limits repeated GET /auth/local-token from the same IP', async () => {
      const store = new SqliteTokenFamilyStore({ dbPath: ':memory:' })
      const service = new LocalAuthService({
        store,
        rateLimit: {
          localTokenWindowMs: 60_000,
          localTokenMaxAttempts: 3,
        },
      })
      const testApp = new Hono()
        .use('/auth/*', requireTrustedAppOrigin())
        .route('/auth', createLocalAuthRoutes({ service }))

      // First 3 requests succeed.
      for (let i = 0; i < 3; i++) {
        const res = await testApp.request(
          'http://127.0.0.1:9105/auth/local-token',
          { headers: { Host: '127.0.0.1:9105' } },
          loopbackEnv(),
        )
        expect(res.status).toBe(200)
      }

      // Fourth request is blocked.
      const blocked = await testApp.request(
        'http://127.0.0.1:9105/auth/local-token',
        { headers: { Host: '127.0.0.1:9105' } },
        loopbackEnv(),
      )
      expect(blocked.status).toBe(429)
      expect(await blocked.json()).toEqual({ error: 'Too many requests' })
      expect(blocked.headers.get('Retry-After')).toMatch(/^\d+$/)
      expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
    })

    it('rate limits repeated POST /auth/refresh from the same IP', async () => {
      const store = new SqliteTokenFamilyStore({ dbPath: ':memory:' })
      const service = new LocalAuthService({
        store,
        rateLimit: {
          refreshWindowMs: 60_000,
          refreshMaxAttempts: 2,
        },
      })
      const testApp = new Hono()
        .use('/auth/*', requireTrustedAppOrigin())
        .route('/auth', createLocalAuthRoutes({ service }))

      const tokenRes = await testApp.request(
        'http://127.0.0.1:9105/auth/local-token',
        { headers: { Host: '127.0.0.1:9105' } },
        loopbackEnv(),
      )
      expect(tokenRes.status).toBe(200)
      let { refreshToken } = await tokenRes.json()

      // First two refreshes succeed, consuming the 2-attempt window.
      for (let i = 0; i < 2; i++) {
        const res = await testApp.request(
          'http://127.0.0.1:9105/auth/refresh',
          {
            method: 'POST',
            headers: {
              Host: '127.0.0.1:9105',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ refreshToken }),
          },
          loopbackEnv(),
        )
        expect(res.status).toBe(200)
        const body = await res.json()
        refreshToken = body.refreshToken
      }

      // Third refresh is blocked by rate limit before rotation runs.
      const blocked = await testApp.request(
        'http://127.0.0.1:9105/auth/refresh',
        {
          method: 'POST',
          headers: {
            Host: '127.0.0.1:9105',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refreshToken }),
        },
        loopbackEnv(),
      )
      expect(blocked.status).toBe(429)
      expect(await blocked.json()).toEqual({ error: 'Too many requests' })
      expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
    })

    it('records route-level audit events in SQLite', async () => {
      const store = new SqliteTokenFamilyStore({ dbPath: ':memory:' })
      const service = new LocalAuthService({ store })
      const testApp = new Hono()
        .use('/auth/*', requireTrustedAppOrigin())
        .route('/auth', createLocalAuthRoutes({ service }))

      const tokenRes = await testApp.request(
        'http://127.0.0.1:9105/auth/local-token',
        { headers: { Host: '127.0.0.1:9105' } },
        loopbackEnv(),
      )
      expect(tokenRes.status).toBe(200)

      const { refreshToken } = await tokenRes.json()
      const refreshRes = await testApp.request(
        'http://127.0.0.1:9105/auth/refresh',
        {
          method: 'POST',
          headers: {
            Host: '127.0.0.1:9105',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refreshToken }),
        },
        loopbackEnv(),
      )
      expect(refreshRes.status).toBe(200)

      const db = (
        store as unknown as {
          db: { query: (sql: string) => { all: () => unknown[] } }
        }
      ).db
      const events = db
        .query(
          "SELECT event_type, socket_address FROM local_auth_family_audit WHERE event_type IN ('local-token-issued', 'refresh-attempt', 'refresh-success') ORDER BY timestamp",
        )
        .all() as { event_type: string; socket_address: string }[]

      const types = events.map((e) => e.event_type)
      expect(types).toContain('local-token-issued')
      expect(types).toContain('refresh-attempt')
      expect(types).toContain('refresh-success')
      expect(events.every((e) => e.socket_address === '127.0.0.1')).toBe(true)
    })

    it('rate limit buckets are independent per IP', async () => {
      const store = new SqliteTokenFamilyStore({ dbPath: ':memory:' })
      const service = new LocalAuthService({
        store,
        rateLimit: {
          localTokenWindowMs: 60_000,
          localTokenMaxAttempts: 1,
        },
      })
      const testApp = new Hono()
        .use('/auth/*', requireTrustedAppOrigin())
        .route('/auth', createLocalAuthRoutes({ service }))

      // 127.0.0.1 uses its only allowed request.
      const first = await testApp.request(
        'http://127.0.0.1:9105/auth/local-token',
        { headers: { Host: '127.0.0.1:9105' } },
        loopbackEnv(),
      )
      expect(first.status).toBe(200)

      const blocked = await testApp.request(
        'http://127.0.0.1:9105/auth/local-token',
        { headers: { Host: '127.0.0.1:9105' } },
        loopbackEnv(),
      )
      expect(blocked.status).toBe(429)

      // A different loopback IP has its own bucket and is still allowed.
      const other = await testApp.request(
        'http://127.0.0.1:9105/auth/local-token',
        { headers: { Host: '127.0.0.1:9105' } },
        loopbackIpv6Env(),
      )
      expect(other.status).toBe(200)
    })

    describe('admin token-family lifecycle', () => {
      it('GET /auth/admin/families requires local auth', async () => {
        const store = new SqliteTokenFamilyStore({ dbPath: ':memory:' })
        const service = new LocalAuthService({ store })
        const testApp = new Hono()
          .use('/auth/*', requireTrustedAppOrigin())
          .route('/auth', createLocalAuthRoutes({ service }))

        const res = await testApp.request(
          'http://127.0.0.1:9105/auth/admin/families',
          { headers: { Host: '127.0.0.1:9105' } },
          loopbackEnv(),
        )
        expect(res.status).toBe(403)
      })

      it('lists families with redacted hashes', async () => {
        const store = new SqliteTokenFamilyStore({ dbPath: ':memory:' })
        const service = new LocalAuthService({ store })
        const testApp = new Hono()
          .use('/auth/*', requireTrustedAppOrigin())
          .route('/auth', createLocalAuthRoutes({ service }))

        const tokenRes = await testApp.request(
          'http://127.0.0.1:9105/auth/local-token',
          { headers: { Host: '127.0.0.1:9105' } },
          loopbackEnv(),
        )
        const { token } = await tokenRes.json()

        const res = await testApp.request(
          'http://127.0.0.1:9105/auth/admin/families',
          {
            headers: { Host: '127.0.0.1:9105', [LOCAL_AUTH_HEADER]: token },
          },
          loopbackEnv(),
        )
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.families).toHaveLength(1)
        expect(body.total).toBe(1)
        const family = body.families[0]
        expect(family.status).toBe('active')
        expect(family.accessTokenHash).toMatch(/^.{8}\.{3}.{4}$/)
        expect(family.refreshTokenHash).toMatch(/^.{8}\.{3}.{4}$/)
        expect(family.rotatedRefreshHashCount).toBe(0)
        expect(typeof family.familyId).toBe('string')
      })

      it('revokes a family by id', async () => {
        const store = new SqliteTokenFamilyStore({ dbPath: ':memory:' })
        const service = new LocalAuthService({ store })
        const testApp = new Hono()
          .use('/auth/*', requireTrustedAppOrigin())
          .route('/auth', createLocalAuthRoutes({ service }))

        const tokenRes = await testApp.request(
          'http://127.0.0.1:9105/auth/local-token',
          { headers: { Host: '127.0.0.1:9105' } },
          loopbackEnv(),
        )
        const { token, refreshToken } = await tokenRes.json()
        const families = service.listFamilies()
        expect(families).toHaveLength(1)
        const familyId = families[0].familyId

        const revokeRes = await testApp.request(
          `http://127.0.0.1:9105/auth/admin/families/${familyId}/revoke`,
          {
            method: 'POST',
            headers: { Host: '127.0.0.1:9105', [LOCAL_AUTH_HEADER]: token },
          },
          loopbackEnv(),
        )
        expect(revokeRes.status).toBe(200)
        expect(await revokeRes.json()).toEqual({ revoked: true })

        // The revoked family's access token is now invalid, so fetch a fresh
        // admin token before querying the admin families list.
        const freshRes = await testApp.request(
          'http://127.0.0.1:9105/auth/local-token',
          { headers: { Host: '127.0.0.1:9105' } },
          loopbackEnv(),
        )
        const { token: freshToken } = await freshRes.json()

        const list = await testApp.request(
          'http://127.0.0.1:9105/auth/admin/families?status=revoked',
          {
            headers: {
              Host: '127.0.0.1:9105',
              [LOCAL_AUTH_HEADER]: freshToken,
            },
          },
          loopbackEnv(),
        )
        const listBody = await list.json()
        expect(listBody.families).toHaveLength(1)
        expect(listBody.families[0].status).toBe('revoked')

        // Refresh token from the revoked family is rejected.
        const refreshRes = await testApp.request(
          'http://127.0.0.1:9105/auth/refresh',
          {
            method: 'POST',
            headers: {
              Host: '127.0.0.1:9105',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ refreshToken }),
          },
          loopbackEnv(),
        )
        expect(refreshRes.status).toBe(401)
      })

      it('returns 404 when revoking an unknown family', async () => {
        const store = new SqliteTokenFamilyStore({ dbPath: ':memory:' })
        const service = new LocalAuthService({ store })
        const testApp = new Hono()
          .use('/auth/*', requireTrustedAppOrigin())
          .route('/auth', createLocalAuthRoutes({ service }))

        const tokenRes = await testApp.request(
          'http://127.0.0.1:9105/auth/local-token',
          { headers: { Host: '127.0.0.1:9105' } },
          loopbackEnv(),
        )
        const { token } = await tokenRes.json()

        const res = await testApp.request(
          'http://127.0.0.1:9105/auth/admin/families/does-not-exist/revoke',
          {
            method: 'POST',
            headers: { Host: '127.0.0.1:9105', [LOCAL_AUTH_HEADER]: token },
          },
          loopbackEnv(),
        )
        expect(res.status).toBe(404)
      })

      it('cleans up old revoked families and audit rows', async () => {
        const store = new SqliteTokenFamilyStore({ dbPath: ':memory:' })
        const service = new LocalAuthService({
          store,
          retention: {
            familyRetentionMs: 60_000,
            auditRetentionMs: 60_000,
            rateLimitRetentionMs: 60_000,
          },
        })
        const testApp = new Hono()
          .use('/auth/*', requireTrustedAppOrigin())
          .route('/auth', createLocalAuthRoutes({ service }))

        const tokenRes = await testApp.request(
          'http://127.0.0.1:9105/auth/local-token',
          { headers: { Host: '127.0.0.1:9105' } },
          loopbackEnv(),
        )
        const { refreshToken } = await tokenRes.json()

        // Rotate once to generate audit events and a rotated family state.
        await testApp.request(
          'http://127.0.0.1:9105/auth/refresh',
          {
            method: 'POST',
            headers: {
              Host: '127.0.0.1:9105',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ refreshToken }),
          },
          loopbackEnv(),
        )

        // Issuing a new initial token revokes all prior families. The old
        // rotated family becomes revoked, and we get a fresh admin token that
        // can still call cleanup.
        const freshRes = await testApp.request(
          'http://127.0.0.1:9105/auth/local-token',
          { headers: { Host: '127.0.0.1:9105' } },
          loopbackEnv(),
        )
        const { token: freshToken } = await freshRes.json()

        // Wait a few milliseconds so cleanup's Date.now() is strictly later
        // than the rotated_at timestamps created above.
        await new Promise((resolve) => setTimeout(resolve, 5))

        const cleanupRes = await testApp.request(
          'http://127.0.0.1:9105/auth/admin/cleanup',
          {
            method: 'POST',
            headers: {
              Host: '127.0.0.1:9105',
              'Content-Type': 'application/json',
              [LOCAL_AUTH_HEADER]: freshToken,
            },
            body: JSON.stringify({
              familyRetentionMs: 0,
              auditRetentionMs: 0,
              rateLimitRetentionMs: 0,
            }),
          },
          loopbackEnv(),
        )
        expect(cleanupRes.status).toBe(200)
        const cleanupBody = await cleanupRes.json()
        expect(cleanupBody.familiesDeleted).toBeGreaterThanOrEqual(1)
        expect(cleanupBody.auditRowsDeleted).toBeGreaterThanOrEqual(1)
        expect(cleanupBody.rateLimitRowsDeleted).toBeGreaterThanOrEqual(0)

        // Only the newly issued admin family remains.
        const listAfter = service.listFamilies()
        expect(listAfter).toHaveLength(1)
      })
    })
  })
})
