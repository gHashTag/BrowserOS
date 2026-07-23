import { describe, expect, it } from 'bun:test'
import {
  createExecutionRun,
  startExecutionRun,
} from '../../src/agent/execution-run'
import type {
  EvidenceEvent,
  NormalizedToolResult,
  ToolEffect,
} from '../../src/agent/execution-types'
import { type AgentSession, SessionStore } from '../../src/agent/session-store'

type MutableNormalizedToolResult = {
  -readonly [Key in keyof NormalizedToolResult]: NormalizedToolResult[Key]
}

function createRunningRun(runId: string, conversationId = 'conversation-1') {
  return startExecutionRun(
    createExecutionRun({
      runId,
      conversationId,
      userMessageId: `message-${runId}`,
      now: 100,
    }),
  )
}

function createSession(): AgentSession {
  return {
    agent: {
      dispose: async () => undefined,
    } as unknown as AgentSession['agent'],
  }
}

describe('SessionStore turn leases', () => {
  it('acquires the first turn and refuses a second turn with the original run', () => {
    const store = new SessionStore()
    const first = createRunningRun('run-1')
    const second = createRunningRun('run-2')

    expect(store.tryAcquireTurn(first)).toEqual({
      acquired: true,
      run: first,
    })
    expect(store.tryAcquireTurn(second)).toEqual({
      acquired: false,
      activeRun: first,
    })
    expect(store.getActiveRun('conversation-1')).toBe(first)
  })

  it('acquires turns for different conversations independently', () => {
    const store = new SessionStore()
    const first = createRunningRun('run-1', 'conversation-1')
    const second = createRunningRun('run-2', 'conversation-2')

    expect(store.tryAcquireTurn(first)).toEqual({
      acquired: true,
      run: first,
    })
    expect(store.tryAcquireTurn(second)).toEqual({
      acquired: true,
      run: second,
    })
    expect(store.getActiveRun('conversation-1')).toBe(first)
    expect(store.getActiveRun('conversation-2')).toBe(second)
  })

  it('suspends only the owning run and stores sorted approval IDs', () => {
    const store = new SessionStore()
    const running = createRunningRun('run-1')
    store.tryAcquireTurn(running)

    expect(
      store.suspendTurnForApproval('conversation-1', 'stale-run', [
        'approval-a',
      ]),
    ).toBeUndefined()
    expect(store.getActiveRun('conversation-1')).toBe(running)

    const waiting = store.suspendTurnForApproval('conversation-1', 'run-1', [
      'approval-b',
      'approval-a',
      'approval-b',
    ])

    expect(waiting?.waitingFor).toEqual({
      kind: 'approval',
      approvalIds: ['approval-a', 'approval-b'],
    })
    expect(store.getActiveRun('conversation-1')).toBe(waiting)
  })

  it('blocks an ordinary second turn while approval is pending', () => {
    const store = new SessionStore()
    const running = createRunningRun('run-1')
    store.tryAcquireTurn(running)
    const waiting = store.suspendTurnForApproval('conversation-1', 'run-1', [
      'approval-a',
    ])
    const second = createRunningRun('run-2')

    expect(store.tryAcquireTurn(second)).toEqual({
      acquired: false,
      activeRun: waiting,
    })
  })

  it('resumes matching approval IDs on the same run', () => {
    const store = new SessionStore()
    const running = createRunningRun('run-1')
    store.tryAcquireTurn(running)
    const waiting = store.suspendTurnForApproval('conversation-1', 'run-1', [
      'approval-b',
      'approval-a',
    ])

    const result = store.tryResumeApprovalTurn('conversation-1', [
      'approval-b',
      'approval-a',
    ])

    expect(result.resumed).toBe(true)
    if (!result.resumed) {
      throw new Error('Expected the approval turn to resume')
    }
    expect(result.run.runId).toBe('run-1')
    expect(result.run.waitingFor).toBeUndefined()
    expect(result.run).not.toBe(waiting)
    expect(store.getActiveRun('conversation-1')).toBe(result.run)
  })

  it('does not resume or mutate on unknown, partial, mixed, or replayed IDs', () => {
    const store = new SessionStore()
    const running = createRunningRun('run-1')
    store.tryAcquireTurn(running)
    const waiting = store.suspendTurnForApproval('conversation-1', 'run-1', [
      'approval-a',
      'approval-b',
    ])

    for (const approvalIds of [
      ['approval-unknown'],
      ['approval-a'],
      ['approval-a', 'approval-unknown'],
    ]) {
      expect(
        store.tryResumeApprovalTurn('conversation-1', approvalIds),
      ).toEqual({
        resumed: false,
        reason: 'approval-mismatch',
        activeRun: waiting,
      })
      expect(store.getActiveRun('conversation-1')).toBe(waiting)
      expect(waiting?.waitingFor?.approvalIds).toEqual([
        'approval-a',
        'approval-b',
      ])
    }

    const resumed = store.tryResumeApprovalTurn('conversation-1', [
      'approval-a',
      'approval-b',
    ])
    expect(resumed.resumed).toBe(true)
    if (!resumed.resumed) {
      throw new Error('Expected the approval turn to resume')
    }

    expect(
      store.tryResumeApprovalTurn('conversation-1', [
        'approval-a',
        'approval-b',
      ]),
    ).toEqual({
      resumed: false,
      reason: 'not-waiting',
      activeRun: resumed.run,
    })
    expect(store.getActiveRun('conversation-1')).toBe(resumed.run)
  })

  it('reports when no active run exists for approval resumption', () => {
    const store = new SessionStore()

    expect(
      store.tryResumeApprovalTurn('conversation-1', ['approval-a']),
    ).toEqual({
      resumed: false,
      reason: 'no-active-run',
    })
  })

  it('releases only the owner and ignores stale or duplicate finishes', () => {
    const store = new SessionStore()
    const first = createRunningRun('run-1')
    store.tryAcquireTurn(first)

    expect(
      store.finishTurn('conversation-1', 'stale-run', {
        status: 'failed',
        failureReason: 'execution-error',
      }),
    ).toBe(false)
    expect(store.getActiveRun('conversation-1')).toBe(first)
    expect(
      store.finishTurn('conversation-1', 'run-1', {
        status: 'succeeded',
      }),
    ).toBe(true)
    expect(store.getActiveRun('conversation-1')).toBeUndefined()

    const second = createRunningRun('run-2')
    expect(store.tryAcquireTurn(second).acquired).toBe(true)
    expect(
      store.finishTurn('conversation-1', 'run-1', {
        status: 'succeeded',
      }),
    ).toBe(false)
    expect(store.getActiveRun('conversation-1')).toBe(second)
    expect(
      store.finishTurn('conversation-1', 'run-2', {
        status: 'failed',
        failureReason: 'aborted',
        effectState: 'partial',
      }),
    ).toBe(true)
    expect(
      store.finishTurn('conversation-1', 'run-2', {
        status: 'failed',
        failureReason: 'aborted',
      }),
    ).toBe(false)
  })

  it('keeps an active lease while its agent session is replaced or removed', async () => {
    const store = new SessionStore()
    const running = createRunningRun('run-1')

    store.set('conversation-1', createSession())
    store.tryAcquireTurn(running)
    store.set('conversation-1', createSession())
    expect(store.getActiveRun('conversation-1')).toBe(running)

    expect(store.remove('conversation-1')).toBe(true)
    expect(store.getActiveRun('conversation-1')).toBe(running)

    store.set('conversation-1', createSession())
    expect(store.getActiveRun('conversation-1')).toBe(running)
    expect(await store.delete('conversation-1')).toBe(true)
    expect(store.getActiveRun('conversation-1')).toBe(running)
  })

  it('records deeply frozen evidence without mutating prior or caller input', () => {
    const store = new SessionStore()
    const running = createRunningRun('run-1')
    const effects: ToolEffect[] = ['filesystem-write']
    const result: MutableNormalizedToolResult = {
      transportStatus: 'received',
      executionStatus: 'success',
      effectStatus: 'applied',
      verificationStatus: 'not-run',
    }
    const event = {
      eventId: 'event-1',
      toolCallId: 'call-1',
      toolName: 'write-file',
      kind: 'settled',
      effects,
      retrySafety: 'unsafe',
      result,
      argumentDigest: 'argument-digest',
      outputDigest: 'output-digest',
      recordedAt: 150,
    } satisfies EvidenceEvent
    store.tryAcquireTurn(running)

    expect(store.recordEvidence('conversation-1', 'run-1', event)).toBe(true)

    const updated = store.getActiveRun('conversation-1')
    if (!updated) {
      throw new Error('Expected evidence to be recorded')
    }
    const storedEvent = updated.evidence[0]
    expect(updated).not.toBe(running)
    expect(updated.evidence).not.toBe(running.evidence)
    expect(running.evidence).toEqual([])
    expect(storedEvent).not.toBe(event)
    expect(storedEvent.effects).not.toBe(effects)
    expect(storedEvent.result).not.toBe(result)
    expect(Object.isFrozen(updated)).toBe(true)
    expect(Object.isFrozen(updated.evidence)).toBe(true)
    expect(Object.isFrozen(storedEvent)).toBe(true)
    expect(Object.isFrozen(storedEvent.effects)).toBe(true)
    expect(Object.isFrozen(storedEvent.result)).toBe(true)
    expect(Object.isFrozen(event)).toBe(false)
    expect(Object.isFrozen(effects)).toBe(false)
    expect(Object.isFrozen(result)).toBe(false)
    expect(event.toolName).toBe('write-file')
    expect(effects).toEqual(['filesystem-write'])
    expect(result.executionStatus).toBe('success')

    event.toolName = 'mutated-tool'
    effects.push('command')
    result.executionStatus = 'error'

    expect(storedEvent.toolName).toBe('write-file')
    expect(storedEvent.effects).toEqual(['filesystem-write'])
    expect(storedEvent.result?.executionStatus).toBe('success')
    expect(store.recordEvidence('conversation-1', 'stale-run', event)).toBe(
      false,
    )
    expect(store.getActiveRun('conversation-1')).toBe(updated)
  })
})
