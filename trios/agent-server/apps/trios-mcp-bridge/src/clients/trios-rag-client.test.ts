/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * Contract suite for src/clients/trios-rag-client.ts.
 *
 * The module's sole export, TriosRagClient, is pinned against a stand-in
 * trios-mcp-rag server: a tiny bun script this suite writes into a
 * temporary directory, which speaks just enough MCP over stdio —
 * initialize, tools/list, tools/call — and records what it observed
 * (spawn count, tools/list pings, tool calls, clean shutdown when its
 * stdin closes) to files in that directory. Every assertion below is
 * about what a caller of the client can observe: connection state, tool
 * listings, tool results, environment plumbing, recovery from a server
 * that refuses its first handshake, the keep-alive loop, teardown of the
 * child process, and the error surface when the server cannot be
 * reached at all. Nothing asserts how the client is built internally.
 *
 * Export coverage of src/clients/trios-rag-client.ts:
 *  - TriosRagClient — exercised throughout: construction, connect,
 *    disconnect, isConnected, startHealthCheck and stopHealthCheck,
 *    listTools, callTool, extractText, and the errors a caller sees
 *    when the configured server is unreachable.
 *
 * No export is left unexercised because of a live dependency: the real
 * trios-mcp-rag binary and its Postgres database are stood in for by
 * the script this suite generates, so the suite needs no network, no
 * database and no container.
 */

import { describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TriosRagClient } from './trios-rag-client.js'

/** Tool names the stand-in server advertises over tools/list. */
const ADVERTISED_TOOLS = ['rag_search', 'echo_args', 'report_env']

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Poll every 20ms until fn is true, failing after `ms` milliseconds. */
async function waitFor(ms: number, fn: () => boolean): Promise<void> {
  const deadline = Date.now() + ms
  while (!fn()) {
    if (Date.now() > deadline) {
      throw new Error('condition was not reached within the allotted time')
    }
    await sleep(20)
  }
}

/** Value recorded in a counter file inside a stand-in directory. */
function counter(dir: string, name: string): number {
  try {
    return Number.parseInt(readFileSync(join(dir, name), 'utf8'), 10) || 0
  } catch {
    return 0
  }
}

/**
 * Source of the stand-in trios-mcp-rag server. It speaks
 * newline-delimited JSON-RPC over stdio: echoes the requested protocol
 * version back on initialize, serves three tools, and records every
 * observable fact — spawns, tools/list pings, tool calls, shutdown on
 * stdin close — to files next to the script. When `failFirst` is
 * positive, the first `failFirst` spawns kill themselves before the
 * handshake completes, standing in for a server that is down and then
 * comes back.
 */
function standinServerSource(failFirst: number): string {
  return String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const dir = import.meta.dir

const bump = (name) => {
  let n = 0
  try {
    n = Number.parseInt(readFileSync(join(dir, name), 'utf8'), 10) || 0
  } catch {}
  writeFileSync(join(dir, name), String(n + 1))
}

let handshakes = 0
try {
  handshakes =
    Number.parseInt(readFileSync(join(dir, 'handshakes.txt'), 'utf8'), 10) || 0
} catch {}
writeFileSync(join(dir, 'handshakes.txt'), String(handshakes + 1))
bump('spawns.txt')
if (handshakes < ${failFirst}) {
  process.kill(process.pid, 'SIGKILL')
}

const say = (msg) => writeSync(1, JSON.stringify(msg) + '\n')
const note = (name, entry) =>
  appendFileSync(join(dir, name), JSON.stringify(entry) + '\n')

const tools = [
  {
    name: 'rag_search',
    description: 'search the corpus',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    },
  },
  {
    name: 'echo_args',
    description: 'echo the arguments back',
    inputSchema: { type: 'object' },
  },
  {
    name: 'report_env',
    description: 'report DATABASE_URL',
    inputSchema: { type: 'object' },
  },
]

const answerCall = (name, args) => {
  note('calls.jsonl', { name: name, args: args })
  if (name === 'rag_search') {
    return { content: [{ type: 'text', text: 'hits for ' + (args.q ?? '') }] }
  }
  if (name === 'echo_args') {
    return { content: [{ type: 'text', text: 'echo:' + JSON.stringify(args) }] }
  }
  if (name === 'report_env') {
    return {
      content: [
        {
          type: 'text',
          text: 'DATABASE_URL=' + (process.env.DATABASE_URL ?? 'unset'),
        },
      ],
    }
  }
  return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true }
}

const handle = (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return
  if (msg.method === 'initialize') {
    say({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'contract-standin', version: '0.0.1' },
      },
    })
    return
  }
  if (msg.method === 'ping') {
    say({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }
  if (msg.method === 'tools/list') {
    bump('lists.txt')
    say({ jsonrpc: '2.0', id: msg.id, result: { tools: tools } })
    return
  }
  if (msg.method === 'tools/call') {
    say({
      jsonrpc: '2.0',
      id: msg.id,
      result: answerCall(msg.params?.name, msg.params?.arguments ?? {}),
    })
    return
  }
  say({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: 'Method not found: ' + msg.method },
  })
}

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString()
  let at = buffer.indexOf('\n')
  while (at !== -1) {
    handle(buffer.slice(0, at))
    buffer = buffer.slice(at + 1)
    at = buffer.indexOf('\n')
  }
})
const finish = () => {
  try {
    writeFileSync(join(dir, 'exited.txt'), 'stdin closed')
  } catch {}
  process.kill(process.pid, 'SIGKILL')
}
process.stdin.on('end', finish)
process.stdin.on('close', finish)
process.stdin.on('error', finish)
`
}

describe('triosRagClientContract', () => {
  it('TriosRagClient — connection lifecycle, tool listing and calls, environment plumbing, retry after a refused handshake, keep-alive, teardown and the unreachable-server error surface, all over a stand-in stdio server', async () => {
    const healthy = mkdtempSync(join(tmpdir(), 'trios-rag-contract-'))
    const provisioned = mkdtempSync(join(tmpdir(), 'trios-rag-contract-'))
    const guarded = mkdtempSync(join(tmpdir(), 'trios-rag-contract-'))
    const flaky = mkdtempSync(join(tmpdir(), 'trios-rag-contract-'))
    const dead = mkdtempSync(join(tmpdir(), 'trios-rag-contract-'))
    const clients: TriosRagClient[] = []
    const standin = (dir: string, failFirst: number): string => {
      const script = join(dir, 'standin.mjs')
      writeFileSync(script, standinServerSource(failFirst))
      chmodSync(script, 0o755)
      return script
    }

    try {
      // extractText is a pure view over an MCP result: text parts only,
      // joined with newlines; anything else yields the empty string.
      const reader = new TriosRagClient(standin(healthy, 0))
      clients.push(reader)
      expect(
        reader.extractText({
          content: [
            { type: 'text', text: 'first' },
            { type: 'image', data: 'AAAA' },
            { type: 'text', text: 'second' },
          ],
        }),
      ).toBe('first\nsecond')
      expect(reader.extractText({ content: [] })).toBe('')
      expect(reader.extractText(null)).toBe('')

      // A freshly constructed client reports itself disconnected.
      expect(reader.isConnected).toBe(false)

      // connect() brings the server up over the real stdio protocol and
      // reports connected, having spawned exactly one child process.
      await reader.connect()
      expect(reader.isConnected).toBe(true)
      expect(counter(healthy, 'spawns.txt')).toBe(1)

      // listTools() surfaces exactly the names the server advertises.
      expect(await reader.listTools()).toEqual(ADVERTISED_TOOLS)

      // callTool() round-trips the tool name and arguments through the
      // server and extractText reads the answer back out.
      const echoed = await reader.callTool('echo_args', { x: 1, y: 'two' })
      expect(reader.extractText(echoed)).toBe('echo:{"x":1,"y":"two"}')
      const searched = await reader.callTool('rag_search', { q: 'igla' })
      expect(reader.extractText(searched)).toBe('hits for igla')

      // The optional databaseUrl reaches the child as DATABASE_URL; when
      // it is absent the child inherits this process's own value.
      const expectedInherited = process.env.DATABASE_URL ?? 'unset'
      const inherited = await reader.callTool('report_env', {})
      expect(reader.extractText(inherited)).toBe(
        `DATABASE_URL=${expectedInherited}`,
      )
      const dbClient = new TriosRagClient(
        standin(provisioned, 0),
        'postgres://contract/standin',
      )
      clients.push(dbClient)
      await dbClient.connect()
      const reported = await dbClient.callTool('report_env', {})
      expect(dbClient.extractText(reported)).toBe(
        'DATABASE_URL=postgres://contract/standin',
      )
      await dbClient.disconnect()

      // connect() on an already-connected, healthy client reuses the
      // existing session instead of spawning another server.
      await reader.connect()
      expect(counter(healthy, 'spawns.txt')).toBe(1)

      // Two connect() calls racing from a cold start share a single
      // handshake: the second caller waits for the first rather than
      // spawning a second child.
      const racer = new TriosRagClient(standin(guarded, 0))
      clients.push(racer)
      await Promise.all([racer.connect(), racer.connect()])
      expect(counter(guarded, 'spawns.txt')).toBe(1)

      // A server that dies before completing its first handshake is
      // retried within a single connect() call and ends up serving.
      const survivor = new TriosRagClient(standin(flaky, 1))
      clients.push(survivor)
      await survivor.connect()
      expect(survivor.isConnected).toBe(true)
      expect(counter(flaky, 'handshakes.txt')).toBe(2)
      expect(await survivor.listTools()).toEqual(ADVERTISED_TOOLS)

      // startHealthCheck() keeps the session warm with periodic
      // tools/list pings; stopHealthCheck() halts them.
      const listsBefore = counter(healthy, 'lists.txt')
      reader.startHealthCheck(40)
      await waitFor(
        5_000,
        () => counter(healthy, 'lists.txt') >= listsBefore + 3,
      )
      reader.stopHealthCheck()
      await sleep(250) // let any in-flight tick land before measuring
      const settledAt = counter(healthy, 'lists.txt')
      await sleep(250)
      expect(counter(healthy, 'lists.txt')).toBe(settledAt)

      // disconnect() tears the child process down, reports
      // disconnected, and the server observes its stdin closing.
      await reader.disconnect()
      expect(reader.isConnected).toBe(false)
      await waitFor(5_000, () => existsSync(join(healthy, 'exited.txt')))
      expect(counter(healthy, 'spawns.txt')).toBe(1)

      // A later connect() brings a fresh server up again.
      await reader.connect()
      expect(reader.isConnected).toBe(true)
      expect(counter(healthy, 'spawns.txt')).toBe(2)
      await reader.disconnect()

      // connect() against a server binary that cannot even be spawned
      // rejects after exhausting its retries.
      const ghost = new TriosRagClient(join(dead, 'no-such-server'))
      clients.push(ghost)
      await expect(ghost.connect()).rejects.toThrow()

      // Persistently failing tool calls surface the underlying error,
      // and after enough consecutive failures the client fails fast
      // with an OPEN-circuit error instead of retrying spawns. One full
      // retry cycle costs hundreds of milliseconds of back-off, so a
      // fast rejection is itself observable behaviour.
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(ghost.listTools()).rejects.toThrow()
      }
      const openedAt = Date.now()
      await expect(ghost.listTools()).rejects.toThrow(/OPEN for trios-rag/)
      expect(Date.now() - openedAt).toBeLessThan(400)

      // disconnect() on a client that never connected is a no-op, not
      // an error.
      await ghost.disconnect()
      expect(ghost.isConnected).toBe(false)
    } finally {
      for (const client of clients) {
        client.stopHealthCheck()
        await client.disconnect().catch(() => {})
      }
      for (const dir of [healthy, provisioned, guarded, flaky, dead]) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }, 25_000)
})
