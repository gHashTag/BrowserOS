/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto'
import type { ToolExecutionOptions, ToolSet } from 'ai'
import type {
  DigestFidelity,
  EvidenceEvent,
  NormalizedToolResult,
  ToolEffect,
} from './execution-types'
import {
  type RuntimeToolExecute,
  wrapToolExecuteProperty,
} from './tool-execute-wrapper'
import { observeToolReturn } from './tool-return-observer'
import {
  createToolSetDictionary,
  defineToolSetEntry,
} from './tool-set-dictionary'

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

export interface ToolEvidenceSink {
  record(event: EvidenceEvent): void
}

export interface ToolReliabilityDescriptor {
  readonly effects: readonly ToolEffect[]
  readonly retrySafety: 'safe' | 'unsafe' | 'unknown'
}

export type ToolReliabilitySource =
  | {
      readonly kind: 'browser'
      readonly approvalCategory?: string
    }
  | { readonly kind: 'external' }
  | { readonly kind: 'filesystem' }
  | { readonly kind: 'memory' }

export interface ToolReliabilityLayer {
  readonly toolNames: readonly string[]
  readonly describeTool: (name: string) => ToolReliabilityDescriptor
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
const MAX_LEDGER_EVENT_COUNT = 10_000

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

function isDigestFidelity(value: unknown): value is DigestFidelity {
  return value === 'exact' || value === 'coarse' || value === 'unavailable'
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
  const argumentDigestFidelity = requireEventProperty(
    event,
    'argumentDigestFidelity',
  )
  const outputDigestValue = optionalEventProperty(event, 'outputDigest')
  const outputDigestFidelity = optionalEventProperty(
    event,
    'outputDigestFidelity',
  )
  const recordedAt = requireEventProperty(event, 'recordedAt')

  if (
    (kind !== 'requested' && kind !== 'settled' && kind !== 'verification') ||
    !effectsSnapshot.valid ||
    (retrySafety !== 'safe' &&
      retrySafety !== 'unsafe' &&
      retrySafety !== 'unknown') ||
    !isDigestFidelity(argumentDigestFidelity) ||
    (outputDigestValue !== undefined &&
      typeof outputDigestValue !== 'string') ||
    (outputDigestValue === undefined) !==
      (outputDigestFidelity === undefined) ||
    (outputDigestFidelity !== undefined &&
      !isDigestFidelity(outputDigestFidelity)) ||
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
    argumentDigestFidelity,
    outputDigest: outputDigestValue,
    outputDigestFidelity,
    recordedAt,
  })
  OWNED_EVIDENCE_EVENTS.add(snapshot)
  return snapshot
}

function evidenceLedgerError(): TypeError {
  return new TypeError(
    'Cannot snapshot evidence ledger: expected a bounded dense array of own data entries',
  )
}

function snapshotLedgerEntries(ledger: unknown): readonly EvidenceEvent[] {
  if (!isObject(ledger) || safeArrayCheck(ledger) !== true) {
    throw evidenceLedgerError()
  }

  const lengthProperty = readOwnDataProperty(ledger, 'length')
  if (
    lengthProperty.state !== 'data' ||
    !Number.isSafeInteger(lengthProperty.value) ||
    (lengthProperty.value as number) < 0 ||
    (lengthProperty.value as number) > MAX_LEDGER_EVENT_COUNT
  ) {
    throw evidenceLedgerError()
  }

  const entries: EvidenceEvent[] = []
  for (let index = 0; index < (lengthProperty.value as number); index += 1) {
    const entryProperty = readOwnDataProperty(ledger, String(index))
    if (entryProperty.state !== 'data') {
      throw evidenceLedgerError()
    }
    entries.push(
      snapshotEvidenceEvent(entryProperty.value as EvidenceEvent, true),
    )
  }
  return entries
}

export function appendEvidence(
  ledger: readonly EvidenceEvent[],
  event: EvidenceEvent,
): readonly EvidenceEvent[] {
  const prior = snapshotLedgerEntries(ledger)
  return Object.freeze([...prior, snapshotEvidenceEvent(event, false)])
}

const OBSERVE_SAFE_DESCRIPTOR: ToolReliabilityDescriptor = Object.freeze({
  effects: Object.freeze(['observe'] as const),
  retrySafety: 'safe',
})
const FILESYSTEM_READ_SAFE_DESCRIPTOR: ToolReliabilityDescriptor =
  Object.freeze({
    effects: Object.freeze(['filesystem-read'] as const),
    retrySafety: 'safe',
  })
const FILESYSTEM_WRITE_SAFE_DESCRIPTOR: ToolReliabilityDescriptor =
  Object.freeze({
    effects: Object.freeze(['filesystem-write'] as const),
    retrySafety: 'safe',
  })
const FILESYSTEM_WRITE_UNSAFE_DESCRIPTOR: ToolReliabilityDescriptor =
  Object.freeze({
    effects: Object.freeze(['filesystem-write'] as const),
    retrySafety: 'unsafe',
  })
const FILESYSTEM_WRITE_UNKNOWN_DESCRIPTOR: ToolReliabilityDescriptor =
  Object.freeze({
    effects: Object.freeze(['filesystem-write'] as const),
    retrySafety: 'unknown',
  })
const COMMAND_UNKNOWN_DESCRIPTOR: ToolReliabilityDescriptor = Object.freeze({
  effects: Object.freeze(['command'] as const),
  retrySafety: 'unknown',
})
const BROWSER_WRITE_UNSAFE_DESCRIPTOR: ToolReliabilityDescriptor =
  Object.freeze({
    effects: Object.freeze(['browser-write'] as const),
    retrySafety: 'unsafe',
  })
const BROWSER_WRITE_UNKNOWN_DESCRIPTOR: ToolReliabilityDescriptor =
  Object.freeze({
    effects: Object.freeze(['browser-write'] as const),
    retrySafety: 'unknown',
  })
const EXTERNAL_WRITE_UNKNOWN_DESCRIPTOR: ToolReliabilityDescriptor =
  Object.freeze({
    effects: Object.freeze(['external-write'] as const),
    retrySafety: 'unknown',
  })

const FILESYSTEM_READ_TOOL_NAMES = new Set([
  'filesystem_read',
  'filesystem_grep',
  'filesystem_find',
  'filesystem_ls',
])
const MEMORY_READ_TOOL_NAMES = new Set([
  'memory_search',
  'memory_read_core',
  'soul_read',
])
const MEMORY_WRITE_TOOL_NAMES = new Set([
  'memory_write',
  'memory_update_core',
  'soul_update',
])

/**
 * Resolve reliability from both the final tool name and the source that won
 * merge precedence. Names alone are insufficient because MCP tools may collide
 * with BrowserOS or local tools.
 */
export function resolveToolReliabilityDescriptor(
  name: string,
  source: ToolReliabilitySource,
): ToolReliabilityDescriptor {
  switch (source.kind) {
    case 'browser':
      return source.approvalCategory === 'observation' ||
        source.approvalCategory === 'screenshots'
        ? OBSERVE_SAFE_DESCRIPTOR
        : source.approvalCategory === undefined
          ? BROWSER_WRITE_UNKNOWN_DESCRIPTOR
          : BROWSER_WRITE_UNSAFE_DESCRIPTOR
    case 'external':
      return EXTERNAL_WRITE_UNKNOWN_DESCRIPTOR
    case 'filesystem':
      if (FILESYSTEM_READ_TOOL_NAMES.has(name)) {
        return FILESYSTEM_READ_SAFE_DESCRIPTOR
      }
      // filesystem_write is a complete overwrite, so repeating the same
      // validated input is idempotent. Edit and command execution are not.
      if (name === 'filesystem_write') {
        return FILESYSTEM_WRITE_SAFE_DESCRIPTOR
      }
      if (name === 'filesystem_edit') {
        return FILESYSTEM_WRITE_UNSAFE_DESCRIPTOR
      }
      if (name === 'filesystem_bash') {
        return COMMAND_UNKNOWN_DESCRIPTOR
      }
      return FILESYSTEM_WRITE_UNKNOWN_DESCRIPTOR
    case 'memory':
      if (MEMORY_READ_TOOL_NAMES.has(name)) {
        return FILESYSTEM_READ_SAFE_DESCRIPTOR
      }
      if (MEMORY_WRITE_TOOL_NAMES.has(name)) {
        return FILESYSTEM_WRITE_UNSAFE_DESCRIPTOR
      }
      return FILESYSTEM_WRITE_UNKNOWN_DESCRIPTOR
  }
}

export function createMergedToolDescriptorResolver(
  layers: readonly ToolReliabilityLayer[],
): (name: string) => ToolReliabilityDescriptor {
  const descriptors = new Map<string, ToolReliabilityDescriptor>()
  for (const layer of layers) {
    for (const name of layer.toolNames) {
      try {
        descriptors.set(name, layer.describeTool(name))
      } catch {
        descriptors.set(name, EXTERNAL_WRITE_UNKNOWN_DESCRIPTOR)
      }
    }
  }

  return (name) => descriptors.get(name) ?? EXTERNAL_WRITE_UNKNOWN_DESCRIPTOR
}

/**
 * A stable relay lets an AiSdkAgent keep one wrapped tool set while changing
 * the run-owned ledger. captureTarget() binds both events of an in-flight call
 * to the same owner even if the current target changes before settlement.
 */
export class MutableToolEvidenceSinkRelay implements ToolEvidenceSink {
  private target: ToolEvidenceSink | undefined

  setTarget(target: ToolEvidenceSink | undefined): void {
    this.target = target
  }

  captureTarget(): ToolEvidenceSink | undefined {
    return this.target
  }

  record(event: EvidenceEvent): void {
    this.target?.record(event)
  }
}

const MAX_DIGEST_STRING_LENGTH = 4_096
const UNAVAILABLE_DIGEST = '0'.repeat(64)

function updateDigestToken(
  hash: ReturnType<typeof createHash>,
  kind: string,
  value = '',
): void {
  hash.update(String(kind.length))
  hash.update(':')
  hash.update(kind)
  hash.update(String(value.length))
  hash.update(':')
  hash.update(value)
}

interface EvidenceDigest {
  readonly value: string
  readonly fidelity: DigestFidelity
}

function canonicalDigest(value: unknown): EvidenceDigest {
  try {
    const hash = createHash('sha256')
    let fidelity: DigestFidelity = 'exact'
    switch (typeof value) {
      case 'undefined':
        updateDigestToken(hash, 'undefined')
        break
      case 'boolean':
        updateDigestToken(hash, 'boolean', value ? '1' : '0')
        break
      case 'number':
        updateDigestToken(
          hash,
          'number',
          Number.isNaN(value)
            ? 'NaN'
            : Object.is(value, -0)
              ? '-0'
              : String(value),
        )
        break
      case 'string':
        if (value.length > MAX_DIGEST_STRING_LENGTH) {
          fidelity = 'coarse'
          updateDigestToken(hash, 'string-opaque', String(value.length))
        } else {
          updateDigestToken(hash, 'string', value)
        }
        break
      case 'bigint':
        fidelity = 'coarse'
        updateDigestToken(
          hash,
          value === 0n
            ? 'bigint-zero'
            : value < 0n
              ? 'bigint-negative'
              : 'bigint-positive',
        )
        break
      case 'symbol':
        fidelity = 'coarse'
        updateDigestToken(hash, 'symbol-opaque')
        break
      case 'function':
        fidelity = 'coarse'
        updateDigestToken(hash, 'function-opaque')
        break
      case 'object':
        if (value === null) {
          updateDigestToken(hash, 'null')
          break
        }
        fidelity = 'coarse'
        if (safeArrayCheck(value) === true) {
          const length = readOwnDataProperty(value, 'length')
          if (
            length.state === 'data' &&
            Number.isSafeInteger(length.value) &&
            (length.value as number) >= 0
          ) {
            updateDigestToken(hash, 'array-opaque', String(length.value))
          } else {
            fidelity = 'unavailable'
            updateDigestToken(hash, 'array-unavailable')
          }
        } else {
          updateDigestToken(hash, 'object-opaque')
        }
        break
    }
    return Object.freeze({ value: hash.digest('hex'), fidelity })
  } catch {
    return Object.freeze({
      value: UNAVAILABLE_DIGEST,
      fidelity: 'unavailable',
    })
  }
}

/**
 * Reliability decisions may only consume exact digests. Coarse and
 * unavailable observations are telemetry and cannot identify effects,
 * idempotency, or terminal completion.
 */
export function digestForReliabilityDecision(
  digest: string,
  fidelity: DigestFidelity,
): string | undefined {
  return fidelity === 'exact' ? digest : undefined
}

function safeDescriptor(
  name: string,
  describeTool: (name: string) => ToolReliabilityDescriptor,
): ToolReliabilityDescriptor {
  let candidate: unknown
  try {
    candidate = describeTool(name)
  } catch {
    return EXTERNAL_WRITE_UNKNOWN_DESCRIPTOR
  }
  if (!isNonArrayObject(candidate)) {
    return EXTERNAL_WRITE_UNKNOWN_DESCRIPTOR
  }

  const effectsProperty = readOwnDataProperty(candidate, 'effects')
  const retrySafetyProperty = readOwnDataProperty(candidate, 'retrySafety')
  const effects =
    effectsProperty.state === 'data'
      ? snapshotEffects(effectsProperty.value)
      : { valid: false, values: Object.freeze([]) }
  const retrySafety =
    retrySafetyProperty.state === 'data' ? retrySafetyProperty.value : undefined
  if (
    !effects.valid ||
    (retrySafety !== 'safe' &&
      retrySafety !== 'unsafe' &&
      retrySafety !== 'unknown')
  ) {
    return EXTERNAL_WRITE_UNKNOWN_DESCRIPTOR
  }
  return Object.freeze({
    effects: effects.values,
    retrySafety,
  })
}

function capturedSink(
  sink: ToolEvidenceSink | undefined,
): ToolEvidenceSink | undefined {
  try {
    return sink instanceof MutableToolEvidenceSinkRelay
      ? sink.captureTarget()
      : sink
  } catch {
    return undefined
  }
}

function safelyRecord(
  sink: ToolEvidenceSink | undefined,
  event: EvidenceEvent,
): void {
  try {
    sink?.record(event)
  } catch {
    // Evidence is observe-only. A telemetry failure must not affect the tool.
  }
}

function createEvidenceEvent(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly kind: 'requested' | 'settled'
  readonly descriptor: ToolReliabilityDescriptor
  readonly argumentDigest: EvidenceDigest
  readonly result?: NormalizedToolResult
  readonly outputDigest?: EvidenceDigest
}): EvidenceEvent {
  return snapshotEvidenceEvent(
    {
      eventId: randomUUID(),
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      kind: input.kind,
      effects: input.descriptor.effects,
      retrySafety: input.descriptor.retrySafety,
      result: input.result,
      argumentDigest: input.argumentDigest.value,
      argumentDigestFidelity: input.argumentDigest.fidelity,
      outputDigest: input.outputDigest?.value,
      outputDigestFidelity: input.outputDigest?.fidelity,
      recordedAt: Date.now(),
    },
    false,
  )
}

function createObservedExecute(
  toolName: string,
  sourceExecute: RuntimeToolExecute,
  options: {
    readonly evidenceSink: ToolEvidenceSink
    readonly describeTool: (name: string) => ToolReliabilityDescriptor
  },
): RuntimeToolExecute {
  return function (this: unknown, ...args: unknown[]): unknown {
    const input = args[0]
    const executionOptions = args[1] as ToolExecutionOptions
    const sink = capturedSink(options.evidenceSink)
    if (sink === undefined) {
      return sourceExecute.apply(this, args)
    }
    let descriptor: ToolReliabilityDescriptor
    let argumentDigest: EvidenceDigest
    let toolCallId: string
    let abortSignal: AbortSignal | undefined
    let preAborted: boolean
    try {
      descriptor = safeDescriptor(toolName, options.describeTool)
      argumentDigest = canonicalDigest(input)
      toolCallId = executionOptions.toolCallId
      abortSignal = executionOptions.abortSignal
      preAborted = abortSignal?.aborted === true
      safelyRecord(
        sink,
        createEvidenceEvent({
          toolCallId,
          toolName,
          kind: 'requested',
          descriptor,
          argumentDigest,
        }),
      )
    } catch {
      return sourceExecute.apply(this, args)
    }
    let started = false
    let settled = false

    const settle = (
      outcome: ToolResultObservation['outcome'],
      output?: unknown,
    ): void => {
      if (settled) {
        return
      }
      settled = true
      try {
        const effectiveOutcome =
          preAborted || abortSignal?.aborted === true ? 'aborted' : outcome
        const normalized = normalizeToolResult({
          outcome: effectiveOutcome,
          started,
          effects: descriptor.effects,
          output,
        })
        safelyRecord(
          sink,
          createEvidenceEvent({
            toolCallId,
            toolName,
            kind: 'settled',
            descriptor,
            argumentDigest,
            result: normalized,
            outputDigest:
              outcome === 'rejected' ? undefined : canonicalDigest(output),
          }),
        )
      } catch {
        // Evidence settlement is observe-only and cannot replace tool behavior.
      }
    }

    let output: unknown
    try {
      started = true
      output = sourceExecute.apply(this, args)
    } catch (error) {
      settle('rejected', error)
      throw error
    }

    return observeToolReturn(output, {
      onResolved: (resolved) => settle('resolved', resolved),
      onRejected: (error) => settle('rejected', error),
      onCancelled: (lastOutput) => settle('aborted', lastOutput),
    })
  }
}

export function wrapToolSetWithEvidence(
  tools: ToolSet,
  options: {
    readonly evidenceSink?: ToolEvidenceSink
    readonly describeTool: (name: string) => ToolReliabilityDescriptor
  },
): ToolSet {
  if (options.evidenceSink === undefined) {
    return tools
  }

  const wrapped = createToolSetDictionary()
  for (const [name, sourceTool] of Object.entries(tools)) {
    defineToolSetEntry(
      wrapped,
      name,
      wrapToolExecuteProperty(sourceTool, (sourceExecute) =>
        createObservedExecute(
          name,
          sourceExecute,
          options as {
            readonly evidenceSink: ToolEvidenceSink
            readonly describeTool: (name: string) => ToolReliabilityDescriptor
          },
        ),
      ),
    )
  }
  return wrapped
}
