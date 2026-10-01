import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { Pool } from 'pg'

import { createQueenRunnerRoute } from '../../src/api/routes/queen-runners'
import { dispatchBee } from '../../src/api/services/queen-dispatch'
import {
  bringBranchHome,
  type claimRunnerWork,
  completeRunnerWork,
  offerToRunner,
  parseCompleteBody,
  publicRepoUrl,
  RUNNER_WORKDIR_PLACEHOLDER,
  type RunnerGit,
  runnerStart,
} from '../../src/api/services/queen-runner-work'
import {
  hashRunnerToken,
  laneOf,
  mintRunnerToken,
} from '../../src/api/services/queen-runners'

/**
 * A runner takes a task from the round, runs it on its owner's machine and
 * hands back a pushed branch, which the existing review then judges. These
 * tests hold the hand-off to three promises: a runner is only given work it
 * can actually continue, it can only hand back its OWN task, and nothing it
 * hands back reaches the branch the review reads until every check has passed.
 */

// ---------------------------------------------------------------------------
// Real git in a scratch directory. The fetch is the one call rewritten: the
// service only fetches from https://github.com, and a test has no network, so
// the GitHub address is mapped onto a local "fork" and the https-only pin is
// dropped for that one call. Every other git call runs as written.
// ---------------------------------------------------------------------------
const GIT_ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

const FORK_URL = 'https://github.com/alice/trios.git'

function realGit(root: string, fork: string, base: string): RunnerGit {
  return {
    root: () => root,
    exists: existsSync,
    base: async () => base,
    git: async (cwd, args) => {
      let argv = args
      if (args.includes('fetch')) {
        argv = []
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === '-c' && args[i + 1] === 'protocol.allow=never') {
            i += 1
            continue
          }
          argv.push(args[i] === FORK_URL ? fork : args[i])
        }
      }
      const r = spawnSync('git', argv, { cwd, encoding: 'utf8' })
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`.trim() }
    },
  }
}

let dir: string
let root: string
let fork: string
let base: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'queen-runner-work-'))
  root = join(dir, 'BrowserOS')
  fork = join(dir, 'fork')
  spawnSync('git', ['init', '-q', '-b', 'dev', root])
  writeFileSync(join(root, 'README.md'), 'base\n')
  sh(root, 'add', '.')
  sh(root, 'commit', '-qm', 'base')
  base = sh(root, 'rev-parse', 'HEAD')
  spawnSync('git', ['clone', '-q', root, fork])
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A commit on a branch of the fork, as a runner would push it. */
function runnerCommit(branch: string, from = base): string {
  sh(fork, 'checkout', '-q', '-B', branch, from)
  writeFileSync(join(fork, 'work.txt'), `work on ${branch}\n`)
  sh(fork, 'add', '.')
  sh(fork, 'commit', '-qm', 'the runner did the work')
  return sh(fork, 'rev-parse', 'HEAD')
}

// ---------------------------------------------------------------------------
// A recording pool that answers by statement shape.
// ---------------------------------------------------------------------------
type Answer = { rows: Record<string, unknown>[]; rowCount: number }
function recordingPool(
  answer: (sql: string, params: unknown[]) => Answer | undefined,
) {
  const asked: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    asked,
    async query(sql: string, params: unknown[] = []) {
      asked.push({ sql, params })
      return answer(sql, params) ?? { rows: [], rowCount: 0 }
    },
  }
  return pool as typeof pool & Pool
}

const writes = (asked: Array<{ sql: string }>, table: string) =>
  asked.filter((q) =>
    new RegExp(`^\\s*(INSERT INTO|UPDATE) ${table}\\b`).test(q.sql),
  )

describe('which tasks a runner may take', () => {
  it('starts from the base when the issue has no branch yet', async () => {
    const pool = recordingPool(() => undefined)
    expect(await runnerStart(pool, 42, realGit(root, fork, base))).toEqual({
      sha: base,
    })
  })

  it('starts from the base when the branch holds nothing the base lacks', async () => {
    sh(root, 'branch', 'queen-42', base)
    const pool = recordingPool(() => undefined)
    expect(await runnerStart(pool, 42, realGit(root, fork, base))).toEqual({
      sha: base,
    })
  })

  it('keeps an issue whose branch holds this container’s own commits', async () => {
    sh(root, 'checkout', '-q', '-b', 'queen-42')
    writeFileSync(join(root, 'local.txt'), 'a container bee wrote this\n')
    sh(root, 'add', '.')
    sh(root, 'commit', '-qm', 'local work')
    sh(root, 'checkout', '-q', 'dev')
    const pool = recordingPool(() => ({
      rows: [{ runner_head: null, runner_remote: null, runner_branch: null }],
      rowCount: 1,
    }))
    expect(await runnerStart(pool, 42, realGit(root, fork, base))).toBeNull()
  })

  it('continues a runner’s own previous push when the review sent it back', async () => {
    const head = runnerCommit('queen-42')
    sh(root, 'fetch', '-q', fork, `queen-42:queen-42`)
    const pool = recordingPool(() => ({
      rows: [
        {
          runner_head: head,
          runner_remote: FORK_URL,
          runner_branch: 'queen-42',
        },
      ],
      rowCount: 1,
    }))
    expect(await runnerStart(pool, 42, realGit(root, fork, base))).toEqual({
      sha: head,
      remote: FORK_URL,
      branch: 'queen-42',
    })
  })

  it('keeps an issue whose worktree holds uncommitted edits', async () => {
    sh(
      root,
      'worktree',
      'add',
      '-q',
      '-b',
      'queen-42',
      join(root, '.worktrees/queen-42'),
      base,
    )
    writeFileSync(join(root, '.worktrees/queen-42/half.txt'), 'half done\n')
    const pool = recordingPool(() => undefined)
    expect(await runnerStart(pool, 42, realGit(root, fork, base))).toBeNull()
  })
})

describe('the offer', () => {
  const input = {
    issue: 42,
    branch: 'queen-42',
    brief: 'Do issue 42.',
    ownedPaths: ['docs/'],
    criteria: ['it works'],
    criteriaSource: 'stated',
  }

  it('is not made when no runner is idle, and books nothing', async () => {
    const pool = recordingPool(() => undefined)
    expect(await offerToRunner(pool, input, realGit(root, fork, base))).toBe(
      null,
    )
    expect(writes(pool.asked, 'queen_dispatch')).toEqual([])
  })

  it('books the dispatch on the runner’s lane with its brief and its start', async () => {
    const pool = recordingPool((sql) => {
      if (/FROM queen_runner r/.test(sql))
        return {
          rows: [{ id: 7, label: 'laptop', owner_name: 'Alice' }],
          rowCount: 1,
        }
      if (/^\s*UPDATE queen_dispatch\s+SET runner_brief/.test(sql))
        return { rows: [], rowCount: 1 }
      return undefined
    })
    const outcome = await offerToRunner(pool, input, realGit(root, fork, base))
    expect(outcome?.started).toBe(true)
    expect(outcome?.keyIndex).toBe(laneOf(7))
    expect(outcome?.detail).toBe('offered to runner 7 (laptop) of Alice')

    const booked = writes(pool.asked, 'queen_dispatch')
    // The dispatch row, then the offer stored on it.
    expect(booked).toHaveLength(2)
    expect(booked[0].params[2]).toBe(true) // started
    expect(booked[0].params[6]).toBe(laneOf(7)) // key_index
    // No provider and no model: the lender's spend is not the operator's.
    expect(booked[0].params[9]).toBeNull()
    expect(booked[0].params[10]).toBeNull()
    const [, conversation, brief, prompt, startSha] = booked[1]
      .params as string[]
    expect(conversation).toBe(outcome?.conversationId as string)
    expect(brief).toBe('Do issue 42.')
    expect(prompt).toContain(RUNNER_WORKDIR_PLACEHOLDER)
    expect(startSha).toBe(base)
  })

  it('comes before the container: an offered task cuts no worktree and asks for no key', async () => {
    const pool = recordingPool(() => undefined)
    const outcome = await dispatchBee(
      pool,
      42,
      'brief',
      [],
      [],
      undefined,
      [],
      'none',
      {
        offer: async () => ({
          started: true,
          issue: 42,
          branch: 'queen-42',
          detail: 'offered to runner 7 (laptop) of Alice',
          conversationId: '00000000-0000-4000-8000-000000000001',
          keyIndex: laneOf(7),
        }),
        memory: () => {
          throw new Error('the container must not be measured')
        },
      },
    )
    expect(outcome.started).toBe(true)
    expect(outcome.keyIndex).toBe(laneOf(7))
  })

  it('in the runner-only pass, a task no runner takes is neither started nor booked', async () => {
    const pool = recordingPool(() => undefined)
    const outcome = await dispatchBee(
      pool,
      42,
      'brief',
      [],
      [],
      undefined,
      [],
      'none',
      { offer: async () => null, runnerOnly: true },
    )
    expect(outcome.started).toBe(false)
    expect(outcome.detail).toBe('no runner is free to take it')
    expect(pool.asked).toEqual([])
  })
})

describe('what a runner may hand back', () => {
  const id = '6f1c2f9e-3b1d-4c55-9d5c-0a7f1d2e3b4c'
  const sha = 'a'.repeat(40)

  it('accepts a branch on github.com over https', () => {
    expect(
      parseCompleteBody({
        conversationId: id,
        remoteUrl: FORK_URL,
        branch: 'queen-42',
        headSha: sha,
        said: '## VERDICT',
        tokens: { inputTokens: 10, outputTokens: 2 },
      }),
    ).toEqual({
      conversationId: id,
      remoteUrl: FORK_URL,
      branch: 'queen-42',
      headSha: sha,
      said: '## VERDICT',
      tokens: { inputTokens: 10, outputTokens: 2 },
    })
  })

  it.each([
    ['file:///etc', 'remoteUrl'],
    ['git@github.com:alice/trios.git', 'remoteUrl'],
    ['https://gitlab.com/alice/trios', 'remoteUrl'],
    ['https://github.com.evil.example/alice/trios', 'remoteUrl'],
    ['https://user:pw@github.com/alice/trios', 'remoteUrl'],
    ['ext::sh -c touch% /tmp/pwned', 'remoteUrl'],
  ])('refuses %s as a remote', (remoteUrl) => {
    expect(
      parseCompleteBody({
        conversationId: id,
        remoteUrl,
        branch: 'queen-42',
        headSha: sha,
      }),
    ).toHaveProperty('error')
  })

  it.each([
    '--upload-pack=x',
    'a..b',
    'x@{1}',
    'ends/',
    'has space',
    '',
  ])('refuses %p as a branch', (branch) => {
    expect(
      parseCompleteBody({
        conversationId: id,
        remoteUrl: FORK_URL,
        branch,
        headSha: sha,
      }),
    ).toHaveProperty('error')
  })

  it('refuses an abbreviated commit and a missing conversation', () => {
    expect(
      parseCompleteBody({
        conversationId: id,
        remoteUrl: FORK_URL,
        branch: 'queen-42',
        headSha: 'abc1234',
      }),
    ).toHaveProperty('error')
    expect(parseCompleteBody({ remoteUrl: FORK_URL })).toHaveProperty('error')
  })

  it('takes a give-up without a branch', () => {
    expect(
      parseCompleteBody({ conversationId: id, gaveUp: true, reason: 'no key' }),
    ).toEqual({
      conversationId: id,
      gaveUp: true,
      reason: 'no key',
      tokens: undefined,
    })
  })

  it('never tells a runner the credentials in the project URL', () => {
    const saved = process.env.TRIOS_REPO_URL
    process.env.TRIOS_REPO_URL =
      'https://x-access-token:ghs_secret@github.com/gHashTag/BrowserOS.git'
    try {
      expect(publicRepoUrl()).toBe('https://github.com/gHashTag/BrowserOS.git')
    } finally {
      if (saved === undefined) delete process.env.TRIOS_REPO_URL
      else process.env.TRIOS_REPO_URL = saved
    }
  })
})

describe('bringing the branch home', () => {
  it('puts the pushed commit at queen-<issue> and leaves no scratch ref', async () => {
    const head = runnerCommit('feat-42')
    const moved = await bringBranchHome(
      42,
      FORK_URL,
      'feat-42',
      head,
      base,
      realGit(root, fork, base),
    )
    expect(moved).toEqual({ ok: true })
    expect(sh(root, 'rev-parse', 'queen-42')).toBe(head)
    expect(
      spawnSync(
        'git',
        ['rev-parse', '--verify', '-q', 'refs/runner/queen-42'],
        {
          cwd: root,
        },
      ).status,
    ).not.toBe(0)
  })

  it('refuses a branch that is not at the commit the runner named', async () => {
    runnerCommit('feat-42')
    const moved = await bringBranchHome(
      42,
      FORK_URL,
      'feat-42',
      'b'.repeat(40),
      base,
      realGit(root, fork, base),
    )
    expect(moved.ok).toBe(false)
    expect(
      spawnSync('git', ['rev-parse', '--verify', '-q', 'queen-42'], {
        cwd: root,
      }).status,
    ).not.toBe(0)
  })

  it('refuses work that does not descend from where the task started', async () => {
    // An unrelated history: the runner did not start from the offered commit.
    sh(fork, 'checkout', '-q', '--orphan', 'elsewhere')
    sh(fork, 'rm', '-rqf', '.')
    writeFileSync(join(fork, 'other.txt'), 'unrelated\n')
    sh(fork, 'add', '.')
    sh(fork, 'commit', '-qm', 'unrelated')
    const head = sh(fork, 'rev-parse', 'HEAD')
    const moved = await bringBranchHome(
      42,
      FORK_URL,
      'elsewhere',
      head,
      base,
      realGit(root, fork, base),
    )
    expect(moved.ok).toBe(false)
    if (!moved.ok) expect(moved.error).toMatch(/does not descend/)
  })

  it('moves a clean worktree that has the branch checked out along with it', async () => {
    const tree = join(root, '.worktrees/queen-42')
    sh(root, 'worktree', 'add', '-q', '-b', 'queen-42', tree, base)
    const head = runnerCommit('feat-42')
    const moved = await bringBranchHome(
      42,
      FORK_URL,
      'feat-42',
      head,
      base,
      realGit(root, fork, base),
    )
    expect(moved).toEqual({ ok: true })
    expect(sh(tree, 'rev-parse', 'HEAD')).toBe(head)
    // Not dirty: the tree describes the commit, so no salvage reads it as edits.
    expect(sh(tree, 'status', '--porcelain')).toBe('')
  })
})

describe('completing a task', () => {
  const conversationId = '6f1c2f9e-3b1d-4c55-9d5c-0a7f1d2e3b4c'

  const openTask = (startSha: string) =>
    recordingPool((sql) => {
      if (/^\s*SELECT issue, runner_start_sha FROM queen_dispatch/.test(sql))
        return {
          rows: [{ issue: 42, runner_start_sha: startSha }],
          rowCount: 1,
        }
      if (/^\s*UPDATE queen_dispatch\s+SET finished_at/.test(sql))
        return { rows: [], rowCount: 1 }
      return undefined
    })

  it('moves the branch, writes what the agent said, and only then closes the row', async () => {
    const head = runnerCommit('feat-42')
    const pool = openTask(base)
    const said = `Done.\n\n## VERDICT\n- 1. it works: met\n${'x'.repeat(9000)}`
    const result = await completeRunnerWork(
      pool,
      7,
      {
        conversationId,
        remoteUrl: FORK_URL,
        branch: 'feat-42',
        headSha: head,
        said,
        tokens: { inputTokens: 100, outputTokens: 20 },
      },
      realGit(root, fork, base),
    )
    expect(result).toEqual({ ok: true, issue: 42, closed: true })
    expect(sh(root, 'rev-parse', 'queen-42')).toBe(head)

    // Only this runner's lane is asked for the task.
    expect(pool.asked[0].params).toEqual([conversationId, laneOf(7)])

    const transcript = writes(pool.asked, 'queen_transcript')
    expect(transcript.map((q) => [q.params[1], q.params[3]])).toEqual([
      [1, 'tool'],
      [2, 'say'],
      [3, 'say'],
    ])
    expect(
      transcript
        .filter((q) => q.params[3] === 'say')
        .map((q) => q.params[4])
        .join(''),
    ).toBe(said)

    const dispatch = writes(pool.asked, 'queen_dispatch')
    // runner_head recorded, then the ending - in that order.
    expect(dispatch.map((q) => /SET finished_at/.test(q.sql))).toEqual([
      false,
      true,
    ])
    expect(dispatch[0].params).toEqual([
      conversationId,
      FORK_URL,
      'feat-42',
      head,
    ])
    expect(dispatch[1].params.slice(1, 4)).toEqual(['finished', 100, 20])
  })

  it('leaves the task open when the branch cannot be brought home', async () => {
    runnerCommit('feat-42')
    const pool = openTask(base)
    const result = await completeRunnerWork(
      pool,
      7,
      {
        conversationId,
        remoteUrl: FORK_URL,
        branch: 'feat-42',
        headSha: 'c'.repeat(40),
        said: '## VERDICT',
      },
      realGit(root, fork, base),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(422)
    expect(writes(pool.asked, 'queen_dispatch')).toEqual([])
    expect(writes(pool.asked, 'queen_transcript')).toEqual([])
  })

  it('answers 404 for a task that is not this runner’s', async () => {
    const pool = recordingPool(() => undefined)
    const result = await completeRunnerWork(
      pool,
      8,
      { conversationId, gaveUp: true, reason: '' },
      realGit(root, fork, base),
    )
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: 'No open task of this runner has that conversation',
    })
    expect(writes(pool.asked, 'queen_dispatch')).toEqual([])
  })

  it('a give-up releases the issue with the reaped label', async () => {
    const pool = openTask(base)
    const result = await completeRunnerWork(
      pool,
      7,
      { conversationId, gaveUp: true, reason: 'my key ran out' },
      realGit(root, fork, base),
    )
    expect(result).toEqual({ ok: true, issue: 42, closed: true })
    const [ending] = writes(pool.asked, 'queen_dispatch')
    expect(String(ending.params[1])).toMatch(/^reaped/)
  })
})

// ---------------------------------------------------------------------------
// The routes, against a small in-memory pair of tables.
// ---------------------------------------------------------------------------
describe('the runner routes', () => {
  function tables() {
    const minted = mintRunnerToken()
    const runner = {
      id: 7,
      telegram_id: '111',
      owner_name: 'Alice',
      label: 'laptop',
      token_hash: minted.hash,
      token_hint: minted.hint,
      created_at: new Date(),
      last_seen_at: null as Date | null,
      revoked_at: null as Date | null,
    }
    const task = {
      issue: 42,
      branch: 'queen-42',
      conversation_id: '6f1c2f9e-3b1d-4c55-9d5c-0a7f1d2e3b4c',
      key_index: laneOf(7),
      finished: false,
      runner_brief: 'Do issue 42.',
      runner_system_prompt: `Your repository is ${RUNNER_WORKDIR_PLACEHOLDER}.`,
      runner_start_sha: 'd'.repeat(40),
      runner_start_remote: null,
      runner_start_branch: null,
      runner_claimed_at: null as Date | null,
      runner_lease_at: null as Date | null,
      owned_paths: ['docs/'],
      criteria: ['it works'],
    }
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        if (/^\s*UPDATE queen_runner SET last_seen_at/.test(sql)) {
          const hit =
            params[0] === runner.token_hash && runner.revoked_at === null
          if (hit) runner.last_seen_at = new Date()
          return { rows: hit ? [runner] : [], rowCount: hit ? 1 : 0 }
        }
        const mine =
          params[0] === task.key_index && !task.finished && task.runner_brief
        if (/SET runner_lease_at = CASE/.test(sql)) {
          if (!mine) return { rows: [], rowCount: 0 }
          if (task.runner_claimed_at) task.runner_lease_at = new Date()
          return { rows: [task], rowCount: 1 }
        }
        if (/SET runner_claimed_at = coalesce/.test(sql)) {
          if (!mine) return { rows: [], rowCount: 0 }
          task.runner_claimed_at ??= new Date()
          task.runner_lease_at = new Date()
          return { rows: [task], rowCount: 1 }
        }
        throw new Error(`unexpected SQL ${sql}`)
      },
    }
    return { pool, runner, task, token: minted.token }
  }

  const post = (token: string, body?: unknown): RequestInit => ({
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  function server(t = tables(), complete = completeRunnerWork) {
    return new Hono().route(
      '/queen/runner',
      createQueenRunnerRoute({
        pool: () => t.pool,
        identify: async () => null,
        complete,
      }),
    )
  }

  it('tells the runner a task is waiting, hands it over on claim, then renews its lease', async () => {
    const t = tables()
    const app = server(t)

    const first = await app.request('/queen/runner/heartbeat', post(t.token))
    expect(first.status).toBe(200)
    expect(((await first.json()) as { work: unknown }).work).toEqual({
      issue: 42,
      conversationId: t.task.conversation_id,
      claimed: false,
    })
    // Telling is not claiming: no lease starts until the runner asks.
    expect(t.task.runner_lease_at).toBeNull()

    const claim = await app.request('/queen/runner/claim', post(t.token))
    const { work } = (await claim.json()) as {
      work: Awaited<ReturnType<typeof claimRunnerWork>>
    }
    expect(work?.issue).toBe(42)
    expect(work?.brief).toBe('Do issue 42.')
    expect(work?.systemPrompt).toContain(RUNNER_WORKDIR_PLACEHOLDER)
    expect(work?.start).toEqual({ sha: 'd'.repeat(40) })
    expect(work?.ownedPaths).toEqual(['docs/'])
    expect(t.task.runner_claimed_at).not.toBeNull()

    t.task.runner_lease_at = new Date(0)
    const again = await app.request('/queen/runner/heartbeat', post(t.token))
    expect(
      ((await again.json()) as { work: { claimed: boolean } }).work.claimed,
    ).toBe(true)
    expect(t.task.runner_lease_at?.getTime()).toBeGreaterThan(0)
  })

  it('refuses every call without a live runner token', async () => {
    const t = tables()
    const app = server(t)
    for (const path of ['heartbeat', 'claim', 'complete']) {
      const res = await app.request(
        `/queen/runner/${path}`,
        post(mintRunnerToken().token, {}),
      )
      expect(res.status).toBe(401)
    }
    t.runner.revoked_at = new Date()
    const revoked = await app.request('/queen/runner/claim', post(t.token))
    expect(revoked.status).toBe(401)
    // The hash is the only thing the table holds.
    expect(t.runner.token_hash).toBe(hashRunnerToken(t.token))
  })

  it('checks a completion body before anything touches git', async () => {
    const t = tables()
    let called = 0
    const app = server(t, async () => {
      called += 1
      return { ok: true, issue: 42, closed: true }
    })
    const bad = await app.request(
      '/queen/runner/complete',
      post(t.token, {
        conversationId: t.task.conversation_id,
        remoteUrl: 'file:///etc',
        branch: 'x',
        headSha: 'e'.repeat(40),
      }),
    )
    expect(bad.status).toBe(400)
    expect(called).toBe(0)

    const good = await app.request(
      '/queen/runner/complete',
      post(t.token, {
        conversationId: t.task.conversation_id,
        remoteUrl: FORK_URL,
        branch: 'queen-42',
        headSha: 'e'.repeat(40),
        said: '## VERDICT',
      }),
    )
    expect(good.status).toBe(200)
    expect(called).toBe(1)
  })
})
