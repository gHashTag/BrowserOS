import { describe, expect, it } from 'bun:test'
import type { UIMessage } from 'ai'
import {
  collectPendingApprovalIds,
  completeExecutionRun,
  createExecutionRun,
  markRunWaitingForApproval,
  resumeExecutionRun,
  startExecutionRun,
} from '../../src/agent/execution-run'

function createPlannedRun() {
  return createExecutionRun({
    runId: 'run-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    now: 100,
  })
}

function message(
  id: string,
  role: UIMessage['role'],
  parts: UIMessage['parts'],
): UIMessage {
  return { id, role, parts }
}

function approvalPart(
  approvalId: string,
  state = 'approval-requested',
): UIMessage['parts'][number] {
  return {
    type: 'dynamic-tool',
    toolCallId: `call-${approvalId}`,
    toolName: 'test-tool',
    state,
    input: {},
    approval: { id: approvalId },
  } as unknown as UIMessage['parts'][number]
}

describe('ExecutionRun', () => {
  it('creates a frozen planned observe-only run with exact defaults', () => {
    const run = createPlannedRun()

    expect(run).toEqual({
      runId: 'run-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      intent: 'unknown',
      expectedEffects: [],
      phase: 'planned',
      waitingFor: undefined,
      attempt: 0,
      evidence: [],
      failureReason: undefined,
      effectState: 'none',
      startedAt: 100,
      finishedAt: undefined,
    })
    expect(Object.isFrozen(run)).toBe(true)
    expect(Object.isFrozen(run.evidence)).toBe(true)
    expect(Object.isFrozen(run.expectedEffects)).toBe(true)
  })

  it('generates a run ID only when one is absent', () => {
    const generated = createExecutionRun({
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      now: 100,
    })
    const supplied = createExecutionRun({
      runId: 'supplied-run-id',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      now: 100,
    })

    expect(generated.runId).toBeString()
    expect(generated.runId.length).toBeGreaterThan(0)
    expect(supplied.runId).toBe('supplied-run-id')
  })

  it('moves through running, approval suspension, resume, and success', () => {
    const planned = createPlannedRun()
    const running = startExecutionRun(planned)
    const waiting = markRunWaitingForApproval(running, [
      'approval-b',
      'approval-a',
    ])
    const resumed = resumeExecutionRun(waiting, ['approval-a', 'approval-b'])
    const succeeded = completeExecutionRun(resumed, {
      status: 'succeeded',
      now: 200,
    })

    expect(running.phase).toBe('running')
    expect(waiting.phase).toBe('running')
    expect(waiting.waitingFor).toEqual({
      kind: 'approval',
      approvalIds: ['approval-a', 'approval-b'],
    })
    expect(Object.isFrozen(waiting)).toBe(true)
    expect(Object.isFrozen(waiting.waitingFor)).toBe(true)
    expect(Object.isFrozen(waiting.waitingFor?.approvalIds)).toBe(true)
    expect(resumed.phase).toBe('running')
    expect(resumed.waitingFor).toBeUndefined()
    expect(succeeded.phase).toBe('succeeded')
    expect(succeeded.failureReason).toBeUndefined()
    expect(succeeded.finishedAt).toBe(200)
    expect(Object.isFrozen(succeeded)).toBe(true)
  })

  it('creates terminal denial and abort failure snapshots', () => {
    const waiting = markRunWaitingForApproval(
      startExecutionRun(createPlannedRun()),
      ['approval-1'],
    )
    const denied = completeExecutionRun(waiting, {
      status: 'failed',
      failureReason: 'denied',
      now: 200,
    })
    const aborted = completeExecutionRun(
      startExecutionRun(createPlannedRun()),
      {
        status: 'failed',
        failureReason: 'aborted',
        effectState: 'partial',
        now: 300,
      },
    )

    expect(denied.phase).toBe('failed')
    expect(denied.failureReason).toBe('denied')
    expect(denied.waitingFor).toBeUndefined()
    expect(denied.effectState).toBe('none')
    expect(denied.finishedAt).toBe(200)
    expect(aborted.phase).toBe('failed')
    expect(aborted.failureReason).toBe('aborted')
    expect(aborted.effectState).toBe('partial')
    expect(aborted.finishedAt).toBe(300)
    expect(Object.isFrozen(denied)).toBe(true)
    expect(Object.isFrozen(aborted)).toBe(true)
  })

  it('sorts and deduplicates nonempty approval IDs', () => {
    const waiting = markRunWaitingForApproval(
      startExecutionRun(createPlannedRun()),
      ['approval-b', '', 'approval-a', 'approval-b'],
    )

    expect(waiting.waitingFor?.approvalIds).toEqual([
      'approval-a',
      'approval-b',
    ])
    expect(() =>
      markRunWaitingForApproval(startExecutionRun(createPlannedRun()), []),
    ).toThrow()
    expect(() =>
      markRunWaitingForApproval(startExecutionRun(createPlannedRun()), [
        '',
        '',
      ]),
    ).toThrow()
  })

  it('rejects mismatches and invalid or terminal transitions', () => {
    const planned = createPlannedRun()
    const running = startExecutionRun(planned)
    const waiting = markRunWaitingForApproval(running, ['approval-1'])
    const succeeded = completeExecutionRun(running, {
      status: 'succeeded',
      now: 200,
    })
    const failed = completeExecutionRun(waiting, {
      status: 'failed',
      failureReason: 'denied',
      now: 200,
    })

    expect(() => resumeExecutionRun(waiting, ['approval-2'])).toThrow(
      'Approval IDs do not match',
    )
    expect(() =>
      completeExecutionRun(waiting, { status: 'succeeded', now: 200 }),
    ).toThrow()
    expect(() => markRunWaitingForApproval(planned, ['approval-1'])).toThrow()
    expect(() => markRunWaitingForApproval(waiting, ['approval-1'])).toThrow()
    expect(() => resumeExecutionRun(running, ['approval-1'])).toThrow()
    expect(() =>
      completeExecutionRun(planned, { status: 'succeeded', now: 200 }),
    ).toThrow()
    expect(() => startExecutionRun(succeeded)).toThrow(
      'Cannot start a terminal execution run',
    )
    expect(() => startExecutionRun(failed)).toThrow(
      'Cannot start a terminal execution run',
    )
    expect(() =>
      completeExecutionRun(succeeded, { status: 'succeeded', now: 300 }),
    ).toThrow()
    expect(() =>
      completeExecutionRun(failed, {
        status: 'failed',
        failureReason: 'execution-error',
        now: 300,
      }),
    ).toThrow()
  })

  it('never mutates prior snapshots', () => {
    const planned = createPlannedRun()
    const running = startExecutionRun(planned)
    const waiting = markRunWaitingForApproval(running, ['approval-1'])
    const resumed = resumeExecutionRun(waiting, ['approval-1'])
    const succeeded = completeExecutionRun(resumed, {
      status: 'succeeded',
      now: 200,
    })

    expect(planned.phase).toBe('planned')
    expect(planned.waitingFor).toBeUndefined()
    expect(planned.finishedAt).toBeUndefined()
    expect(running.phase).toBe('running')
    expect(running.waitingFor).toBeUndefined()
    expect(running.finishedAt).toBeUndefined()
    expect(waiting.phase).toBe('running')
    expect(waiting.waitingFor?.approvalIds).toEqual(['approval-1'])
    expect(waiting.finishedAt).toBeUndefined()
    expect(resumed.phase).toBe('running')
    expect(resumed.waitingFor).toBeUndefined()
    expect(resumed.finishedAt).toBeUndefined()
    expect(succeeded.phase).toBe('succeeded')
    expect(succeeded.finishedAt).toBe(200)
    expect(planned).not.toBe(running)
    expect(running).not.toBe(waiting)
    expect(waiting).not.toBe(resumed)
    expect(resumed).not.toBe(succeeded)
  })
})

describe('collectPendingApprovalIds', () => {
  it('collects sorted unique pending IDs only from assistant parts', () => {
    const messages: UIMessage[] = [
      message('assistant-1', 'assistant', [
        approvalPart('approval-b'),
        { type: 'text', text: 'working' },
        approvalPart('approval-a'),
        approvalPart('approval-b'),
        approvalPart('approval-c', 'approval-responded'),
      ]),
      message('user-1', 'user', [
        { type: 'text', text: 'continue' },
        approvalPart('approval-from-user'),
      ]),
      message('assistant-2', 'assistant', [
        {
          type: 'dynamic-tool',
          toolCallId: 'call-without-approval',
          toolName: 'test-tool',
          state: 'input-available',
          input: {},
        } as unknown as UIMessage['parts'][number],
        approvalPart(''),
      ]),
    ]

    expect(collectPendingApprovalIds(messages)).toEqual([
      'approval-a',
      'approval-b',
    ])
  })
})
