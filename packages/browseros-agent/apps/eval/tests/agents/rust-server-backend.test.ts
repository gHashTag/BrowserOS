/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Tests for the Rust trios-server executor backend — the thin eval-harness
 * path that delegates goals to `POST /agent/run` instead of the TS tool loop.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import type { ResolvedAgentConfig } from '@browseros/agent-core/agent/types'
import { createExecutorBackend } from '../../src/agents/orchestrated/backends/create-executor-backend'
import { RustServerExecutorBackend } from '../../src/agents/orchestrated/backends/rust-server/rust-server-executor-backend'

let lastRunBody: Record<string, unknown> | null = null
let mode: 'ok' | 'max-steps' | 'error' = 'ok'

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname !== '/agent/run') {
      return new Response('not found', { status: 404 })
    }
    lastRunBody = (await req.json()) as Record<string, unknown>
    if (mode === 'error') {
      return new Response('llm unreachable', { status: 502 })
    }
    return Response.json({
      finalText: 'checkout clicked',
      steps: 4,
      stopReason: mode === 'max-steps' ? 'max_steps' : 'final_text',
      model: 'mock-model',
      usage: { input_tokens: 12, output_tokens: 7 },
      transcript: [
        { role: 'assistant', type: 'tool_call', tool: 'browser_goto' },
        { role: 'tool', type: 'tool_result', tool: 'browser_goto' },
        { role: 'assistant', type: 'tool_call', tool: 'browser_click' },
      ],
    })
  },
})

afterAll(() => {
  server.stop(true)
})

const configTemplate = {
  conversationId: 'rust-backend-test',
  provider: 'openai-compatible',
  model: 'mock-model',
  apiKey: 'k',
  baseUrl: 'http://127.0.0.1:9301/v1',
  userSystemPrompt: 'be terse',
} as ResolvedAgentConfig

function backend(): RustServerExecutorBackend {
  return new RustServerExecutorBackend({
    configTemplate,
    serverUrl: `http://127.0.0.1:${server.port}`,
    maxSteps: 8,
  })
}

describe('RustServerExecutorBackend', () => {
  it('is constructible through createExecutorBackend', () => {
    const created = createExecutorBackend({
      backendKind: 'rust-server',
      configTemplate,
      serverUrl: `http://127.0.0.1:${server.port}`,
    })
    expect(created).toBeInstanceOf(RustServerExecutorBackend)
    expect(created.kind).toBe('rust-server')
  })

  it('maps /agent/run replies onto the ExecutorResult contract', async () => {
    mode = 'ok'
    const result = await backend().execute('Click checkout')
    expect(result.status).toBe('done')
    expect(result.observation).toBe('checkout clicked')
    expect(result.actionsPerformed).toBe(4)
    expect(result.toolsUsed).toEqual(['browser_goto', 'browser_click'])

    expect(lastRunBody?.prompt).toBe('Click checkout')
    expect(lastRunBody?.system).toBe('be terse')
    expect(lastRunBody?.max_steps).toBe(8)
    expect(
      (lastRunBody?.provider as { base_url: string } | undefined)?.base_url,
    ).toBe('http://127.0.0.1:9301/v1')
  })

  it('reports max_steps stop reason as timeout and accumulates steps', async () => {
    mode = 'max-steps'
    const b = backend()
    const result = await b.execute('Long task')
    expect(result.status).toBe('timeout')
    expect(b.getTotalSteps()).toBe(4)
  })

  it('degrades server errors to a blocked delegation, not a throw', async () => {
    mode = 'error'
    const result = await backend().execute('Click checkout')
    expect(result.status).toBe('blocked')
    expect(result.observation).toContain('502')
    expect(result.actionsPerformed).toBe(0)
  })
})
