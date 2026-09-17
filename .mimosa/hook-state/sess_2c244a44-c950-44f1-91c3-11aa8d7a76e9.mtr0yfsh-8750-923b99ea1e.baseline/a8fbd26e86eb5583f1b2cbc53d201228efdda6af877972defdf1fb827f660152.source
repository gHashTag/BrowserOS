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
    try {
      const res = await fetch(`http://127.0.0.1:${hostPort}/readyz`)
      return res.ok
    } catch {
      return false
    }
  }

  async waitForReady(hostPort: number, timeoutMs = 30_000): Promise<boolean> {
    logger.info('Waiting for OpenClaw gateway readiness', {
      hostPort,
      timeoutMs,
    })
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await this.isReady(hostPort)) return true
      await Bun.sleep(1000)
    }
    logger.error('Timed out waiting for OpenClaw gateway readiness', {
      hostPort,
      timeoutMs,
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

function imageMatchesExpectedRef(
  actual: string | null,
  expected: string,
): boolean {
  return (
    actual === expected || actual?.startsWith(`${expected}@sha256:`) === true
  )
}
