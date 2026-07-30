/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ProcessLockTimeoutError,
  resolveProcessLockPath,
  withProcessLock,
} from '../../src/lib/process-lock'

describe('process-lock', () => {
  let tempDir: string
  let lockDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'process-lock-'))
    lockDir = join(tempDir, '.locks')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('serializes concurrent callers for the same lock name', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = withProcessLock(
      'openclaw-lifecycle',
      { lockDir },
      async () => {
        events.push('first:start')
        await firstMayFinish
        events.push('first:end')
      },
    )

    while (!events.includes('first:start')) await Bun.sleep(1)

    const second = withProcessLock(
      'openclaw-lifecycle',
      {
        lockDir,
        retryMinTimeoutMs: 5,
        retryMaxTimeoutMs: 5,
      },
      async () => {
        events.push('second')
      },
    )

    await Bun.sleep(25)
    expect(events).toEqual(['first:start'])

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second'])
  })

  it('releases the lock when the callback throws', async () => {
    await expect(
      withProcessLock('openclaw-lifecycle', { lockDir }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await expect(
      withProcessLock('openclaw-lifecycle', { lockDir }, async () => 'ok'),
    ).resolves.toBe('ok')
  })

  it('fails with a structured timeout error when acquisition takes too long', async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = withProcessLock(
      'openclaw-lifecycle',
      { lockDir },
      async () => {
        await firstMayFinish
      },
    )

    await Bun.sleep(10)

    try {
      await expect(
        withProcessLock(
          'openclaw-lifecycle',
          {
            lockDir,
            timeoutMs: 25,
            retryMinTimeoutMs: 5,
            retryMaxTimeoutMs: 5,
          },
          async () => undefined,
        ),
      ).rejects.toBeInstanceOf(ProcessLockTimeoutError)
    } finally {
      releaseFirst()
      await first
    }
  })

  it('sanitizes lock names into the lock directory', async () => {
    const path = resolveProcessLockPath(lockDir, '../OpenClaw Lifecycle!')

    expect(path).toBe(join(lockDir, 'OpenClaw-Lifecycle.lock'))

    await withProcessLock(
      '../OpenClaw Lifecycle!',
      { lockDir },
      async () => undefined,
    )

    const entries = await readdir(lockDir)
    expect(entries).not.toContain('..')
  })
})
