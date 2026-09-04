/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * First suite for the OpenClaw gateway runtime-state module. It pins the
 * behaviour that exists today so the next change to the file has something
 * to fail against.
 *
 * Coverage ledger - both exports of the module are pinned; nothing was
 * silently left out:
 *   - readPersistedGatewayPort -> exercised below (the file-backed read
 *     contract: what is read, from where, and what reads as "no port").
 *   - allocateGatewayPort -> exercised below (the allocation contract:
 *     forced env port, reuse of a bindable persisted port, and the
 *     scan-and-persist fallback).
 * No export was blocked by a live dependency: the whole suite runs on a
 * temp directory and loopback sockets bound to 127.0.0.1 - no network,
 * no database, no container.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPENCLAW_GATEWAY_CONTAINER_PORT } from '@browseros/shared/constants/openclaw'
import {
  allocateGatewayPort,
  readPersistedGatewayPort,
} from '../../src/api/services/openclaw/runtime-state'

const STATE_FILE = 'runtime-state.json'
const STATE_DIR_NAME = '.openclaw'
const FORCED_PORT_ENV = 'BROWSEROS_TEST_OPENCLAW_GATEWAY_PORT'
const MAX_TCP_PORT = 65_535

/** A throwaway openclaw directory, laid out the way the module expects to find one. */
function makeOpenclawDir(): string {
  return mkdtempSync(join(tmpdir(), 'openclaw-runtime-state-'))
}

/** Write raw bytes to the state file the module reads, bypassing the module itself. */
function persistRawState(openclawDir: string, contents: string): void {
  mkdirSync(join(openclawDir, STATE_DIR_NAME), { recursive: true })
  writeFileSync(join(openclawDir, STATE_DIR_NAME, STATE_FILE), contents)
}

/** Read back what the module persisted, as raw JSON, to observe the on-disk format. */
function readRawState(openclawDir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(openclawDir, STATE_DIR_NAME, STATE_FILE), 'utf-8'),
  ) as Record<string, unknown>
}

/** Bind a loopback listener; resolves once the port is actually held. */
function holdPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/** Grab an ephemeral loopback port from the OS, then release the socket so the port reads as free. */
async function reserveFreePort(): Promise<number> {
  const server = await holdPort(0)
  const address = server.address()
  const port =
    address !== null && typeof address === 'object' ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('runtimeStateContract', () => {
  it('readPersistedGatewayPort returns the port stored in <openclawDir>/.openclaw/runtime-state.json and null for anything unreadable', async () => {
    const dir = makeOpenclawDir()
    try {
      // No state file yet: a fresh install reads as "no port chosen".
      expect(await readPersistedGatewayPort(dir)).toBeNull()

      // A well-formed state file yields its port verbatim, across the
      // whole legal range. The read is pure: ports need not be bindable.
      persistRawState(dir, JSON.stringify({ gatewayPort: 1 }))
      expect(await readPersistedGatewayPort(dir)).toBe(1)
      persistRawState(dir, JSON.stringify({ gatewayPort: MAX_TCP_PORT }))
      expect(await readPersistedGatewayPort(dir)).toBe(MAX_TCP_PORT)
      persistRawState(dir, JSON.stringify({ gatewayPort: 40_123 }))
      expect(await readPersistedGatewayPort(dir)).toBe(40_123)

      // Malformed or out-of-contract content reads as null, never throws.
      const unreadablePayloads = [
        'not json at all',
        '{}',
        JSON.stringify({ gatewayPort: '18789' }),
        JSON.stringify({ gatewayPort: 0 }),
        JSON.stringify({ gatewayPort: -1 }),
        JSON.stringify({ gatewayPort: 1.5 }),
        JSON.stringify({ gatewayPort: MAX_TCP_PORT + 1 }),
        JSON.stringify({ gatewayPort: 12.0001 }),
      ]
      for (const payload of unreadablePayloads) {
        persistRawState(dir, payload)
        expect(await readPersistedGatewayPort(dir)).toBeNull()
      }

      // The state file is only honoured inside the .openclaw state
      // directory; a stray copy next to the openclaw root is ignored.
      const strayDir = makeOpenclawDir()
      try {
        writeFileSync(
          join(strayDir, STATE_FILE),
          JSON.stringify({ gatewayPort: 40_124 }),
        )
        expect(await readPersistedGatewayPort(strayDir)).toBeNull()
      } finally {
        rmSync(strayDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allocateGatewayPort honours a forced env port, reuses a still-bindable persisted port, and otherwise picks and persists a fresh one', async () => {
    const previousForced = process.env[FORCED_PORT_ENV]
    let holder: Server | null = null
    const dir = makeOpenclawDir()
    try {
      delete process.env[FORCED_PORT_ENV]

      // Fresh directory: a legal port is allocated, the scan starts from
      // the container port, and the choice is persisted where a later
      // reader (or a restart) will find exactly that port.
      const first = await allocateGatewayPort(dir)
      expect(Number.isInteger(first)).toBe(true)
      expect(first).toBeGreaterThanOrEqual(OPENCLAW_GATEWAY_CONTAINER_PORT)
      expect(first).toBeLessThanOrEqual(MAX_TCP_PORT)
      expect(readRawState(dir).gatewayPort).toBe(first)
      expect(await readPersistedGatewayPort(dir)).toBe(first)

      // A valid forced port from the environment wins over both the
      // persisted state and the scan, and becomes the persisted port.
      const forced = 39_501
      process.env[FORCED_PORT_ENV] = String(forced)
      expect(await allocateGatewayPort(dir)).toBe(forced)
      expect(readRawState(dir).gatewayPort).toBe(forced)

      // Garbage in the same variable is ignored rather than trusted:
      // each of these falls back to normal allocation.
      for (const garbage of [
        'not-a-number',
        '0',
        String(MAX_TCP_PORT + 1),
        '   ',
      ]) {
        process.env[FORCED_PORT_ENV] = garbage
        const fallback = await allocateGatewayPort(dir)
        expect(Number.isInteger(fallback)).toBe(true)
        expect(fallback).toBeGreaterThan(0)
        expect(fallback).toBeLessThanOrEqual(MAX_TCP_PORT)
      }

      // A persisted port that is still bindable is reused as-is: the
      // once-chosen port survives a restart.
      delete process.env[FORCED_PORT_ENV]
      rmSync(dir, { recursive: true, force: true })
      const reusable = await reserveFreePort()
      persistRawState(dir, JSON.stringify({ gatewayPort: reusable }))
      expect(await allocateGatewayPort(dir)).toBe(reusable)

      // ...unless the caller excludes it, in which case a different
      // port is allocated and persisted in its place.
      rmSync(dir, { recursive: true, force: true })
      const excluded = await reserveFreePort()
      persistRawState(dir, JSON.stringify({ gatewayPort: excluded }))
      const afterExclusion = await allocateGatewayPort(dir, {
        excludePort: excluded,
      })
      expect(afterExclusion).not.toBe(excluded)
      expect(await readPersistedGatewayPort(dir)).toBe(afterExclusion)

      // ...or it is no longer bindable, in which case the allocator
      // scans onward instead of handing back a dead port, and the
      // replacement is persisted.
      rmSync(dir, { recursive: true, force: true })
      const occupied = await reserveFreePort()
      holder = await holdPort(occupied)
      persistRawState(dir, JSON.stringify({ gatewayPort: occupied }))
      const reallocated = await allocateGatewayPort(dir)
      expect(reallocated).not.toBe(occupied)
      expect(Number.isInteger(reallocated)).toBe(true)
      expect(reallocated).toBeGreaterThanOrEqual(
        OPENCLAW_GATEWAY_CONTAINER_PORT,
      )
      expect(reallocated).toBeLessThanOrEqual(MAX_TCP_PORT)
      expect(await readPersistedGatewayPort(dir)).toBe(reallocated)
    } finally {
      if (previousForced === undefined) {
        delete process.env[FORCED_PORT_ENV]
      } else {
        process.env[FORCED_PORT_ENV] = previousForced
      }
      await new Promise<void>((resolve) => {
        if (holder) {
          holder.close(() => resolve())
        } else {
          resolve()
        }
      })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
