/**
 * @license
 * Copyright 2025 BrowserOS
 *
 * First suite for src/lib/clients/gateway.ts.
 *
 * Every exported symbol of the module is exercised below and none had to
 * be left out, so there is no export whose behaviour is blocked by a live
 * dependency: both fetching functions are driven through a stubbed
 * globalThis.fetch, and getLLMConfigFromProvider is a pure function. The
 * suite therefore needs no network, no database and no container.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import {
  type BrowserOSConfig,
  fetchBrowserOSConfig,
  fetchCredits,
  getLLMConfigFromProvider,
} from '../../src/lib/clients/gateway'

describe('gatewayContract', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  const stubFetch = (implementation: () => Promise<Response>) => {
    globalThis.fetch = mock(implementation) as typeof globalThis.fetch
  }

  it('fetchBrowserOSConfig requests the config URL and validates what comes back', async () => {
    const config: BrowserOSConfig = {
      providers: [
        {
          name: 'default',
          model: 'gpt-default',
          apiKey: 'key-default',
          dailyRateLimit: 40,
        },
        {
          name: 'openrouter',
          model: 'or-model',
          apiKey: 'key-or',
          baseUrl: 'https://openrouter.example/api/v1',
          providerType: 'openrouter',
        },
      ],
    }
    const fetchMock = mock(() => Promise.resolve(jsonResponse(config)))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    await expect(
      fetchBrowserOSConfig('https://cfg.example/config'),
    ).resolves.toEqual(config)

    // Anonymous request: GET the config URL, JSON content type, no id header.
    const anonymous = fetchMock.mock.calls[0]
    expect(anonymous?.[0]).toBe('https://cfg.example/config')
    expect(anonymous?.[1]?.method).toBe('GET')
    const anonymousHeaders = anonymous?.[1]?.headers as Record<string, string>
    expect(anonymousHeaders['Content-Type']).toBe('application/json')
    expect(anonymousHeaders['X-BrowserOS-ID']).toBeUndefined()

    // Identified request: the BrowserOS id travels in a header.
    await fetchBrowserOSConfig('https://cfg.example/config', 'browseros-42')
    const identified = fetchMock.mock.calls[1]
    const identifiedHeaders = identified?.[1]?.headers as Record<string, string>
    expect(identifiedHeaders['X-BrowserOS-ID']).toBe('browseros-42')

    // A non-OK answer is an error that reports the status and the body.
    stubFetch(() =>
      Promise.resolve(new Response('gateway exploded', { status: 500 })),
    )
    await expect(
      fetchBrowserOSConfig('https://cfg.example/config'),
    ).rejects.toThrow('Failed to fetch config: 500')
    await expect(
      fetchBrowserOSConfig('https://cfg.example/config'),
    ).rejects.toThrow('gateway exploded')

    // An OK answer without providers is rejected just the same.
    stubFetch(() => Promise.resolve(jsonResponse({ providers: [] })))
    await expect(
      fetchBrowserOSConfig('https://cfg.example/config'),
    ).rejects.toThrow('providers array is empty or missing')
    stubFetch(() =>
      Promise.resolve(
        jsonResponse({ providers: [{ name: 'default', model: 'm' }] }),
      ),
    )
    await expect(
      fetchBrowserOSConfig('https://cfg.example/config'),
    ).rejects.toThrow('Invalid provider: missing name, model, or apiKey')
  })

  it('getLLMConfigFromProvider maps a named provider onto an LLM config', () => {
    const config: BrowserOSConfig = {
      providers: [
        {
          name: 'default',
          model: 'gpt-default',
          apiKey: 'key-default',
          baseUrl: 'https://default.example/v1',
          providerType: 'azure',
        },
        { name: 'openrouter', model: 'or-model', apiKey: 'key-or' },
      ],
    }

    // Without a name the 'default' provider is used.
    const fromDefault = getLLMConfigFromProvider(config)
    expect(fromDefault.modelName).toBe('gpt-default')
    expect(fromDefault.baseUrl).toBe('https://default.example/v1')
    expect(fromDefault.apiKey).toBe('key-default')
    expect(fromDefault.providerType).toBe('azure')
    expect(fromDefault.provider).toMatchObject({
      name: 'default',
      model: 'gpt-default',
      apiKey: 'key-default',
    })

    // A named provider is used when asked for by name.
    const fromNamed = getLLMConfigFromProvider(config, 'openrouter')
    expect(fromNamed.modelName).toBe('or-model')
    expect(fromNamed.apiKey).toBe('key-or')
    expect(fromNamed.baseUrl).toBeUndefined()

    // An unknown provider is an error that names what is available.
    expect(() => getLLMConfigFromProvider(config, 'anthropic')).toThrow(
      "Provider 'anthropic' not found in config. Available providers: default, openrouter",
    )
  })

  it('fetchCredits reads the credits endpoint for a BrowserOS id', async () => {
    const credits = {
      credits: 12.5,
      dailyLimit: 40,
      lastResetAt: '2025-09-04T00:00:00.000Z',
    }
    const fetchMock = mock(() => Promise.resolve(jsonResponse(credits)))
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    await expect(
      fetchCredits('http://gateway.example:8080/', 'browseros-42'),
    ).resolves.toEqual(credits)

    // The id is appended to the gateway base as a path segment.
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://gateway.example:8080/credits/browseros-42',
    )

    // A non-OK answer is an error that reports the status and the body.
    stubFetch(() =>
      Promise.resolve(new Response('no such id', { status: 404 })),
    )
    await expect(
      fetchCredits('http://gateway.example:8080', 'nobody'),
    ).rejects.toThrow('Failed to fetch credits: 404')
    await expect(
      fetchCredits('http://gateway.example:8080', 'nobody'),
    ).rejects.toThrow('no such id')
  })
})
