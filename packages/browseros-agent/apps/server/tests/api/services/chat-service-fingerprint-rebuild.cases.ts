import { describe, expect, it, mock } from 'bun:test'
import {
  ChatService,
  createAgentSpy,
  createBrowser,
  createFakeAgent,
  createRequest,
  createSessionStore,
  defaultLlmConfig,
  emptyRegistry,
  harnessState,
  streamAndPersist,
} from './chat-service-test-harness'

describe('ChatService execution fingerprint session lifecycle', () => {
  it('disposes and recreates the agent before streaming when only the model changes', async () => {
    harnessState.resolvedLlmConfig = {
      ...defaultLlmConfig,
      apiKey: 'stable-model-test-secret',
    }
    harnessState.lifecycleEvents = []
    streamAndPersist()

    const firstAgent = createFakeAgent()
    const secondAgent = createFakeAgent()
    harnessState.agentToReturn = firstAgent
    const browser = createBrowser()
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: browser as never,
      registry: emptyRegistry as never,
    })
    const createCallsBefore = createAgentSpy.mock.calls.length
    const conversationId = crypto.randomUUID()
    const request = createRequest(conversationId)

    await service.processMessage(request as never, new AbortController().signal)

    const secondTurnEventIndex = harnessState.lifecycleEvents.length
    harnessState.resolvedLlmConfig = {
      ...harnessState.resolvedLlmConfig,
      model: 'gpt-5.1',
    }
    harnessState.agentToReturn = secondAgent
    await service.processMessage(
      { ...request, message: 'use the new model' } as never,
      new AbortController().signal,
    )

    expect(createAgentSpy.mock.calls.length - createCallsBefore).toBe(2)
    expect(firstAgent.dispose).toHaveBeenCalledTimes(1)
    expect(harnessState.lifecycleEvents.slice(secondTurnEventIndex)).toEqual([
      'create',
      'dispose',
      'swap',
      'stream',
    ])
  })

  it('disposes and recreates the agent before streaming when only credentials change', async () => {
    harnessState.resolvedLlmConfig = {
      ...defaultLlmConfig,
      apiKey: 'old-credential-sentinel',
    }
    harnessState.lifecycleEvents = []
    streamAndPersist()

    const firstAgent = createFakeAgent()
    const secondAgent = createFakeAgent()
    harnessState.agentToReturn = firstAgent
    const browser = createBrowser()
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: browser as never,
      registry: emptyRegistry as never,
    })
    const createCallsBefore = createAgentSpy.mock.calls.length
    const conversationId = crypto.randomUUID()
    const request = createRequest(conversationId)

    await service.processMessage(request as never, new AbortController().signal)

    const secondTurnEventIndex = harnessState.lifecycleEvents.length
    harnessState.resolvedLlmConfig = {
      ...harnessState.resolvedLlmConfig,
      apiKey: 'new-credential-sentinel',
    }
    harnessState.agentToReturn = secondAgent
    await service.processMessage(
      { ...request, message: 'use rotated credentials' } as never,
      new AbortController().signal,
    )

    expect(createAgentSpy.mock.calls.length - createCallsBefore).toBe(2)
    expect(firstAgent.dispose).toHaveBeenCalledTimes(1)
    expect(harnessState.lifecycleEvents.slice(secondTurnEventIndex)).toEqual([
      'create',
      'dispose',
      'swap',
      'stream',
    ])
  })

  it('keeps the original scheduled session intact when replacement creation fails', async () => {
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    let streamCalls = 0
    harnessState.streamResponseHandler = async () => {
      streamCalls += 1
      harnessState.lifecycleEvents?.push('stream')
      return new Response('ok')
    }

    const firstAgent = createFakeAgent()
    harnessState.agentToReturn = firstAgent
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
      registry: emptyRegistry as never,
    })
    const conversationId = crypto.randomUUID()
    const request = createRequest(conversationId, {
      isScheduledTask: true,
    })

    await service.processMessage(request as never, new AbortController().signal)
    const originalSession = sessionStore.get(conversationId)
    const originalMessages = structuredClone(firstAgent.messages)
    expect(originalSession?.hiddenPageId).toBe(77)

    harnessState.resolvedLlmConfig = {
      ...harnessState.resolvedLlmConfig,
      model: 'gpt-5.1',
    }
    harnessState.createAgentError = new Error('replacement creation failed')
    try {
      await expect(
        service.processMessage(
          { ...request, message: 'retry with new model' } as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow('replacement creation failed')
    } finally {
      harnessState.createAgentError = undefined
    }

    expect(sessionStore.get(conversationId)).toBe(originalSession)
    expect(sessionStore.get(conversationId)?.hiddenPageId).toBe(77)
    expect(firstAgent.messages).toEqual(originalMessages)
    expect(firstAgent.dispose).not.toHaveBeenCalled()
    expect(browser.closePage).not.toHaveBeenCalled()
    expect(streamCalls).toBe(1)
  })
})
