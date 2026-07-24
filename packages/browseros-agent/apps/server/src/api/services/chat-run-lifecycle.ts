/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FinishReason, UIMessage } from 'ai'
import { ConversationBusyError } from '../../agent/errors'
import {
  collectPendingApprovalIds,
  createExecutionRun,
  startExecutionRun,
} from '../../agent/execution-run'
import type { ExecutionRunFailureReason } from '../../agent/execution-types'
import { filterValidMessages } from '../../agent/message-validation'
import type { AgentSession, SessionStore } from '../../agent/session-store'
import { metrics } from '../../lib/metrics'
import type { ChatRequest } from '../types'

export interface OwnedChatRun {
  readonly runId: string
  readonly userMessageId: string
  readonly isApprovalContinuation: boolean
  readonly deniedByApproval: boolean
}

function busy(
  sessionStore: SessionStore,
  conversationId: string,
  activeRunId?: string,
): never {
  throw new ConversationBusyError(
    conversationId,
    activeRunId ?? sessionStore.getActiveRun(conversationId)?.runId,
  )
}

export function acquireOwnedChatRun(
  sessionStore: SessionStore,
  request: ChatRequest,
): OwnedChatRun {
  const responses = request.toolApprovalResponses
  if (responses?.length) {
    const approvalIds = responses.map((response) => response.approvalId)
    if (new Set(approvalIds).size !== approvalIds.length) {
      return busy(sessionStore, request.conversationId)
    }
    const resumed = sessionStore.tryResumeApprovalTurn(
      request.conversationId,
      approvalIds,
    )
    if (!resumed.resumed) {
      return busy(
        sessionStore,
        request.conversationId,
        resumed.activeRun?.runId,
      )
    }
    return {
      runId: resumed.run.runId,
      userMessageId: resumed.run.userMessageId,
      isApprovalContinuation: true,
      deniedByApproval: responses.some((response) => !response.approved),
    }
  }

  const userMessageId = crypto.randomUUID()
  const run = startExecutionRun(
    createExecutionRun({
      conversationId: request.conversationId,
      userMessageId,
    }),
  )
  const acquired = sessionStore.tryAcquireTurn(run)
  if (!acquired.acquired) {
    return busy(
      sessionStore,
      request.conversationId,
      'activeRun' in acquired ? acquired.activeRun?.runId : undefined,
    )
  }
  return {
    runId: acquired.run.runId,
    userMessageId,
    isApprovalContinuation: false,
    deniedByApproval: false,
  }
}

export function ownsChatRun(
  sessionStore: SessionStore,
  conversationId: string,
  runId: string,
): boolean {
  return sessionStore.getActiveRun(conversationId)?.runId === runId
}

function logRunMetricSafely(
  conversationId: string,
  runId: string,
  status: 'succeeded' | 'failed',
  evidenceCount: number,
  failureReason?: ExecutionRunFailureReason,
): void {
  try {
    metrics.log('chat.execution_run', {
      conversation_id: conversationId,
      run_id: runId,
      status,
      evidence_count: evidenceCount,
      ...(failureReason ? { failure_reason: failureReason } : {}),
    })
  } catch {
    // Observability must not affect run ownership or cleanup.
  }
}

function runCleanupSafely(cleanup: () => void): void {
  try {
    cleanup()
  } catch {
    // Cleanup hooks are independent so one cannot suppress the others.
  }
}

export function failOwnedChatRun(options: {
  sessionStore: SessionStore
  conversationId: string
  runId: string
  failureReason: 'aborted' | 'execution-error'
  clearEvidenceSink: () => void
  closeHiddenPage: () => void
}): boolean {
  const activeRun = options.sessionStore.getActiveRun(options.conversationId)
  if (!activeRun || activeRun.runId !== options.runId) {
    return false
  }
  const finished = options.sessionStore.finishTurn(
    options.conversationId,
    options.runId,
    {
      status: 'failed',
      failureReason: options.failureReason,
    },
  )
  if (!finished) {
    return false
  }
  runCleanupSafely(options.clearEvidenceSink)
  runCleanupSafely(options.closeHiddenPage)
  logRunMetricSafely(
    options.conversationId,
    options.runId,
    'failed',
    activeRun.evidence.length,
    options.failureReason,
  )
  return true
}

export function finishOwnedChatRun(options: {
  sessionStore: SessionStore
  session: AgentSession
  conversationId: string
  runId: string
  messages: UIMessage[]
  isAborted: boolean
  finishReason?: FinishReason
  deniedByApproval: boolean
  clearEvidenceSink: () => void
  closeHiddenPage: () => void
}): 'stale' | 'suspended' | 'terminal' {
  const activeRun = options.sessionStore.getActiveRun(options.conversationId)
  if (!activeRun || activeRun.runId !== options.runId) {
    return 'stale'
  }
  if (activeRun.waitingFor?.kind === 'approval') {
    try {
      const duplicateApprovalIds = collectPendingApprovalIds(
        filterValidMessages(options.messages),
      )
      const expectedApprovalIds = activeRun.waitingFor.approvalIds
      const isExactDuplicate =
        duplicateApprovalIds.length === expectedApprovalIds.length &&
        duplicateApprovalIds.every(
          (approvalId, index) => approvalId === expectedApprovalIds[index],
        )
      return isExactDuplicate ? 'suspended' : 'stale'
    } catch {
      return 'stale'
    }
  }

  let failureReason: ExecutionRunFailureReason | undefined = options.isAborted
    ? 'aborted'
    : options.finishReason === 'error'
      ? 'execution-error'
      : options.deniedByApproval
        ? 'denied'
        : undefined
  try {
    const persisted = filterValidMessages(options.messages)
    const pendingApprovalIds =
      failureReason === undefined ? collectPendingApprovalIds(persisted) : []
    options.session.agent.messages = persisted
    if (pendingApprovalIds.length > 0) {
      const suspended = options.sessionStore.suspendTurnForApproval(
        options.conversationId,
        options.runId,
        pendingApprovalIds,
      )
      return suspended ? 'suspended' : 'stale'
    }
  } catch {
    failureReason = 'execution-error'
  }

  const outcome = failureReason
    ? failureReason === 'denied'
      ? ({
          status: 'failed',
          failureReason,
          effectState: 'none',
        } as const)
      : ({ status: 'failed', failureReason } as const)
    : ({ status: 'succeeded' } as const)
  const finished = options.sessionStore.finishTurn(
    options.conversationId,
    options.runId,
    outcome,
  )
  if (!finished) {
    return 'stale'
  }
  runCleanupSafely(options.clearEvidenceSink)
  runCleanupSafely(options.closeHiddenPage)
  logRunMetricSafely(
    options.conversationId,
    options.runId,
    outcome.status,
    activeRun.evidence.length,
    failureReason,
  )
  return 'terminal'
}

export function applyToolApprovalResponses(
  messages: UIMessage[],
  responses: NonNullable<ChatRequest['toolApprovalResponses']>,
): void {
  type ApprovalPart = {
    state?: string
    approval: { id: string; approved?: boolean; reason?: string }
  }
  const responseMap = new Map(
    responses.map((response) => [response.approvalId, response]),
  )
  const partsById = new Map<string, ApprovalPart[]>()

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      const toolPart = part as {
        state?: string
        approval?: { id: string; approved?: boolean; reason?: string }
      }
      if (
        toolPart.state !== 'approval-requested' ||
        !toolPart.approval?.id ||
        !responseMap.has(toolPart.approval.id)
      ) {
        continue
      }
      const matching = partsById.get(toolPart.approval.id) ?? []
      matching.push(toolPart as ApprovalPart)
      partsById.set(toolPart.approval.id, matching)
    }
  }

  if (responses.some((response) => !partsById.has(response.approvalId))) {
    throw new Error('Approval response does not match a pending message')
  }
  for (const response of responses) {
    for (const part of partsById.get(response.approvalId) ?? []) {
      part.state = 'approval-responded'
      part.approval = {
        ...part.approval,
        approved: response.approved,
        reason: response.reason,
      }
    }
  }
}
