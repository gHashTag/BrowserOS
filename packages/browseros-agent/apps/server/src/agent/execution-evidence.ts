/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  EvidenceEvent,
  NormalizedToolResult,
  ToolEffect,
} from './execution-types'

export interface ToolExecutionReceipt {
  readonly effectStatus?: NormalizedToolResult['effectStatus']
  readonly verificationStatus?: NormalizedToolResult['verificationStatus']
}

export interface ToolResultObservation {
  readonly outcome: 'resolved' | 'rejected' | 'denied' | 'aborted'
  readonly started: boolean
  readonly effects: readonly ToolEffect[]
  readonly output?: unknown
  readonly receipt?: ToolExecutionReceipt
}

const MUTATING_EFFECTS: ReadonlySet<ToolEffect> = new Set([
  'filesystem-write',
  'command',
  'browser-write',
  'external-write',
])

function isEffectStatus(
  value: unknown,
): value is NormalizedToolResult['effectStatus'] {
  return (
    value === 'none' ||
    value === 'applied' ||
    value === 'partial' ||
    value === 'unknown'
  )
}

function isVerificationStatus(
  value: unknown,
): value is NormalizedToolResult['verificationStatus'] {
  return (
    value === 'not-run' ||
    value === 'passed' ||
    value === 'failed' ||
    value === 'not-required'
  )
}

function isSemanticError(output: unknown): boolean {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return false
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(output, 'isError')
    return descriptor !== undefined && descriptor.value === true
  } catch {
    return false
  }
}

function executionStatus(
  observation: ToolResultObservation,
): NormalizedToolResult['executionStatus'] {
  switch (observation.outcome) {
    case 'rejected':
      return 'error'
    case 'denied':
      return 'denied'
    case 'aborted':
      return 'aborted'
    case 'resolved':
      return isSemanticError(observation.output) ? 'error' : 'success'
  }
}

export function normalizeToolResult(
  observation: ToolResultObservation,
): NormalizedToolResult {
  const status = executionStatus(observation)
  const mutatingEffectStarted =
    observation.started &&
    observation.effects.some((effect) => MUTATING_EFFECTS.has(effect))

  let effectStatus: NormalizedToolResult['effectStatus'] =
    mutatingEffectStarted && observation.outcome !== 'denied'
      ? 'unknown'
      : 'none'

  const receiptEffectStatus = observation.receipt?.effectStatus
  if (
    mutatingEffectStarted &&
    observation.outcome !== 'denied' &&
    isEffectStatus(receiptEffectStatus)
  ) {
    effectStatus = receiptEffectStatus
  }

  const defaultVerificationStatus: NormalizedToolResult['verificationStatus'] =
    status === 'success' && !mutatingEffectStarted ? 'not-required' : 'not-run'
  const receiptVerificationStatus = observation.receipt?.verificationStatus
  const verificationStatus = isVerificationStatus(receiptVerificationStatus)
    ? receiptVerificationStatus
    : defaultVerificationStatus

  return Object.freeze({
    transportStatus: observation.outcome === 'rejected' ? 'failed' : 'received',
    executionStatus: status,
    effectStatus,
    verificationStatus,
  })
}

function isFrozenEvidenceSnapshot(event: EvidenceEvent): boolean {
  return (
    Object.isFrozen(event) &&
    Object.isFrozen(event.effects) &&
    (event.result === undefined || Object.isFrozen(event.result))
  )
}

function snapshotEvidenceEvent(event: EvidenceEvent): EvidenceEvent {
  const effects = Object.freeze([...event.effects])
  const result =
    event.result === undefined ? undefined : Object.freeze({ ...event.result })

  return Object.freeze({
    ...event,
    effects,
    result,
  })
}

export function appendEvidence(
  ledger: readonly EvidenceEvent[],
  event: EvidenceEvent,
): readonly EvidenceEvent[] {
  const prior = ledger.map((entry) =>
    isFrozenEvidenceSnapshot(entry) ? entry : snapshotEvidenceEvent(entry),
  )
  return Object.freeze([...prior, snapshotEvidenceEvent(event)])
}
