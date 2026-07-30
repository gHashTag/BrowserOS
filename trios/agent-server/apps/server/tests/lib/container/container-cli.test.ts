/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { ContainerCli } from '../../../src/lib/container/container-cli'
import {
  ContainerCliError,
  ContainerNameInUseError,
} from '../../../src/lib/vm/errors'
import { fakeSsh } from '../../__helpers__/fake-ssh'

describe('ContainerCli', () => {
  let tempDir: string
  let logPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp('/tmp/container-cli-')
    logPath = join(tempDir, 'ssh.log')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('checks image existence with nerdctl image inspect', async () => {
    const sshPath = await fakeSsh({}, logPath)
    const cli = await createCli(sshPath, tempDir)

    await expect(cli.imageExists('openclaw:v1')).resolves.toBe(true)

    const sshConfig = sshConfigPath(tempDir)
    await expect(readFile(logPath, 'utf8')).resolves.toContain(
      `${sshPrefix(sshConfig)} 'nerdctl' 'image' 'inspect' 'openclaw:v1'`,
    )
  })

  it('returns false when image inspect exits non-zero', async () => {
    const sshPath = await fakeSsh({ stderr: 'missing', exit: 1 }, logPath)
    const cli = await createCli(sshPath, tempDir)

    await expect(cli.imageExists('openclaw:v1')).resolves.toBe(false)
  })

  it('reads a container configured image ref', async () => {
    const sshPath = await fakeSsh(
      { stdout: 'ghcr.io/openclaw/openclaw:2026.4.12\n' },
      logPath,
    )
    const cli = await createCli(sshPath, tempDir)

    await expect(cli.containerImageRef('gateway')).resolves.toBe(
      'ghcr.io/openclaw/openclaw:2026.4.12',
    )

    await expect(readFile(logPath, 'utf8')).resolves.toContain(
      `${sshPrefix(sshConfigPath(tempDir))} 'nerdctl' 'inspect' '--format' '{{.Config.Image}}' 'gateway'`,
    )
  })

  it('returns null when reading a missing container image ref', async () => {
    const sshPath = await fakeSsh(
      {
        stderr: 'no such container',
        exit: 1,
      },
      logPath,
    )
    const cli = await createCli(sshPath, tempDir)

    await expect(cli.containerImageRef('missing')).resolves.toBeNull()
  })

  it('pulls images with progress and throws typed command errors', async () => {
    const sshPath = await fakeSsh(
      { stdout: 'pulling\n', stderr: 'denied', exit: 2 },
      logPath,
    )
    const cli = await createCli(sshPath, tempDir)
    const lines: string[] = []

    const error = await cli
      .pullImage('openclaw:v1', (line) => lines.push(line))
      .catch((err) => err)

    expect(error).toBeInstanceOf(ContainerCliError)
    expect(error.exitCode).toBe(2)
    expect(error.stderr).toBe('denied')
    expect(lines).toContain('pulling')
    expect(lines).toContain('denied')
  })

  it('creates containers from typed specs', async () => {
    const sshPath = await fakeSsh({}, logPath)
    const cli = await createCli(sshPath, tempDir)

    await cli.createContainer({
      name: 'gateway',
      image: 'openclaw:v1',
      restart: 'unless-stopped',
      ports: [{ hostIp: '127.0.0.1', hostPort: 18789, containerPort: 18789 }],
      envFile: '/mnt/browseros/vm/openclaw/.env',
      env: { HOME: '/home/node', NODE_ENV: 'production' },
      mounts: [
        {
          source: '/mnt/browseros/vm/openclaw',
          target: '/home/node',
          readonly: true,
        },
      ],
      addHosts: ['host.containers.internal:192.168.5.2'],
      health: {
        cmd: 'curl -sf http://127.0.0.1:18789/healthz',
        interval: '30s',
        timeout: '10s',
        retries: 3,
      },
      command: ['node', 'dist/index.js', 'gateway'],
    })

    await expect(readFile(logPath, 'utf8')).resolves.toContain(
      [
        `${sshPrefix(sshConfigPath(tempDir))} 'nerdctl' 'create'`,
        "'--name' 'gateway'",
        "'--restart' 'unless-stopped'",
        "'-p' '127.0.0.1:18789:18789'",
        "'--env-file' '/mnt/browseros/vm/openclaw/.env'",
        "'-e' 'HOME=/home/node'",
        "'-e' 'NODE_ENV=production'",
        "'-v' '/mnt/browseros/vm/openclaw:/home/node:ro'",
        "'--add-host' 'host.containers.internal:192.168.5.2'",
        "'--health-cmd' 'curl -sf http://127.0.0.1:18789/healthz'",
        "'--health-interval' '30s'",
        "'--health-timeout' '10s'",
        "'--health-retries' '3'",
        "'openclaw:v1' 'node' 'dist/index.js' 'gateway'",
      ].join(' '),
    )
  })

  it('starts, stops, removes, execs, and lists containers', async () => {
    const sshPath = await fakeSsh({ stdout: 'gateway\nworker\n' }, logPath)
    const cli = await createCli(sshPath, tempDir)

    await cli.startContainer('gateway')
    await cli.stopContainer('gateway')
    await cli.removeContainer('gateway', { force: true })
    await expect(cli.exec('gateway', ['node', '--version'])).resolves.toBe(0)
    await expect(cli.ps({ namesOnly: true })).resolves.toEqual([
      'gateway',
      'worker',
    ])

    const log = await readFile(logPath, 'utf8')
    expect(log).toContain("lima-browseros-vm 'nerdctl' 'start' 'gateway'")
    expect(log).toContain("lima-browseros-vm 'nerdctl' 'stop' 'gateway'")
    expect(log).toContain("lima-browseros-vm 'nerdctl' 'rm' '-f' 'gateway'")
    expect(log).toContain(
      "lima-browseros-vm 'nerdctl' 'exec' 'gateway' 'node' '--version'",
    )
    expect(log).toContain(
      "lima-browseros-vm 'nerdctl' 'ps' '--format' '{{.Names}}'",
    )
  })

  it('inspects a container by name', async () => {
    const sshPath = await fakeSsh(
      {
        stdout: JSON.stringify({
          ID: 'abc123',
          Name: 'gateway',
          Config: { Image: 'openclaw:v1' },
          State: { Status: 'running', Running: true },
        }),
      },
      logPath,
    )
    const cli = await createCli(sshPath, tempDir)

    await expect(cli.inspectContainer('gateway')).resolves.toEqual({
      id: 'abc123',
      name: 'gateway',
      image: 'openclaw:v1',
      status: 'running',
      running: true,
    })

    await expect(readFile(logPath, 'utf8')).resolves.toContain(
      "lima-browseros-vm 'nerdctl' 'container' 'inspect' '--format' '{{json .}}' 'gateway'",
    )
  })

  it('returns null when inspected containers are absent', async () => {
    const sshPath = await fakeSsh(
      { stderr: 'no such container', exit: 1 },
      logPath,
    )
    const cli = await createCli(sshPath, tempDir)

    await expect(cli.inspectContainer('gateway')).resolves.toBeNull()
  })

  it('does not treat unrelated not found errors as absent containers', async () => {
    const sshPath = await fakeSsh(
      { stderr: 'network interface not found', exit: 1 },
      logPath,
    )
    const cli = await createCli(sshPath, tempDir)

    await expect(cli.inspectContainer('gateway')).rejects.toBeInstanceOf(
      ContainerCliError,
    )
  })

  it('waits until a container name is no longer resolvable', async () => {
    const sshPath = await fakeSshContainerExistsThenMissing(tempDir, logPath)
    const cli = await createCli(sshPath, tempDir)

    await expect(
      cli.waitForContainerNameRelease('gateway', {
        timeoutMs: 500,
        intervalMs: 5,
      }),
    ).resolves.toBeUndefined()

    const inspectCalls = (await readFile(logPath, 'utf8'))
      .split('\n')
      .filter((line) => line.includes("'container' 'inspect'"))
    expect(inspectCalls).toHaveLength(2)
  })

  it('classifies create name-store collisions as name-in-use errors', async () => {
    const sshPath = await fakeSsh(
      {
        stderr:
          'name-store error\nname "gateway" is already used by ID "abc123"',
        exit: 1,
      },
      logPath,
    )
    const cli = await createCli(sshPath, tempDir)

    const error = await cli
      .createContainer({ name: 'gateway', image: 'openclaw:v1' })
      .catch((err) => err)

    expect(error).toBeInstanceOf(ContainerNameInUseError)
    expect(error.containerName).toBe('gateway')
    expect(error.stderr).toContain('name "gateway" is already used')
  })

  it('tolerates removal when the container is already absent', async () => {
    const sshPath = await fakeSsh(
      { stderr: 'no such container', exit: 1 },
      logPath,
    )
    const cli = await createCli(sshPath, tempDir)

    await expect(cli.removeContainer('gateway', { force: true })).resolves.toBe(
      undefined,
    )
  })

  it('tails logs and returns a stop handle', async () => {
    const sshPath = await fakeSsh({ stdout: 'line\n' }, logPath)
    const cli = await createCli(sshPath, tempDir)
    const lines: string[] = []

    const stop = cli.tailLogs('gateway', (line) => lines.push(line))
    for (let attempts = 0; attempts < 50 && lines.length === 0; attempts += 1) {
      await Bun.sleep(10)
    }
    stop()

    expect(lines).toEqual(['line'])
    await expect(readFile(logPath, 'utf8')).resolves.toContain(
      `${sshPrefix(sshConfigPath(tempDir))} 'nerdctl' 'logs' '-f' '-n' '0' 'gateway'`,
    )
  })
})

async function createCli(
  sshPath: string,
  tempDir: string,
): Promise<ContainerCli> {
  const configPath = sshConfigPath(tempDir)
  await mkdir(join(tempDir, 'lima', 'browseros-vm'), { recursive: true })
  await writeFile(configPath, '')
  return new ContainerCli({
    limactlPath: 'unused',
    limaHome: join(tempDir, 'lima'),
    sshPath,
    vmName: 'browseros-vm',
  })
}

function sshConfigPath(tempDir: string): string {
  return join(tempDir, 'lima', 'browseros-vm', 'ssh.config')
}

function sshPrefix(configPath: string): string {
  return `ARGS:-F ${configPath} lima-browseros-vm`
}

async function fakeSshContainerExistsThenMissing(
  tempDir: string,
  logPath: string,
): Promise<string> {
  const path = join(tempDir, 'ssh-container-exists-then-missing')
  const counterPath = join(tempDir, 'ssh-container-exists-then-missing.count')
  const body = `#!/usr/bin/env bash
set -u
echo "ARGS:$*" >> "${logPath}"
count="$(cat "${counterPath}" 2>/dev/null || echo 0)"
next=$((count + 1))
printf '%s' "$next" > "${counterPath}"
case "$count" in
  0)
    printf '{"ID":"abc123","Name":"gateway","Config":{"Image":"openclaw:v1"},"State":{"Status":"exited","Running":false}}'
    exit 0
    ;;
  *)
    echo "no such container" >&2
    exit 1
    ;;
esac
`
  await writeFile(path, body)
  await chmod(path, 0o755)
  return path
}
