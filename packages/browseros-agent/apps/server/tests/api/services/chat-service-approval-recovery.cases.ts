import { beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  ChatService,
  createBrowser,
  createFakeAgent,
  createRequest,
  createSessionStore,
  defaultLlmConfig,
  finishStream,
  harnessState,
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

function createScheduledFixture() {
  const browser = {
    ...createBrowser(),
    newPage: mock(async () => 77),
    listPages: mock(async () => [{ pageId: 77, windowId: 11 }]),
  }
  const sessionStore = createSessionStore()
  const service = new ChatService({
    sessionStore: sessionStore as never,
    klavisRef: { handle: null },
    browser: browser as never,
    registry: { names: () => [] } as never,
  })
  return { browser, service, sessionStore }
}

async function startWaitingTurn(options: {
  service: InstanceType<typeof ChatService>
  sessionStore: ReturnType<typeof createSessionStore>
  conversationId: string
  streams: StreamResponseOptions[]
}): Promise<string> {
  await options.service.processMessage(
    createRequest(options.conversationId, {
      message: 'request approved work',
      isScheduledTask: true,
    }) as never,
    new AbortController().signal,
  )
  const stream = requireStream(options.streams[0])
  await finishStream(stream, [
    ...(stream.uiMessages ?? []),
    {
      id: 'assistant-approval',
      role: 'assistant',
      parts: [approvalPart('approval-a')],
    },
  ])
  const run = options.sessionStore.getActiveRun(options.conversationId)
  expect(run?.waitingFor).toEqual({
    kind: 'approval',
    approvalIds: ['approval-a'],
  })
  if (!run) throw new Error('Expected approval-owned run')
  return run.runId
}

function approvalRequest(conversationId: string) {
  return createRequest(conversationId, {
    message: '',
    isScheduledTask: true,
    toolApprovalResponses: [{ approvalId: 'approval-a', approved: true }],
  }) as never
}

beforeEach(() => {
  harnessState.agentToReturn = createFakeAgent()
  harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
  harnessState.createAgentError = undefined
  harnessState.replaceSessionError = undefined
  harnessState.replaceSessionResult = undefined
  harnessState.replaceSessionConflict = undefined
  resolveLLMConfigSpy.mockImplementation(async () => ({
    ...harnessState.resolvedLlmConfig,
  }))
})

describe('ChatService approval resume recovery', () => {
  it('restores a waiting approval after an early resolver failure and permits exact retry', async () => {
    const { browser, service, sessionStore } = createScheduledFixture()
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
    const messagesBefore = structuredClone(
      harnessState.agentToReturn?.messages ?? [],
    )
    const retainedSink = harnessState.agentToReturn?.evidenceSink

    resolveLLMConfigSpy.mockImplementationOnce(async () => {
      throw new Error('resolver-failure')
    })
    await expect(
      service.processMessage(
        approvalRequest(conversationId),
        new AbortController().signal,
      ),
    ).rejects.toThrow('resolver-failure')

    expect(sessionStore.getActiveRun(conversationId)).toEqual(
      expect.objectContaining({
        runId,
        waitingFor: {
          kind: 'approval',
          approvalIds: ['approval-a'],
        },
      }),
    )
    expect(harnessState.agentToReturn?.messages).toEqual(messagesBefore)
    expect(harnessState.agentToReturn?.evidenceSink).toBe(retainedSink)
    expect(sessionStore.get(conversationId)?.hiddenPageId).toBe(77)
    expect(browser.closePage).not.toHaveBeenCalled()

    await service.processMessage(
      approvalRequest(conversationId),
      new AbortController().signal,
    )
    expect(sessionStore.getActiveRun(conversationId)).toEqual(
      expect.objectContaining({ runId, waitingFor: undefined }),
    )
    expect(streams).toHaveLength(2)
  })

  it('restores a waiting approval when the pre-await message snapshot cannot be cloned', async () => {
    const { browser, service, sessionStore } = createScheduledFixture()
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
    const approvalMessage = harnessState.agentToReturn?.messages.find(
      (message) => message.id === 'assistant-approval',
    )
    if (!approvalMessage) throw new Error('Expected pending approval message')
    approvalMessage.parts[0].uncloneable = () => {}
    const retainedSink = harnessState.agentToReturn?.evidenceSink

    await expect(
      service.processMessage(
        approvalRequest(conversationId),
        new AbortController().signal,
      ),
    ).rejects.toThrow()

    expect(sessionStore.getActiveRun(conversationId)).toEqual(
      expect.objectContaining({
        runId,
        waitingFor: {
          kind: 'approval',
          approvalIds: ['approval-a'],
        },
      }),
    )
    expect(approvalMessage.parts[0].state).toBe('approval-requested')
    expect(harnessState.agentToReturn?.evidenceSink).toBe(retainedSink)
    expect(sessionStore.get(conversationId)?.hiddenPageId).toBe(77)
    expect(browser.closePage).not.toHaveBeenCalled()

    delete approvalMessage.parts[0].uncloneable
    await service.processMessage(
      approvalRequest(conversationId),
      new AbortController().signal,
    )
    expect(sessionStore.getActiveRun(conversationId)).toEqual(
      expect.objectContaining({ runId, waitingFor: undefined }),
    )
  })

  it('restores a waiting approval after a late stream-setup failure and permits exact retry', async () => {
    const { browser, service, sessionStore } = createScheduledFixture()
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
    const messagesBefore = structuredClone(
      harnessState.agentToReturn?.messages ?? [],
    )
    const retainedSink = harnessState.agentToReturn?.evidenceSink

    harnessState.streamResponseHandler = async () => {
      throw new Error('stream-setup-failure')
    }
    await expect(
      service.processMessage(
        approvalRequest(conversationId),
        new AbortController().signal,
      ),
    ).rejects.toThrow('stream-setup-failure')

    expect(sessionStore.getActiveRun(conversationId)).toEqual(
      expect.objectContaining({
        runId,
        waitingFor: {
          kind: 'approval',
          approvalIds: ['approval-a'],
        },
      }),
    )
    expect(harnessState.agentToReturn?.messages).toEqual(messagesBefore)
    expect(harnessState.agentToReturn?.evidenceSink).toBe(retainedSink)
    expect(sessionStore.get(conversationId)?.hiddenPageId).toBe(77)
    expect(browser.closePage).not.toHaveBeenCalled()

    harnessState.streamResponseHandler = async (options) => {
      streams.push(options)
      return new Response('held-open')
    }
    await service.processMessage(
      approvalRequest(conversationId),
      new AbortController().signal,
    )
    expect(sessionStore.getActiveRun(conversationId)).toEqual(
      expect.objectContaining({ runId, waitingFor: undefined }),
    )
    expect(streams).toHaveLength(2)
  })

  it('keeps an aborted approval continuation terminal', async () => {
    const { browser, service, sessionStore } = createScheduledFixture()
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
    })

    resolveLLMConfigSpy.mockImplementationOnce(async () => {
      throw new Error('aborted-resolver')
    })
    const controller = new AbortController()
    controller.abort()
    await expect(
      service.processMessage(
        approvalRequest(conversationId),
        controller.signal,
      ),
    ).rejects.toThrow('aborted-resolver')

    expect(sessionStore.getActiveRun(conversationId)).toBeUndefined()
    expect(harnessState.agentToReturn?.evidenceSink).toBeUndefined()
    expect(sessionStore.get(conversationId)?.hiddenPageId).toBeUndefined()
    expect(browser.closePage).toHaveBeenCalledTimes(1)
    await expect(
      service.processMessage(
        approvalRequest(conversationId),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONVERSATION_BUSY',
    })
  })

  it('suspends a fresh approval requested after a denial and permits its continuation', async () => {
    const { service, sessionStore } = createScheduledFixture()
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
        message: '',
        isScheduledTask: true,
        toolApprovalResponses: [
          { approvalId: 'approval-a', approved: false, reason: 'use another' },
        ],
      }) as never,
      new AbortController().signal,
    )
    const deniedStream = requireStream(streams[1])
    await finishStream(deniedStream, [
      ...(deniedStream.uiMessages ?? []),
      {
        id: 'assistant-second-approval',
        role: 'assistant',
        parts: [approvalPart('approval-b')],
      },
    ])

    expect(sessionStore.getActiveRun(conversationId)).toEqual(
      expect.objectContaining({
        runId,
        waitingFor: {
          kind: 'approval',
          approvalIds: ['approval-b'],
        },
      }),
    )
    expect(
      harnessState.agentToReturn?.messages
        .flatMap((message) => message.parts)
        .some(
          (part) =>
            part.state === 'approval-requested' &&
            (part.approval as { id?: string } | undefined)?.id === 'approval-b',
        ),
    ).toBe(true)

    await service.processMessage(
      createRequest(conversationId, {
        message: '',
        isScheduledTask: true,
        toolApprovalResponses: [{ approvalId: 'approval-b', approved: true }],
      }) as never,
      new AbortController().signal,
    )
    const approvedStream = requireStream(streams[2])
    await finishStream(approvedStream, [
      ...(approvedStream.uiMessages ?? []),
      {
        id: 'assistant-complete',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Alternative completed.' }],
      },
    ])
    expect(sessionStore.getActiveRun(conversationId)).toBeUndefined()
  })
})
