import type { BrowserContext } from '@browseros/shared/schemas/browser-context'
import { logger } from '../lib/logger'
import type { AiSdkAgent } from './ai-sdk-agent'
import {
  completeExecutionRun,
  markRunWaitingForApproval,
  resumeExecutionRun,
} from './execution-run'
import type {
  EvidenceEvent,
  ExecutionEffectState,
  ExecutionRun,
  ExecutionRunFailureReason,
} from './execution-types'

export type AcquireTurnResult =
  | { acquired: true; run: ExecutionRun }
  | { acquired: false; activeRun: ExecutionRun }
  | {
      acquired: false
      reason: 'deletion-pending'
      activeRun?: ExecutionRun
    }

function freezeEvidenceEvent(event: EvidenceEvent): EvidenceEvent {
  return Object.freeze({
    ...event,
    effects: Object.freeze([...event.effects]),
    result: event.result ? Object.freeze({ ...event.result }) : undefined,
  })
}

function freezeExecutionRunSnapshot(run: ExecutionRun): ExecutionRun {
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

function appendFrozenEvidence(
  run: ExecutionRun,
  event: EvidenceEvent,
): ExecutionRun {
  return Object.freeze({
    ...run,
    evidence: Object.freeze([...run.evidence, freezeEvidenceEvent(event)]),
  })
}

function isApprovalMismatchError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Approval IDs do not match'
}

export interface AgentSession {
  agent: AiSdkAgent
  hiddenPageId?: number
  /** Browser context scoped to the scheduled hidden page. */
  browserContext?: BrowserContext
  /** MCP server names used when the session was created, for change detection. */
  mcpServerKey?: string
  /** Workspace directory when the session was created, for change detection. */
  workingDir?: string
  /** Tool approval category key for change detection. */
  approvalConfigKey?: string
}

export class SessionStore {
  private sessions = new Map<string, AgentSession>()
  private activeRuns = new Map<string, ExecutionRun>()
  private deletingConversations = new Set<string>()

  get(conversationId: string): AgentSession | undefined {
    return this.sessions.get(conversationId)
  }

  set(conversationId: string, session: AgentSession): void {
    this.sessions.set(conversationId, session)
    logger.info('Session added to store', {
      conversationId,
      totalSessions: this.sessions.size,
    })
  }

  has(conversationId: string): boolean {
    return this.sessions.has(conversationId)
  }

  tryAcquireTurn(run: ExecutionRun): AcquireTurnResult {
    const activeRun = this.activeRuns.get(run.conversationId)
    if (this.deletingConversations.has(run.conversationId)) {
      return activeRun
        ? { acquired: false, reason: 'deletion-pending', activeRun }
        : { acquired: false, reason: 'deletion-pending' }
    }
    if (activeRun) {
      return { acquired: false, activeRun }
    }

    const runSnapshot = freezeExecutionRunSnapshot(run)
    this.activeRuns.set(run.conversationId, runSnapshot)
    return { acquired: true, run: runSnapshot }
  }

  getActiveRun(conversationId: string): ExecutionRun | undefined {
    return this.activeRuns.get(conversationId)
  }

  suspendTurnForApproval(
    conversationId: string,
    runId: string,
    approvalIds: readonly string[],
  ): ExecutionRun | undefined {
    const activeRun = this.activeRuns.get(conversationId)
    if (!activeRun || activeRun.runId !== runId) {
      return undefined
    }

    const waitingRun = markRunWaitingForApproval(activeRun, approvalIds)
    this.activeRuns.set(conversationId, waitingRun)
    return waitingRun
  }

  tryResumeApprovalTurn(
    conversationId: string,
    approvalIds: readonly string[],
  ):
    | { resumed: true; run: ExecutionRun }
    | {
        resumed: false
        reason:
          | 'no-active-run'
          | 'not-waiting'
          | 'approval-mismatch'
          | 'deletion-pending'
        activeRun?: ExecutionRun
      } {
    const activeRun = this.activeRuns.get(conversationId)
    if (this.deletingConversations.has(conversationId)) {
      return activeRun
        ? { resumed: false, reason: 'deletion-pending', activeRun }
        : { resumed: false, reason: 'deletion-pending' }
    }
    if (!activeRun) {
      return { resumed: false, reason: 'no-active-run' }
    }
    if (
      activeRun.phase !== 'running' ||
      activeRun.waitingFor?.kind !== 'approval'
    ) {
      return { resumed: false, reason: 'not-waiting', activeRun }
    }

    let resumedRun: ExecutionRun
    try {
      resumedRun = resumeExecutionRun(activeRun, approvalIds)
    } catch (error) {
      if (!isApprovalMismatchError(error)) {
        throw error
      }
      return { resumed: false, reason: 'approval-mismatch', activeRun }
    }

    this.activeRuns.set(conversationId, resumedRun)
    return { resumed: true, run: resumedRun }
  }

  finishTurn(
    conversationId: string,
    runId: string,
    outcome:
      | { status: 'succeeded' }
      | {
          status: 'failed'
          failureReason: ExecutionRunFailureReason
          effectState?: ExecutionEffectState
        },
  ): boolean {
    const activeRun = this.activeRuns.get(conversationId)
    if (!activeRun || activeRun.runId !== runId) {
      return false
    }

    if (activeRun.phase !== 'planned') {
      completeExecutionRun(activeRun, outcome)
    }
    this.activeRuns.delete(conversationId)
    return true
  }

  recordEvidence(
    conversationId: string,
    runId: string,
    event: EvidenceEvent,
  ): boolean {
    const activeRun = this.activeRuns.get(conversationId)
    if (!activeRun || activeRun.runId !== runId) {
      return false
    }

    const updatedRun = appendFrozenEvidence(activeRun, event)
    this.activeRuns.set(conversationId, updatedRun)
    return true
  }

  remove(conversationId: string): boolean {
    const existed = this.sessions.delete(conversationId)
    if (existed) {
      logger.info('Session removed from store (without dispose)', {
        conversationId,
        remainingSessions: this.sessions.size,
      })
    }
    return existed
  }

  async delete(conversationId: string): Promise<boolean> {
    if (this.deletingConversations.has(conversationId)) {
      return false
    }

    const capturedSession = this.sessions.get(conversationId)
    const capturedRun = this.activeRuns.get(conversationId)
    const capturedRunId = capturedRun?.runId
    const runWasApprovalSuspended = capturedRun?.waitingFor?.kind === 'approval'

    if (capturedRun && !runWasApprovalSuspended) {
      return false
    }

    if (!capturedSession) {
      if (
        runWasApprovalSuspended &&
        capturedRunId !== undefined &&
        this.activeRuns.get(conversationId)?.runId === capturedRunId
      ) {
        this.activeRuns.delete(conversationId)
      }
      return false
    }

    this.deletingConversations.add(conversationId)
    try {
      await capturedSession.agent.dispose()

      const currentRun = this.activeRuns.get(conversationId)
      const capturedRunIsUnchanged =
        capturedRun === undefined
          ? currentRun === undefined
          : currentRun === capturedRun &&
            currentRun.waitingFor?.kind === 'approval'
      const removedSession =
        capturedRunIsUnchanged &&
        this.sessions.get(conversationId) === capturedSession

      if (removedSession) {
        this.sessions.delete(conversationId)
      }
      if (
        capturedRunIsUnchanged &&
        runWasApprovalSuspended &&
        capturedRunId !== undefined
      ) {
        this.activeRuns.delete(conversationId)
      }
      if (removedSession) {
        logger.info('Session deleted', {
          conversationId,
          remainingSessions: this.sessions.size,
        })
      }
      return removedSession
    } finally {
      this.deletingConversations.delete(conversationId)
    }
  }

  count(): number {
    return this.sessions.size
  }
}
