/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The decisions of gHashTag/t27 specs/queen/jobs.t27 (t27#7676): a multi-step
 * job the Queen drives to its end, with no session open anywhere.
 *
 * SOURCE. The constants come from `queen-jobs.gen.js`, the verbatim output of
 * `t27c gen-js` on that card. `gen-js` lowers declarations, not bodies, so each
 * function below mirrors the spec function of the same name line for line, and
 * queen-jobs.test.ts holds it to the spec's own vectors. If they differ, the
 * spec is right.
 */
import {
  A_ADVANCE,
  A_FAIL,
  A_RETRY,
  A_STAY,
  E_REFUSE,
  E_REHEARSE,
  E_RUN,
  J_DONE,
  J_FAILED,
  J_RUNNING,
  O_BLOCKED,
  O_FAIL,
  O_NOT_YET,
  O_PASS,
  SK_WAIT,
  STEP_RUN_LIMIT,
  WAIT_LIMIT_MINUTES,
} from './queen-jobs.gen'

export * from './queen-jobs.gen'

/** step_action: advance, stay, retry or fail, from one step's answer. */
export function stepAction(
  kind: number,
  outcome: number,
  runs: number,
  waited: number,
): number {
  if (outcome === O_PASS) return A_ADVANCE
  if (outcome === O_NOT_YET) {
    if (kind !== SK_WAIT) return A_FAIL
    if (waited >= WAIT_LIMIT_MINUTES) return A_FAIL
    return A_STAY
  }
  if (outcome === O_BLOCKED) {
    if (waited >= WAIT_LIMIT_MINUTES) return A_FAIL
    return A_STAY
  }
  if (outcome === O_FAIL) {
    if (kind === SK_WAIT) return A_FAIL
    if (runs >= STEP_RUN_LIMIT) return A_FAIL
    return A_RETRY
  }
  return A_FAIL
}

/** job_state_after: advancing past the last step finishes the job. */
export function jobStateAfter(
  action: number,
  step: number,
  stepCount: number,
): number {
  if (action === A_FAIL) return J_FAILED
  if (action === A_ADVANCE) {
    if (step + 1 >= stepCount) return J_DONE
  }
  return J_RUNNING
}

/** step_after: the step the job is on afterwards. */
export function stepAfter(action: number, step: number): number {
  if (action === A_ADVANCE) return step + 1
  return step
}

/** cancel_allowed: only a running job may be cancelled; nothing is undone. */
export function jobCancelAllowed(state: number): boolean {
  return state === J_RUNNING
}

/** is_terminal */
export function isTerminal(state: number): boolean {
  return state !== J_RUNNING
}

/** effect_may_run: run, rehearse, or refuse an EFFECT step. */
export function effectMayRun(
  rehearsal: boolean,
  subjectPinned: boolean,
  checksAtSubject: boolean,
): number {
  if (subjectPinned === false) return E_REFUSE
  if (checksAtSubject === false) return E_REFUSE
  if (rehearsal) return E_REHEARSE
  return E_RUN
}

/** job_may_start: one running job per card. */
export function jobMayStart(runningOfCard: number): boolean {
  return runningOfCard === 0
}

export { A_STAY }
