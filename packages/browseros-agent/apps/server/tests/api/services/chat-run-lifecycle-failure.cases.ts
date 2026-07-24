import { describe, expect, it, mock } from 'bun:test'
import {
  createExecutionRun,
  startExecutionRun,
} from '../../../src/agent/execution-run'
import type {
  EvidenceEvent,
  NormalizedToolResult,
} from '../../../src/agent/execution-types'
import {
  failOwnedChatRun,
  finishOwnedChatRun,
} from '../../../src/api/services/chat-run-lifecycle'
import {
  createFakeAgent,
  createSessionStore,
} from './chat-service-test-harness'

type EffectStatus = NormalizedToolResult['effectStatus']

function evidence(options: {
  id: string
  kind: 'requested' | 'settled'
  effectStatus?: EffectStatus
}): EvidenceEvent {
  return {
    eventId: `event-${options.id}`,
    toolCallId: `call-${options.id}`,
    toolName: 'filesystem_write',
    kind: options.kind,
    effects: ['filesystem-write'],
    retrySafety: 'unsafe',
    ...(options.effectStatus
      ? {
          result: {
            transportStatus: 'received',
            executionStatus:
              options.effectStatus === 'none' ? 'denied' : 'success',
            effectStatus: options.effectStatus,
            verificationStatus: 'not-run',
          } satisfies NormalizedToolResult,
        }
      : {}),
    argumentDigest: `argument-${options.id}`,
    argumentDigestFidelity: 'exact',
    recordedAt: 100,
  }
}

function createOwnedRun(events: EvidenceEvent[]) {
  const conversationId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const sessionStore = createSessionStore()
  const run = startExecutionRun(
    createExecutionRun({
      runId,
      conversationId,
      userMessageId: crypto.randomUUID(),
    }),
  )
  const acquired = sessionStore.tryAcquireTurn(run)
  if (!acquired.acquired) throw new Error('Expected run ownership')
  for (const event of events) {
    expect(sessionStore.recordEvidence(conversationId, runId, event)).toBe(true)
  }
  return {
    conversationId,
    runId,
    sessionStore,
    session: { agent: createFakeAgent() },
    clearEvidenceSink: mock(() => {}),
    closeHiddenPage: mock(() => {}),
  }
}

describe('chat run failure effect truth', () => {
  for (const testCase of [
    {
      name: 'maps an applied settlement on abort to partial',
      events: [
        evidence({ id: 'applied', kind: 'settled', effectStatus: 'applied' }),
      ],
      finish: { isAborted: true, finishReason: 'other' as const },
      deniedByApproval: false,
      failureReason: 'aborted',
      effectState: 'partial',
    },
    {
      name: 'maps a partial settlement on stream error to partial',
      events: [
        evidence({ id: 'partial', kind: 'settled', effectStatus: 'partial' }),
      ],
      finish: { isAborted: false, finishReason: 'error' as const },
      deniedByApproval: false,
      failureReason: 'execution-error',
      effectState: 'partial',
    },
    {
      name: 'maps an unknown settlement on denial to unknown',
      events: [
        evidence({ id: 'unknown', kind: 'settled', effectStatus: 'unknown' }),
      ],
      finish: { isAborted: false, finishReason: 'stop' as const },
      deniedByApproval: true,
      failureReason: 'denied',
      effectState: 'unknown',
    },
    {
      name: 'maps proven-none evidence on denial to none',
      events: [evidence({ id: 'none', kind: 'settled', effectStatus: 'none' })],
      finish: { isAborted: false, finishReason: 'stop' as const },
      deniedByApproval: true,
      failureReason: 'denied',
      effectState: 'none',
    },
    {
      name: 'maps no evidence on abort to none',
      events: [],
      finish: { isAborted: true, finishReason: 'other' as const },
      deniedByApproval: false,
      failureReason: 'aborted',
      effectState: 'none',
    },
  ] as const) {
    it(testCase.name, () => {
      const owned = createOwnedRun([...testCase.events])

      expect(
        finishOwnedChatRun({
          sessionStore: owned.sessionStore as never,
          session: owned.session as never,
          conversationId: owned.conversationId,
          runId: owned.runId,
          messages: [
            {
              id: 'user-message',
              role: 'user',
              parts: [{ type: 'text', text: 'perform work' }],
            },
          ],
          ...testCase.finish,
          deniedByApproval: testCase.deniedByApproval,
          clearEvidenceSink: owned.clearEvidenceSink,
          closeHiddenPage: owned.closeHiddenPage,
        }),
      ).toBe('terminal')
      expect(owned.sessionStore.finishCalls.at(-1)?.outcome).toEqual({
        status: 'failed',
        failureReason: testCase.failureReason,
        effectState: testCase.effectState,
      })
    })
  }

  it('maps an unresolved mutating request on setup failure to unknown', () => {
    const owned = createOwnedRun([
      evidence({ id: 'unresolved', kind: 'requested' }),
    ])

    expect(
      failOwnedChatRun({
        sessionStore: owned.sessionStore as never,
        conversationId: owned.conversationId,
        runId: owned.runId,
        failureReason: 'execution-error',
        clearEvidenceSink: owned.clearEvidenceSink,
        closeHiddenPage: owned.closeHiddenPage,
      }),
    ).toBe(true)
    expect(owned.sessionStore.finishCalls.at(-1)?.outcome).toEqual({
      status: 'failed',
      failureReason: 'execution-error',
      effectState: 'unknown',
    })
  })
})
