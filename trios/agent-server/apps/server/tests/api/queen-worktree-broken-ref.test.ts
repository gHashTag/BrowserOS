/**
 * #1321, Wave A: a broken local bee ref must not block a fresh worktree.
 *
 * The state on the volume, read 2026-09-03: the shared bare repository that
 * every worktree calls `origin` still carries `refs/heads/queen-1291`, a ref
 * whose object no longer exists - a bee that went away left its ref behind.
 * Whether that ref blocks unrelated fetches was the one thing in the epic
 * left unmeasured, and it is measurable without a build or a screen. This
 * file is the measurement, kept as a guard:
 *
 *   $ git fetch --quiet origin            # the exact argv prepareWorktree runs
 *   fatal: git upload-pack: not our ref 1234567890...
 *
 * `not our ref` is upload-pack refusing to serve a ref that names an object
 * the server does not have. The default refspec a plain `git clone` writes
 * (`+refs/heads/*:refs/remotes/origin/*`) asks for EVERY head, the broken one
 * included, so one stale bee ref stops the Queen's one fetch - and behind it
 * every unrelated worktree she would have cut. That is the failure mode this
 * file names, and the one it must not let come back silently.
 *
 * The guard is the shape of the fetch, not luck. The fetch invoked must name
 * exactly one ref, the configured base ref (FR-002), and must not fetch
 * `--all`. A fetch scoped to `refs/heads/dev` never asks upload-pack about
 * `queen-1291`, so preparation succeeds and the broken ref is left exactly
 * as it was found, byte for byte (FR-003): it is a dead bee's history, and
 * the container holds no push credential, so nobody here may repair, rewrite
 * or prune it on the way past.
 *
 * FR-001: every repository below is built with `git` inside a throwaway
 * directory under the system temp dir, and WORKSPACE_DIR is redirected there
 * before the module under test runs, so no real checkout is touched.
 * FR-004: `origin` is a directory on the same disk, never a URL, so the file
 * runs under `bun test` with no network.
 */
import { describe, expect, it } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { prepareWorktree } from '../../src/api/services/queen-dispatch'

/**
 * An object no repository will ever have: a syntactically valid SHA-1 whose
 * bytes were never the hash of anything. The broken ref names it, so the ref
 * can be read but never served - `not our ref`.
 */
const MISSING_OBJECT = '1234567890123456789012345678901234567890'

/** The real git, resolved before any test can put a spy onto PATH. */
const REAL_GIT = Bun.which('git') || '/usr/bin/git'

/** Run git in a fixture directory, returning its fate rather than judging it. */
function runGit(cwd: string, args: string[]): { code: number; out: string } {
  const done = Bun.spawnSync([REAL_GIT, ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  return {
    code: done.exitCode ?? -1,
    out: `${done.stdout.toString()}${done.stderr.toString()}`.trim(),
  }
}

/** The same, for setup steps that have no business failing. */
function git(cwd: string, args: string[]): string {
  const done = runGit(cwd, args)
  if (done.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${done.out}`)
  }
  return done.out
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key]
  else process.env[key] = previous
}

/**
 * Plants `refs/heads/<name>` as a raw file naming an object the repository
 * does not have - the exact bytes a vanished bee left behind on the volume.
 *
 * Written straight to the ref file rather than through `git update-ref`,
 * because git refuses to point a ref at an object it cannot see: the only
 * honest way to make one is to write the file the way the dead process left
 * it. Returns the bytes planted so a caller can later prove they were not
 * touched.
 */
function plantBrokenRef(gitDir: string, name: string, missing: string): Buffer {
  const refPath = join(gitDir, 'refs', 'heads', name)
  mkdirSync(dirname(refPath), { recursive: true })
  writeFileSync(refPath, `${missing}\n`)
  return readFileSync(refPath)
}

/**
 * The deployment in miniature, entirely under a temp dir:
 *
 *   origin.git   a bare repository with one good branch, `dev`
 *   BrowserOS    the checkout the Queen prepares worktrees from, whose
 *                `origin` is that bare repository on the same disk
 *
 * The broken ref is planted AFTER the clone, on purpose. A clone made from
 * an origin that already carries it copies the dead ref into the client's
 * own remote-tracking refs, and then every client-side command trips over
 * `bad object refs/remotes/origin/queen-1291` instead. That is a different,
 * louder failure. The volume's real state is quieter and worse: the checkout
 * is clean, the shared origin is not, and nothing fails until a fetch asks
 * for every head at once.
 */
function fixture(): {
  scratch: string
  origin: string
  root: string
  refPath: string
  planted: Buffer
  restore: () => void
} {
  const previousWorkspace = process.env.WORKSPACE_DIR
  const previousRef = process.env.TRIOS_REPO_REF
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'queen-broken-ref-')))

  const origin = join(scratch, 'origin.git')
  git(scratch, ['init', '-q', '--bare', 'origin.git'])

  // One good branch with one commit, pushed to the bare origin.
  const seed = join(scratch, 'seed')
  mkdirSync(seed)
  git(seed, ['init', '-q', '-b', 'dev'])
  git(seed, ['config', 'user.email', 'bee@example.com'])
  git(seed, ['config', 'user.name', 'Bee'])
  writeFileSync(join(seed, 'README.md'), 'one good branch\n')
  git(seed, ['add', '.'])
  git(seed, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'first'])
  git(seed, ['push', '-q', origin, 'dev'])
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/dev'])

  // The Queen's checkout - and the fetch it runs is scoped to exactly one
  // ref, the base ref, instead of the every-head refspec a plain clone
  // writes. That scoping is the whole guard, so the fixture ships with it
  // configured and the counterfactual case below removes it.
  const root = join(scratch, 'BrowserOS')
  git(scratch, ['clone', '-q', origin, 'BrowserOS'])
  git(root, [
    'config',
    'remote.origin.fetch',
    '+refs/heads/dev:refs/remotes/origin/dev',
  ])

  // ... and the stale bee ref, pointing at an object that is not there.
  const planted = plantBrokenRef(origin, 'queen-1291', MISSING_OBJECT)

  process.env.WORKSPACE_DIR = scratch
  process.env.TRIOS_REPO_REF = 'origin/dev'
  return {
    scratch,
    origin,
    root,
    refPath: join(origin, 'refs', 'heads', 'queen-1291'),
    planted,
    restore: () => {
      restoreEnv('WORKSPACE_DIR', previousWorkspace)
      restoreEnv('TRIOS_REPO_REF', previousRef)
    },
  }
}

/**
 * Puts a recording `git` first on PATH for the duration of one case, so the
 * test can see the argv the module actually invoked. `run` in queen-dispatch
 * shells out as `sh -c "'git' 'fetch' ...'"`, so a PATH entry is the one
 * place every spawned git can be observed without touching the module. The
 * script records and relays verbatim; it never rewrites an argument, or the
 * log would prove nothing about the code under test.
 */
function spyOnGit(scratch: string): { logPath: string; restore: () => void } {
  const previousPath = process.env.PATH
  const previousLog = process.env.QUEEN_GIT_SPY_LOG
  const previousReal = process.env.QUEEN_REAL_GIT
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL

  const logPath = join(scratch, 'git-invocations.log')
  const spyDir = join(scratch, 'git-spy')
  mkdirSync(spyDir)
  writeFileSync(
    join(spyDir, 'git'),
    [
      '#!/bin/sh',
      '# Records every git invocation for the test, then relays verbatim.',
      '{',
      "  printf 'git'",
      '  for a in "$@"; do printf \' %s\' "$a"; done',
      "  printf '\\n'",
      '} >> "$QUEEN_GIT_SPY_LOG"',
      'exec "$QUEEN_REAL_GIT" "$@"',
      '',
    ].join('\n'),
  )
  chmodSync(join(spyDir, 'git'), 0o755)

  process.env.PATH = `${spyDir}:${previousPath ?? ''}`
  process.env.QUEEN_GIT_SPY_LOG = logPath
  process.env.QUEEN_REAL_GIT = REAL_GIT
  // The runner's own global git config must not reach the fixture: a
  // developer with fetch.prune or insteadOf rewrites would change what the
  // fetch does without changing a line of the module.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  return {
    logPath,
    restore: () => {
      restoreEnv('PATH', previousPath)
      restoreEnv('QUEEN_GIT_SPY_LOG', previousLog)
      restoreEnv('QUEEN_REAL_GIT', previousReal)
      restoreEnv('GIT_CONFIG_GLOBAL', previousGlobal)
    },
  }
}

describe('#1321 Wave A: a broken local ref must not block a fresh worktree', () => {
  // THE FAILURE MODE, named. The same fixture, the same checkout, the same
  // `git fetch --quiet origin` the Queen runs - only the refspec is the one
  // a plain `git clone` writes by default, which asks upload-pack for every
  // head. The broken `queen-1291` is among them, and the answer is
  // `not our ref`. Every fetch, for every issue, dies on a ref that belonged
  // to a bee that is long gone. This case proves the failure is real so the
  // next one can prove the scoping is what prevents it; if anyone ever makes
  // the Queen fetch every head again - `--all`, a wildcard refspec, the
  // clone default - this is what comes back.
  it('blocks the fetch that asks for every ref - not our ref', () => {
    const { root, origin, refPath, planted, restore } = fixture()
    try {
      git(root, [
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*',
      ])
      const failed = runGit(root, ['fetch', '--quiet', 'origin'])
      expect(failed.code).not.toBe(0)
      expect(failed.out).toContain('not our ref')
      // The refusal names the broken ref's object, tying the failure to the
      // one stale ref and to nothing else in the fixture.
      expect(failed.out).toContain(MISSING_OBJECT)
      // Even a failed fetch touched nothing: the ref is not ours to repair.
      expect(readFileSync(refPath).equals(planted)).toBe(true)
      expect(runGit(origin, ['cat-file', '-e', MISSING_OBJECT]).code).not.toBe(
        0,
      )
    } finally {
      restore()
    }
  })

  // Scenario 1 and FR-002/FR-003. With the fetch scoped to the configured
  // base ref, the stale `queen-1291` is never requested, never served, and
  // never a reason to refuse the worktree a fresh bee needs.
  it('does not block preparing a fresh worktree when the fetch names one ref', async () => {
    const { scratch, origin, root, refPath, planted, restore } = fixture()
    const spy = spyOnGit(scratch)
    try {
      // FR-004, in the fixture itself: origin is a path, not a URL.
      expect(git(root, ['remote', 'get-url', 'origin'])).toBe(origin)

      // The volume measurement is injected so this test does not depend on how
      // full the developer's disk happens to be. It failed for exactly that
      // reason once: `/private/tmp` lives on the macOS data volume, which was at
      // 97%, and the new headroom guard correctly refused to cut a worktree that
      // would have failed part-way. Correct behaviour, wrong thing for a unit
      // test about stale refs to be measuring.
      const prepared = await prepareWorktree(1321, { volumeUsed: () => 10 })

      // Scenario 1: preparation succeeds - the stale ref costs nothing.
      expect(prepared.ok).toBe(true)
      // THE DETAIL IS A LIST OF CLAUSES NOW, AND THIS PIN PREDATES THE SECOND.
      //
      // `prepareWorktree` appends `; installed its own modules (…)` or
      // `; linked N node_modules into the store for …` on both the fresh and
      // the reuse path, because a worktree whose dependencies were not shared
      // is the difference between a 159 MB tree and a 2.5 GB one and belongs in
      // the record. This assertion was written when `detail` was one phrase, so
      // it has failed on every run since - 12 of 12 measured, which is not
      // flake, which is what it was being called.
      //
      // The first clause is still pinned exactly, so a reworded phrase is still
      // caught; the rest of the list is allowed to grow.
      expect(prepared.detail.split('; ')[0]).toBe('cut from origin/dev')
      // And it really cut a worktree: on its own branch, at the base ref.
      expect(git(root, ['worktree', 'list', '--porcelain'])).toContain(
        join(root, '.worktrees', 'queen-1321'),
      )
      expect(git(root, ['rev-parse', 'queen-1321'])).toBe(
        git(root, ['rev-parse', 'origin/dev']),
      )

      // FR-002: the fetch invoked. One fetch, seen as invoked.
      const lines = readFileSync(spy.logPath, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
      const fetches = lines.filter((line) => line.startsWith('git fetch'))
      expect(fetches).toHaveLength(1)
      // Never `--all`, and never the wildcard refspec that behaves like it.
      expect(fetches[0]).not.toContain('--all')
      expect(fetches[0]).not.toContain('*')
      // And it names exactly one ref, the configured base ref: the refspec
      // the fetch runs under is `+refs/heads/dev:refs/remotes/origin/dev` -
      // `dev`, the branch TRIOS_REPO_REF resolves against - and nothing
      // else, so upload-pack is never asked about the broken one.
      expect(git(root, ['config', 'remote.origin.fetch'])).toBe(
        '+refs/heads/dev:refs/remotes/origin/dev',
      )
      const remoteRefs = git(root, [
        'for-each-ref',
        'refs/remotes/origin',
        '--format=%(refname)',
      ]).split('\n')
      expect(remoteRefs).toContain('refs/remotes/origin/dev')
      expect(remoteRefs.join('\n')).not.toContain('queen-1291')

      // FR-003: the broken ref still exists, byte for byte, still pointing
      // at an object that is not there. Success did not come from repairing
      // it, and preparation must not prune it either.
      const after = readFileSync(refPath)
      expect(after.equals(planted)).toBe(true)
      expect(after.toString()).toBe(`${MISSING_OBJECT}\n`)
      expect(runGit(origin, ['cat-file', '-e', MISSING_OBJECT]).code).not.toBe(
        0,
      )
    } finally {
      spy.restore()
      restore()
    }
  })
})
