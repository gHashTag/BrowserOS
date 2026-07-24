import { describe, expect, it, mock } from 'bun:test'
import {
  ChatService,
  createBrowser,
  createFakeAgent,
  createRequest,
  createSessionStore,
  defaultLlmConfig,
  emptyRegistry,
  finishStream,
  harnessState,
  requireStream,
  type StreamResponseOptions,
} from './chat-service-test-harness'

function approvalPart(approvalId: string) {
  return {
    type: 'dynamic-tool',
    toolCallId: `call-${approvalId}`,
    toolName: 'filesystem_write',
    state: 'approval-requested',
    input: { path: approvalId },
    approval: { id: approvalId },
  }
}

describe('ChatService approval callback ownership', () => {
  it('ignores a late original finish after approval continuation resumes', async () => {
    harnessState.agentToReturn = createFakeAgent()
    harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
    harnessState.createAgentError = undefined
    harnessState.replaceSessionError = undefined
    harnessState.replaceSessionResult = undefined
    harnessState.replaceSessionConflict = undefined
    const streams: StreamResponseOptions[] = []
    harnessState.streamResponseHandler = async (options) => {
      streams.push(options)
      return new Response('held-open')
    }
    const browser = {
      ...createBrowser(),
      newPage: mock(async () => 95),
      listPages: mock(async () => [{ pageId: 95, windowId: 19 }]),
    }
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: browser as never,
      registry: emptyRegistry as never,
    })
    const conversationId = crypto.randomUUID()

    await service.processMessage(
      createRequest(conversationId, {
        message: 'request approved work',
        isScheduledTask: true,
      }) as never,
      new AbortController().signal,
    )
    const originalStream = requireStream(streams[0])
    const originalMessages = [
      ...(originalStream.uiMessages ?? []),
      {
        id: 'assistant-approval',
        role: 'assistant' as const,
        parts: [approvalPart('approval-a'), approvalPart('approval-b')],
      },
    ]
    await finishStream(originalStream, originalMessages)
    const lateOriginalMessages = structuredClone(originalMessages)
    const retainedSink = harnessState.agentToReturn?.evidenceSink

    await service.processMessage(
      createRequest(conversationId, {
        isScheduledTask: true,
        toolApprovalResponses: [
          { approvalId: 'approval-a', approved: true },
          { approvalId: 'approval-b', approved: true },
        ],
      }) as never,
      new AbortController().signal,
    )
    const resumedStream = requireStream(streams[1])
    const resumedRun = sessionStore.getActiveRun(conversationId)
    const resumedMessages = harnessState.agentToReturn?.messages
    expect(resumedRun?.waitingFor).toBeUndefined()

    await finishStream(originalStream, lateOriginalMessages)

    expect(sessionStore.getActiveRun(conversationId)).toBe(resumedRun)
    expect(
      sessionStore.getActiveRun(conversationId)?.waitingFor,
    ).toBeUndefined()
    expect(harnessState.agentToReturn?.messages).toBe(resumedMessages)
    expect(harnessState.agentToReturn?.evidenceSink).toBe(retainedSink)
    expect(sessionStore.get(conversationId)?.hiddenPageId).toBe(95)
    expect(sessionStore.finishCalls).toHaveLength(0)
    expect(browser.closePage).not.toHaveBeenCalled()

    await finishStream(resumedStream, [
      ...(resumedStream.uiMessages ?? []),
      {
        id: 'assistant-complete',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Approved work completed.' }],
      },
    ])
    expect(sessionStore.getActiveRun(conversationId)).toBeUndefined()
    expect(harnessState.agentToReturn?.evidenceSink).toBeUndefined()
    expect(sessionStore.get(conversationId)?.hiddenPageId).toBeUndefined()
    expect(browser.closePage).toHaveBeenCalledTimes(1)
    expect(browser.closePage).toHaveBeenCalledWith(95)
  })
})
