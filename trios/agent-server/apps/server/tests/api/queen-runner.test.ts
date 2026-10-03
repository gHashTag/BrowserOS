/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The parts of the handover that are this code's own logic rather than
 * PostgreSQL's. Whether two runners can take one order is the database's answer
 * and is asked of a real one in tests/pglive/queen-runner-live.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { importRunnerBranch } from '../../src/api/routes/queen-export'
import {
  RUNNER_SILENT_MINUTES,
  reapStalledDispatches,
  workerProviderForKeyIndex,
} from '../../src/api/services/queen-dispatch'
import {
  runnerName,
  runnerSlots,
  waitForEnding,
} from '../../src/api/services/queen-runner'

/** A database that returns the given rows to the reaper's SELECT and records everything. */
function reaperPool(rows: Array<{ issue: number; queued_at: Date | null }>) {
  const asked: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      asked.push({ sql: String(sql), params })
      if (
        String(sql).startsWith('SELECT issue, queued_at FROM queen_dispatch')
      ) {
        return { rowCount: rows.length, rows }
      }
      return {
        rowCount: rows.length,
        rows: rows.map(({ issue }) => ({ issue })),
      }
    },
  } as unknown as Pool
  return { pool, asked }
}

describe('the stall reaper and bees that run elsewhere', () => {
  it('releases a runner bee without reaching for a worktree this disk does not have', async () => {
    // #7 ran here; #8 was an order a runner took. Both are past the line.
    const { pool, asked } = reaperPool([
      { issue: 7, queued_at: null },
      { issue: 8, queued_at: new Date() },
    ])
    const salvaged: number[] = []
    const released = await reapStalledDispatches(pool, 120, {
      salvage: async (_pool, issue) => {
        salvaged.push(issue)
        return {
          committed: false,
          detail: 'nothing',
          left: [],
          sha: null,
          files: [],
        } as never
      },
    })
    // Both rows are released - a dead runner's issue must go back to the swarm
    // - but only the bee that ran HERE is salvaged: git on the other one's
    // worktree would be git on a directory that does not exist.
    expect(salvaged).toEqual([7])
    expect(released).toEqual([7, 8])
    const release = asked.find((q) => q.sql.includes('UPDATE queen_dispatch'))
    expect(release?.params).toEqual([120, [7, 8], RUNNER_SILENT_MINUTES])
  })

  it('counts a runner that stopped vouching as dead long before two hours', () => {
    // Forty missed renewals at fifteen seconds each. Not a slow network.
    expect(RUNNER_SILENT_MINUTES).toBeGreaterThanOrEqual(5)
    expect(RUNNER_SILENT_MINUTES).toBeLessThan(120)
  })
})

describe('a runner vouching for its bee', () => {
  it('renews its claim until the row stops matching, then stops', async () => {
    const asked: Array<{ sql: string; params: unknown[] }> = []
    let alive = 3
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        asked.push({ sql: String(sql), params })
        alive -= 1
        // Three renewals find the row; then the drain writes the ending and
        // the renewal matches nothing.
        return alive > 0 ? { rows: [{ issue: 9 }] } : { rows: [] }
      },
    } as unknown as Pool
    await waitForEnding(
      pool,
      {
        issue: 9,
        branch: 'queen-9',
        brief: '',
        ownedPaths: [],
        conversationId: 'conv-9',
        keyIndex: 0,
      },
      'runner-a',
      1,
    )
    expect(asked).toHaveLength(3)
    for (const q of asked) {
      expect(q.sql).toContain('SET claimed_at = now()')
      // Only its OWN claim, on its own turn: a re-dispatched issue belongs to
      // whoever claimed the new order.
      expect(q.params).toEqual([9, 'conv-9', 'runner-a'])
    }
  })

  it('keeps vouching through a database that blips', async () => {
    let calls = 0
    const pool = {
      query: async () => {
        calls += 1
        if (calls === 1) throw new Error('Connection terminated unexpectedly')
        return { rows: [] }
      },
    } as unknown as Pool
    await waitForEnding(
      pool,
      {
        issue: 10,
        branch: 'queen-10',
        brief: '',
        ownedPaths: [],
        conversationId: 'conv-10',
        keyIndex: 0,
      },
      'runner-a',
      1,
    )
    // One failed renewal is not a dead runner; it tried again.
    expect(calls).toBe(2)
  })
})

describe('what a runner calls itself and how much it carries', () => {
  it('says who it is, and carries one bee unless told otherwise', () => {
    const previous = {
      name: process.env.TRIOS_BEE_RUNNER_NAME,
      slots: process.env.TRIOS_BEE_RUNNER_SLOTS,
    }
    try {
      delete process.env.TRIOS_BEE_RUNNER_NAME
      delete process.env.TRIOS_BEE_RUNNER_SLOTS
      expect(runnerName()).toContain(String(process.pid))
      expect(runnerSlots()).toBe(1)
      process.env.TRIOS_BEE_RUNNER_NAME = 'replica-3'
      process.env.TRIOS_BEE_RUNNER_SLOTS = '4'
      expect(runnerName()).toBe('replica-3')
      expect(runnerSlots()).toBe(4)
      for (const bad of ['0', '-2', 'many', '1.5']) {
        process.env.TRIOS_BEE_RUNNER_SLOTS = bad
        expect(runnerSlots()).toBe(1)
      }
      process.env.TRIOS_BEE_RUNNER_SLOTS = '1000'
      expect(runnerSlots()).toBe(64)
    } finally {
      if (previous.name === undefined) delete process.env.TRIOS_BEE_RUNNER_NAME
      else process.env.TRIOS_BEE_RUNNER_NAME = previous.name
      if (previous.slots === undefined)
        delete process.env.TRIOS_BEE_RUNNER_SLOTS
      else process.env.TRIOS_BEE_RUNNER_SLOTS = previous.slots
    }
  })
})

describe('a runner resolves an order the way the Queen allocated it', () => {
  const names = [
    'TRIOS_QUEEN_WORKER_BASE_URL',
    'TRIOS_QUEEN_WORKER_PROVIDER',
    'TRIOS_QUEEN_WORKER_MODEL',
    'TRIOS_QUEEN_WORKER_API_KEY',
    'TRIOS_QUEEN_WORKER_API_KEY_2',
  ]
  const saved = new Map<string, string | undefined>()
  beforeEach(() => {
    for (const name of names) saved.set(name, process.env[name])
    process.env.TRIOS_QUEEN_WORKER_BASE_URL =
      'https://integrate.api.nvidia.com/v1'
    process.env.TRIOS_QUEEN_WORKER_PROVIDER = 'openai-compatible'
    process.env.TRIOS_QUEEN_WORKER_MODEL = 'pool-model'
    process.env.TRIOS_QUEEN_WORKER_API_KEY = 'env-key-a'
    process.env.TRIOS_QUEEN_WORKER_API_KEY_2 = 'env-key-b'
  })
  afterEach(() => {
    for (const name of names) {
      const value = saved.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const runtime = {
    managed: [
      {
        id: -2,
        provider: 'nvidia' as const,
        model: 'owner-model',
        apiKey: 'managed-key',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
      },
    ],
    disabled: [0],
    models: { 1: 'owner-model' },
  }
  it('finds a managed key, applies the owner model and refuses a disabled key', () => {
    expect(workerProviderForKeyIndex(-2, runtime)).toMatchObject({
      apiKey: 'managed-key',
      model: 'owner-model',
      keyIndex: -2,
    })
    expect(workerProviderForKeyIndex(1, runtime)).toMatchObject({
      apiKey: 'env-key-b',
      model: 'owner-model',
      keyIndex: 1,
    })
    expect(workerProviderForKeyIndex(0, runtime)).toBeNull()
    expect(workerProviderForKeyIndex(-9, runtime)).toBeNull()
  })
  it('without the registry, reads the environment exactly as before', () => {
    expect(workerProviderForKeyIndex(0)).toMatchObject({
      apiKey: 'env-key-a',
      model: 'pool-model',
    })
    expect(
      workerProviderForKeyIndex(0, { managed: [], disabled: [], models: {} }),
    ).toMatchObject({ apiKey: 'env-key-a', model: 'pool-model' })
  })
})

describe('the Queen brings a runner branch into her checkout before judging it', () => {
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim()
  let scratch = ''
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'queen-import-'))
    for (const name of [
      'WORKSPACE_DIR',
      'TRIOS_REPO_URL',
      'TRIOS_TOOL_SHELL_USER',
    ])
      saved[name] = process.env[name]
    delete process.env.TRIOS_TOOL_SHELL_USER
    // origin, the Queen's checkout, and a runner's checkout of the same repo.
    execFileSync('git', ['init', '-q', '-b', 'master', join(scratch, 'origin')])
    sh(join(scratch, 'origin'), 'commit', '-q', '--allow-empty', '-m', 'base')
    execFileSync('git', [
      'clone',
      '-q',
      join(scratch, 'origin'),
      join(scratch, 'ws', 't27'),
    ])
    execFileSync('git', [
      'clone',
      '-q',
      join(scratch, 'origin'),
      join(scratch, 'runner'),
    ])
    process.env.WORKSPACE_DIR = join(scratch, 'ws')
    process.env.TRIOS_REPO_URL = 'https://github.com/gHashTag/t27.git'
  })
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(scratch, { recursive: true, force: true })
  })
  /** The runner's work after the origin moved on, as `queen_bundle` would hold it. */
  const runnerBundle = () => {
    const origin = join(scratch, 'origin')
    sh(origin, 'commit', '-q', '--allow-empty', '-m', 'master moved')
    const runner = join(scratch, 'runner')
    sh(runner, 'fetch', '-q', 'origin')
    sh(runner, 'checkout', '-q', '-b', 'queen-7', 'origin/master')
    sh(runner, 'commit', '-q', '--allow-empty', '-m', 'bee work')
    const file = join(scratch, 'b.bundle')
    sh(runner, 'bundle', 'create', file, 'origin/master..queen-7')
    return {
      bytes: readFileSync(file),
      head: sh(runner, 'rev-parse', 'queen-7'),
    }
  }
  const poolWith = (bytes: Buffer | null) =>
    ({
      query: async () => ({ rows: bytes ? [{ bytes }] : [] }),
    }) as unknown as Pick<Pool, 'query'>
  it('imports the branch even when the runner cut from a base this checkout has not fetched', async () => {
    const { bytes, head } = runnerBundle()
    const queen = join(scratch, 'ws', 't27')
    expect(await importRunnerBranch(poolWith(bytes), 7)).toEqual({
      ok: true,
      imported: true,
    })
    expect(sh(queen, 'rev-parse', 'queen-7')).toBe(head)
    // Already here: nothing to do the second time.
    expect(await importRunnerBranch(poolWith(bytes), 7)).toEqual({
      ok: true,
      imported: false,
    })
    // No bundle: a bee that ran here, untouched.
    expect(await importRunnerBranch(poolWith(null), 8)).toEqual({
      ok: true,
      imported: false,
    })
  })
  it('replaces an earlier attempt whose worktree still holds the branch', async () => {
    const queen = join(scratch, 'ws', 't27')
    sh(
      queen,
      'worktree',
      'add',
      '-q',
      '-b',
      'queen-7',
      join(queen, '.worktrees', 'queen-7'),
      'master',
    )
    const { bytes, head } = runnerBundle()
    expect(await importRunnerBranch(poolWith(bytes), 7)).toEqual({
      ok: true,
      imported: true,
    })
    expect(sh(queen, 'rev-parse', 'queen-7')).toBe(head)
  })
})
