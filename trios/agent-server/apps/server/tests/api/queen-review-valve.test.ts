import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import {
  BACKFILL_WINDOW_MINUTES,
  CEILING_FLOOR_MINUTES,
  escalationKind,
  KIND_BASE_TRUTH_ALONE,
  KIND_BEYOND_THE_PATCH,
  KIND_DEAD_LETTER,
  KIND_EMPTY_ACCEPT,
  KIND_NO_CRITERIA,
  KIND_REVIEWER_GAVE_UP,
  KIND_SEND_BACK_CEILING,
  KIND_UNRECORDED,
  MAX_RELEASES,
  nextStep,
  POLICY_HOLD_MINUTES,
  RETRY_FLOOR_MINUTES,
  STEP_BACKFILL,
  STEP_CLOSE,
  STEP_HOLD,
  STEP_RELEASE,
  stateOfStep,
  wantsBackfill,
} from '../../src/api/services/queen-review-valve'
import { closeObsolete } from '../../src/api/services/queen-tick'

// The same vectors as the test blocks of gHashTag/t27
// specs/queen/review_valve.t27, so the hand-written mirror of a function the
// generator does not lower cannot drift from the spec silently.
describe('the review valve mirrors its spec', () => {
  it('reads the kind from the row', () => {
    expect(escalationKind(0, true, true, true)).toBe(KIND_NO_CRITERIA)
    expect(escalationKind(3, true, true, false)).toBe(KIND_SEND_BACK_CEILING)
    expect(escalationKind(3, false, true, true)).toBe(KIND_DEAD_LETTER)
    expect(escalationKind(3, false, false, true)).toBe(KIND_REVIEWER_GAVE_UP)
    expect(escalationKind(3, false, false, false)).toBe(KIND_UNRECORDED)
  })

  it('releases an empty attempt after the floor', () => {
    expect(nextStep(KIND_DEAD_LETTER, 0, 0)).toBe(STEP_HOLD)
    expect(nextStep(KIND_DEAD_LETTER, 29, 0)).toBe(STEP_HOLD)
    expect(nextStep(KIND_DEAD_LETTER, 30, 0)).toBe(STEP_RELEASE)
    expect(nextStep(KIND_REVIEWER_GAVE_UP, 30, 0)).toBe(STEP_RELEASE)
    expect(nextStep(KIND_EMPTY_ACCEPT, 30, 0)).toBe(STEP_RELEASE)
    expect(nextStep(KIND_UNRECORDED, 30, 0)).toBe(STEP_RELEASE)
  })

  it('waits the hour on a spent ceiling, then gives it back once', () => {
    expect(nextStep(KIND_SEND_BACK_CEILING, 59, 0)).toBe(STEP_HOLD)
    expect(nextStep(KIND_SEND_BACK_CEILING, 60, 0)).toBe(STEP_RELEASE)
    expect(nextStep(KIND_SEND_BACK_CEILING, 60, 1)).toBe(STEP_CLOSE)
  })

  it('closes spent releases at once', () => {
    expect(nextStep(KIND_DEAD_LETTER, 0, 1)).toBe(STEP_CLOSE)
    expect(nextStep(KIND_SEND_BACK_CEILING, 0, 1)).toBe(STEP_CLOSE)
    expect(nextStep(KIND_UNRECORDED, 0, 5)).toBe(STEP_CLOSE)
  })

  it('backfills missing criteria, then closes', () => {
    expect(nextStep(KIND_NO_CRITERIA, 0, 0)).toBe(STEP_BACKFILL)
    expect(nextStep(KIND_BEYOND_THE_PATCH, 119, 0)).toBe(STEP_BACKFILL)
    expect(nextStep(KIND_BASE_TRUTH_ALONE, 120, 0)).toBe(STEP_CLOSE)
    expect(nextStep(KIND_NO_CRITERIA, 120, 0)).toBe(STEP_CLOSE)
    expect(wantsBackfill(KIND_DEAD_LETTER)).toBe(false)
  })

  it('lets no kind wait for a person', () => {
    for (let kind = KIND_UNRECORDED; kind <= KIND_BASE_TRUTH_ALONE; kind++) {
      const step = nextStep(kind, POLICY_HOLD_MINUTES, 0)
      expect(step === STEP_RELEASE || step === STEP_CLOSE).toBe(true)
    }
  })

  it('keeps every clock inside the policy hold', () => {
    expect(RETRY_FLOOR_MINUTES).toBeLessThan(CEILING_FLOOR_MINUTES)
    expect(CEILING_FLOOR_MINUTES).toBeLessThan(BACKFILL_WINDOW_MINUTES)
    expect(BACKFILL_WINDOW_MINUTES).toBeLessThan(POLICY_HOLD_MINUTES)
    expect(MAX_RELEASES).toBeGreaterThan(0)
  })

  it('maps a step to the policy state the claim rule reads', () => {
    expect(stateOfStep(STEP_RELEASE, 'rejected')).toBe('failed')
    expect(stateOfStep(STEP_CLOSE, 'awaitingReview')).toBe('cancelled')
    expect(stateOfStep(STEP_HOLD, 'rejected')).toBe('rejected')
    expect(stateOfStep(STEP_BACKFILL, 'awaitingReview')).toBe('awaitingReview')
  })
})

describe('closing an obsolete dispatch', () => {
  it('rewrites a cancelled row once, with the reason, and skips its issue', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        writes.push({ sql, params })
        return { rows: [], rowCount: 1 }
      },
    } as unknown as Pool
    const rows = [
      {
        issue: 11,
        review_state: 'escalate',
        send_backs: 2,
        ceiling_releases: 1,
      },
      { issue: 12, review_state: 'obsolete' },
      { issue: 13, review_state: 'wait' },
    ]
    const tasks = [
      { state: 'cancelled' },
      { state: 'cancelled' },
      { state: 'awaitingReview' },
    ]
    const closed = await closeObsolete(pool, rows, tasks)
    expect([...closed].sort()).toEqual([11, 12])
    const updates = writes.filter((w) => /UPDATE queen_dispatch/.test(w.sql))
    expect(updates).toHaveLength(1)
    expect(updates[0].params.slice(0, 3)).toEqual([11, 'escalate', 'obsolete'])
    expect(String(updates[0].params[3])).toContain('review_valve.t27')
    expect(updates[0].sql).toContain('review_state = $2')
    // and the board hears it (gHashTag/t27 specs/queen/events.t27)
    const events = writes.filter((w) =>
      /INSERT INTO queen_event_log/.test(w.sql),
    )
    expect(events).toHaveLength(1)
    expect(JSON.parse(String(events[0].params[2]))).toEqual({
      issue: 11,
      verdict: 'obsolete',
    })
  })
})
