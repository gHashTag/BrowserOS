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
  type MockMessage,
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

describe('ChatService scheduled-mode fingerprint transitions', () => {
  it('moves an ordinary session onto one newly created hidden page', async () => {
    resetReplacementFailures()
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    retainSessionAfterStream()

    const firstAgent = createFakeAgent()
    const secondAgent = createFakeAgent()
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
    const createCallsBefore = createAgentSpy.mock.calls.length
    const conversationId = crypto.randomUUID()
    const ordinaryRequest = createRequest(conversationId, {
      browserContext: {
        activeTab: {
          id: 3,
          url: 'https://example.com',
          title: 'Example',
        },
        enabledMcpServers: ['slack'],
      },
    })

    await service.processMessage(
      ordinaryRequest as never,
      new AbortController().signal,
    )

    harnessState.agentToReturn = secondAgent
    await service.processMessage(
      {
        ...ordinaryRequest,
        message: 'continue in the background',
        isScheduledTask: true,
        browserContext: {
          ...ordinaryRequest.browserContext,
          enabledMcpServers: ['github'],
        },
      } as never,
      new AbortController().signal,
    )

    const createdConfigs = createAgentSpy.mock.calls
      .slice(createCallsBefore)
      .map(
        ([config]) =>
          config as {
            browserContext?: {
              activeTab?: { id: number; pageId?: number }
              enabledMcpServers?: string[]
            }
          },
      )
    expect(browser.newPage).toHaveBeenCalledTimes(1)
    expect(browser.listPages).toHaveBeenCalledTimes(1)
    expect(createdConfigs).toHaveLength(2)
    expect(createdConfigs[1]?.browserContext).toEqual(
      expect.objectContaining({
        activeTab: expect.objectContaining({ id: 77, pageId: 77 }),
        enabledMcpServers: ['github'],
      }),
    )
    expect(sessionStore.get(conversationId)).toEqual(
      expect.objectContaining({
        agent: secondAgent,
        hiddenPageId: 77,
        browserContext: expect.objectContaining({
          activeTab: expect.objectContaining({ id: 77, pageId: 77 }),
        }),
      }),
    )
    expect(browser.closePage).not.toHaveBeenCalled()
  })

  it('moves a scheduled session back to visible context and closes its old hidden page once', async () => {
    resetReplacementFailures()
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    retainSessionAfterStream()

    const firstAgent = createFakeAgent()
    const secondAgent = createFakeAgent()
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
    const createCallsBefore = createAgentSpy.mock.calls.length
    const conversationId = crypto.randomUUID()
    const scheduledRequest = createRequest(conversationId, {
      isScheduledTask: true,
    })

    await service.processMessage(
      scheduledRequest as never,
      new AbortController().signal,
    )

    harnessState.agentToReturn = secondAgent
    await service.processMessage(
      {
        ...scheduledRequest,
        message: 'continue in the visible tab',
        isScheduledTask: false,
        browserContext: {
          activeTab: {
            id: 9,
            url: 'https://visible.example.test',
            title: 'Visible',
          },
        },
      } as never,
      new AbortController().signal,
    )

    const createdConfigs = createAgentSpy.mock.calls
      .slice(createCallsBefore)
      .map(
        ([config]) =>
          config as {
            browserContext?: { activeTab?: { id: number; pageId?: number } }
          },
      )
    expect(createdConfigs).toHaveLength(2)
    expect(createdConfigs[1]?.browserContext?.activeTab).toEqual(
      expect.objectContaining({ id: 9, pageId: 109 }),
    )
    expect(sessionStore.get(conversationId)).toEqual(
      expect.objectContaining({
        agent: secondAgent,
        hiddenPageId: undefined,
        browserContext: expect.objectContaining({
          activeTab: expect.objectContaining({ id: 9, pageId: 109 }),
        }),
      }),
    )
    expect(browser.closePage).toHaveBeenCalledTimes(1)
    expect(browser.closePage).toHaveBeenCalledWith(77)
  })

  it('keeps the ordinary session and closes the new hidden page when replacement creation fails', async () => {
    resetReplacementFailures()
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    retainSessionAfterStream()

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
    const request = createRequest(conversationId)

    await service.processMessage(request as never, new AbortController().signal)
    const originalSession = sessionStore.get(conversationId)
    const originalMessages = snapshotMessages(firstAgent.messages)
    harnessState.createAgentError = new Error('transition-create-failure')

    try {
      await expect(
        service.processMessage(
          {
            ...request,
            message: 'run in background',
            isScheduledTask: true,
          } as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow('transition-create-failure')
    } finally {
      harnessState.createAgentError = undefined
    }

    expect(browser.newPage).toHaveBeenCalledTimes(1)
    expect(browser.closePage).toHaveBeenCalledTimes(1)
    expect(browser.closePage).toHaveBeenCalledWith(77)
    expect(sessionStore.get(conversationId)).toBe(originalSession)
    expect(firstAgent.dispose).not.toHaveBeenCalled()
    expect(firstAgent.messages).toEqual(originalMessages)
    expect(
      harnessState.lifecycleEvents?.filter((event) => event === 'stream'),
    ).toHaveLength(1)
  })

  it('keeps the ordinary session and closes the new hidden page when history sanitizing fails', async () => {
    resetReplacementFailures()
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    retainSessionAfterStream()

    const firstAgent = createFakeAgent(new Set(['old_tool']))
    const hostileToolNames = {
      has: mock(() => {
        throw new Error('transition-sanitize-failure')
      }),
    } as unknown as Set<string>
    const replacementAgent = createFakeAgent(hostileToolNames)
    harnessState.agentToReturn = firstAgent
    const browser = {
      ...createBrowser(),
      newPage: mock(async () => 78),
      listPages: mock(async () => [{ pageId: 78, windowId: 12 }]),
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
    firstAgent.messages.push({
      id: 'assistant-old-tool',
      role: 'assistant',
      parts: [{ type: 'tool-old_tool', toolCallId: 'old-call' }],
    })
    const originalSession = sessionStore.get(conversationId)
    const originalMessages = snapshotMessages(firstAgent.messages)
    harnessState.agentToReturn = replacementAgent

    await expect(
      service.processMessage(
        {
          ...request,
          message: 'run in background',
          isScheduledTask: true,
        } as never,
        new AbortController().signal,
      ),
    ).rejects.toThrow('transition-sanitize-failure')

    expect(browser.closePage).toHaveBeenCalledTimes(1)
    expect(browser.closePage).toHaveBeenCalledWith(78)
    expect(replacementAgent.dispose).toHaveBeenCalledTimes(1)
    expect(sessionStore.get(conversationId)).toBe(originalSession)
    expect(firstAgent.dispose).not.toHaveBeenCalled()
    expect(firstAgent.messages).toEqual(originalMessages)
    expect(
      harnessState.lifecycleEvents?.filter((event) => event === 'stream'),
    ).toHaveLength(1)
  })

  it('keeps a failed scheduled-to-visible transition on its tracked hidden page', async () => {
    resetReplacementFailures()
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    retainSessionAfterStream()

    const firstAgent = createFakeAgent()
    harnessState.agentToReturn = firstAgent
    const browser = {
      ...createBrowser(),
      newPage: mock(async () => 79),
      listPages: mock(async () => [{ pageId: 79, windowId: 13 }]),
    }
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: browser as never,
      registry: emptyRegistry as never,
    })
    const conversationId = crypto.randomUUID()
    const request = createRequest(conversationId, { isScheduledTask: true })

    await service.processMessage(request as never, new AbortController().signal)
    const originalSession = sessionStore.get(conversationId)
    const originalMessages = snapshotMessages(firstAgent.messages)
    harnessState.createAgentError = new Error('reverse-create-failure')

    try {
      await expect(
        service.processMessage(
          {
            ...request,
            message: 'return to visible mode',
            isScheduledTask: false,
          } as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow('reverse-create-failure')
    } finally {
      harnessState.createAgentError = undefined
    }

    expect(sessionStore.get(conversationId)).toBe(originalSession)
    expect(sessionStore.get(conversationId)?.hiddenPageId).toBe(79)
    expect(browser.closePage).not.toHaveBeenCalled()
    expect(firstAgent.dispose).not.toHaveBeenCalled()
    expect(firstAgent.messages).toEqual(originalMessages)
    expect(
      harnessState.lifecycleEvents?.filter((event) => event === 'stream'),
    ).toHaveLength(1)
  })
})
