import { mock, spyOn } from 'bun:test'
import * as sessionFingerprintModule from '../../../src/agent/session-fingerprint'

export interface MockMessage {
  id: string
  role: 'user' | 'assistant'
  parts: Array<{
    type: string
    text?: string
    [key: string]: unknown
  }>
}

export interface MockAgent {
  toolLoopAgent: object
  toolNames: Set<string>
  messages: MockMessage[]
  appendUserMessage(text: string): void
  updateAclRules(rules: unknown): void
  dispose(): Promise<void>
}

export interface StoredSession {
  agent: MockAgent
  executionFingerprint: string
  hiddenPageId?: number
  browserContext?: unknown
  mcpServerKey?: string
  workingDir?: string
  approvalConfigKey?: string
}

export interface StreamResponseOptions {
  uiMessages?: MockMessage[]
  onFinish(args: { messages: MockMessage[] }): Promise<void>
}

export const harnessState: {
  agentToReturn?: MockAgent
  streamResponseHandler?: (options: StreamResponseOptions) => Promise<Response>
  lifecycleEvents?: string[]
  createAgentError?: Error
  resolvedLlmConfig: {
    provider: string
    model: string
    apiKey: string
    baseUrl?: string
  }
} = {
  resolvedLlmConfig: {
    provider: 'openai',
    model: 'gpt-5',
    apiKey: 'test-key',
  },
}

export const createAgentSpy = mock(async (config: unknown) => {
  if (harnessState.createAgentError) {
    throw harnessState.createAgentError
  }
  if (!harnessState.agentToReturn) {
    throw new Error(`No mock agent configured for ${JSON.stringify(config)}`)
  }
  harnessState.lifecycleEvents?.push('create')
  return harnessState.agentToReturn
})

export const createAgentUIStreamResponseSpy = mock(
  async (options: StreamResponseOptions) => {
    if (!harnessState.streamResponseHandler) {
      throw new Error('No stream response handler configured')
    }
    return await harnessState.streamResponseHandler(options)
  },
)

export const defaultLlmConfig = {
  provider: 'openai',
  model: 'gpt-5',
  apiKey: 'test-key',
}
export const resolveLLMConfigSpy = mock(async () => ({
  ...harnessState.resolvedLlmConfig,
}))
export const loggerInfoSpy = mock(() => {})
export const loggerWarnSpy = mock(() => {})
export const emptyRegistry = {
  names: () => [] as string[],
}

mock.module('ai', () => ({
  createAgentUIStreamResponse: createAgentUIStreamResponseSpy,
}))

mock.module('../../../src/agent/ai-sdk-agent', () => ({
  AiSdkAgent: {
    create: createAgentSpy,
  },
}))

mock.module('../../../src/lib/clients/llm/config', () => ({
  resolveLLMConfig: resolveLLMConfigSpy,
}))

mock.module('../../../src/lib/logger', () => ({
  logger: {
    info: loggerInfoSpy,
    warn: loggerWarnSpy,
    debug: mock(() => {}),
  },
}))

export const deriveFingerprintSpy = spyOn(
  sessionFingerprintModule,
  'deriveSessionExecutionFingerprint',
)
export const { ChatService } = await import(
  '../../../src/api/services/chat-service'
)

export function createSessionStore() {
  const sessions = new Map<string, StoredSession>()
  return {
    get(conversationId: string) {
      return sessions.get(conversationId)
    },
    set(conversationId: string, session: StoredSession) {
      harnessState.lifecycleEvents?.push('swap')
      sessions.set(conversationId, session)
    },
    remove(conversationId: string) {
      return sessions.delete(conversationId)
    },
    async delete(conversationId: string) {
      const session = sessions.get(conversationId)
      if (!session) return false
      await session.agent.dispose()
      sessions.delete(conversationId)
      return true
    },
    count() {
      return sessions.size
    },
  }
}

export function createFakeAgent(toolNames = new Set<string>()): MockAgent {
  const messages: MockMessage[] = []
  return {
    toolLoopAgent: {},
    toolNames,
    messages,
    appendUserMessage(text: string) {
      this.messages.push({
        id: `user-${this.messages.length + 1}`,
        role: 'user',
        parts: [{ type: 'text', text }],
      })
    },
    updateAclRules: mock(() => {}),
    dispose: mock(async () => {
      harnessState.lifecycleEvents?.push('dispose')
    }),
  }
}

export function createBrowser() {
  return {
    resolveTabIds: mock(
      async (tabIds: number[]) =>
        new Map(tabIds.map((tabId) => [tabId, tabId + 100])),
    ),
    closePage: mock(async () => {}),
  }
}

export function createRequest(
  conversationId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    conversationId,
    message: 'first turn',
    isScheduledTask: false,
    mode: 'agent',
    origin: 'sidepanel',
    browserContext: {
      activeTab: {
        id: 3,
        url: 'https://example.com',
        title: 'Example',
      },
    },
    ...overrides,
  }
}

export function streamAndPersist(): void {
  harnessState.streamResponseHandler = async ({ onFinish, uiMessages }) => {
    harnessState.lifecycleEvents?.push('stream')
    await onFinish({ messages: uiMessages ?? [] })
    return new Response('ok')
  }
}
