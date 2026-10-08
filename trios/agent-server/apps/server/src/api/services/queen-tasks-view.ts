/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * EVERY TASK AND THE BEES ON THEM, as anyone may read them (gHashTag/t27
 * specs/queen/tasks.t27, epic t27#7718 slice 1).
 *
 * WHY. Measured 2026-10-08: no public field said which bee is on which issue,
 * so the game drew a snapshot with no bees. Each kind of task (an issue
 * dispatch, a job, an app review) kept its own codes, so no board could show
 * them together or filter them.
 *
 * WHAT DECIDES. The card's functions run as generated wasm: job_state,
 * review_state, bee_state and task_matches (the kind/state filter). The board
 * and the game mirror task_matches against the same vectors. This file reads
 * the rows and shapes the answer.
 *
 * WHAT IS PUBLIC. Issue numbers, titles and columns, which /queen/public-board
 * already shows; jobs, which /queen/public-jobs shows; reviews on PUBLIC
 * repositories only; and for each bee in flight: the issue, when it started,
 * when it was last heard, and an anonymous lane number. No provider, model,
 * key, path, worker text or person's runner is named.
 */

import type { Pool } from 'pg'
import {
  build as buildBoard,
  type Card,
  type PublicBoardPool,
} from '../routes/queen-kanban'
import { flag, loadCardWasm, u32 } from './queen-card-wasm'
import { isRunnerLane } from './queen-runners'
import {
  BEE_STATE_NAMES,
  KIND_NAMES,
  STATE_NAMES,
  TASK_PAGE_DEFAULT,
  TASK_PAGE_MAX,
  TK_ISSUE,
  TK_JOB,
  TK_REVIEW,
} from './queen-tasks.gen'

export const TASKS_CARD = 'queen/tasks.wasm'

const card = () => loadCardWasm(TASKS_CARD)
export const jobState = (j: number): number => card().call('job_state', j)
export const reviewState = (r: number): number => card().call('review_state', r)
export const a2aState = (s: number): number => card().call('a2a_state', s)
export const beeState = (claimed: boolean, secondsSince: number): number =>
  card().call('bee_state', flag(claimed), u32(secondsSince))
export const taskMatches = (
  kindMask: number,
  stateMask: number,
  kind: number,
  state: number,
): boolean =>
  card().call('task_matches', u32(kindMask), u32(stateMask), kind, state) !== 0

export interface TaskRecord {
  key: string
  kind: string
  repo: string
  number: number | null
  title: string
  state: string
  criteria: number | null
  needs: string[]
  verdict: string | null
  url: string | null
  bee: string | null
  updatedAt: string | null
}

export interface BeeRecord {
  id: string
  lane: number | null
  kind: 'worker' | 'runner' | 'lent'
  task: string
  repo: string
  number: number
  state: string
  since: string
  lastEventAt: string | null
}

export interface TasksQuery {
  kinds: number[]
  states: number[]
  repo: string | null
  q: string | null
  limit: number
}

/** Read `?kind=&state=&repo=&q=&limit=` into masks and bounds. Unknown names are ignored. */
export function parseTasksQuery(
  params: Record<string, string | undefined>,
): TasksQuery {
  const list = (v: string | undefined, names: readonly string[]) =>
    (v ?? '')
      .split(',')
      .map((s) => names.indexOf(s.trim().toLowerCase()))
      .filter((i) => i >= 0)
  const limit = Number(params.limit ?? TASK_PAGE_DEFAULT)
  return {
    kinds: list(params.kind, KIND_NAMES as readonly string[]),
    states: list(params.state, STATE_NAMES as readonly string[]),
    repo: params.repo?.trim() ? params.repo.trim() : null,
    q: params.q?.trim() ? params.q.trim().toLowerCase().slice(0, 200) : null,
    limit:
      Number.isFinite(limit) && limit > 0
        ? Math.min(Math.floor(limit), TASK_PAGE_MAX)
        : TASK_PAGE_DEFAULT,
  }
}

const mask = (indices: number[]) => indices.reduce((m, i) => m | (1 << i), 0)
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null

interface DispatchRow {
  issue: number
  key_index: number | null
  dispatched_at: Date | string
  queued_at: Date | string | null
  claimed_by: string | null
  claimed_at: Date | string | null
  runner_claimed_at: Date | string | null
  conversation_id: string | null
}

/** The bees in flight: one per dispatch that started and has not finished. */
export function beesOf(
  rows: DispatchRow[],
  lastHeard: Map<string, Date>,
  repo: string,
  now: number,
): BeeRecord[] {
  return rows.map((r) => {
    const lent = typeof r.key_index === 'number' && isRunnerLane(r.key_index)
    const kind: BeeRecord['kind'] = lent
      ? 'lent'
      : r.claimed_by
        ? 'runner'
        : 'worker'
    const claimed =
      r.queued_at === null ||
      r.claimed_by !== null ||
      r.runner_claimed_at !== null
    // When the turn began: dispatched_at, which a runner sets as it starts the
    // bee. Not claimed_at - a runner renews that every 15 s to vouch for a long
    // turn (waitForEnding), so read as a start it made every bee seconds old
    // and, with nothing heard, never quiet (measured 2026-10-08: b7510 quiet
    // with a `since` four minutes after its last event).
    const since = new Date(r.dispatched_at)
    const heard = r.conversation_id
      ? lastHeard.get(r.conversation_id)
      : undefined
    const from = heard ?? since
    const seconds = Math.max(0, Math.floor((now - from.getTime()) / 1000))
    return {
      id: `b${r.issue}`,
      lane: lent || typeof r.key_index !== 'number' ? null : r.key_index,
      kind,
      task: `${repo}#${r.issue}`,
      repo,
      number: r.issue,
      state: BEE_STATE_NAMES[beeState(claimed, seconds)] ?? 'working',
      since: since.toISOString(),
      lastEventAt: heard ? heard.toISOString() : null,
    }
  })
}

export interface TasksView {
  at: string
  kinds: readonly string[]
  states: readonly string[]
  tasks: TaskRecord[]
  bees: BeeRecord[]
  counts: {
    tasks: number
    bees: number
    byState: Record<string, number>
    byKind: Record<string, number>
  }
  truncated: boolean
}

/** Build the whole view: issue cards, jobs and public app reviews, filtered, and the bees. */
export async function buildTasksView(
  pool: Pool,
  query: TasksQuery,
  repo: string,
  now: number = Date.now(),
): Promise<TasksView> {
  const [board, running, jobs, reviews] = await Promise.all([
    buildBoard(pool as unknown as PublicBoardPool),
    pool.query(
      `SELECT issue, key_index, dispatched_at, queued_at, claimed_by, claimed_at,
              runner_claimed_at, conversation_id
         FROM queen_dispatch
        WHERE started = true AND finished_at IS NULL
          AND dispatched_at > now() - interval '7 days'`,
    ),
    pool
      .query(
        `SELECT id, card, params, state, updated_at FROM queen_job
          ORDER BY id DESC LIMIT 50`,
      )
      .catch(() => ({ rows: [] as Array<Record<string, unknown>> })),
    pool
      .query(
        `SELECT r.repo, r.pr, r.head_sha, r.state, r.url, r.updated_at
           FROM queen_app_review r JOIN queen_app_repo p ON p.repo = r.repo AND p.private = false
          WHERE r.head_sha <> '' ORDER BY r.updated_at DESC LIMIT 200`,
      )
      .catch(() => ({ rows: [] as Array<Record<string, unknown>> })),
  ])

  const conversations = (running.rows as DispatchRow[])
    .map((r) => r.conversation_id)
    .filter((c): c is string => typeof c === 'string')
  const heard = new Map<string, Date>()
  if (conversations.length > 0) {
    const last = await pool
      .query(
        `SELECT conversation_id, max(at) AS at FROM queen_transcript
          WHERE conversation_id = ANY($1) GROUP BY conversation_id`,
        [conversations],
      )
      .catch(() => ({
        rows: [] as Array<{ conversation_id: string; at: Date }>,
      }))
    for (const r of last.rows)
      heard.set(String(r.conversation_id), new Date(r.at))
  }
  const bees = beesOf(running.rows as DispatchRow[], heard, repo, now)
  const beeOf = new Map(bees.map((b) => [b.number, b.id]))

  const all: Array<TaskRecord & { kindIndex: number; stateIndex: number }> = []
  for (const c of board.cards as Card[]) {
    const stateIndex = STATE_NAMES.indexOf(
      c.column as (typeof STATE_NAMES)[number],
    )
    all.push({
      key: `${repo}#${c.number}`,
      kind: KIND_NAMES[TK_ISSUE],
      kindIndex: TK_ISSUE,
      repo,
      number: c.number,
      title: c.title,
      state: c.column,
      stateIndex,
      criteria: typeof c.criteria === 'number' ? c.criteria : null,
      needs: c.needs ?? [],
      verdict: c.verdict ?? null,
      url: `https://github.com/${repo}/issues/${c.number}`,
      bee: beeOf.get(c.number) ?? null,
      updatedAt: null,
    })
  }
  for (const j of jobs.rows) {
    const params = (j.params ?? {}) as Record<string, string>
    const stateIndex = jobState(Number(j.state))
    const issue = params.issue ? Number(params.issue) : null
    all.push({
      key: `job:${j.id}`,
      kind: KIND_NAMES[TK_JOB],
      kindIndex: TK_JOB,
      repo,
      number: issue,
      title: `${String(j.card)}${params.version ? ` ${params.version}` : ''}`,
      state: STATE_NAMES[stateIndex],
      stateIndex,
      criteria: null,
      needs: [],
      verdict: null,
      url: issue ? `https://github.com/${repo}/issues/${issue}` : null,
      bee: null,
      updatedAt: iso(j.updated_at),
    })
  }
  for (const r of reviews.rows) {
    const stateIndex = reviewState(Number(r.state))
    const sha = String(r.head_sha).slice(0, 7)
    all.push({
      key: `${r.repo}#${r.pr}@${sha}`,
      kind: KIND_NAMES[TK_REVIEW],
      kindIndex: TK_REVIEW,
      repo: String(r.repo),
      number: Number(r.pr),
      title: `review of ${sha}`,
      state: STATE_NAMES[stateIndex],
      stateIndex,
      criteria: null,
      needs: [],
      verdict: null,
      url:
        typeof r.url === 'string' && r.url
          ? r.url
          : `https://github.com/${r.repo}/pull/${r.pr}`,
      bee: null,
      updatedAt: iso(r.updated_at),
    })
  }

  const kindMask = mask(query.kinds)
  const stateMask = mask(query.states)
  const repoLower = query.repo?.toLowerCase() ?? null
  const matched = all.filter(
    (t) =>
      taskMatches(kindMask, stateMask, t.kindIndex, t.stateIndex) &&
      (repoLower === null || t.repo.toLowerCase() === repoLower) &&
      (query.q === null ||
        t.title.toLowerCase().includes(query.q) ||
        (t.number !== null && `#${t.number}`.includes(query.q))),
  )
  const byState: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  for (const t of matched) {
    byState[t.state] = (byState[t.state] ?? 0) + 1
    byKind[t.kind] = (byKind[t.kind] ?? 0) + 1
  }
  const page = matched
    .slice(0, query.limit)
    .map(({ kindIndex: _k, stateIndex: _s, ...t }) => t)
  const shownBees = bees.filter(
    (b) => repoLower === null || b.repo.toLowerCase() === repoLower,
  )
  return {
    at: new Date(now).toISOString(),
    kinds: KIND_NAMES,
    states: STATE_NAMES,
    tasks: page,
    bees: shownBees,
    counts: { tasks: matched.length, bees: shownBees.length, byState, byKind },
    truncated: matched.length > page.length,
  }
}
