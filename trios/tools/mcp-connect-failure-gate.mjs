#!/usr/bin/env node
/**
 * Source gate for the MCP connect-failure contract (gHashTag/trios#1375).
 *
 * A lost MCP server used to vanish inside `createMcpClients`: zero clients,
 * zero tools, no exception — indistinguishable from "no servers configured".
 * This gate statically checks that the loss is retried and observable.
 *
 * Constraints honoured here:
 * - Node builtins only (`node:fs`, `node:url`); the worker has no make,
 *   python3, swift, rustc or cargo, so nothing is shelled out to.
 * - The two TypeScript sources are read as text and checked with regular
 *   expressions; they are never imported, so the gate runs even when the
 *   Bun workspace store is absent.
 *
 * Usage: node trios/tools/mcp-connect-failure-gate.mjs
 * Exits 0 when every check passes, 1 otherwise.
 */
import { readFileSync } from 'node:fs'

const here = new URL('.', import.meta.url)
const builder = readFileSync(
  new URL('../agent-server/apps/server/src/agent/mcp-builder.ts', here),
  'utf8',
)
const agent = readFileSync(
  new URL('../agent-server/apps/server/src/agent/ai-sdk-agent.ts', here),
  'utf8',
)

/**
 * @param {string} source
 * @returns {string[]}
 */
function linesMentioning(source, needle) {
  return source.split(/\r?\n/).filter((line) => line.includes(needle))
}

const checks = [
  {
    name: 'builder exports McpConnectFailure',
    run() {
      if (!/(?:export\s+(?:interface|type)\s+McpConnectFailure\b)/.test(builder)) {
        throw new Error(
          'mcp-builder.ts does not export a type named McpConnectFailure',
        )
      }
    },
  },
  {
    name: 'bundle carries failures',
    run() {
      const bundle = builder.match(
        /export\s+interface\s+McpClientBundle\s*\{[\s\S]*?\n\}/,
      )
      if (!bundle) {
        throw new Error('mcp-builder.ts does not export interface McpClientBundle')
      }
      if (!/failures\s*:\s*McpConnectFailure\s*\[\]/.test(bundle[0])) {
        throw new Error(
          'McpClientBundle has no `failures: McpConnectFailure[]` field',
        )
      }
    },
  },
  {
    name: 'MCP_CONNECT_MAX_ATTEMPTS defined',
    run() {
      const declaration = builder.match(
        /(?:export\s+)?const\s+MCP_CONNECT_MAX_ATTEMPTS\s*=\s*(\d+)\b/,
      )
      if (!declaration) {
        throw new Error(
          'mcp-builder.ts does not declare const MCP_CONNECT_MAX_ATTEMPTS with a numeric literal',
        )
      }
      const value = Number(declaration[1])
      if (!Number.isInteger(value) || value < 2) {
        throw new Error(
          `MCP_CONNECT_MAX_ATTEMPTS is ${declaration[1]}, must be an integer >= 2`,
        )
      }
    },
  },
  {
    name: 'retry loop references MCP_CONNECT_MAX_ATTEMPTS',
    run() {
      const mentionLines = linesMentioning(builder, 'MCP_CONNECT_MAX_ATTEMPTS')
      const declarationLine = mentionLines.find((line) =>
        /(?:export\s+)?const\s+MCP_CONNECT_MAX_ATTEMPTS\s*=/.test(line),
      )
      const loopLines = mentionLines.filter(
        (line) => line !== declarationLine && /\bfor\s*\(|\bwhile\s*\(/.test(line),
      )
      if (!declarationLine) {
        throw new Error('MCP_CONNECT_MAX_ATTEMPTS declaration line not found')
      }
      if (loopLines.length === 0) {
        throw new Error(
          'MCP_CONNECT_MAX_ATTEMPTS is not referenced inside a retry loop on a separate line',
        )
      }
    },
  },
  {
    name: 'agent reads bundle failures',
    run() {
      if (!/McpConnectFailure/.test(agent)) {
        throw new Error('ai-sdk-agent.ts never references McpConnectFailure')
      }
      if (
        !/const\s*\{[^}]*\bfailures\b[^}]*\}\s*=\s*await\s+createMcpClients\(/s.test(
          agent,
        )
      ) {
        throw new Error(
          'ai-sdk-agent.ts does not destructure `failures` from createMcpClients',
        )
      }
    },
  },
  {
    name: 'agent logs failures at error level',
    run() {
      const guarded = agent.match(
        /if\s*\(\s*(\w*[Ff]ailures\w*)\s*\.\s*length\s*>\s*0\s*\)\s*\{[\s\S]{0,400}?logger\.error\(/,
      )
      if (!guarded) {
        throw new Error(
          'ai-sdk-agent.ts has no `failures.length > 0` guard leading to logger.error',
        )
      }
    },
  },
  {
    name: 'agent exposes failure getter',
    run() {
      if (!/get\s+mcpConnectFailures\s*\(\s*\)\s*:/.test(agent)) {
        throw new Error(
          'ai-sdk-agent.ts has no `get mcpConnectFailures()` getter',
        )
      }
    },
  },
]

let failed = 0
for (const check of checks) {
  try {
    check.run()
    console.log(`PASS ${check.name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${check.name}`)
    console.log(`  reason: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`checks: ${checks.length} failed: ${failed}`)
if (failed > 0) {
  process.exitCode = 1
}
