/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The single A2A liveness threshold, derived once and shared by every site
 * that decides whether an agent counts as alive.
 *
 * RING-01 (trios/rings/T27-01/a2a.t27) states the rule once:
 * HEARTBEAT_INTERVAL_SECONDS * MISSED_BEATS_BEFORE_OFFLINE, with an
 * inclusive boundary - an agent silent for exactly the threshold is still
 * alive, and a negative age (clocks disagreeing, the last beat appearing
 * to be in the future) is answered as alive rather than left to arithmetic.
 * The registry service used to transcribe that number by hand at three
 * sites and drifted (gHashTag/trios#1388); this module is the one place
 * the derivation now lives on the server side.
 *
 * This module deliberately contains no import statements: a fresh worktree
 * has no node_modules, and the unit test for this rule must run without an
 * install. Keep it that way.
 */

/** Heartbeat cadence, in seconds. Mirrors a2a.t27 HEARTBEAT_INTERVAL_SECONDS. */
export const HEARTBEAT_INTERVAL_SECONDS = 30

/**
 * Beats that may be missed before an agent is called offline.
 * Mirrors a2a.t27 MISSED_BEATS_BEFORE_OFFLINE.
 */
export const MISSED_BEATS_BEFORE_OFFLINE = 3

export type A2aLivenessUnit = 'seconds' | 'milliseconds'

/**
 * The offline threshold in the requested unit, derived from the one spec
 * product rather than written out per unit. pruneOffline takes seconds;
 * the memory-path comparisons are in milliseconds. Naming the unit at the
 * call site keeps a bare number, whose unit has to be inferred from
 * surrounding code, out of the service.
 */
export function a2aLivenessThreshold(unit: A2aLivenessUnit): number {
  const offlineAfterSeconds =
    HEARTBEAT_INTERVAL_SECONDS * MISSED_BEATS_BEFORE_OFFLINE
  return unit === 'seconds' ? offlineAfterSeconds : offlineAfterSeconds * 1000
}

/**
 * Whether an agent counts as alive, given how long since its last
 * heartbeat, in milliseconds. Mirrors a2a.t27 is_alive: inclusive on the
 * boundary, and a negative age is answered as alive - the case the spec
 * spells out rather than leaving to arithmetic.
 */
export function a2aIsAlive(msSinceLastHeartbeat: number): boolean {
  if (msSinceLastHeartbeat < 0) {
    return true
  }
  return msSinceLastHeartbeat <= a2aLivenessThreshold('milliseconds')
}
