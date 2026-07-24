import { describe, expect, it, mock } from 'bun:test'
import {
  ChatService,
  createBrowser,
  createFakeAgent,
  createRequest,
  createSessionStore,
  defaultLlmConfig,
  emptyRegistry,
  harnessState,
  loggerInfoSpy,
  loggerWarnSpy,
  type MockMessage,
  type StoredSession,
} from './chat-service-test-harness'

function retainSessionAfterStream(): void {
  harnessState.streamResponseHandler = async () => {
    harnessState.lifecycleEvents?.push('stream')
    return new Response('ok')
  }
}

function resetReplacementFailures(): void {
  harnessState.createAgentError = undefined
  harnessState.replaceSessionError = undefined
  harnessState.replaceSessionResult = undefined
  harnessState.replaceSessionConflict = undefined
}

function snapshotMessages(messages: MockMessage[]): MockMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => ({ ...part })),
  }))
}

describe('ChatService atomic fingerprint publication', () => {
  it('disposes the candidate and preserves the winning session after a CAS conflict', async () => {
    resetReplacementFailures()
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    retainSessionAfterStream()

    const firstAgent = createFakeAgent()
    const replacementAgent = createFakeAgent()
    const winnerAgent = createFakeAgent()
    harnessState.agentToReturn = firstAgent
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: createBrowser() as never,
      registry: emptyRegistry as never,
    })
    const conversationId = crypto.randomUUID()
    const request = createRequest(conversationId)

    await service.processMessage(request as never, new AbortController().signal)
    const winnerSession: StoredSession = {
      agent: winnerAgent,
      executionFingerprint: 'winner-fingerprint',
    }
    harnessState.resolvedLlmConfig = {
      ...harnessState.resolvedLlmConfig,
      model: 'gpt-5.1',
    }
    harnessState.agentToReturn = replacementAgent
    harnessState.replaceSessionConflict = winnerSession

    try {
      await expect(
        service.processMessage(
          { ...request, message: 'publish replacement' } as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow('Session changed while rebuilding')
    } finally {
      harnessState.replaceSessionConflict = undefined
    }

    expect(sessionStore.get(conversationId)).toBe(winnerSession)
    expect(replacementAgent.dispose).toHaveBeenCalledTimes(1)
    expect(firstAgent.dispose).not.toHaveBeenCalled()
    expect(winnerAgent.dispose).not.toHaveBeenCalled()
    expect(
      harnessState.lifecycleEvents?.filter((event) => event === 'stream'),
    ).toHaveLength(1)
  })

  it('disposes the candidate and preserves the old session when CAS throws', async () => {
    resetReplacementFailures()
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    retainSessionAfterStream()

    const firstAgent = createFakeAgent()
    const replacementAgent = createFakeAgent()
    harnessState.agentToReturn = firstAgent
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: createBrowser() as never,
      registry: emptyRegistry as never,
    })
    const conversationId = crypto.randomUUID()
    const request = createRequest(conversationId)

    await service.processMessage(request as never, new AbortController().signal)
    const originalSession = sessionStore.get(conversationId)
    const originalMessages = snapshotMessages(firstAgent.messages)
    harnessState.resolvedLlmConfig = {
      ...harnessState.resolvedLlmConfig,
      model: 'gpt-5.1',
    }
    harnessState.agentToReturn = replacementAgent
    harnessState.replaceSessionError = new Error('publish-failure-sentinel')

    try {
      await expect(
        service.processMessage(
          { ...request, message: 'publish replacement' } as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow('publish-failure-sentinel')
    } finally {
      harnessState.replaceSessionError = undefined
    }

    expect(sessionStore.get(conversationId)).toBe(originalSession)
    expect(replacementAgent.dispose).toHaveBeenCalledTimes(1)
    expect(firstAgent.dispose).not.toHaveBeenCalled()
    expect(firstAgent.messages).toEqual(originalMessages)
    expect(
      harnessState.lifecycleEvents?.filter((event) => event === 'stream'),
    ).toHaveLength(1)
  })

  it('keeps the published replacement and streams when old disposal rejects', async () => {
    resetReplacementFailures()
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    retainSessionAfterStream()

    const firstAgent = createFakeAgent()
    firstAgent.dispose = mock(async () => {
      harnessState.lifecycleEvents?.push('dispose')
      throw new Error('old-dispose-secret-sentinel')
    })
    const replacementAgent = createFakeAgent()
    harnessState.agentToReturn = firstAgent
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: createBrowser() as never,
      registry: emptyRegistry as never,
    })
    const conversationId = crypto.randomUUID()
    const request = createRequest(conversationId)

    await service.processMessage(request as never, new AbortController().signal)
    const secondTurnEventIndex = harnessState.lifecycleEvents.length
    const infoCallsBefore = loggerInfoSpy.mock.calls.length
    const warnCallsBefore = loggerWarnSpy.mock.calls.length
    harnessState.resolvedLlmConfig = {
      ...harnessState.resolvedLlmConfig,
      model: 'gpt-5.1',
    }
    harnessState.agentToReturn = replacementAgent

    await service.processMessage(
      { ...request, message: 'continue after cleanup failure' } as never,
      new AbortController().signal,
    )

    expect(sessionStore.get(conversationId)?.agent).toBe(replacementAgent)
    expect(firstAgent.dispose).toHaveBeenCalledTimes(1)
    expect(replacementAgent.dispose).not.toHaveBeenCalled()
    expect(harnessState.lifecycleEvents.slice(secondTurnEventIndex)).toEqual([
      'create',
      'swap',
      'dispose',
      'stream',
    ])
    expect(
      JSON.stringify([
        ...loggerInfoSpy.mock.calls.slice(infoCallsBefore),
        ...loggerWarnSpy.mock.calls.slice(warnCallsBefore),
      ]),
    ).not.toContain('old-dispose-secret-sentinel')
  })

  it('closes a newly created hidden page when CAS declines publication', async () => {
    resetReplacementFailures()
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    retainSessionAfterStream()

    const firstAgent = createFakeAgent()
    const replacementAgent = createFakeAgent()
    harnessState.agentToReturn = firstAgent
    const browser = {
      ...createBrowser(),
      newPage: mock(async () => 81),
      listPages: mock(async () => [{ pageId: 81, windowId: 14 }]),
    }
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: browser as never,
      registry: emptyRegistry as never,
    })
    const conversationId = crypto.randomUUID()
    const request = createRequest(conversationId)

    await service.processMessage(request as never, new AbortController().signal)
    const originalSession = sessionStore.get(conversationId)
    const originalMessages = snapshotMessages(firstAgent.messages)
    harnessState.agentToReturn = replacementAgent
    harnessState.replaceSessionResult = false

    try {
      await expect(
        service.processMessage(
          {
            ...request,
            message: 'continue in background',
            isScheduledTask: true,
          } as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow('Session changed while rebuilding')
    } finally {
      harnessState.replaceSessionResult = undefined
    }

    expect(browser.closePage).toHaveBeenCalledTimes(1)
    expect(browser.closePage).toHaveBeenCalledWith(81)
    expect(sessionStore.get(conversationId)).toBe(originalSession)
    expect(replacementAgent.dispose).toHaveBeenCalledTimes(1)
    expect(firstAgent.dispose).not.toHaveBeenCalled()
    expect(firstAgent.messages).toEqual(originalMessages)
    expect(
      harnessState.lifecycleEvents?.filter((event) => event === 'stream'),
    ).toHaveLength(1)
  })
})
