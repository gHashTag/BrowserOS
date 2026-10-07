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
    // A verdict that says failed is a failure, not something awaiting review.
    // Without this case it fell through to `awaitingReview`, which
    // `claimOnIssue` counts as a LIVE claim - so writing `failed` to release an
    // issue HELD it instead. Five issues and every worker slot, 2026-09-04.
    expect(stateOfDispatch(true, 'failed')).toBe('failed')
    expect(stateOfDispatch(true, 'cancelled')).toBe('failed')
    // And it does not depend on the lease: a failure is a failure at zero idle
    // and at the ceiling, because nothing about it is waiting for a clock.
    expect(
      stateOfDispatch(true, 'failed', { idleMs: 0, sendBacks: 9, ceiling: 2 }),
    ).toBe('failed')
    // The states that must NOT be swept up by it.
    expect(stateOfDispatch(true, 'accept')).toBe('accepted')
    expect(stateOfDispatch(true, 'sendBack')).toBe('rejected')
    expect(stateOfDispatch(false, 'failed')).toBe('running')
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

  // THIS RULE CHANGED ON 2026-09-20, and the old wording is kept so the change
  // is legible: "holds it at the ceiling however long it sits - a person
  // decides, not a timer". That is right the second time and wrong the first.
  // Measured that morning, after the adversarial review began refusing work the
  // compiler cannot build: 71 issues claimed by spent rows, 0 of 8 lanes
  // running, 673 candidates refused with "nothing to choose". Every refusal was
  // honest and the swarm still stopped, because nothing ever handed the issue
  // back. It is handed back ONCE now, an hour later, with the last review's
  // findings in the brief; the second time the review valve closes it as
  // obsolete (specs/queen/review_valve.t27), so the files are freed.
  it('hands a spent ceiling back once, an hour later, then closes it', () => {
    const spent = { sendBacks: 2, ceiling: 2 }
    expect(stateOfDispatch(true, 'sendBack', { ...spent, idleMs: 0 })).toBe(
      'rejected',
    )
    expect(
      stateOfDispatch(true, 'sendBack', { ...spent, idleMs: 1000 * HOUR }),
    ).toBe('failed')
    expect(
      stateOfDispatch(true, 'sendBack', {
        ...spent,
        idleMs: 1000 * HOUR,
        releases: 1,
      }),
    ).toBe('cancelled')
    expect(
      stateOfDispatch(true, 'sendBack', {
        idleMs: 1000 * HOUR,
        sendBacks: 9,
        releases: 1,
      }),
    ).toBe('cancelled')
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
        // Handed back once already: the valve closes it as obsolete
        // (specs/queen/review_valve.t27), so the boundary is freed.
        releases: 1,
      }),
    ).toBe('cancelled')
  })

  it('releases an escalation by the review valve, never by hand', () => {
    // This once said an escalation waits for a PERSON for ever. Measured
    // 2026-10-05: 144 escalate rows held their files and nobody came. The
    // owner's rule is now that no outcome waits for a person: an escalation
    // is released once (after RETRY_FLOOR_MINUTES) and then closed.
    expect(
      stateOfDispatch(true, 'escalate', { idleMs: 1000 * HOUR, sendBacks: 0 }),
    ).toBe('failed')
    expect(
      stateOfDispatch(true, 'escalate', {
        idleMs: 1000 * HOUR,
        sendBacks: 0,
        releases: 1,
      }),
    ).toBe('cancelled')
    expect(stateOfDispatch(true, 'escalate', { idleMs: 0, sendBacks: 0 })).toBe(
      'awaitingReview',
    )
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

  it('holds an escalation with no criteria for the backfill, then closes it', () => {
    expect(
      stateOfDispatch(true, 'escalate', {
        idleMs: 1000 * HOUR,
        sendBacks: 0,
        criteria: 0,
      }),
    ).toBe('cancelled')
    expect(
      stateOfDispatch(true, 'escalate', {
        idleMs: HOUR,
        sendBacks: 0,
        criteria: 0,
      }),
    ).toBe('awaitingReview')
  })

  it('is a longer clock than the send-back floor, and the test would fail if inverted', () => {
    expect(WAIT_FROZEN_FLOOR_MS).toBeGreaterThan(SEND_BACK_IDLE_FLOOR_MS)
  })
})

// The clock the valve reads must be one nothing touches.
//
// The first deploy measured idle from `reviewed_at ?? finished_at`, and the
// review sweep UPDATEs every wait row in place each round - so `reviewed_at`
// was refreshed every five minutes and a six-hour floor could never be
// reached. Measured in production: two dispatches frozen 18.4 hours reported
// 0.06 hours of idle. These pin the property rather than the field name, so a
// future edit that reintroduces a touched clock fails here.
describe('the lease clock', () => {
  it('releases on a long-frozen wait, which the touched clock made impossible', () => {
    const eighteenHours = 18.4 * 60 * 60 * 1000
    expect(
      stateOfDispatch(true, 'wait', { idleMs: eighteenHours, sendBacks: 0 }),
    ).toBe('failed')
  })

  it('is not fooled by a value just under the floor, so the floor still means something', () => {
    expect(
      stateOfDispatch(true, 'wait', {
        idleMs: WAIT_FROZEN_FLOOR_MS - 60_000,
        sendBacks: 0,
      }),
    ).toBe('awaitingReview')
  })

  it('still holds a wait at the retry ceiling however long it has been frozen', () => {
    expect(
      stateOfDispatch(true, 'wait', { idleMs: 1000 * HOUR, sendBacks: 2 }),
    ).toBe('awaitingReview')
  })
})
