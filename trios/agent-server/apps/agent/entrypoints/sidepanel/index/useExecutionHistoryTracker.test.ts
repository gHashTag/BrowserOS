/**
 * Contract suite for the exports of useExecutionHistoryTracker.ts.
 *
 * The module exports exactly one symbol: `useExecutionHistoryTracker`.
 * Every assertion below renders that export through React's own hook
 * machinery (`react-dom/server`, the same renderer the sibling
 * SkillsPage contract suite uses, since no DOM test environment exists
 * in this project) and then drives the returned API the way its only
 * production caller (`useChatSession.ts`) does: start on dispatch,
 * sync on every message/status change, finish on stream end, clear on
 * reset. The assertions read what the tracker does to the outside
 * world - the task records it hands to storage and the ids it returns -
 * never the shape of its internals.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`useExecutionHistoryTracker`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The module's only live dependencies are the extension storage
 * (`@/lib/execution-history/storage`, backed by `@wxt-dev/storage`,
 * which needs a real browser) and the Sentry reporter. Both are swapped
 * for in-memory stubs via `mock.module`, so this suite needs no
 * network, no database and no container. No export was blocked by a
 * live dependency: the hook itself is fully exercised above.
 *
 * Not pinned, and why: nothing. The pure helpers the hook leans on
 * (`normalizeExecutionSteps`, `getResponsePreview`) run for real here
 * rather than being stubbed, so their mapping behaviour is covered at
 * the boundary where the hook actually relies on it; their own
 * edge cases are pinned separately by normalize.test.ts.
 */
import { describe, expect, it, mock } from 'bun:test'
import type { UIMessage } from 'ai'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { ExecutionTaskRecord } from '@/lib/execution-history/types'

// In-memory replacement for the extension-backed execution history
// storage. Every write is recorded so assertions can read exactly what
// the tracker persisted, in order, plus a start/end trace per write so
// the suite can pin that writes are serialised without touching the
// implementation's private queue.
const persistedTasks: ExecutionTaskRecord[] = []
const writeEvents: string[] = []
const capturedExceptions: unknown[] = []
let storageFailure: Error | null = null
let writeGate: Promise<void> = Promise.resolve()

mock.module('@/lib/execution-history/storage', () => ({
  upsertConversationExecutionTask: async (
    task: ExecutionTaskRecord,
  ): Promise<void> => {
    writeEvents.push(`start:actions=${task.actionCount}`)
    await writeGate
    if (storageFailure) throw storageFailure
    writeEvents.push(`end:actions=${task.actionCount}`)
    persistedTasks.push({ ...task })
  },
}))

mock.module('@/lib/sentry/sentry', () => ({
  sentry: {
    captureException: (error: unknown) => {
      capturedExceptions.push(error)
    },
  },
}))

const { useExecutionHistoryTracker } = await import(
  './useExecutionHistoryTracker'
)

type Tracker = ReturnType<typeof useExecutionHistoryTracker>

/**
 * Renders a probe component through React's server renderer so the hook
 * runs through React's real hook machinery. The hook uses only refs and
 * callbacks - no effects - so the captured API is fully drivable after
 * the render, exactly like the callbacks the sidepanel holds between
 * renders.
 */
function renderTracker(): Tracker {
  let rendered: Tracker | undefined
  function Probe() {
    rendered = useExecutionHistoryTracker()
    return null
  }
  const markup = renderToString(createElement(Probe))
  if (markup !== '') {
    throw new Error(`probe component emitted unexpected markup: ${markup}`)
  }
  if (rendered === undefined) {
    throw new Error('probe component failed to capture the tracker')
  }
  return rendered
}

/**
 * The hook persists through a promise chain, so every synchronous burst
 * of calls is drained by yielding one macrotask: the stub storage never
 * schedules timers, so all queued writes settle before the timer fires.
 */
const flushWrites = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

type ChatPart = UIMessage['parts'][number]

function textPart(text: string): ChatPart {
  return { type: 'text', text } as ChatPart
}

function toolPart(part: Record<string, unknown>): ChatPart {
  return part as unknown as ChatPart
}

function userMessage(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [textPart(text)] } as UIMessage
}

/**
 * A realistic post-dispatch transcript: two user turns (the tracker
 * must bind the prompt to the *last* one), then an assistant reply
 * whose parts mix one ignored nudge tool, one completed action and one
 * denied action that carries an approval.
 */
function conversationMessages(): UIMessage[] {
  return [
    userMessage('m-user-old', 'What happened yesterday?'),
    userMessage('m-user-1', 'Check the news'),
    {
      id: 'm-assistant-1',
      role: 'assistant',
      parts: [
        textPart('Checking the news now.'),
        toolPart({
          type: 'tool-suggest_schedule',
          toolCallId: 'nudge-1',
          state: 'output-available',
          input: { scheduleType: 'daily' },
          output: { suggestedName: 'Morning briefing' },
        }),
        toolPart({
          type: 'tool-open',
          toolCallId: 'call-open',
          state: 'output-available',
          input: { ref_id: 'page-1' },
          output: { pageId: 1 },
        }),
        toolPart({
          type: 'tool-click',
          toolCallId: 'call-deny',
          state: 'output-denied',
          input: { x: 10, y: 20 },
          approval: { id: 'approval-1', approved: false, reason: 'no' },
        }),
      ],
    } as UIMessage,
  ]
}

describe('useExecutionHistoryTrackerContract', () => {
  it('pins the contract of useExecutionHistoryTracker', async () => {
    // --- Before any task is started, sync and finish are inert. ---
    const idleTracker = renderTracker()
    persistedTasks.length = 0
    writeEvents.length = 0
    idleTracker.syncFromMessages(conversationMessages(), 'submitted')
    await idleTracker.finishTask({ responseText: 'orphan finish' })
    await flushWrites()
    expect(persistedTasks).toEqual([])
    expect(writeEvents).toEqual([])

    // --- startTask creates a running task, persists it and returns
    // --- its id; a second start opens a distinct task.
    const tracker = renderTracker()
    const firstTaskId = tracker.startTask({
      conversationId: 'conv-1',
      promptText: 'Summarize this page',
    })
    const secondTaskId = tracker.startTask({
      conversationId: 'conv-1',
      promptText: 'Summarize that page',
    })
    await flushWrites()
    expect(firstTaskId).not.toBe(secondTaskId)
    expect(persistedTasks.map((task) => task.id)).toEqual([
      firstTaskId,
      secondTaskId,
    ])
    expect(persistedTasks[0]).toMatchObject({
      id: firstTaskId,
      conversationId: 'conv-1',
      promptText: 'Summarize this page',
      status: 'running',
      actionCount: 0,
      approvalCount: 0,
      deniedCount: 0,
      errorCount: 0,
      steps: [],
    })
    expect(Number.isNaN(Date.parse(persistedTasks[0].startedAt))).toBe(false)

    // --- Writes are serialised: the second write does not begin until
    // --- the first one has completed.
    persistedTasks.length = 0
    writeEvents.length = 0
    let releaseFirstWrite!: () => void
    writeGate = new Promise((resolve) => {
      releaseFirstWrite = resolve
    })
    const queuedTracker = renderTracker()
    queuedTracker.startTask({
      conversationId: 'conv-2',
      promptText: 'Check the news',
    })
    queuedTracker.syncFromMessages(conversationMessages(), 'streaming')
    await flushWrites()
    // The first write is parked on the gate; the second has not started.
    expect(writeEvents).toEqual(['start:actions=0'])
    releaseFirstWrite()
    await flushWrites()
    expect(writeEvents).toEqual([
      'start:actions=0',
      'end:actions=0',
      'start:actions=2',
      'end:actions=2',
    ])
    expect(persistedTasks).toHaveLength(2)

    // --- A full run: sync binds ids, counts and preview from the
    // --- live transcript; unchanged transcripts are not re-persisted;
    // --- finish completes the task and closes it.
    persistedTasks.length = 0
    const liveTracker = renderTracker()
    const taskId = liveTracker.startTask({
      conversationId: 'conv-3',
      promptText: 'Check the news',
    })
    await flushWrites()
    liveTracker.syncFromMessages(conversationMessages(), 'streaming')
    await flushWrites()
    expect(persistedTasks[1]).toMatchObject({
      id: taskId,
      promptMessageId: 'm-user-1',
      assistantMessageId: 'm-assistant-1',
      responsePreview: 'Checking the news now.',
      actionCount: 2,
      approvalCount: 1,
      deniedCount: 1,
      errorCount: 0,
      status: 'running',
    })
    expect(persistedTasks[1].steps.map((step) => step.id)).toEqual([
      'call-open',
      'call-deny',
    ])
    expect(persistedTasks[1].steps.map((step) => step.toolName)).toEqual([
      'open',
      'click',
    ])
    // A repeat sync with an identical transcript persists nothing new.
    liveTracker.syncFromMessages(conversationMessages(), 'ready')
    await flushWrites()
    expect(persistedTasks).toHaveLength(2)
    await liveTracker.finishTask({ responseText: '  Headlines attached.  ' })
    await flushWrites()
    expect(persistedTasks[2]).toMatchObject({
      id: taskId,
      status: 'completed',
      completedAt: expect.any(String),
      responseText: 'Headlines attached.',
      responsePreview: 'Headlines attached.',
      actionCount: 2,
    })
    expect(persistedTasks[2].steps).toHaveLength(2)
    // After a finish the tracker holds no active task: later syncs and
    // finishes persist nothing.
    liveTracker.syncFromMessages(conversationMessages(), 'ready')
    await liveTracker.finishTask({ responseText: 'late finish' })
    await flushWrites()
    expect(persistedTasks).toHaveLength(3)

    // --- finishTask maps its flags onto terminal statuses, error
    // --- winning over abort, and an empty response keeps the preview
    // --- already captured during streaming.
    persistedTasks.length = 0
    const abortedTask = await finishTracking({
      conversationId: 'conv-4',
      promptText: 'Anything',
      finishInput: { isAbort: true },
    })
    expect(abortedTask.status).toBe('stopped')
    const failedTask = await finishTracking({
      conversationId: 'conv-4',
      promptText: 'Anything',
      finishInput: { isError: true },
    })
    expect(failedTask.status).toBe('failed')
    const crashedTask = await finishTracking({
      conversationId: 'conv-4',
      promptText: 'Anything',
      finishInput: { isAbort: true, isError: true },
    })
    expect(crashedTask.status).toBe('failed')
    const quietTask = await finishTracking({
      conversationId: 'conv-4',
      promptText: 'Anything',
      finishInput: {},
      messagesBeforeFinish: true,
    })
    expect(quietTask).toMatchObject({
      status: 'completed',
      responsePreview: 'Checking the news now.',
    })
    expect(quietTask.responseText).toBeUndefined()

    // --- clearActiveTask discards the active task: nothing after the
    // --- clear is persisted, not even a finish.
    persistedTasks.length = 0
    const clearedTracker = renderTracker()
    clearedTracker.startTask({
      conversationId: 'conv-5',
      promptText: 'Stale request',
    })
    clearedTracker.clearActiveTask()
    await flushWrites()
    clearedTracker.syncFromMessages(conversationMessages(), 'ready')
    await clearedTracker.finishTask({ responseText: 'never' })
    await flushWrites()
    expect(persistedTasks).toHaveLength(1)
    expect(persistedTasks[0]).toMatchObject({
      status: 'running',
      promptText: 'Stale request',
    })

    // --- A failing write is reported to Sentry and does not poison
    // --- later writes: the queue survives the failure.
    persistedTasks.length = 0
    capturedExceptions.length = 0
    const quotaError = new Error('extension storage quota exceeded')
    storageFailure = quotaError
    const resilientTracker = renderTracker()
    resilientTracker.startTask({
      conversationId: 'conv-6',
      promptText: 'Resilient request',
    })
    await flushWrites()
    expect(persistedTasks).toEqual([])
    expect(capturedExceptions[0]).toBe(quotaError)
    storageFailure = null
    resilientTracker.syncFromMessages(conversationMessages(), 'streaming')
    await flushWrites()
    expect(persistedTasks).toHaveLength(1)
    expect(persistedTasks[0]).toMatchObject({
      promptMessageId: 'm-user-1',
      actionCount: 2,
      status: 'running',
    })

    /** Starts a task, optionally syncs the transcript, finishes and returns the persisted record. */
    async function finishTracking(input: {
      conversationId: string
      promptText: string
      finishInput: {
        responseText?: string
        isAbort?: boolean
        isError?: boolean
      }
      messagesBeforeFinish?: boolean
    }): Promise<ExecutionTaskRecord> {
      const scenarioTracker = renderTracker()
      scenarioTracker.startTask({
        conversationId: input.conversationId,
        promptText: input.promptText,
      })
      if (input.messagesBeforeFinish) {
        scenarioTracker.syncFromMessages(conversationMessages(), 'streaming')
      }
      await flushWrites()
      await scenarioTracker.finishTask(input.finishInput)
      await flushWrites()
      const record = persistedTasks[persistedTasks.length - 1]
      if (!record) throw new Error('finish scenario persisted no record')
      return record
    }
  })
})
