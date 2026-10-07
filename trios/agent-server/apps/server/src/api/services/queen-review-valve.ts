/**
 * The review valve: what happens to work the review did not accept.
 *
 * SOURCE. gHashTag/t27 `specs/queen/review_valve.t27` (t27#6616, PR
 * t27#6617). The constants are NOT restated here: they come from
 * `queen-review-valve.gen.js`, the verbatim output of
 * `t27c gen-js specs/queen/review_valve.t27` (t27c 0.4.0). Change the spec and
 * regenerate; never edit the generated file.
 *
 * `t27c gen-js` lowers declarations, not bodies, so the three functions below
 * are written by hand. Each one mirrors the spec function of the same name
 * line for line; if they differ, the spec is right. `pr_step` is the reviewer
 * bee's half (tools/bees/reviewer.py) and is not used by this supervisor.
 */
import {
  BACKFILL_WINDOW_MINUTES,
  CEILING_FLOOR_MINUTES,
  KIND_BASE_TRUTH_ALONE,
  KIND_BEYOND_THE_PATCH,
  KIND_DEAD_LETTER,
  KIND_NO_CRITERIA,
  KIND_REVIEWER_GAVE_UP,
  KIND_SEND_BACK_CEILING,
  KIND_UNRECORDED,
  MAX_RELEASES,
  RETRY_FLOOR_MINUTES,
  STEP_BACKFILL,
  STEP_CLOSE,
  STEP_HOLD,
  STEP_RELEASE,
} from './queen-review-valve.gen'

export * from './queen-review-valve.gen'

/** escalation_kind: the kind of an escalated row, from what the row records. */
export function escalationKind(
  criteria: number,
  sendBackCeiling: boolean,
  deadLetter: boolean,
  reviewerGaveUp: boolean,
): number {
  if (criteria === 0) return KIND_NO_CRITERIA
  if (sendBackCeiling) return KIND_SEND_BACK_CEILING
  if (deadLetter) return KIND_DEAD_LETTER
  if (reviewerGaveUp) return KIND_REVIEWER_GAVE_UP
  return KIND_UNRECORDED
}

/** wants_backfill: fixed by rewriting the criteria, not by another attempt. */
export function wantsBackfill(kind: number): boolean {
  return (
    kind === KIND_NO_CRITERIA ||
    kind === KIND_BEYOND_THE_PATCH ||
    kind === KIND_BASE_TRUTH_ALONE
  )
}

/** next_step: HOLD, RELEASE, BACKFILL or CLOSE. */
export function nextStep(
  kind: number,
  idleMinutes: number,
  releases: number,
): number {
  if (wantsBackfill(kind)) {
    if (idleMinutes >= BACKFILL_WINDOW_MINUTES) return STEP_CLOSE
    return STEP_BACKFILL
  }
  if (releases >= MAX_RELEASES) return STEP_CLOSE
  const floor =
    kind === KIND_SEND_BACK_CEILING
      ? CEILING_FLOOR_MINUTES
      : RETRY_FLOOR_MINUTES
  if (idleMinutes >= floor) return STEP_RELEASE
  return STEP_HOLD
}

/** The board state of a step; `held` is the state the row keeps while it waits. */
export function stateOfStep<H extends 'awaitingReview' | 'rejected'>(
  step: number,
  held: H,
): H | 'failed' | 'cancelled' {
  if (step === STEP_RELEASE) return 'failed'
  if (step === STEP_CLOSE) return 'cancelled'
  return held
}
