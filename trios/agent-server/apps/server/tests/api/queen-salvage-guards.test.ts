/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * WHAT THE SALVAGE MUST REFUSE, AND WHAT IT MUST NOT SPEND.
 *
 * The salvage commit exists because a killed turn's work was invisible to the
 * review: 38 of 43 re-reviewed dispatches had committed nothing, while 116
 * dispatches in the same 24 hours found "N uncommitted file(s) left by a
 * previous attempt" in the worktree. Committing that work is the repair. This
 * file guards the cases where the repair, written naively, is worse than the
 * defect:
 *
 *   - it commits under a bee that is still running, and the index lock kills
 *     whichever `git commit` loses - which is the very work it exists to save;
 *   - it reaps a bee the first round dispatched while it was busy salvaging;
 *   - it loses every good file because one path vanished, or half a rename;
 *   - it charges a quota window's dead turn against the ISSUE's send-backs;
 *   - it says the container wrote work the bee wrote, for ever after, and says
 *     it where the 1500-character note cap cuts it off.
 *
 * Each case below fails on the code as it stood before the guard it names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Pool } from 'pg'
import {
  clearBeeRunningHere,
  closeDispatch,
  markBeeRunningHere,
  prepareWorktree,
  reapDispatchesFromPreviousBoot,
  reapStalledDispatches,
  reapWorktrees,
  recordDispatch,
  salvageDispatch,
  salvageWorktree,
} from '../../src/api/services/queen-dispatch'
import {
  noteWithSalvage,
  reviewFinishedDispatches,
} from '../../src/api/services/queen-tick'
import { resolveQueendPath } from '../__helpers__/queend-path'

const queendPresent = existsSync(resolveQueendPath())

const REAL_GIT = Bun.which('git') || '/usr/bin/git'
const ISSUE = 1627

/** The policy binary, when this machine has one: the verdict is its decision. */
const QUEEND = [
  join(import.meta.dir, '../../../../queen-core/.build/release/queend'),
  '/usr/local/bin/queend',
].find(existsSync)

function git(cwd: string, args: string[]): string {
  const done = Bun.spawnSync([REAL_GIT, ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  const out = `${done.stdout.toString()}${done.stderr.toString()}`.trim()
  if ((done.exitCode ?? -1) !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${out}`)
  }
  return out
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

const ENV_KEYS = [
  'WORKSPACE_DIR',
  'TRIOS_REPO_REF',
  'TRIOS_REPO_URL',
  'TRIOS_REPO_SUBDIR',
  'TRIOS_MODULE_STORE',
  'GIT_CONFIG_GLOBAL',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'TRIOS_QUEEND_PATH',
]
const saved: Record<string, string | undefined> = {}

interface Fixture {
  scratch: string
  root: string
  worktree: string
  head: () => string[]
}

/** The deployment in miniature, cut by `prepareWorktree` itself. */
async function fixture(issue = ISSUE): Promise<Fixture> {
  const scratch = mkdtempSync(join(tmpdir(), 'queen-salvage-guard-'))
  const origin = join(scratch, 'origin.git')
  git(scratch, ['init', '-q', '--bare', 'origin.git'])

  const seed = join(scratch, 'seed')
  mkdirSync(seed)
  git(seed, ['init', '-q', '-b', 'dev'])
  git(seed, ['config', 'user.email', 'bee@example.com'])
  git(seed, ['config', 'user.name', 'Bee'])
  write(join(seed, 'README.md'), 'the root of the checkout\n')
  write(join(seed, 'trios/docs/keep.md'), 'one line\n')
  git(seed, ['add', '.'])
  git(seed, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'first'])
  git(seed, ['push', '-q', origin, 'dev'])
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/dev'])

  const root = join(scratch, 'BrowserOS')
  git(scratch, ['clone', '-q', origin, 'BrowserOS'])

  process.env.WORKSPACE_DIR = scratch
  process.env.TRIOS_REPO_REF = 'origin/dev'
  delete process.env.TRIOS_REPO_URL
  delete process.env.TRIOS_REPO_SUBDIR
  process.env.TRIOS_MODULE_STORE = join(scratch, 'no-such-store')
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  delete process.env.GIT_AUTHOR_NAME
  delete process.env.GIT_AUTHOR_EMAIL

  const cut = await prepareWorktree(issue, { volumeUsed: () => 10 })
  expect(cut.ok).toBe(true)
  return {
    scratch,
    root,
    worktree: cut.path,
    head: () =>
      git(cut.path, ['ls-tree', '-r', '--name-only', 'HEAD'])
        .split('\n')
        .filter((l) => l.trim().length > 0),
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  if (QUEEND) process.env.TRIOS_QUEEND_PATH = QUEEND
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  clearBeeRunningHere(ISSUE, 'conv-live')
})

// ---------------------------------------------------------------------------
// Never against a bee that is still running.
// ---------------------------------------------------------------------------

/** A pool whose dispatch row belongs to `conversation`. */
function rowPool(conversation: string, ownedPaths = ['trios/docs']) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      queries.push({ sql: text, params })
      if (text.includes('SELECT owned_paths, conversation_id')) {
        // Postgres, in miniature: the predicate is read from the STATEMENT, so
        // a guard the SQL does not carry is a guard this pool does not apply.
        const guarded = text.includes('conversation_id::text = $2::text')
        const wanted = params[1] == null ? null : String(params[1])
        if (guarded && wanted !== null && wanted !== conversation) {
          return { rowCount: 0, rows: [] }
        }
        return {
          rowCount: 1,
          rows: [{ owned_paths: ownedPaths, conversation_id: conversation }],
        }
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, queries }
}

describe('a late close does not commit for the attempt that replaced it', () => {
  // ATTEMPT A STALLS, is reaped, the issue is released, attempt B is
  // dispatched into the SAME `.worktrees/queen-<issue>` - and only then does
  // A's stream end and call closeDispatch. Nothing kills a reaped stream:
  // there is no abort signal, no turn timeout and no registry, and
  // finishDispatch takes a conversation precisely because its own doc calls
  // this "routine rather than exotic". Without the same guard on the salvage,
  // A's close reads B's row, finds B's half-written files, and commits them as
  // finished work under B's boundary.
  it('salvages nothing when the row has moved on to another turn', async () => {
    const f = await fixture()
    write(`${f.worktree}/trios/docs/half-written.md`, 'B is still typing\n')
    const { pool, queries } = rowPool('conv-B')

    const result = await salvageDispatch(pool, ISSUE, 'finished', {
      conversationId: 'conv-A',
    })

    expect(result.committed).toBe(false)
    expect(result.detail).toContain('no longer belongs to this turn')
    // Nothing committed, and nothing stamped on the live row either.
    expect(f.head()).not.toContain('trios/docs/half-written.md')
    expect(queries.some((q) => q.sql.includes('SET salvaged_at'))).toBe(false)
    rmSync(f.scratch, { recursive: true, force: true })
  })

  // ...and the same call for the turn that DOES own the row still works, so
  // the guard is a guard and not a disablement.
  it('salvages normally for the turn the row still belongs to', async () => {
    const f = await fixture()
    write(`${f.worktree}/trios/docs/mine.md`, 'the turn that owns this row\n')
    const { pool } = rowPool('conv-B')

    const result = await salvageDispatch(pool, ISSUE, 'finished', {
      conversationId: 'conv-B',
    })

    expect(result.committed).toBe(true)
    expect(f.head()).toContain('trios/docs/mine.md')
    rmSync(f.scratch, { recursive: true, force: true })
  })

  // closeDispatch holds the conversation and passes it to finishDispatch four
  // lines further down; the salvage must read the same argument rather than
  // whatever the row says now.
  it('closeDispatch hands its own conversation to the salvage', async () => {
    const seen: Array<Record<string, unknown>> = []
    const pool = {
      query: async () => ({ rowCount: 1, rows: [] }),
    } as unknown as Pool
    await closeDispatch(pool, ISSUE, 'conv-A', 'finished', undefined, {
      salvage: (async (
        _pool: Pool,
        issue: number,
        reason: string,
        deps: Record<string, unknown> = {},
      ) => {
        seen.push({ issue, reason, ...deps })
        return {
          committed: false,
          files: [],
          left: [],
          sha: null,
          detail: 'test',
        }
      }) as unknown as typeof salvageDispatch,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].conversationId).toBe('conv-A')
    expect(seen[0].requireOpen).toBe(true)
  })

  // A repair may not hold the ending. Until the deadline, a wedged git could
  // keep `finished_at` NULL for the sum of every per-command timeout, and a
  // row that is not finished is a phantom running bee holding its boundary and
  // its provider key.
  it('writes the ending even when the salvage never returns', async () => {
    const statements: string[] = []
    const pool = {
      query: async (sql: string) => {
        statements.push(String(sql))
        return { rowCount: 1, rows: [] }
      },
    } as unknown as Pool
    const began = Date.now()
    await closeDispatch(pool, ISSUE, 'conv-A', 'finished', undefined, {
      salvageDeadlineMs: 25,
      salvage: (() =>
        new Promise(() => {})) as unknown as typeof salvageDispatch,
    })
    expect(Date.now() - began).toBeLessThan(4_000)
    expect(statements.some((s) => s.includes('finished_at = now()'))).toBe(true)
  })
})

describe('the stall sweep leaves this process own bees alone', () => {
  // The stall predicate says "nobody has written an ending", not "the bee is
  // dead": nothing caps a turn by wall clock (a step count, no abort signal,
  // `idleTimeout: 0`), so a turn of this process's own can pass 120 minutes
  // while it is still editing. Committing there takes the index lock from
  // under the bee's own `git commit`.
  it('does not salvage an issue whose bee is streaming here', async () => {
    const salvaged: number[] = []
    const pool = {
      query: async (sql: string) => {
        if (String(sql).startsWith('SELECT issue')) {
          return { rowCount: 1, rows: [{ issue: ISSUE }] }
        }
        return { rowCount: 1, rows: [{ issue: ISSUE }] }
      },
    } as unknown as Pool
    const spy = (async (_p: Pool, issue: number) => {
      salvaged.push(issue)
      return { committed: false, files: [], left: [], sha: null, detail: '' }
    }) as unknown as typeof salvageDispatch

    markBeeRunningHere(ISSUE, 'conv-live')
    await reapStalledDispatches(pool, 120, { salvage: spy })
    expect(salvaged).toEqual([])

    // The turn ends; the next sweep may repair what it left behind.
    clearBeeRunningHere(ISSUE, 'conv-live')
    await reapStalledDispatches(pool, 120, { salvage: spy })
    expect(salvaged).toEqual([ISSUE])
  })
})

describe('the boot reaper releases only the rows it looked at', () => {
  // It is fired WITHOUT being awaited and the first round starts milliseconds
  // later. Before the salvage the gap between the SELECT and the UPDATE was
  // microseconds; now it is however long git takes on the volume a restart
  // left behind - and the UPDATE's predicate, `started = true AND finished_at
  // IS NULL`, is exactly the shape of a bee the round has just dispatched.
  it('does not reap a dispatch that started while it was salvaging', async () => {
    // The rows in flight, as the database would hold them.
    let inFlight = [1]
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        const text = String(sql)
        if (text.startsWith('SELECT issue')) {
          return {
            rowCount: inFlight.length,
            rows: inFlight.map((i) => ({ issue: i })),
          }
        }
        // The UPDATE, evaluated the way Postgres would: the predicate AND the
        // bound the statement carries.
        const bound = (params[params.length - 1] as number[]) ?? null
        const hit = inFlight.filter((i) => bound === null || bound.includes(i))
        inFlight = inFlight.filter((i) => !hit.includes(i))
        return { rowCount: hit.length, rows: hit.map((i) => ({ issue: i })) }
      },
    } as unknown as Pool

    const reaped = await reapDispatchesFromPreviousBoot(pool, {
      salvage: (async () => {
        // The first round takes the lease and dispatches a new bee while the
        // salvage loop is still running git on the previous boot's worktrees.
        inFlight.push(2)
        return { committed: false, files: [], left: [], sha: null, detail: '' }
      }) as unknown as typeof salvageDispatch,
    })

    expect(reaped).toEqual([1])
    // Issue 2's bee is streaming right now; its row is untouched.
    expect(inFlight).toEqual([2])
  })
})

// ---------------------------------------------------------------------------
// What the commit takes, and what it refuses to take.
// ---------------------------------------------------------------------------

describe('the salvage commit', () => {
  // A LOCK IS A HAND ON THE INDEX. git takes `index.lock` with no wait and no
  // retry: either a bee is inside its own commit - and the salvage would kill
  // it, losing the turn this feature exists to save - or a SIGKILLed git left
  // the lock behind, in which case every index write in the tree fails until a
  // person removes the file, and nothing in this repository names it.
  it('refuses a worktree whose index is locked, and names the lock', async () => {
    const f = await fixture()
    write(`${f.worktree}/trios/docs/note.md`, 'work\n')
    const gitDir = git(f.worktree, ['rev-parse', '--absolute-git-dir'])
    writeFileSync(join(gitDir, 'index.lock'), '')

    const locked = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'finished',
      'conv-lock',
    )
    expect(locked.committed).toBe(false)
    expect(locked.detail).toContain('index is locked')
    expect(locked.detail).toContain('index.lock')
    expect(f.head()).not.toContain('trios/docs/note.md')

    // The lock gone, the same call does the work.
    rmSync(join(gitDir, 'index.lock'))
    const freed = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'finished',
      'conv-lock',
    )
    expect(freed.committed).toBe(true)
    expect(f.head()).toContain('trios/docs/note.md')
    rmSync(f.scratch, { recursive: true, force: true })
  })

  // ONE MISSING PATH COSTS ONE PATH. `git add -A -- a b c` aborts the WHOLE
  // command when one untracked pathspec matches nothing, and the status and
  // the add are two separate processes: a scratch file removed in between used
  // to throw away every good file beside it and release the attempt as empty.
  it('still commits the good paths when one of them vanished', async () => {
    const f = await fixture()
    write(`${f.worktree}/trios/docs/a.md`, 'good\n')
    write(`${f.worktree}/trios/docs/b.md`, 'good\n')

    // The status the salvage reads names a third file; the add the salvage
    // runs cannot find it, which is the race, reproduced exactly.
    const real = await import('node:child_process')
    const runner = (async (
      command: string,
      args: string[],
      cwd: string,
    ): Promise<{ code: number; out: string }> => {
      if (args[0] === 'status') {
        write(`${f.worktree}/trios/docs/gone.md`, 'about to vanish\n')
      }
      const done = real.spawnSync(
        command === 'git' ? REAL_GIT : command,
        args,
        {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
        },
      )
      if (args[0] === 'status') {
        rmSync(`${f.worktree}/trios/docs/gone.md`)
      }
      return {
        code: done.status ?? -1,
        out: `${done.stdout ?? ''}${done.stderr ?? ''}`.trim(),
      }
    }) as unknown as Parameters<typeof salvageWorktree>[4]['git']

    const result = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'finished',
      'conv-race',
      { git: runner },
    )
    expect(result.committed).toBe(true)
    expect(result.files).toEqual(['trios/docs/a.md', 'trios/docs/b.md'])
    // The path that could not be staged is reported, not silently dropped.
    expect(result.left).toContain('trios/docs/gone.md')
    expect(f.head()).toContain('trios/docs/a.md')
    expect(f.head()).toContain('trios/docs/b.md')
    rmSync(f.scratch, { recursive: true, force: true })
  })

  // A STATUS THIS CANNOT PARSE IS NOT A BOUNDARY MISS. `run` merges stderr
  // into the buffer it returns, so a warning git writes while it walks the
  // tree for `-uall` (exit code still 0) arrives glued to a record - which
  // then matches no boundary and gets reported as a stray, the salvage
  // silently failing at its one job with the log blaming the boundary.
  it('refuses the whole tree when a status record cannot be read', async () => {
    const f = await fixture()
    write(`${f.worktree}/trios/docs/note.md`, 'work\n')
    const runner = (async (
      command: string,
      args: string[],
      cwd: string,
    ): Promise<{ code: number; out: string }> => {
      if (args[0] === 'status') {
        return {
          code: 0,
          out: "warning: could not open directory 'x/': Permission denied\n?? trios/docs/note.md\0",
        }
      }
      const done = Bun.spawnSync(
        [command === 'git' ? REAL_GIT : command, ...args],
        {
          cwd,
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
        },
      )
      return {
        code: done.exitCode ?? -1,
        out: `${done.stdout.toString()}${done.stderr.toString()}`.trim(),
      }
    }) as unknown as Parameters<typeof salvageWorktree>[4]['git']

    const result = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'finished',
      'conv-warn',
      { git: runner },
    )
    expect(result.committed).toBe(false)
    expect(result.detail).toContain('cannot parse')
    expect(result.detail).not.toContain('outside the boundary')
    rmSync(f.scratch, { recursive: true, force: true })
  })

  // THE CAP COUNTS ENTRIES. Slicing a flattened sorted path list can cut
  // between a rename's two names - `parsePorcelainZ` keeps them in one entry
  // because "committing half of a rename is not salvaging work, it is
  // inventing a deletion" - and `commit --only <new>` then leaves HEAD holding
  // BOTH copies for the reviewer and the compiler to trip over.
  it('never splits a rename across the path cap', async () => {
    const f = await fixture()
    // A file the bee renamed, whose two names sort to OPPOSITE ends of the
    // list the cap is applied to.
    write(`${f.worktree}/trios/docs/z/old.md`, 'the file the bee renamed\n')
    git(f.worktree, ['add', 'trios/docs/z/old.md'])
    git(f.worktree, [
      '-c',
      'user.email=bee@example.com',
      '-c',
      'user.name=Bee',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'the bee committed this before it renamed it',
    ])
    mkdirSync(`${f.worktree}/trios/docs/a`, { recursive: true })
    git(f.worktree, ['mv', 'trios/docs/z/old.md', 'trios/docs/a/new.md'])
    // ...and enough paths between them to put the cap in the gap.
    for (let i = 0; i < 205; i++) {
      write(
        `${f.worktree}/trios/docs/m/f${String(i).padStart(3, '0')}.md`,
        'x\n',
      )
    }

    const result = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'reaped',
      'conv-rename',
    )
    expect(result.committed).toBe(true)
    // Both halves travelled together...
    expect(result.files).toContain('trios/docs/a/new.md')
    expect(result.files).toContain('trios/docs/z/old.md')
    // ...so the branch the reviewer and the compiler read holds the renamed
    // file ONCE, rather than the new name beside a copy nothing removed.
    const head = f.head()
    expect(head).toContain('trios/docs/a/new.md')
    expect(head).not.toContain('trios/docs/z/old.md')
    rmSync(f.scratch, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// And what the salvage leaves behind on disk and on the row.
// ---------------------------------------------------------------------------

describe('a salvaged worktree is not garbage', () => {
  // The container holds no push credential by design, so a commit on a bee
  // branch lives in one place. Before the salvage, "the only copy" and
  // "uncommitted" were the same set and the dirt check covered both. A salvage
  // COMMITS the work and leaves the tree clean - which made it eligible for
  // removal, and `prepareWorktree` then re-cuts with `worktree add -B`, which
  // resets the branch to base and takes the salvage with it.
  it('is kept by the volume reaper while its branch is ahead of base', async () => {
    const f = await fixture()
    write(`${f.worktree}/trios/docs/note.md`, 'salvaged\n')
    const salvaged = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'reaped',
      'conv-gc',
    )
    expect(salvaged.committed).toBe(true)
    // Clean, as a successful salvage always leaves it.
    expect(git(f.worktree, ['status', '--porcelain'])).toBe('')

    const gc = await reapWorktrees({
      high: 1,
      low: 0,
      keepNewest: 0,
      volumeUsed: () => 99,
    })
    expect(
      gc.keptUnpushed.some((p) => p.endsWith(`/.worktrees/queen-${ISSUE}`)),
    ).toBe(true)
    expect(gc.removed).toEqual([])
    expect(existsSync(f.worktree)).toBe(true)
    rmSync(f.scratch, { recursive: true, force: true })
  })
})

describe('the salvage columns belong to the attempt that was salvaged', () => {
  // `queen_dispatch` is keyed by issue and the upsert resets every
  // attempt-scoped column for the reason it records one comment above ("a
  // second dispatch of #1244 inherited the first one's 18308 input tokens").
  // The salvage columns were not in that list, so one salvage marked the issue
  // as salvaged for ever: attempt 2's bee commits its own work, salvage writes
  // nothing, and the verdict, the stored note, the next bee's brief and the
  // salvaged counter all still report attempt 1's files and attempt 1's sha.
  it('is cleared when the issue is dispatched again', async () => {
    const statements: string[] = []
    const pool = {
      query: async (sql: string) => {
        statements.push(String(sql))
        return { rowCount: 1, rows: [] }
      },
    } as unknown as Pool
    await recordDispatch(pool, ISSUE, `queen-${ISSUE}`, true, 'cut', [
      'trios/docs',
    ])
    const upsert = statements.find((s) => s.includes('ON CONFLICT (issue)'))
    expect(upsert).toBeDefined()
    for (const column of [
      'salvaged_at = CASE WHEN EXCLUDED.started',
      'salvaged_sha = CASE WHEN EXCLUDED.started',
      'salvaged_files = CASE WHEN EXCLUDED.started',
      'salvage_left = CASE WHEN EXCLUDED.started',
    ]) {
      expect(upsert).toContain(column)
    }
  })
})

// ---------------------------------------------------------------------------
// The verdict: what it says, and what it spends.
// ---------------------------------------------------------------------------

const CRITERION = 'A note file records what the turn was doing'

/**
 * Six criteria, because one is not the case the cap was raised for: the
 * reviewer answers per criterion and each line carries a cited reason.
 */
const CRITERIA = [
  CRITERION,
  'The note names the issue it belongs to',
  'The note names the turn that wrote it',
  'A test covers the note reader',
  'The reader refuses a note it cannot parse',
  'The change touches nothing outside trios/docs',
]

/** One dispatch row, as the review sweep selects it. */
function finishedRow(over: Record<string, unknown> = {}) {
  return {
    issue: ISSUE,
    conversation_id: 'conv-review',
    review_state: null,
    criteria: CRITERIA,
    criteria_source: 'stated',
    send_backs: 0,
    owned_paths: ['trios/docs'],
    free_attempts: 0,
    key_index: 0,
    provider: 'zai',
    model: 'glm-5.3',
    reviewer_fingerprint: null,
    reviewer_text: null,
    reviewer_model: null,
    reviewer_provider: null,
    reviewer_misses: 0,
    outcome: 'finished',
    judged_head: null,
    judged_conversation: null,
    judged_note: null,
    criteria_fingerprint: null,
    criteria_runs: null,
    salvaged_at: null,
    salvaged_sha: null,
    salvaged_files: [],
    salvage_left: [],
    said: '',
    errored: false,
    ...over,
  }
}

function reviewPool(row: Record<string, unknown>) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      queries.push({ sql: text, params })
      if (text.includes('FROM queen_dispatch d')) {
        return { rowCount: 1, rows: [row] }
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  const verdict = () =>
    queries.find(
      (q) =>
        q.sql.includes('UPDATE queen_dispatch') &&
        q.sql.includes('review_state ='),
    )
  return { pool, verdict }
}

const LANE = {
  provider: 'openai-compatible',
  model: 'reviewer-model',
  baseUrl: 'https://reviewer.example.invalid',
  apiKey: 'not-a-real-key',
  keyIndex: 0,
  poolNumber: 1,
  laneIndex: 0,
  laneCount: 1,
}

/** The branch the sweep reads, without a checkout under it. */
function branchDeps() {
  return {
    committedFilesResult: async () => ({
      ok: true as const,
      files: ['trios/docs/note.md'],
    }),
    branchHeadSha: async () => 'headsha00000000',
    mergeBaseSha: async () => 'basesha00000000',
    branchPatch: async () =>
      'diff --git a/trios/docs/note.md b/trios/docs/note.md\n+one line\n',
    worktreeDirtCount: async () => 0,
    measureCriteria: async () => ({ runs: [], fingerprint: null }),
  }
}

/** A reviewer whose refutation is as long as a real one's. */
function reviewDeps(reviewerText: string) {
  return {
    witness: async () => ({
      kind: 'witnessed' as const,
      t27c: 'fake',
      specs: [],
    }),
    laneCandidates: () => [LANE],
    reviewsPerRound: () => 1,
    // One, not zero: a review now waits for its criteria to be measured, so a
    // zero budget turned every row here into `wait` and the reviewer was
    // never asked. The fake measurement (branchDeps) returns no runs.
    measurementsPerRound: () => 1,
    llm: async () => ({ ok: true as const, text: reviewerText }),
  }
}

/**
 * A refutation with citations, at the length the note cap was raised for: the
 * comment on `PREVIOUS_REVIEW_MAX_CHARS` says 1500 exists because "a
 * reviewer's reasons with citations do not fit the 900 a bare list of criteria
 * used to".
 */
const LONG_REFUTATION = [
  '## VERDICT',
  ...CRITERIA.map(
    (criterion, i) =>
      `- ${i + 1}. ${criterion}: trios/docs/note.md:1 is the only line the ` +
      'patch adds and it does not carry this, and the commit body claims ' +
      'nothing about it either, so nothing in what I was shown establishes ' +
      'the criterion and I can cite no line that does: unmet',
  ),
].join('\n')

describe('the note says who committed the branch, where it can be read', () => {
  // The verdict is queend's (the Swift policy binary): without it every row
  // stays `wait` and the reviewer's refutation never becomes a send-back, so
  // this needs the binary exactly as queen-adversarial-review.test.ts does.
  // It failed in CI for that reason alone - CI builds no queend.
  it.if(queendPresent)(
    'puts the salvage fact where the 1500-character cap cannot cut it',
    async () => {
      const salvagedRow = finishedRow({
        salvaged_at: new Date(),
        salvaged_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        salvaged_files: ['trios/docs/note.md'],
        salvage_left: ['README.md'],
      })
      const pool = reviewPool(salvagedRow)
      await reviewFinishedDispatches(pool.pool, {
        ...reviewDeps(LONG_REFUTATION),
        ...branchDeps(),
      } as unknown as Parameters<typeof reviewFinishedDispatches>[1])

      const note = String(pool.verdict()?.params[2] ?? '')
      // Stored at the cap, which is the case the fact used to be lost in...
      expect(note.length).toBe(1500)
      // ...and the fact is still there, because it goes first.
      expect(note).toContain('committed by the container')
      expect(note.indexOf('committed by the container')).toBeLessThan(400)
    },
  )

  // The composer itself: provenance first, body second, and a body alone when
  // nothing was salvaged.
  it('leaves an unsalvaged note exactly as the policy wrote it', () => {
    expect(noteWithSalvage('', 'the policy note')).toBe('the policy note')
    expect(noteWithSalvage('\n\nsalvaged.', 'body')).toBe('salvaged.\n\nbody')
  })
})

describe('a turn the provider killed does not spend the issue', () => {
  // `providerEnded` was consulted in ONE place - the empty path - because a
  // killed turn committed nothing and therefore always went down it, where
  // FREE_ATTEMPT_CEILING's own comment says such an attempt must not be
  // counted: "a quota window ends every turn at once and three of them are
  // minutes, not evidence about the issue". The salvage removed that
  // coincidence: the container commits the killed turn's edits, files.length
  // is non-zero, and the attempt arrives on the MAIN path, which charged it.
  it.if(queendPresent)(
    'is judged and sent back, but charges neither counter',
    async () => {
      const killed = finishedRow({
        outcome: 'the stream ended without a completion',
        said: '',
        salvaged_at: new Date(),
        salvaged_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        salvaged_files: ['trios/docs/note.md'],
        salvage_left: [],
      })
      const pool = reviewPool(killed)
      const result = await reviewFinishedDispatches(pool.pool, {
        ...reviewDeps(LONG_REFUTATION),
        ...branchDeps(),
      } as unknown as Parameters<typeof reviewFinishedDispatches>[1])

      // The work IS judged - that is the whole point of salvaging it...
      expect(result.acted).toEqual([`#${ISSUE}:sendBack`])
      const params = pool.verdict()?.params ?? []
      // ...and it is not escalated past the bee (`beyondThePatch`)...
      expect(String(params[1])).toBe('sendBack')
      // ...and `send_backs` does not move: countsAgainstTheIssue is false...
      expect(params[4]).toBe(false)
      // ...and neither does free_attempts.
      expect(params[5]).toBe(0)
    },
  )
})
