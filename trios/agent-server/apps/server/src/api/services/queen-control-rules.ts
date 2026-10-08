/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The decisions of specs/queen/control.t27 sections 1 and 3 (gHashTag/t27#6657):
 * which event wakes the Queen, and what a person may do to a task.
 *
 * SOURCE. The constants are NOT restated here: they come from
 * `queen-control.gen.js`, the verbatim output of `t27c gen-js` on the vendored
 * card (specs/queen/control.t27, the blob named in its header). `t27c gen-js`
 * lowers declarations, not bodies, so each function below mirrors the spec
 * function of the same name line for line, and queen-control-rules.test.ts
 * checks it against the spec's own test vectors. If they differ, the spec is
 * right.
 */
import {
  A_AGENT_BUSY,
  A_HELD,
  A_OK,
  A_WRONG_DOMAIN,
  DO_GIVE_UP,
  DO_LOOK,
  DO_NOTHING,
  DO_RUN,
  DO_SKIP,
  EFF_DONE,
  EFF_NONE,
  EFFECT_RUN_LIMIT,
  EK_COMMENT,
  EK_PULL_REQUEST,
  EK_PUSH,
  EK_RELEASE,
  EV_ASSIGN,
  EV_CANCEL,
  EV_EVIDENCE,
  EV_LEASE_EXPIRED,
  EV_REVIEW,
  EV_TASK_CREATED,
  EV_TASK_ENDED,
  EV_TICK,
  EV_WORKER_IDLE,
  P_CLONE,
  P_REUSE,
  P_WAIT,
  R_ASSIGN,
  R_CANCEL,
  R_DISPATCH,
  R_NONE,
  R_RECLAIM,
  R_RECONCILE,
  R_REVIEW,
  SRC_AUTO,
  SRC_MANUAL,
  SRC_NONE,
  ST_BASE,
  ST_HOLD,
  ST_TIP,
  TIP_NONE,
  TIP_PR_CLOSED,
  TIP_SENT_BACK,
} from './queen-control.gen'

export * from './queen-control.gen'

/** reaction_of: what a woken Queen does for an event of this kind. */
export function reactionOf(kind: number): number {
  if (kind === EV_TASK_CREATED) return R_DISPATCH
  if (kind === EV_TASK_ENDED) return R_REVIEW
  if (kind === EV_WORKER_IDLE) return R_DISPATCH
  if (kind === EV_LEASE_EXPIRED) return R_RECLAIM
  if (kind === EV_EVIDENCE) return R_REVIEW
  if (kind === EV_REVIEW) return R_DISPATCH
  if (kind === EV_ASSIGN) return R_ASSIGN
  if (kind === EV_CANCEL) return R_CANCEL
  if (kind === EV_TICK) return R_RECONCILE
  return R_NONE
}

/** wakes_queen: a heartbeat needs no decision; every other kind wakes her. */
export function wakesQueen(kind: number): boolean {
  return reactionOf(kind) !== R_NONE
}

/** event_applies: only a sequence number past the last applied one counts. */
export function eventApplies(lastApplied: number, seq: number): boolean {
  return seq > lastApplied
}

/** next_source: a person's assignment is taken before the automatic choice. */
export function nextSource(
  manualPending: boolean,
  autoEligible: boolean,
): number {
  if (manualPending) return SRC_MANUAL
  if (autoEligible) return SRC_AUTO
  return SRC_NONE
}

/** assign_answer: a person cannot take a task out from under a live lease. */
export function assignAnswer(
  taskLeasedLive: boolean,
  agentIdle: boolean,
  domainMatch: boolean,
): number {
  if (taskLeasedLive) return A_HELD
  if (domainMatch === false) return A_WRONG_DOMAIN
  if (agentIdle === false) return A_AGENT_BUSY
  return A_OK
}

/** cancel_allowed: an accept is done; anything else can be cancelled. */
export function cancelAllowed(accepted: boolean): boolean {
  return accepted === false
}

/** fence_after_cancel: a cancel bumps the fence, so late writes do not land. */
export function fenceAfterCancel(fence: number): number {
  return fence + 1
}

/** cancel_counts_against_issue: an interruption spends no retry. */
export function cancelCountsAgainstIssue(): boolean {
  return false
}

/**
 * Section 7, the effects journal. effect_can_be_looked_up: whether GitHub can
 * say if an effect landed (a push, a pull request, a comment, a release).
 */
export function effectCanBeLookedUp(kind: number): boolean {
  if (kind === EK_PUSH) return true
  if (kind === EK_PULL_REQUEST) return true
  if (kind === EK_COMMENT) return true
  if (kind === EK_RELEASE) return true
  return false
}

/** rerun_or_give_up */
export function rerunOrGiveUp(runs: number): number {
  if (runs >= EFFECT_RUN_LIMIT) return DO_GIVE_UP
  return DO_RUN
}

/** write_lands */
export function writeLands(fence: number, myFence: number): boolean {
  return fence === myFence
}

/** effect_action: what a holder does before an effect, from its journal entry. */
export function effectAction(
  entry: number,
  kind: number,
  runs: number,
  fence: number,
  myFence: number,
): number {
  if (writeLands(fence, myFence) === false) return DO_NOTHING
  if (entry === EFF_NONE) return DO_RUN
  if (entry === EFF_DONE) return DO_SKIP
  if (effectCanBeLookedUp(kind)) return DO_LOOK
  return rerunOrGiveUp(runs)
}

/** after_look */
export function afterLook(found: boolean, runs: number): number {
  if (found) return DO_SKIP
  return rerunOrGiveUp(runs)
}

/** runs_after_intent */
export function runsAfterIntent(runs: number): number {
  return runs + 1
}

/**
 * placement (section 5): reuse an idle runtime of the task's domain, else clone
 * onto any free lane, else wait. A domain is an affinity, not a cap.
 */
export function placement(
  idleInDomain: number,
  running: number,
  cap: number,
): number {
  if (idleInDomain > 0) return P_REUSE
  if (running < cap) return P_CLONE
  return P_WAIT
}

/** attempt_start (section 6): where the next attempt on an issue starts. */
export function attemptStart(tip: number): number {
  if (tip === TIP_NONE) return ST_BASE
  if (tip === TIP_SENT_BACK) return ST_TIP
  if (tip === TIP_PR_CLOSED) return ST_TIP
  return ST_HOLD
}

/**
 * The candidate order a round hands `queend`: a person's assignments first, in
 * the order they were asked for, then the automatic order unchanged. `queend`
 * takes the first candidate that survives its checks, so this is next_source
 * with no second chooser: an assigned issue still has to declare a boundary,
 * hold no file another task holds, and fit the capacity, like any other.
 * Only issues already among the candidates are moved; an assignment on an
 * issue that is not open stays pending and changes nothing.
 */
export function manualFirst(candidates: number[], manual: number[]): number[] {
  const present = new Set(candidates)
  const first = manual.filter(
    (issue, i) => present.has(issue) && manual.indexOf(issue) === i,
  )
  const moved = new Set(first)
  return [...first, ...candidates.filter((issue) => !moved.has(issue))]
}
