/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { describe, expect, it, mock } from 'bun:test'
import {
  OPENCLAW_GATEWAY_CONTAINER_NAME,
  OPENCLAW_IMAGE,
} from '@browseros/shared/constants/openclaw'
import { ContainerRuntime } from '../../../../src/api/services/openclaw/container-runtime'
import { ContainerNameInUseError } from '../../../../src/lib/vm/errors'

const PROJECT_DIR = '/tmp/openclaw'
const OPENCLAW_NAME_RELEASE_WAIT = { timeoutMs: 10_000, intervalMs: 100 }
const defaultSpec = {
  hostPort: 18789,
  hostHome: '/Users/me/.browseros/vm/openclaw',
  envFilePath: '/Users/me/.browseros/vm/openclaw/.openclaw/.env',
  gatewayToken: 'token-123',
  timezone: 'America/Los_Angeles',
}

describe('ContainerRuntime', () => {
  it('starts the gateway by loading the image, creating, and starting a container', async () => {
    const deps = createDeps()
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    await runtime.startGateway(defaultSpec)

    expect(deps.shell.removeContainer).toHaveBeenCalledWith(
      OPENCLAW_GATEWAY_CONTAINER_NAME,
      { force: true },
      undefined,
    )
    expect(deps.shell.waitForContainerNameRelease).toHaveBeenCalledWith(
      OPENCLAW_GATEWAY_CONTAINER_NAME,
      OPENCLAW_NAME_RELEASE_WAIT,
    )
    expect(deps.loader.ensureAgentImageLoaded).toHaveBeenCalledWith(
      'openclaw',
      undefined,
    )
    expect(deps.shell.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: OPENCLAW_GATEWAY_CONTAINER_NAME,
        image: OPENCLAW_IMAGE,
        restart: 'unless-stopped',
        ports: [
          {
            hostIp: '127.0.0.1',
            hostPort: 18789,
            containerPort: 18789,
          },
        ],
        envFile: '/mnt/browseros/vm/openclaw/.openclaw/.env',
        mounts: [
          {
            source: '/mnt/browseros/vm/openclaw',
            target: '/home/node',
          },
        ],
        addHosts: ['host.containers.internal:192.168.5.2'],
      }),
      undefined,
    )
    expect(deps.shell.startContainer).toHaveBeenCalledWith(
      OPENCLAW_GATEWAY_CONTAINER_NAME,
    )
  })

  it('reconciles and retries when gateway create reports name-in-use', async () => {
    const deps = createDeps()
    deps.shell.createContainer = mock(async () => {
      if (deps.shell.createContainer.mock.calls.length === 1) {
        throw new ContainerNameInUseError(
          OPENCLAW_GATEWAY_CONTAINER_NAME,
          'nerdctl create',
          1,
          `name-store error\nname "${OPENCLAW_GATEWAY_CONTAINER_NAME}" is already used`,
        )
      }
    })
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    await runtime.startGateway(defaultSpec)

    expect(deps.shell.createContainer).toHaveBeenCalledTimes(2)
    expect(deps.shell.removeContainer).toHaveBeenCalledTimes(2)
    expect(deps.shell.waitForContainerNameRelease).toHaveBeenCalledTimes(2)
    expect(deps.shell.startContainer).toHaveBeenCalledWith(
      OPENCLAW_GATEWAY_CONTAINER_NAME,
    )
  })

  it('bounds gateway create retries when the name stays in use', async () => {
    const deps = createDeps()
    deps.shell.createContainer = mock(async () => {
      throw new ContainerNameInUseError(
        OPENCLAW_GATEWAY_CONTAINER_NAME,
        'nerdctl create',
        1,
        `name-store error\nname "${OPENCLAW_GATEWAY_CONTAINER_NAME}" is already used`,
      )
    })
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    await expect(runtime.startGateway(defaultSpec)).rejects.toBeInstanceOf(
      ContainerNameInUseError,
    )

    expect(deps.shell.createContainer).toHaveBeenCalledTimes(3)
    expect(deps.shell.removeContainer).toHaveBeenCalledTimes(3)
    expect(deps.shell.waitForContainerNameRelease).toHaveBeenCalledTimes(3)
    expect(deps.shell.startContainer).not.toHaveBeenCalled()
  })

  it('uses OPENCLAW_IMAGE as a direct image override', async () => {
    const previous = process.env.OPENCLAW_IMAGE
    process.env.OPENCLAW_IMAGE = 'localhost/openclaw:test'
    const deps = createDeps()
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    try {
      await runtime.startGateway(defaultSpec)
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_IMAGE
      else process.env.OPENCLAW_IMAGE = previous
    }

    expect(deps.loader.ensureImageLoaded).toHaveBeenCalledWith(
      'localhost/openclaw:test',
      undefined,
    )
    expect(deps.loader.ensureAgentImageLoaded).not.toHaveBeenCalled()
    expect(deps.shell.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'localhost/openclaw:test' }),
      undefined,
    )
  })

  it('passes private-ingress no-auth only when requested', async () => {
    const deps = createDeps()
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    await runtime.startGateway({
      ...defaultSpec,
      gatewayToken: undefined,
      privateIngressNoAuth: true,
    })

    expect(deps.shell.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_GATEWAY_PRIVATE_INGRESS_NO_AUTH: '1',
        }),
      }),
      undefined,
    )
  })

  it('delegates ensureReady and stopVm to VmRuntime', async () => {
    const deps = createDeps()
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    await runtime.ensureReady()
    await runtime.stopVm()

    expect(deps.vm.ensureReady).toHaveBeenCalled()
    expect(deps.vm.getDefaultGateway).toHaveBeenCalled()
    expect(deps.vm.stopVm).toHaveBeenCalled()
  })

  it('runs setup commands with guest paths', async () => {
    const deps = createDeps()
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    await runtime.runGatewaySetupCommand(
      ['node', 'dist/index.js', 'agents', 'list', '--json'],
      defaultSpec,
    )

    expect(deps.shell.runCommand).toHaveBeenCalledWith(
      expect.arrayContaining([
        'create',
        '--name',
        `${OPENCLAW_GATEWAY_CONTAINER_NAME}-setup`,
        '--env-file',
        '/mnt/browseros/vm/openclaw/.openclaw/.env',
        '-v',
        '/mnt/browseros/vm/openclaw:/home/node',
        '--add-host',
        'host.containers.internal:192.168.5.2',
        OPENCLAW_IMAGE,
      ]),
      undefined,
    )
    expect(deps.shell.runCommand).toHaveBeenCalledWith(
      ['start', '-a', `${OPENCLAW_GATEWAY_CONTAINER_NAME}-setup`],
      undefined,
    )
    expect(deps.shell.removeContainer).toHaveBeenCalledWith(
      `${OPENCLAW_GATEWAY_CONTAINER_NAME}-setup`,
      { force: true },
      undefined,
    )
    expect(deps.shell.waitForContainerNameRelease).toHaveBeenCalledWith(
      `${OPENCLAW_GATEWAY_CONTAINER_NAME}-setup`,
      OPENCLAW_NAME_RELEASE_WAIT,
    )
  })

  it('reconciles and retries when setup create reports name-in-use', async () => {
    const deps = createDeps()
    let setupCreateCount = 0
    deps.shell.runCommand = mock(async (args: string[]) => {
      if (args[0] === 'create') {
        setupCreateCount += 1
        if (setupCreateCount === 1) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: `name-store error\nname "${OPENCLAW_GATEWAY_CONTAINER_NAME}-setup" is already used`,
          }
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    await expect(
      runtime.runGatewaySetupCommand(
        ['node', 'dist/index.js', 'agents', 'list', '--json'],
        defaultSpec,
      ),
    ).resolves.toBe(0)

    expect(setupCreateCount).toBe(2)
    expect(deps.shell.waitForContainerNameRelease).toHaveBeenCalledTimes(2)
    expect(deps.shell.removeContainer).toHaveBeenCalledTimes(3)
  })

  it('tails and fetches gateway logs through the new transport', async () => {
    const deps = createDeps()
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    const stop = runtime.tailGatewayLogs(() => {})
    const logs = await runtime.getGatewayLogs(10)
    stop()

    expect(deps.shell.tailLogs).toHaveBeenCalledWith(
      OPENCLAW_GATEWAY_CONTAINER_NAME,
      expect.any(Function),
    )
    expect(deps.shell.runCommand).toHaveBeenCalledWith(
      ['logs', '-n', '10', OPENCLAW_GATEWAY_CONTAINER_NAME],
      expect.any(Function),
    )
    expect(logs).toEqual(['log line'])
  })

  it('prewarms the gateway image without creating a container', async () => {
    const deps = createDeps()
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    await runtime.prewarmGatewayImage()

    expect(deps.loader.ensureAgentImageLoaded).toHaveBeenCalledWith(
      'openclaw',
      undefined,
    )
    expect(deps.shell.createContainer).not.toHaveBeenCalled()
  })

  it('detects when the gateway container uses the current image', async () => {
    const deps = createDeps()
    deps.shell.containerImageRef.mockImplementation(async () => OPENCLAW_IMAGE)
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    await expect(runtime.isGatewayCurrent()).resolves.toBe(true)
    expect(deps.shell.containerImageRef).toHaveBeenCalledWith(
      OPENCLAW_GATEWAY_CONTAINER_NAME,
    )
  })

  it('treats a digest-qualified current image ref as current', async () => {
    const deps = createDeps()
    deps.shell.containerImageRef.mockImplementation(
      async () => `${OPENCLAW_IMAGE}@sha256:${'a'.repeat(64)}`,
    )
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    await expect(runtime.isGatewayCurrent()).resolves.toBe(true)
  })

  it('detects when the gateway container uses an old image', async () => {
    const deps = createDeps()
    deps.shell.containerImageRef.mockImplementation(
      async () => 'ghcr.io/openclaw/openclaw:old',
    )
    const runtime = new ContainerRuntime({
      vm: deps.vm,
      shell: deps.shell,
      loader: deps.loader,
      projectDir: PROJECT_DIR,
    })

    await expect(runtime.isGatewayCurrent()).resolves.toBe(false)
  })
})

function createDeps() {
  return {
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
      containerImageRef: mock(async () => OPENCLAW_IMAGE),
      waitForContainerNameRelease: mock(async () => {}),
      exec: mock(async () => 0),
      runCommand: mock(
        async (_args: string[], onLog?: (line: string) => void) => {
          onLog?.('log line')
          return { exitCode: 0, stdout: 'log line\n', stderr: '' }
        },
      ),
      tailLogs: mock(() => () => {}),
    },
    loader: {
      ensureImageLoaded: mock(async () => {}),
      ensureAgentImageLoaded: mock(async () => OPENCLAW_IMAGE),
    },
  }
}
