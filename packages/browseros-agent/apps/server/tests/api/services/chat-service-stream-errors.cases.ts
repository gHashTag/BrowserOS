import { beforeEach, describe, expect, it, mock } from 'bun:test'
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

function createFixture() {
  const sessionStore = createSessionStore()
  const service = new ChatService({
    sessionStore: sessionStore as never,
    klavisRef: { handle: null },
    browser: createBrowser() as never,
    registry: { names: () => [] } as never,
  })
  return { service, sessionStore }
}

beforeEach(() => {
  harnessState.agentToReturn = createFakeAgent()
  harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
  harnessState.createAgentError = undefined
  harnessState.replaceSessionError = undefined
  harnessState.replaceSessionResult = undefined
  harnessState.replaceSessionConflict = undefined
  resolveLLMConfigSpy.mockImplementation(async () => ({
    ...harnessState.resolvedLlmConfig,
  }))
})

describe('ChatService stream error truth', () => {
  it('records an onError stream as execution-error and returns only a generic message', async () => {
    const { service, sessionStore } = createFixture()
    const conversationId = crypto.randomUUID()
    let clientError: string | undefined
    harnessState.streamResponseHandler = async (options) => {
      clientError = options.onError?.(
        new Error('provider-secret must never reach the client'),
      )
      await options.onFinish({
        messages: options.uiMessages ?? [],
        isAborted: false,
        finishReason: 'stop',
      })
      return new Response('error-only')
    }

    await service.processMessage(
      createRequest(conversationId) as never,
      new AbortController().signal,
    )

    expect(clientError).toBe('An error occurred.')
    expect(clientError).not.toContain('provider-secret')
    expect(sessionStore.finishCalls.at(-1)?.outcome).toEqual({
      status: 'failed',
      failureReason: 'execution-error',
      effectState: 'none',
    })
  })

  it('records an undefined finish reason as execution-error without an onError callback', async () => {
    const { service, sessionStore } = createFixture()
    const conversationId = crypto.randomUUID()
    harnessState.streamResponseHandler = async (options) => {
      await options.onFinish({
        messages: options.uiMessages ?? [],
        isAborted: false,
      })
      return new Response('missing-finish')
    }

    await service.processMessage(
      createRequest(conversationId) as never,
      new AbortController().signal,
    )

    expect(sessionStore.finishCalls.at(-1)?.outcome).toEqual({
      status: 'failed',
      failureReason: 'execution-error',
      effectState: 'none',
    })
  })

  it('suspends a fresh approval request even when the finish reason is undefined', async () => {
    const { service, sessionStore } = createFixture()
    const conversationId = crypto.randomUUID()
    harnessState.streamResponseHandler = async (options) => {
      await options.onFinish({
        messages: [
          ...(options.uiMessages ?? []),
          {
            id: 'assistant-approval',
            role: 'assistant',
            parts: [
              {
                type: 'dynamic-tool',
                toolCallId: 'call-approval-a',
                toolName: 'filesystem_write',
                state: 'approval-requested',
                input: { path: 'approval-a' },
                approval: { id: 'approval-a' },
              },
            ],
          },
        ],
        isAborted: false,
      })
      return new Response('missing-finish-with-approval')
    }

    await service.processMessage(
      createRequest(conversationId) as never,
      new AbortController().signal,
    )

    expect(sessionStore.getActiveRun(conversationId)?.waitingFor).toEqual({
      kind: 'approval',
      approvalIds: ['approval-a'],
    })
    expect(sessionStore.finishCalls).toHaveLength(0)
  })
})

describe('ChatService approval continuation context reuse', () => {
  it('does not create a hidden page when a visible suspended turn resumes as scheduled', async () => {
    const browser = {
      ...createBrowser(),
      newPage: mock(async () => 88),
      listPages: mock(async () => [{ pageId: 88, windowId: 11 }]),
    }
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: browser as never,
      registry: { names: () => [] } as never,
    })
    const conversationId = crypto.randomUUID()
    const streams: StreamResponseOptions[] = []
    harnessState.streamResponseHandler = async (options) => {
      streams.push(options)
      return new Response('held-open')
    }

    await service.processMessage(
      createRequest(conversationId) as never,
      new AbortController().signal,
    )
    const initialStream = requireStream(streams[0])
    await finishStream(initialStream, [
      ...(initialStream.uiMessages ?? []),
      {
        id: 'assistant-approval',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolCallId: 'call-approval-a',
            toolName: 'filesystem_write',
            state: 'approval-requested',
            input: { path: 'approval-a' },
            approval: { id: 'approval-a' },
          },
        ],
      },
    ])

    await service.processMessage(
      createRequest(conversationId, {
        message: '',
        isScheduledTask: true,
        toolApprovalResponses: [{ approvalId: 'approval-a', approved: true }],
      }) as never,
      new AbortController().signal,
    )

    expect(browser.newPage).not.toHaveBeenCalled()
    expect(streams).toHaveLength(2)
  })
})
