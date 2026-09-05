/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * First suite for railway-client.ts. The module exports a single symbol,
 * RailwayMcpClient, and this suite pins the behaviour that exists today:
 * construction, the connect lifecycle, retry policy, the tool-call wire
 * contract, automatic reconnect, the circuit breaker and health checks.
 *
 * No network is used: only the streamable-HTTP transport specifier is
 * replaced, with an in-memory fake that speaks real MCP JSON-RPC. The SDK
 * Client itself stays genuine, so every assertion below observes the actual
 * protocol traffic the module would put on the wire. The transport
 * specifier is imported by railway-client.ts alone, so no other suite in
 * the repository can be affected; the real module is re-registered after
 * the run regardless. No database and no container are involved.
 *
 * Nothing is blocked on a live dependency: the one exported symbol is
 * exercised end to end below, so the "could not pin" list is empty.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test'
import * as realTransportModule from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CircuitBreaker, CircuitOpenError } from '../circuit-breaker.js'

const SERVER_URL = 'https://trios-railway-mcp.test/mcp'

/** What the fake Railway server does for the traffic it receives. */
interface ScriptedBehaviour {
  /** One error per initialize handshake that must fail, consumed in order. */
  connectErrors: Error[]
  /** When set, every tools/list ping on an established session fails. */
  listToolsError: Error | null
  /** Tool names the fake server reports. */
  toolNames: string[]
  /** One result per tools/call request, consumed in order; Error means an
   * error response. */
  callToolResults: unknown[]
}

let script: ScriptedBehaviour
const transports: FakeTransport[] = []

function resetScript(): void {
  script = {
    connectErrors: [],
    listToolsError: null,
    toolNames: [],
    callToolResults: [],
  }
  transports.length = 0
}

interface WireRequest {
  method: string
  params: Record<string, unknown>
}

/** The JSON-RPC messages the SDK Client pushes through the transport. */
interface WireMessage {
  id?: number | string | null
  method?: string
  params?: {
    clientInfo?: { name: string; version: string }
    protocolVersion?: string
  }
}

/**
 * Stands in for StreamableHTTPClientTransport. Each instance is one
 * server-side session: it records every request that reaches the server and
 * answers from the script, in memory.
 */
class FakeTransport {
  readonly url: URL
  sessionId: string | undefined = undefined
  closed = false
  onclose: (() => void) | undefined
  onerror: ((error: Error) => void) | undefined
  onmessage: ((message: unknown) => void) | undefined
  readonly requests: WireRequest[] = []
  clientInfo: { name: string; version: string } | null = null

  constructor(url: URL) {
    this.url = url
    transports.push(this)
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true
  }

  async send(message: WireMessage | undefined): Promise<void> {
    const method = message?.method ?? ''
    const params = message?.params ?? {}
    this.requests.push({
      method,
      params: params as unknown as Record<string, unknown>,
    })

    if (message?.id === undefined || message?.id === null) return

    if (method === 'initialize') {
      const failure = script.connectErrors.shift()
      if (failure) throw failure
      this.clientInfo = params.clientInfo ?? null
      this.respond(message.id, {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-railway', version: '9.9.9' },
      })
      return
    }

    if (method === 'tools/list') {
      if (script.listToolsError) {
        this.respondError(message.id, script.listToolsError.message)
        return
      }
      this.respond(message.id, {
        tools: script.toolNames.map((name) => ({
          name,
          inputSchema: { type: 'object' },
        })),
      })
      return
    }

    if (method === 'tools/call') {
      const next = script.callToolResults.shift()
      if (next instanceof Error) {
        this.respondError(message.id, next.message)
        return
      }
      this.respond(message.id, next ?? {})
      return
    }
  }

  private respond(id: unknown, result: unknown): void {
    const response = { jsonrpc: '2.0' as const, id, result }
    queueMicrotask(() => this.onmessage?.(response))
  }

  private respondError(id: unknown, message: string): void {
    const response = {
      jsonrpc: '2.0' as const,
      id,
      error: { code: -32000, message },
    }
    queueMicrotask(() => this.onmessage?.(response))
  }
}

mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  ...realTransportModule,
  StreamableHTTPClientTransport: FakeTransport,
}))

afterAll(() => {
  mock.module(
    '@modelcontextprotocol/sdk/client/streamableHttp.js',
    () => realTransportModule,
  )
})

const { RailwayMcpClient } = await import('./railway-client.js')

function lastTransport(): FakeTransport {
  return transports[transports.length - 1]
}

function listPings(transport: FakeTransport): number {
  return transport.requests.filter((r) => r.method === 'tools/list').length
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('railwayClientContract', () => {
  it('RailwayMcpClient', async () => {
    const originalLog = console.log
    const originalWarn = console.warn
    console.log = () => {}
    console.warn = () => {}
    try {
      // --- construction ---

      resetScript()
      const client = new RailwayMcpClient(SERVER_URL)
      expect(client.isConnected).toBe(false)
      expect(client.circuit).toBeInstanceOf(CircuitBreaker)
      expect(client.circuit.name).toBe('railway')

      // --- connect: happy path handshakes with the configured URL ---

      await client.connect()
      expect(client.isConnected).toBe(true)
      expect(transports).toHaveLength(1)
      expect(transports[0].url.href).toBe(SERVER_URL)
      expect(transports[0].requests[0].method).toBe('initialize')
      expect(transports[0].clientInfo).toEqual({
        name: 'trios-mcp-bridge',
        version: '0.1.0',
      })

      // --- connect: a healthy session is reused, only pinged ---

      script.toolNames = ['railway_service_list']
      await client.connect()
      expect(client.isConnected).toBe(true)
      expect(transports).toHaveLength(1)
      expect(listPings(transports[0])).toBe(1)

      // --- connect: a dead session is replaced ---

      script.listToolsError = new Error('session is dead')
      await client.connect()
      expect(client.isConnected).toBe(true)
      expect(transports).toHaveLength(2)
      expect(transports[0].closed).toBe(true)
      script.listToolsError = null

      // --- connect: concurrent calls open a single session ---

      resetScript()
      const concurrent = new RailwayMcpClient(SERVER_URL)
      await Promise.all([concurrent.connect(), concurrent.connect()])
      expect(concurrent.isConnected).toBe(true)
      expect(transports).toHaveLength(1)

      // --- disconnect: closes the session ---

      await concurrent.disconnect()
      expect(concurrent.isConnected).toBe(false)
      expect(transports[0].closed).toBe(true)

      // --- connect: retries with backoff, then succeeds ---

      resetScript()
      const retrying = new RailwayMcpClient(SERVER_URL)
      script.connectErrors.push(
        new Error('attempt 1 failed'),
        new Error('attempt 2 failed'),
      )
      await retrying.connect()
      expect(retrying.isConnected).toBe(true)
      expect(transports).toHaveLength(3)

      // --- connect: exhausted retries surface the last error ---

      resetScript()
      const exhausted = new RailwayMcpClient(SERVER_URL)
      script.connectErrors.push(
        new Error('attempt 1 failed'),
        new Error('attempt 2 failed'),
        new Error('attempt 3 failed'),
      )
      await expect(exhausted.connect()).rejects.toThrow('attempt 3 failed')
      // Current behaviour: the last attempt assigned its session before the
      // handshake failed and the reference is never cleared, so isConnected
      // still reports true after a rejected connect. Pinned as it stands.
      expect(exhausted.isConnected).toBe(true)

      // --- listTools: returns tool names as strings ---

      resetScript()
      const tools = new RailwayMcpClient(SERVER_URL)
      script.toolNames = ['railway_service_list', 'fleet_health']
      await tools.connect()
      expect(await tools.listTools()).toEqual([
        'railway_service_list',
        'fleet_health',
      ])

      // --- redeploy: tool name, argument mapping, text extraction ---

      script.callToolResults.push({
        content: [{ type: 'text', text: 'redeployed svc_1' }],
      })
      expect(await tools.redeploy('svc_1', 'proj_1', 'env_1')).toBe(
        'redeployed svc_1',
      )
      expect(lastTransport().requests.at(-1)).toEqual({
        method: 'tools/call',
        params: {
          name: 'railway_service_redeploy',
          arguments: {
            service_id: 'svc_1',
            project: 'proj_1',
            environment: 'env_1',
          },
        },
      })

      script.callToolResults.push({
        content: [{ type: 'text', text: 'redeployed default' }],
      })
      expect(await tools.redeploy()).toBe('redeployed default')
      expect(lastTransport().requests.at(-1)).toEqual({
        method: 'tools/call',
        params: { name: 'railway_service_redeploy', arguments: {} },
      })

      // --- deploy: snake_case mapping, multi-part text joined with newline ---

      script.callToolResults.push({
        content: [
          { type: 'text', text: 'deployed web' },
          { type: 'text', text: 'at the edge' },
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        ],
      })
      expect(
        await tools.deploy({
          serviceName: 'web',
          image: 'img:1',
          env: { PORT: '8080' },
          existingServiceId: 'svc_9',
          project: 'proj_2',
          environment: 'env_2',
        }),
      ).toBe('deployed web\nat the edge')
      expect(lastTransport().requests.at(-1)).toEqual({
        method: 'tools/call',
        params: {
          name: 'railway_service_deploy',
          arguments: {
            service_name: 'web',
            image: 'img:1',
            env: { PORT: '8080' },
            existing_service_id: 'svc_9',
            project: 'proj_2',
            environment: 'env_2',
          },
        },
      })

      // --- listServices: parses the JSON payload, falls back to empty ---

      script.callToolResults.push({
        content: [
          {
            type: 'text',
            text: '[{"id":"svc_2","name":"api","created_at":"2026-01-01"}]',
          },
        ],
      })
      expect(await tools.listServices('proj_3')).toEqual([
        { id: 'svc_2', name: 'api', created_at: '2026-01-01' },
      ])
      expect(lastTransport().requests.at(-1)).toEqual({
        method: 'tools/call',
        params: {
          name: 'railway_service_list',
          arguments: { project: 'proj_3' },
        },
      })

      script.callToolResults.push({
        content: [{ type: 'text', text: 'not json at all' }],
      })
      expect(await tools.listServices()).toEqual([])

      // --- batchRedeploy, fleetHealth, workerStatus ---

      script.callToolResults.push({
        content: [{ type: 'text', text: 'queued 3 redeployments' }],
      })
      expect(await tools.batchRedeploy(7, 'web-*')).toBe(
        'queued 3 redeployments',
      )
      expect(lastTransport().requests.at(-1)).toEqual({
        method: 'tools/call',
        params: {
          name: 'service_batch_redeploy',
          arguments: { account: 7, filter: 'web-*' },
        },
      })

      script.callToolResults.push({
        content: [{ type: 'text', text: 'fleet is healthy' }],
      })
      expect(await tools.fleetHealth()).toBe('fleet is healthy')
      expect(lastTransport().requests.at(-1)).toEqual({
        method: 'tools/call',
        params: { name: 'fleet_health', arguments: {} },
      })

      script.callToolResults.push({})
      expect(await tools.workerStatus()).toBe('')
      expect(lastTransport().requests.at(-1)).toEqual({
        method: 'tools/call',
        params: { name: 'worker_status', arguments: {} },
      })

      // --- a failed tool call reconnects and the next call succeeds ---

      resetScript()
      const healing = new RailwayMcpClient(SERVER_URL)
      await healing.connect()
      script.callToolResults.push(new Error('connection reset by peer'), {
        content: [{ type: 'text', text: 'worker alive' }],
      })
      await expect(healing.fleetHealth()).rejects.toThrow(
        'connection reset by peer',
      )
      expect(await healing.fleetHealth()).toBe('worker alive')
      expect(healing.isConnected).toBe(true)
      expect(transports).toHaveLength(2)

      // --- the circuit opens after three consecutive tool failures ---

      resetScript()
      const breaker = new RailwayMcpClient(SERVER_URL)
      await breaker.connect()
      script.callToolResults.push(new Error('tool exploded'))
      await expect(breaker.workerStatus()).rejects.toThrow('tool exploded')
      script.callToolResults.push(new Error('tool exploded'))
      await expect(breaker.workerStatus()).rejects.toThrow('tool exploded')
      expect(breaker.circuit.currentState).toBe('closed')
      script.callToolResults.push(new Error('tool exploded'))
      await expect(breaker.workerStatus()).rejects.toThrow('tool exploded')
      expect(breaker.circuit.currentState).toBe('open')

      // An open circuit refuses the call outright, with no new session.
      const transportsBeforeProbe = transports.length
      let thrown: unknown = null
      try {
        await breaker.fleetHealth()
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(CircuitOpenError)
      expect((thrown as Error).message).toBe(
        'Circuit breaker OPEN for railway. Retry after 10s.',
      )
      expect(transports.length).toBe(transportsBeforeProbe)

      // --- health checks: ping while running, silent once stopped ---

      resetScript()
      const watched = new RailwayMcpClient(SERVER_URL)
      script.toolNames = ['fleet_health']
      await watched.connect()
      const liveSession = lastTransport()
      watched.startHealthCheck(15)
      await sleep(90)
      const pinged = listPings(liveSession)
      expect(pinged).toBeGreaterThanOrEqual(2)
      watched.stopHealthCheck()
      await sleep(60)
      expect(listPings(liveSession)).toBe(pinged)
      await watched.disconnect()
      expect(watched.isConnected).toBe(false)
    } finally {
      console.log = originalLog
      console.warn = originalWarn
    }
  })
})
