import { describe, expect, it, mock } from 'bun:test'
import {
  ChatService,
  createAgentSpy,
  createBrowser,
  createFakeAgent,
  createRequest,
  createSessionStore,
  defaultLlmConfig,
  deriveFingerprintSpy,
  emptyRegistry,
  harnessState,
  streamAndPersist,
} from './chat-service-test-harness'

describe('ChatService execution fingerprint session lifecycle', () => {
  it('reuses the agent when the effective execution fingerprint is unchanged', async () => {
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    streamAndPersist()

    const agent = createFakeAgent()
    harnessState.agentToReturn = agent
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
    await service.processMessage(
      { ...request, message: 'second turn' } as never,
      new AbortController().signal,
    )

    expect(createAgentSpy.mock.calls.length - createCallsBefore).toBe(1)
    expect(agent.dispose).not.toHaveBeenCalled()
    expect(harnessState.lifecycleEvents).toEqual([
      'create',
      'swap',
      'stream',
      'stream',
    ])
    expect(sessionStore.get(conversationId)?.executionFingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    )
  })

  it('resolves one effective browser context per request and shares one config object with fingerprinting and creation', async () => {
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
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
    const deriveCallsBefore = deriveFingerprintSpy.mock.calls.length
    const conversationId = crypto.randomUUID()
    const request = createRequest(conversationId)

    await service.processMessage(request as never, new AbortController().signal)

    harnessState.resolvedLlmConfig = {
      ...harnessState.resolvedLlmConfig,
      model: 'gpt-5.1',
    }
    harnessState.agentToReturn = secondAgent
    await service.processMessage(
      { ...request, message: 'second turn' } as never,
      new AbortController().signal,
    )

    const createdConfigs = createAgentSpy.mock.calls
      .slice(createCallsBefore)
      .map(([config]) => config)
    const fingerprintedConfigs = deriveFingerprintSpy.mock.calls
      .slice(deriveCallsBefore)
      .map(([config]) => config)
    expect(browser.resolveTabIds).toHaveBeenCalledTimes(2)
    expect(fingerprintedConfigs).toHaveLength(2)
    expect(createdConfigs).toHaveLength(2)
    expect(fingerprintedConfigs[0]).toBe(createdConfigs[0])
    expect(fingerprintedConfigs[1]).toBe(createdConfigs[1])
    expect(
      (fingerprintedConfigs[1] as { browserContext?: unknown }).browserContext,
    ).toBe((createdConfigs[1] as { browserContext?: unknown }).browserContext)
  })

  it('hashes and reuses a pre-existing hidden context during a scheduled rebuild', async () => {
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    harnessState.streamResponseHandler = async () => {
      harnessState.lifecycleEvents?.push('stream')
      return new Response('ok')
    }

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
    const deriveCallsBefore = deriveFingerprintSpy.mock.calls.length
    const conversationId = crypto.randomUUID()
    const request = createRequest(conversationId, {
      isScheduledTask: true,
      browserContext: {
        activeTab: {
          id: 3,
          url: 'https://example.com',
          title: 'Example',
        },
        enabledMcpServers: ['slack'],
      },
    })
    // A stored scheduled session is the prerequisite under owned-turn
    // semantics; starting a second request while its stream is open is invalid.
    sessionStore.set(conversationId, {
      agent: firstAgent,
      executionFingerprint: 'existing-scheduled-fingerprint',
      hiddenPageId: 77,
      browserContext: {
        windowId: 11,
        activeTab: {
          id: 77,
          pageId: 77,
          url: 'about:blank',
          title: 'Scheduled Task',
        },
        enabledMcpServers: ['slack'],
      },
      mcpServerKey: 'klavis:pending,slack',
      approvalConfigKey: '',
    })

    harnessState.agentToReturn = secondAgent
    await service.processMessage(
      {
        ...request,
        message: 'scheduled retry',
        browserContext: {
          ...request.browserContext,
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
    const fingerprintedConfigs = deriveFingerprintSpy.mock.calls
      .slice(deriveCallsBefore)
      .map(
        ([config]) =>
          config as {
            browserContext?: {
              activeTab?: { id: number; pageId?: number }
              enabledMcpServers?: string[]
            }
          },
      )
    expect(browser.newPage).not.toHaveBeenCalled()
    expect(browser.resolveTabIds).not.toHaveBeenCalled()
    expect(fingerprintedConfigs).toHaveLength(1)
    expect(createdConfigs).toHaveLength(1)
    expect(fingerprintedConfigs[0]).toBe(createdConfigs[0])
    expect(createdConfigs[0]?.browserContext).toBe(
      fingerprintedConfigs[0]?.browserContext,
    )
    expect(createdConfigs[0]?.browserContext).toEqual(
      expect.objectContaining({
        activeTab: expect.objectContaining({ id: 77, pageId: 77 }),
        enabledMcpServers: ['github'],
      }),
    )
  })

  it('closes a newly created hidden page if initial agent creation fails', async () => {
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    const creationFailure = new Error('initial agent creation failed')
    harnessState.createAgentError = creationFailure

    const browser = {
      ...createBrowser(),
      newPage: mock(async () => 91),
      listPages: mock(async () => [{ pageId: 91, windowId: 12 }]),
    }
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: browser as never,
      registry: emptyRegistry as never,
    })
    const conversationId = crypto.randomUUID()

    try {
      await expect(
        service.processMessage(
          createRequest(conversationId, {
            isScheduledTask: true,
          }) as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow('initial agent creation failed')
    } finally {
      harnessState.createAgentError = undefined
    }

    expect(browser.closePage).toHaveBeenCalledWith(91)
    expect(sessionStore.get(conversationId)).toBeUndefined()
    expect(harnessState.lifecycleEvents).not.toContain('stream')
  })
})
