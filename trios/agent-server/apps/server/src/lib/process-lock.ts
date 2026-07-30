/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'

const DEFAULT_STALE_MS = 60_000
const DEFAULT_UPDATE_MS = 15_000
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_RETRY_MIN_TIMEOUT_MS = 100
const DEFAULT_RETRY_MAX_TIMEOUT_MS = 1_000

export interface ProcessLockOptions {
  lockDir: string
  staleMs?: number
  updateMs?: number
  timeoutMs?: number
  retryMinTimeoutMs?: number
  retryMaxTimeoutMs?: number
  randomize?: boolean
}

export class ProcessLockTimeoutError extends Error {
  constructor(
    public readonly lockName: string,
    public readonly lockPath: string,
    public readonly timeoutMs: number,
    public override readonly cause?: unknown,
  ) {
    super(
      `Timed out acquiring process lock "${lockName}" at ${lockPath} after ${timeoutMs}ms`,
    )
    this.name = 'ProcessLockTimeoutError'
  }
}

/** Run a critical section while holding a named lock shared across processes. */
export async function withProcessLock<T>(
  name: string,
  options: ProcessLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireProcessLock(name, options)
  try {
    return await fn()
  } finally {
    await release()
  }
}

export function resolveProcessLockPath(lockDir: string, name: string): string {
  return join(lockDir, `${sanitizeLockName(name)}.lock`)
}

async function acquireProcessLock(
  name: string,
  options: ProcessLockOptions,
): Promise<() => Promise<void>> {
  await mkdir(options.lockDir, { recursive: true })

  const lockPath = resolveProcessLockPath(options.lockDir, name)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retryMinTimeoutMs =
    options.retryMinTimeoutMs ?? DEFAULT_RETRY_MIN_TIMEOUT_MS
  const retryMaxTimeoutMs =
    options.retryMaxTimeoutMs ?? DEFAULT_RETRY_MAX_TIMEOUT_MS
  const startedAt = Date.now()
  let lastError: unknown

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await lockfile.lock(lockPath, {
        lockfilePath: lockPath,
        realpath: false,
        stale: options.staleMs ?? DEFAULT_STALE_MS,
        update: options.updateMs ?? DEFAULT_UPDATE_MS,
        // The wrapper owns retry/backoff so acquisition respects timeoutMs.
        retries: 0,
      })
    } catch (err) {
      if (!isLockedError(err)) throw err
      lastError = err
    }

    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) break
    await Bun.sleep(
      Math.min(
        remainingMs,
        nextRetryDelay(retryMinTimeoutMs, retryMaxTimeoutMs, options.randomize),
      ),
    )
  }

  throw new ProcessLockTimeoutError(name, lockPath, timeoutMs, lastError)
}

function sanitizeLockName(name: string): string {
  const safeName = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  if (!safeName) throw new Error('Process lock name must not be empty')
  return safeName
}

function isLockedError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'ELOCKED'
  )
}

function nextRetryDelay(
  minTimeoutMs: number,
  maxTimeoutMs: number,
  randomize = true,
): number {
  if (maxTimeoutMs <= minTimeoutMs) return minTimeoutMs
  if (!randomize) return minTimeoutMs
  return (
    minTimeoutMs + Math.floor(Math.random() * (maxTimeoutMs - minTimeoutMs))
  )
}
