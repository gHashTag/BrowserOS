/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE REVIEWER ON ITS OWN CLOCK (gHashTag/t27 specs/queen/reviewer.t27): the
 * card as the wasm runs it, and a pass - how many rows it starts, in what
 * order, on which lanes, and that the steps writing to the checkout queue.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  createReviewer,
  drainReviewerRound,
  reviewSlots,
  roundReviews,
  serialized,
  visitFirst,
} from '../../src/api/services/queen-review-loop'
import { REVIEWER_CONCURRENCY } from '../../src/api/services/queen-reviewer-card.gen'
import {
  reviewFinishedDispatches,
  waitingReviewIssues,
} from '../../src/api/services/queen-tick'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'

const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

afterEach(() => {
  drainReviewerRound()
})

describe('the vendored reviewer card is the one PIN names', () => {
  it('reviewer.t27 and reviewer.wasm match', () => {
    const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
    expect(pin).toContain(
      `queen/reviewer.t27 sha256 ${sha('queen/reviewer.t27')}`,
    )
    expect(pin).toContain(
      `queen/reviewer.wasm sha256 ${sha('queen/reviewer.wasm')}`,
    )
  })
})

describe('the card, as the wasm runs it', () => {
  it('fills the free slots with waiting rows', () => {
    expect(reviewSlots(0, 100)).toBe(REVIEWER_CONCURRENCY)
    expect(reviewSlots(1, 100)).toBe(REVIEWER_CONCURRENCY - 1)
    expect(reviewSlots(0, 2)).toBe(2)
    expect(reviewSlots(REVIEWER_CONCURRENCY, 9)).toBe(0)
  })
  it('visits a never-visited row first, then the one visited longest ago', () => {
    const now = 1_000_000
    expect(visitFirst(undefined, now - 5000, now)).toBe(true)
    expect(visitFirst(now - 5000, undefined, now)).toBe(false)
    expect(visitFirst(now - 300_000, now - 20_000, now)).toBe(true)
    expect(visitFirst(now - 20_000, now - 300_000, now)).toBe(false)
  })
  it('the round stands aside while the reviewer runs', () => {
    expect(roundReviews(true)).toBe(false)
    expect(roundReviews(false)).toBe(true)
  })
})

/** A review that resolves when the test says so. */
function controlled() {
  const started: number[] = []
  const finish = new Map<number, () => void>()
  const reserved = new Map<number, number[]>()
  const reviewOne = (
    issue: number,
    reservedKeys: () => number[],
    onLane: (k: number | undefined) => void,
  ) => {
    started.push(issue)
    reserved.set(issue, reservedKeys())
    onLane(100 + issue)
    return new Promise<{ acted: string[]; strays: []; tally: [] }>(
      (resolve) => {
        finish.set(issue, () =>
          resolve({ acted: [`#${issue}:accept`], strays: [], tally: [] }),
        )
      },
    )
  }
  return { started, finish, reserved, reviewOne }
}

const settle = () => new Promise((r) => setTimeout(r, 5))

describe('a pass', () => {
  it('does nothing without the Queen lease', async () => {
    const c = controlled()
    const r = createReviewer({
      holdsLease: async () => false,
      waiting: async () => [1, 2],
      reviewOne: c.reviewOne,
    })
    expect(await r.pass()).toEqual([])
    expect(c.started).toEqual([])
  })

  it('starts up to REVIEWER_CONCURRENCY rows at once, never one row twice', async () => {
    const c = controlled()
    const waiting = [1, 2, 3, 4, 5, 6]
    const r = createReviewer({
      holdsLease: async () => true,
      waiting: async () => waiting,
      reviewOne: c.reviewOne,
    })
    expect(await r.pass()).toEqual([1, 2, 3, 4].slice(0, REVIEWER_CONCURRENCY))
    // all slots busy: the next pass starts nothing, and nothing twice
    expect(await r.pass()).toEqual([])
    c.finish.get(2)?.()
    await settle()
    expect(await r.pass()).toEqual([5])
    expect(new Set(c.started).size).toBe(c.started.length)
  })

  it('gives each review the lanes its siblings hold', async () => {
    const c = controlled()
    const r = createReviewer({
      holdsLease: async () => true,
      waiting: async () => [1, 2, 3],
      reviewOne: c.reviewOne,
    })
    await r.pass()
    expect(c.reserved.get(1)).toEqual([])
    expect(c.reserved.get(2)).toEqual([101])
    expect(c.reserved.get(3)).toEqual([101, 102])
  })

  it('visits every waiting row in turn, not the same head again and again', async () => {
    const c = controlled()
    let clock = 0
    const waiting = [1, 2, 3, 4, 5, 6]
    const r = createReviewer({
      holdsLease: async () => true,
      waiting: async () => waiting,
      reviewOne: c.reviewOne,
      now: () => clock,
    })
    await r.pass()
    for (const n of [1, 2, 3, 4]) c.finish.get(n)?.()
    await settle()
    clock += 60_000
    // 5 and 6 were never visited, so they go first; then the oldest visits
    expect((await r.pass()).slice(0, 2)).toEqual([5, 6])
  })

  it('hands the round what it judged, once', async () => {
    const c = controlled()
    const r = createReviewer({
      holdsLease: async () => true,
      waiting: async () => [7],
      reviewOne: c.reviewOne,
    })
    await r.pass()
    c.finish.get(7)?.()
    await settle()
    expect(drainReviewerRound().acted).toEqual(['#7:accept'])
    expect(drainReviewerRound().acted).toEqual([])
  })
})

describe('the steps that write to the checkout', () => {
  it('run one at a time', async () => {
    let inside = 0
    let most = 0
    const step = serialized(async (n: number) => {
      inside += 1
      most = Math.max(most, inside)
      await new Promise((r) => setTimeout(r, 3))
      inside -= 1
      return n * 2
    })
    expect(await Promise.all([step(1), step(2), step(3)])).toEqual([2, 4, 6])
    expect(most).toBe(1)
  })
  it('a failing step does not stop the next', async () => {
    const step = serialized(async (fail: boolean) => {
      if (fail) throw new Error('git lock')
      return 'ok'
    })
    await expect(step(true)).rejects.toThrow('git lock')
    expect(await step(false)).toBe('ok')
  })
})

describe('the sweep, scoped to one issue', () => {
  it('asks only for that issue, and the waiting list uses the same rule', async () => {
    const sql: Array<{ text: string; params: unknown[] }> = []
    const pool = {
      query: async (text: string, params: unknown[] = []) => {
        sql.push({ text, params })
        if (/count\(\*\)/.test(text)) return { rows: [{ n: '0' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Pool
    await reviewFinishedDispatches(pool, {}, { issues: [7772] })
    const done = sql.find((q) => /FROM queen_dispatch d/.test(q.text))
    expect(done?.text).toContain('AND d.issue = ANY($1::int[])')
    expect(done?.params).toEqual([[7772]])
    sql.length = 0
    expect(await waitingReviewIssues(pool)).toEqual([])
    const list = sql.find((q) =>
      /SELECT d.issue FROM queen_dispatch d/.test(q.text),
    )
    expect(list?.text).toContain("d.review_state = 'wait'")
    expect(list?.text).toContain("NOT LIKE 'reaped%'")
  })
})
