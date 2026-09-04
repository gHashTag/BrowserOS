import { describe, expect, it } from 'bun:test'
import {
  SEND_BACK_IDLE_FLOOR_MS,
  stateOfDispatch,
} from '../../src/api/services/queen-tick'

// The defect these cover, in one sentence: `claimOnIssue` counts `rejected` as
// a live claim because "the same bee is expected to return to those files", and
// nothing returns, so a sent-back issue is held by its own failed attempt
// forever. Measured 2026-09-04: 18 of 28 open issues skipped as `claimed`.
//
// `failed` is already free in the policy, over the comment "A failure is the
// state that most obviously means 'do this again'". So the lease reports a
// stale send-back as what it is rather than inventing a new state.

const HOUR = 60 * 60 * 1000

describe('stateOfDispatch: the send-back lease', () => {
  it('leaves every existing caller unchanged when no lease is passed', () => {
    expect(stateOfDispatch(false, null)).toBe('running')
    expect(stateOfDispatch(true, 'accept')).toBe('accepted')
    expect(stateOfDispatch(true, 'sendBack')).toBe('rejected')
    expect(stateOfDispatch(true, 'escalate')).toBe('awaitingReview')
    expect(stateOfDispatch(true, 'wait')).toBe('awaitingReview')
    expect(stateOfDispatch(true, null)).toBe('awaitingReview')
  })

  it('holds a fresh send-back, so a verdict is not undone the moment it lands', () => {
    expect(stateOfDispatch(true, 'sendBack', { idleMs: 0, sendBacks: 0 })).toBe(
      'rejected',
    )
    expect(
      stateOfDispatch(true, 'sendBack', {
        idleMs: SEND_BACK_IDLE_FLOOR_MS - 1,
        sendBacks: 0,
      }),
    ).toBe('rejected')
  })

  it('releases a send-back that has sat past the floor with attempts left', () => {
    expect(
      stateOfDispatch(true, 'sendBack', {
        idleMs: SEND_BACK_IDLE_FLOOR_MS,
        sendBacks: 0,
      }),
    ).toBe('failed')
    expect(
      stateOfDispatch(true, 'sendBack', { idleMs: 19 * HOUR, sendBacks: 1 }),
    ).toBe('failed')
  })

  it('holds it at the ceiling however long it sits - a person decides, not a timer', () => {
    expect(
      stateOfDispatch(true, 'sendBack', { idleMs: 1000 * HOUR, sendBacks: 2 }),
    ).toBe('rejected')
    expect(
      stateOfDispatch(true, 'sendBack', { idleMs: 1000 * HOUR, sendBacks: 9 }),
    ).toBe('rejected')
  })

  it('respects a ceiling passed in, so the number is not restated here', () => {
    expect(
      stateOfDispatch(true, 'sendBack', {
        idleMs: 19 * HOUR,
        sendBacks: 2,
        ceiling: 4,
      }),
    ).toBe('failed')
    expect(
      stateOfDispatch(true, 'sendBack', {
        idleMs: 19 * HOUR,
        sendBacks: 4,
        ceiling: 4,
      }),
    ).toBe('rejected')
  })

  it('never releases an escalation or a wait, whatever the clock says', () => {
    // An escalation wants a person and a wait is re-read by the reviewer each
    // round. Neither is the false promise this lease repairs, and releasing
    // them would retry work that nobody judged.
    for (const verdict of ['escalate', 'wait', null]) {
      expect(
        stateOfDispatch(true, verdict, { idleMs: 1000 * HOUR, sendBacks: 0 }),
      ).toBe('awaitingReview')
    }
  })

  it('never releases anything that has not finished', () => {
    expect(
      stateOfDispatch(false, 'sendBack', { idleMs: 1000 * HOUR, sendBacks: 0 }),
    ).toBe('running')
  })
})
