import { describe, expect, it } from 'bun:test'
import {
  SEND_BACK_IDLE_FLOOR_MS,
  stateOfDispatch,
  WAIT_FROZEN_FLOOR_MS,
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

  it('never releases an escalation, whatever the clock says', () => {
    // This assertion once covered `wait` and `null` as well, and the wait valve
    // below deliberately changed that: a wait whose transcript is frozen can
    // never become anything else, so past a long floor it is released. The
    // assertion was narrowed rather than deleted, because the rule it still
    // states is the one that matters most here - an escalation asks for a
    // PERSON, and no timer is a person.
    expect(
      stateOfDispatch(true, 'escalate', { idleMs: 1000 * HOUR, sendBacks: 0 }),
    ).toBe('awaitingReview')
  })

  it('never releases anything that has not finished', () => {
    expect(
      stateOfDispatch(false, 'sendBack', { idleMs: 1000 * HOUR, sendBacks: 0 }),
    ).toBe('running')
  })
})

// The wait valve. Same defect, third state: `wait` means "not judged yet" and
// the transcript of a finished bee never changes, so it can never become
// anything else. Six hours rather than one, because a wait CAN resolve by
// itself on a later sweep and only a frozen one should be released.
describe('stateOfDispatch: the wait valve', () => {
  it('holds a wait that is younger than the frozen floor', () => {
    expect(
      stateOfDispatch(true, 'wait', {
        idleMs: WAIT_FROZEN_FLOOR_MS - 1,
        sendBacks: 0,
      }),
    ).toBe('awaitingReview')
  })

  it('releases a wait that has outlasted the floor with attempts left', () => {
    expect(
      stateOfDispatch(true, 'wait', {
        idleMs: WAIT_FROZEN_FLOOR_MS,
        sendBacks: 0,
      }),
    ).toBe('failed')
  })

  it('treats a missing verdict the same way, since it is the same condition', () => {
    expect(
      stateOfDispatch(true, null, {
        idleMs: WAIT_FROZEN_FLOOR_MS,
        sendBacks: 0,
      }),
    ).toBe('failed')
    expect(stateOfDispatch(true, null, { idleMs: 0, sendBacks: 0 })).toBe(
      'awaitingReview',
    )
  })

  it('holds it at the ceiling however long it sits', () => {
    expect(
      stateOfDispatch(true, 'wait', { idleMs: 1000 * HOUR, sendBacks: 2 }),
    ).toBe('awaitingReview')
  })

  it('NEVER releases an escalation - it asks for a person, and a timer is not one', () => {
    expect(
      stateOfDispatch(true, 'escalate', { idleMs: 1000 * HOUR, sendBacks: 0 }),
    ).toBe('awaitingReview')
  })

  it('is a longer clock than the send-back floor, and the test would fail if inverted', () => {
    expect(WAIT_FROZEN_FLOOR_MS).toBeGreaterThan(SEND_BACK_IDLE_FLOOR_MS)
  })
})
