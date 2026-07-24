import { describe, expect, it, mock } from 'bun:test'
import {
  ChatService,
  createBrowser,
  createFakeAgent,
  createRequest,
  createSessionStore,
  defaultLlmConfig,
  emptyRegistry,
  finishFirstStreamAndRetainFollowing,
  harnessState,
  loggerInfoSpy,
} from './chat-service-test-harness'

function resetHarness(): void {
  harnessState.createAgentError = undefined
  harnessState.replaceSessionError = undefined
  harnessState.replaceSessionResult = undefined
  harnessState.replaceSessionConflict = undefined
  harnessState.resolvedLlmConfig = { ...defaultLlmConfig }
  harnessState.lifecycleEvents = []
  loggerInfoSpy.mockImplementation(() => {})
}

describe('ChatService lifecycle observability isolation', () => {
  it('completes an ordinary-to-scheduled rebuild when its lifecycle info log throws', async () => {
    resetHarness()
    finishFirstStreamAndRetainFollowing()

    const firstAgent = createFakeAgent()
    const secondAgent = createFakeAgent()
    harnessState.agentToReturn = firstAgent
    const browser = {
      ...createBrowser(),
      newPage: mock(async () => 82),
      listPages: mock(async () => [{ pageId: 82, windowId: 16 }]),
    }
    const sessionStore = createSessionStore()
    const service = new ChatService({
      sessionStore: sessionStore as never,
      klavisRef: { handle: null },
      browser: browser as never,
      registry: emptyRegistry as never,
    })
    const conversationId = crypto.randomUUID()
    const ordinaryRequest = createRequest(conversationId)

    await service.processMessage(
      ordinaryRequest as never,
      new AbortController().signal,
    )

    harnessState.agentToReturn = secondAgent
    loggerInfoSpy.mockImplementation((message) => {
      if (
        message ===
        'Execution fingerprint changed mid-conversation, rebuilding session'
      ) {
        throw new Error('rebuild-info-failure')
      }
    })
    let transitionOutcome: unknown
    try {
      transitionOutcome = await service.processMessage(
        {
          ...ordinaryRequest,
          message: 'continue in the background',
          isScheduledTask: true,
        } as never,
        new AbortController().signal,
      )
    } catch (error) {
      transitionOutcome = error
    } finally {
      loggerInfoSpy.mockImplementation(() => {})
    }

    expect([
      transitionOutcome instanceof Error,
      browser.closePage.mock.calls.length,
    ]).toEqual([false, 0])
    expect(transitionOutcome).toBeInstanceOf(Response)
    expect(sessionStore.get(conversationId)).toEqual(
      expect.objectContaining({
        agent: secondAgent,
        hiddenPageId: 82,
      }),
    )
    expect(firstAgent.dispose).toHaveBeenCalledTimes(1)
    expect(secondAgent.dispose).not.toHaveBeenCalled()
    expect(
      harnessState.lifecycleEvents?.filter((event) => event === 'stream'),
    ).toHaveLength(2)
  })

  it('closes the scheduled hidden page when its completion info log throws', async () => {
    resetHarness()
    const fakeAgent = createFakeAgent()
    harnessState.agentToReturn = fakeAgent
    harnessState.streamResponseHandler = async ({ onFinish, uiMessages }) => {
      await onFinish({ messages: uiMessages ?? fakeAgent.messages })
      return new Response('ok')
    }
    loggerInfoSpy.mockImplementation((message) => {
      if (message === 'Agent execution complete') {
        throw new Error('completion-info-failure')
      }
    })

    const browser = {
      newPage: mock(async () => 93),
      listPages: mock(async () => [{ pageId: 93, windowId: 17 }]),
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
    const conversationId = crypto.randomUUID()
    let completionOutcome: unknown

    try {
      completionOutcome = await service.processMessage(
        {
          conversationId,
          message: 'Finish despite observability failure',
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
    } catch (error) {
      completionOutcome = error
    } finally {
      loggerInfoSpy.mockImplementation(() => {})
    }

    expect([
      completionOutcome instanceof Error,
      browser.closePage.mock.calls.length,
      sessionStore.get(conversationId)?.hiddenPageId,
    ]).toEqual([false, 1, undefined])
    expect(completionOutcome).toBeInstanceOf(Response)
    expect(browser.closePage).toHaveBeenCalledWith(93)
  })
})
