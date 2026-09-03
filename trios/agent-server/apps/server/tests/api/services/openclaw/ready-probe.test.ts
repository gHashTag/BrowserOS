/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import net from 'node:net'
import {
  ContainerRuntime,
  GATEWAY_READY_PROBE_TIMEOUT_MS,
  GATEWAY_READY_TIMEOUT_MS,
  probeGatewayReady,
} from '../../../../src/api/services/openclaw/container-runtime'
import * as loggerModule from '../../../../src/lib/logger'

const PROJECT_DIR = '/tmp/openclaw'
const READINESS_EXPIRED_LOG = 'Timed out waiting for OpenClaw gateway readiness'

/**
 * chat-service.test.ts replaces the logger module process-wide via
 * mock.module with a stub that has no error method, so in a whole-group bun
 * run any logger.error call would crash. Give the current logger object an
 * error method only when it is missing; the real Logger instance is never
 * touched.
 */
function healStubbedLoggerError(): void {
  const target = loggerModule.logger as { error?: unknown }
  if (typeof target.error !== 'function') {
    target.error = () => {}
  }
}

healStubbedLoggerError()
beforeEach(healStubbedLoggerError)

type CapturedErrorLog = {
  message: string
  meta: Record<string, unknown> | undefined
}

/**
 * Capture logger.error calls without depending on how the shared logger
 * module is currently wired: sibling test files replace it process-wide via
 * mock.module (chat-service.test.ts stubs it without an error method), so
 * spyOn on the method is not reliable in a whole-group bun run. Assigning an
 * own property covers both the real Logger instance and any stub.
 */
function captureLoggerError(): {
  entries: CapturedErrorLog[]
  restore: () => void
} {
  const target = loggerModule.logger as {
    error?: (message: string, meta?: Record<string, unknown>) => void
  }
  const entries: CapturedErrorLog[] = []
  const original = target.error
  target.error = (message, meta) => {
    entries.push({ message, meta })
  }
  return {
    entries,
    restore: () => {
      if (original === undefined) {
        delete target.error
      } else {
        target.error = original
      }
    },
  }
}

type TrackedServer = {
  server: net.Server
  port: number
  sockets: Set<net.Socket>
  closeCount: () => number
}

describe('ContainerRuntime.waitForReady', () => {
  it('returns false within the requested deadline when the server accepts connections and never responds', async () => {
    const wedged = await startWedgedServer()
    const runtime = createRuntime()
    try {
      const startedAt = Date.now()
      const ready = await runtime.waitForReady(wedged.port, 1500)
      const elapsed = Date.now() - startedAt
      expect(ready).toBe(false)
      expect(elapsed).toBeLessThan(2500)
    } finally {
      await stopServer(wedged)
    }
  })

  it('returns false at the deadline when the port refuses connections', async () => {
    const port = await findRefusedPort()
    const runtime = createRuntime()
    const startedAt = Date.now()
    const ready = await runtime.waitForReady(port, 1500)
    const elapsed = Date.now() - startedAt
    expect(ready).toBe(false)
    // It must keep retrying until the deadline, not give up early.
    expect(elapsed).toBeGreaterThanOrEqual(1400)
    expect(elapsed).toBeLessThan(2500)
  })

  it('returns true promptly when the gateway becomes ready mid-wait', async () => {
    // Reserve an ephemeral port and leave it unbound, exactly like a
    // container whose gateway process has not bound its port yet.
    const port = await findRefusedPort()
    const gateway = makeHttpServer('200 OK')
    const runtime = createRuntime()
    try {
      const startedAt = Date.now()
      const waitPromise = runtime.waitForReady(port, 1500)
      await Bun.sleep(250)
      await listenOn(gateway, port)
      const ready = await waitPromise
      const elapsed = Date.now() - startedAt
      expect(ready).toBe(true)
      expect(elapsed).toBeLessThan(2500)
    } finally {
      await stopServer(gateway)
    }
  })

  it('records which failure kind ended an expired wait: refused, timed out, and answered not-ok', async () => {
    const errorLog = captureLoggerError()
    const wedged = await startWedgedServer()
    const notOk = await listen(makeHttpServer('503 Service Unavailable'))
    const refusedPort = await findRefusedPort()
    const runtime = createRuntime()
    try {
      // Short 600 ms deadlines: three expired waits inside one test, each
      // still well under the two-second wall-clock budget per delay.
      await runtime.waitForReady(wedged.port, 600)
      await runtime.waitForReady(notOk.port, 600)
      await runtime.waitForReady(refusedPort, 600)

      const byPort = new Map<number, Record<string, unknown>>()
      for (const entry of errorLog.entries) {
        if (entry.message !== READINESS_EXPIRED_LOG || !entry.meta) continue
        byPort.set(entry.meta.hostPort as number, entry.meta)
      }

      const wedgedEntry = byPort.get(wedged.port)
      expect(wedgedEntry?.failureKind).toBe('timed-out')
      expect(wedgedEntry?.attempts).toBeGreaterThan(0)
      expect(typeof wedgedEntry?.failureDetail).toBe('string')

      const notOkEntry = byPort.get(notOk.port)
      expect(notOkEntry?.failureKind).toBe('not-ok')
      expect(notOkEntry?.attempts).toBeGreaterThan(0)
      expect(notOkEntry?.failureDetail).toBe('HTTP 503')

      const refusedEntry = byPort.get(refusedPort)
      expect(refusedEntry?.failureKind).toBe('refused')
      expect(refusedEntry?.attempts).toBeGreaterThan(0)
      expect(typeof refusedEntry?.failureDetail).toBe('string')

      // Three waits, three distinct failure kinds in the log.
      const kinds = [wedgedEntry, notOkEntry, refusedEntry].map(
        (entry) => entry?.failureKind,
      )
      expect(new Set(kinds).size).toBe(3)
    } finally {
      errorLog.restore()
      await stopServer(wedged)
      await stopServer(notOk)
    }
  })
})

describe('probeGatewayReady', () => {
  it('aborts the pending request instead of leaving it hanging', async () => {
    const wedged = await startWedgedServer()
    try {
      const startedAt = Date.now()
      const result = await probeGatewayReady(wedged.port, 150)
      const elapsed = Date.now() - startedAt
      expect(result).toEqual({
        ready: false,
        reason: 'timed-out',
        detail: 'no response within 150ms',
      })
      expect(elapsed).toBeLessThan(1000)
      // The server must observe the connection being torn down: the aborted
      // probe may not linger as a pending request.
      const socketClosed = await waitForCondition(
        () => wedged.closeCount() >= 1,
        1000,
        25,
      )
      expect(socketClosed).toBe(true)
      expect(wedged.sockets.size).toBe(0)
    } finally {
      await stopServer(wedged)
    }
  })

  it('reports refused, answered not-ok, and ready outcomes for a single probe', async () => {
    const refusedPort = await findRefusedPort()
    const notOk = await listen(makeHttpServer('503 Service Unavailable'))
    const ok = await listen(makeHttpServer('200 OK'))
    try {
      const refused = await probeGatewayReady(refusedPort)
      expect(refused.ready).toBe(false)
      if (!refused.ready) {
        expect(refused.reason).toBe('refused')
        expect(refused.detail.length).toBeGreaterThan(0)
      }

      const answered = await probeGatewayReady(notOk.port)
      expect(answered).toEqual({
        ready: false,
        reason: 'not-ok',
        detail: 'HTTP 503',
      })

      const ready = await probeGatewayReady(ok.port)
      expect(ready).toEqual({ ready: true })
    } finally {
      await stopServer(notOk)
      await stopServer(ok)
    }
  })
})

describe('gateway readiness budgets', () => {
  it('keeps the per-attempt timeout strictly below the default total timeout', () => {
    expect(GATEWAY_READY_PROBE_TIMEOUT_MS).toBeGreaterThan(0)
    expect(GATEWAY_READY_TIMEOUT_MS).toBeGreaterThan(0)
    // At least two attempts must fit inside any default wait.
    expect(GATEWAY_READY_PROBE_TIMEOUT_MS).toBeLessThan(
      GATEWAY_READY_TIMEOUT_MS,
    )
  })
})

function makeServer(onConnection: (socket: net.Socket) => void): TrackedServer {
  const sockets = new Set<net.Socket>()
  let closed = 0
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      closed += 1
    })
    onConnection(socket)
  })
  return { server, port: -1, sockets, closeCount: () => closed }
}

/** A server that accepts TCP connections and then never writes a byte. */
function startWedgedServer(): Promise<TrackedServer> {
  const tracked = makeServer(() => {
    // Accept the connection, never respond.
  })
  return listen(tracked)
}

/** A server that answers every connection with a bare raw HTTP response. */
function makeHttpServer(statusLine: string): TrackedServer {
  return makeServer((socket) => {
    socket.end(
      `HTTP/1.1 ${statusLine}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    )
  })
}

function listen(tracked: TrackedServer): Promise<TrackedServer> {
  return listenOn(tracked, 0)
}

function listenOn(
  tracked: TrackedServer,
  port: number,
): Promise<TrackedServer> {
  return new Promise((resolve, reject) => {
    tracked.server.once('error', reject)
    tracked.server.listen(port, '127.0.0.1', () => {
      const address = tracked.server.address() as net.AddressInfo
      tracked.port = address.port
      resolve(tracked)
    })
  })
}

/** Reserve an ephemeral port, then stop listening so it refuses connections. */
async function findRefusedPort(): Promise<number> {
  const holder = makeServer(() => {})
  const bound = await listen(holder)
  await stopServer(bound)
  return bound.port
}

async function stopServer(tracked: TrackedServer): Promise<void> {
  for (const socket of tracked.sockets) {
    socket.destroy()
  }
  await new Promise<void>((resolve) => {
    tracked.server.close(() => resolve())
  })
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await Bun.sleep(intervalMs)
  }
  return predicate()
}

function createRuntime(): ContainerRuntime {
  return new ContainerRuntime({
    vm: {
      ensureReady: mock(async () => {}),
      getDefaultGateway: mock(async () => '192.168.5.2'),
      stopVm: mock(async () => {}),
      isReady: mock(async () => true),
    },
    shell: {
      createContainer: mock(async () => {}),
      startContainer: mock(async () => {}),
      stopContainer: mock(async () => {}),
      removeContainer: mock(async () => {}),
      containerImageRef: mock(async () => null),
      waitForContainerNameRelease: mock(async () => {}),
      exec: mock(async () => 0),
      runCommand: mock(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      tailLogs: mock(() => () => {}),
    },
    loader: {
      ensureImageLoaded: mock(async () => {}),
      ensureAgentImageLoaded: mock(async () => 'openclaw'),
    },
    projectDir: PROJECT_DIR,
  })
}
