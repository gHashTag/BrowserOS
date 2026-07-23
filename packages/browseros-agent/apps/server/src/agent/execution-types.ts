/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ExecutionIntent = 'unknown' | 'conversational' | 'action'

export type ExecutionRunPhase =
  | 'planned'
  | 'running'
  | 'verifying'
  | 'succeeded'
  | 'failed'

export type ExecutionRunFailureReason =
  | 'denied'
  | 'aborted'
  | 'no-evidence'
  | 'execution-error'

export type ExecutionEffectState = 'none' | 'partial' | 'complete' | 'unknown'

export type ToolEffect =
  | 'observe'
  | 'filesystem-read'
  | 'filesystem-write'
  | 'command'
  | 'browser-write'
  | 'external-write'
  | 'verify'

export interface NormalizedToolResult {
  readonly transportStatus: 'received' | 'failed'
  readonly executionStatus: 'success' | 'error' | 'denied' | 'aborted'
  readonly effectStatus: 'none' | 'applied' | 'partial' | 'unknown'
  readonly verificationStatus: 'not-run' | 'passed' | 'failed' | 'not-required'
}

export interface EvidenceEvent {
  readonly eventId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly kind: 'requested' | 'settled' | 'verification'
  readonly effects: readonly ToolEffect[]
  readonly retrySafety: 'safe' | 'unsafe' | 'unknown'
  readonly result?: NormalizedToolResult
  readonly argumentDigest: string
  readonly outputDigest?: string
  readonly recordedAt: number
}

export interface ExecutionRun {
  readonly runId: string
  readonly conversationId: string
  readonly userMessageId: string
  readonly intent: ExecutionIntent
  readonly expectedEffects: readonly ToolEffect[]
  readonly phase: ExecutionRunPhase
  readonly waitingFor?: {
    readonly kind: 'approval'
    readonly approvalIds: readonly string[]
  }
  readonly attempt: 0 | 1
  readonly evidence: readonly EvidenceEvent[]
  readonly failureReason?: ExecutionRunFailureReason
  readonly effectState: ExecutionEffectState
  readonly startedAt: number
  readonly finishedAt?: number
}
