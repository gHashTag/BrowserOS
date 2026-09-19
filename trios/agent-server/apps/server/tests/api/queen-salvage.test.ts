/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE SALVAGE COMMIT, against a real repository.
 *
 * WHAT IS BEING GUARDED, measured on the live service 2026-09-17/18: of 43
 * finished dispatches re-reviewed in one window, 38 had committed nothing, and
 * the first sweep after the new code released 19 attempts as `empty` in one
 * go. In the same 24 hours 116 dispatches recorded "N uncommitted file(s) left
 * by a previous attempt" - the bee HAD edited, and the turn ended before
 * `git commit`: a provider 429, one of 38 deploy restarts (188 of 541
 * dispatches never finished), or the bee simply stopping. The work sat in
 * `.worktrees/queen-<issue>`, where the review cannot see it, so there was
 * nothing to judge, the attempt was released as empty, and the next attempt
 * started beside the same uncommitted pile.
 *
 * EVERY CASE BELOW USES A REAL GIT REPOSITORY under the system temp directory,
 * with WORKSPACE_DIR redirected to it: a fake git would prove the test's idea
 * of `git commit --only`, which is precisely the part that has to be true.
 * `origin` is a directory on the same disk, so nothing here touches a network
 * or a real checkout.
 *
 * WHAT IT DOES NOT CLAIM. Nothing here says a salvaged commit is correct work.
 * The last case says the opposite: a salvaged attempt stops being released as
 * `empty` and becomes an attempt the reviewer and the compiler judge.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Pool } from 'pg'
import {
  committedFilesResult,
  insideBoundary,
  parsePorcelainZ,
  prepareWorktree,
  reapStalledDispatches,
  salvageDispatch,
  salvageWorktree,
} from '../../src/api/services/queen-dispatch'
import { reviewFinishedDispatches } from '../../src/api/services/queen-tick'

/** The real git, resolved before any test can put something else on PATH. */
const REAL_GIT = Bun.which('git') || '/usr/bin/git'

/** The policy binary, when this machine has one. */
const QUEEND = [
  join(import.meta.dir, '../../../../queen-core/.build/release/queend'),
  '/usr/local/bin/queend',
].find(existsSync)

const ISSUE = 1627

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

/** The same, for a command whose failure is the point (a conflicting merge). */
function tryGit(cwd: string, args: string[]): number {
  const done = Bun.spawnSync([REAL_GIT, ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  return done.exitCode ?? -1
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key]
  else process.env[key] = previous
}

interface Fixture {
  scratch: string
  root: string
  worktree: string
  /** Commits on the bee's branch, oldest first, as `<sha> <subject>`. */
  log: () => string[]
  /** Everything git still calls uncommitted in the worktree. */
  dirt: () => string[]
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

/**
 * The deployment in miniature: a bare `origin`, the checkout the Queen cuts
 * worktrees from, and one bee worktree cut by `prepareWorktree` itself - the
 * same function the dispatch path uses, so the branch, the base ref and the
 * layout are the ones salvage will meet in production.
 *
 * No git identity is configured anywhere in it, on purpose: the container's
 * entrypoint sets one, a developer's machine has a global one, and the
 * fixture has neither - which is the case that proves the salvage supplies an
 * author of its own rather than dying with "please tell me who you are".
 */
async function fixture(issue = ISSUE): Promise<Fixture> {
  const scratch = mkdtempSync(join(tmpdir(), 'queen-salvage-'))
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
  // A branch that changes the same line, so one case below can make a REAL
  // merge conflict rather than a hand-written index entry.
  git(seed, ['checkout', '-q', '-b', 'theirs'])
  write(join(seed, 'trios/docs/keep.md'), 'their line\n')
  git(seed, ['-c', 'commit.gpgsign=false', 'commit', '-qam', 'theirs'])
  git(seed, ['push', '-q', origin, 'theirs'])
  git(seed, ['checkout', '-q', 'dev'])

  const root = join(scratch, 'BrowserOS')
  git(scratch, ['clone', '-q', origin, 'BrowserOS'])

  process.env.WORKSPACE_DIR = scratch
  process.env.TRIOS_REPO_REF = 'origin/dev'
  delete process.env.TRIOS_REPO_URL
  delete process.env.TRIOS_REPO_SUBDIR
  // No module store, so the farm exits with NOFARM instead of hunting a disk.
  process.env.TRIOS_MODULE_STORE = join(scratch, 'no-such-store')
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  delete process.env.GIT_AUTHOR_NAME
  delete process.env.GIT_AUTHOR_EMAIL

  // The volume measurement is injected for the reason `prepareWorktree`
  // records: `df -P` on a macOS temp directory reports the container's own
  // usage, so a guard meant for the Linux volume refuses to cut anything here.
  const cut = await prepareWorktree(issue, { volumeUsed: () => 10 })
  expect(cut.detail).toContain('cut from')
  expect(cut.ok).toBe(true)
  const worktree = cut.path
  return {
    scratch,
    root,
    worktree,
    log: () =>
      git(worktree, ['log', '--reverse', '--pretty=%H %s'])
        .split('\n')
        .filter((l) => l.trim().length > 0),
    dirt: () =>
      git(worktree, ['status', '--porcelain'])
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) restoreEnv(key, saved[key])
})

// ---------------------------------------------------------------------------
// The boundary rule and the porcelain reader, with no git involved.
// ---------------------------------------------------------------------------

describe('what the salvage is allowed to touch', () => {
  // BOTH SPELLINGS, the same reduction `boundaryStrays` documents: git names a
  // path from the repository root while an owned path may be written
  // repository-relative or project-relative.
  it('accepts a boundary written either way', () => {
    expect(insideBoundary('trios/docs/x.md', ['trios/docs'], 'trios')).toBe(
      true,
    )
    expect(insideBoundary('trios/docs/x.md', ['docs'], 'trios')).toBe(true)
    expect(insideBoundary('trios/docs', ['trios/docs'], 'trios')).toBe(true)
  })

  // A PREFIX IS NOT A PARENT. `trios/docs` must not swallow `trios/docsite`,
  // or the salvage would commit a directory nobody gave the bee.
  it('does not let a name prefix stand for a directory', () => {
    expect(insideBoundary('trios/docsite/x.md', ['trios/docs'], 'trios')).toBe(
      false,
    )
    expect(insideBoundary('README.md', ['trios/docs'], 'trios')).toBe(false)
  })

  // A task that owns no paths is not a task that owns everything - the same
  // reading the Swift side and `boundaryStrays` already take.
  it('treats an empty boundary as holding nothing', () => {
    expect(insideBoundary('trios/docs/x.md', [], 'trios')).toBe(false)
    expect(insideBoundary('anything', [''], 'trios')).toBe(false)
  })

  it('reads the NUL porcelain, renames and spaces included', () => {
    const records = [
      'R  new name.md',
      'old name.md',
      '?? a/b c.md',
      ' M kept.md',
    ]
    const entries = parsePorcelainZ(`${records.join('\0')}\0`)
    // The rename travels as ONE entry: committing half of it would invent a
    // deletion rather than salvage work.
    expect(entries[0].paths).toEqual(['new name.md', 'old name.md'])
    expect(entries[1].paths).toEqual(['a/b c.md'])
    // `run` trims what it returns, so a leading status column can be gone by
    // the time this reads it - the case that made a modified file read as the
    // path "M trios/docs/keep.md" and stay uncommitted by the salvage written
    // to commit it.
    expect(entries[2].paths).toEqual(['kept.md'])
  })
})

// ---------------------------------------------------------------------------
// The commit itself, in a real worktree.
// ---------------------------------------------------------------------------

describe('salvaging a turn that ended with its work uncommitted', () => {
  it('writes exactly one commit, and the review can then see the files', async () => {
    const f = await fixture()
    const before = f.log().length
    write(`${f.worktree}/trios/docs/keep.md`, 'one line\nand another\n')
    write(`${f.worktree}/trios/docs/note.md`, 'work the turn never committed\n')

    const result = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'finished',
      'conv-salvage',
    )
    expect(result.committed).toBe(true)
    expect(result.files).toEqual(['trios/docs/keep.md', 'trios/docs/note.md'])
    expect(result.left).toEqual([])
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/)

    // ONE commit, and it says what it is in its own subject.
    const log = f.log()
    expect(log.length).toBe(before + 1)
    expect(log[log.length - 1]).toContain(
      `salvage(queen-${ISSUE}): commit what the turn left uncommitted`,
    )
    const body = git(f.worktree, ['log', '-1', '--pretty=%b'])
    expect(body).toContain(`Issue: #${ISSUE}`)
    expect(body).toContain('Turn: conv-salvage')
    expect(body).toContain('not a claim that the work is correct')
    // An author, although the fixture configured none anywhere.
    expect(git(f.worktree, ['log', '-1', '--pretty=%an'])).toBe('Trinity Bee')

    // THE POINT OF ALL OF IT: the diff the review reads now holds the work.
    const diff = await committedFilesResult(ISSUE)
    expect(diff.ok).toBe(true)
    expect(diff.ok && diff.files.sort()).toEqual([
      'trios/docs/keep.md',
      'trios/docs/note.md',
    ])
    expect(f.dirt()).toEqual([])
  })

  // A STRAY IS A FINDING, NOT A DELIVERABLE. It stays where the bee left it -
  // the worktree is reused, so nothing is lost - and it is reported.
  it('leaves everything outside the boundary uncommitted, and reports it', async () => {
    const f = await fixture()
    write(`${f.worktree}/trios/docs/note.md`, 'inside the boundary\n')
    write(`${f.worktree}/README.md`, 'outside the boundary\n')
    // ...and one the bee had already STAGED before it stopped. `--only` is
    // what keeps this out of the commit; without it the index decides what a
    // boundary-checked commit contains.
    write(`${f.worktree}/staged-stray.md`, 'staged, and still not ours\n')
    git(f.worktree, ['add', 'staged-stray.md'])

    const result = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'finished',
      'conv-stray',
    )
    expect(result.committed).toBe(true)
    expect(result.files).toEqual(['trios/docs/note.md'])
    expect(result.left).toEqual(['README.md', 'staged-stray.md'])

    const diff = await committedFilesResult(ISSUE)
    expect(diff.ok && diff.files).toEqual(['trios/docs/note.md'])
    // Still there, untouched, for the next attempt or for a person.
    expect(f.dirt().join('\n')).toContain('README.md')
    expect(f.dirt().join('\n')).toContain('staged-stray.md')
  })

  it('writes nothing at all when the worktree is clean', async () => {
    const f = await fixture()
    const before = f.log()
    const result = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'finished',
      'conv-clean',
    )
    expect(result.committed).toBe(false)
    expect(result.sha).toBeNull()
    expect(result.detail).toContain('clean')
    expect(f.log()).toEqual(before)
  })

  // SAFE TO RUN TWICE. The close path and a reaper can both reach the same
  // dispatch, and a second salvage must not write a second commit.
  it('is idempotent: the second run finds nothing to commit', async () => {
    const f = await fixture()
    write(`${f.worktree}/trios/docs/note.md`, 'once\n')
    const first = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'finished',
      'conv-twice',
    )
    expect(first.committed).toBe(true)
    const after = f.log()

    const second = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'reaped',
      'conv-twice',
    )
    expect(second.committed).toBe(false)
    expect(f.log()).toEqual(after)
  })

  // A CONFLICT IS NOT SALVAGE. An unmerged path holds both sides and the
  // markers between them; committing it would put a file nobody wrote in front
  // of the reviewer as the bee's work.
  it('refuses a worktree holding an unmerged path', async () => {
    const f = await fixture()
    write(`${f.worktree}/trios/docs/keep.md`, 'our line\n')
    git(f.worktree, [
      '-c',
      'user.email=bee@example.com',
      '-c',
      'user.name=Bee',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qam',
      'ours',
    ])
    git(f.worktree, ['fetch', '-q', 'origin', 'theirs:refs/remotes/origin/x'])
    // The merge is MEANT to fail: that is how the unmerged entry gets there.
    expect(tryGit(f.worktree, ['merge', 'refs/remotes/origin/x'])).not.toBe(0)
    const before = f.log()

    const result = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'reaped',
      'conv-conflict',
    )
    expect(result.committed).toBe(false)
    expect(result.detail).toContain('unmerged')
    expect(result.left).toContain('trios/docs/keep.md')
    expect(f.log()).toEqual(before)
  })

  // NEVER A TREE THAT IS NOT THIS DISPATCH'S. A detached HEAD has no branch of
  // its own, and a commit written onto it belongs to nobody.
  it('refuses a worktree that is not standing on the bee branch', async () => {
    const f = await fixture()
    write(`${f.worktree}/trios/docs/note.md`, 'work\n')
    git(f.worktree, ['checkout', '-q', '--detach', 'HEAD'])
    const before = f.log()
    const result = await salvageWorktree(
      ISSUE,
      ['trios/docs'],
      'finished',
      'conv-detached',
    )
    expect(result.committed).toBe(false)
    expect(result.detail).toContain(`not queen-${ISSUE}`)
    expect(f.log()).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// The two places a turn is abandoned.
// ---------------------------------------------------------------------------

/** A Postgres that answers the two statements salvage and the reaper send. */
function salvagePool(ownedPaths: string[], due: number[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      queries.push({ sql: text, params })
      if (text.includes('SELECT owned_paths, conversation_id')) {
        return {
          rowCount: 1,
          rows: [{ owned_paths: ownedPaths, conversation_id: 'conv-reaped' }],
        }
      }
      if (text.startsWith('SELECT issue FROM queen_dispatch')) {
        return { rowCount: due.length, rows: due.map((issue) => ({ issue })) }
      }
      return { rowCount: due.length, rows: due.map((issue) => ({ issue })) }
    },
  } as unknown as Pool
  const indexOf = (needle: string) =>
    queries.findIndex((q) => q.sql.includes(needle))
  return { pool, queries, indexOf }
}

describe('a reaped dispatch', () => {
  // A reap RELEASES the issue, and the retry reuses this worktree. Salvaging
  // after the release would be a race with the next bee; salvaging before it
  // is what makes the killed turn's work the next attempt's starting point.
  it('is salvaged before the row is released', async () => {
    const f = await fixture()
    write(`${f.worktree}/trios/docs/note.md`, 'killed mid-turn\n')
    const { pool, queries, indexOf } = salvagePool(['trios/docs'], [ISSUE])

    const reaped = await reapStalledDispatches(pool, 120)
    expect(reaped).toEqual([ISSUE])

    const log = f.log()
    expect(log[log.length - 1]).toContain(`salvage(queen-${ISSUE})`)
    expect(git(f.worktree, ['log', '-1', '--pretty=%b'])).toContain(
      'Ending: reaped',
    )
    // The order is the guarantee: the salvage is recorded on the row before
    // the statement that releases it runs.
    const recorded = indexOf('SET salvaged_at')
    const released = indexOf("outcome = 'reaped")
    expect(recorded).toBeGreaterThanOrEqual(0)
    expect(released).toBeGreaterThan(recorded)
    const record = queries[recorded]
    expect(JSON.parse(String(record.params[2]))).toEqual(['trios/docs/note.md'])
  })

  it('records the salvage on the dispatch row, strays included', async () => {
    const f = await fixture()
    write(`${f.worktree}/trios/docs/note.md`, 'inside\n')
    write(`${f.worktree}/README.md`, 'outside\n')
    const { pool, queries, indexOf } = salvagePool(['trios/docs'], [ISSUE])

    const result = await salvageDispatch(pool, ISSUE, 'finished')
    expect(result.committed).toBe(true)

    const record = queries[indexOf('SET salvaged_at')]
    expect(record.params[1]).toMatch(/^[0-9a-f]{40}$/)
    expect(JSON.parse(String(record.params[2]))).toEqual(['trios/docs/note.md'])
    expect(JSON.parse(String(record.params[3]))).toEqual(['README.md'])
    expect(f.dirt().join('\n')).toContain('README.md')
  })

  // The suites that drive `closeDispatch` against a fake pool must keep
  // reaching the ending through the statements they always did, and a
  // deployment with no worktree for an issue must not pay for a query.
  it('asks the database nothing when there is no worktree', async () => {
    const f = await fixture()
    const { pool, queries } = salvagePool(['trios/docs'], [])
    const result = await salvageDispatch(pool, ISSUE + 1, 'finished')
    expect(result.committed).toBe(false)
    expect(queries).toEqual([])
    expect(f.log().length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// And then it is judged like any other commit.
// ---------------------------------------------------------------------------

/** One dispatch row, as the review sweep selects it. */
function finishedRow(over: Record<string, unknown> = {}) {
  return {
    issue: ISSUE,
    conversation_id: 'conv-review',
    review_state: null,
    criteria: [CRITERION],
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

/** A reviewer lane that cannot reach anything: the model is a fake below. */
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

/**
 * Real git against the fixture, a real policy when the machine has one, and a
 * fake model - the same division the adversarial suite uses, because a test
 * that needs a paid key is a test nobody runs.
 */
function reviewDeps() {
  const shown: string[] = []
  const deps = {
    witness: async () => ({
      kind: 'witnessed' as const,
      t27c: 'fake',
      specs: [],
    }),
    laneCandidates: () => [LANE],
    reviewsPerRound: () => 1,
    measurementsPerRound: () => 0,
    llm: async (_lane: unknown, _system: string, message: string) => {
      shown.push(message)
      return {
        ok: true as const,
        text: [
          '## VERDICT',
          `- 1. ${CRITERION}: trios/docs/note.md:1 records it, and the refutation that the file is empty failed: met`,
        ].join('\n'),
      }
    },
  }
  return { deps, shown }
}

const CRITERION = 'A note file records what the turn was doing'

describe('a salvaged attempt is judged, not released', () => {
  it('is empty before the salvage and reaches the reviewer after it', async () => {
    const f = await fixture()
    if (QUEEND) process.env.TRIOS_QUEEND_PATH = QUEEND
    write(`${f.worktree}/trios/docs/note.md`, 'edited, never committed\n')

    // BEFORE. The branch holds no commit and the bee wrote no verdict, so
    // there is nothing to judge: the measured `empty` release, with the work
    // sitting in the worktree the whole time. No reviewer is bought for it -
    // there is nothing to show one.
    const first = reviewPool(finishedRow())
    const cold = reviewDeps()
    const before = await reviewFinishedDispatches(first.pool, cold.deps)
    expect(before.acted).toEqual([`#${ISSUE}:empty`])
    expect(String(first.verdict()?.params[1])).toBe('empty')
    expect(cold.shown).toEqual([])

    // The salvage, through the path a finished turn takes.
    const { pool } = salvagePool(['trios/docs'], [ISSUE])
    const salvaged = await salvageDispatch(pool, ISSUE, 'finished')
    expect(salvaged.committed).toBe(true)

    // AFTER. The same sweep, the same row, now carrying the salvage the
    // dispatch recorded. The attempt is no longer released as empty: it goes
    // to the adversarial reviewer through the existing path, with the
    // salvaged file in the patch the reviewer reads - salvaged work is judged,
    // not trusted.
    const second = reviewPool(
      finishedRow({
        salvaged_at: new Date(),
        salvaged_sha: salvaged.sha,
        salvaged_files: salvaged.files,
        salvage_left: salvaged.left,
      }),
    )
    const warm = reviewDeps()
    const after = await reviewFinishedDispatches(second.pool, warm.deps)
    expect(after.acted).not.toEqual([`#${ISSUE}:empty`])
    expect(String(second.verdict()?.params[1])).not.toBe('empty')
    expect(warm.shown).toHaveLength(1)
    expect(warm.shown[0]).toContain('trios/docs/note.md')
    expect(warm.shown[0]).toContain('edited, never committed')

    // ...and the verdict says whose commit it was.
    const note = String(second.verdict()?.params[2] ?? '')
    expect(note).toContain('committed by the container')
    expect(note).toContain('as salvage')
    expect(note).toContain('judged exactly like any other commit')
  })
})
