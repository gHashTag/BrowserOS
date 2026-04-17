/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * State Recovery Helpers
 *
 * Helper functions for testing state recovery across reconnects:
 * - Assert state sequence
 * - Verify reconnect preserves state
 * - Measure reconnect latency
 */

import type { A2AConnectionState, A2AAgentState, A2AStateTransition } from '../../../src/agent/portable/a2a-types'

/**
 * Expected state transition for validation
 */
export interface ExpectedTransition {
  from: string
  to: string
  reason?: string
}

/**
 * Latency measurement result
 */
export interface LatencyMeasurement {
  startEvent: string
  endEvent: string
  durationMs: number
  timestamp: number
}

/**
 * State validation result
 */
export interface StateValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Assert state sequence matches expected transitions
 */
export function assertStateSequence(
  logs: A2AStateTransition[],
  expectedTransitions: ExpectedTransition[],
): StateValidationResult {
  const result: StateValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  }

  if (logs.length !== expectedTransitions.length) {
    result.valid = false
    result.errors.push(
      `Transition count mismatch. Expected: ${expectedTransitions.length}, Actual: ${logs.length}`,
    )
  }

  for (let i = 0; i < Math.min(logs.length, expectedTransitions.length); i++) {
    const actual = logs[i]
    const expected = expectedTransitions[i]

    if (actual.from !== expected.from) {
      result.valid = false
      result.errors.push(
        `Transition ${i}: "from" mismatch. Expected: ${expected.from}, Actual: ${actual.from}`,
      )
    }

    if (actual.to !== expected.to) {
      result.valid = false
      result.errors.push(
        `Transition ${i}: "to" mismatch. Expected: ${expected.to}, Actual: ${actual.to}`,
      )
    }

    if (expected.reason && actual.reason !== expected.reason) {
      result.warnings.push(
        `Transition ${i}: reason differs. Expected: ${expected.reason}, Actual: ${actual.reason}`,
      )
    }
  }

  return result
}

/**
 * Verify state is preserved across reconnect
 */
export function verifyReconnectPreservesState(
  initialState: Record<string, unknown>,
  reconnectState: Record<string, unknown>,
  preservedKeys: string[],
): StateValidationResult {
  const result: StateValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  }

  for (const key of preservedKeys) {
    const initialValue = initialState[key]
    const reconnectValue = reconnectState[key]

    if (initialValue !== reconnectValue) {
      result.valid = false
      result.errors.push(
        `State not preserved for key "${key}". Initial: ${initialValue}, After reconnect: ${reconnectValue}`,
      )
    }
  }

  return result
}

/**
 * Measure reconnect latency from start to end event
 */
export function measureReconnectLatency(
  startEvent: { timestamp: number; name: string },
  endEvent: { timestamp: number; name: string },
): LatencyMeasurement {
  const durationMs = endEvent.timestamp - startEvent.timestamp

  return {
    startEvent: startEvent.name,
    endEvent: endEvent.name,
    durationMs,
    timestamp: Date.now(),
  }
}

/**
 * Verify exponential backoff delay pattern
 */
export function verifyExponentialBackoff(
  delays: number[],
  baseDelay: number = 1000,
  maxDelay: number = 30000,
  tolerancePercent: number = 25,
): StateValidationResult {
  const result: StateValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  }

  for (let i = 0; i < delays.length; i++) {
    const actual = delays[i]
    const expected = Math.min(baseDelay * Math.pow(2, i), maxDelay)
    const tolerance = expected * (tolerancePercent / 100)
    const minExpected = expected - tolerance
    const maxExpected = expected + tolerance

    if (actual < minExpected || actual > maxExpected) {
      result.valid = false
      result.errors.push(
        `Attempt ${i}: delay outside expected range. ` +
          `Expected: ${expected}ms ±${tolerancePercent}%, Actual: ${actual}ms`,
      )
    }
  }

  return result
}

/**
 * Check for state gaps or inconsistencies
 */
export function detectStateGaps(
  logs: A2AStateTransition[],
): StateValidationResult {
  const result: StateValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  }

  for (let i = 1; i < logs.length; i++) {
    const prev = logs[i - 1]
    const curr = logs[i]

    // Detect duplicate states (rapid toggling)
    if (prev.to === curr.from && prev.from === curr.to) {
      result.warnings.push(
        `Rapid state toggling detected between ${prev.from} and ${prev.to}`,
      )
    }

    // Detect invalid transitions (from closed to connected without connecting)
    if (prev.to === 'closed' && curr.to === 'connected' && curr.to !== 'connecting') {
      result.errors.push(
        `Invalid state transition: from ${prev.to} to ${curr.to} without intermediate connecting state`,
      )
      result.valid = false
    }
  }

  return result
}

/**
 * Verify connection state follows valid progression
 */
export function verifyConnectionStateProgression(
  states: A2AConnectionState[],
): StateValidationResult {
  const result: StateValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  }

  const validProgressions: Record<string, string[]> = {
    disconnected: ['connecting', 'closed'],
    connecting: ['connected', 'disconnected', 'closed'],
    connected: ['disconnected', 'closed'],
    reconnecting: ['connected', 'disconnected', 'closed'],
    closed: [],
  }

  for (let i = 1; i < states.length; i++) {
    const from = states[i - 1]
    const to = states[i]

    const allowed = validProgressions[from] || []

    if (!allowed.includes(to)) {
      result.valid = false
      result.errors.push(
        `Invalid state progression: ${from} → ${to}. Allowed: ${allowed.join(', ') || 'none'}`,
      )
    }
  }

  return result
}

/**
 * Extract timestamps from state transitions for latency measurement
 */
export function extractTransitionTimestamps(
  logs: A2AStateTransition[],
  transitionType: 'to' | 'from',
  targetState: string,
): number[] {
  return logs
    .filter((log) => log[transitionType] === targetState)
    .map((log) => log.timestamp)
}

/**
 * Find state transition by reason
 */
export function findTransitionByReason(
  logs: A2AStateTransition[],
  reason: string,
): A2AStateTransition | undefined {
  return logs.find((log) => log.reason === reason)
}

/**
 * Get state at specific timestamp
 */
export function getStateAtTimestamp(
  logs: A2AStateTransition[],
  timestamp: number,
): A2AConnectionState | A2AAgentState | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].timestamp <= timestamp) {
      return logs[i].to
    }
  }

  return null
}
