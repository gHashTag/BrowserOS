/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A RUNNER TAKES A TASK, AND HANDS THE WORK BACK.
 *
 * queen-runners.ts registers a runner; this file gives it work. The shape is
 * the container bee's, moved one machine over:
 *
 *   OFFER     The round chose an issue and `dispatchBee` asked `offerToRunner`
 *             first. An idle runner (seen recently, nothing open on its lane)
 *             gets a dispatch row on its lane - `started = true`, the brief and
 *             the system prompt stored with it, and the commit it must start
 *             from. Nothing is started here: no worktree, no /chat, no key.
 *
 *   CLAIM     The runner asks for its lane's open row and is handed exactly
 *             what the round wrote. Its heartbeat renews the lease from then on.
 *
 *   COMPLETE  The runner pushed the branch to a GitHub remote it controls and
 *             says where. This container fetches that one branch, checks the
 *             commit is the one named and descends from the offered start, puts
 *             it at `queen-<issue>` - the ref the review reads - and stores what
 *             the runner's agent said as the transcript the review reads. Then
 *             the row is finished and the EXISTING review judges it, by the
 *             same rules as any other bee. A runner earns nothing a review did
 *             not accept.
 *
 *   REAP      An offer nobody claims, or a lease nobody renews, releases the
 *             issue (`reapSilentRunners`). A container restart does not: the
 *             runner's turn is not here, which is why the container's own
 *             reapers skip runner lanes (NOT_A_RUNNER).
 *
 * WHAT NEVER MOVES. The runner's provider key. Nothing here accepts, stores or
 * returns one, and the row records no provider or model - so the daily spend
 * cap, which prices `provider + model + tokens`, never counts the lender's
 * money as the operator's.
 *
 * WHICH TASKS. Only those a runner can actually continue. A runner starts from
 * a commit it can fetch: the base, or its own previous push when the review
 * sent the work back. An issue whose branch carries commits that exist only in
 * this container stays with the container, because handing it to a runner
 * would start the next attempt from scratch beside the last one's work.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Pool } from 'pg'
import { logger } from '../../lib/logger'
import {
  announceDurableClose,
  baseHeadSha,
  baseRef,
  DISPATCH_OUTCOME_LABELS,
  type DispatchOutcome,
  finishDispatch,
  gitAt,
  recordDispatch,
  repoSubdir,
  workspaceRoot,
} from './queen-dispatch'
import { laneOf, RUNNER_KEY_BASE, RUNNER_ONLINE_MS } from './queen-runners'
import { workerSystemPrompt } from './queen-tick'

type Queryable = Pick<Pool, 'query'>

/** The runner substitutes its own checkout for this in the system prompt. */
export const RUNNER_WORKDIR_PLACEHOLDER = '{{WORKDIR}}'
/** An offer nobody claims within this long is released. */
export const RUNNER_OFFER_MINUTES = 10
/** A claimed task whose runner has not renewed its lease for this long is released. */
export const RUNNER_LEASE_MINUTES = 15
/** And no runner holds an issue longer than this, lease or not. */
export const RUNNER_CAP_MINUTES = 360
/** How often the runner should heartbeat while it works. */
export const RUNNER_HEARTBEAT_SECONDS = 60
/** What the runner's agent said, kept for the review: at most this much. */
export const RUNNER_SAID_MAX = 64_000
const TRANSCRIPT_CHUNK = 8000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Off with QUEEN_RUNNERS=off, for an operator who wants the swarm local only. */
export function runnersEnabled(): boolean {
  return (process.env.QUEEN_RUNNERS ?? 'on').trim().toLowerCase() !== 'off'
}

export interface IdleRunner {
  id: number
  lane: number
  label: string
  ownerName: string
}

/**
 * A runner that may take a task now: live, seen within RUNNER_ONLINE_MS, and
 * holding nothing open on its lane. The one idle longest goes first, so two
 * runners of one person share the work rather than one taking all of it.
 */
export async function idleRunner(pool: Queryable): Promise<IdleRunner | null> {
  const { rows } = await pool.query(
    `SELECT r.id, r.label, r.owner_name
       FROM queen_runner r
      WHERE r.revoked_at IS NULL
        AND r.last_seen_at > now() - make_interval(secs => $1)
        AND NOT EXISTS (
          SELECT 1 FROM queen_dispatch d
           WHERE d.key_index = $2 + r.id
             AND d.started = true AND d.finished_at IS NULL)
      ORDER BY (SELECT max(d.dispatched_at) FROM queen_dispatch d
                 WHERE d.key_index = $2 + r.id) ASC NULLS FIRST, r.id
      LIMIT 1`,
    [RUNNER_ONLINE_MS / 1000, RUNNER_KEY_BASE],
  )
  const row = rows?.[0]
  const id = Number(row?.id)
  if (!row || !Number.isSafeInteger(id) || id <= 0) return null
  return {
    id,
    lane: laneOf(id),
    label: String(row.label ?? ''),
    ownerName: String(row.owner_name ?? ''),
  }
}

export interface RunnerStart {
  /** The commit the runner checks out before it starts. */
  sha: string
  /** Where to fetch it, when it is not on the project's own repository. */
  remote?: string
  branch?: string
}

export interface RunnerGit {
  root: () => string
  git: (
    cwd: string,
    args: string[],
    timeoutMs?: number,
  ) => Promise<{ code: number; out: string }>
  exists: (path: string) => boolean
  base: () => Promise<string | null>
}

const defaultGit: RunnerGit = {
  root: workspaceRoot,
  git: gitAt,
  exists: existsSync,
  base: baseHeadSha,
}

const SHA = /^[0-9a-f]{40}$/

/**
 * Where a runner must start on this issue, or null when it may not take it.
 *
 * Null whenever the branch holds something a runner cannot reach: commits made
 * in this container, or a worktree with uncommitted edits. Those belong to the
 * next CONTAINER attempt, which starts from them.
 */
export async function runnerStart(
  pool: Queryable,
  issue: number,
  g: RunnerGit = defaultGit,
): Promise<RunnerStart | null> {
  const base = await g.base()
  if (!base || !SHA.test(base)) return null
  const root = g.root()
  const tree = `${root}/.worktrees/queen-${issue}`
  if (g.exists(tree)) {
    const dirt = await g.git(tree, ['status', '--porcelain'], 60_000)
    if (dirt.code !== 0 || dirt.out.trim() !== '') return null
  }
  const head = await g.git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/queen-${issue}^{commit}`,
  ])
  const sha = head.out.trim()
  if (head.code !== 0 || !SHA.test(sha)) return { sha: base }
  // Nothing of its own on the branch: whatever is there is already in the base.
  const behind = await g.git(root, ['merge-base', '--is-ancestor', sha, base])
  if (behind.code === 0) return { sha: base }
  // Commits of its own. Only a runner's own previous push can be continued
  // somewhere else, and only when the branch still points at exactly it.
  const { rows } = await pool.query(
    `SELECT runner_head, runner_remote, runner_branch
       FROM queen_dispatch WHERE issue = $1`,
    [issue],
  )
  const last = rows?.[0]
  if (
    last?.runner_head === sha &&
    typeof last.runner_remote === 'string' &&
    typeof last.runner_branch === 'string'
  ) {
    return { sha, remote: last.runner_remote, branch: last.runner_branch }
  }
  return null
}

export interface OfferInput {
  issue: number
  branch: string
  brief: string
  ownedPaths: string[]
  criteria: string[]
  criteriaSource: string
}

/**
 * Hand this dispatch to an idle runner, or return null so the container takes
 * it. Never throws: a runner registry that cannot be read is a round that
 * dispatches locally, as it did before runners existed.
 */
export async function offerToRunner(
  pool: Pool,
  input: OfferInput,
  g: RunnerGit = defaultGit,
): Promise<DispatchOutcome | null> {
  if (!runnersEnabled()) return null
  const runner = await idleRunner(pool).catch((error) => {
    logger.warn('Queen could not read the runner registry', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })
  if (!runner) return null
  const start = await runnerStart(pool, input.issue, g).catch(() => null)
  if (!start) return null

  const { issue, branch, ownedPaths } = input
  const conversationId = randomUUID()
  const systemPrompt = workerSystemPrompt(
    issue,
    process.env.TRIOS_GITHUB_REPO || 'gHashTag/trios',
    RUNNER_WORKDIR_PLACEHOLDER,
    ownedPaths,
  )
  const detail = `offered to runner ${runner.id} (${runner.label}) of ${runner.ownerName}`
  await recordDispatch(
    pool,
    issue,
    branch,
    true,
    detail,
    ownedPaths,
    conversationId,
    runner.lane,
    input.criteria,
    input.criteriaSource,
  )
  try {
    const stored = await pool.query(
      `UPDATE queen_dispatch
          SET runner_brief = $3, runner_system_prompt = $4,
              runner_start_sha = $5, runner_start_remote = $6,
              runner_start_branch = $7,
              runner_claimed_at = NULL, runner_lease_at = NULL
        WHERE issue = $1 AND conversation_id::text = $2::text
          AND finished_at IS NULL`,
      [
        issue,
        conversationId,
        input.brief,
        systemPrompt,
        start.sha,
        start.remote ?? null,
        start.branch ?? null,
      ],
    )
    if ((stored.rowCount ?? 0) === 0) throw new Error('the offer row is gone')
  } catch (error) {
    // A row on a runner's lane with no brief can never be claimed; close it
    // now rather than hold the issue until the offer clock runs out.
    await finishDispatch(
      pool,
      issue,
      DISPATCH_OUTCOME_LABELS.reapedRunnerSilent,
      undefined,
      conversationId,
    ).catch(() => 0)
    const why = error instanceof Error ? error.message : String(error)
    logger.warn('Queen could not store a runner offer', { issue, error: why })
    return {
      started: false,
      issue,
      branch,
      detail: `the offer to runner ${runner.id} could not be stored: ${why}`,
    }
  }
  logger.info('Queen offered a task to a runner', {
    issue,
    runner: runner.id,
    lane: runner.lane,
    from: start.remote ? 'its previous push' : 'the base',
  })
  return {
    started: true,
    issue,
    branch,
    detail,
    conversationId,
    keyIndex: runner.lane,
  }
}

/** The project's repository as a runner may clone it: never with credentials. */
export function publicRepoUrl(): string {
  const raw = process.env.TRIOS_REPO_URL?.trim()
  if (raw) {
    try {
      const url = new URL(raw)
      url.username = ''
      url.password = ''
      return url.toString()
    } catch {
      // Not a URL (an scp-style remote): nothing in it to strip but the user.
      return raw.replace(/^[^@/]+@/, '')
    }
  }
  return `https://github.com/${process.env.TRIOS_GITHUB_REPO || 'gHashTag/trios'}.git`
}

export interface RunnerWork {
  issue: number
  branch: string
  conversationId: string
  repo: string
  repoUrl: string
  baseRef: string
  start: RunnerStart
  /** The project directory inside the checkout; '' when it is the root. */
  subdir: string
  brief: string
  /** Contains RUNNER_WORKDIR_PLACEHOLDER; the runner puts its checkout there. */
  systemPrompt: string
  workdirPlaceholder: string
  ownedPaths: string[]
  criteria: string[]
  heartbeatSeconds: number
  leaseMinutes: number
  capMinutes: number
}

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []

/**
 * The open task on this runner's lane, claimed. Asking twice returns the same
 * task - a runner that restarted mid-turn picks up where it was - and renews
 * the lease each time.
 */
export async function claimRunnerWork(
  pool: Queryable,
  runnerId: number,
): Promise<RunnerWork | null> {
  const { rows } = await pool.query(
    `UPDATE queen_dispatch
        SET runner_claimed_at = coalesce(runner_claimed_at, now()),
            runner_lease_at = now()
      WHERE key_index = $1
        AND started = true AND finished_at IS NULL
        AND runner_brief IS NOT NULL
     RETURNING issue, branch, conversation_id, runner_brief,
               runner_system_prompt, runner_start_sha, runner_start_remote,
               runner_start_branch, owned_paths, criteria`,
    [laneOf(runnerId)],
  )
  const row = rows?.[0]
  if (!row) return null
  return {
    issue: Number(row.issue),
    branch: String(row.branch),
    conversationId: String(row.conversation_id),
    repo: process.env.TRIOS_GITHUB_REPO || 'gHashTag/trios',
    repoUrl: publicRepoUrl(),
    baseRef: baseRef(),
    start: {
      sha: String(row.runner_start_sha),
      ...(row.runner_start_remote && {
        remote: String(row.runner_start_remote),
        branch: String(row.runner_start_branch),
      }),
    },
    subdir: repoSubdir(),
    brief: String(row.runner_brief),
    systemPrompt: String(row.runner_system_prompt ?? ''),
    workdirPlaceholder: RUNNER_WORKDIR_PLACEHOLDER,
    ownedPaths: asStrings(row.owned_paths),
    criteria: asStrings(row.criteria),
    heartbeatSeconds: RUNNER_HEARTBEAT_SECONDS,
    leaseMinutes: RUNNER_LEASE_MINUTES,
    capMinutes: RUNNER_CAP_MINUTES,
  }
}

/**
 * Renew the lease on whatever this runner holds, and say what that is. Called
 * by every heartbeat; an unclaimed offer is reported so the runner knows to
 * claim it.
 */
export async function renewRunnerLease(
  pool: Queryable,
  runnerId: number,
): Promise<{ issue: number; conversationId: string; claimed: boolean } | null> {
  const { rows } = await pool.query(
    `UPDATE queen_dispatch
        SET runner_lease_at = CASE WHEN runner_claimed_at IS NULL
                                   THEN runner_lease_at ELSE now() END
      WHERE key_index = $1
        AND started = true AND finished_at IS NULL
        AND runner_brief IS NOT NULL
     RETURNING issue, conversation_id, runner_claimed_at`,
    [laneOf(runnerId)],
  )
  const row = rows?.[0]
  if (!row) return null
  return {
    issue: Number(row.issue),
    conversationId: String(row.conversation_id),
    claimed: row.runner_claimed_at != null,
  }
}

/** A branch on github.com, over https, and nothing else: no file://, no ssh, no other host. */
const GITHUB_REMOTE =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}?(?:\.git)?$/
const BRANCH_NAME =
  /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,120}(?<![./])$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CompleteInput {
  conversationId: string
  /** The runner could not do the work and hands the issue back. */
  gaveUp?: boolean
  reason?: string
  remoteUrl?: string
  branch?: string
  headSha?: string
  /** What the runner's agent said - its final answer, with the VERDICT block. */
  said?: string
  tokens?: { inputTokens: number; outputTokens: number }
}

export type CompleteResult =
  | { ok: true; issue: number; closed: boolean }
  | { ok: false; status: 400 | 404 | 409 | 422; error: string }

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined

/** The body a runner sent, or the sentence that says what is wrong with it. */
export function parseCompleteBody(
  body: unknown,
): CompleteInput | { error: string } {
  if (!isRecord(body)) return { error: 'A JSON object is required' }
  const conversationId = body.conversationId
  if (typeof conversationId !== 'string' || !UUID.test(conversationId))
    return { error: 'conversationId is required' }
  const usage = isRecord(body.tokens) ? body.tokens : null
  const inputTokens = count(usage?.inputTokens)
  const outputTokens = count(usage?.outputTokens)
  const tokens =
    inputTokens !== undefined || outputTokens !== undefined
      ? { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
      : undefined
  if (body.gaveUp === true) {
    return {
      conversationId,
      gaveUp: true,
      reason: typeof body.reason === 'string' ? body.reason.slice(0, 2000) : '',
      tokens,
    }
  }
  const { remoteUrl, branch, headSha, said } = body
  if (typeof remoteUrl !== 'string' || !GITHUB_REMOTE.test(remoteUrl))
    return {
      error: 'remoteUrl must be an https://github.com/<owner>/<repo> address',
    }
  if (typeof branch !== 'string' || !BRANCH_NAME.test(branch))
    return { error: 'branch is not a plain branch name' }
  if (typeof headSha !== 'string' || !SHA.test(headSha))
    return { error: 'headSha must be a full 40-character commit id' }
  if (said !== undefined && typeof said !== 'string')
    return { error: 'said must be text' }
  return {
    conversationId,
    remoteUrl,
    branch,
    headSha,
    said: (said ?? '').slice(0, RUNNER_SAID_MAX),
    tokens,
  }
}

/** One completion per issue at a time; a second is told to wait. */
const completing = new Set<number>()

/**
 * The runner's work, brought into this container and closed for review.
 *
 * The dispatch is closed only after the branch is in place and the transcript
 * is written, so the first review that sees the row finished already sees the
 * work - the same ordering `closeDispatch` keeps with its salvage.
 */
export async function completeRunnerWork(
  pool: Pool,
  runnerId: number,
  input: CompleteInput,
  g: RunnerGit = defaultGit,
): Promise<CompleteResult> {
  const { rows } = await pool.query(
    `SELECT issue, runner_start_sha FROM queen_dispatch
      WHERE conversation_id::text = $1::text AND key_index = $2
        AND started = true AND finished_at IS NULL
        AND runner_claimed_at IS NOT NULL`,
    [input.conversationId, laneOf(runnerId)],
  )
  const row = rows?.[0]
  if (!row)
    return {
      ok: false,
      status: 404,
      error: 'No open task of this runner has that conversation',
    }
  const issue = Number(row.issue)
  if (completing.has(issue))
    return { ok: false, status: 409, error: 'This task is already completing' }
  completing.add(issue)
  try {
    if (input.gaveUp) {
      await note(
        pool,
        input.conversationId,
        issue,
        1,
        'error',
        input.reason || 'the runner gave up',
      )
      const closed = await finishDispatch(
        pool,
        issue,
        DISPATCH_OUTCOME_LABELS.reapedRunnerGaveUp,
        input.tokens,
        input.conversationId,
      )
      if (closed > 0) announceDurableClose(issue)
      return { ok: true, issue, closed: closed > 0 }
    }

    const moved = await bringBranchHome(
      issue,
      input.remoteUrl as string,
      input.branch as string,
      input.headSha as string,
      String(row.runner_start_sha ?? ''),
      g,
    )
    if (!moved.ok)
      return { ok: false, status: moved.status, error: moved.error }

    // seq 1 says where the work came from; what the agent said follows it.
    await note(
      pool,
      input.conversationId,
      issue,
      1,
      'tool',
      `runner ${runnerId}: ${input.remoteUrl} ${input.branch} @ ${input.headSha}`,
    )
    const said = input.said ?? ''
    for (let i = 0; i * TRANSCRIPT_CHUNK < said.length; i += 1) {
      await note(
        pool,
        input.conversationId,
        issue,
        i + 2,
        'say',
        said.slice(i * TRANSCRIPT_CHUNK, (i + 1) * TRANSCRIPT_CHUNK),
      )
    }
    await pool.query(
      `UPDATE queen_dispatch
          SET runner_remote = $2, runner_branch = $3, runner_head = $4,
              runner_lease_at = NULL
        WHERE conversation_id::text = $1::text AND finished_at IS NULL`,
      [input.conversationId, input.remoteUrl, input.branch, input.headSha],
    )
    const closed = await finishDispatch(
      pool,
      issue,
      DISPATCH_OUTCOME_LABELS.finished,
      input.tokens,
      input.conversationId,
    )
    if (closed > 0) {
      announceDurableClose(issue)
    } else {
      logger.warn('A runner finished a task that was already closed', {
        issue,
        runner: runnerId,
      })
    }
    logger.info('Queen took back a runner task', {
      issue,
      runner: runnerId,
      head: input.headSha,
      closed: closed > 0,
    })
    return { ok: true, issue, closed: closed > 0 }
  } finally {
    completing.delete(issue)
  }
}

async function note(
  pool: Queryable,
  conversationId: string,
  issue: number,
  seq: number,
  kind: string,
  text: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO queen_transcript (conversation_id, seq, issue, kind, text)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (conversation_id, seq) DO NOTHING`,
    [conversationId, seq, issue, kind, text.slice(0, TRANSCRIPT_CHUNK)],
  )
}

/**
 * Fetch the runner's branch and put it at `queen-<issue>`, or say why not.
 *
 * Fetched into a ref of its own first, so nothing the review reads changes
 * until every check has passed. The protocol is pinned to https and no
 * credential helper is consulted: this container fetches a public branch from
 * an address a runner typed, and must neither follow it elsewhere nor offer it
 * a credential.
 */
export async function bringBranchHome(
  issue: number,
  remoteUrl: string,
  branch: string,
  headSha: string,
  startSha: string,
  g: RunnerGit = defaultGit,
): Promise<{ ok: true } | { ok: false; status: 409 | 422; error: string }> {
  const root = g.root()
  const scratch = `refs/runner/queen-${issue}`
  const fetched = await g.git(
    root,
    [
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'credential.helper=',
      '-c',
      'core.askPass=true',
      'fetch',
      '--no-tags',
      '--quiet',
      '--',
      remoteUrl,
      `+refs/heads/${branch}:${scratch}`,
    ],
    300_000,
  )
  if (fetched.code !== 0)
    return {
      ok: false,
      status: 422,
      error: `Could not fetch ${branch} from ${remoteUrl}: ${fetched.out.slice(0, 300)}`,
    }
  try {
    const got = await g.git(root, [
      'rev-parse',
      '--verify',
      `${scratch}^{commit}`,
    ])
    if (got.out.trim() !== headSha)
      return {
        ok: false,
        status: 422,
        error: `${branch} on ${remoteUrl} is at ${got.out.trim().slice(0, 40) || 'nothing'}, not ${headSha}`,
      }
    if (SHA.test(startSha)) {
      const descends = await g.git(root, [
        'merge-base',
        '--is-ancestor',
        startSha,
        headSha,
      ])
      if (descends.code !== 0)
        return {
          ok: false,
          status: 422,
          error: `${headSha} does not descend from ${startSha}, the commit this task started from`,
        }
    }
    const tree = `${root}/.worktrees/queen-${issue}`
    if (g.exists(tree)) {
      const dirt = await g.git(tree, ['status', '--porcelain'], 60_000)
      if (dirt.code !== 0 || dirt.out.trim() !== '')
        return {
          ok: false,
          status: 409,
          error:
            'This container holds uncommitted work for the issue; the task stays open',
        }
      const holds = await g.git(tree, ['symbolic-ref', '-q', 'HEAD'])
      if (holds.out.trim() === `refs/heads/queen-${issue}`) {
        // The branch is checked out there: moving the ref alone would leave the
        // tree describing the old commit, which the next salvage would read as
        // edits. A clean tree has nothing to lose to a hard reset.
        const reset = await g.git(tree, ['reset', '--hard', '--quiet', headSha])
        if (reset.code !== 0)
          return {
            ok: false,
            status: 409,
            error: `Could not move queen-${issue}: ${reset.out.slice(0, 300)}`,
          }
        return { ok: true }
      }
    }
    const set = await g.git(root, [
      'update-ref',
      `refs/heads/queen-${issue}`,
      headSha,
    ])
    if (set.code !== 0)
      return {
        ok: false,
        status: 409,
        error: `Could not move queen-${issue}: ${set.out.slice(0, 300)}`,
      }
    if (!g.exists(tree)) {
      // A TREE FOR THE BRANCH, as a container bee leaves one. Without it a
      // send-back the container takes cuts a fresh tree with `-B ... base`
      // (prepareWorktree) - resetting the branch and starting the retry beside
      // the runner's work instead of from it. Not fatal: the branch is home and
      // the review reads the branch, not the tree.
      const added = await g.git(
        root,
        ['worktree', 'add', '--quiet', tree, `queen-${issue}`],
        180_000,
      )
      if (added.code !== 0)
        logger.warn('Queen could not give a runner branch a worktree', {
          issue,
          error: added.out.slice(0, 300),
        })
    }
    return { ok: true }
  } finally {
    await g.git(root, ['update-ref', '-d', scratch]).catch(() => undefined)
  }
}

/**
 * Release what runners took and stopped answering for: an offer unclaimed for
 * RUNNER_OFFER_MINUTES, a lease unrenewed for RUNNER_LEASE_MINUTES, or any
 * runner task older than RUNNER_CAP_MINUTES. The `reaped` label releases the
 * issue exactly as a stalled container bee's does.
 */
export async function reapSilentRunners(pool: Queryable): Promise<number[]> {
  const { rows } = await pool.query(
    `UPDATE queen_dispatch
        SET finished_at = now(), outcome = $1
      WHERE started = true AND finished_at IS NULL
        AND key_index > $2
        AND (
          (runner_claimed_at IS NULL
             AND dispatched_at < now() - make_interval(mins => $3))
          OR (runner_claimed_at IS NOT NULL
             AND coalesce(runner_lease_at, runner_claimed_at)
                 < now() - make_interval(mins => $4))
          OR dispatched_at < now() - make_interval(mins => $5)
        )
      RETURNING issue`,
    [
      DISPATCH_OUTCOME_LABELS.reapedRunnerSilent,
      RUNNER_KEY_BASE,
      RUNNER_OFFER_MINUTES,
      RUNNER_LEASE_MINUTES,
      RUNNER_CAP_MINUTES,
    ],
  )
  return (rows ?? []).map((r) => Number(r.issue))
}
