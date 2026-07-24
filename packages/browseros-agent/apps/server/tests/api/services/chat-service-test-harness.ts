import { mock, spyOn } from 'bun:test'
import type { ToolEvidenceSink } from '../../../src/agent/execution-evidence'
import type { EvidenceEvent } from '../../../src/agent/execution-types'
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
  evidenceSink?: ToolEvidenceSink
  appendUserMessage(text: string, id?: string): string
  setEvidenceSink(sink: ToolEvidenceSink | undefined): void
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
  agent: object
  uiMessages?: MockMessage[]
  abortSignal?: AbortSignal
  consumeSseStream?: (options: {
    stream: ReadableStream<string>
  }) => PromiseLike<void> | void
  onFinish(args: {
    messages: MockMessage[]
    isContinuation?: boolean
    isAborted?: boolean
    responseMessage?: MockMessage
    finishReason?:
      | 'stop'
      | 'length'
      | 'content-filter'
      | 'tool-calls'
      | 'error'
      | 'other'
  }): Promise<void>
}

export const harnessState: {
  agentToReturn?: MockAgent
  streamResponseHandler?: (options: StreamResponseOptions) => Promise<Response>
  lifecycleEvents?: string[]
  createAgentError?: Error
  replaceSessionError?: Error
  replaceSessionResult?: boolean
  replaceSessionConflict?: StoredSession
  resolvedLlmConfig: {
    provider: string
    model: string
    apiKey: string
    baseUrl?: string
    secretAccessKey?: string
    sessionToken?: string
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
export const loggerInfoSpy = mock(
  (_message?: string, _details?: Record<string, unknown>) => {},
)
export const loggerWarnSpy = mock(() => {})
export const metricsLogSpy = mock(
  (_eventName?: string, _properties?: Record<string, unknown>) => {},
)
export const emptyRegistry = {
  names: () => [] as string[],
}

export async function consumeStream({
  stream,
}: {
  stream: ReadableStream
}): Promise<void> {
  const reader = stream.getReader()
  try {
    while (!(await reader.read()).done) {
      // Drain so server-side completion does not depend on a client reader.
    }
  } finally {
    reader.releaseLock()
  }
}

mock.module('ai', () => ({
  consumeStream,
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

mock.module('../../../src/lib/metrics', () => ({
  metrics: {
    log: metricsLogSpy,
  },
}))

export const deriveFingerprintSpy = spyOn(
  sessionFingerprintModule,
  'deriveSessionExecutionFingerprint',
)
export const { ChatService } = await import(
  '../../../src/api/services/chat-service'
)
const { SessionStore } = await import('../../../src/agent/session-store')

export function createSessionStore() {
  const store = new SessionStore()
  const finishCalls: Array<{
    conversationId: string
    runId: string
    outcome:
      | { status: 'succeeded' }
      | {
          status: 'failed'
          failureReason:
            | 'denied'
            | 'aborted'
            | 'no-evidence'
            | 'execution-error'
          effectState?: 'none' | 'partial' | 'complete' | 'unknown'
        }
  }> = []

  return {
    finishCalls,
    get(conversationId: string) {
      return store.get(conversationId) as unknown as StoredSession | undefined
    },
    set(conversationId: string, session: StoredSession) {
      harnessState.lifecycleEvents?.push('swap')
      store.set(conversationId, session as never)
    },
    replace(
      conversationId: string,
      expectedSession: StoredSession,
      replacement: StoredSession,
    ) {
      if (harnessState.replaceSessionConflict) {
        store.set(conversationId, harnessState.replaceSessionConflict as never)
      }
      if (harnessState.replaceSessionError) {
        throw harnessState.replaceSessionError
      }
      if (harnessState.replaceSessionResult === false) {
        return false
      }
      const replaced = store.replace(
        conversationId,
        expectedSession as never,
        replacement as never,
      )
      if (replaced) {
        harnessState.lifecycleEvents?.push('swap')
      }
      return replaced
    },
    remove(conversationId: string) {
      return store.remove(conversationId)
    },
    async delete(conversationId: string) {
      return store.delete(conversationId)
    },
    count() {
      return store.count()
    },
    has: store.has.bind(store),
    tryAcquireTurn: store.tryAcquireTurn.bind(store),
    getActiveRun: store.getActiveRun.bind(store),
    suspendTurnForApproval: store.suspendTurnForApproval.bind(store),
    tryResumeApprovalTurn: store.tryResumeApprovalTurn.bind(store),
    finishTurn(
      conversationId: string,
      runId: string,
      outcome:
        | { status: 'succeeded' }
        | {
            status: 'failed'
            failureReason:
              | 'denied'
              | 'aborted'
              | 'no-evidence'
              | 'execution-error'
            effectState?: 'none' | 'partial' | 'complete' | 'unknown'
          },
    ) {
      finishCalls.push({ conversationId, runId, outcome })
      return store.finishTurn(conversationId, runId, outcome)
    },
    recordEvidence(
      conversationId: string,
      runId: string,
      event: EvidenceEvent,
    ) {
      return store.recordEvidence(conversationId, runId, event)
    },
    createEvidenceSink: store.createEvidenceSink.bind(store),
    inner: store,
  }
}

export function createFakeAgent(toolNames = new Set<string>()): MockAgent {
  const messages: MockMessage[] = []
  return {
    toolLoopAgent: {},
    toolNames,
    messages,
    appendUserMessage(text: string, id = crypto.randomUUID()) {
      this.messages.push({
        id,
        role: 'user',
        parts: [{ type: 'text', text }],
      })
      return id
    },
    setEvidenceSink(sink: ToolEvidenceSink | undefined) {
      this.evidenceSink = sink
    },
    updateAclRules: mock(() => {}),
    dispose: mock(async () => {
      harnessState.lifecycleEvents?.push('dispose')
    }),
  }
}

export function finishStream(
  options: StreamResponseOptions,
  messages: MockMessage[],
  overrides: {
    isAborted?: boolean
    finishReason?:
      | 'stop'
      | 'length'
      | 'content-filter'
      | 'tool-calls'
      | 'error'
      | 'other'
  } = {},
): Promise<void> {
  const responseMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant') ?? {
    id: 'assistant-empty',
    role: 'assistant',
    parts: [],
  }
  return options.onFinish({
    messages,
    isContinuation: false,
    isAborted: overrides.isAborted ?? false,
    responseMessage,
    finishReason: overrides.finishReason ?? 'stop',
  })
}

export function requireStream(
  stream: StreamResponseOptions | undefined,
): StreamResponseOptions {
  if (!stream) throw new Error('Expected a captured stream')
  return stream
}

export function evidenceEvent(
  eventId: string,
  toolCallId = eventId,
): EvidenceEvent {
  return {
    eventId,
    toolCallId,
    toolName: 'filesystem_read',
    kind: 'settled',
    effects: ['filesystem-read'],
    retrySafety: 'safe',
    argumentDigest: `argument-${eventId}`,
    argumentDigestFidelity: 'exact',
    recordedAt: 100,
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
  harnessState.streamResponseHandler = async (options) => {
    harnessState.lifecycleEvents?.push('stream')
    await finishStream(options, options.uiMessages ?? [])
    return new Response('ok')
  }
}

export function finishFirstStreamAndRetainFollowing(): void {
  let streamCalls = 0
  harnessState.streamResponseHandler = async (options) => {
    harnessState.lifecycleEvents?.push('stream')
    if (streamCalls === 0) {
      await finishStream(options, options.uiMessages ?? [])
    }
    streamCalls += 1
    return new Response('ok')
  }
}
