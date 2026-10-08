/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A new attempt starts from the branch it inherits (specs/queen/control.t27
 * section 6, gHashTag/t27#6657), held against real git: a scratch origin, a
 * clone where the Queen's workspace would be, and the remote queen-<issue> tip
 * in each of the three shapes the cut can meet.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  attemptStart,
  ST_BASE,
  ST_HOLD,
  ST_TIP,
  TIP_ACCEPTED,
  TIP_NONE,
  TIP_PR_CLOSED,
  TIP_SENT_BACK,
  TIP_UNJUDGED,
} from '../../src/api/services/queen-control-rules'
import { prepareWorktree } from '../../src/api/services/queen-dispatch'

const ISSUE = 6657

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Bee',
      GIT_AUTHOR_EMAIL: 'bee@example.com',
      GIT_COMMITTER_NAME: 'Bee',
      GIT_COMMITTER_EMAIL: 'bee@example.com',
    },
  }).trim()
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// test a_re_dispatch_inherits_the_tip_and_never_restarts_waiting_work
describe('attempt_start mirrors its spec', () => {
  it('starts from the base, from the tip, or holds', () => {
    expect(attemptStart(TIP_NONE)).toBe(ST_BASE)
    expect(attemptStart(TIP_UNJUDGED)).toBe(ST_HOLD)
    expect(attemptStart(TIP_ACCEPTED)).toBe(ST_HOLD)
    expect(attemptStart(TIP_SENT_BACK)).toBe(ST_TIP)
    expect(attemptStart(TIP_PR_CLOSED)).toBe(ST_TIP)
    expect(attemptStart(99)).toBe(ST_HOLD)
  })
})

describe('a fresh cut starts where the previous attempt left off', () => {
  let scratch = ''
  let seed = ''
  let origin = ''
  const saved = { ...process.env }

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'queen-attempt-start-'))
    origin = join(scratch, 'origin.git')
    git(scratch, ['init', '-q', '--bare', 'origin.git'])
    seed = join(scratch, 'seed')
    mkdirSync(seed)
    git(seed, ['init', '-q', '-b', 'dev'])
    write(join(seed, 'README.md'), 'the root\n')
    git(seed, ['add', '.'])
    git(seed, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'first'])
    git(seed, ['push', '-q', origin, 'dev'])
    git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/dev'])
    git(scratch, ['clone', '-q', origin, 'BrowserOS'])

    process.env.WORKSPACE_DIR = scratch
    process.env.TRIOS_REPO_REF = 'origin/dev'
    delete process.env.TRIOS_REPO_URL
    delete process.env.TRIOS_REPO_SUBDIR
    process.env.TRIOS_MODULE_STORE = join(scratch, 'no-such-store')
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  })

  afterEach(() => {
    process.env = { ...saved }
    rmSync(scratch, { recursive: true, force: true })
  })

  /** Push a queen-<issue> branch to the origin, with or without its own work. */
  const pushTip = (ownWork: boolean): string => {
    git(seed, ['checkout', '-q', '-b', `queen-${ISSUE}`])
    if (ownWork) {
      write(join(seed, 'trios/docs/attempt.md'), 'the first attempt\n')
      git(seed, ['add', '.'])
      git(seed, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'attempt 1'])
    }
    git(seed, ['push', '-q', origin, `queen-${ISSUE}`])
    return git(seed, ['rev-parse', 'HEAD'])
  }

  it('cuts from the base when no tip exists', async () => {
    const cut = await prepareWorktree(ISSUE, { volumeUsed: () => 10 })
    expect(cut.ok).toBe(true)
    expect(cut.detail).toContain('cut from origin/dev')
    expect(git(cut.path, ['rev-parse', 'HEAD'])).toBe(
      git(seed, ['rev-parse', 'dev']),
    )
  })

  it('cuts from the base when the tip is already in it', async () => {
    pushTip(false)
    const cut = await prepareWorktree(ISSUE, { volumeUsed: () => 10 })
    expect(cut.ok).toBe(true)
    expect(cut.detail).toContain('cut from origin/dev')
  })

  it('continues from a tip that carries work of its own', async () => {
    const tip = pushTip(true)
    const cut = await prepareWorktree(ISSUE, { volumeUsed: () => 10 })
    expect(cut.ok).toBe(true)
    expect(cut.detail).toContain(`cut from origin/queen-${ISSUE}`)
    // The new attempt descends from the tip, so its push is a fast-forward
    // (attempt_push_lands): the previous attempt's commit is its HEAD.
    expect(git(cut.path, ['rev-parse', 'HEAD'])).toBe(tip)
    expect(git(cut.path, ['log', '--pretty=%s', '-1'])).toBe('attempt 1')
  })
})
