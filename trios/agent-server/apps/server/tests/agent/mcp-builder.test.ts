/**
 * @license
 * Copyright 2025 BrowserOS
 *
 * MCP Builder — Test Suite
 *
 * Covers the observability contract of `createMcpClients`: a spec whose
 * server cannot be reached must come back as a `McpConnectFailure` record
 * (naming the server, its URL, and how many attempts were made) instead of
 * vanishing into a log line, and an empty spec list must stay quiet.
 * A flaky mock server additionally proves that a spec which refuses the
 * first connects but succeeds on a later attempt yields a client and no
 * failure record.
 *
 * Port 1 on 127.0.0.1 is used as a guaranteed-closed port: nothing ever
 * listens there, so the connect is refused immediately and each attempt
 * fails fast without waiting on a timeout.
 */

import { describe, expect, it } from 'bun:test'
import {
  createMcpClients,
  MCP_CONNECT_MAX_ATTEMPTS,
  type McpServerSpec,
} from '../../src/agent/mcp-builder'

const CLOSED_PORT_SPEC: McpServerSpec = {
  name: 'custom-my-server',
  url: 'http://127.0.0.1:1/mcp',
  transport: 'http',
}

// JSON-RPC responder for the minimal mock MCP server used by the flaky-server
// test: answers initialize, tools/list and ping, rejects anything else.
function respondToRpc(messages: Array<Record<string, unknown>>) {
  const responses: Array<Record<string, unknown>> = []
  for (const msg of messages) {
    if (msg.id === undefined || msg.id === null) continue // notification
    if (msg.method === 'initialize') {
      responses.push({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp', version: '1.0.0' },
        },
      })
    } else if (msg.method === 'tools/list') {
      responses.push({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'mock_tool',
              description: 'A mock tool',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      })
    } else if (msg.method === 'ping') {
      responses.push({ jsonrpc: '2.0', id: msg.id, result: {} })
    } else {
      responses.push({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      })
    }
  }
  return responses
}

describe('createMcpClients', () => {
  it('retries and records one failure per unreachable spec', async () => {
    const { clients, tools, failures } = await createMcpClients([
      CLOSED_PORT_SPEC,
    ])

    expect(clients.length).toBe(0)
    expect(Object.keys(tools).length).toBe(0)

    expect(failures.length).toBe(1)
    expect(failures[0].name).toBe('custom-my-server')
    expect(failures[0].url).toBe('http://127.0.0.1:1/mcp')
    // The spec was attempted more than once before being abandoned
    expect(MCP_CONNECT_MAX_ATTEMPTS).toBeGreaterThanOrEqual(2)
    expect(failures[0].attempts).toBe(MCP_CONNECT_MAX_ATTEMPTS)
    expect(failures[0].attempts).toBeGreaterThanOrEqual(2)
    expect(failures[0].error.length).toBeGreaterThan(0)
  })

  it('derives the failure count from the specs array at runtime', async () => {
    const { clients, failures } = await createMcpClients([
      { ...CLOSED_PORT_SPEC, name: 'custom-a' },
      { ...CLOSED_PORT_SPEC, name: 'custom-b' },
      { ...CLOSED_PORT_SPEC, name: 'custom-c' },
    ])

    expect(clients.length).toBe(0)
    expect(failures.length).toBe(3)
    expect(failures.map((f) => f.name).sort()).toEqual([
      'custom-a',
      'custom-b',
      'custom-c',
    ])
  })

  it('returns an empty bundle for zero specs', async () => {
    const { clients, tools, failures } = await createMcpClients([])

    expect(clients.length).toBe(0)
    expect(Object.keys(tools).length).toBe(0)
    expect(failures.length).toBe(0)
  })

  it('retries past refusals and reports no failure when a later attempt succeeds', async () => {
    // Minimal streamable-HTTP MCP endpoint that refuses the first
    // MCP_CONNECT_MAX_ATTEMPTS - 1 requests, then answers initialize and
    // tools/list — a server that is still booting when the chat starts.
    let refusalsLeft = MCP_CONNECT_MAX_ATTEMPTS - 1
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        if (refusalsLeft > 0) {
          refusalsLeft--
          return new Response('not ready', { status: 503 })
        }
        if (req.method !== 'POST') {
          return new Response(null, { status: 405 })
        }
        const body = await req.json()
        const messages: Array<Record<string, unknown>> = Array.isArray(body)
          ? body
          : [body]
        const responses = respondToRpc(messages)
        if (responses.length === 0) {
          return new Response(null, { status: 202 })
        }
        return Response.json(responses.length === 1 ? responses[0] : responses)
      },
    })

    try {
      const { clients, tools, failures } = await createMcpClients([
        {
          name: 'custom-flaky',
          url: `http://127.0.0.1:${server.port}/mcp`,
          transport: 'http',
        },
      ])

      expect(failures.length).toBe(0)
      expect(clients.length).toBe(1)
      expect(Object.keys(tools)).toEqual(['mock_tool'])
      for (const client of clients) {
        await client.close()
      }
    } finally {
      server.stop(true)
    }
  })
})
