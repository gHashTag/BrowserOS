import { describe, expect, it } from 'bun:test'
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

function createService(sessionStore: ReturnType<typeof createSessionStore>) {
  return new ChatService({
    sessionStore: sessionStore as never,
    klavisRef: { handle: null },
    browser: createBrowser() as never,
    registry: { names: () => [] } as never,
  })
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

describe('ChatService owned conversation runs', () => {
  it('acquires the ordinary run before LLM resolution or session mutation', async () => {
    resetHarness()
    const sessionStore = createSessionStore()
    const service = createService(sessionStore)
    const conversationId = crypto.randomUUID()
    let activeAtResolution:
      | ReturnType<typeof sessionStore.getActiveRun>
      | undefined
    let sessionAtResolution: unknown

    resolveLLMConfigSpy.mockImplementationOnce(async () => {
      activeAtResolution = sessionStore.getActiveRun(conversationId)
      sessionAtResolution = sessionStore.get(conversationId)
      throw new Error('stop-after-order-observation')
    })

    await expect(
      service.processMessage(
        createRequest(conversationId) as never,
        new AbortController().signal,
      ),
    ).rejects.toThrow('stop-after-order-observation')

    expect(activeAtResolution).toEqual(
      expect.objectContaining({
        conversationId,
        userMessageId: expect.any(String),
        phase: 'running',
      }),
    )
    expect(sessionAtResolution).toBeUndefined()
    expect(sessionStore.getActiveRun(conversationId)).toBeUndefined()
  })

  it('returns a metadata-safe 409 for overlap while another conversation runs', async () => {
    resetHarness()
    const sessionStore = createSessionStore()
    const service = createService(sessionStore)
    const firstConversationId = crypto.randomUUID()
    const otherConversationId = crypto.randomUUID()
    const streams: StreamResponseOptions[] = []
    harnessState.streamResponseHandler = async (options) => {
      streams.push(options)
      return new Response('held-open')
    }

    await service.processMessage(
      createRequest(firstConversationId) as never,
      new AbortController().signal,
    )
    const activeRun = sessionStore.getActiveRun(firstConversationId)
    expect(activeRun).toBeDefined()

    const overlap = await service
      .processMessage(
        createRequest(firstConversationId, {
          message: 'overlapping turn',
        }) as never,
        new AbortController().signal,
      )
      .catch((error: unknown) => error)

    expect(overlap).toEqual(
      expect.objectContaining({
        name: 'ConversationBusyError',
        statusCode: 409,
        code: 'CONVERSATION_BUSY',
        conversationId: firstConversationId,
        activeRunId: activeRun?.runId,
      }),
    )
    expect((overlap as { toJSON(): unknown }).toJSON()).toEqual({
      error: expect.objectContaining({
        code: 'CONVERSATION_BUSY',
        statusCode: 409,
        conversationId: firstConversationId,
        activeRunId: activeRun?.runId,
      }),
    })

    const independent = await service.processMessage(
      createRequest(otherConversationId) as never,
      new AbortController().signal,
    )
    expect(independent).toBeInstanceOf(Response)
    expect(sessionStore.getActiveRun(otherConversationId)).toBeDefined()
    expect(streams).toHaveLength(2)

    const firstStream = requireStream(streams[0])
    const secondStream = requireStream(streams[1])
    await finishStream(firstStream, firstStream.uiMessages ?? [])
    await finishStream(secondStream, secondStream.uiMessages ?? [])
  })

  it('checks stale ownership before persistence and every terminal cleanup', async () => {
    resetHarness()
    const sessionStore = createSessionStore()
    const service = createService(sessionStore)
    const conversationId = crypto.randomUUID()
    const streams: StreamResponseOptions[] = []
    harnessState.streamResponseHandler = async (options) => {
      streams.push(options)
      return new Response('held-open')
    }

    await service.processMessage(
      createRequest(conversationId, { message: 'run one' }) as never,
      new AbortController().signal,
    )
    const firstRunId = sessionStore.getActiveRun(conversationId)?.runId
    const firstStream = requireStream(streams[0])
    await finishStream(firstStream, [
      ...(firstStream.uiMessages ?? []),
      {
        id: 'assistant-one',
        role: 'assistant',
        parts: [{ type: 'text', text: 'first answer' }],
      },
    ])

    await service.processMessage(
      createRequest(conversationId, { message: 'run two' }) as never,
      new AbortController().signal,
    )
    const secondRun = sessionStore.getActiveRun(conversationId)
    const messagesBeforeStaleFinish = structuredClone(
      harnessState.agentToReturn?.messages ?? [],
    )
    const secondSink = harnessState.agentToReturn?.evidenceSink

    await finishStream(firstStream, [
      {
        id: 'stale-user',
        role: 'user',
        parts: [{ type: 'text', text: 'stale overwrite' }],
      },
    ])

    expect(secondRun?.runId).not.toBe(firstRunId)
    expect(sessionStore.getActiveRun(conversationId)).toBe(secondRun)
    expect(harnessState.agentToReturn?.messages).toEqual(
      messagesBeforeStaleFinish,
    )
    expect(harnessState.agentToReturn?.evidenceSink).toBe(secondSink)

    const secondStream = requireStream(streams[1])
    await finishStream(secondStream, secondStream.uiMessages ?? [])
  })
})
