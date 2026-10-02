import { execSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Mutex } from 'async-mutex'

import { ensureBrowserOS } from './setup'

// =============================================================================
// Port Management
// =============================================================================

export async function killProcessOnPort(port: number): Promise<void> {
  try {
    console.log(`Finding process on port ${port}...`)

    // LISTEN only, and never this process. A bare `lsof -i :port` also lists
    // every client still connected to the port - including this test process,
    // whose CDP socket to the previous file's browser outlives it - and the
    // SIGTERM that followed ended the whole server-tools run (exit 143).
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((pid) => pid.trim())
      .filter((pid) => pid !== '' && pid !== String(process.pid))
      .join(' ')

    if (pids) {
      console.log(`Terminating process(es) ${pids} on port ${port}...`)

      try {
        execSync(`kill -15 ${pids}`, {
          stdio: 'ignore',
        })
        await new Promise((resolve) => setTimeout(resolve, 500))
      } catch {
        execSync(`kill -9 ${pids}`, {
          stdio: 'ignore',
        })
      }

      console.log(`Terminated process on port ${port}`)
    }
  } catch {
    console.log(`No process found on port ${port}`)
  }

  console.log('Waiting 1 second for port to be released...')
  await new Promise((resolve) => setTimeout(resolve, 1000))
}

// =============================================================================
// Test Wrappers
// =============================================================================

const envMutex = new Mutex()

export async function withMcpServer(
  cb: (client: Client) => Promise<void>,
): Promise<void> {
  return await envMutex.runExclusive(async () => {
    const config = await ensureBrowserOS()

    const client = new Client({
      name: 'browseros-test-client',
      version: '1.0.0',
    })

    const serverUrl = new URL(`http://127.0.0.1:${config.serverPort}/mcp`)
    const transport = new StreamableHTTPClientTransport(serverUrl)

    try {
      await client.connect(transport)
      await cb(client)
    } finally {
      await transport.close()
    }
  })
}

// =============================================================================
// HTML Helper
// =============================================================================

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  const bodyContent = strings.reduce((acc, str, i) => {
    return acc + str + (values[i] || '')
  }, '')

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My test page</title>
  </head>
  <body>
    ${bodyContent}
  </body>
</html>`
}

// =============================================================================
// Type Helpers
// =============================================================================

export interface McpContentItem {
  type: 'text' | 'image'
  text?: string
  data?: string
  mimeType?: string
}

export interface TypedCallToolResult {
  content: McpContentItem[]
  isError?: boolean
}

export function asToolResult(result: CallToolResult): TypedCallToolResult {
  return result as unknown as TypedCallToolResult
}
