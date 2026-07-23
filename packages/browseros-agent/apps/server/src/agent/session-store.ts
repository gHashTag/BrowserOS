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

function freezeEvidenceEvent(event: EvidenceEvent): EvidenceEvent {
  return Object.freeze({
    ...event,
    effects: Object.freeze([...event.effects]),
    result: event.result ? Object.freeze({ ...event.result }) : undefined,
  })
}

function appendFrozenEvidence(
  run: ExecutionRun,
  event: EvidenceEvent,
): ExecutionRun {
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
    evidence: Object.freeze([
      ...run.evidence.map(freezeEvidenceEvent),
      freezeEvidenceEvent(event),
    ]),
  })
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
    if (activeRun) {
      return { acquired: false, activeRun }
    }

    this.activeRuns.set(run.conversationId, run)
    return { acquired: true, run }
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
        reason: 'no-active-run' | 'not-waiting' | 'approval-mismatch'
        activeRun?: ExecutionRun
      } {
    const activeRun = this.activeRuns.get(conversationId)
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
    } catch {
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

    completeExecutionRun(activeRun, outcome)
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
    const session = this.sessions.get(conversationId)
    if (!session) return false

    await session.agent.dispose()
    this.sessions.delete(conversationId)
    logger.info('Session deleted', {
      conversationId,
      remainingSessions: this.sessions.size,
    })
    return true
  }

  count(): number {
    return this.sessions.size
  }
}
