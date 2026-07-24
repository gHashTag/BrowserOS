import { describe, expect, it, mock } from 'bun:test'
import {
  ChatService,
  createAgentSpy,
  createBrowser,
  createFakeAgent,
  createRequest,
  createSessionStore,
  defaultLlmConfig,
  finishStream,
  harnessState,
  type MockMessage,
  requireStream,
  resolveLLMConfigSpy,
  type StreamResponseOptions,
} from './chat-service-test-harness'

function approvalPart(approvalId: string) {
  return {
    type: 'dynamic-tool',
    toolCallId: `call-${approvalId}`,
    toolName: 'filesystem_write',
    state: 'approval-requested',
    input: { path: approvalId },
    approval: { id: approvalId },
  }
}

function pendingAssistant(): MockMessage {
  return {
    id: 'assistant-approval',
    role: 'assistant',
    parts: [approvalPart('approval-b'), approvalPart('approval-a')],
  }
}

function resetHarness(): void {
  harnessState.agentToReturn = createFakeAgent()
  harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
  harnessState.createAgentError = undefined
  harnessState.replaceSessionError = undefined
  harnessState.replaceSessionResult = undefined
  harnessState.replaceSessionConflict = undefined
  resolveLLMConfigSpy.mockImplementation(async () => ({
    ...harnessState.resolvedLlmConfig,
  }))
}

function createService(
  sessionStore: ReturnType<typeof createSessionStore>,
  browser = createBrowser(),
) {
  return new ChatService({
    sessionStore: sessionStore as never,
    klavisRef: { handle: null },
    browser: browser as never,
    registry: { names: () => [] } as never,
  })
}

async function startWaitingTurn(options: {
  service: InstanceType<typeof ChatService>
  sessionStore: ReturnType<typeof createSessionStore>
  conversationId: string
  streams: StreamResponseOptions[]
  isScheduledTask?: boolean
}): Promise<string> {
  await options.service.processMessage(
    createRequest(options.conversationId, {
      message: 'request an approved write',
      isScheduledTask: options.isScheduledTask ?? false,
    }) as never,
    new AbortController().signal,
  )
  const firstStream = requireStream(options.streams[0])
  await finishStream(firstStream, [
    ...(firstStream.uiMessages ?? []),
    pendingAssistant(),
  ])
  const waiting = options.sessionStore.getActiveRun(options.conversationId)
  expect(waiting?.waitingFor).toEqual({
    kind: 'approval',
    approvalIds: ['approval-a', 'approval-b'],
  })
  if (!waiting) throw new Error('Expected a waiting run')
  return waiting.runId
}

describe('ChatService approval-owned run continuation', () => {
  it('retains one run, sink, and scheduled page through exact approval resume', async () => {
    resetHarness()
    const browser = {
      ...createBrowser(),
      newPage: mock(async () => 77),
      listPages: mock(async () => [{ pageId: 77, windowId: 11 }]),
    }
    const sessionStore = createSessionStore()
    const service = createService(sessionStore, browser)
    const conversationId = crypto.randomUUID()
    const streams: StreamResponseOptions[] = []
    harnessState.streamResponseHandler = async (options) => {
      streams.push(options)
      return new Response('held-open')
    }
    const createsBefore = createAgentSpy.mock.calls.length

    const runId = await startWaitingTurn({
      service,
      sessionStore,
      conversationId,
      streams,
      isScheduledTask: true,
    })
    const userCountBeforeResume = harnessState.agentToReturn?.messages.filter(
      (message) => message.role === 'user',
    ).length
    const retainedSink = harnessState.agentToReturn?.evidenceSink
    expect(retainedSink).toBeDefined()
    expect(browser.closePage).not.toHaveBeenCalled()
    expect(sessionStore.get(conversationId)?.hiddenPageId).toBe(77)

    harnessState.resolvedLlmConfig = {
      ...harnessState.resolvedLlmConfig,
      model: 'must-not-rebuild-during-approval',
    }
    await service.processMessage(
      createRequest(conversationId, {
        message: 'must not append this continuation payload',
        isScheduledTask: true,
        toolApprovalResponses: [
          { approvalId: 'approval-b', approved: true },
          { approvalId: 'approval-a', approved: true },
        ],
      }) as never,
      new AbortController().signal,
    )

    expect(sessionStore.getActiveRun(conversationId)).toEqual(
      expect.objectContaining({ runId, waitingFor: undefined }),
    )
    expect(createAgentSpy.mock.calls.length - createsBefore).toBe(1)
    expect(harnessState.agentToReturn?.evidenceSink).toBe(retainedSink)
    expect(
      harnessState.agentToReturn?.messages.filter(
        (message) => message.role === 'user',
      ),
    ).toHaveLength(userCountBeforeResume ?? 0)
    expect(
      streams[1]?.uiMessages
        ?.flatMap((message) => message.parts)
        .filter((part) => part.type === 'dynamic-tool')
        .map((part) => ({
          state: part.state,
          approval: part.approval,
        })),
    ).toEqual([
      {
        state: 'approval-responded',
        approval: { id: 'approval-b', approved: true, reason: undefined },
      },
      {
        state: 'approval-responded',
        approval: { id: 'approval-a', approved: true, reason: undefined },
      },
    ])

    const resumedStream = requireStream(streams[1])
    await finishStream(resumedStream, [
      ...(resumedStream.uiMessages ?? []),
      {
        id: 'assistant-done',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Approved work observed.' }],
      },
    ])
    expect(sessionStore.getActiveRun(conversationId)).toBeUndefined()
    expect(harnessState.agentToReturn?.evidenceSink).toBeUndefined()
    expect(browser.closePage).toHaveBeenCalledTimes(1)
    expect(browser.closePage).toHaveBeenCalledWith(77)
  })

  it('rejects partial, mixed, unknown, and duplicate responses atomically', async () => {
    resetHarness()
    const sessionStore = createSessionStore()
    const service = createService(sessionStore)
    const conversationId = crypto.randomUUID()
    const streams: StreamResponseOptions[] = []
    harnessState.streamResponseHandler = async (options) => {
      streams.push(options)
      return new Response('held-open')
    }
    const runId = await startWaitingTurn({
      service,
      sessionStore,
      conversationId,
      streams,
    })
    const waiting = sessionStore.getActiveRun(conversationId)
    const messagesBefore = structuredClone(
      harnessState.agentToReturn?.messages ?? [],
    )

    for (const responses of [
      [{ approvalId: 'approval-a', approved: true }],
      [
        { approvalId: 'approval-a', approved: true },
        { approvalId: 'approval-unknown', approved: true },
      ],
      [
        { approvalId: 'approval-unknown', approved: true },
        { approvalId: 'approval-other', approved: true },
      ],
      [
        { approvalId: 'approval-a', approved: true },
        { approvalId: 'approval-a', approved: false },
        { approvalId: 'approval-b', approved: true },
      ],
    ]) {
      const rejection = await service
        .processMessage(
          createRequest(conversationId, {
            message: 'invalid continuation',
            toolApprovalResponses: responses,
          }) as never,
          new AbortController().signal,
        )
        .catch((error: unknown) => error)

      expect(rejection).toEqual(
        expect.objectContaining({
          statusCode: 409,
          code: 'CONVERSATION_BUSY',
          conversationId,
          activeRunId: runId,
        }),
      )
      expect(sessionStore.getActiveRun(conversationId)).toBe(waiting)
      expect(harnessState.agentToReturn?.messages).toEqual(messagesBefore)
    }
    expect(streams).toHaveLength(1)
  })

  it('rejects a replay while the resumed stream owns the run', async () => {
    resetHarness()
    const sessionStore = createSessionStore()
    const service = createService(sessionStore)
    const conversationId = crypto.randomUUID()
    const streams: StreamResponseOptions[] = []
    harnessState.streamResponseHandler = async (options) => {
      streams.push(options)
      return new Response('held-open')
    }
    const runId = await startWaitingTurn({
      service,
      sessionStore,
      conversationId,
      streams,
    })
    const responses = [
      { approvalId: 'approval-a', approved: true },
      { approvalId: 'approval-b', approved: true },
    ]

    await service.processMessage(
      createRequest(conversationId, {
        toolApprovalResponses: responses,
      }) as never,
      new AbortController().signal,
    )
    const resumed = sessionStore.getActiveRun(conversationId)
    const messagesAfterResume = structuredClone(
      harnessState.agentToReturn?.messages ?? [],
    )
    const replay = await service
      .processMessage(
        createRequest(conversationId, {
          toolApprovalResponses: responses,
        }) as never,
        new AbortController().signal,
      )
      .catch((error: unknown) => error)

    expect(replay).toEqual(
      expect.objectContaining({
        statusCode: 409,
        code: 'CONVERSATION_BUSY',
        activeRunId: runId,
      }),
    )
    expect(sessionStore.getActiveRun(conversationId)).toBe(resumed)
    expect(harnessState.agentToReturn?.messages).toEqual(messagesAfterResume)
    expect(streams).toHaveLength(2)

    const resumedStream = requireStream(streams[1])
    await finishStream(resumedStream, resumedStream.uiMessages ?? [])
  })

  it('finishes an exact denied approval continuation as denied', async () => {
    resetHarness()
    const sessionStore = createSessionStore()
    const service = createService(sessionStore)
    const conversationId = crypto.randomUUID()
    const streams: StreamResponseOptions[] = []
    harnessState.streamResponseHandler = async (options) => {
      streams.push(options)
      return new Response('held-open')
    }
    const runId = await startWaitingTurn({
      service,
      sessionStore,
      conversationId,
      streams,
    })

    await service.processMessage(
      createRequest(conversationId, {
        toolApprovalResponses: [
          { approvalId: 'approval-a', approved: false, reason: 'Not allowed' },
          { approvalId: 'approval-b', approved: true },
        ],
      }) as never,
      new AbortController().signal,
    )
    const resumedStream = requireStream(streams[1])
    await finishStream(resumedStream, resumedStream.uiMessages ?? [])

    expect(sessionStore.getActiveRun(conversationId)).toBeUndefined()
    expect(sessionStore.finishCalls.at(-1)).toEqual({
      conversationId,
      runId,
      outcome: {
        status: 'failed',
        failureReason: 'denied',
        effectState: 'none',
      },
    })
    expect(harnessState.agentToReturn?.evidenceSink).toBeUndefined()
  })

  it('keeps duplicate approval finishes idempotently suspended', async () => {
    resetHarness()
    const browser = {
      ...createBrowser(),
      newPage: mock(async () => 91),
      listPages: mock(async () => [{ pageId: 91, windowId: 17 }]),
    }
    const sessionStore = createSessionStore()
    const service = createService(sessionStore, browser)
    const conversationId = crypto.randomUUID()
    const streams: StreamResponseOptions[] = []
    harnessState.streamResponseHandler = async (options) => {
      streams.push(options)
      return new Response('held-open')
    }
    await startWaitingTurn({
      service,
      sessionStore,
      conversationId,
      streams,
      isScheduledTask: true,
    })
    const firstStream = requireStream(streams[0])
    const waitingRun = sessionStore.getActiveRun(conversationId)
    const retainedMessages = harnessState.agentToReturn?.messages
    const retainedSink = harnessState.agentToReturn?.evidenceSink

    await finishStream(firstStream, [
      ...(firstStream.uiMessages ?? []),
      pendingAssistant(),
    ])
    await finishStream(firstStream, [
      ...(firstStream.uiMessages ?? []),
      {
        id: 'assistant-conflicting-approval',
        role: 'assistant',
        parts: [approvalPart('approval-other')],
      },
    ])

    expect(sessionStore.getActiveRun(conversationId)).toBe(waitingRun)
    expect(harnessState.agentToReturn?.messages).toBe(retainedMessages)
    expect(harnessState.agentToReturn?.evidenceSink).toBe(retainedSink)
    expect(sessionStore.finishCalls).toHaveLength(0)
    expect(browser.closePage).not.toHaveBeenCalled()
  })
})
