import { describe, expect, it, mock } from 'bun:test'
import {
  ChatService,
  consumeStream,
  createBrowser,
  createFakeAgent,
  createRequest,
  createSessionStore,
  defaultLlmConfig,
  evidenceEvent,
  finishStream,
  harnessState,
  loggerInfoSpy,
  type MockMessage,
  metricsLogSpy,
  requireStream,
  resolveLLMConfigSpy,
  type StreamResponseOptions,
} from './chat-service-test-harness'

function resetHarness(): void {
  harnessState.agentToReturn = createFakeAgent()
  harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
  harnessState.createAgentError = undefined
  loggerInfoSpy.mockImplementation(() => {})
  metricsLogSpy.mockImplementation(() => {})
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

describe('ChatService run completion cleanup', () => {
  for (const testCase of [
    {
      name: 'normal completion',
      finish: { isAborted: false, finishReason: 'stop' as const },
      outcome: { status: 'succeeded' },
    },
    {
      name: 'request abort',
      finish: { isAborted: true, finishReason: 'other' as const },
      outcome: {
        status: 'failed',
        failureReason: 'aborted',
        effectState: 'none',
      },
    },
    {
      name: 'stream error',
      finish: { isAborted: false, finishReason: 'error' as const },
      outcome: {
        status: 'failed',
        failureReason: 'execution-error',
        effectState: 'none',
      },
    },
  ]) {
    it(`releases the owner and evidence sink after ${testCase.name}`, async () => {
      resetHarness()
      const sessionStore = createSessionStore()
      const service = createService(sessionStore)
      const conversationId = crypto.randomUUID()
      let stream: StreamResponseOptions | undefined
      harnessState.streamResponseHandler = async (options) => {
        stream = options
        return new Response('held-open')
      }

      await service.processMessage(
        createRequest(conversationId) as never,
        new AbortController().signal,
      )
      const run = sessionStore.getActiveRun(conversationId)
      expect(run).toBeDefined()
      expect(
        harnessState.agentToReturn?.messages.find(
          (message) => message.role === 'user',
        )?.id,
      ).toBe(run?.userMessageId)
      expect(stream?.consumeSseStream).toBe(consumeStream)
      expect(harnessState.agentToReturn?.evidenceSink).toBeDefined()

      harnessState.agentToReturn?.evidenceSink?.record(
        evidenceEvent(`evidence-${testCase.name}`),
      )
      expect(sessionStore.getActiveRun(conversationId)?.evidence).toHaveLength(
        1,
      )

      const capturedStream = requireStream(stream)
      await finishStream(
        capturedStream,
        capturedStream.uiMessages ?? [],
        testCase.finish,
      )

      expect(sessionStore.getActiveRun(conversationId)).toBeUndefined()
      expect(harnessState.agentToReturn?.evidenceSink).toBeUndefined()
      expect(sessionStore.finishCalls.at(-1)?.outcome).toEqual(testCase.outcome)
      expect(metricsLogSpy).toHaveBeenCalledWith(
        'chat.execution_run',
        expect.objectContaining({
          conversation_id: conversationId,
          run_id: run?.runId,
          status:
            testCase.outcome.status === 'succeeded' ? 'succeeded' : 'failed',
        }),
      )
    })
  }

  it('isolates metrics and completion-log failures from owner cleanup', async () => {
    resetHarness()
    const metricsCallsBefore = metricsLogSpy.mock.calls.length
    metricsLogSpy.mockImplementation(() => {
      throw new Error('metrics-failure')
    })
    loggerInfoSpy.mockImplementation((message) => {
      if (message === 'Agent execution complete') {
        throw new Error('log-failure')
      }
    })
    const sessionStore = createSessionStore()
    const service = createService(sessionStore)
    const conversationId = crypto.randomUUID()
    harnessState.streamResponseHandler = async (options) => {
      await finishStream(options, options.uiMessages ?? [])
      return new Response('ok')
    }

    const response = await service.processMessage(
      createRequest(conversationId) as never,
      new AbortController().signal,
    )

    expect(response).toBeInstanceOf(Response)
    expect(metricsLogSpy.mock.calls.length).toBeGreaterThan(metricsCallsBefore)
    expect(sessionStore.getActiveRun(conversationId)).toBeUndefined()
    expect(harnessState.agentToReturn?.evidenceSink).toBeUndefined()
    loggerInfoSpy.mockImplementation(() => {})
    metricsLogSpy.mockImplementation(() => {})
  })

  it('rolls back an unstreamed message and closes a new scheduled page once', async () => {
    resetHarness()
    const browser = {
      ...createBrowser(),
      newPage: mock(async () => 77),
      listPages: mock(async () => [{ pageId: 77, windowId: 11 }]),
    }
    const sessionStore = createSessionStore()
    const service = createService(sessionStore, browser)
    const conversationId = crypto.randomUUID()
    harnessState.streamResponseHandler = async () => {
      throw new Error('stream-setup-failure')
    }

    await expect(
      service.processMessage(
        createRequest(conversationId, {
          message: 'must be rolled back',
          isScheduledTask: true,
        }) as never,
        new AbortController().signal,
      ),
    ).rejects.toThrow('stream-setup-failure')

    expect(sessionStore.getActiveRun(conversationId)).toBeUndefined()
    expect(sessionStore.get(conversationId)?.agent.messages).toEqual([])
    expect(sessionStore.get(conversationId)?.hiddenPageId).toBeUndefined()
    expect(sessionStore.get(conversationId)?.agent.evidenceSink).toBeUndefined()
    expect(browser.closePage).toHaveBeenCalledTimes(1)
    expect(browser.closePage).toHaveBeenCalledWith(77)
  })

  it('does not close a running turn hidden page when deletion is refused', async () => {
    resetHarness()
    const browser = {
      ...createBrowser(),
      newPage: mock(async () => 94),
      listPages: mock(async () => [{ pageId: 94, windowId: 18 }]),
    }
    const sessionStore = createSessionStore()
    const service = createService(sessionStore, browser)
    const conversationId = crypto.randomUUID()
    harnessState.streamResponseHandler = async () => new Response('held-open')

    await service.processMessage(
      createRequest(conversationId, { isScheduledTask: true }) as never,
      new AbortController().signal,
    )
    const result = await service.deleteSession(conversationId)

    expect(result).toEqual({ deleted: false, sessionCount: 1 })
    expect(sessionStore.getActiveRun(conversationId)).toBeDefined()
    expect(sessionStore.get(conversationId)?.hiddenPageId).toBe(94)
    expect(browser.closePage).not.toHaveBeenCalled()
  })

  it('keeps imported history when rolling back an unstreamed first turn', async () => {
    resetHarness()
    const sessionStore = createSessionStore()
    const service = createService(sessionStore)
    const conversationId = crypto.randomUUID()
    harnessState.streamResponseHandler = async () => {
      throw new Error('stream-setup-failure')
    }

    await expect(
      service.processMessage(
        createRequest(conversationId, {
          message: 'must be rolled back',
          previousConversation: [
            { role: 'user', content: 'imported question' },
            { role: 'assistant', content: 'imported answer' },
          ],
        }) as never,
        new AbortController().signal,
      ),
    ).rejects.toThrow('stream-setup-failure')

    expect(sessionStore.get(conversationId)?.agent.messages).toEqual([
      {
        id: expect.any(String),
        role: 'user',
        parts: [{ type: 'text', text: 'imported question' }],
      },
      {
        id: expect.any(String),
        role: 'assistant',
        parts: [{ type: 'text', text: 'imported answer' }],
      },
    ])
  })

  it('streams and persists zero-tool completion prose unchanged', async () => {
    resetHarness()
    const sessionStore = createSessionStore()
    const service = createService(sessionStore)
    const conversationId = crypto.randomUUID()
    const assistantMessage: MockMessage = {
      id: 'assistant-prose',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Exact observe-only prose.' }],
    }
    harnessState.streamResponseHandler = async (options) => {
      await finishStream(options, [
        ...(options.uiMessages ?? []),
        assistantMessage,
      ])
      return new Response('Exact observe-only prose.')
    }

    const response = await service.processMessage(
      createRequest(conversationId, { message: 'answer in prose' }) as never,
      new AbortController().signal,
    )

    expect(await response.text()).toBe('Exact observe-only prose.')
    expect(sessionStore.get(conversationId)?.agent.messages.at(-1)).toEqual(
      assistantMessage,
    )
    expect(sessionStore.finishCalls.at(-1)?.outcome).toEqual({
      status: 'succeeded',
    })
  })
})
