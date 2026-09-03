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
import { shellArgv, spawnEnv } from '../../tools/filesystem/bash'
import { workerSystemPrompt } from './queen-tick'

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
  { provider: 'zai', envVar: 'ZAI_API_KEY', model: 'glm-5.3' },
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
  baseUrl?: string
  /** This server's own token, when the turn is aimed back at this server. */
  apiKey?: string
  rehearsal?: boolean
  /** Which of this provider's keys was handed out, 0-based. */
  keyIndex?: number
  keyCount?: number
  /** Set when no index is left; carries how many keys are configured. */
  exhausted?: number
  /** Of those, how many are carrying a bee right now. */
  busy?: number
  /** Of those, how many the provider has refused. */
  refusedCount?: number
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
/**
 * Every key this deployment holds for one provider, in index order.
 *
 * `ZAI_API_KEY`, then `ZAI_API_KEY_2`, `_3`, `_4`, ... The unsuffixed name is
 * index 0 so a deployment with one key needs no migration and reads exactly as
 * it did.
 *
 * Empty strings are skipped rather than counted. A platform variable saved with
 * an empty box leaves the NAME behind, and a rotation that hands a bee index 2
 * because the name exists gives it nothing to authenticate with - the same trap
 * `~/.trios/config.json` has been sitting in for months.
 */
function keysFor(envVar: string): string[] {
  const keys: string[] = []
  const first = process.env[envVar]
  if (first && first.length > 0) keys.push(first)
  for (let i = 2; i <= 16; i++) {
    const next = process.env[`${envVar}_${i}`]
    if (next && next.length > 0) keys.push(next)
  }
  return keys
}

/**
 * A key per concurrent bee, not a key per request.
 *
 * Four bees sharing one credential share one rate limit, so the swarm's real
 * ceiling becomes whatever that single key allows rather than what the Queen's
 * policy permits - and the failure arrives as a 429 blamed on the work.
 *
 * Assignment is by SLOT, not by issue number. Issue numbers look random and are
 * not: the four issues in flight when this was written were 1176, 1216, 1240
 * and 1244, and every one of them is 0 mod 4. A hash of the issue would have
 * put all four bees on the same key and looked like rotation while doing
 * nothing.
 *
 * So the caller passes the indices already in use, and this returns the lowest
 * that is free. The index is stored with the dispatch, which is what makes a
 * retry attributable: the same bee comes back to the same key, and a key that
 * keeps failing is visible as a key rather than as four unlucky tasks.
 */
/**
 * Key indices this process has seen a provider refuse, per provider.
 *
 * In memory on purpose, and cleared by a restart. A key with no balance is a
 * fact about an account at a moment; persisting it would outlive a top-up and
 * shrink the swarm for a reason nobody could see. A restart is the cheapest
 * possible retry, and the deployment restarts often.
 *
 * Without this the rotation kept handing work to key 1 after it had refused
 * three turns in a row - #1323, #1324 and #1325, one frame each - because
 * nothing carried the refusal back to the chooser.
 */
const refusedKeys = new Map<string, Set<number>>()

/** Record that a provider refused this key, so the rotation stops offering it. */
export function noteKeyRefused(provider: string, index: number): void {
  const seen = refusedKeys.get(provider) ?? new Set<number>()
  seen.add(index)
  refusedKeys.set(provider, seen)
  logger.warn('Queen will stop handing out a refused key', {
    provider,
    keyIndex: index,
    refusedSoFar: [...seen],
  })
}

/**
 * Whether a credential can actually pay for a turn, asked before an issue is
 * spent on finding out.
 *
 * Measured 2026-09-03 with four keys configured: two answered HTTP 200 and two
 * answered 429 with Z.AI business code 1113, "Insufficient balance or no
 * resource package". Without this the rotation hands each dead key an issue,
 * the turn dies on its first frame, and the swarm learns by burning work -
 * once per key, per process. Two of the four keys were dead, so that is two
 * issues consumed to discover a fact one request answers.
 *
 * ONE request, one token, cached for the life of the process. The cache is
 * deliberately not persisted: a key with no balance is a fact about an account
 * at a moment, and a restart is the cheapest possible retry after a top-up.
 *
 * A network failure is NOT a refusal. If the probe cannot reach the provider at
 * all, the answer is "assume live" - refusing to dispatch because our own
 * network hiccuped would stall the swarm for a reason that has nothing to do
 * with the credential.
 */
const keyLiveness = new Map<string, boolean>()

export async function keyIsLive(chosen: WorkerProvider): Promise<boolean> {
  if (!chosen.apiKey || chosen.rehearsal) return true
  const slot = `${chosen.provider}:${chosen.keyIndex ?? 0}`
  const known = keyLiveness.get(slot)
  if (known !== undefined) return known
  const base =
    chosen.baseUrl ||
    process.env.ZAI_BASE_URL ||
    'https://api.z.ai/api/coding/paas/v4'
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${chosen.apiKey}`,
      },
      body: JSON.stringify({
        model: chosen.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    // 429 with business code 1113 is an exhausted package, and 401/403 is a key
    // that is not a key. Everything else - including a rate limit that is a
    // real rate limit - is a live credential having a bad moment.
    const body = response.ok ? '' : await response.text().catch(() => '')
    const dead =
      response.status === 401 ||
      response.status === 403 ||
      body.includes('1113') ||
      body.includes('Insufficient balance')
    keyLiveness.set(slot, !dead)
    if (dead) {
      logger.warn('Queen found a credential that cannot pay', {
        provider: chosen.provider,
        keyIndex: chosen.keyIndex,
        status: response.status,
        said: body.slice(0, 160),
      })
    }
    return !dead
  } catch (error) {
    logger.warn('Queen could not reach the provider to check a key', {
      provider: chosen.provider,
      keyIndex: chosen.keyIndex,
      error: error instanceof Error ? error.message : String(error),
    })
    return true
  }
}

/**
 * Forget every refusal, so a topped-up account is tried again without a restart.
 *
 * The cache is process-lifetime by design - a key with no balance is a fact
 * about an account at a moment - and until this existed the only way to clear
 * it was to restart the container. It is also what keeps tests honest: a
 * module-level cache leaks between them, and one did, making a check about a
 * healthy swarm fail because an earlier check had written a key off.
 */
export function clearRefusedKeys(): void {
  refusedKeys.clear()
  keyLiveness.clear()
}

/** For the board and for tests: which keys this process has written off. */
export function refusedKeyCount(provider = 'zai'): number {
  return (refusedKeys.get(provider) ?? new Set()).size
}

export function resolveWorkerProvider(
  takenKeyIndices: number[] = [],
): WorkerProvider | null {
  const override = process.env.TRIOS_QUEEN_WORKER_MODEL
  for (const candidate of WORKER_PROVIDERS) {
    const keys = keysFor(candidate.envVar)
    if (keys.length > 0) {
      // Busy OR refused. A key the provider has already turned down is not a
      // key: handing it out again spends an issue to learn the same fact.
      const refused = refusedKeys.get(candidate.provider) ?? new Set<number>()
      let index = 0
      while (
        index < keys.length &&
        (takenKeyIndices.includes(index) || refused.has(index))
      ) {
        index++
      }
      // No index left. BUSY and REFUSED are different reasons and the fix for
      // each is the opposite of the other, so they are counted apart.
      //
      // They were one number, and the live board showed what that costs: with
      // two bees running on the two credentials that can pay, the refusal read
      // "all 4 provider key(s) are already in use by bees in flight. Add
      // another with ZAI_API_KEY_5". Four were configured, two were carrying a
      // bee and two could not pay - and the operator was told to buy a fifth.
      if (index >= keys.length) {
        const refusedHere = [...refused].filter((i) => i < keys.length).length
        return {
          provider: candidate.provider,
          model: override || candidate.model,
          exhausted: keys.length,
          busy: takenKeyIndices.filter((i) => i < keys.length).length,
          refusedCount: refusedHere,
        }
      }
      const key = keys[index]
      // The key travels WITH the choice, and leaving it out was a real defect:
      // `/chat` resolves a provider from what the CALLER supplies, because its
      // usual caller is an app on someone's laptop holding its own credentials.
      // The server does not go looking in its own environment. So a deployment
      // with ZAI_API_KEY set got past the credential precheck and then died at
      // the chat route with the same sentence the precheck exists to prevent -
      //
      //   chat answered 500: "z.ai provider requires apiKey"
      //
      // - which reads like a missing key and was a key that was never handed
      // over. Measured on the first round after the operator set one.
      return {
        provider: candidate.provider,
        model: override || candidate.model,
        apiKey: key,
        keyIndex: index,
        keyCount: keys.length,
      }
    }
  }
  // No key anywhere. If this deployment has been told to rehearse, aim the
  // turn at the recorded stream inside this process instead of refusing.
  //
  // Explicitly opt-in, and it must never be the silent fallback on a
  // deployment that HAS a key: a hive that quietly rehearses instead of
  // working is worse than one that stops, because it reports success.
  if (process.env.TRIOS_QUEEN_REHEARSAL) {
    const port = process.env.PORT || '8080'
    return {
      provider: 'openai-compatible',
      model: override || 'rehearsal',
      baseUrl: `http://127.0.0.1:${port}/queen/rehearsal`,
      apiKey: process.env.TRIOS_API_TOKEN,
      rehearsal: true,
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

/**
 * Run a command as the bee, not as the server.
 *
 * The image splits the two uids deliberately and the entrypoint says so out
 * loud: "git runs as bee; root does not enter the checkout". Running git as
 * root against a bee-owned tree is not merely impolite, git refuses it -
 * measured on the first dispatch that got past the credential check:
 *
 *   git fetch failed: fatal: detected dubious ownership in repository at
 *   '/workspace/BrowserOS'
 *
 * The tempting fix is `safe.directory`, and it is the wrong one: it tells git
 * to stop minding that a root process is operating on another user's tree,
 * which is the thing the uid split exists to prevent. Dropping to bee - through
 * the same helper every agent shell command already uses - keeps the split and
 * makes git happy for the real reason.
 */
function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ code: number; out: string }> {
  const quoted = [command, ...args]
    .map((a) => `'${a.replaceAll("'", `'\\''`)}'`)
    .join(' ')
  const argv = shellArgv(quoted)
  return new Promise((resolve) => {
    // THE SAME ENVIRONMENT THE BEE'S OWN SHELL GETS, and that is the whole fix.
    //
    // This spawn passed no env, so it inherited the server's full container
    // environment - 52 variables on the live service. Something in it made git
    // refuse https:
    //
    //   git fetch failed: fatal: protocol 'https' is not supported
    //
    // Every dispatch needing a NEW worktree died there from 2026-09-02, while
    // reused worktrees kept working because `prepareWorktree` returns before
    // the fetch on reuse - so the swarm looked half-alive rather than blocked.
    //
    // It was not git and it was not the remote. Asked directly through
    // `filesystem_bash`, the container answered: git 2.47.3, exec-path
    // /usr/lib/git-core, git-remote-https present and linked against libcurl,
    // origin https://github.com/gHashTag/BrowserOS.git, no protocol or url
    // config - and `git fetch --quiet origin` in that same directory SUCCEEDED.
    // The only difference between the two calls was that `filesystem_bash`
    // goes through `spawnEnv()` and this one did not.
    //
    // The allowlist exists for exactly this class: its own comment records that
    // the inherited environment carried SSH_AUTH_SOCK, DATABASE_URL and a
    // Kaggle token into every worker command. Passing a git command more
    // environment than it needs is how one of those variables gets to decide
    // what git may do.
    const child = spawn(argv[0], argv.slice(1), { cwd, env: spawnEnv() })
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

/**
 * WHICH files a bee's branch actually changed.
 *
 * Lives here because `run` here drops to the bee before touching git. A first
 * version of this counted from the tick and would have run git as root against
 * a bee-owned tree - the dubious-ownership refusal this repository already paid
 * for once, reintroduced two files away from its own fix.
 *
 * The names, not the count. The count was all that ever left this module, and
 * the diff that produced it is the only measurement of where a bee wrote: the
 * `boundary` question `queend` has been able to answer since it was written
 * (queend/main.swift, case "boundary") compares written paths against
 * `owned_paths` and has never had a caller, because the one place holding the
 * paths threw them away at `.length`. Handing back the list costs nothing and
 * is the half of that comparison that lives on this side.
 *
 * Empty on any failure. The review policy treats zero committed files as
 * grounds to escalate rather than accept, so an unreadable branch cannot be
 * mistaken for finished work.
 */
export async function committedFiles(issue: number): Promise<string[]> {
  const base = process.env.TRIOS_REPO_REF || 'origin/dev'
  const out = await run(
    'git',
    ['diff', '--name-only', `${base}...queen-${issue}`],
    workspaceRoot(),
    60_000,
  )
  if (out.code !== 0) return []
  return out.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** The same measurement, counted. One rule, asked two ways. */
export async function committedFileCount(issue: number): Promise<number> {
  return (await committedFiles(issue)).length
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
    // Reuse is not a fresh checkout, and saying "reused an existing worktree"
    // let that pass unnoticed: the next bee inherits whatever the last one left
    // uncommitted, and both the dispatch row and the brief read as if it had
    // started from `origin/dev`. So count the leftovers and say so - the same
    // sentence reaches the board, the operator and the reviewer.
    //
    // It counts and does not clean. The container holds no push credential by
    // design, so unpushed work in that tree is the ONLY copy of it; a reset
    // here would destroy the predecessor's turn to make this one tidy.
    const dirty = await run('git', ['status', '--porcelain'], path, 60_000)
    if (dirty.code !== 0) {
      return {
        ok: true,
        path,
        detail: 'reused an existing worktree (its state could not be read)',
      }
    }
    const changed = dirty.out
      .split('\n')
      .filter((l) => l.trim().length > 0).length
    return {
      ok: true,
      path,
      detail:
        changed === 0
          ? 'reused an existing worktree (clean)'
          : `reused an existing worktree (${changed} uncommitted file(s) ` +
            'left by a previous attempt)',
    }
  }

  const fetched = await run(
    'git',
    ['fetch', '--quiet', 'origin'],
    root,
    180_000,
  )
  if (fetched.code !== 0) {
    // MAKE THE FAILURE EXPLAIN ITSELF.
    //
    // `fatal: protocol 'https' is not supported` stopped every NEW worktree on
    // 2026-09-03 while the entrypoint's own fetch, run through the identical
    // `su -s /bin/sh <user> -c`, succeeded at the same boot - so the remote and
    // the credentials are fine and the difference is the environment this
    // spawn inherits. That message is what git prints when it cannot reach the
    // `git-remote-https` helper, so the three facts that separate the causes
    // are the exec-path, whether the helper is there, and PATH.
    //
    // Guessing cost several rounds. These three commands cost one second and
    // are only run when the fetch has already failed.
    const where = await run('git', ['--exec-path'], root, 10_000)
    const helper = await run(
      'sh',
      [
        '-c',
        'command -v git-remote-https || ls "$(git --exec-path)" | grep -c remote-http',
      ],
      root,
      10_000,
    )
    const path$ = await run('sh', ['-c', 'echo "$PATH"'], root, 10_000)
    logger.error('Queen worktree fetch failed', {
      issue,
      error: fetched.out.slice(0, 300),
      execPath: where.out.slice(0, 200),
      remoteHelper: helper.out.slice(0, 200),
      shellPath: path$.out.slice(0, 300),
    })
    return {
      ok: false,
      path,
      detail:
        `git fetch failed: ${fetched.out.slice(0, 160)}` +
        ` | exec-path ${where.out.slice(0, 60)}` +
        ` | helper ${helper.out.slice(0, 40)}`,
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
  pool: Pool,
  issue: number,
  conversationId: string,
  brief: string,
  workingDirectory: string,
  chosen: WorkerProvider,
  ownedPaths: string[],
): Promise<{ ok: boolean; detail: string; beginDrain?: () => void }> {
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
        ...(chosen.baseUrl && { baseUrl: chosen.baseUrl }),
        ...(chosen.apiKey && { apiKey: chosen.apiKey }),
        // `userWorkingDir`, not `workingDirectory`. The schema names it the
        // first way and ignores unknown keys, so the wrong name was accepted
        // in silence and the bee would have run against the shared checkout
        // instead of its own worktree - its edits and its branch in different
        // trees, which is the failure the worktree exists to prevent.
        userWorkingDir: workingDirectory,
        // The standing identity, in the field the server reads (types.ts:42 ->
        // prompt.ts:649). The brief is the task; this is who is doing it.
        userSystemPrompt: workerSystemPrompt(
          issue,
          process.env.TRIOS_GITHUB_REPO || 'gHashTag/trios',
          workingDirectory,
          ownedPaths,
        ),
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        ok: false,
        detail: `chat answered ${response.status}: ${body.slice(0, 200)}`,
      }
    }
    // HANDED BACK, NOT FIRED. The reader used to start here, and the row it
    // eventually closes was written by the CALLER afterwards - so the two raced,
    // and the reader could win.
    //
    // Measured by a skeptic on a real stream: a turn whose frames are all
    // NOISE (start, finish) does no database work of its own, so it reached
    // `closeDispatch` before `recordDispatch` had inserted anything. The ending
    // UPDATE then matched ZERO rows - silently, because an UPDATE that changes
    // nothing does not throw - and the upsert that followed wrote
    // started=true, finished_at NULL. A bee that had already stopped appeared
    // to be running and held its files until the 120-minute reaper.
    //
    // That is the exact phantom `closeDispatch`'s own logging was added to
    // catch, arriving by a path with no database failure in it at all.
    return {
      ok: true,
      detail: 'turn accepted',
      beginDrain: () =>
        void drain(
          pool,
          response,
          conversationId,
          issue,
          chosen.provider,
          chosen.keyIndex,
        ),
    }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Turns the bee's stream into rows a person can read.
 *
 * Two things it must not do. It must not write a row per token - a turn emits
 * thousands of text deltas and a row each would make the table the expensive
 * part of watching. And it must not wait for the turn to end before writing
 * anything, or "live" means "ten minutes late".
 *
 * So text is coalesced and flushed on a size or time bound, whichever comes
 * first, while a tool call or an error flushes immediately: those are the
 * events somebody watching is actually waiting for, and batching them to save a
 * round trip would hide the one frame that mattered.
 */
export class Scribe {
  private seq = 0
  private buffer = ''
  private lastFlush = Date.now()
  /**
   * The provider's own refusal, if the stream carried one.
   *
   * A turn that dies because the account has no balance ends the stream
   * CLEANLY - the error arrives as a frame, not as a thrown exception - so
   * `drain` recorded `outcome = 'finished'` and the review then answered
   * `wait`. Measured 2026-09-03: #1323, #1324 and #1325 each ran on key index
   * 1, produced ONE frame, and were written down as finished work awaiting a
   * verdict, indistinguishable from a bee that worked and under-reported.
   * Meanwhile key 0 was healthy and finishing 257-frame turns.
   *
   * So the swarm kept feeding issues to a dead credential and calling the
   * result finished. That is the difference between a supervisor that is idle
   * and one that is lying to itself.
   */
  providerError: string | null = null
  /**
   * What the turn cost, as the stream reported it.
   *
   * Undefined until a `usage` frame arrives, and undefined is not zero: a turn
   * killed mid-stream never reaches its usage frame, and writing 0 tokens for
   * it would price a real turn at nothing instead of admitting it is unknown.
   */
  tokens: TokenUsage | undefined

  constructor(
    private pool: Pool,
    private conversationId: string,
    private issue: number,
  ) {}

  /**
   * Frames that carry no information for a reader.
   *
   * The model's stream is mostly bookkeeping: a step opening, a step closing,
   * reasoning starting, a text block starting. Storing them filled the feed
   * with lines like {"type":"start-step"} between every sentence, which is
   * exactly what made it unreadable to anyone who had not written the parser.
   */
  private static readonly NOISE = new Set([
    'start',
    'start-step',
    'finish-step',
    'finish',
    'text-start',
    'text-end',
    'reasoning-start',
    'reasoning-end',
    'tool-input-start',
    'tool-input-delta',
  ])

  /**
   * Whether this frame is the provider refusing, and in its own words.
   *
   * Matched on the signatures the providers actually send rather than on a
   * status code, because the code never reaches here - the turn is a stream and
   * the failure is inside it. Z.AI answers `[1113] Insufficient balance or no
   * resource package. Please recharge.`; the Vercel AI SDK wraps it as
   * `AI_APICallError`. Both are quoted whole, because a bee's log that says
   * "provider failed" and not why costs another round to diagnose.
   */
  static providerRefusal(type: string, said: string): string | null {
    const signatures = [
      'Insufficient balance',
      'AI_APICallError',
      'no resource package',
      'invalid_api_key',
      'Incorrect API key',
      'quota',
    ]
    const hit = signatures.find((s) => said.includes(s))
    if (!hit && type !== 'error') return null
    return said.slice(0, 400)
  }

  async frame(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(payload) as Record<string, unknown>
    } catch {
      await this.note('raw', payload.slice(0, 2000))
      return
    }
    const type = String(event.type ?? 'event')
    // Read BEFORE the noise filter drops it: an error frame is exactly the
    // thing a filter built for start/finish chatter must not swallow.
    if (this.providerError === null) {
      const said = JSON.stringify(event)
      const refusal = Scribe.providerRefusal(type, said)
      if (refusal) this.providerError = refusal
    }
    if (Scribe.NOISE.has(type)) return

    const text =
      (event.text as string) ??
      (event.delta as string) ??
      (event.errorText as string) ??
      ''

    // Reasoning and answer both read as the bee talking. Separating them in the
    // feed would ask a reader to care about a distinction the model makes for
    // its own reasons.
    if (type.includes('delta') || type === 'text' || type === 'reasoning') {
      this.buffer += text
      const old = Date.now() - this.lastFlush > 2500
      if (this.buffer.length > 400 || old) await this.flush()
      return
    }

    await this.flush()

    // What the turn cost, read rather than stringified.
    //
    // This frame was falling through to the default branch and being stored as
    // 800 characters of JSON, which was the only place a price existed: no
    // column on `queen_dispatch` carried a token count, so pricing one round
    // meant string-parsing one transcript row. The row is still written - the
    // feed keeps its line - and the numbers now also leave here as numbers.
    const usage = type === 'usage' ? Scribe.usageIn(event) : undefined
    if (usage) {
      this.tokens = usage
      await this.note(
        'usage',
        `${usage.inputTokens} in / ${usage.outputTokens} out tokens`,
      )
      return
    }

    // Tool traffic, rendered as a sentence rather than as a payload.
    //
    // A tool call is the most interesting thing in a turn and it arrived as
    // 2 KB of JSON with the command buried in it. What a reader wants is the
    // verb and the object: which tool, and what it was pointed at.
    if (type === 'tool-input-available') {
      const name = String(event.toolName ?? 'tool')
      const input = (event.input ?? {}) as Record<string, unknown>
      const what =
        (input.command as string) ??
        (input.path as string) ??
        (input.pattern as string) ??
        JSON.stringify(input)
      await this.note('tool', `${name}  ${String(what).slice(0, 600)}`)
      return
    }
    if (type === 'tool-output-available') {
      const out = (event.output ?? {}) as Record<string, unknown>
      const body = String(out.text ?? JSON.stringify(out))
      const lines = body.split('\n').length
      const head = body.slice(0, 400).trimEnd()
      // The head plus a count, not the whole thing. A grep can return a
      // thousand lines and none of them is the point; the point is that it
      // answered and roughly what it said.
      await this.note(
        'result',
        out.isError
          ? `FAILED  ${head}`
          : `${head}${lines > 8 ? `\n... ${lines} lines` : ''}`,
      )
      return
    }
    await this.note(type, text || JSON.stringify(event).slice(0, 800))
  }

  /**
   * The token counts in a usage frame, or nothing if it carries none.
   *
   * The shape is the one this server emits (chat-service.ts, `withUsageFrame`
   * -> {"type":"usage","usage":{"inputTokens":n,"outputTokens":n}}). The
   * unnested form is read too, because a provider stream that arrives without
   * that transform puts the same two fields at the top level.
   *
   * A frame with neither field returns nothing rather than a pair of zeros, so
   * it falls through and is stored whole - an unrecognised usage shape should
   * be visible in the feed, not silently priced at nothing.
   */
  private static usageIn(
    event: Record<string, unknown>,
  ): TokenUsage | undefined {
    const nested = event.usage
    const raw = (
      typeof nested === 'object' && nested !== null ? nested : event
    ) as Record<string, unknown>
    const input = Number(raw.inputTokens)
    const output = Number(raw.outputTokens)
    if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined
    return {
      inputTokens: Number.isFinite(input) ? input : 0,
      outputTokens: Number.isFinite(output) ? output : 0,
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const text = this.buffer
    this.buffer = ''
    this.lastFlush = Date.now()
    await this.note('say', text)
  }

  async note(kind: string, text: string): Promise<void> {
    this.seq += 1
    await this.pool
      .query(
        `INSERT INTO queen_transcript (conversation_id, seq, issue, kind, text)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (conversation_id, seq) DO NOTHING`,
        [this.conversationId, this.seq, this.issue, kind, text.slice(0, 8000)],
      )
      .catch(() => {
        // A transcript row that will not save must not take the bee down with
        // it. Watching is a convenience; the work is not.
      })
  }
}

/**
 * Read the stream to its end, and write down that it ended.
 *
 * The recording is the point, not the reading. A dispatch with no way to finish
 * holds its boundary for ever, and every issue overlapping those paths is
 * skipped for ever with it - which is exactly the defect this repository
 * already carries in `awaitingReview`, where a state that is not terminal
 * parked #1286 for five days and blocked everything it touched.
 *
 * A stream that ends badly still ends. The outcome is written on the error path
 * too, because a bee whose connection dropped is a bee that is not working, and
 * treating it as still running is how the boundary leaks.
 */
export async function drain(
  pool: Pool,
  response: Response,
  conversationId: string,
  issue: number,
  /**
   * Whose credential ran this turn. Carried so a refusal can be attributed:
   * without it the stream knows the provider said no and the rotation never
   * hears about it, which is how key 1 was handed three issues in a row after
   * it had already refused.
   */
  provider?: string,
  keyIndex?: number,
): Promise<void> {
  let outcome = 'finished'
  const scribe = new Scribe(pool, conversationId, issue)
  try {
    const reader = response.body?.getReader()
    if (!reader) {
      outcome = 'no stream'
    } else {
      const decoder = new TextDecoder()
      let carry = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        // The bytes are the point now. They were read and discarded here, which
        // is why a running bee had nothing anyone could look at.
        carry += decoder.decode(value, { stream: true })
        const lines = carry.split('\n')
        // The last fragment may be half a line; carry it to the next chunk
        // rather than parsing a truncated JSON object and losing the frame.
        carry = lines.pop() ?? ''
        for (const line of lines) await scribe.frame(line)
      }
    }
    await scribe.flush()
    // A stream that ENDED is not a turn that WORKED. The provider's refusal
    // arrives inside the stream, so ending cleanly proves only that the socket
    // closed.
    if (scribe.providerError) {
      outcome = `provider refused: ${scribe.providerError.slice(0, 300)}`
      logger.error('Queen worker turn refused by the provider', {
        conversationId,
        issue,
        provider,
        keyIndex,
        refusal: scribe.providerError.slice(0, 300),
      })
      if (provider && typeof keyIndex === 'number') {
        noteKeyRefused(provider, keyIndex)
      }
    } else {
      logger.info('Queen worker turn finished', { conversationId, issue })
    }
  } catch (error) {
    outcome = `stream ended badly: ${
      error instanceof Error ? error.message : String(error)
    }`
    logger.warn('Queen worker stream ended badly', { conversationId, issue })
    await scribe.note('error', outcome).catch(() => {})
  }
  await closeDispatch(pool, issue, conversationId, outcome, scribe.tokens)
}

/** What one turn cost, as its own stream reported it. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/**
 * Write the ending, and if it cannot be written, say so out loud.
 *
 * This was `finishDispatch(...).catch(() => {})` - an empty catch on the ONLY
 * statement that ends a turn, inside a function that is itself `void`ed, so no
 * caller could see the failure either. What it produces is a phantom: the row
 * keeps `finished_at IS NULL` and `started = true`, which the board reads as
 * `running` (queen-tick.ts, `state: finished ? 'awaitingReview' : 'running'`),
 * so a bee that has stopped holds its boundary against every overlapping issue
 * until the 120-minute stall sweep reaps it - and reaping RELEASES the issue
 * for retry, which is how the same issue gets picked six times.
 *
 * One retry, then silence, because the stall reaper is the real backstop and a
 * loop here would hold a dead stream open. The first failure is the part that
 * matters: it is the only signal separating a phantom running bee from a real
 * one, and it used to produce no line anywhere.
 */
export async function closeDispatch(
  pool: Pool,
  issue: number,
  conversationId: string,
  outcome: string,
  tokens?: TokenUsage,
): Promise<void> {
  try {
    const closed = await finishDispatch(
      pool,
      issue,
      outcome,
      tokens,
      conversationId,
    )
    // AN UPDATE THAT CHANGED NOTHING IS NOT AN ENDING.
    //
    // It does not throw, so a `try` alone cannot see it: "I wrote the ending"
    // and "I matched no row" were the same answer, which is the shape of the
    // defect this function was written to end, one layer further out.
    //
    // Zero rows means either the row is not there yet - which the drain
    // handshake in `startTurn` now prevents - or another writer already closed
    // it. Both are worth a line: the bee is about to look like it is running.
    if (closed === 0) {
      logger.error('Queen dispatch ending matched no row', {
        issue,
        conversationId,
        outcome,
      })
    }
  } catch (error) {
    logger.error('Queen dispatch could not be closed', {
      issue,
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    })
    await finishDispatch(pool, issue, outcome, tokens, conversationId).catch(
      () => {},
    )
  }
}

export async function finishDispatch(
  pool: Pool,
  issue: number,
  outcome: string,
  tokens?: TokenUsage,
  /**
   * The turn this ending belongs to.
   *
   * Keyed by issue ALONE, a stream from a previous attempt that finishes late
   * closes the CURRENT attempt's row - and writes its token counts onto it,
   * straight through the COALESCE that exists to protect a price. The reaper
   * releases an issue for retry while the old container's stream may still be
   * alive, so this is routine rather than exotic; it is the six-turns-on-#1244
   * shape from the other side.
   *
   * Optional so the reaper, which legitimately closes a row whose conversation
   * is gone, can still call it.
   */
  conversationId?: string,
): Promise<number> {
  const result = await pool.query(
    // COALESCE, not assignment: a turn that ended without a usage frame must
    // not overwrite a price with NULL. Unknown and free are different answers,
    // and only one of them can be added up.
    `UPDATE queen_dispatch
        SET finished_at = now(), outcome = $2,
            input_tokens = COALESCE($3::bigint, input_tokens),
            output_tokens = COALESCE($4::bigint, output_tokens)
      WHERE issue = $1 AND finished_at IS NULL
        AND ($5::text IS NULL OR conversation_id::text = $5::text)`,
    [
      issue,
      outcome.slice(0, 500),
      tokens?.inputTokens ?? null,
      tokens?.outputTokens ?? null,
      conversationId ?? null,
    ],
  )
  return result.rowCount ?? 0
}

/**
 * Release dispatches that have stopped without saying so.
 *
 * A container redeployed mid-turn takes its streams with it, and nothing is
 * left to write the ending. Without a sweep those rows stay `started` and
 * unfinished for ever, and the issue they name can never be chosen again - a
 * permanent hole in the board, caused by a deploy.
 *
 * Returns what it reaped so the round can say so out loud. A reaper that works
 * silently is indistinguishable from one that is not running.
 */
/**
 * Everything in flight belonged to a process that no longer exists.
 *
 * Called once at startup. A container that has just booted is not running any
 * turn it dispatched before - the stream, the agent session and the process are
 * all gone with the old container - so a row still marked in-flight is a
 * phantom, and it holds its boundary against every overlapping issue until the
 * two-hour stall sweep eventually notices.
 *
 * Measured 2026-08-31: the board reported four bees running while the container
 * held ONE worktree and zero commits. Three of the four had been killed by
 * redeploys and the board had no way to know. A supervisor whose board says
 * "busy" about work that no longer exists will refuse real work on its behalf.
 */
export async function reapDispatchesFromPreviousBoot(
  pool: Pool,
): Promise<number[]> {
  const reaped = await pool.query(
    `UPDATE queen_dispatch
        SET finished_at = now(),
            outcome = 'reaped at boot: the container running this turn was replaced'
      WHERE started = true AND finished_at IS NULL
      RETURNING issue`,
  )
  return reaped.rows.map((r) => r.issue as number)
}

export async function reapStalledDispatches(
  pool: Pool,
  stallMinutes = 120,
): Promise<number[]> {
  const reaped = await pool.query(
    `UPDATE queen_dispatch
        SET finished_at = now(),
            outcome = 'reaped: no completion within ' || $1 || ' minutes'
      WHERE started = true
        AND finished_at IS NULL
        AND dispatched_at < now() - make_interval(mins => $1)
      RETURNING issue`,
    [stallMinutes],
  )
  return reaped.rows.map((r) => r.issue as number)
}

export interface DispatchOutcome {
  started: boolean
  issue: number
  branch: string
  detail: string
  conversationId?: string
  /** Which provider key this bee took, so the next one takes a different one. */
  keyIndex?: number
}

/**
 * Choose already made; this starts the bee or says precisely why it did not.
 */
export async function dispatchBee(
  pool: Pool,
  issue: number,
  brief: string,
  ownedPaths: string[],
  takenKeyIndices: number[] = [],
  /**
   * What this bee will be judged by, recorded WITH the dispatch.
   *
   * On the row rather than re-read from the issue at review time, because the
   * issue can be edited while the bee works and the contract a worker was given
   * is the one it must be judged against. Editing an issue mid-flight to add a
   * criterion is how a bee fails for something it was never told.
   */
  criteria: string[] = [],
  criteriaSource = 'none',
): Promise<DispatchOutcome> {
  const branch = `queen-${issue}`

  // Ask the provider before spending an issue. Each dead key costs one probe
  // once per process instead of one dispatched bee that dies on its first
  // frame - and a bee that dies that way used to be recorded as finished work.
  let chosen = resolveWorkerProvider(takenKeyIndices)
  for (let attempt = 0; attempt < 8 && chosen?.apiKey; attempt++) {
    if (await keyIsLive(chosen)) break
    noteKeyRefused(chosen.provider, chosen.keyIndex ?? 0)
    chosen = resolveWorkerProvider(takenKeyIndices)
  }
  if (chosen?.exhausted !== undefined) {
    // Not a missing credential. But WHICH kind of unavailable decides what the
    // operator should do, and saying the wrong one costs them money: a message
    // that reads "all 4 keys are in use, add a fifth" when two of the four
    // cannot pay asks for a purchase that fixes nothing.
    const busy = chosen.busy ?? chosen.exhausted
    const refusedCount = chosen.refusedCount ?? 0
    const detail =
      refusedCount > 0
        ? `${chosen.exhausted} provider key(s) configured: ${busy} carrying a ` +
          `bee and ${refusedCount} refused by the provider - top those up ` +
          'rather than adding another, a refused key is not extra capacity.'
        : `all ${chosen.exhausted} provider key(s) are already in use by bees ` +
          'in flight. Add another with ZAI_API_KEY_' +
          String(chosen.exhausted + 1) +
          ' (or the equivalent for your provider) to widen the swarm.'
    logger.warn('Queen tick chose an issue and had no credential free', {
      issue,
      configured: chosen.exhausted,
      busy,
      refused: refusedCount,
    })
    await recordDispatch(pool, issue, branch, false, detail, ownedPaths)
    return { started: false, issue, branch, detail }
  }
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
  const turn = await startTurn(
    pool,
    issue,
    conversationId,
    brief,
    workingDirectory,
    chosen,
    ownedPaths,
  )
  const detail = turn.ok
    ? `${worktree.detail}; ${chosen.provider}/${chosen.model}` +
      (chosen.keyCount && chosen.keyCount > 1
        ? ` key ${(chosen.keyIndex ?? 0) + 1}/${chosen.keyCount}`
        : '') +
      (chosen.rehearsal ? ' (REHEARSAL - a recorded stream, not a model)' : '')
    : turn.detail

  await recordDispatch(
    pool,
    issue,
    branch,
    turn.ok,
    detail,
    ownedPaths,
    conversationId,
    chosen.keyIndex,
    criteria,
    criteriaSource,
    chosen.provider,
    chosen.model,
  )
  // ONLY NOW may the stream be read. Everything that reads the bee's output
  // eventually writes to the row above, and a writer that can outrun the row's
  // creation is a writer that silently updates nothing.
  turn.beginDrain?.()
  logger.info('Queen dispatch', { issue, branch, started: turn.ok, detail })
  return {
    started: turn.ok,
    issue,
    branch,
    detail,
    conversationId,
    keyIndex: chosen.keyIndex,
  }
}

export async function recordDispatch(
  pool: Pool,
  issue: number,
  branch: string,
  started: boolean,
  detail: string,
  ownedPaths: string[],
  conversationId?: string,
  keyIndex?: number,
  criteria: string[] = [],
  criteriaSource = 'none',
  /**
   * Who ran this bee and on what. Written because the daily spend cap could
   * not see a single cloud bee without them: `estimatedCostUSD` returns nil
   * unless a task carries BOTH, so every cloud dispatch summed to nothing and
   * the ceiling measured only the Mac app.
   */
  provider?: string,
  model?: string,
): Promise<void> {
  // Keep the attempt this one replaces.
  //
  // `queen_dispatch` is keyed by issue alone, so the upsert below overwrites
  // detail, conversation_id, dispatched_at, finished_at, outcome and key_index
  // in place: after a second dispatch of the same issue, attempt N-1 cannot be
  // recovered from this table at all - which key it took, how long it ran, or
  // why it ended. The transcript survives (queen_transcript is keyed by
  // conversation_id and seq) but nothing left points at the conversation.
  //
  // Stored as `to_jsonb(queen_dispatch)` rather than as a copied column list.
  // A second column list is the defect this repository keeps shipping: two
  // statements of one rule that agree until someone adds a column to one of
  // them. This captures whatever the row holds today and whatever is added to
  // it later, with no second place to edit.
  //
  // Separate from the upsert, and its failure does not stop the dispatch: on a
  // database that has not run this migration the archive is the part worth
  // losing, not the round.
  await pool
    .query(
      `INSERT INTO queen_dispatch_history (issue, snapshot)
       SELECT issue, to_jsonb(queen_dispatch) FROM queen_dispatch
        WHERE issue = $1`,
      [issue],
    )
    .catch((error) => {
      logger.warn('Queen dispatch history could not be kept', {
        issue,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  await pool.query(
    // A dispatch that never started is already over, so it is written with its
    // ending. Leaving `finished_at` null for a refusal would put it on the board
    // looking like work in progress - and "refused an hour ago" and "running for
    // an hour" are the two states an operator most needs to tell apart.
    `INSERT INTO queen_dispatch
       (issue, branch, started, detail, owned_paths, conversation_id,
        dispatched_at, finished_at, outcome, key_index,
        criteria, criteria_source, provider, model)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(),
             CASE WHEN $3 THEN NULL ELSE now() END,
             CASE WHEN $3 THEN NULL ELSE $4 END,
             $7, $8::jsonb, $9, $10, $11)
     ON CONFLICT (issue) DO UPDATE
       SET branch = EXCLUDED.branch,
           started = EXCLUDED.started,
           detail = EXCLUDED.detail,
           owned_paths = EXCLUDED.owned_paths,
           conversation_id = EXCLUDED.conversation_id,
           dispatched_at = EXCLUDED.dispatched_at,
           finished_at = EXCLUDED.finished_at,
           outcome = EXCLUDED.outcome,
           key_index = EXCLUDED.key_index,
           -- A price belongs to the turn that spent it. Left in place it would
           -- be read as this attempt's cost: measured on a scratch database
           -- while this was being written, a second dispatch of #1244
           -- inherited the first one's 18308 input tokens and reported them
           -- again. The archived row above still holds them.
           input_tokens = NULL,
           output_tokens = NULL,
           criteria = EXCLUDED.criteria,
           criteria_source = EXCLUDED.criteria_source,
           provider = EXCLUDED.provider,
           model = EXCLUDED.model,
           -- A dispatch that starts again is new work, so last turn's verdict
           -- no longer describes anything. Left in place it would exclude the
           -- row from review for good: the reviewer only looks at dispatches
           -- whose review_state IS NULL.
           review_state = CASE WHEN EXCLUDED.started THEN NULL
                               ELSE queen_dispatch.review_state END,
           review_note = CASE WHEN EXCLUDED.started THEN NULL
                              ELSE queen_dispatch.review_note END`,
    [
      issue,
      branch,
      started,
      detail,
      JSON.stringify(ownedPaths),
      conversationId ?? null,
      keyIndex ?? null,
      JSON.stringify(criteria),
      criteriaSource,
      provider ?? null,
      model ?? null,
    ],
  )
}
