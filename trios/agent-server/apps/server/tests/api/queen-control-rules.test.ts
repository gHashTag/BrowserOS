/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Sections 1 and 3 of specs/queen/control.t27 (gHashTag/t27#6657), held to the
 * spec's own vectors, and the two pieces of wiring that turn them into
 * behaviour: an event that wakes the Queen asks the round gate for a round,
 * and a person's assignment goes first in the candidate list.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import {
  publishEvent,
  setControlEventListener,
} from '../../src/api/services/queen-control'
import {
  A_AGENT_BUSY,
  A_HELD,
  A_OK,
  A_WRONG_DOMAIN,
  assignAnswer,
  cancelAllowed,
  cancelCountsAgainstIssue,
  EV_ASSIGN,
  EV_CANCEL,
  EV_EVIDENCE,
  EV_HEARTBEAT,
  EV_LEASE_EXPIRED,
  EV_REVIEW,
  EV_TASK_CREATED,
  EV_TASK_ENDED,
  EV_TICK,
  EV_WORKER_IDLE,
  EVENT_KINDS,
  EVENT_NAMES,
  eventApplies,
  fenceAfterCancel,
  manualFirst,
  nextSource,
  R_ASSIGN,
  R_CANCEL,
  R_DISPATCH,
  R_NONE,
  R_RECLAIM,
  R_RECONCILE,
  R_REVIEW,
  reactionOf,
  SRC_AUTO,
  SRC_MANUAL,
  SRC_NONE,
  wakesQueen,
} from '../../src/api/services/queen-control-rules'
import { wakeOnControlEvents } from '../../src/api/services/queen-tick'

afterEach(() => setControlEventListener(null))

describe('section 1 mirrors its spec', () => {
  it('maps every kind to its reaction', () => {
    expect(reactionOf(EV_TASK_CREATED)).toBe(R_DISPATCH)
    expect(reactionOf(EV_TASK_ENDED)).toBe(R_REVIEW)
    expect(reactionOf(EV_WORKER_IDLE)).toBe(R_DISPATCH)
    expect(reactionOf(EV_LEASE_EXPIRED)).toBe(R_RECLAIM)
    expect(reactionOf(EV_EVIDENCE)).toBe(R_REVIEW)
    expect(reactionOf(EV_REVIEW)).toBe(R_DISPATCH)
    expect(reactionOf(EV_ASSIGN)).toBe(R_ASSIGN)
    expect(reactionOf(EV_CANCEL)).toBe(R_CANCEL)
    expect(reactionOf(EV_HEARTBEAT)).toBe(R_NONE)
    expect(reactionOf(EV_TICK)).toBe(R_RECONCILE)
    expect(reactionOf(EVENT_KINDS)).toBe(R_NONE)
  })

  // test a_synthetic_task_ended_event_wakes_the_queen_before_the_tick
  it('wakes on everything but a heartbeat', () => {
    expect(wakesQueen(EV_TASK_ENDED)).toBe(true)
    expect(wakesQueen(EV_HEARTBEAT)).toBe(false)
    for (let kind = 0; kind < EVENT_KINDS; kind++) {
      expect(wakesQueen(kind)).toBe(kind !== EV_HEARTBEAT)
    }
  })

  // test a_redelivered_event_changes_nothing
  it('applies an event once', () => {
    expect(eventApplies(41, 42)).toBe(true)
    expect(eventApplies(42, 42)).toBe(false)
    expect(eventApplies(42, 7)).toBe(false)
  })

  it('names one event per kind', () => {
    expect(EVENT_NAMES.length).toBe(EVENT_KINDS)
    expect(EVENT_NAMES[EV_CANCEL]).toBe('queen/task.cancel')
    expect(EVENT_NAMES[EV_ASSIGN]).toBe('queen/task.assign')
  })
})

describe('section 3 mirrors its spec', () => {
  // test a_person_assigns_first_and_cannot_steal_a_live_lease
  it('takes a person first and never steals a live lease', () => {
    expect(nextSource(true, true)).toBe(SRC_MANUAL)
    expect(nextSource(false, true)).toBe(SRC_AUTO)
    expect(nextSource(false, false)).toBe(SRC_NONE)
    expect(assignAnswer(true, true, true)).toBe(A_HELD)
    expect(assignAnswer(false, true, false)).toBe(A_WRONG_DOMAIN)
    expect(assignAnswer(false, false, true)).toBe(A_AGENT_BUSY)
    expect(assignAnswer(false, true, true)).toBe(A_OK)
  })

  // test a_cancel_interrupts_frees_and_fences_out_the_bee
  it('cancels anything but an accept, bumps the fence, spends no retry', () => {
    expect(cancelAllowed(false)).toBe(true)
    expect(cancelAllowed(true)).toBe(false)
    expect(fenceAfterCancel(7)).toBe(8)
    expect(cancelCountsAgainstIssue()).toBe(false)
  })
})

describe('a person goes first in the candidate list', () => {
  it('moves assigned open issues to the front, in request order', () => {
    expect(manualFirst([10, 20, 30, 40], [30, 10])).toEqual([30, 10, 20, 40])
  })

  it('leaves the order alone when nothing is assigned', () => {
    expect(manualFirst([10, 20, 30], [])).toEqual([10, 20, 30])
  })

  it('ignores an assignment on an issue that is not a candidate', () => {
    expect(manualFirst([10, 20], [99, 20])).toEqual([20, 10])
  })

  it('never duplicates a candidate', () => {
    expect(manualFirst([10, 20], [20, 20])).toEqual([20, 10])
  })
})

/** Postgres as publishEvent sees it: the next sequence number, every time. */
function sequencePool(): Pool {
  let seq = 0
  return {
    query: async () => ({ rowCount: 1, rows: [{ seq: ++seq }] }),
  } as unknown as Pool
}

describe('an event wakes the Queen through the round gate', () => {
  it('asks for a round on a person cancelling or assigning', async () => {
    const asked: string[] = []
    wakeOnControlEvents((why) => asked.push(why))
    const pool = sequencePool()
    await publishEvent(pool, 'queen/task.cancel', { issue: 1 })
    await publishEvent(pool, 'queen/task.assign', { issue: 2 })
    expect(asked).toEqual([
      'event queen/task.cancel #1',
      'event queen/task.assign #2',
    ])
  })

  it('does not wake for a heartbeat', async () => {
    const asked: string[] = []
    wakeOnControlEvents((why) => asked.push(why))
    await publishEvent(sequencePool(), 'queen/lease.heartbeat', {})
    expect(asked).toEqual([])
  })

  // The durable close already asks for the round a finished bee needs, and the
  // round publishes task.created itself; waking again would run a second full
  // round for every bee that started or ended.
  it('does not wake twice for an ending or a start', async () => {
    const asked: string[] = []
    wakeOnControlEvents((why) => asked.push(why))
    const pool = sequencePool()
    await publishEvent(pool, 'queen/task.ended', { issue: 1 })
    await publishEvent(pool, 'queen/task.created', { issue: 1 })
    expect(asked).toEqual([])
  })

  it('wakes for the kinds no other path delivers', async () => {
    const asked: string[] = []
    wakeOnControlEvents((why) => asked.push(why))
    const pool = sequencePool()
    await publishEvent(pool, 'queen/lease.expired', { issue: 3 })
    await publishEvent(pool, 'queen/task.reviewed', { issue: 3 })
    expect(asked.length).toBe(2)
  })

  it('ignores a redelivered sequence number', async () => {
    const asked: string[] = []
    wakeOnControlEvents((why) => asked.push(why))
    const replay = {
      query: async () => ({ rowCount: 1, rows: [{ seq: 5 }] }),
    } as unknown as Pool
    await publishEvent(replay, 'queen/task.cancel', { issue: 1 })
    await publishEvent(replay, 'queen/task.cancel', { issue: 1 })
    expect(asked).toEqual(['event queen/task.cancel #5'])
  })

  it('keeps recording when the listener throws', async () => {
    setControlEventListener(() => {
      throw new Error('listener down')
    })
    expect(await publishEvent(sequencePool(), 'queen/task.cancel', {})).toBe(1)
  })
})
