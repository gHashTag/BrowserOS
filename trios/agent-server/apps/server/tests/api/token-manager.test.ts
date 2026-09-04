/**
 * @license
 * Copyright 2025 BrowserOS
 */

// Contract suite for src/lib/clients/oauth/token-manager.ts (#1409).
//
// Export census of the subject (its single runtime symbol plus four
// type-only exports that have no runtime behaviour of their own — they shape
// the values this suite asserts against):
//
//   exercised by assertions below : 1 — OAuthTokenManager (every test)
//   blocked by a live dependency   : 0
//   1 + 0 = 1
//
// Nothing was left out for needing a live dependency: the manager takes its
// collaborators through the constructor, so the suite injects an in-memory
// token store and a fake callback server, and serves every authorization,
// token and device-code endpoint from an in-test fetch stub. No network, no
// database, no container.
//
// The suite pins observable behaviour rather than wiring: it reads returned
// URLs and tokens, persisted store contents, thrown error messages, the
// outgoing HTTP requests (the manager's external boundary), and the callback
// server's running state, which the real OAuthCallbackServer exposes as
// isRunning(). The device-code poll loop runs to completion because
// setTimeout is patched to fire immediately for its duration, so no test
// waits out a real poll interval.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from 'bun:test'
import { OAUTH_CALLBACK_PORT } from '@browseros/shared/constants/ports'
import { TIMEOUTS } from '@browseros/shared/constants/timeouts'
import type { OAuthCallbackServer } from '../../src/lib/clients/oauth/callback-server'
import { OAUTH_PROVIDERS } from '../../src/lib/clients/oauth/providers'
import {
  OAuthTokenManager,
  type OAuthTokenStore,
  type StoredOAuthTokens,
} from '../../src/lib/clients/oauth/token-manager'

const originalFetch = globalThis.fetch
// Captured before any test patches timers, so waits still sleep for real.
const realSetTimeout = globalThis.setTimeout

// ---------------------------------------------------------------------------
// Fakes for the manager's two constructor collaborators.
// ---------------------------------------------------------------------------

/** In-memory stand-in for the Drizzle-backed store, same observable rules. */
class InMemoryTokenStore implements OAuthTokenStore {
  private readonly rows = new Map<string, StoredOAuthTokens>()

  private key(browserosId: string, provider: string): string {
    return `${browserosId}\u0000${provider}`
  }

  upsertTokens(
    browserosId: string,
    provider: string,
    tokens: StoredOAuthTokens,
  ): void {
    this.rows.set(this.key(browserosId, provider), { ...tokens })
  }

  getTokens(browserosId: string, provider: string): StoredOAuthTokens | null {
    return this.rows.get(this.key(browserosId, provider)) ?? null
  }

  deleteTokens(browserosId: string, provider: string): void {
    this.rows.delete(this.key(browserosId, provider))
  }

  getStatus(
    browserosId: string,
    provider: string,
  ): { authenticated: boolean; email?: string; provider: string } {
    const row = this.rows.get(this.key(browserosId, provider))
    return {
      authenticated: row != null,
      email: row?.email ?? undefined,
      provider,
    }
  }
}

/**
 * Mirrors the lifecycle the real callback server documents: bound only once
 * a login flow asks for it (ensureRunning), released on stop.
 */
class FakeCallbackServer {
  running = false

  async ensureRunning(): Promise<void> {
    this.running = true
  }

  stop(): void {
    this.running = false
  }

  // Shape compatibility with the real OAuthCallbackServer.
  isRunning(): boolean {
    return this.running
  }

  setTokenManager(): void {}
}

function makeManager(browserosId = 'browseros-test-1') {
  const store = new InMemoryTokenStore()
  const callbackServer = new FakeCallbackServer()
  const manager = new OAuthTokenManager(
    store,
    browserosId,
    callbackServer as unknown as OAuthCallbackServer,
  )
  return { store, callbackServer, manager }
}

// ---------------------------------------------------------------------------
// HTTP stub: every endpoint the manager can call is served from the test.
// ---------------------------------------------------------------------------

interface LoggedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function stubHttp(
  respond: (url: string) => Response | Promise<Response>,
): LoggedRequest[] {
  const logged: LoggedRequest[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    logged.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body == null ? '' : String(init.body),
    })
    return await respond(url)
  }) as typeof fetch
  return logged
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function htmlResponse(status = 200): Response {
  return new Response('<html>blocked by a WAF</html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  })
}

/** Fires setTimeout callbacks on the next microtask, so poll intervals and
 *  the poll safety margin cost nothing while the patch is installed. */
function makeTimersInstant(): () => void {
  const original = globalThis.setTimeout
  globalThis.setTimeout = ((fn: () => void) => {
    queueMicrotask(fn)
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  return () => {
    globalThis.setTimeout = original
  }
}

async function waitFor(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 5)
    })
  }
}

/** Lets the fire-and-forget device-code poll reach the token endpoint and
 *  consume its answer before the caller restores real timers. */
async function letDevicePollFinish(
  logged: LoggedRequest[],
  tokenEndpoint: string,
): Promise<void> {
  await waitFor(
    () => logged.some((request) => request.url === tokenEndpoint),
    `the device-code poll to reach ${tokenEndpoint}`,
  )
  await new Promise<void>((resolve) => {
    realSetTimeout(resolve, 10)
  })
}

// ---------------------------------------------------------------------------
// Small helpers shared by the scenarios.
// ---------------------------------------------------------------------------

function providerConfig(id: keyof typeof OAUTH_PROVIDERS | string) {
  const provider = OAUTH_PROVIDERS[id]
  if (!provider) throw new Error(`test setup: no provider registered as ${id}`)
  return provider
}

function queryParamOf(url: string, name: string): string {
  const value = new URL(url).searchParams.get(name)
  if (value === null) throw new Error(`test setup: no ${name} in ${url}`)
  return value
}

function soleRequestTo(logged: LoggedRequest[], url: string): LoggedRequest {
  const found = logged.filter((request) => request.url === url)
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one request to ${url}, saw ${found.length}`,
    )
  }
  return found[0] as LoggedRequest
}

/** Unsigned JWT whose payload the manager reads for identity claims. */
function accessTokenWithClaims(claims: Record<string, unknown>): string {
  return `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify(claims))}.sig`
}

/** The S256 transform PKCE requires: base64url(SHA-256(verifier)). */
async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  )
  let binary = ''
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/

// ---------------------------------------------------------------------------

describe('tokenManagerContract', () => {
  beforeEach(() => {
    // The suite must never touch the network: an unstubbed fetch fails
    // loudly instead of quietly reaching whatever URL the manager built.
    globalThis.fetch = (() => {
      throw new Error(
        'unexpected network access in the token-manager contract suite',
      )
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('OAuthTokenManager.generateAuthorizationUrl', () => {
    it('builds the provider authorization URL with a PKCE S256 challenge and starts the callback server', async () => {
      const { manager, callbackServer } = makeManager()
      const provider = providerConfig('chatgpt-pro')

      const loginUrl = await manager.generateAuthorizationUrl('chatgpt-pro')

      expect(loginUrl.startsWith(`${provider.authEndpoint}?`)).toBe(true)
      const query = new URL(loginUrl).searchParams
      expect(query.get('response_type')).toBe('code')
      expect(query.get('client_id')).toBe(provider.clientId)
      expect(query.get('redirect_uri')).toBe(
        `http://localhost:${OAUTH_CALLBACK_PORT}/auth/callback`,
      )
      expect(query.get('code_challenge')).toMatch(CODE_VERIFIER_PATTERN)
      expect(query.get('code_challenge_method')).toBe('S256')
      expect(query.get('scope')).toBe(provider.scopes.join(' '))
      expect(query.get('state')).toMatch(/^[A-Za-z0-9_-]{10,}$/)
      // Provider-specific extras ride along (OpenAI's originator mark).
      expect(query.get('originator')).toBe('browseros')
      // Initiating a login is what brings the callback server up.
      expect(callbackServer.running).toBe(true)
    })

    it('starts a fresh flow per call, never reusing state or challenge', async () => {
      const { manager } = makeManager()

      const first = await manager.generateAuthorizationUrl('chatgpt-pro')
      const second = await manager.generateAuthorizationUrl('chatgpt-pro')

      const firstState = queryParamOf(first, 'state')
      const secondState = queryParamOf(second, 'state')
      expect(firstState).not.toBe(secondState)
      expect(queryParamOf(first, 'code_challenge')).not.toBe(
        queryParamOf(second, 'code_challenge'),
      )
    })

    it('rejects unknown providers', async () => {
      const { manager } = makeManager()

      await expect(manager.generateAuthorizationUrl('nope')).rejects.toThrow(
        'Unknown OAuth provider: nope',
      )
    })
  })

  describe('OAuthTokenManager.handleCallback', () => {
    it('exchanges the code at the token endpoint with the matching PKCE verifier and stores the tokens it gets back', async () => {
      const { manager, store, callbackServer } =
        makeManager('browseros-login-1')
      const provider = providerConfig('chatgpt-pro')
      const loginUrl = await manager.generateAuthorizationUrl(
        'chatgpt-pro',
        'browseros://settings/auth',
      )
      const state = queryParamOf(loginUrl, 'state')
      const challenge = queryParamOf(loginUrl, 'code_challenge')
      const issuedToken = accessTokenWithClaims({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_12345' },
        'https://api.openai.com/profile': { email: 'dev@example.test' },
      })
      const logged = stubHttp((url) =>
        url === provider.tokenEndpoint
          ? jsonResponse({
              access_token: issuedToken,
              refresh_token: 'rt-new',
              expires_in: 3600,
            })
          : jsonResponse({}, 500),
      )

      const before = Date.now()
      const result = await manager.handleCallback('the-auth-code', state)
      const after = Date.now()

      // The exchange request: a code grant from the registered client, back
      // to the callback redirect, proving possession of the flow's verifier.
      const exchange = soleRequestTo(logged, provider.tokenEndpoint)
      expect(exchange.method).toBe('POST')
      expect(exchange.headers['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      )
      const form = new URLSearchParams(exchange.body)
      expect(form.get('grant_type')).toBe('authorization_code')
      expect(form.get('client_id')).toBe(provider.clientId)
      expect(form.get('code')).toBe('the-auth-code')
      expect(form.get('redirect_uri')).toBe(
        `http://localhost:${OAUTH_CALLBACK_PORT}/auth/callback`,
      )
      const verifier = form.get('code_verifier') ?? ''
      expect(verifier).toMatch(CODE_VERIFIER_PATTERN)
      expect(await sha256Base64Url(verifier)).toBe(challenge)

      // The returned tokens carry the response's access token, the identity
      // claims inside it, and a computed expiry; they are persisted for this
      // profile, and the caller learns where to send the user back to.
      expect(result.tokens.accessToken).toBe(issuedToken)
      expect(result.tokens.refreshToken).toBe('rt-new')
      expect(result.tokens.email).toBe('dev@example.test')
      expect(result.tokens.accountId).toBe('acct_12345')
      expect(result.tokens.expiresAt).toBeGreaterThanOrEqual(
        before + 3600_000 - 2_000,
      )
      expect(result.tokens.expiresAt).toBeLessThanOrEqual(
        after + 3600_000 + 2_000,
      )
      expect(result.redirectBackUrl).toBe('browseros://settings/auth')
      expect(store.getTokens('browseros-login-1', 'chatgpt-pro')).toEqual(
        result.tokens,
      )
      expect(manager.getTokens('chatgpt-pro')).toEqual(result.tokens)
      // A completed flow releases the callback port and cannot be replayed.
      expect(callbackServer.running).toBe(false)
      await expect(manager.handleCallback('again', state)).rejects.toThrow(
        'Invalid or expired OAuth state',
      )
    })

    it('also reads the plain identity claims some providers issue', async () => {
      const { manager } = makeManager()
      const provider = providerConfig('chatgpt-pro')
      const loginUrl = await manager.generateAuthorizationUrl('chatgpt-pro')
      const state = queryParamOf(loginUrl, 'state')
      stubHttp((url) =>
        url === provider.tokenEndpoint
          ? jsonResponse({
              access_token: accessTokenWithClaims({
                email: 'plain@example.test',
                account_id: 'acct_plain',
              }),
              expires_in: 60,
            })
          : jsonResponse({}, 500),
      )

      const result = await manager.handleCallback('code', state)

      expect(result.tokens.email).toBe('plain@example.test')
      expect(result.tokens.accountId).toBe('acct_plain')
    })

    it('still logs in when the provider issues no refresh token', async () => {
      const { manager } = makeManager()
      const provider = providerConfig('chatgpt-pro')
      const loginUrl = await manager.generateAuthorizationUrl('chatgpt-pro')
      const state = queryParamOf(loginUrl, 'state')
      stubHttp((url) =>
        url === provider.tokenEndpoint
          ? jsonResponse({
              access_token: accessTokenWithClaims({}),
              expires_in: 3600,
            })
          : jsonResponse({}, 500),
      )

      const result = await manager.handleCallback('code', state)

      expect(result.tokens.refreshToken).toBe('')
    })

    it('reports token-endpoint failures without consuming the flow', async () => {
      const { manager, store } = makeManager()
      const provider = providerConfig('chatgpt-pro')
      const loginUrl = await manager.generateAuthorizationUrl('chatgpt-pro')
      const state = queryParamOf(loginUrl, 'state')

      stubHttp(() => jsonResponse({}, 400))
      await expect(manager.handleCallback('the-code', state)).rejects.toThrow(
        'Token exchange failed: 400',
      )
      expect(store.getTokens('browseros-test-1', 'chatgpt-pro')).toBeNull()

      // The flow survives the failure, so the user can retry it.
      stubHttp((url) =>
        url === provider.tokenEndpoint
          ? jsonResponse({
              access_token: accessTokenWithClaims({}),
              refresh_token: 'rt-late',
              expires_in: 3600,
            })
          : jsonResponse({}, 500),
      )
      const retried = await manager.handleCallback('the-code', state)
      expect(retried.tokens.refreshToken).toBe('rt-late')
    })

    it('rejects callbacks whose state no flow knows', async () => {
      const { manager } = makeManager()

      await expect(
        manager.handleCallback('code', 'state-nobody-started'),
      ).rejects.toThrow('Invalid or expired OAuth state')
    })

    it('expires flows older than the TTL and then discards them', async () => {
      const { manager } = makeManager()
      const flowStart = new Date('2026-01-01T00:00:00Z')
      setSystemTime(flowStart)
      try {
        const loginUrl = await manager.generateAuthorizationUrl('chatgpt-pro')
        const state = queryParamOf(loginUrl, 'state')

        setSystemTime(
          new Date(flowStart.getTime() + TIMEOUTS.OAUTH_FLOW_TTL + 1),
        )
        await expect(manager.handleCallback('code', state)).rejects.toThrow(
          'OAuth flow expired. Please try again.',
        )
        // Refusing the expired flow also removes it: a replayed callback is
        // treated as unknown state, not as an expired one forever.
        await expect(manager.handleCallback('code', state)).rejects.toThrow(
          'Invalid or expired OAuth state',
        )
      } finally {
        setSystemTime(false as unknown as number)
      }
    })

    it('keeps the callback server up while another login flow is still pending', async () => {
      const { manager, callbackServer } = makeManager()
      const provider = providerConfig('chatgpt-pro')
      const firstUrl = await manager.generateAuthorizationUrl('chatgpt-pro')
      const secondUrl = await manager.generateAuthorizationUrl('chatgpt-pro')
      const firstState = queryParamOf(firstUrl, 'state')
      const secondState = queryParamOf(secondUrl, 'state')
      stubHttp((url) =>
        url === provider.tokenEndpoint
          ? jsonResponse({
              access_token: accessTokenWithClaims({}),
              refresh_token: 'rt',
              expires_in: 3600,
            })
          : jsonResponse({}, 500),
      )

      await manager.handleCallback('code-1', firstState)

      // One flow done, one still open: the port stays bound for the second.
      expect(callbackServer.running).toBe(true)
      await expect(
        manager.handleCallback('code-1', firstState),
      ).rejects.toThrow('Invalid or expired OAuth state')

      await manager.handleCallback('code-2', secondState)

      expect(callbackServer.running).toBe(false)
    })
  })

  describe('OAuthTokenManager.stopCallbackServer', () => {
    it('stops the callback server on demand, started or not', async () => {
      const { manager, callbackServer } = makeManager()

      // Stopping an idle manager is not an error.
      manager.stopCallbackServer()
      expect(callbackServer.running).toBe(false)

      await manager.generateAuthorizationUrl('chatgpt-pro')
      expect(callbackServer.running).toBe(true)

      manager.stopCallbackServer()
      expect(callbackServer.running).toBe(false)
    })
  })

  describe('OAuthTokenManager.startDeviceCodeFlow', () => {
    it('returns the device code with the complete verification URL, asking in the provider format', async () => {
      const { manager } = makeManager()
      const provider = providerConfig('github-copilot')
      const restoreTimers = makeTimersInstant()
      const logged = stubHttp((url) => {
        if (url === provider.authEndpoint) {
          return jsonResponse({
            device_code: 'device-code-1',
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://github.com/login/device',
            verification_uri_complete:
              'https://github.com/login/device?user_code=WDJB-MJHT',
            expires_in: 900,
            interval: 5,
          })
        }
        return jsonResponse({ error: 'expired_token' })
      })
      try {
        const result = await manager.startDeviceCodeFlow('github-copilot')

        expect(result).toEqual({
          userCode: 'WDJB-MJHT',
          verificationUri:
            'https://github.com/login/device?user_code=WDJB-MJHT',
          expiresIn: 900,
        })
        const request = soleRequestTo(logged, provider.authEndpoint)
        expect(request.method).toBe('POST')
        expect(request.headers.Accept).toBe('application/json')
        expect(request.headers['Content-Type']).toBe('application/json')
        // JSON providers get a JSON body with no PKCE material.
        expect(JSON.parse(request.body)).toEqual({
          client_id: provider.clientId,
          scope: provider.scopes.join(' '),
        })
        await letDevicePollFinish(logged, provider.tokenEndpoint)
      } finally {
        restoreTimers()
      }
    })

    it('falls back to the plain verification URL when the provider offers no complete one', async () => {
      const { manager } = makeManager()
      const provider = providerConfig('github-copilot')
      const restoreTimers = makeTimersInstant()
      const logged = stubHttp((url) => {
        if (url === provider.authEndpoint) {
          return jsonResponse({
            device_code: 'device-code-1',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          })
        }
        return jsonResponse({ error: 'expired_token' })
      })
      try {
        const result = await manager.startDeviceCodeFlow('github-copilot')

        expect(result.verificationUri).toBe('https://github.com/login/device')
        await letDevicePollFinish(logged, provider.tokenEndpoint)
      } finally {
        restoreTimers()
      }
    })

    it('sends form data with a PKCE challenge when the provider requires it', async () => {
      const { manager } = makeManager()
      const provider = providerConfig('qwen-code')
      const restoreTimers = makeTimersInstant()
      const logged = stubHttp((url) => {
        if (url === provider.authEndpoint) {
          return jsonResponse({
            device_code: 'device-code-2',
            user_code: 'QWEN-5678',
            verification_uri: 'https://chat.qwen.ai/device',
            expires_in: 899,
            interval: 5,
          })
        }
        return jsonResponse({ error: 'expired_token' })
      })
      try {
        const result = await manager.startDeviceCodeFlow('qwen-code')

        expect(result.userCode).toBe('QWEN-5678')
        const request = soleRequestTo(logged, provider.authEndpoint)
        expect(request.headers['Content-Type']).toBe(
          'application/x-www-form-urlencoded',
        )
        const form = new URLSearchParams(request.body)
        expect(form.get('client_id')).toBe(provider.clientId)
        expect(form.get('scope')).toBe(provider.scopes.join(' '))
        expect(form.get('code_challenge')).toMatch(CODE_VERIFIER_PATTERN)
        expect(form.get('code_challenge_method')).toBe('S256')
        await letDevicePollFinish(logged, provider.tokenEndpoint)
      } finally {
        restoreTimers()
      }
    })

    it('rejects unknown providers', async () => {
      const { manager } = makeManager()

      await expect(manager.startDeviceCodeFlow('nope')).rejects.toThrow(
        'Unknown OAuth provider: nope',
      )
    })

    it('rejects HTML answers a WAF put in front of the auth endpoint', async () => {
      const { manager } = makeManager()
      const provider = providerConfig('github-copilot')
      stubHttp((url) =>
        url === provider.authEndpoint ? htmlResponse() : jsonResponse({}, 500),
      )

      await expect(
        manager.startDeviceCodeFlow('github-copilot'),
      ).rejects.toThrow('Authentication service temporarily unavailable')
    })

    it('rejects a 200 response carrying an OAuth error', async () => {
      const { manager } = makeManager()
      const provider = providerConfig('github-copilot')
      stubHttp((url) =>
        url === provider.authEndpoint
          ? jsonResponse({ error: 'invalid_scope' })
          : jsonResponse({}, 500),
      )

      await expect(
        manager.startDeviceCodeFlow('github-copilot'),
      ).rejects.toThrow('Device code error: invalid_scope')
    })

    it('rejects device responses missing their codes', async () => {
      const { manager } = makeManager()
      const provider = providerConfig('github-copilot')
      stubHttp((url) =>
        url === provider.authEndpoint
          ? jsonResponse({ device_code: 'device-code-1' })
          : jsonResponse({}, 500),
      )

      await expect(
        manager.startDeviceCodeFlow('github-copilot'),
      ).rejects.toThrow('Invalid device code response')
    })

    it('rejects non-OK device-code responses', async () => {
      const { manager } = makeManager()
      const provider = providerConfig('github-copilot')
      stubHttp((url) =>
        url === provider.authEndpoint
          ? jsonResponse({}, 400)
          : jsonResponse({}, 500),
      )

      await expect(
        manager.startDeviceCodeFlow('github-copilot'),
      ).rejects.toThrow('Failed to request device code: 400')
    })
  })

  describe('OAuthTokenManager.startDeviceCodeFlow — background polling', () => {
    it('stores tokens once the user approves, polling through authorization_pending', async () => {
      const { manager, store } = makeManager()
      const provider = providerConfig('github-copilot')
      const restoreTimers = makeTimersInstant()
      let polls = 0
      stubHttp((url) => {
        if (url === provider.authEndpoint) {
          return jsonResponse({
            device_code: 'device-code-1',
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          })
        }
        polls += 1
        return polls === 1
          ? jsonResponse({ error: 'authorization_pending' })
          : jsonResponse({
              access_token: 'gho_device',
              refresh_token: 'ghr_device',
              expires_in: 28_800,
            })
      })
      try {
        await manager.startDeviceCodeFlow('github-copilot')
        const before = Date.now()
        await waitFor(
          () => store.getTokens('browseros-test-1', 'github-copilot') != null,
          'the poll to store the approved tokens',
        )
        const after = Date.now()

        const tokens = manager.getTokens('github-copilot')
        expect(tokens?.accessToken).toBe('gho_device')
        expect(tokens?.refreshToken).toBe('ghr_device')
        // The device flow carries no identity claims.
        expect(tokens?.email).toBeUndefined()
        expect(tokens?.accountId).toBeUndefined()
        expect(tokens?.expiresAt).toBeGreaterThanOrEqual(
          before + 28_800_000 - 2_000,
        )
        expect(tokens?.expiresAt).toBeLessThanOrEqual(
          after + 28_800_000 + 2_000,
        )
        // Approval arrived on the second poll: one pending answer first.
        expect(polls).toBe(2)
      } finally {
        restoreTimers()
      }
    })

    it('ends the flow without storing anything when the user denies it', async () => {
      const { manager, store } = makeManager()
      const provider = providerConfig('github-copilot')
      const restoreTimers = makeTimersInstant()
      const logged = stubHttp((url) => {
        if (url === provider.authEndpoint) {
          return jsonResponse({
            device_code: 'device-code-1',
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          })
        }
        return jsonResponse({ error: 'access_denied' })
      })
      try {
        await manager.startDeviceCodeFlow('github-copilot')

        await letDevicePollFinish(logged, provider.tokenEndpoint)
        expect(store.getTokens('browseros-test-1', 'github-copilot')).toBeNull()
      } finally {
        restoreTimers()
      }
    })
  })

  describe('OAuthTokenManager.refreshIfExpired', () => {
    it('returns null for a provider with no tokens, without contacting anyone', async () => {
      const { manager } = makeManager()
      const logged = stubHttp(() => jsonResponse({}))

      expect(await manager.refreshIfExpired('chatgpt-pro')).toBeNull()
      expect(logged).toHaveLength(0)
    })

    it('returns never-expiring tokens untouched, without contacting anyone', async () => {
      const { manager } = makeManager()
      manager.storeTokens('github-copilot', {
        accessToken: 'gho_forever',
        refreshToken: 'ghr_forever',
        expiresIn: 0,
      })
      const logged = stubHttp(() => jsonResponse({}))

      const tokens = await manager.refreshIfExpired('github-copilot')

      expect(tokens).toEqual({
        accessToken: 'gho_forever',
        refreshToken: 'ghr_forever',
        expiresAt: 0,
        email: undefined,
        accountId: undefined,
      })
      expect(logged).toHaveLength(0)
    })

    it('returns still-valid tokens untouched, without contacting anyone', async () => {
      const { manager } = makeManager()
      manager.storeTokens('chatgpt-pro', {
        accessToken: 'at-fresh',
        refreshToken: 'rt-fresh',
        expiresIn: 3_600,
      })
      const logged = stubHttp(() => jsonResponse({}))

      const tokens = await manager.refreshIfExpired('chatgpt-pro')

      expect(tokens?.accessToken).toBe('at-fresh')
      expect(logged).toHaveLength(0)
    })

    it('refreshes near-expiry tokens, keeping identity and refresh token when the new one carries none', async () => {
      const { manager, store } = makeManager()
      const provider = providerConfig('chatgpt-pro')
      store.upsertTokens('browseros-test-1', 'chatgpt-pro', {
        accessToken: 'at-old',
        refreshToken: 'rt-old',
        expiresAt: Date.now() + 10_000,
        email: 'old@example.test',
        accountId: 'acct_old',
      })
      const logged = stubHttp((url) =>
        url === provider.tokenEndpoint
          ? jsonResponse({
              access_token: 'opaque-new',
              expires_in: 3600,
            })
          : jsonResponse({}, 500),
      )

      const before = Date.now()
      const refreshed = await manager.refreshIfExpired('chatgpt-pro')
      const after = Date.now()

      const request = soleRequestTo(logged, provider.tokenEndpoint)
      const form = new URLSearchParams(request.body)
      expect(form.get('grant_type')).toBe('refresh_token')
      expect(form.get('client_id')).toBe(provider.clientId)
      expect(form.get('refresh_token')).toBe('rt-old')

      expect(refreshed?.accessToken).toBe('opaque-new')
      // An opaque token exposes no claims, so the stored identity survives.
      expect(refreshed?.refreshToken).toBe('rt-old')
      expect(refreshed?.email).toBe('old@example.test')
      expect(refreshed?.accountId).toBe('acct_old')
      expect(refreshed?.expiresAt).toBeGreaterThanOrEqual(
        before + 3600_000 - 2_000,
      )
      expect(refreshed?.expiresAt).toBeLessThanOrEqual(after + 3600_000 + 2_000)
      expect(manager.getTokens('chatgpt-pro')).toEqual(refreshed)
    })

    it('drops the session and asks to re-login when a near-expiry token has no refresh token', async () => {
      const { manager, store } = makeManager()
      store.upsertTokens('browseros-test-1', 'chatgpt-pro', {
        accessToken: 'at-dying',
        refreshToken: '',
        expiresAt: Date.now() + 60_000,
      })
      stubHttp(() => jsonResponse({}))

      await expect(manager.refreshIfExpired('chatgpt-pro')).rejects.toThrow(
        'chatgpt-pro session expired (no refresh token). Please re-login.',
      )
      expect(store.getTokens('browseros-test-1', 'chatgpt-pro')).toBeNull()
    })

    it('drops the session when the provider rejects the refresh', async () => {
      const { manager, store } = makeManager()
      const provider = providerConfig('chatgpt-pro')
      store.upsertTokens('browseros-test-1', 'chatgpt-pro', {
        accessToken: 'at-dying',
        refreshToken: 'rt-revoked',
        expiresAt: Date.now() + 60_000,
      })
      stubHttp((url) =>
        url === provider.tokenEndpoint
          ? jsonResponse({}, 400)
          : jsonResponse({}, 500),
      )

      await expect(manager.refreshIfExpired('chatgpt-pro')).rejects.toThrow(
        'ChatGPT Plus/Pro session expired. Please re-login.',
      )
      expect(store.getTokens('browseros-test-1', 'chatgpt-pro')).toBeNull()
    })

    it('refreshes once for concurrent callers on the same provider', async () => {
      const { manager, store } = makeManager()
      const provider = providerConfig('chatgpt-pro')
      store.upsertTokens('browseros-test-1', 'chatgpt-pro', {
        accessToken: 'at-shared',
        refreshToken: 'rt-shared',
        expiresAt: Date.now() + 60_000,
      })
      const logged = stubHttp(async (url) => {
        // A realistic round-trip so both callers are truly in flight.
        await new Promise<void>((resolve) => {
          realSetTimeout(resolve, 20)
        })
        return url === provider.tokenEndpoint
          ? jsonResponse({
              access_token: 'at-once',
              refresh_token: 'rt-rotated',
              expires_in: 3600,
            })
          : jsonResponse({}, 500)
      })

      const [first, second] = await Promise.all([
        manager.refreshIfExpired('chatgpt-pro'),
        manager.refreshIfExpired('chatgpt-pro'),
      ])

      // Providers rotate refresh tokens on use; two exchanges would break
      // the login, so concurrent callers share a single refresh.
      expect(
        logged.filter((r) => r.url === provider.tokenEndpoint),
      ).toHaveLength(1)
      expect(first?.accessToken).toBe('at-once')
      expect(second).toEqual(first)
      expect(manager.getTokens('chatgpt-pro')?.refreshToken).toBe('rt-rotated')
    })
  })

  describe('OAuthTokenManager — token bookkeeping', () => {
    it('stores extension-provided tokens with a computed expiry and reports the session', () => {
      const { manager } = makeManager()

      const before = Date.now()
      manager.storeTokens('qwen-code', {
        accessToken: 'at-ext',
        refreshToken: 'rt-ext',
        expiresIn: 3600,
      })
      const after = Date.now()

      const stored = manager.getTokens('qwen-code')
      expect(stored?.accessToken).toBe('at-ext')
      expect(stored?.refreshToken).toBe('rt-ext')
      expect(stored?.expiresAt).toBeGreaterThanOrEqual(
        before + 3600_000 - 2_000,
      )
      expect(stored?.expiresAt).toBeLessThanOrEqual(after + 3600_000 + 2_000)
      expect(manager.getStatus('qwen-code')).toEqual({
        authenticated: true,
        email: undefined,
        provider: 'qwen-code',
      })
    })

    it('marks tokens that never expire', () => {
      const { manager } = makeManager()

      manager.storeTokens('github-copilot', {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresIn: 0,
      })

      expect(manager.getTokens('github-copilot')?.expiresAt).toBe(0)
    })

    it('deletes a provider session', () => {
      const { manager } = makeManager()
      manager.storeTokens('qwen-code', {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresIn: 3600,
      })

      manager.deleteTokens('qwen-code')

      expect(manager.getTokens('qwen-code')).toBeNull()
      expect(manager.getStatus('qwen-code')).toEqual({
        authenticated: false,
        email: undefined,
        provider: 'qwen-code',
      })
    })

    it('keeps profiles apart: tokens stored for one id are invisible to another', () => {
      const store = new InMemoryTokenStore()
      const alice = new OAuthTokenManager(
        store,
        'alice',
        new FakeCallbackServer() as unknown as OAuthCallbackServer,
      )
      const bob = new OAuthTokenManager(
        store,
        'bob',
        new FakeCallbackServer() as unknown as OAuthCallbackServer,
      )

      alice.storeTokens('qwen-code', {
        accessToken: 'at-alice',
        refreshToken: 'rt-alice',
        expiresIn: 3600,
      })

      expect(alice.getTokens('qwen-code')?.accessToken).toBe('at-alice')
      expect(bob.getTokens('qwen-code')).toBeNull()
    })
  })
})
