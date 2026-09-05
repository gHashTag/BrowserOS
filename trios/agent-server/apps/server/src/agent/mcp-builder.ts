import { createMCPClient } from '@ai-sdk/mcp'
import { TIMEOUTS } from '@browseros/shared/constants/timeouts'
import type { BrowserContext } from '@browseros/shared/schemas/browser-context'
import type { ToolSet } from 'ai'
import { logger } from '../lib/logger'
import {
  detectMcpTransport,
  type McpTransportType,
} from '../lib/mcp-transport-detect'

export interface McpServerSpec {
  name: string
  url: string
  transport: McpTransportType
  headers?: Record<string, string>
}

export interface McpServerSpecDeps {
  browserContext?: BrowserContext
}

/**
 * One MCP server that was requested but produced no client after all
 * connect attempts were exhausted. `attempts` records how many tries
 * were actually made before the spec was given up on.
 */
export interface McpConnectFailure {
  name: string
  url: string
  attempts: number
  error: string
}

export interface McpClientBundle {
  clients: Array<{ close(): Promise<void> }>
  tools: ToolSet
  /** Exactly one entry per requested spec that yielded no client. */
  failures: McpConnectFailure[]
}

/**
 * Connect attempts made per spec before it is abandoned. A spec whose
 * server is slow to boot gets retried instead of being dropped on the
 * first refusal. The worst case for one spec is bounded by
 * `MCP_CONNECT_MAX_ATTEMPTS * TIMEOUTS.MCP_CLIENT_CONNECT` because every
 * attempt - client creation plus the initial tools() fetch - must fit
 * inside a single `TIMEOUTS.MCP_CLIENT_CONNECT` budget.
 */
export const MCP_CONNECT_MAX_ATTEMPTS = 3

type ConnectedClient = {
  client: { close(): Promise<void> }
  tools: ToolSet
}

type ConnectOutcome =
  | ({ ok: true } & ConnectedClient)
  | { ok: false; failure: McpConnectFailure }

// Build list of custom MCP server specs from browser context
// (Klavis Strata is handled separately via shared background connection)
export async function buildMcpServerSpecs(
  deps: McpServerSpecDeps,
): Promise<McpServerSpec[]> {
  const specs: McpServerSpec[] = []

  // User-provided custom MCP servers
  if (deps.browserContext?.customMcpServers?.length) {
    const servers = deps.browserContext.customMcpServers
    const transports = await Promise.all(
      servers.map((s) => detectMcpTransport(s.url)),
    )
    for (let i = 0; i < servers.length; i++) {
      specs.push({
        name: `custom-${servers[i].name}`,
        url: servers[i].url,
        transport: transports[i],
      })
    }
  }

  return specs
}

// Reject with `message` if `promise` does not settle within `ms`
function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// A single connect attempt for one spec. Both phases (createMCPClient and
// the initial client.tools()) share one TIMEOUTS.MCP_CLIENT_CONNECT budget,
// so one attempt can never exceed that timeout and the retry loop above can
// never exceed MCP_CONNECT_MAX_ATTEMPTS times it.
async function attemptMcpConnect(
  spec: McpServerSpec,
): Promise<ConnectedClient> {
  const budget = TIMEOUTS.MCP_CLIENT_CONNECT
  const deadline = Date.now() + budget
  const remaining = () => Math.max(deadline - Date.now(), 0)

  const client = await withTimeout(
    createMCPClient({
      transport: {
        type: spec.transport === 'sse' ? 'sse' : 'http',
        url: spec.url,
        headers: spec.headers,
      },
    }),
    remaining(),
    `MCP client connect timed out after ${budget}ms`,
  )
  try {
    const clientTools = await withTimeout(
      client.tools(),
      remaining(),
      `MCP client.tools() timed out after ${budget}ms`,
    )
    return { client, tools: clientTools }
  } catch (error) {
    // Don't leak a half-connected client when tools() fails
    await client.close().catch(() => {})
    throw error
  }
}

// Connect a single MCP client, retrying refusals up to
// MCP_CONNECT_MAX_ATTEMPTS times. Never throws: a spec that cannot be
// connected is reported as a McpConnectFailure instead of vanishing.
async function connectMcpClient(spec: McpServerSpec): Promise<ConnectOutcome> {
  let lastError = 'unknown error'
  for (let attempt = 1; attempt <= MCP_CONNECT_MAX_ATTEMPTS; attempt++) {
    try {
      const connected = await attemptMcpConnect(spec)
      return {
        ok: true,
        client: connected.client,
        tools: connected.tools,
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      logger.warn('Failed to connect MCP client, retrying', {
        name: spec.name,
        url: spec.url,
        attempt,
        maxAttempts: MCP_CONNECT_MAX_ATTEMPTS,
        error: lastError,
      })
    }
  }
  return {
    ok: false,
    failure: {
      name: spec.name,
      url: spec.url,
      attempts: MCP_CONNECT_MAX_ATTEMPTS,
      error: lastError,
    },
  }
}

// Create MCP clients from specs, return merged toolset plus one failure
// record for every spec that yielded no client
export async function createMcpClients(
  specs: McpServerSpec[],
): Promise<McpClientBundle> {
  const clients: Array<{ close(): Promise<void> }> = []
  const failures: McpConnectFailure[] = []
  let tools: ToolSet = {}

  // Connect all specs concurrently; each spec retries independently
  const results = await Promise.all(specs.map(connectMcpClient))
  // Walk the specs array itself so the failure count is derived at runtime:
  // every spec without a client contributes exactly one failure record
  for (let i = 0; i < specs.length; i++) {
    const result = results[i]
    if (result?.ok) {
      clients.push(result.client)
      tools = { ...tools, ...result.tools }
    } else {
      failures.push(
        result?.failure ?? {
          name: specs[i].name,
          url: specs[i].url,
          attempts: 0,
          error: 'connect produced no client',
        },
      )
    }
  }

  return { clients, tools, failures }
}
