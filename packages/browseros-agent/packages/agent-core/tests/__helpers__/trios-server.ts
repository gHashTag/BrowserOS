/**
 * @license
 * Copyright 2025 BrowserOS
 *
 * Low-level process management for the Rust `trios-server` binary — the
 * production agent server that replaced the retired TS server surface.
 *
 * Binary resolution order:
 *   1. `TRIOS_SERVER_BIN` env var (absolute path)
 *   2. `trios-server` on PATH
 *
 * When the binary is not available the helpers become no-ops and
 * `resolveTriosServerBin()` returns null so callers can skip gracefully.
 * Use setup.ts:ensureBrowserOS() for the full test environment.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface ServerConfig {
  cdpPort: number
  serverPort: number
  extensionPort: number
}

interface ServerState {
  process: ChildProcess
  config: ServerConfig
}

let serverState: ServerState | null = null

export function resolveTriosServerBin(): string | null {
  const fromEnv = process.env.TRIOS_SERVER_BIN
  if (fromEnv) {
    return existsSync(fromEnv) ? fromEnv : null
  }
  return Bun.which('trios-server')
}

function appendBufferedLog(buffer: string[], chunk: Buffer | string): void {
  const lines = chunk
    .toString()
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
  if (lines.length === 0) {
    return
  }
  buffer.push(...lines)
  const overflow = buffer.length - 40
  if (overflow > 0) {
    buffer.splice(0, overflow)
  }
}

function formatStartupFailure(
  child: ChildProcess,
  port: number,
  stdoutBuffer: string[],
  stderrBuffer: string[],
  reason: string,
): Error {
  const details: string[] = [reason]
  if (child.exitCode !== null) {
    details.push(`exit code: ${child.exitCode}`)
  }
  if (child.signalCode) {
    details.push(`signal: ${child.signalCode}`)
  }
  if (stderrBuffer.length > 0) {
    details.push(`stderr:\n${stderrBuffer.join('\n')}`)
  } else if (stdoutBuffer.length > 0) {
    details.push(`stdout:\n${stdoutBuffer.join('\n')}`)
  }
  return new Error(
    `trios-server failed to start on port ${port}. ${details.join('\n\n')}`,
  )
}

export async function isServerRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    })
    return response.ok
  } catch {
    return false
  }
}

async function waitForHealth(
  child: ChildProcess,
  port: number,
  stdoutBuffer: string[],
  stderrBuffer: string[],
  maxAttempts = 60,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await isServerRunning(port)) {
      return
    }
    if (child.exitCode !== null || child.signalCode) {
      throw formatStartupFailure(
        child,
        port,
        stdoutBuffer,
        stderrBuffer,
        'trios-server exited before /health became ready.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw formatStartupFailure(
    child,
    port,
    stdoutBuffer,
    stderrBuffer,
    'Timed out waiting for /health to become ready.',
  )
}

export function getServerState(): ServerState | null {
  return serverState
}

export async function spawnServer(config: ServerConfig): Promise<ServerState> {
  const bin = resolveTriosServerBin()
  if (!bin) {
    throw new Error(
      'trios-server binary not found. Set TRIOS_SERVER_BIN or add trios-server to PATH.',
    )
  }

  if (
    serverState &&
    JSON.stringify(serverState.config) === JSON.stringify(config)
  ) {
    if (await isServerRunning(config.serverPort)) {
      console.log(`Reusing existing trios-server on port ${config.serverPort}`)
      return serverState
    }
  }

  if (serverState) {
    console.log('Config changed, cleaning up existing trios-server...')
    await killServer()
  }

  console.log(`Starting trios-server (Rust) on port ${config.serverPort}...`)
  const stdoutBuffer: string[] = []
  const stderrBuffer: string[] = []
  const child = spawn(bin, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TRIOS_PORT: config.serverPort.toString(),
      // SR-03 host runtime: the host CDP agent connects to this browser.
      TRIOS_CDP_PORT: config.cdpPort.toString(),
    },
  })

  child.stdout?.on('data', (data) => {
    appendBufferedLog(stdoutBuffer, data)
  })
  child.stderr?.on('data', (data) => {
    appendBufferedLog(stderrBuffer, data)
  })
  child.on('error', (error) => {
    console.error('Failed to start trios-server:', error)
  })

  console.log('Waiting for trios-server to be ready...')
  await waitForHealth(child, config.serverPort, stdoutBuffer, stderrBuffer)
  console.log('trios-server is ready')

  serverState = { process: child, config }
  return serverState
}

export async function killServer(): Promise<void> {
  if (!serverState) {
    return
  }

  console.log('Shutting down trios-server...')
  serverState.process.kill('SIGTERM')

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      serverState?.process.kill('SIGKILL')
      resolve()
    }, 5000)

    serverState?.process.on('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })

  console.log('trios-server stopped')
  serverState = null
}
