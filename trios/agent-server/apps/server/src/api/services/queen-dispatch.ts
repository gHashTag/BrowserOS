/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Starting the bee, not just picking it.
 *
 * The tick could choose long before it could dispatch, and a supervisor that
 * chooses without starting anything is a supervisor in name. This is the other
 * half: an isolated checkout, a briefing, and an agent turn that runs where the
 * files are.
 *
 * THE ORDER HERE IS THE DESIGN. Credentials are checked FIRST, before git is
 * touched at all. A worktree cut for a bee that cannot run is litter on a
 * volume, and a refusal that arrives after side effects is one somebody has to
 * clean up before they can even read it. Refusing costs nothing; refusing
 * halfway costs a directory and a branch.
 *
 * WHAT THIS CANNOT DO, and it is not a coding gap: the container holds no push
 * credential, by design. A bee commits inside it, and the commit leaves as a
 * patch that the Mac replays and pushes - proven end to end on 2026-08-29. So
 * dispatch here produces work that is finished but not yet published, and the
 * publication step still belongs to a machine that has the credential.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { logger } from '../../lib/logger'

/**
 * Providers this deployment could use, in preference order, with the variable
 * that carries each one's key.
 *
 * Read per call rather than captured at import: a platform that injects
 * variables after module load would otherwise be reported as unconfigured
 * forever, which is the same defect shape as a config file full of zero-length
 * keys - it looks configured and supplies nothing.
 */
const WORKER_PROVIDERS: Array<{
  provider: string
  envVar: string
  model: string
}> = [
  { provider: 'zai', envVar: 'ZAI_API_KEY', model: 'glm-4.6' },
  {
    provider: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-5',
  },
  {
    provider: 'openrouter',
    envVar: 'OPENROUTER_API_KEY',
    model: 'anthropic/claude-sonnet-4.5',
  },
  {
    provider: 'moonshot',
    envVar: 'MOONSHOT_API_KEY',
    model: 'kimi-k2-0905-preview',
  },
  { provider: 'openai', envVar: 'OPENAI_API_KEY', model: 'gpt-5' },
]

export interface WorkerProvider {
  provider: string
  model: string
}

/**
 * The first provider this deployment can actually pay for.
 *
 * An empty string counts as absent. `~/.trios/config.json` on the operator's
 * Mac has held two provider keys with ZERO-LENGTH values for months: it reads
 * as configured everywhere that checks for the name and supplies nothing to
 * anything that reads the value. The same trap exists in a platform's variable
 * editor, where saving an empty box leaves the name behind.
 */
export function resolveWorkerProvider(): WorkerProvider | null {
  const override = process.env.TRIOS_QUEEN_WORKER_MODEL
  for (const candidate of WORKER_PROVIDERS) {
    const key = process.env[candidate.envVar]
    if (key && key.length > 0) {
      return {
        provider: candidate.provider,
        model: override || candidate.model,
      }
    }
  }
  return null
}

/** One line naming what is missing, and who can supply it. */
export function missingProviderRefusal(): string {
  return (
    'no provider credential in this deployment - set one of ' +
    WORKER_PROVIDERS.map((p) => p.envVar).join(', ') +
    '. Only the operator can: a key typed by anything else is a key that ' +
    'passed through a place it should not have.'
  )
}

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd })
    let out = ''
    const done = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    child.on('error', (e) => {
      clearTimeout(done)
      resolve({ code: -1, out: String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(done)
      resolve({ code: code ?? -1, out: out.trim() })
    })
  })
}

export function workspaceRoot(): string {
  return `${process.env.WORKSPACE_DIR || '/workspace'}/BrowserOS`
}

/**
 * An isolated checkout for one bee.
 *
 * Not a nicety. Two bees sharing a checkout is the failure this whole branch
 * kept re-learning: neither the resume path nor the send-back path prepared a
 * worktree, so two workers edited the same files and each committed the other's
 * half-finished work. The worktree IS the isolation - the boundary rules only
 * decide who is allowed to want a file.
 *
 * Idempotent: an existing worktree for this issue is reused rather than
 * treated as an error, because a round that crashed after cutting one must be
 * able to run again.
 */
export async function prepareWorktree(
  issue: number,
): Promise<{ ok: boolean; path: string; detail: string }> {
  const root = workspaceRoot()
  const branch = `queen-${issue}`
  const path = `${root}/.worktrees/${branch}`

  const existing = await run('git', ['worktree', 'list', '--porcelain'], root)
  if (existing.out.includes(path)) {
    return { ok: true, path, detail: 'reused an existing worktree' }
  }

  const fetched = await run(
    'git',
    ['fetch', '--quiet', 'origin'],
    root,
    180_000,
  )
  if (fetched.code !== 0) {
    return {
      ok: false,
      path,
      detail: `git fetch failed: ${fetched.out.slice(0, 200)}`,
    }
  }

  const base = process.env.TRIOS_REPO_REF || 'origin/dev'
  const added = await run(
    'git',
    ['worktree', 'add', '-B', branch, path, base],
    root,
    180_000,
  )
  if (added.code !== 0) {
    return {
      ok: false,
      path,
      detail: `git worktree add failed: ${added.out.slice(0, 300)}`,
    }
  }
  return { ok: true, path, detail: `cut from ${base}` }
}

/**
 * The turn, over this server's own HTTP surface.
 *
 * In-process would be fewer moving parts and the wrong choice: `/chat` is where
 * auth, model resolution, persistence and tool wiring are decided, and a second
 * entry point past all of that is a second set of rules that agrees until it
 * does not. The bee gets in the same way every other client does, with the same
 * token, through the same gate.
 *
 * The stream is drained in the background. Dropping the connection would cancel
 * the turn, and blocking the round on it would mean one bee's half hour is the
 * whole hive's half hour.
 */
async function startTurn(
  conversationId: string,
  brief: string,
  workingDirectory: string,
  chosen: WorkerProvider,
): Promise<{ ok: boolean; detail: string }> {
  const token = process.env.TRIOS_API_TOKEN
  if (!token)
    return {
      ok: false,
      detail: 'this server has no TRIOS_API_TOKEN to call itself with',
    }
  const port = process.env.PORT || '8080'

  try {
    const response = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        conversationId,
        message: brief,
        mode: 'agent',
        origin: 'sidepanel',
        provider: chosen.provider,
        model: chosen.model,
        workingDirectory,
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        ok: false,
        detail: `chat answered ${response.status}: ${body.slice(0, 200)}`,
      }
    }
    void drain(response, conversationId)
    return { ok: true, detail: 'turn accepted' }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function drain(
  response: Response,
  conversationId: string,
): Promise<void> {
  try {
    const reader = response.body?.getReader()
    if (!reader) return
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
    logger.info('Queen worker turn finished', { conversationId })
  } catch (error) {
    logger.warn('Queen worker stream ended badly', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export interface DispatchOutcome {
  started: boolean
  issue: number
  branch: string
  detail: string
  conversationId?: string
}

/**
 * Choose already made; this starts the bee or says precisely why it did not.
 */
export async function dispatchBee(
  pool: Pool,
  issue: number,
  brief: string,
  ownedPaths: string[],
): Promise<DispatchOutcome> {
  const branch = `queen-${issue}`

  const chosen = resolveWorkerProvider()
  if (!chosen) {
    const detail = missingProviderRefusal()
    logger.warn('Queen tick chose an issue but cannot dispatch', {
      issue,
      detail,
    })
    await recordDispatch(pool, issue, branch, false, detail, ownedPaths)
    return { started: false, issue, branch, detail }
  }

  const worktree = await prepareWorktree(issue)
  if (!worktree.ok) {
    await recordDispatch(
      pool,
      issue,
      branch,
      false,
      worktree.detail,
      ownedPaths,
    )
    return { started: false, issue, branch, detail: worktree.detail }
  }

  // The PROJECT inside the checkout, not the checkout root. A worktree is a
  // clone of the repository and this project is a directory inside it, so
  // standing at the root makes every project-relative boundary resolve one
  // level too high - the bee writes `<worktree>/docs/x.md` where the committer
  // looks for `trios/docs/x.md`, and its work reads as no work at all.
  const workingDirectory = `${worktree.path}/trios`

  const conversationId = randomUUID()
  const turn = await startTurn(conversationId, brief, workingDirectory, chosen)
  const detail = turn.ok
    ? `${worktree.detail}; ${chosen.provider}/${chosen.model}`
    : turn.detail

  await recordDispatch(
    pool,
    issue,
    branch,
    turn.ok,
    detail,
    ownedPaths,
    conversationId,
  )
  logger.info('Queen dispatch', { issue, branch, started: turn.ok, detail })
  return { started: turn.ok, issue, branch, detail, conversationId }
}

async function recordDispatch(
  pool: Pool,
  issue: number,
  branch: string,
  started: boolean,
  detail: string,
  ownedPaths: string[],
  conversationId?: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO queen_dispatch
       (issue, branch, started, detail, owned_paths, conversation_id, dispatched_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
     ON CONFLICT (issue) DO UPDATE
       SET branch = EXCLUDED.branch,
           started = EXCLUDED.started,
           detail = EXCLUDED.detail,
           owned_paths = EXCLUDED.owned_paths,
           conversation_id = EXCLUDED.conversation_id,
           dispatched_at = EXCLUDED.dispatched_at`,
    [
      issue,
      branch,
      started,
      detail,
      JSON.stringify(ownedPaths),
      conversationId ?? null,
    ],
  )
}
