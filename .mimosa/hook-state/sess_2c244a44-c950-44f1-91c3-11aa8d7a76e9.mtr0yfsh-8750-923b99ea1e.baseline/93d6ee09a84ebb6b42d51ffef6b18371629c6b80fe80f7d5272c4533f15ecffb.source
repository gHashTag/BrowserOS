/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Runtime state for the OpenClaw gateway. Today this is just the host port
 * we mapped the gateway container to, persisted so that a once-chosen port
 * is reused across restarts when it's still free.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { OPENCLAW_GATEWAY_CONTAINER_PORT } from '@browseros/shared/constants/openclaw'
import { getOpenClawStateDir } from './openclaw-env'

const RUNTIME_STATE_FILE = 'runtime-state.json'
const MAX_TCP_PORT = 65_535

interface RuntimeState {
  gatewayPort: number
}

function readForcedGatewayPort(): number | null {
  const raw = process.env.BROWSEROS_TEST_OPENCLAW_GATEWAY_PORT?.trim()
  if (!raw) return null

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_TCP_PORT) {
    return null
  }
  return parsed
}

function getRuntimeStatePath(openclawDir: string): string {
  return join(getOpenClawStateDir(openclawDir), RUNTIME_STATE_FILE)
}

export async function readPersistedGatewayPort(
  openclawDir: string,
): Promise<number | null> {
  const path = getRuntimeStatePath(openclawDir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(
      await readFile(path, 'utf-8'),
    ) as Partial<RuntimeState>
    if (
      typeof parsed.gatewayPort === 'number' &&
      Number.isInteger(parsed.gatewayPort) &&
      parsed.gatewayPort > 0 &&
      parsed.gatewayPort <= MAX_TCP_PORT
    ) {
      return parsed.gatewayPort
    }
    return null
  } catch {
    return null
  }
}

async function writePersistedGatewayPort(
  openclawDir: string,
  port: number,
): Promise<void> {
  await mkdir(getOpenClawStateDir(openclawDir), { recursive: true })
  const state: RuntimeState = { gatewayPort: port }
  await writeFile(
    getRuntimeStatePath(openclawDir),
    `${JSON.stringify(state, null, 2)}\n`,
  )
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function findAvailablePort(
  startPort: number,
  excludePort?: number,
): Promise<number> {
  let port = startPort
  while (port === excludePort || !(await isPortAvailable(port))) {
    port++
    if (port > MAX_TCP_PORT) {
      throw new Error(
        `No available OpenClaw gateway port found from ${startPort}`,
      )
    }
  }
  return port
}

export interface AllocateGatewayPortOptions {
  excludePort?: number
}

/**
 * Pick a host port for the gateway container and persist it. Prefers the
 * previously persisted port when it's still bindable; otherwise scans
 * upward from OPENCLAW_GATEWAY_CONTAINER_PORT until a free port is found.
 */
export async function allocateGatewayPort(
  openclawDir: string,
  opts: AllocateGatewayPortOptions = {},
): Promise<number> {
  const forcedPort = readForcedGatewayPort()
  if (forcedPort !== null) {
    await writePersistedGatewayPort(openclawDir, forcedPort)
    return forcedPort
  }

  const persisted = await readPersistedGatewayPort(openclawDir)
  if (
    persisted !== null &&
    persisted !== opts.excludePort &&
    (await isPortAvailable(persisted))
  ) {
    return persisted
  }
  const port = await findAvailablePort(
    OPENCLAW_GATEWAY_CONTAINER_PORT,
    opts.excludePort,
  )
  await writePersistedGatewayPort(openclawDir, port)
  return port
}
