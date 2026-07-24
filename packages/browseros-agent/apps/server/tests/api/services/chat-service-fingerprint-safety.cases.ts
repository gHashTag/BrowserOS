import { describe, expect, it } from 'bun:test'
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
  loggerInfoSpy,
  loggerWarnSpy,
  type MockMessage,
  streamAndPersist,
} from './chat-service-test-harness'

describe('ChatService execution fingerprint session lifecycle', () => {
  it('coalesces simultaneous model, MCP, workspace, and approval changes into one rebuild', async () => {
    const oldSecret = 'old-secret-sentinel'
    const newSecret = 'new-secret-sentinel'
    const oldUrl = 'https://old-secret-mcp.example.test/sse'
    const newUrl = 'https://new-secret-mcp.example.test/sse'
    const oldWorkspace = '/workspace/old-secret-path'
    const newWorkspace = '/workspace/new-secret-path'
    const oldBaseUrl = 'https://old-private-provider.example.test/v1'
    const newBaseUrl = 'https://new-private-provider.example.test/v1'
    const oldSecretAccessKey = 'old-secret-access-key-sentinel'
    const newSecretAccessKey = 'new-secret-access-key-sentinel'
    const oldSessionToken = 'old-session-token-sentinel'
    const newSessionToken = 'new-session-token-sentinel'
    harnessState.resolvedLlmConfig = {
      ...defaultLlmConfig,
      apiKey: oldSecret,
      baseUrl: oldBaseUrl,
      secretAccessKey: oldSecretAccessKey,
      sessionToken: oldSessionToken,
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
      klavisRef: { handle: {} } as never,
      browser: browser as never,
      registry: emptyRegistry as never,
    })
    const createCallsBefore = createAgentSpy.mock.calls.length
    const logCallsBefore = loggerInfoSpy.mock.calls.length
    const warnCallsBefore = loggerWarnSpy.mock.calls.length
    const conversationId = crypto.randomUUID()
    const firstRequest = createRequest(conversationId, {
      userWorkingDir: oldWorkspace,
      toolApprovalConfig: {
        categories: { filesystem: true, browser: false },
      },
      browserContext: {
        activeTab: {
          id: 3,
          url: 'https://example.com',
          title: 'Example',
        },
        enabledMcpServers: ['slack'],
        customMcpServers: [{ name: 'old-private', url: oldUrl }],
      },
    })

    await service.processMessage(
      firstRequest as never,
      new AbortController().signal,
    )

    const secondTurnEventIndex = harnessState.lifecycleEvents.length
    harnessState.resolvedLlmConfig = {
      ...harnessState.resolvedLlmConfig,
      model: 'gpt-5.1',
      apiKey: newSecret,
      baseUrl: newBaseUrl,
      secretAccessKey: newSecretAccessKey,
      sessionToken: newSessionToken,
    }
    harnessState.agentToReturn = secondAgent
    await service.processMessage(
      {
        ...firstRequest,
        message: 'apply every new setting',
        userWorkingDir: newWorkspace,
        toolApprovalConfig: {
          categories: { browser: true, filesystem: false },
        },
        browserContext: {
          activeTab: {
            id: 3,
            url: 'https://example.com',
            title: 'Example',
          },
          enabledMcpServers: ['github'],
          customMcpServers: [{ name: 'new-private', url: newUrl }],
        },
      } as never,
      new AbortController().signal,
    )

    expect(createAgentSpy.mock.calls.length - createCallsBefore).toBe(2)
    expect(firstAgent.dispose).toHaveBeenCalledTimes(1)
    expect(secondAgent.dispose).not.toHaveBeenCalled()
    expect(harnessState.lifecycleEvents.slice(secondTurnEventIndex)).toEqual([
      'create',
      'swap',
      'dispose',
      'stream',
    ])

    const infoLogs = loggerInfoSpy.mock.calls.slice(logCallsBefore)
    const serializedLogs = JSON.stringify([
      ...infoLogs,
      ...loggerWarnSpy.mock.calls.slice(warnCallsBefore),
    ])
    for (const sensitiveValue of [
      oldSecret,
      newSecret,
      oldUrl,
      newUrl,
      oldWorkspace,
      newWorkspace,
      oldBaseUrl,
      newBaseUrl,
      oldSecretAccessKey,
      newSecretAccessKey,
      oldSessionToken,
      newSessionToken,
    ]) {
      expect(serializedLogs).not.toContain(sensitiveValue)
    }

    const rebuildDetails = infoLogs
      .map(([, details]) => details)
      .find(
        (details) =>
          typeof details === 'object' &&
          details !== null &&
          'changedCategories' in details,
      ) as Record<string, unknown> | undefined
    expect(rebuildDetails).toBeDefined()
    expect(Object.keys(rebuildDetails ?? {}).sort()).toEqual([
      'changedCategories',
      'conversationId',
      'currentFingerprint',
      'previousFingerprint',
    ])
    expect(rebuildDetails).toEqual({
      conversationId,
      previousFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      currentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      changedCategories: ['approval', 'execution-config', 'mcp', 'workspace'],
    })
  })

  it('treats managed apps and enabled approval keys as order-independent sets', async () => {
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    let latestPromptMessages: MockMessage[] = []
    harnessState.streamResponseHandler = async ({ onFinish, uiMessages }) => {
      latestPromptMessages = uiMessages ?? []
      await onFinish({ messages: latestPromptMessages })
      return new Response('ok')
    }

    const agent = createFakeAgent()
    harnessState.agentToReturn = agent
    const browser = createBrowser()
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: {} } as never,
      browser: browser as never,
      registry: emptyRegistry as never,
    })
    const createCallsBefore = createAgentSpy.mock.calls.length
    const conversationId = crypto.randomUUID()
    const firstRequest = createRequest(conversationId, {
      toolApprovalConfig: {
        categories: { filesystem: true, browser: true, memory: false },
      },
      browserContext: {
        activeTab: {
          id: 3,
          url: 'https://example.com',
          title: 'Example',
        },
        enabledMcpServers: ['slack', 'github', 'slack'],
      },
    })

    await service.processMessage(
      firstRequest as never,
      new AbortController().signal,
    )
    await service.processMessage(
      {
        ...firstRequest,
        message: 'same effective settings',
        toolApprovalConfig: {
          categories: { browser: true, memory: false, filesystem: true },
        },
        browserContext: {
          activeTab: {
            id: 3,
            url: 'https://example.com',
            title: 'Example',
          },
          enabledMcpServers: ['github', 'slack'],
        },
      } as never,
      new AbortController().signal,
    )

    expect(createAgentSpy.mock.calls.length - createCallsBefore).toBe(1)
    expect(agent.dispose).not.toHaveBeenCalled()
    expect(latestPromptMessages.at(-1)?.parts[0]?.text).not.toContain(
      '[Context:',
    )
  })

  it('preserves compatible history and removes unavailable tool parts during rebuild', async () => {
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.lifecycleEvents = []
    streamAndPersist()

    const firstAgent = createFakeAgent(new Set(['keep_tool', 'old_tool']))
    const secondAgent = createFakeAgent(new Set(['keep_tool']))
    harnessState.agentToReturn = firstAgent
    const browser = createBrowser()
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
    firstAgent.messages.push(
      {
        id: 'assistant-mixed',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Useful explanation' },
          { type: 'tool-old_tool', toolCallId: 'old-call' },
          { type: 'tool-keep_tool', toolCallId: 'keep-call' },
        ],
      },
      {
        id: 'assistant-obsolete-only',
        role: 'assistant',
        parts: [{ type: 'tool-old_tool', toolCallId: 'obsolete-call' }],
      },
    )

    harnessState.resolvedLlmConfig = {
      ...harnessState.resolvedLlmConfig,
      model: 'gpt-5.1',
    }
    harnessState.agentToReturn = secondAgent
    await service.processMessage(
      { ...request, message: 'continue safely' } as never,
      new AbortController().signal,
    )

    expect(
      secondAgent.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.parts[0]?.text),
    ).toEqual(['first turn', 'continue safely'])
    expect(
      secondAgent.messages.find((message) => message.id === 'assistant-mixed')
        ?.parts,
    ).toEqual([
      { type: 'text', text: 'Useful explanation' },
      { type: 'tool-keep_tool', toolCallId: 'keep-call' },
    ])
    expect(
      secondAgent.messages.some(
        (message) => message.id === 'assistant-obsolete-only',
      ),
    ).toBe(false)
  })
})
