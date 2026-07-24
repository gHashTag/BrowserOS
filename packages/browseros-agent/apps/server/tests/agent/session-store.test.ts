import { describe, expect, it } from 'bun:test'
import {
  createExecutionRun,
  startExecutionRun,
} from '../../src/agent/execution-run'
import type {
  EvidenceEvent,
  ExecutionRun,
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

function acquireTurn(store: SessionStore, run: ExecutionRun): ExecutionRun {
  const result = store.tryAcquireTurn(run)
  if (!result.acquired) {
    throw new Error('Expected the turn lease to be acquired')
  }
  return result.run
}

function createSession(
  dispose: () => Promise<void> = async () => undefined,
): AgentSession {
  return {
    agent: {
      dispose,
    } as unknown as AgentSession['agent'],
    executionFingerprint: 'test-session-fingerprint',
  }
}

function createDeferredDisposal() {
  let resolve: () => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function beginApprovalDeletion(store: SessionStore) {
  const disposal = createDeferredDisposal()
  const session = createSession(() => disposal.promise)
  store.set('conversation-1', session)
  acquireTurn(store, createRunningRun('run-1'))
  const waiting = store.suspendTurnForApproval('conversation-1', 'run-1', [
    'approval-a',
  ])
  if (!waiting) {
    throw new Error('Expected the active run to wait for approval')
  }
  const deletion = store.delete('conversation-1')
  return { deletion, disposal, session, waiting }
}

describe('SessionStore turn leases', () => {
  it('acquires the first turn and refuses a second turn with the original run', () => {
    const store = new SessionStore()
    const first = createRunningRun('run-1')
    const second = createRunningRun('run-2')

    const acquired = store.tryAcquireTurn(first)
    expect(acquired.acquired).toBe(true)
    if (!acquired.acquired) {
      throw new Error('Expected the first turn lease to be acquired')
    }
    expect(acquired.run).toEqual(first)
    expect(acquired.run).not.toBe(first)
    expect(store.tryAcquireTurn(second)).toEqual({
      acquired: false,
      activeRun: acquired.run,
    })
    expect(store.getActiveRun('conversation-1')).toBe(acquired.run)
  })

  it('acquires turns for different conversations independently', () => {
    const store = new SessionStore()
    const first = createRunningRun('run-1', 'conversation-1')
    const second = createRunningRun('run-2', 'conversation-2')

    const firstSnapshot = acquireTurn(store, first)
    const secondSnapshot = acquireTurn(store, second)

    expect(firstSnapshot).toEqual(first)
    expect(secondSnapshot).toEqual(second)
    expect(store.getActiveRun('conversation-1')).toBe(firstSnapshot)
    expect(store.getActiveRun('conversation-2')).toBe(secondSnapshot)
  })

  it('deeply snapshots caller-owned mutable runs on acquisition', () => {
    const store = new SessionStore()
    const expectedEffects: ToolEffect[] = ['filesystem-write']
    const eventEffects: ToolEffect[] = ['filesystem-write']
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
      effects: eventEffects,
      retrySafety: 'unsafe',
      result,
      argumentDigest: 'argument-digest',
      argumentDigestFidelity: 'exact',
      outputDigest: 'output-digest',
      outputDigestFidelity: 'exact',
      recordedAt: 100,
    } satisfies EvidenceEvent
    const evidence: EvidenceEvent[] = [event]
    const callerRun = {
      runId: 'run-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      intent: 'action',
      expectedEffects,
      phase: 'running',
      waitingFor: undefined,
      attempt: 0,
      evidence,
      failureReason: undefined,
      effectState: 'complete',
      startedAt: 100,
      finishedAt: undefined,
    } satisfies ExecutionRun

    const snapshot = acquireTurn(store, callerRun)
    const snapshotEvent = snapshot.evidence[0]

    expect(snapshot).not.toBe(callerRun)
    expect(snapshot.expectedEffects).not.toBe(expectedEffects)
    expect(snapshot.evidence).not.toBe(evidence)
    expect(snapshotEvent).not.toBe(event)
    expect(snapshotEvent.effects).not.toBe(eventEffects)
    expect(snapshotEvent.result).not.toBe(result)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.expectedEffects)).toBe(true)
    expect(Object.isFrozen(snapshot.evidence)).toBe(true)
    expect(Object.isFrozen(snapshotEvent)).toBe(true)
    expect(Object.isFrozen(snapshotEvent.effects)).toBe(true)
    expect(Object.isFrozen(snapshotEvent.result)).toBe(true)
    expect(Object.isFrozen(callerRun)).toBe(false)
    expect(Object.isFrozen(expectedEffects)).toBe(false)
    expect(Object.isFrozen(evidence)).toBe(false)
    expect(Object.isFrozen(event)).toBe(false)
    expect(Object.isFrozen(eventEffects)).toBe(false)
    expect(Object.isFrozen(result)).toBe(false)

    callerRun.runId = 'mutated-run'
    expectedEffects.push('command')
    event.toolName = 'mutated-tool'
    eventEffects.push('command')
    result.executionStatus = 'error'
    evidence.push({ ...event, eventId: 'event-2' })

    expect(snapshot.runId).toBe('run-1')
    expect(snapshot.expectedEffects).toEqual(['filesystem-write'])
    expect(snapshot.evidence).toHaveLength(1)
    expect(snapshotEvent.toolName).toBe('write-file')
    expect(snapshotEvent.effects).toEqual(['filesystem-write'])
    expect(snapshotEvent.result?.executionStatus).toBe('success')
    expect(store.getActiveRun('conversation-1')).toBe(snapshot)
    expect(
      store.finishTurn('conversation-1', 'run-1', { status: 'succeeded' }),
    ).toBe(true)
  })

  it('suspends only the owning run and stores sorted approval IDs', () => {
    const store = new SessionStore()
    const running = createRunningRun('run-1')
    const activeRun = acquireTurn(store, running)

    expect(
      store.suspendTurnForApproval('conversation-1', 'stale-run', [
        'approval-a',
      ]),
    ).toBeUndefined()
    expect(store.getActiveRun('conversation-1')).toBe(activeRun)

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
    acquireTurn(store, running)
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
    acquireTurn(store, running)
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
    acquireTurn(store, running)
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
    const firstSnapshot = acquireTurn(store, first)

    expect(
      store.finishTurn('conversation-1', 'stale-run', {
        status: 'failed',
        failureReason: 'execution-error',
      }),
    ).toBe(false)
    expect(store.getActiveRun('conversation-1')).toBe(firstSnapshot)
    expect(
      store.finishTurn('conversation-1', 'run-1', {
        status: 'succeeded',
      }),
    ).toBe(true)
    expect(store.getActiveRun('conversation-1')).toBeUndefined()

    const second = createRunningRun('run-2')
    const secondSnapshot = acquireTurn(store, second)
    expect(
      store.finishTurn('conversation-1', 'run-1', {
        status: 'succeeded',
      }),
    ).toBe(false)
    expect(store.getActiveRun('conversation-1')).toBe(secondSnapshot)
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

  it('releases an owner-matched planned run during pre-stream cleanup', () => {
    const store = new SessionStore()
    const planned = createExecutionRun({
      runId: 'run-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      now: 100,
    })
    acquireTurn(store, planned)

    expect(
      store.finishTurn('conversation-1', 'run-1', {
        status: 'failed',
        failureReason: 'execution-error',
      }),
    ).toBe(true)
    expect(store.getActiveRun('conversation-1')).toBeUndefined()
  })

  it('keeps an active lease while its agent session is replaced or removed', () => {
    const store = new SessionStore()
    const running = createRunningRun('run-1')

    store.set('conversation-1', createSession())
    const activeRun = acquireTurn(store, running)
    store.set('conversation-1', createSession())
    expect(store.getActiveRun('conversation-1')).toBe(activeRun)

    expect(store.remove('conversation-1')).toBe(true)
    expect(store.getActiveRun('conversation-1')).toBe(activeRun)

    store.set('conversation-1', createSession())
    expect(store.getActiveRun('conversation-1')).toBe(activeRun)
  })

  it('explicitly deletes a session and its waiting approval lease', async () => {
    const store = new SessionStore()
    store.set('conversation-1', createSession())
    acquireTurn(store, createRunningRun('run-1'))
    store.suspendTurnForApproval('conversation-1', 'run-1', ['approval-a'])

    expect(await store.delete('conversation-1')).toBe(true)
    expect(store.has('conversation-1')).toBe(false)
    expect(store.getActiveRun('conversation-1')).toBeUndefined()
  })

  it('refuses deletion while a turn is running and keeps later turns blocked', async () => {
    const store = new SessionStore()
    let disposeCalls = 0
    const session = createSession(async () => {
      disposeCalls += 1
    })
    store.set('conversation-1', session)
    const activeRun = acquireTurn(store, createRunningRun('run-1'))

    expect(await store.delete('conversation-1')).toBe(false)
    expect(disposeCalls).toBe(0)
    expect(store.get('conversation-1')).toBe(session)
    expect(store.getActiveRun('conversation-1')).toBe(activeRun)
    expect(store.tryAcquireTurn(createRunningRun('run-2'))).toEqual({
      acquired: false,
      activeRun,
    })
  })

  it('preserves an active orphan lease but removes an approval-suspended orphan', async () => {
    const store = new SessionStore()
    const activeRun = acquireTurn(store, createRunningRun('run-1'))

    expect(await store.delete('conversation-1')).toBe(false)
    expect(store.getActiveRun('conversation-1')).toBe(activeRun)

    const waiting = store.suspendTurnForApproval('conversation-1', 'run-1', [
      'approval-a',
    ])
    expect(waiting?.waitingFor?.approvalIds).toEqual(['approval-a'])
    expect(await store.delete('conversation-1')).toBe(false)
    expect(store.getActiveRun('conversation-1')).toBeUndefined()
  })

  it('preserves the session and approval lease when agent disposal fails', async () => {
    const store = new SessionStore()
    const disposal = createDeferredDisposal()
    const session = createSession(() => disposal.promise)
    store.set('conversation-1', session)
    acquireTurn(store, createRunningRun('run-1'))
    const waiting = store.suspendTurnForApproval('conversation-1', 'run-1', [
      'approval-a',
    ])

    const deletion = store.delete('conversation-1')
    expect(
      store.tryResumeApprovalTurn('conversation-1', ['approval-a']),
    ).toEqual({
      resumed: false,
      reason: 'deletion-pending',
      activeRun: waiting,
    })
    disposal.reject(new Error('dispose failed'))
    await expect(deletion).rejects.toThrow('dispose failed')
    expect(store.get('conversation-1')).toBe(session)
    expect(store.getActiveRun('conversation-1')).toBe(waiting)
    const resumed = store.tryResumeApprovalTurn('conversation-1', [
      'approval-a',
    ])
    expect(resumed.resumed).toBe(true)
  })

  it('rejects approval resume while deletion is pending', async () => {
    const store = new SessionStore()
    const disposal = createDeferredDisposal()
    const session = createSession(() => disposal.promise)
    store.set('conversation-1', session)
    acquireTurn(store, createRunningRun('run-1'))
    const waiting = store.suspendTurnForApproval('conversation-1', 'run-1', [
      'approval-a',
    ])

    const deletion = store.delete('conversation-1')
    expect(
      store.tryResumeApprovalTurn('conversation-1', ['approval-a']),
    ).toEqual({
      resumed: false,
      reason: 'deletion-pending',
      activeRun: waiting,
    })
    expect(store.getActiveRun('conversation-1')).toBe(waiting)
    disposal.resolve()

    expect(await deletion).toBe(true)
    expect(store.get('conversation-1')).toBeUndefined()
    expect(store.getActiveRun('conversation-1')).toBeUndefined()
  })

  it('rejects new lease acquisition while session deletion is pending', async () => {
    const store = new SessionStore()
    const disposal = createDeferredDisposal()
    store.set(
      'conversation-1',
      createSession(() => disposal.promise),
    )

    const deletion = store.delete('conversation-1')
    const nextRun = createRunningRun('run-1')
    expect(store.tryAcquireTurn(nextRun)).toEqual({
      acquired: false,
      reason: 'deletion-pending',
    })
    expect(store.getActiveRun('conversation-1')).toBeUndefined()
    disposal.resolve()

    expect(await deletion).toBe(true)
    expect(store.get('conversation-1')).toBeUndefined()
    expect(store.getActiveRun('conversation-1')).toBeUndefined()
    expect(store.tryAcquireTurn(nextRun).acquired).toBe(true)
  })

  it('refuses finishing the captured run while deletion is pending', async () => {
    const store = new SessionStore()
    const { deletion, disposal, waiting } = beginApprovalDeletion(store)

    expect(
      store.finishTurn('conversation-1', 'run-1', {
        status: 'failed',
        failureReason: 'denied',
      }),
    ).toBe(false)
    expect(store.getActiveRun('conversation-1')).toBe(waiting)
    disposal.resolve()

    expect(await deletion).toBe(true)
    expect(store.get('conversation-1')).toBeUndefined()
    expect(store.getActiveRun('conversation-1')).toBeUndefined()
  })

  it('refuses recording evidence on the captured run while deletion is pending', async () => {
    const store = new SessionStore()
    const { deletion, disposal, waiting } = beginApprovalDeletion(store)
    const event = {
      eventId: 'event-during-deletion',
      toolCallId: 'call-during-deletion',
      toolName: 'observe',
      kind: 'settled',
      effects: ['observe'],
      retrySafety: 'safe',
      argumentDigest: 'argument-digest',
      argumentDigestFidelity: 'exact',
      recordedAt: 200,
    } satisfies EvidenceEvent

    expect(store.recordEvidence('conversation-1', 'run-1', event)).toBe(false)
    expect(store.getActiveRun('conversation-1')).toBe(waiting)
    disposal.resolve()

    expect(await deletion).toBe(true)
    expect(store.get('conversation-1')).toBeUndefined()
    expect(store.getActiveRun('conversation-1')).toBeUndefined()
  })

  it('refuses another approval suspension while deletion is pending', async () => {
    const store = new SessionStore()
    const { deletion, disposal, waiting } = beginApprovalDeletion(store)

    expect(
      store.suspendTurnForApproval('conversation-1', 'run-1', ['approval-b']),
    ).toBeUndefined()
    expect(store.getActiveRun('conversation-1')).toBe(waiting)
    disposal.resolve()

    expect(await deletion).toBe(true)
    expect(store.getActiveRun('conversation-1')).toBeUndefined()
  })

  it('rejects session replacement and removal while deletion is pending', async () => {
    const store = new SessionStore()
    const { deletion, disposal, session, waiting } =
      beginApprovalDeletion(store)

    expect(() => store.set('conversation-1', createSession())).toThrow(
      'Cannot replace a session while deletion is pending',
    )
    expect(store.remove('conversation-1')).toBe(false)
    expect(store.get('conversation-1')).toBe(session)
    expect(store.has('conversation-1')).toBe(true)
    expect(store.getActiveRun('conversation-1')).toBe(waiting)
    disposal.resolve()

    expect(await deletion).toBe(true)
    expect(store.get('conversation-1')).toBeUndefined()
    expect(store.has('conversation-1')).toBe(false)
    expect(store.getActiveRun('conversation-1')).toBeUndefined()
  })

  it('preserves a lease if the captured session is unexpectedly replaced', async () => {
    const store = new SessionStore()
    const { deletion, disposal, waiting } = beginApprovalDeletion(store)
    const replacement = createSession()
    const sessions = (
      store as unknown as {
        sessions: Map<string, AgentSession>
      }
    ).sessions
    sessions.set('conversation-1', replacement)
    disposal.resolve()

    expect(await deletion).toBe(false)
    expect(store.get('conversation-1')).toBe(replacement)
    expect(store.getActiveRun('conversation-1')).toBe(waiting)
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
      argumentDigestFidelity: 'exact',
      outputDigest: 'output-digest',
      outputDigestFidelity: 'exact',
      recordedAt: 150,
    } satisfies EvidenceEvent
    const prior = acquireTurn(store, running)

    expect(store.recordEvidence('conversation-1', 'run-1', event)).toBe(true)

    const updated = store.getActiveRun('conversation-1')
    if (!updated) {
      throw new Error('Expected evidence to be recorded')
    }
    const storedEvent = updated.evidence[0]
    expect(updated).not.toBe(prior)
    expect(updated.evidence).not.toBe(prior.evidence)
    expect(prior.evidence).toEqual([])
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

    const verification = {
      eventId: 'event-2',
      toolCallId: 'call-2',
      toolName: 'verify-write',
      kind: 'verification',
      effects: ['verify'],
      retrySafety: 'safe',
      argumentDigest: 'verification-argument-digest',
      argumentDigestFidelity: 'exact',
      outputDigest: 'verification-output-digest',
      outputDigestFidelity: 'exact',
      recordedAt: 200,
    } satisfies EvidenceEvent
    expect(store.recordEvidence('conversation-1', 'run-1', verification)).toBe(
      true,
    )
    const appended = store.getActiveRun('conversation-1')
    expect(appended?.evidence).toHaveLength(2)
    expect(appended?.evidence[0]).toBe(storedEvent)
  })

  it('creates an owner-checked evidence sink that ignores stale owners', () => {
    const store = new SessionStore()
    acquireTurn(store, createRunningRun('run-1'))
    const ownerSink = store.createEvidenceSink('conversation-1', 'run-1')
    const staleSink = store.createEvidenceSink('conversation-1', 'stale-run')
    const ownerEvent = {
      eventId: 'owner-event',
      toolCallId: 'owner-call',
      toolName: 'filesystem_read',
      kind: 'settled',
      effects: ['filesystem-read'],
      retrySafety: 'safe',
      argumentDigest: 'argument-digest',
      argumentDigestFidelity: 'exact',
      recordedAt: 300,
    } satisfies EvidenceEvent
    const hostileStaleEvent = new Proxy(ownerEvent, {
      ownKeys: () => {
        throw new Error('stale evidence must not be inspected')
      },
    })

    expect(() => staleSink.record(hostileStaleEvent)).not.toThrow()
    expect(store.getActiveRun('conversation-1')?.evidence).toEqual([])
    expect(() => ownerSink.record(ownerEvent)).not.toThrow()
    expect(store.getActiveRun('conversation-1')?.evidence).toHaveLength(1)

    expect(
      store.finishTurn('conversation-1', 'run-1', { status: 'succeeded' }),
    ).toBe(true)
    expect(() => ownerSink.record(hostileStaleEvent)).not.toThrow()
  })

  it('rejects malformed owner evidence while the observe-only sink ignores it', () => {
    const store = new SessionStore()
    acquireTurn(store, createRunningRun('run-1'))
    const validEvent = {
      eventId: 'valid-event',
      toolCallId: 'valid-call',
      toolName: 'filesystem_read',
      kind: 'settled',
      effects: ['filesystem-read'],
      retrySafety: 'safe',
      argumentDigest: 'argument-digest',
      argumentDigestFidelity: 'exact',
      recordedAt: 400,
    } satisfies EvidenceEvent
    const malformedEvent = {
      ...validEvent,
      eventId: 'malformed-event',
      kind: 'fabricated',
    } as unknown as EvidenceEvent

    expect(() =>
      store.recordEvidence('conversation-1', 'run-1', malformedEvent),
    ).toThrow(TypeError)
    expect(store.getActiveRun('conversation-1')?.evidence).toEqual([])

    const ownerSink = store.createEvidenceSink('conversation-1', 'run-1')
    expect(() => ownerSink.record(malformedEvent)).not.toThrow()
    expect(store.getActiveRun('conversation-1')?.evidence).toEqual([])

    expect(store.recordEvidence('conversation-1', 'run-1', validEvent)).toBe(
      true,
    )
    expect(store.getActiveRun('conversation-1')?.evidence).toHaveLength(1)
  })
})
