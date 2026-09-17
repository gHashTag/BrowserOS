/**
 * MCP Client utilities for eval infrastructure.
 *
 * - callMcpTool: One-shot function (creates and tears down connection per call)
 * - McpClient: Persistent connection for repeated calls (CladoActionExecutor)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const MCP_TOOL_TIMEOUT_MS = 65_000

export interface McpToolResult {
  content: Array<{
    type: string
    text?: string
    data?: string
    mimeType?: string
  }>
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

/**
 * One-shot MCP tool call. Creates a connection, calls the tool, and tears down.
 * Use for infrequent calls (screenshot capture, page resolution, navigation).
 */
export async function callMcpTool(
  serverUrl: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  const client = new Client({
    name: 'browseros-eval',
    version: '1.0.0',
  })

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: {
      headers: { 'X-BrowserOS-Source': 'sdk-internal' },
    },
  })

  try {
    await client.connect(transport)

    const toolCallPromise = client.callTool({
      name,
      arguments: args,
    })

    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new Error(`MCP tool call timed out after ${MCP_TOOL_TIMEOUT_MS}ms`),
          ),
        MCP_TOOL_TIMEOUT_MS,
      )
    })

    try {
      return (await Promise.race([
        toolCallPromise,
        timeoutPromise,
      ])) as McpToolResult
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  } finally {
    try {
      await transport.close()
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * Persistent MCP client for repeated tool calls.
 * Lazily connects on first call, reuses connection across calls.
 * Must call close() when done (e.g. in executor cleanup).
 */
export class McpClient {
  private client!: Client
  private transport!: StreamableHTTPClientTransport
  private connected = false
  private serverUrl: string

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl
    this.createClientAndTransport()
  }

  private createClientAndTransport(): void {
    this.client = new Client({ name: 'browseros-eval', version: '1.0.0' })
    this.transport = new StreamableHTTPClientTransport(
      new URL(this.serverUrl),
      {
        requestInit: {
          headers: { 'X-BrowserOS-Source': 'sdk-internal' },
        },
      },
    )
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<McpToolResult> {
    if (!this.connected) {
      await this.client.connect(this.transport)
      this.connected = true
    }

    const toolCallPromise = this.client.callTool({
      name,
      arguments: args,
    })

    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new Error(`MCP tool call timed out after ${MCP_TOOL_TIMEOUT_MS}ms`),
          ),
        MCP_TOOL_TIMEOUT_MS,
      )
    })

    try {
      return (await Promise.race([
        toolCallPromise,
        timeoutPromise,
      ])) as McpToolResult
    } catch (error) {
      this.connected = false
      try {
        await this.transport.close()
      } catch {
        // Ignore close errors
      }
      this.createClientAndTransport()
      throw error
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  async close(): Promise<void> {
    try {
      await this.transport.close()
    } catch {
      // Ignore close errors
    }
    this.connected = false
  }
}
