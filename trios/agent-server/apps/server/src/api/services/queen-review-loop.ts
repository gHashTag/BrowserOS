/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE REVIEWER, ON ITS OWN CLOCK (gHashTag/t27 specs/queen/reviewer.t27,
 * t27#7840).
 *
 * WHY. Measured 2026-10-08: bees finished 47 tasks an hour and the Queen
 * reviewed 23. The sweep ran inside the round, before it handed out work: at
 * most 3 reviews, one after another, in at most 45 s - about one review a
 * round - while finished work queued up and held its files.
 *
 * WHAT DECIDES. The card, as generated wasm: review_slots (how many rows a
 * pass starts), visit_first (the order: never-visited, then longest ago) and
 * round_reviews (the round stands aside while this runs). This file runs the
 * passes: only while this process holds the Queen's lease, one row per sweep,
 * never one row twice at once, each sweep on a lane no bee and no sibling
 * holds. The steps that write to the checkout (a runner's branch imported, a
 * criteria worktree cut and removed) run one at a time; the model calls, which
 * are the slow part, run side by side.
 */

import type { Pool } from 'pg'
import { logger } from '../../lib/logger'
import { importRunnerBranch } from '../routes/queen-export'
import { flag, loadCardWasm, u32 } from './queen-card-wasm'
import { queenHolderName } from './queen-lease'
import { defaultReviewDeps, type ReviewDeps } from './queen-reviewer'
import {
  REVIEW_ROW_SECONDS,
  REVIEWER_EVERY_SECONDS,
} from './queen-reviewer-card.gen'

export const REVIEWER_CARD = 'queen/reviewer.wasm'

const card = () => loadCardWasm(REVIEWER_CARD)
export const reviewSlots = (inFlight: number, waiting: number): number =>
  card().call('review_slots', u32(inFlight), u32(waiting))
export const visitFirst = (
  a: number | undefined,
  b: number | undefined,
  now: number,
): boolean =>
  card().call(
    'visit_first',
    flag(a === undefined),
    u32(a === undefined ? 0 : (now - a) / 1000),
    flag(b === undefined),
    u32(b === undefined ? 0 : (now - b) / 1000),
  ) !== 0
export const roundReviews = (reviewerRunning: boolean): boolean =>
  card().call('round_reviews', flag(reviewerRunning)) !== 0

let running = false

/**
 * What the reviewer judged since the round last asked, so the round's report
 * still says what was accepted, sent back and escalated.
 */
interface Judged {
  acted: string[]
  strays: Array<{ issue: number; paths: string[] }>
  tally: unknown[]
}
let judged: Judged = { acted: [], strays: [], tally: [] }

/** Hand the round what the reviewer judged since it last asked, and start over. */
export function drainReviewerRound<T extends Judged>(): T {
  const out = judged
  judged = { acted: [], strays: [], tally: [] }
  return out as T
}

/** Whether this process runs the reviewer; the round asks before it sweeps. */
export function reviewerRunning(): boolean {
  return running
}

/** One-at-a-time, for the steps that write to the shared checkout. */
export function serialized<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let chain: Promise<unknown> = Promise.resolve()
  return (...args: A) => {
    const run = chain.then(() => fn(...args))
    chain = run.catch(() => undefined)
    return run
  }
}

export interface ReviewerDeps {
  /** Whether this process holds the Queen's lease now. */
  holdsLease: () => Promise<boolean>
  /** The issues waiting for a review, in the sweep's own order. */
  waiting: () => Promise<number[]>
  /** One sweep over one issue; lanes held by siblings are passed in. */
  reviewOne: (
    issue: number,
    reservedKeys: () => number[],
    onLane: (keyIndex: number | undefined) => void,
  ) => Promise<Judged>
  now?: () => number
}

/**
 * The reviewer's state and one pass. Exported apart from the timer so a test
 * can drive passes and watch what it starts.
 */
export function createReviewer(deps: ReviewerDeps) {
  const inFlight = new Set<number>()
  const lanes = new Map<number, number>()
  const lastVisited = new Map<number, number>()
  const now = deps.now ?? Date.now

  const pass = async (): Promise<number[]> => {
    if (!(await deps.holdsLease())) return []
    const waiting = (await deps.waiting()).filter((n) => !inFlight.has(n))
    if (waiting.length === 0) return []
    const at = now()
    // visit_first as a comparator; the sort is stable, so ties keep the
    // sweep's own order (the longest-waiting row first)
    const ordered = [...waiting].sort((a, b) => {
      if (visitFirst(lastVisited.get(a), lastVisited.get(b), at)) return -1
      if (visitFirst(lastVisited.get(b), lastVisited.get(a), at)) return 1
      return 0
    })
    const take = ordered.slice(0, reviewSlots(inFlight.size, ordered.length))
    for (const issue of take) {
      inFlight.add(issue)
      lastVisited.set(issue, at)
      void deps
        .reviewOne(
          issue,
          () => [...lanes.values()],
          (keyIndex) => {
            if (typeof keyIndex === 'number') lanes.set(issue, keyIndex)
          },
        )
        .then((round) => {
          judged.acted.push(...round.acted)
          judged.strays.push(...round.strays)
          judged.tally.push(...round.tally)
        })
        .catch((error) =>
          logger.warn('Queen reviewer could not review a row', {
            issue,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          inFlight.delete(issue)
          lanes.delete(issue)
        })
    }
    if (lastVisited.size > 10_000) lastVisited.clear()
    return take
  }
  return { pass, inFlight }
}

/**
 * Start the reviewer in this process. The round's sweep stands aside from the
 * first pass on (round_reviews). Off with TRIOS_QUEEN_REVIEWER=off, which
 * hands reviewing back to the round as before.
 */
export function startReviewer(
  pool: Pool,
  leaseName: string,
  review: (
    pool: Pool,
    overrides: Partial<ReviewDeps>,
    scope: {
      issues: number[]
      reservedKeys: () => number[]
      onLane: (lane: { keyIndex?: number }) => void
      deadlineMs: number
    },
  ) => Promise<Judged>,
  waiting: (pool: Pool) => Promise<number[]>,
): (() => void) | null {
  if ((process.env.TRIOS_QUEEN_REVIEWER ?? 'on').toLowerCase() === 'off')
    return null
  const defaults = defaultReviewDeps()
  const overrides: Partial<ReviewDeps> = {
    reviewsPerRound: () => 1,
    measurementsPerRound: () => 1,
    measureCriteria: serialized(defaults.measureCriteria),
    importRunnerBranch: serialized((issue: number) =>
      importRunnerBranch(pool, issue),
    ),
  }
  const reviewer = createReviewer({
    holdsLease: async () => {
      const r = await pool.query(
        `SELECT 1 FROM queen_lease
          WHERE name = $1 AND holder = $2 AND expires_at > now()`,
        [leaseName, queenHolderName()],
      )
      return (r.rowCount ?? r.rows.length) > 0
    },
    waiting: () => waiting(pool),
    reviewOne: (issue, reservedKeys, onLane) =>
      review(pool, overrides, {
        issues: [issue],
        reservedKeys,
        onLane: (lane) => onLane(lane.keyIndex),
        deadlineMs: REVIEW_ROW_SECONDS * 1000,
      }),
  })
  running = true
  logger.info('Queen reviewer starting', {
    everySeconds: REVIEWER_EVERY_SECONDS,
  })
  const timer = setInterval(() => {
    reviewer.pass().catch((error) =>
      logger.warn('Queen reviewer pass failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }, REVIEWER_EVERY_SECONDS * 1000)
  return () => {
    clearInterval(timer)
    running = false
  }
}
