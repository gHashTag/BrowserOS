import { afterEach, describe, expect, it } from 'bun:test'
import { RemoteLazyMonitoringJudgeClient } from '../src/monitoring/judge/llm-judge'
import {
  type LazyMonitoringJudgeClient,
  LazyMonitoringJudgeService,
} from '../src/monitoring/judge/service'
import type {
  LazyMonitoringJudgeInput,
  LazyMonitoringJudgment,
} from '../src/monitoring/judge/types'

function buildInput(
  overrides: Partial<LazyMonitoringJudgeInput> = {},
): LazyMonitoringJudgeInput {
  return {
    run: {
      monitoringSessionId: '123e4567-e89b-12d3-a456-426614174111',
      agentId: 'agent-1',
      sessionKey: 'session-1',
      originalPrompt: 'summarize my inbox',
      chatHistory: [{ role: 'user', content: 'summarize my inbox' }],
      startedAt: '2026-04-20T15:59:03.630Z',
      source: 'debug',
    },
    priorToolCalls: [],
    currentToolCall: {
      monitoringSessionId: '123e4567-e89b-12d3-a456-426614174111',
      agentId: 'agent-1',
      toolCallId: 'tool-1',
      toolName: 'get_page_content',
      source: 'browser-tool',
      args: { page: 1 },
      startedAt: '2026-04-20T15:59:03.630Z',
    },
    ...overrides,
  }
}

function buildJudgment(
  input: LazyMonitoringJudgeInput,
  overrides: Partial<LazyMonitoringJudgment> = {},
): LazyMonitoringJudgment {
  return {
    monitoringSessionId: input.run.monitoringSessionId,
    agentId: input.run.agentId,
    toolCallId: input.currentToolCall.toolCallId,
    toolName: input.currentToolCall.toolName,
    verdict: 'safe',
    summary: 'safe',
    destructive: false,
    shouldInterrupt: false,
    mode: 'llm',
    categories: [],
    matchedIntentCategories: [],
    policyDimensions: [],
    policyVersion: 'lazy-monitoring-judge/v1',
    model: 'test-model',
    ...overrides,
  }
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('LazyMonitoringJudgeService', () => {
  it('sends every call to the configured judge client', async () => {
    const calls: LazyMonitoringJudgeInput[] = []
    const client: LazyMonitoringJudgeClient = {
      judge: async (input) => {
        calls.push(input)
        return buildJudgment(input)
      },
    }

    const judgment = await new LazyMonitoringJudgeService(client).evaluate(
      buildInput(),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.currentToolCall.toolName).toBe('get_page_content')
    expect(judgment.mode).toBe('llm')
  })

  it('returns the remote judge result without local rewriting', async () => {
    const client: LazyMonitoringJudgeClient = {
      judge: async (input) =>
        buildJudgment(input, {
          verdict: 'unsafe',
          summary: 'remote result',
          destructive: true,
          shouldInterrupt: true,
          policyDimensions: ['destructive_action', 'scope_mismatch'],
        }),
    }

    const judgment = await new LazyMonitoringJudgeService(client).evaluate(
      buildInput(),
    )

    expect(judgment.verdict).toBe('unsafe')
    expect(judgment.summary).toBe('remote result')
    expect(judgment.policyDimensions).toEqual([
      'destructive_action',
      'scope_mismatch',
    ])
  })

  it('throws when the judge client is not configured', async () => {
    await expect(
      new LazyMonitoringJudgeService().evaluate(buildInput()),
    ).rejects.toThrow('lazy monitoring judge is not configured')
  })

  it('sends only the current prompt, previous prompt, current tool call, and previous tool call to the remote judge', async () => {
    const input = buildInput({
      run: {
        monitoringSessionId: '123e4567-e89b-12d3-a456-426614174111',
        agentId: 'agent-1',
        sessionKey: 'session-1',
        originalPrompt: 'click on the first product',
        chatHistory: [
          { role: 'user', content: 'open amazon cart' },
          { role: 'assistant', content: 'done' },
        ],
        startedAt: '2026-04-20T15:59:03.630Z',
        source: 'debug',
      },
      priorToolCalls: [
        {
          monitoringSessionId: '123e4567-e89b-12d3-a456-426614174111',
          agentId: 'agent-1',
          toolCallId: 'tool-prev',
          toolName: 'take_snapshot',
          toolDescription: 'Take a snapshot',
          source: 'browser-tool',
          args: { page: 2 },
          output: { content: [{ type: 'text', text: '[12] Product 1' }] },
          startedAt: '2026-04-20T15:59:02.000Z',
          finishedAt: '2026-04-20T15:59:03.000Z',
          durationMs: 1000,
        },
      ],
      currentToolCall: {
        monitoringSessionId: '123e4567-e89b-12d3-a456-426614174111',
        agentId: 'agent-1',
        toolCallId: 'tool-current',
        toolName: 'click',
        toolDescription: 'Click an element',
        source: 'browser-tool',
        args: { page: 2, element: 12, button: 'left' },
        startedAt: '2026-04-20T15:59:03.630Z',
      },
    })

    let payload: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      const requestBody =
        typeof init?.body === 'string' ? JSON.parse(init.body) : null
      const userMessage = requestBody?.messages?.[1]?.content
      payload =
        typeof userMessage === 'string' ? JSON.parse(userMessage) : undefined

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: 'safe',
                  summary: 'ok',
                  policyDimensions: [],
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    const judgment = await new RemoteLazyMonitoringJudgeClient({
      provider: 'openrouter',
      model: 'test-model',
      baseUrl: 'https://example.com',
      apiKey: 'test-key',
      timeoutMs: 10_000,
    }).judge(input)

    expect(judgment.verdict).toBe('safe')
    expect(payload).toEqual({
      currentUserPrompt: 'click on the first product',
      previousUserPrompt: 'open amazon cart',
      previousToolCall: {
        toolCallId: 'tool-prev',
        toolName: 'take_snapshot',
        toolDescription: 'Take a snapshot',
        source: 'browser-tool',
        args: { page: 2 },
        output: { content: [{ type: 'text', text: '[12] Product 1' }] },
        error: undefined,
      },
      currentToolCall: {
        toolCallId: 'tool-current',
        toolName: 'click',
        toolDescription: 'Click an element',
        source: 'browser-tool',
        args: {
          page: 2,
          element: 12,
          button: 'left',
          lazyMonitoringContext: {
            element: {
              id: 12,
              lastSnapshotLine: '[12] Product 1',
              matchedFromToolCallId: 'tool-prev',
              matchedFromToolName: 'take_snapshot',
            },
          },
        },
      },
    })
  })
})
