/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { accessSync, constants, existsSync } from 'node:fs'
import { homedir, arch as osArch } from 'node:os'
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { PATHS } from '@browseros/shared/constants/paths'

export const VM_NAME = 'browseros-vm'
export const GUEST_VM_STATE = '/mnt/browseros/vm'
const HOST_LIMACTL_BINARY = 'limactl'

export type Arch = 'arm64' | 'x64'

function rootDir(): string {
  const override = process.env.BROWSEROS_DIR?.trim()
  if (override) {
    return override
  }
  const base =
    process.env.NODE_ENV === 'development'
      ? PATHS.DEV_BROWSEROS_DIR_NAME
      : PATHS.BROWSEROS_DIR_NAME
  return join(homedir(), base)
}

export function detectArch(arch: NodeJS.Architecture = osArch()): Arch {
  if (arch === 'arm64') return 'arm64'
  if (arch === 'x64') return 'x64'
  throw new Error(`unsupported host arch: ${arch}`)
}

export function getLimaHomeDir(browserosRoot = rootDir()): string {
  return join(browserosRoot, 'lima')
}

export function getVmStateDir(browserosRoot = rootDir()): string {
  return join(browserosRoot, 'vm')
}

export function getVmCacheDir(browserosRoot = rootDir()): string {
  return join(browserosRoot, PATHS.CACHE_DIR_NAME, 'vm')
}

export function getContainerdSocketPath(browserosRoot = rootDir()): string {
  return join(getLimaHomeDir(browserosRoot), VM_NAME, 'sock', 'containerd.sock')
}

export function getLimaSocketPath(browserosRoot = rootDir()): string {
  return getContainerdSocketPath(browserosRoot)
}

export function getLimaSshConfigPath(limaHome: string, name: string): string {
  return join(limaHome, name, 'ssh.config')
}

export function compressedDiskPath(
  version: string,
  arch: Arch,
  browserosRoot = rootDir(),
): string {
  return join(
    getVmCacheDir(browserosRoot),
    `browseros-vm-${version}-${arch}.qcow2.zst`,
  )
}

export function decompressedDiskPath(
  version: string,
  arch: Arch,
  browserosRoot = rootDir(),
): string {
  return join(
    getVmCacheDir(browserosRoot),
    `browseros-vm-${version}-${arch}.qcow2`,
  )
}

export function resolveBundledLimactl(
  resourcesDir: string,
  hostArch: Arch = detectArch(),
): string {
  if (usesHostVmTools()) return resolveHostLimactl()

  const limaRoot = resolveBundledLimaRoot(resourcesDir)
  const candidate = join(limaRoot, 'bin', 'limactl')
  if (!existsSync(candidate)) {
    throw new Error(
      `bundled limactl not found at ${candidate}; refresh server resources from the build-tools README`,
    )
  }
  assertBundledLimaGuestAgent(limaRoot, hostArch)
  return candidate
}

function resolveBundledLimaRoot(resourcesDir: string): string {
  return join(resourcesDir, 'bin', 'third_party', 'lima')
}

function nativeLinuxGuestAgentName(arch: Arch): string {
  return arch === 'arm64'
    ? 'lima-guestagent.Linux-aarch64.gz'
    : 'lima-guestagent.Linux-x86_64.gz'
}

function assertBundledLimaGuestAgent(limaRoot: string, hostArch: Arch): void {
  const guestAgent = join(
    limaRoot,
    'share',
    'lima',
    nativeLinuxGuestAgentName(hostArch),
  )
  if (!existsSync(guestAgent)) {
    throw new Error(
      `bundled Lima guest agent not found at ${guestAgent}; upload Lima runtime files and refresh server resources`,
    )
  }
}

function resolveHostLimactl(): string {
  const resolved = findExecutableOnPath(HOST_LIMACTL_BINARY)
  if (resolved) return resolved
  throw new Error(
    'Lima is not installed or limactl is not on PATH. Install with brew install lima.',
  )
}

export function resolveBundledLimaTemplate(resourcesDir: string): string {
  if (usesHostVmTools()) {
    const sourceTemplate = findSourceLimaTemplate(resourcesDir)
    if (sourceTemplate) return sourceTemplate
  }

  const candidate = join(resourcesDir, 'vm', 'browseros-vm.yaml')
  if (!existsSync(candidate)) {
    throw new Error(
      `bundled Lima template not found at ${candidate}; refresh server resources from the build-tools README`,
    )
  }
  return candidate
}

function usesHostVmTools(): boolean {
  return (
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
  )
}

function findExecutableOnPath(binary: string): string | null {
  const pathEnv = process.env.PATH
  if (!pathEnv) return null
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, binary)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

function findSourceLimaTemplate(resourcesDir: string): string | null {
  let current = resolve(resourcesDir)
  while (true) {
    const rootCandidate = join(
      current,
      'packages',
      'build-tools',
      'template',
      'browseros-vm.yaml',
    )
    if (existsSync(rootCandidate)) return rootCandidate

    const packageCandidate = join(
      current,
      'build-tools',
      'template',
      'browseros-vm.yaml',
    )
    if (existsSync(packageCandidate)) return packageCandidate

    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function hostPathToGuest(
  hostPath: string,
  browserosRoot = rootDir(),
): string {
  const vmState = getVmStateDir(browserosRoot)
  const vmStateRelative = mountedRelativePath(vmState, hostPath)
  if (vmStateRelative !== null)
    return guestPath(GUEST_VM_STATE, vmStateRelative)

  throw new Error(`host path ${hostPath} is not under any known guest mount`)
}

function mountedRelativePath(parent: string, child: string): string | null {
  const path = relative(parent, child)
  if (path === '') return ''
  if (path.startsWith('..') || isAbsolute(path)) return null
  return path
}

function guestPath(root: string, relativePath: string): string {
  if (!relativePath) return root
  return `${root}/${relativePath.split(sep).join('/')}`
}
