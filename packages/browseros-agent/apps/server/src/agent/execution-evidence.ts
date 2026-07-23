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

type ObservationOutcome = ToolResultObservation['outcome']

type OwnDataProperty =
  | { readonly state: 'absent' }
  | { readonly state: 'invalid' }
  | { readonly state: 'data'; readonly value: unknown }

interface ReceiptSnapshot {
  readonly valid: boolean
  readonly effectStatus?: NormalizedToolResult['effectStatus']
  readonly verificationStatus?: 'passed' | 'failed'
}

interface EffectsSnapshot {
  readonly valid: boolean
  readonly values: readonly ToolEffect[]
}

interface ObservationSnapshot {
  readonly outcomeValid: boolean
  readonly outcome?: ObservationOutcome
  readonly startedValid: boolean
  readonly started?: boolean
  readonly effectsValid: boolean
  readonly effects: readonly ToolEffect[]
  readonly outputValid: boolean
  readonly output?: unknown
  readonly receipt: ReceiptSnapshot
}

const KNOWN_EFFECTS: ReadonlySet<ToolEffect> = new Set([
  'observe',
  'filesystem-read',
  'filesystem-write',
  'command',
  'browser-write',
  'external-write',
  'verify',
])

const MUTATING_EFFECTS: ReadonlySet<ToolEffect> = new Set([
  'filesystem-write',
  'command',
  'browser-write',
  'external-write',
])

const OWNED_EVIDENCE_EVENTS = new WeakSet<object>()
const MAX_EFFECT_COUNT = 64

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function safeArrayCheck(value: object): boolean | undefined {
  try {
    return Array.isArray(value)
  } catch {
    return undefined
  }
}

function isNonArrayObject(value: unknown): value is object {
  return isObject(value) && safeArrayCheck(value) === false
}

function readOwnDataProperty(
  value: unknown,
  property: PropertyKey,
): OwnDataProperty {
  if (!isObject(value)) {
    return { state: 'invalid' }
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property)
    if (descriptor === undefined) {
      return { state: 'absent' }
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      return { state: 'invalid' }
    }
    return { state: 'data', value: descriptor.value }
  } catch {
    return { state: 'invalid' }
  }
}

function isOutcome(value: unknown): value is ObservationOutcome {
  return (
    value === 'resolved' ||
    value === 'rejected' ||
    value === 'denied' ||
    value === 'aborted'
  )
}

function isToolEffect(value: unknown): value is ToolEffect {
  return typeof value === 'string' && KNOWN_EFFECTS.has(value as ToolEffect)
}

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

function isTransportStatus(
  value: unknown,
): value is NormalizedToolResult['transportStatus'] {
  return value === 'received' || value === 'failed'
}

function isExecutionStatus(
  value: unknown,
): value is NormalizedToolResult['executionStatus'] {
  return (
    value === 'success' ||
    value === 'error' ||
    value === 'denied' ||
    value === 'aborted'
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

function snapshotEffects(value: unknown): EffectsSnapshot {
  if (!isObject(value) || safeArrayCheck(value) !== true) {
    return { valid: false, values: Object.freeze([]) }
  }

  const lengthProperty = readOwnDataProperty(value, 'length')
  if (
    lengthProperty.state !== 'data' ||
    !Number.isSafeInteger(lengthProperty.value) ||
    (lengthProperty.value as number) < 0 ||
    (lengthProperty.value as number) > MAX_EFFECT_COUNT
  ) {
    return { valid: false, values: Object.freeze([]) }
  }

  const effects: ToolEffect[] = []
  for (let index = 0; index < (lengthProperty.value as number); index += 1) {
    const effectProperty = readOwnDataProperty(value, String(index))
    if (
      effectProperty.state !== 'data' ||
      !isToolEffect(effectProperty.value)
    ) {
      return { valid: false, values: Object.freeze([]) }
    }
    effects.push(effectProperty.value)
  }

  return { valid: true, values: Object.freeze(effects) }
}

function snapshotReceipt(value: unknown): ReceiptSnapshot {
  if (value === undefined) {
    return { valid: true }
  }
  if (!isNonArrayObject(value)) {
    return { valid: false }
  }

  const effectProperty = readOwnDataProperty(value, 'effectStatus')
  if (effectProperty.state === 'invalid') {
    return { valid: false }
  }
  const effectValue =
    effectProperty.state === 'data' ? effectProperty.value : undefined
  if (effectValue !== undefined && !isEffectStatus(effectValue)) {
    return { valid: false }
  }

  const verificationProperty = readOwnDataProperty(value, 'verificationStatus')
  if (verificationProperty.state === 'invalid') {
    return { valid: false }
  }
  const verificationValue =
    verificationProperty.state === 'data'
      ? verificationProperty.value
      : undefined
  if (
    verificationValue !== undefined &&
    !isVerificationStatus(verificationValue)
  ) {
    return { valid: false }
  }

  return {
    valid: true,
    effectStatus: isEffectStatus(effectValue) ? effectValue : undefined,
    verificationStatus:
      verificationValue === 'passed' || verificationValue === 'failed'
        ? verificationValue
        : undefined,
  }
}

function snapshotObservation(value: unknown): ObservationSnapshot {
  const invalidSnapshot: ObservationSnapshot = {
    outcomeValid: false,
    startedValid: false,
    effectsValid: false,
    effects: Object.freeze([]),
    outputValid: false,
    receipt: { valid: false },
  }
  if (!isNonArrayObject(value)) {
    return invalidSnapshot
  }

  const outcomeProperty = readOwnDataProperty(value, 'outcome')
  const startedProperty = readOwnDataProperty(value, 'started')
  const effectsProperty = readOwnDataProperty(value, 'effects')
  const outputProperty = readOwnDataProperty(value, 'output')
  const receiptProperty = readOwnDataProperty(value, 'receipt')

  const outcomeValue =
    outcomeProperty.state === 'data' ? outcomeProperty.value : undefined
  const startedValue =
    startedProperty.state === 'data' ? startedProperty.value : undefined
  const effectsSnapshot =
    effectsProperty.state === 'data'
      ? snapshotEffects(effectsProperty.value)
      : { valid: false, values: Object.freeze([]) }
  const outputValid =
    outputProperty.state === 'absent' || outputProperty.state === 'data'
  const receiptSnapshot =
    receiptProperty.state === 'invalid'
      ? { valid: false }
      : snapshotReceipt(
          receiptProperty.state === 'data' ? receiptProperty.value : undefined,
        )

  return {
    outcomeValid: isOutcome(outcomeValue),
    outcome: isOutcome(outcomeValue) ? outcomeValue : undefined,
    startedValid: typeof startedValue === 'boolean',
    started: typeof startedValue === 'boolean' ? startedValue : undefined,
    effectsValid: effectsSnapshot.valid,
    effects: effectsSnapshot.values,
    outputValid,
    output: outputProperty.state === 'data' ? outputProperty.value : undefined,
    receipt: receiptSnapshot,
  }
}

function inspectSemanticOutput(
  output: unknown,
): 'success' | 'error' | 'malformed' {
  if (!isObject(output)) {
    return 'success'
  }

  const arrayCheck = safeArrayCheck(output)
  if (arrayCheck === true) {
    return 'success'
  }
  if (arrayCheck === undefined) {
    return 'malformed'
  }

  const errorProperty = readOwnDataProperty(output, 'isError')
  if (errorProperty.state === 'invalid') {
    return 'malformed'
  }
  return errorProperty.state === 'data' && errorProperty.value === true
    ? 'error'
    : 'success'
}

export function normalizeToolResult(
  observation: ToolResultObservation,
): NormalizedToolResult {
  const snapshot = snapshotObservation(observation)
  const semanticStatus = snapshot.outputValid
    ? inspectSemanticOutput(snapshot.output)
    : 'malformed'
  const wellFormed =
    snapshot.outcomeValid &&
    snapshot.startedValid &&
    snapshot.effectsValid &&
    snapshot.outputValid &&
    snapshot.receipt.valid &&
    semanticStatus !== 'malformed'
  const mutatingEffect = snapshot.effects.some((effect) =>
    MUTATING_EFFECTS.has(effect),
  )

  let status: NormalizedToolResult['executionStatus'] = 'error'
  if (snapshot.outcomeValid) {
    switch (snapshot.outcome) {
      case 'rejected':
        status = 'error'
        break
      case 'denied':
        status = 'denied'
        break
      case 'aborted':
        status = 'aborted'
        break
      case 'resolved':
        status =
          wellFormed &&
          snapshot.started === true &&
          semanticStatus === 'success'
            ? 'success'
            : 'error'
        break
    }
  }

  let effectStatus: NormalizedToolResult['effectStatus']
  if (
    snapshot.outcome === 'denied' ||
    (snapshot.startedValid && snapshot.started === false)
  ) {
    effectStatus = 'none'
  } else if (!snapshot.startedValid || !snapshot.effectsValid) {
    effectStatus = 'unknown'
  } else {
    effectStatus = mutatingEffect ? 'unknown' : 'none'
  }

  const canTrustReceipt =
    wellFormed && snapshot.started === true && snapshot.outcome !== 'denied'
  if (
    canTrustReceipt &&
    mutatingEffect &&
    snapshot.receipt.effectStatus !== undefined
  ) {
    effectStatus = snapshot.receipt.effectStatus
  }

  const verificationStatus: NormalizedToolResult['verificationStatus'] =
    canTrustReceipt && snapshot.receipt.verificationStatus !== undefined
      ? snapshot.receipt.verificationStatus
      : 'not-run'

  return Object.freeze({
    transportStatus:
      !snapshot.outcomeValid || snapshot.outcome === 'rejected'
        ? 'failed'
        : 'received',
    executionStatus: status,
    effectStatus,
    verificationStatus,
  })
}

function evidenceSnapshotError(property: string): TypeError {
  return new TypeError(
    `Cannot snapshot evidence event: '${property}' must be a valid own data property`,
  )
}

function requireEventProperty(event: unknown, property: string): unknown {
  const value = readOwnDataProperty(event, property)
  if (value.state !== 'data') {
    throw evidenceSnapshotError(property)
  }
  return value.value
}

function optionalEventProperty(event: unknown, property: string): unknown {
  const value = readOwnDataProperty(event, property)
  if (value.state === 'invalid') {
    throw evidenceSnapshotError(property)
  }
  return value.state === 'data' ? value.value : undefined
}

function requireStringProperty(event: unknown, property: string): string {
  const value = requireEventProperty(event, property)
  if (typeof value !== 'string') {
    throw evidenceSnapshotError(property)
  }
  return value
}

function snapshotNormalizedResult(value: unknown): NormalizedToolResult {
  if (!isNonArrayObject(value)) {
    throw evidenceSnapshotError('result')
  }

  const transportStatus = requireEventProperty(value, 'transportStatus')
  const executionStatus = requireEventProperty(value, 'executionStatus')
  const effectStatus = requireEventProperty(value, 'effectStatus')
  const verificationStatus = requireEventProperty(value, 'verificationStatus')
  if (
    !isTransportStatus(transportStatus) ||
    !isExecutionStatus(executionStatus) ||
    !isEffectStatus(effectStatus) ||
    !isVerificationStatus(verificationStatus)
  ) {
    throw evidenceSnapshotError('result')
  }

  return Object.freeze({
    transportStatus,
    executionStatus,
    effectStatus,
    verificationStatus,
  })
}

function snapshotEvidenceEvent(
  event: EvidenceEvent,
  reuseOwned: boolean,
): EvidenceEvent {
  if (!isNonArrayObject(event)) {
    throw evidenceSnapshotError('event')
  }
  if (reuseOwned && OWNED_EVIDENCE_EVENTS.has(event)) {
    return event
  }

  const eventId = requireStringProperty(event, 'eventId')
  const toolCallId = requireStringProperty(event, 'toolCallId')
  const toolName = requireStringProperty(event, 'toolName')
  const kind = requireEventProperty(event, 'kind')
  const effectsSnapshot = snapshotEffects(
    requireEventProperty(event, 'effects'),
  )
  const retrySafety = requireEventProperty(event, 'retrySafety')
  const resultValue = optionalEventProperty(event, 'result')
  const argumentDigest = requireStringProperty(event, 'argumentDigest')
  const outputDigestValue = optionalEventProperty(event, 'outputDigest')
  const recordedAt = requireEventProperty(event, 'recordedAt')

  if (
    (kind !== 'requested' && kind !== 'settled' && kind !== 'verification') ||
    !effectsSnapshot.valid ||
    (retrySafety !== 'safe' &&
      retrySafety !== 'unsafe' &&
      retrySafety !== 'unknown') ||
    (outputDigestValue !== undefined &&
      typeof outputDigestValue !== 'string') ||
    typeof recordedAt !== 'number' ||
    !Number.isFinite(recordedAt)
  ) {
    throw evidenceSnapshotError('event')
  }

  const snapshot: EvidenceEvent = Object.freeze({
    eventId,
    toolCallId,
    toolName,
    kind,
    effects: effectsSnapshot.values,
    retrySafety,
    result:
      resultValue === undefined
        ? undefined
        : snapshotNormalizedResult(resultValue),
    argumentDigest,
    outputDigest: outputDigestValue,
    recordedAt,
  })
  OWNED_EVIDENCE_EVENTS.add(snapshot)
  return snapshot
}

export function appendEvidence(
  ledger: readonly EvidenceEvent[],
  event: EvidenceEvent,
): readonly EvidenceEvent[] {
  const prior = ledger.map((entry) => snapshotEvidenceEvent(entry, true))
  return Object.freeze([...prior, snapshotEvidenceEvent(event, false)])
}
