/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * ONE TASK, OPENED: the board's drawer (gHashTag/t27 specs/queen/dashboard.t27
 * section 2, epic t27#7718 slice 5).
 *
 * WHY. Measured 2026-10-08: the board showed a task's column and nothing else -
 * no history, no lease, no attempt counts - so "why is #7804 still running"
 * had no answer on screen.
 *
 * WHAT DECIDES. The card, as generated wasm: timeline_shows (which events a
 * task's history holds) and lease_state (none, live, expired). This file reads
 * the rows.
 *
 * WHAT IS PUBLIC. The task and its bee as /queen/public-tasks shows them; the
 * events that name it, projected as /queen/public-events projects them; the
 * lease's fence and expiry (not its holder); the dispatch's state, outcome,
 * times and retry counters (not its notes); a job's effects by step, kind,
 * state and runs (not their results).
 */

import type { Pool } from 'pg'
import { flag, loadCardWasm, u64 } from './queen-card-wasm'
import { LS_EXPIRED, LS_LIVE, TIMELINE_MAX } from './queen-dashboard.gen'
import { publicPayload, tokenOk } from './queen-events'
import {
  type BeeRecord,
  buildTasksView,
  parseTasksQuery,
  type TaskRecord,
} from './queen-tasks-view'

export const DASHBOARD_CARD = 'queen/dashboard.wasm'

const card = () => loadCardWasm(DASHBOARD_CARD)
export const timelineShows = (kind: number): boolean =>
  card().call('timeline_shows', kind) !== 0
export const leaseState = (
  hasLease: boolean,
  expiresAt: number,
  now: number,
): number =>
  Number(card().call64('lease_state', flag(hasLease), u64(expiresAt), u64(now)))

export interface TimelineEntry {
  seq: number
  kind: number
  name: string
  at: string
  [field: string]: string | number | boolean
}

export interface TaskDrawer {
  at: string
  key: string
  task: TaskRecord | null
  bee: BeeRecord | null
  timeline: TimelineEntry[]
  lease: { state: string; fence: number; expiresAt: string } | null
  attempts: {
    reviewState: string | null
    outcome: string | null
    dispatchedAt: string | null
    finishedAt: string | null
    sendBacks: number
    freeAttempts: number
    ceilingReleases: number
    reviewerMisses: number
  } | null
  effects: Array<{
    step: number | null
    kind: number
    state: number
    runs: number
    updatedAt: string | null
  }>
}

export type DrawerRef = { issue: number } | { job: number }

/** Read `?issue=N` or `?job=N`; anything else is no task. */
export function parseDrawerRef(
  params: Record<string, string | undefined>,
): DrawerRef | null {
  const whole = (v: string | undefined) =>
    v !== undefined && /^[1-9]\d{0,9}$/.test(v.trim()) ? Number(v.trim()) : null
  const issue = whole(params.issue)
  if (issue !== null) return { issue }
  const job = whole(params.job)
  if (job !== null) return { job }
  return null
}

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null
const token = (v: unknown): string | null =>
  typeof v === 'string' && tokenOk(v) ? v : null
const LEASE_NAMES = ['none', 'live', 'expired'] as const

export async function buildTaskDrawer(
  pool: Pool,
  ref: DrawerRef,
  repo: string,
  names: readonly string[],
  now: number = Date.now(),
): Promise<TaskDrawer> {
  if ('job' in ref) {
    const key = `job:${ref.job}`
    const view = await buildTasksView(
      pool,
      { ...parseTasksQuery({ kind: 'job' }) },
      repo,
      now,
    )
    const effects = await pool.query(
      `SELECT key, kind, state, runs, updated_at FROM queen_effect
        WHERE key LIKE $1 ORDER BY updated_at DESC LIMIT 20`,
      [`${key}:%`],
    )
    return {
      at: new Date(now).toISOString(),
      key,
      task: view.tasks.find((t) => t.key === key) ?? null,
      bee: null,
      timeline: [],
      lease: null,
      attempts: null,
      effects: effects.rows.map((r) => {
        const step = /:step:(\d+):/.exec(String(r.key))
        return {
          step: step ? Number(step[1]) : null,
          kind: Number(r.kind),
          state: Number(r.state),
          runs: Number(r.runs),
          updatedAt: iso(r.updated_at),
        }
      }),
    }
  }

  const issue = ref.issue
  const [view, events, lease, dispatch] = await Promise.all([
    buildTasksView(
      pool,
      { ...parseTasksQuery({}), issues: [issue] },
      repo,
      now,
    ),
    pool.query(
      `SELECT seq, kind, payload, recorded_at FROM queen_event_log
        WHERE stream = 'queen' AND payload->>'issue' = $1
        ORDER BY seq DESC LIMIT $2`,
      [String(issue), TIMELINE_MAX * 2],
    ),
    pool.query(
      'SELECT fence, expires_at FROM queen_task_lease WHERE issue = $1',
      [issue],
    ),
    pool.query(
      `SELECT review_state, outcome, dispatched_at, finished_at, send_backs,
              free_attempts, ceiling_releases, reviewer_misses
         FROM queen_dispatch WHERE issue = $1`,
      [issue],
    ),
  ])
  const timeline = events.rows
    .filter((r) => timelineShows(Number(r.kind)))
    .slice(0, TIMELINE_MAX)
    .map((r) => ({
      ...publicPayload(
        r.payload && typeof r.payload === 'object'
          ? (r.payload as Record<string, unknown>)
          : {},
      ),
      seq: Number(r.seq),
      kind: Number(r.kind),
      name: names[Number(r.kind)] ?? 'unknown',
      at: iso(r.recorded_at) ?? '',
    }))
  const l = lease.rows[0]
  const expires = l ? new Date(l.expires_at as Date | string) : null
  const state = l
    ? leaseState(
        true,
        Math.floor((expires as Date).getTime() / 1000),
        Math.floor(now / 1000),
      )
    : 0
  const d = dispatch.rows[0]
  return {
    at: new Date(now).toISOString(),
    key: `${repo}#${issue}`,
    task:
      view.tasks.find((t) => t.kind === 'issue' && t.number === issue) ?? null,
    bee: view.bees.find((b) => b.number === issue) ?? null,
    timeline,
    lease: l
      ? {
          state:
            state === LS_LIVE
              ? LEASE_NAMES[1]
              : state === LS_EXPIRED
                ? LEASE_NAMES[2]
                : LEASE_NAMES[0],
          fence: Number(l.fence),
          expiresAt: (expires as Date).toISOString(),
        }
      : null,
    attempts: d
      ? {
          reviewState: token(d.review_state),
          outcome: token(d.outcome),
          dispatchedAt: iso(d.dispatched_at),
          finishedAt: iso(d.finished_at),
          sendBacks: Number(d.send_backs ?? 0),
          freeAttempts: Number(d.free_attempts ?? 0),
          ceilingReleases: Number(d.ceiling_releases ?? 0),
          reviewerMisses: Number(d.reviewer_misses ?? 0),
        }
      : null,
    effects: [],
  }
}
