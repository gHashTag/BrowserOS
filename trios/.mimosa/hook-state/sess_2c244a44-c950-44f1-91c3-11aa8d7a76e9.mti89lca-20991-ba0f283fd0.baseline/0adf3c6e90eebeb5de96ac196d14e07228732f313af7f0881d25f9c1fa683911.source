import { afterEach, describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { getLazyMonitoringRunDir } from '../src/lib/browseros-dir'
import {
  type LazyMonitoringJudgeClient,
  LazyMonitoringJudgeService,
} from '../src/monitoring/judge/service'
import type { LazyMonitoringJudgeInput } from '../src/monitoring/judge/types'
import { MonitoringService } from '../src/monitoring/service'

const createdRunDirs = new Set<string>()

function buildSafeResult(input: LazyMonitoringJudgeInput) {
  return {
    monitoringSessionId: input.run.monitoringSessionId,
    agentId: input.run.agentId,
    toolCallId: input.currentToolCall.toolCallId,
    toolName: input.currentToolCall.toolName,
    verdict: 'safe' as const,
    summary: 'safe',
    destructive: false,
    shouldInterrupt: false,
    mode: 'llm' as const,
    categories: [],
    matchedIntentCategories: [],
    policyDimensions: [],
    policyVersion: 'lazy-monitoring-judge/v1',
  }
}

afterEach(async () => {
  await Promise.all(
    [...createdRunDirs].map(async (runId) => {
      await rm(getLazyMonitoringRunDir(runId), { recursive: true, force: true })
    }),
  )
  createdRunDirs.clear()
})

describe('MonitoringService lazy judge integration', () => {
  it('does not block tool start while the lazy judge is still running', async () => {
    let releaseJudge = () => {}

    const judgeClient: LazyMonitoringJudgeClient = {
      judge: async (input) => {
        await new Promise<void>((resolve) => {
          releaseJudge = resolve
        })
        return buildSafeResult(input)
      },
    }

    const service = new MonitoringService({
      judge: new LazyMonitoringJudgeService(judgeClient),
    })
    const session = await service.startSession({
      agentId: 'agent-1',
      sessionKey: 'session-1',
      originalPrompt: 'summarize my inbox',
      chatHistory: [{ role: 'user', content: 'summarize my inbox' }],
      source: 'debug',
    })
    createdRunDirs.add(session.monitoringSessionId)

    const observer = service.createObserver(
      session.monitoringSessionId,
      session.agentId,
    )

    const result = await Promise.race([
      observer
        .onToolStart({
          toolCallId: 'tool-1',
          toolName: 'click',
          toolDescription: 'Delete all emails button',
          source: 'browser-tool',
          args: { targetText: 'Delete all emails' },
        })
        .then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('timed_out'), 50)),
    ])

    expect(result).toBe('done')

    releaseJudge()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('passes completed prior tool calls into later judge reviews', async () => {
    const calls: LazyMonitoringJudgeInput[] = []

    const judgeClient: LazyMonitoringJudgeClient = {
      judge: async (input) => {
        calls.push(input)
        return buildSafeResult(input)
      },
    }

    const service = new MonitoringService({
      judge: new LazyMonitoringJudgeService(judgeClient),
    })
    const session = await service.startSession({
      agentId: 'agent-2',
      sessionKey: 'session-2',
      originalPrompt: 'find my latest invoices',
      chatHistory: [{ role: 'user', content: 'find my latest invoices' }],
      source: 'debug',
    })
    createdRunDirs.add(session.monitoringSessionId)

    const observer = service.createObserver(
      session.monitoringSessionId,
      session.agentId,
    )

    await observer.onToolStart({
      toolCallId: 'tool-1',
      toolName: 'take_snapshot',
      toolDescription: 'Take a DOM snapshot',
      source: 'browser-tool',
      args: { page: 1 },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    await observer.onToolEnd({
      toolCallId: 'tool-1',
      output: {
        content: [{ type: 'text', text: '[12] Delete all emails\n[13] Inbox' }],
      },
    })

    await observer.onToolStart({
      toolCallId: 'tool-2',
      toolName: 'click',
      toolDescription: 'Delete all emails button',
      source: 'browser-tool',
      args: { page: 1, element: 12, targetText: 'Delete all emails' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toHaveLength(2)
    expect(calls[1]?.priorToolCalls).toHaveLength(1)
    expect(calls[1]?.priorToolCalls[0]?.toolCallId).toBe('tool-1')
  })

  it('emits a judge error event instead of falling back when review fails', async () => {
    const originalError = console.error
    const errorLogs: string[] = []
    console.error = (...args: unknown[]) => {
      errorLogs.push(args.map((value) => String(value)).join(' '))
    }

    try {
      const service = new MonitoringService({
        judge: new LazyMonitoringJudgeService(),
      })
      const session = await service.startSession({
        agentId: 'agent-error',
        sessionKey: 'session-error',
        originalPrompt: 'summarize my inbox',
        chatHistory: [{ role: 'user', content: 'summarize my inbox' }],
        source: 'debug',
      })
      createdRunDirs.add(session.monitoringSessionId)

      const observer = service.createObserver(
        session.monitoringSessionId,
        session.agentId,
      )

      const result = await Promise.race([
        observer
          .onToolStart({
            toolCallId: 'tool-error',
            toolName: 'get_page_content',
            toolDescription: 'Read page content',
            source: 'browser-tool',
            args: { page: 1 },
          })
          .then(() => 'done'),
        new Promise((resolve) => setTimeout(() => resolve('timed_out'), 50)),
      ])

      expect(result).toBe('done')
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(
        errorLogs.some((entry) =>
          entry.includes('"type":"lazy-monitoring-judge-error"'),
        ),
      ).toBe(true)
      expect(
        errorLogs.some((entry) =>
          entry.includes('lazy monitoring judge is not configured'),
        ),
      ).toBe(true)
    } finally {
      console.error = originalError
    }
  })

  it('logs safe judge results so judge activity is visible in stdout', async () => {
    const originalLog = console.log
    const stdoutLogs: string[] = []
    console.log = (...args: unknown[]) => {
      stdoutLogs.push(args.map((value) => String(value)).join(' '))
    }

    try {
      const service = new MonitoringService({
        judge: new LazyMonitoringJudgeService({
          judge: async (input) => buildSafeResult(input),
        }),
      })
      const session = await service.startSession({
        agentId: 'agent-safe',
        sessionKey: 'session-safe',
        originalPrompt: 'summarize my inbox',
        chatHistory: [{ role: 'user', content: 'summarize my inbox' }],
        source: 'debug',
      })
      createdRunDirs.add(session.monitoringSessionId)

      const observer = service.createObserver(
        session.monitoringSessionId,
        session.agentId,
      )

      await observer.onToolStart({
        toolCallId: 'tool-safe',
        toolName: 'get_page_content',
        toolDescription: 'Read page content',
        source: 'browser-tool',
        args: { page: 1 },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(
        stdoutLogs.some(
          (entry) =>
            entry.includes('"type":"lazy-monitoring-judge"') &&
            entry.includes('"verdict":"safe"'),
        ),
      ).toBe(true)
    } finally {
      console.log = originalLog
    }
  })

  it('passes prior tool calls across separate observer instances for the same run', async () => {
    const calls: LazyMonitoringJudgeInput[] = []

    const judgeClient: LazyMonitoringJudgeClient = {
      judge: async (input) => {
        calls.push(input)
        return buildSafeResult(input)
      },
    }

    const service = new MonitoringService({
      judge: new LazyMonitoringJudgeService(judgeClient),
    })
    const session = await service.startSession({
      agentId: 'agent-3',
      sessionKey: 'session-3',
      originalPrompt: 'summarize my inbox',
      chatHistory: [{ role: 'user', content: 'summarize my inbox' }],
      source: 'debug',
    })
    createdRunDirs.add(session.monitoringSessionId)

    const observerA = service.createObserver(
      session.monitoringSessionId,
      session.agentId,
    )
    await observerA.onToolStart({
      toolCallId: 'tool-a',
      toolName: 'take_snapshot',
      toolDescription: 'Take a DOM snapshot',
      source: 'browser-tool',
      args: { page: 1 },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await observerA.onToolEnd({
      toolCallId: 'tool-a',
      output: {
        content: [{ type: 'text', text: '[875] Proceed to checkout' }],
      },
    })

    const observerB = service.createObserver(
      session.monitoringSessionId,
      session.agentId,
    )
    await observerB.onToolStart({
      toolCallId: 'tool-b',
      toolName: 'click',
      toolDescription: 'Click an element by its ID from the last snapshot',
      source: 'browser-tool',
      args: { page: 1, element: 875 },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toHaveLength(2)
    expect(calls[1]?.priorToolCalls).toHaveLength(1)
    expect(calls[1]?.priorToolCalls[0]?.toolCallId).toBe('tool-a')
  })

  it('prefers the single active OpenClaw chat session for unattributed MCP requests', async () => {
    const service = new MonitoringService({
      judge: new LazyMonitoringJudgeService(),
    })

    const debugSession = await service.startSession({
      agentId: 'judge-demo',
      sessionKey: 'session-debug',
      originalPrompt: 'summarize my inbox',
      chatHistory: [{ role: 'user', content: 'summarize my inbox' }],
      source: 'debug',
    })
    const openClawSession = await service.startSession({
      agentId: 'assistant',
      sessionKey: 'session-openclaw',
      originalPrompt: 'Do this again',
      chatHistory: [{ role: 'user', content: 'Click on the first product' }],
      source: 'openclaw-agent-chat',
    })

    createdRunDirs.add(debugSession.monitoringSessionId)
    createdRunDirs.add(openClawSession.monitoringSessionId)

    expect(service.resolveSessionForMcpRequest()).toEqual({
      agentId: 'assistant',
      monitoringSessionId: openClawSession.monitoringSessionId,
    })
  })
})
