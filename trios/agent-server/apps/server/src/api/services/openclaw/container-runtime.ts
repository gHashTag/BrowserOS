/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  OPENCLAW_AGENT_NAME,
  OPENCLAW_GATEWAY_CONTAINER_NAME,
  OPENCLAW_GATEWAY_CONTAINER_PORT,
  OPENCLAW_IMAGE,
} from '@browseros/shared/constants/openclaw'
import type {
  ContainerCli,
  ContainerCommandResult,
  ContainerSpec,
  LogFn,
  WaitForContainerNameReleaseOptions,
} from '../../../lib/container'
import net from 'node:net'
import { isContainerNameInUse } from '../../../lib/container'
import { logger } from '../../../lib/logger'
import {
  GUEST_VM_STATE,
  hostPathToGuest,
  type VmRuntime,
} from '../../../lib/vm'
import { ContainerNameInUseError } from '../../../lib/vm/errors'

const GATEWAY_CONTAINER_HOME = '/home/node'
const GATEWAY_STATE_DIR = `${GATEWAY_CONTAINER_HOME}/.openclaw`
const GUEST_OPENCLAW_HOME = `${GUEST_VM_STATE}/openclaw`
const GATEWAY_NPM_PREFIX = `${GATEWAY_CONTAINER_HOME}/.npm-global`
const CREATE_CONTAINER_MAX_ATTEMPTS = 3
const OPENCLAW_NAME_RELEASE_WAIT: WaitForContainerNameReleaseOptions = {
  timeoutMs: 10_000,
  intervalMs: 100,
}
/** Default total budget for `waitForReady` before it gives up. */
export const GATEWAY_READY_TIMEOUT_MS = 30_000
/**
 * Budget for a single readiness probe. It must stay strictly below
 * GATEWAY_READY_TIMEOUT_MS so any wait always allows at least two attempts;
 * tests/api/services/openclaw/ready-probe.test.ts asserts that relation.
 */
export const GATEWAY_READY_PROBE_TIMEOUT_MS = 10_000
const GATEWAY_READY_RETRY_INTERVAL_MS = 1000
// Prepend user-installed bin so tools like `claude` / `gemini` CLI that
// are installed via npm into the mounted home are discoverable by
// OpenClaw's child-process spawns (no login shell is involved).
const GATEWAY_PATH = [
  `${GATEWAY_NPM_PREFIX}/bin`,
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin',
].join(':')

export type GatewayContainerSpec = {
  hostPort: number
  hostHome: string
  envFilePath: string
  timezone: string
}

export interface ContainerRuntimeConfig {
  vm: VmRuntime
  shell: ContainerCli
  loader: {
    ensureImageLoaded(ref: string, onLog?: LogFn): Promise<void>
    ensureAgentImageLoaded(name: string, onLog?: LogFn): Promise<string>
  }
  projectDir: string
}

export class ContainerRuntime {
  private readonly vm: VmRuntime
  private readonly shell: ContainerCli
  private readonly loader: {
    ensureImageLoaded(ref: string, onLog?: LogFn): Promise<void>
    ensureAgentImageLoaded(name: string, onLog?: LogFn): Promise<string>
  }
  private readonly projectDir: string

  constructor(config: ContainerRuntimeConfig) {
    this.vm = config.vm
    this.shell = config.shell
    this.loader = config.loader
    this.projectDir = config.projectDir
  }

  async ensureReady(onLog?: LogFn): Promise<void> {
    logger.info('Ensuring BrowserOS VM runtime readiness')
    await this.vm.ensureReady(onLog)
    await this.vm.getDefaultGateway()
  }

  async isPodmanAvailable(): Promise<boolean> {
    return true
  }

  async getMachineStatus(): Promise<{
    initialized: boolean
    running: boolean
  }> {
    const running = await this.vm.isReady()
    return { initialized: running, running }
  }

  async pullImage(image: string, onLog?: LogFn): Promise<void> {
    await this.loader.ensureImageLoaded(image, onLog)
  }

  /** Warm the gateway image in containerd without creating or starting containers. */
  async prewarmGatewayImage(onLog?: LogFn): Promise<void> {
    await this.ensureGatewayImageLoaded(onLog)
  }

  /** Report whether the existing gateway container was created from the target image. */
  async isGatewayCurrent(): Promise<boolean> {
    const image = await this.shell.containerImageRef(
      OPENCLAW_GATEWAY_CONTAINER_NAME,
    )
    const expected = this.expectedGatewayImageRef()
    const current = imageMatchesExpectedRef(image, expected)
    if (!current) {
      logger.info('OpenClaw gateway image is not current', {
        actualImageRef: image,
        expectedImageRef: expected,
      })
    }
    return current
  }

  async startGateway(
    input: GatewayContainerSpec,
    onLog?: LogFn,
  ): Promise<void> {
    const image = await this.ensureGatewayImageLoaded(onLog)
    const container = await this.buildGatewayContainerSpec(input, image)
    await this.createContainerWithNameReconcile(container, onLog)
    await this.shell.startContainer(container.name)
  }

  async stopGateway(onLog?: LogFn): Promise<void> {
    await this.removeGatewayContainer(onLog)
  }

  async restartGateway(
    input: GatewayContainerSpec,
    onLog?: LogFn,
  ): Promise<void> {
    await this.startGateway(input, onLog)
  }

  async getGatewayLogs(tail = 50): Promise<string[]> {
    const lines: string[] = []
    await this.shell.runCommand(
      ['logs', '-n', String(tail), OPENCLAW_GATEWAY_CONTAINER_NAME],
      (line) => lines.push(line),
    )
    return lines
  }

  async isHealthy(hostPort: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${hostPort}/healthz`)
      return res.ok
    } catch {
      return false
    }
  }

  async isReady(hostPort: number): Promise<boolean> {
    return (await probeGatewayReady(hostPort)).ready
  }

  async waitForReady(
    hostPort: number,
    timeoutMs: number = GATEWAY_READY_TIMEOUT_MS,
  ): Promise<boolean> {
    logger.info('Waiting for OpenClaw gateway readiness', {
      hostPort,
      timeoutMs,
    })
    const start = Date.now()
    let attempts = 0
    let lastFailure:
      | Extract<GatewayReadyProbeResult, { ready: false }>
      | undefined
    while (Date.now() - start < timeoutMs) {
      attempts += 1
      // A single probe may never outlive the remaining wait budget: a port
      // that accepts the connection and then stays silent is aborted here,
      // not allowed to hold the lifecycle lock past the deadline.
      const remaining = timeoutMs - (Date.now() - start)
      const probe = await probeGatewayReady(
        hostPort,
        Math.min(GATEWAY_READY_PROBE_TIMEOUT_MS, remaining),
      )
      if (probe.ready) return true
      lastFailure = probe
      logger.debug('OpenClaw gateway probe failed', {
        hostPort,
        attempt: attempts,
        failureKind: probe.reason,
        failureDetail: probe.detail,
      })
      const remainingAfterProbe = timeoutMs - (Date.now() - start)
      if (remainingAfterProbe > 0) {
        await Bun.sleep(
          Math.min(GATEWAY_READY_RETRY_INTERVAL_MS, remainingAfterProbe),
        )
      }
    }
    logger.error('Timed out waiting for OpenClaw gateway readiness', {
      hostPort,
      timeoutMs,
      attempts,
      failureKind: lastFailure?.reason ?? 'not-attempted',
      failureDetail:
        lastFailure?.detail ?? 'deadline expired before first probe',
    })
    return false
  }

  async stopVm(): Promise<void> {
    await this.vm.stopVm()
  }

  async execInContainer(command: string[], onLog?: LogFn): Promise<number> {
    return this.shell.exec(OPENCLAW_GATEWAY_CONTAINER_NAME, command, onLog)
  }

  // Unlike execInContainer, this returns stdout and stderr separately
  // so callers that need to parse program output (e.g. JSON status
  // commands) aren't forced to untangle it from nerdctl's stderr.
  async runInContainer(command: string[]): Promise<ContainerCommandResult> {
    return this.shell.runCommand([
      'exec',
      OPENCLAW_GATEWAY_CONTAINER_NAME,
      ...command,
    ])
  }

  async runGatewaySetupCommand(
    command: string[],
    spec: GatewayContainerSpec,
    onLog?: LogFn,
  ): Promise<number> {
    const setupContainerName = `${OPENCLAW_GATEWAY_CONTAINER_NAME}-setup`
    await this.removeContainerAndWait(setupContainerName, onLog)
    const image = await this.ensureGatewayImageLoaded(onLog)
    const setupArgs = command[0] === 'node' ? command.slice(1) : command
    const createResult = await this.runSetupCreateWithNameReconcile(
      setupContainerName,
      [
        'create',
        '--name',
        setupContainerName,
        ...(await this.buildGatewayRunArgs(spec)),
        image,
        'node',
        ...setupArgs,
      ],
      onLog,
    )
    if (createResult.exitCode !== 0) {
      await this.shell.removeContainer(
        setupContainerName,
        { force: true },
        onLog,
      )
      return createResult.exitCode
    }

    try {
      const startResult = await this.shell.runCommand(
        ['start', '-a', setupContainerName],
        onLog,
      )
      return startResult.exitCode
    } finally {
      await this.shell.removeContainer(
        setupContainerName,
        { force: true },
        onLog,
      )
    }
  }

  tailGatewayLogs(onLine: LogFn): () => void {
    return this.shell.tailLogs(OPENCLAW_GATEWAY_CONTAINER_NAME, onLine)
  }

  private async removeGatewayContainer(onLog?: LogFn): Promise<void> {
    await this.removeContainerAndWait(OPENCLAW_GATEWAY_CONTAINER_NAME, onLog)
  }

  /** Create the fixed-name gateway after reconciling stale nerdctl name ownership. */
  private async createContainerWithNameReconcile(
    container: ContainerSpec,
    onLog?: LogFn,
  ): Promise<void> {
    let attempt = 1
    while (true) {
      await this.removeContainerAndWait(container.name, onLog)
      try {
        await this.shell.createContainer(container, onLog)
        return
      } catch (err) {
        if (
          !(err instanceof ContainerNameInUseError) ||
          attempt >= CREATE_CONTAINER_MAX_ATTEMPTS
        ) {
          throw err
        }
        logger.warn('OpenClaw container name still in use; retrying create', {
          containerName: container.name,
          attempt,
          maxAttempts: CREATE_CONTAINER_MAX_ATTEMPTS,
        })
        attempt++
      }
    }
  }

  private async runSetupCreateWithNameReconcile(
    setupContainerName: string,
    createArgs: string[],
    onLog?: LogFn,
  ): Promise<ContainerCommandResult> {
    let attempt = 1
    while (true) {
      const result = await this.shell.runCommand(createArgs, onLog)
      if (
        result.exitCode === 0 ||
        !isContainerNameInUse(result.stderr) ||
        attempt >= CREATE_CONTAINER_MAX_ATTEMPTS
      ) {
        return result
      }

      logger.warn(
        'OpenClaw setup container name still in use; retrying create',
        {
          containerName: setupContainerName,
          attempt,
          maxAttempts: CREATE_CONTAINER_MAX_ATTEMPTS,
        },
      )
      await this.removeContainerAndWait(setupContainerName, onLog)
      attempt++
    }
  }

  private async removeContainerAndWait(
    containerName: string,
    onLog?: LogFn,
  ): Promise<void> {
    await this.shell.removeContainer(containerName, { force: true }, onLog)
    await this.shell.waitForContainerNameRelease(
      containerName,
      OPENCLAW_NAME_RELEASE_WAIT,
    )
  }

  private async buildGatewayContainerSpec(
    input: GatewayContainerSpec,
    image: string,
  ): Promise<ContainerSpec> {
    return {
      name: OPENCLAW_GATEWAY_CONTAINER_NAME,
      image,
      restart: 'unless-stopped',
      ports: [
        {
          hostIp: '127.0.0.1',
          hostPort: input.hostPort,
          containerPort: OPENCLAW_GATEWAY_CONTAINER_PORT,
        },
      ],
      envFile: this.translateHostPath(input.envFilePath, input.hostHome),
      env: this.buildGatewayEnv(input),
      mounts: [{ source: GUEST_OPENCLAW_HOME, target: GATEWAY_CONTAINER_HOME }],
      addHosts: [await this.hostContainersInternalEntry()],
      health: {
        cmd: `curl -sf http://127.0.0.1:${OPENCLAW_GATEWAY_CONTAINER_PORT}/healthz`,
        interval: '30s',
        timeout: '10s',
        retries: 3,
      },
      command: [
        'node',
        'dist/index.js',
        'gateway',
        '--bind',
        'lan',
        '--port',
        String(OPENCLAW_GATEWAY_CONTAINER_PORT),
        '--allow-unconfigured',
      ],
    }
  }

  private async buildGatewayRunArgs(
    input: GatewayContainerSpec,
  ): Promise<string[]> {
    const args = [
      '--env-file',
      this.translateHostPath(input.envFilePath, input.hostHome),
      '-v',
      `${GUEST_OPENCLAW_HOME}:${GATEWAY_CONTAINER_HOME}`,
    ]
    for (const [key, value] of Object.entries(this.buildGatewayEnv(input))) {
      args.push('-e', `${key}=${value}`)
    }
    args.push('--add-host', await this.hostContainersInternalEntry())
    return args
  }

  private async hostContainersInternalEntry(): Promise<string> {
    return `host.containers.internal:${await this.vm.getDefaultGateway()}`
  }

  private async ensureGatewayImageLoaded(onLog?: LogFn): Promise<string> {
    // Local image testing can override the pinned GHCR image with OPENCLAW_IMAGE.
    const override = process.env.OPENCLAW_IMAGE?.trim()
    if (override) {
      await this.loader.ensureImageLoaded(override, onLog)
      return override
    }
    return this.loader.ensureAgentImageLoaded(OPENCLAW_AGENT_NAME, onLog)
  }

  private expectedGatewayImageRef(): string {
    return process.env.OPENCLAW_IMAGE?.trim() || OPENCLAW_IMAGE
  }

  private buildGatewayEnv(input: GatewayContainerSpec): Record<string, string> {
    return {
      HOME: GATEWAY_CONTAINER_HOME,
      OPENCLAW_HOME: GATEWAY_CONTAINER_HOME,
      OPENCLAW_STATE_DIR: GATEWAY_STATE_DIR,
      OPENCLAW_NO_RESPAWN: '1',
      NODE_COMPILE_CACHE: '/var/tmp/openclaw-compile-cache',
      NODE_ENV: 'production',
      TZ: input.timezone,
      PATH: GATEWAY_PATH,
      NPM_CONFIG_PREFIX: GATEWAY_NPM_PREFIX,
      OPENCLAW_GATEWAY_PRIVATE_INGRESS_NO_AUTH: '1',
    }
  }

  private translateHostPath(path: string, openclawHostDir: string): string {
    if (path === openclawHostDir) return GUEST_OPENCLAW_HOME
    if (path.startsWith(`${openclawHostDir}/`)) {
      return `${GUEST_OPENCLAW_HOME}${path.slice(openclawHostDir.length)}`
    }
    return hostPathToGuest(path)
  }
}

/** Why a single readiness probe failed. Three different operational problems. */
export type GatewayReadyProbeReason = 'refused' | 'timed-out' | 'not-ok'

export type GatewayReadyProbeResult =
  | { ready: true }
  | {
      ready: false
      reason: GatewayReadyProbeReason
      detail: string
    }

/**
 * Probe the gateway `/readyz` endpoint exactly once.
 *
 * The request carries its own abort signal so a port that accepts the TCP
 * connection and then never responds cannot outlive the probe budget: when
 * the budget expires the fetch is aborted - the request is never left
 * pending. The outcome records why the probe failed, because a refused
 * port, a wedged port, and a gateway answering non-2xx are three different
 * operational problems.
 */
/**
 * Is the gateway answering /readyz, and is the connection gone when it is not?
 *
 * WRITTEN ON A RAW SOCKET, NOT `fetch`, AND THAT IS THE WHOLE POINT.
 *
 * The previous implementation was `fetch` with an `AbortController`. Aborting a
 * fetch cancels the REQUEST; whether it destroys the underlying connection is
 * the runtime's business, and under load it does not. Measured in CI on
 * 2026-09-06, inside the 976-test group where this leaks:
 *
 *   CLOSE-WITNESS: closed=false after 3015ms, closeCount=0, sockets=1
 *
 * The wedged server still had the socket open three seconds after the probe had
 * returned `timed-out`. Not late and not merely unobserved - open. Alone, and
 * on two other machines, the same probe closed in 29ms, which is why this took
 * four rounds to see: it only leaks under the load it will actually meet, and
 * this function is called in a retry loop against a gateway that is by
 * definition not answering.
 *
 * A socket we own can be destroyed. `destroy()` on timeout is a guarantee about
 * a file descriptor rather than a request about a request, and the readiness
 * probe stops depending on fetch's pooling semantics to avoid leaking one
 * connection per attempt.
 *
 * `Connection: close` is sent as well, so a gateway that DOES answer tears the
 * connection down itself rather than leaving it pooled for a caller that will
 * never reuse it.
 *
 * The four outcomes and their exact shapes are unchanged; the tests that pin
 * them did not move.
 */
export async function probeGatewayReady(
  hostPort: number,
  timeoutMs: number = GATEWAY_READY_PROBE_TIMEOUT_MS,
): Promise<GatewayReadyProbeResult> {
  return new Promise<GatewayReadyProbeResult>((resolve) => {
    const socket = new net.Socket()
    let settled = false
    let received = ''

    // Every exit runs through here, so there is no path that leaves the socket
    // alive - which is the defect this replaces.
    const finish = (result: GatewayReadyProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({
        ready: false,
        reason: 'timed-out',
        detail: `no response within ${timeoutMs}ms`,
      })
    }, timeoutMs)

    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => {
      finish({
        ready: false,
        reason: 'timed-out',
        detail: `no response within ${timeoutMs}ms`,
      })
    })

    socket.on('error', (err: Error) => {
      // A connection that was never established is `refused`; anything after a
      // successful connect is reported the same way, because the caller's only
      // question is whether the gateway answered.
      finish({ ready: false, reason: 'refused', detail: err.message })
    })

    socket.on('close', () => {
      // Closed before a status line arrived: the gateway hung up on us.
      finish({
        ready: false,
        reason: 'refused',
        detail: 'connection closed before a response',
      })
    })

    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1')
      const statusLine = received.split('\r\n', 1)[0]
      if (!received.includes('\r\n')) return
      const match = statusLine.match(/^HTTP\/1\.[01] (\d{3})/)
      if (!match) {
        finish({
          ready: false,
          reason: 'refused',
          detail: `unparseable status line: ${statusLine.slice(0, 60)}`,
        })
        return
      }
      const status = Number(match[1])
      if (status >= 200 && status < 300) {
        finish({ ready: true })
        return
      }
      finish({ ready: false, reason: 'not-ok', detail: `HTTP ${status}` })
    })

    socket.connect(hostPort, '127.0.0.1', () => {
      socket.write(
        `GET /readyz HTTP/1.1\r\nHost: 127.0.0.1:${hostPort}\r\nConnection: close\r\n\r\n`,
      )
    })
  })
}

function imageMatchesExpectedRef(
  actual: string | null,
  expected: string,
): boolean {
  return (
    actual === expected || actual?.startsWith(`${expected}@sha256:`) === true
  )
}
