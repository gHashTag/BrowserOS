/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { UIMessage } from 'ai'
import type {
  EvidenceEvent,
  ExecutionEffectState,
  ExecutionRun,
  ExecutionRunFailureReason,
} from './execution-types'

type CompleteExecutionRunOutcome =
  | {
      readonly status: 'succeeded'
      readonly now?: number
    }
  | {
      readonly status: 'failed'
      readonly failureReason: ExecutionRunFailureReason
      readonly effectState?: ExecutionEffectState
      readonly now?: number
    }

function isTerminal(run: ExecutionRun): boolean {
  return run.phase === 'succeeded' || run.phase === 'failed'
}

function normalizeApprovalIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))].sort()
}

function freezeEvidenceEvent(event: EvidenceEvent): EvidenceEvent {
  return Object.freeze({
    ...event,
    effects: Object.freeze([...event.effects]),
    result: event.result ? Object.freeze({ ...event.result }) : undefined,
  })
}

function freezeExecutionRun(run: ExecutionRun): ExecutionRun {
  const waitingFor = run.waitingFor
    ? Object.freeze({
        kind: 'approval' as const,
        approvalIds: Object.freeze([...run.waitingFor.approvalIds]),
      })
    : undefined

  return Object.freeze({
    ...run,
    expectedEffects: Object.freeze([...run.expectedEffects]),
    waitingFor,
    evidence: Object.freeze(run.evidence.map(freezeEvidenceEvent)),
  })
}

export function createExecutionRun(input: {
  readonly runId?: string
  readonly conversationId: string
  readonly userMessageId: string
  readonly now?: number
}): ExecutionRun {
  return freezeExecutionRun({
    runId: input.runId === undefined ? crypto.randomUUID() : input.runId,
    conversationId: input.conversationId,
    userMessageId: input.userMessageId,
    intent: 'unknown',
    expectedEffects: [],
    phase: 'planned',
    waitingFor: undefined,
    attempt: 0,
    evidence: [],
    failureReason: undefined,
    effectState: 'none',
    startedAt: input.now ?? Date.now(),
    finishedAt: undefined,
  })
}

export function startExecutionRun(run: ExecutionRun): ExecutionRun {
  if (isTerminal(run)) {
    throw new Error('Cannot start a terminal execution run')
  }
  if (run.phase !== 'planned') {
    throw new Error(`Cannot start execution run in phase ${run.phase}`)
  }

  return freezeExecutionRun({
    ...run,
    phase: 'running',
  })
}

export function markRunWaitingForApproval(
  run: ExecutionRun,
  ids: readonly string[],
): ExecutionRun {
  const approvalIds = normalizeApprovalIds(ids)
  if (approvalIds.length === 0) {
    throw new Error('At least one approval ID is required')
  }
  if (run.phase !== 'running' || run.waitingFor !== undefined) {
    throw new Error('Execution run is not available for approval suspension')
  }

  return freezeExecutionRun({
    ...run,
    phase: 'running',
    waitingFor: {
      kind: 'approval',
      approvalIds,
    },
  })
}

export function resumeExecutionRun(
  run: ExecutionRun,
  ids: readonly string[],
): ExecutionRun {
  if (run.phase !== 'running' || run.waitingFor?.kind !== 'approval') {
    throw new Error('Execution run is not waiting for approval')
  }

  const approvalIds = normalizeApprovalIds(ids)
  const expectedIds = run.waitingFor.approvalIds
  const matches =
    approvalIds.length === expectedIds.length &&
    approvalIds.every((id, index) => id === expectedIds[index])

  if (!matches) {
    throw new Error('Approval IDs do not match')
  }

  return freezeExecutionRun({
    ...run,
    phase: 'running',
    waitingFor: undefined,
  })
}

export function completeExecutionRun(
  run: ExecutionRun,
  outcome: CompleteExecutionRunOutcome,
): ExecutionRun {
  if (isTerminal(run)) {
    throw new Error('Cannot complete a terminal execution run')
  }
  if (run.phase !== 'running' && run.phase !== 'verifying') {
    throw new Error(`Cannot complete execution run in phase ${run.phase}`)
  }
  if (outcome.status === 'succeeded' && run.waitingFor !== undefined) {
    throw new Error('Cannot succeed an execution run waiting for approval')
  }

  return freezeExecutionRun({
    ...run,
    phase: outcome.status,
    waitingFor: undefined,
    failureReason:
      outcome.status === 'failed' ? outcome.failureReason : undefined,
    effectState:
      outcome.status === 'failed' && outcome.effectState !== undefined
        ? outcome.effectState
        : run.effectState,
    finishedAt: outcome.now ?? Date.now(),
  })
}

export function collectPendingApprovalIds(messages: UIMessage[]): string[] {
  const approvalIds: string[] = []

  for (const message of messages) {
    if (message.role !== 'assistant') continue

    for (const part of message.parts) {
      const candidate = part as {
        readonly state?: unknown
        readonly approval?: { readonly id?: unknown }
      }
      if (
        candidate.state === 'approval-requested' &&
        typeof candidate.approval?.id === 'string'
      ) {
        approvalIds.push(candidate.approval.id)
      }
    }
  }

  return normalizeApprovalIds(approvalIds)
}
