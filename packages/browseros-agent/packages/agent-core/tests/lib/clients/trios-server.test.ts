/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for the thin Rust trios-server client — the eval harness's
 * only bridge to the production agent loop (`/agent/run`, `/agent/tools`).
 */

import { afterAll, describe, expect, it } from 'bun:test'
import {
  TriosServerClient,
  TriosServerError,
} from '../../../src/lib/clients/trios-server'

const received: { path: string; body: unknown }[] = []

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    received.push({
      path: url.pathname,
      body: req.method === 'POST' ? await req.json() : undefined,
    })
    if (url.pathname === '/agent/tools') {
      return Response.json({
        tools: [{ name: 'echo' }, { name: 'browser_goto' }],
      })
    }
    if (url.pathname === '/agent/run') {
      return Response.json({
        finalText: 'done: 42',
        steps: 3,
        stopReason: 'final_text',
        model: 'mock-model',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    }
    if (url.pathname === '/agent/boom') {
      return new Response('llm unreachable', { status: 502 })
    }
    return new Response('not found', { status: 404 })
  },
})

afterAll(() => {
  server.stop(true)
})

function client(): TriosServerClient {
  return new TriosServerClient({
    serverUrl: `http://127.0.0.1:${server.port}/`,
  })
}

describe('TriosServerClient', () => {
  it('runs an agent task through POST /agent/run', async () => {
    const res = await client().runAgent({
      prompt: 'add 40 and 2',
      max_steps: 5,
      provider: {
        base_url: 'http://127.0.0.1:9301/v1',
        api_key: 'k',
        model: 'mock-model',
      },
    })
    expect(res.finalText).toBe('done: 42')
    expect(res.steps).toBe(3)
    expect(res.stopReason).toBe('final_text')

    const call = received.find((r) => r.path === '/agent/run')
    expect(call).toBeDefined()
    expect((call?.body as { prompt: string }).prompt).toBe('add 40 and 2')
  })

  it('lists Rust agent tools through GET /agent/tools', async () => {
    const tools = await client().listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('echo')
    expect(names).toContain('browser_goto')
  })

  it('surfaces non-2xx responses as TriosServerError', async () => {
    const c = new TriosServerClient({
      serverUrl: `http://127.0.0.1:${server.port}`,
    })
    // biome-ignore lint/suspicious/noExplicitAny: reaching a test-only route
    const err = await (c as any)
      .request('GET', '/agent/boom')
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TriosServerError)
    expect((err as TriosServerError).status).toBe(502)
    expect((err as TriosServerError).message).toContain('llm unreachable')
  })
})
