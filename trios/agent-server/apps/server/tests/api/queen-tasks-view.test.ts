/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Every task and the bees on them, without a database (gHashTag/t27
 * specs/queen/tasks.t27): the generated card against its own spec vectors, the
 * query, and the bees made from dispatch rows.
 */

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BEE_QUIET_SECONDS,
  TS_BACKLOG,
  TS_BLOCKED,
  TS_DONE,
  TS_DROPPED,
  TS_FAILED,
  TS_REVIEW,
  TS_RUNNING,
} from '../../src/api/services/queen-tasks.gen'
import {
  a2aState,
  beeState,
  beesOf,
  jobState,
  parseTasksQuery,
  reviewState,
  taskMatches,
} from '../../src/api/services/queen-tasks-view'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'

const sha = (f: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, f)))
    .digest('hex')

describe('the vendored tasks card is the one PIN names', () => {
  it('tasks.t27 and tasks.wasm match', () => {
    const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
    expect(pin).toContain(`queen/tasks.t27 sha256 ${sha('queen/tasks.t27')}`)
    expect(pin).toContain(`queen/tasks.wasm sha256 ${sha('queen/tasks.wasm')}`)
  })
})

describe('the generated card answers its own spec', () => {
  it('a_job_and_a_review_show_as_one_lifecycle', () => {
    expect([0, 1, 2, 3].map(jobState)).toEqual([
      TS_RUNNING,
      TS_DONE,
      TS_FAILED,
      TS_DROPPED,
    ])
    expect([0, 1, 2, 3].map(reviewState)).toEqual([
      TS_BACKLOG,
      TS_DONE,
      TS_DROPPED,
      TS_FAILED,
    ])
  })
  it('every_state_has_an_a2a_state', () => {
    expect(
      [
        TS_BACKLOG,
        TS_RUNNING,
        TS_BLOCKED,
        TS_REVIEW,
        TS_DONE,
        TS_DROPPED,
        TS_FAILED,
      ].map(a2aState),
    ).toEqual([1, 2, 3, 3, 4, 5, 6])
  })
  it('a_bee_is_queued_working_or_quiet', () => {
    expect(beeState(false, 0)).toBe(0)
    expect(beeState(false, 9999)).toBe(0)
    expect(beeState(true, 0)).toBe(1)
    expect(beeState(true, BEE_QUIET_SECONDS)).toBe(1)
    expect(beeState(true, BEE_QUIET_SECONDS + 1)).toBe(2)
  })
  it('a_filter_narrows_and_zero_means_any', () => {
    expect(taskMatches(0, 0, 0, TS_RUNNING)).toBe(true)
    expect(taskMatches(1 << 0, 0, 0, TS_DONE)).toBe(true)
    expect(taskMatches(1 << 2, 0, 0, TS_DONE)).toBe(false)
    expect(taskMatches(0, 1 << TS_RUNNING, 1, TS_RUNNING)).toBe(true)
    expect(taskMatches(0, 1 << TS_RUNNING, 1, TS_BACKLOG)).toBe(false)
    expect(
      taskMatches(
        (1 << 0) | (1 << 2),
        (1 << TS_RUNNING) | (1 << TS_REVIEW),
        2,
        TS_REVIEW,
      ),
    ).toBe(true)
    expect(taskMatches(0, 0, 3, TS_DONE)).toBe(false)
    expect(taskMatches(0, 0, 0, 7)).toBe(false)
  })
})

describe('the query', () => {
  it('reads names into indices, ignores unknown ones, and bounds the limit', () => {
    const q = parseTasksQuery({
      kind: 'issue, JOB,nope',
      state: 'running,review',
      repo: ' gHashTag/t27 ',
      q: ' Port ',
      limit: '99999',
    })
    expect(q).toEqual({
      kinds: [0, 2],
      states: [2, 3],
      repo: 'gHashTag/t27',
      q: 'port',
      limit: 2000,
    })
    expect(parseTasksQuery({}).limit).toBe(500)
    expect(parseTasksQuery({ limit: '-3' }).limit).toBe(500)
  })
})

describe('the bees made from dispatch rows', () => {
  const now = Date.parse('2026-10-08T08:00:00Z')
  const at = (s: string) => new Date(`2026-10-08T${s}Z`)
  it("names each bee by its issue, anonymises a person's runner, and reads its state", () => {
    const bees = beesOf(
      [
        {
          issue: 7513,
          key_index: 3,
          dispatched_at: at('07:00:00'),
          queued_at: at('07:00:00'),
          claimed_by: 'runner-1:42',
          claimed_at: at('07:01:00'),
          runner_claimed_at: null,
          conversation_id: 'c1',
        },
        {
          issue: 7500,
          key_index: 4,
          dispatched_at: at('07:50:00'),
          queued_at: at('07:50:00'),
          claimed_by: null,
          claimed_at: null,
          runner_claimed_at: null,
          conversation_id: null,
        },
        {
          issue: 7395,
          key_index: 100_000_007,
          dispatched_at: at('07:10:00'),
          queued_at: null,
          claimed_by: null,
          claimed_at: null,
          runner_claimed_at: at('07:11:00'),
          conversation_id: 'c3',
        },
        {
          issue: 7327,
          key_index: 1,
          dispatched_at: at('07:20:00'),
          queued_at: null,
          claimed_by: null,
          claimed_at: null,
          runner_claimed_at: null,
          conversation_id: 'c4',
        },
      ],
      new Map([
        ['c1', at('07:59:30')],
        ['c3', at('07:40:00')],
      ]),
      'gHashTag/t27',
      now,
    )
    expect(bees.map((b) => [b.id, b.kind, b.lane, b.state])).toEqual([
      ['b7513', 'runner', 3, 'working'],
      ['b7500', 'worker', 4, 'queued'],
      ['b7395', 'lent', null, 'quiet'],
      ['b7327', 'worker', 1, 'quiet'],
    ])
    expect(bees[0]).toMatchObject({
      task: 'gHashTag/t27#7513',
      since: '2026-10-08T07:01:00.000Z',
      lastEventAt: '2026-10-08T07:59:30.000Z',
    })
    expect(bees[3].lastEventAt).toBe(null)
  })
})
