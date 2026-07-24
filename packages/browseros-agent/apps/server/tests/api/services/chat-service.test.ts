import { describe, expect, it, mock } from 'bun:test'
import {
  ChatService,
  createAgentSpy,
  createFakeAgent,
  createSessionStore,
  emptyRegistry,
  harnessState,
  loggerInfoSpy,
  loggerWarnSpy,
  type MockMessage,
} from './chat-service-test-harness'

describe('ChatService scheduled task hidden page lifecycle', () => {
  it('creates and cleans up a hidden page without creating a hidden window', async () => {
    const fakeAgent = createFakeAgent()
    harnessState.agentToReturn = fakeAgent
    harnessState.streamResponseHandler = async ({ onFinish, uiMessages }) => {
      await onFinish({ messages: uiMessages ?? fakeAgent.messages })
      return new Response('ok')
    }

    const browser = {
      newPage: mock(async () => 0),
      listPages: mock(async () => [
        {
          pageId: 0,
          windowId: 11,
        },
      ]),
      closePage: mock(async () => {}),
      createWindow: mock(async () => ({ windowId: 11 })),
      closeWindow: mock(async () => {}),
      resolveTabIds: mock(async () => new Map<number, number>()),
    }
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: browser as never,
      registry: emptyRegistry as never,
    })

    await service.processMessage(
      {
        conversationId: crypto.randomUUID(),
        message: 'Run the scheduled task',
        isScheduledTask: true,
        mode: 'agent',
        origin: 'sidepanel',
        browserContext: {
          windowId: 9,
          activeTab: {
            id: 3,
            url: 'https://example.com',
            title: 'Example',
          },
          selectedTabs: [{ id: 4 }],
          enabledMcpServers: ['slack'],
        },
      } as never,
      new AbortController().signal,
    )

    expect(browser.newPage).toHaveBeenCalledWith('about:blank', {
      hidden: true,
      background: true,
    })
    expect(browser.createWindow).not.toHaveBeenCalled()
    expect(browser.closePage).toHaveBeenCalledWith(0)
    expect(browser.closeWindow).not.toHaveBeenCalled()

    const createArgs = createAgentSpy.mock.calls.at(-1)?.[0] as {
      browserContext?: {
        windowId?: number
        selectedTabs?: unknown[]
        activeTab?: {
          id: number
          pageId: number
          url: string
          title: string
        }
        enabledMcpServers?: string[]
      }
    }
    expect(createArgs.browserContext?.windowId).toBe(11)
    expect(createArgs.browserContext?.selectedTabs).toBeUndefined()
    expect(createArgs.browserContext?.activeTab).toEqual({
      id: 0,
      pageId: 0,
      url: 'about:blank',
      title: 'Scheduled Task',
    })
    expect(createArgs.browserContext?.enabledMcpServers).toEqual(['slack'])
  })

  it('deleteSession closes the tracked hidden page', async () => {
    const fakeAgent = createFakeAgent()
    const sessionStore = createSessionStore()
    const browser = {
      closePage: mock(async () => {}),
    }
    const conversationId = crypto.randomUUID()

    sessionStore.set(conversationId, {
      agent: fakeAgent,
      executionFingerprint: 'test-session-fingerprint',
      hiddenPageId: 0,
    })

    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: browser as never,
      registry: emptyRegistry as never,
    })

    const result = await service.deleteSession(conversationId)

    expect(result).toEqual({ deleted: true, sessionCount: 0 })
    expect(browser.closePage).toHaveBeenCalledWith(0)
    expect(fakeAgent.dispose).toHaveBeenCalledTimes(1)
  })

  it('keeps the scheduled hidden page context when metadata lookup fails', async () => {
    const fakeAgent = createFakeAgent()
    harnessState.agentToReturn = fakeAgent
    harnessState.streamResponseHandler = async ({ onFinish, uiMessages }) => {
      await onFinish({ messages: uiMessages ?? fakeAgent.messages })
      return new Response('ok')
    }
    loggerWarnSpy.mockImplementationOnce(() => {
      throw new Error('metadata-log-failure')
    })

    const browser = {
      newPage: mock(async () => 88),
      listPages: mock(async () => {
        throw new Error('CDP lookup failed')
      }),
      closePage: mock(async () => {}),
      resolveTabIds: mock(
        async (tabIds: number[]) =>
          new Map(tabIds.map((tabId) => [tabId, tabId + 100])),
      ),
    }
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: browser as never,
      registry: emptyRegistry as never,
    })

    await service.processMessage(
      {
        conversationId: crypto.randomUUID(),
        message: 'Run the scheduled task',
        isScheduledTask: true,
        mode: 'agent',
        origin: 'sidepanel',
        browserContext: {
          activeTab: {
            id: 3,
            url: 'https://example.com',
            title: 'Example',
          },
        },
      } as never,
      new AbortController().signal,
    )

    const createArgs = createAgentSpy.mock.calls.at(-1)?.[0] as {
      browserContext?: {
        windowId?: number
        activeTab?: {
          id: number
          pageId: number
          url: string
          title: string
        }
      }
    }
    expect(createArgs.browserContext?.windowId).toBeUndefined()
    expect(createArgs.browserContext?.activeTab).toEqual({
      id: 88,
      pageId: 88,
      url: 'about:blank',
      title: 'Scheduled Task',
    })
    expect(browser.closePage).toHaveBeenCalledWith(88)
  })

  it('keeps ownership of a hidden page when its creation log throws', async () => {
    const fakeAgent = createFakeAgent()
    harnessState.agentToReturn = fakeAgent
    harnessState.streamResponseHandler = async ({ onFinish, uiMessages }) => {
      await onFinish({ messages: uiMessages ?? fakeAgent.messages })
      return new Response('ok')
    }
    loggerInfoSpy.mockImplementationOnce(() => {
      throw new Error('creation-log-failure')
    })

    const browser = {
      newPage: mock(async () => 92),
      listPages: mock(async () => [{ pageId: 92, windowId: 15 }]),
      closePage: mock(async () => {}),
      resolveTabIds: mock(async () => new Map<number, number>()),
    }
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: browser as never,
      registry: emptyRegistry as never,
    })

    await service.processMessage(
      {
        conversationId: crypto.randomUUID(),
        message: 'Run despite observability failure',
        isScheduledTask: true,
        mode: 'agent',
        origin: 'sidepanel',
        browserContext: {
          activeTab: {
            id: 3,
            url: 'https://example.com',
            title: 'Example',
          },
        },
      } as never,
      new AbortController().signal,
    )

    const createArgs = createAgentSpy.mock.calls.at(-1)?.[0] as {
      browserContext?: {
        activeTab?: { id: number; pageId: number }
      }
    }
    expect(createArgs.browserContext?.activeTab).toEqual(
      expect.objectContaining({ id: 92, pageId: 92 }),
    )
    expect(browser.closePage).toHaveBeenCalledTimes(1)
    expect(browser.closePage).toHaveBeenCalledWith(92)
  })
})

describe('ChatService Klavis session rebuilds', () => {
  it('rebuilds a managed-app session when the shared Klavis handle appears', async () => {
    const firstAgent = createFakeAgent()
    const secondAgent = createFakeAgent()
    harnessState.agentToReturn = firstAgent
    let lastPromptUiMessages: MockMessage[] | undefined
    harnessState.streamResponseHandler = async ({ onFinish, uiMessages }) => {
      lastPromptUiMessages = uiMessages
      await onFinish({ messages: uiMessages ?? [] })
      return new Response('ok')
    }

    const klavisRef = { handle: null as object | null }
    const browser = {
      resolveTabIds: mock(
        async (tabIds: number[]) =>
          new Map(tabIds.map((tabId) => [tabId, tabId + 100])),
      ),
      closePage: mock(async () => {}),
    }
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: klavisRef as never,
      browser: browser as never,
      registry: emptyRegistry as never,
    })
    const createCallsBefore = createAgentSpy.mock.calls.length
    const conversationId = crypto.randomUUID()
    const request = {
      conversationId,
      message: 'check integrations',
      isScheduledTask: false,
      mode: 'agent',
      origin: 'sidepanel',
      browserContext: {
        activeTab: {
          id: 3,
          url: 'https://example.com',
          title: 'Example',
        },
        enabledMcpServers: ['slack'],
      },
    } as never

    await service.processMessage(request, new AbortController().signal)

    harnessState.agentToReturn = secondAgent
    klavisRef.handle = {}

    await service.processMessage(
      { ...request, message: 'check integrations again' },
      new AbortController().signal,
    )

    expect(createAgentSpy.mock.calls.length - createCallsBefore).toBe(2)
    expect(firstAgent.dispose).toHaveBeenCalledTimes(1)

    // Persisted form stays the raw user text — TKT-774. The Klavis
    // context-change notice and the formatted user envelope go only
    // into the transient prompt copy fed to the LLM.
    expect(secondAgent.messages).toHaveLength(2)
    const persistedRebuiltMessage =
      secondAgent.messages[1]?.parts[0]?.text ?? ''
    expect(persistedRebuiltMessage).toBe('check integrations again')

    // Prompt copy (what the agent loop actually saw) carries the
    // context-change prefix so the model knows about the new tools.
    const promptRebuiltMessage =
      lastPromptUiMessages?.at(-1)?.parts[0]?.text ?? ''
    expect(promptRebuiltMessage).toContain(
      'Klavis app integration tools are now available for the following connected apps: slack.',
    )
    expect(promptRebuiltMessage).not.toContain('klavis:pending')
    expect(promptRebuiltMessage).not.toContain('klavis:connected')
  })

  it('does not rebuild a session with no enabled managed apps when Klavis connects', async () => {
    const firstAgent = createFakeAgent()
    const secondAgent = createFakeAgent()
    harnessState.agentToReturn = firstAgent
    harnessState.streamResponseHandler = async ({ onFinish, uiMessages }) => {
      await onFinish({ messages: uiMessages ?? [] })
      return new Response('ok')
    }

    const klavisRef = { handle: null as object | null }
    const browser = {
      resolveTabIds: mock(
        async (tabIds: number[]) =>
          new Map(tabIds.map((tabId) => [tabId, tabId + 200])),
      ),
      closePage: mock(async () => {}),
    }
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: klavisRef as never,
      browser: browser as never,
      registry: emptyRegistry as never,
    })
    const createCallsBefore = createAgentSpy.mock.calls.length
    const conversationId = crypto.randomUUID()
    const request = {
      conversationId,
      message: 'check browser only',
      isScheduledTask: false,
      mode: 'agent',
      origin: 'sidepanel',
      browserContext: {
        activeTab: {
          id: 5,
          url: 'https://example.com',
          title: 'Example',
        },
      },
    } as never

    await service.processMessage(request, new AbortController().signal)

    harnessState.agentToReturn = secondAgent
    klavisRef.handle = {}

    await service.processMessage(
      { ...request, message: 'check browser only again' },
      new AbortController().signal,
    )

    expect(createAgentSpy.mock.calls.length - createCallsBefore).toBe(1)
    expect(firstAgent.dispose).not.toHaveBeenCalled()
    expect(firstAgent.messages).toHaveLength(2)
  })
})

await import('./chat-service-fingerprint-core.cases')
await import('./chat-service-fingerprint-rebuild.cases')
await import('./chat-service-fingerprint-safety.cases')
await import('./chat-service-fingerprint-transitions.cases')
await import('./chat-service-fingerprint-atomicity.cases')
await import('./chat-service-fingerprint-observability.cases')
await import('./chat-service-run-ownership.cases')
await import('./chat-service-run-cleanup.cases')
await import('./chat-service-approval-runs.cases')
