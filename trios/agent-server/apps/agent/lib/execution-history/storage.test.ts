/**
 * Contract suite for ./storage - the execution-history persistence module.
 *
 * Coverage map - every export of the subject is exercised below:
 *
 *   1. executionHistoryStorage .............. shared-item + key + watch scenario
 *   2. upsertConversationExecutionTask ...... create / append / replace scenario
 *   3. getConversationExecutionHistory ...... known + unknown lookup scenario
 *   4. getExecutionHistoryByConversation .... empty + populated map scenario
 *   5. removeConversationExecutionHistory ... targeted removal scenario
 *   6. removeConversationExecutionTask ...... task removal + no-op scenario
 *   7. useConversationExecutionHistory ...... load / live-update / switch hook
 *   8. useExecutionHistoryByConversation .... load / live-update hook
 *
 * Nothing is left untested: all eight exports run against the in-memory
 * browser-storage fake below, so the blocked-export list is empty. The suite
 * needs no network, no database and no container.
 *
 * Two seams make that possible without touching the subject:
 *   - `globalThis.chrome.storage.local` is installed with a fake before the
 *     subject is imported, so `@wxt-dev/browser` binds the fake when its
 *     module body runs and `@wxt-dev/storage` reads and writes through it.
 *   - the two React hooks are driven by a minimal dispatcher installed on
 *     React's exported client internals - the same seam React routes every
 *     hook call through - so no DOM or renderer is required.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import * as React from 'react'
import type { ExecutionTaskRecord } from './types'

/* ------------------------------------------------------------------ *
 * Fake browser storage area, installed before the subject loads.
 * ------------------------------------------------------------------ */

type StorageChanges = Record<string, { oldValue: unknown; newValue: unknown }>
type StorageChangeListener = (changes: StorageChanges) => void

function createFakeLocalStorageArea() {
  const backing = new Map<string, unknown>()
  const listeners = new Set<StorageChangeListener>()

  const notify = (changes: StorageChanges) => {
    for (const listener of [...listeners]) listener(changes)
  }

  return {
    backing,
    async get(keys?: string | string[]) {
      if (keys === undefined) return Object.fromEntries(backing)
      const wanted = typeof keys === 'string' ? [keys] : keys
      const result: Record<string, unknown> = {}
      for (const key of wanted) {
        if (backing.has(key)) result[key] = backing.get(key)
      }
      return result
    },
    async set(items: Record<string, unknown>) {
      const changes: StorageChanges = {}
      for (const [key, newValue] of Object.entries(items)) {
        changes[key] = {
          oldValue: backing.has(key) ? backing.get(key) : undefined,
          newValue,
        }
        backing.set(key, newValue)
      }
      notify(changes)
    },
    async remove(keys: string | string[]) {
      const wanted = Array.isArray(keys) ? keys : [keys]
      const changes: StorageChanges = {}
      for (const key of wanted) {
        if (backing.has(key)) {
          changes[key] = { oldValue: backing.get(key), newValue: undefined }
          backing.delete(key)
        }
      }
      notify(changes)
    },
    onChanged: {
      addListener(listener: StorageChangeListener) {
        listeners.add(listener)
      },
      removeListener(listener: StorageChangeListener) {
        listeners.delete(listener)
      },
    },
  }
}

const fakeLocalStorageArea = createFakeLocalStorageArea()

// `@wxt-dev/browser` resolves `browser` to `globalThis.chrome` once, at
// module-load time, so the fake must be in place before the subject import.
;(globalThis as { chrome?: unknown }).chrome = {
  runtime: { id: 'storage-contract-suite' },
  storage: { local: fakeLocalStorageArea },
}

/* ------------------------------------------------------------------ *
 * Subject - imported only after the fake exists.
 * ------------------------------------------------------------------ */

const {
  executionHistoryStorage,
  upsertConversationExecutionTask,
  getConversationExecutionHistory,
  getExecutionHistoryByConversation,
  removeConversationExecutionHistory,
  removeConversationExecutionTask,
  useConversationExecutionHistory,
  useExecutionHistoryByConversation,
} = await import('./storage')

/* ------------------------------------------------------------------ *
 * Minimal React hook harness: a dispatcher swapped in around each
 * render, with after-render effect flushing, rerender and unmount.
 * ------------------------------------------------------------------ */

const reactInternals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
      H: unknown
    }
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

type Unsubscribe = () => void

function depsEqual(
  left: readonly unknown[] | undefined,
  right: readonly unknown[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return false
  return (
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  )
}

function renderHook<Props, Result>(
  callback: (props: Props) => Result,
  initialProps: Props,
) {
  interface StateCell {
    value: unknown
  }
  interface EffectCell {
    deps: readonly unknown[] | undefined
    cleanup: Unsubscribe | undefined
    effect: () => Unsubscribe | undefined
  }

  const stateCells = new Map<number, StateCell>()
  const effectCells = new Map<number, EffectCell>()
  const pendingEffects: EffectCell[] = []
  let hookCursor = 0
  let currentProps = initialProps
  let currentResult = undefined as Result
  let renderRequested = false

  const dispatcher = {
    useState(initialValue: unknown): [unknown, (update: unknown) => void] {
      const index = hookCursor++
      let cell = stateCells.get(index)
      if (cell === undefined) {
        const seed =
          typeof initialValue === 'function'
            ? (initialValue as () => unknown)()
            : initialValue
        cell = { value: seed }
        stateCells.set(index, cell)
      }
      const captured = cell
      const setState = (update: unknown) => {
        captured.value =
          typeof update === 'function'
            ? (update as (previous: unknown) => unknown)(captured.value)
            : update
        renderRequested = true
      }
      return [captured.value, setState]
    },
    useEffect(
      effect: () => Unsubscribe | undefined,
      deps?: readonly unknown[],
    ): void {
      const index = hookCursor++
      const previous = effectCells.get(index)
      if (previous !== undefined && depsEqual(previous.deps, deps)) return
      previous?.cleanup?.()
      const cell: EffectCell = { deps, cleanup: undefined, effect }
      effectCells.set(index, cell)
      pendingEffects.push(cell)
    },
  }

  function runRender() {
    hookCursor = 0
    const previousDispatcher = reactInternals.H
    reactInternals.H = dispatcher
    try {
      currentResult = callback(currentProps)
    } finally {
      reactInternals.H = previousDispatcher
    }
  }

  function flushPendingWork() {
    let guard = 0
    while ((renderRequested || pendingEffects.length > 0) && guard < 50) {
      guard += 1
      if (pendingEffects.length > 0) {
        const batch = pendingEffects.splice(0, pendingEffects.length)
        for (const cell of batch) {
          const cleanup = cell.effect()
          cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        }
      }
      if (renderRequested) {
        renderRequested = false
        runRender()
      }
    }
    if (guard >= 50) throw new Error('render loop guard tripped')
  }

  runRender()
  flushPendingWork()

  return {
    get current() {
      return currentResult
    },
    rerender(nextProps: Props) {
      currentProps = nextProps
      renderRequested = true
      flushPendingWork()
    },
    flush: flushPendingWork,
    unmount() {
      for (const cell of effectCells.values()) cell.cleanup?.()
      effectCells.clear()
      pendingEffects.length = 0
    },
  }
}

/**
 * Lets pending promise callbacks (history loads, watcher notifications) run
 * and applies any state updates they produced.
 */
async function settle(rendered: { flush: () => void }) {
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    rendered.flush()
  }
}

/* ------------------------------------------------------------------ *
 * Fixtures.
 * ------------------------------------------------------------------ */

function makeTask(id: string, conversationId: string): ExecutionTaskRecord {
  return {
    id,
    conversationId,
    promptText: `prompt for ${id}`,
    startedAt: '2025-01-01T00:00:00.000Z',
    status: 'completed',
    actionCount: 0,
    approvalCount: 0,
    deniedCount: 0,
    errorCount: 0,
    steps: [],
  }
}

/* ------------------------------------------------------------------ *
 * The suite.
 * ------------------------------------------------------------------ */

beforeEach(() => {
  fakeLocalStorageArea.backing.clear()
})

describe('storageContract', () => {
  it('executionHistoryStorage exposes the shared item under its published key', async () => {
    expect(executionHistoryStorage.key).toBe(
      'local:executionHistoryByConversation',
    )

    // Nothing written yet: the defined item reports its fallback value.
    expect(await executionHistoryStorage.getValue()).toEqual({})

    // Writes made through the module land in the same backing item.
    await upsertConversationExecutionTask(makeTask('task-1', 'conversation-a'))
    expect(Object.keys(await executionHistoryStorage.getValue())).toEqual([
      'conversation-a',
    ])

    // The item observes later writes, and stops observing once unsubscribed.
    const seen: unknown[] = []
    const stopWatching = executionHistoryStorage.watch((value) =>
      seen.push(value),
    )
    await upsertConversationExecutionTask(makeTask('task-2', 'conversation-a'))
    stopWatching()
    expect(seen.length).toBe(1)
    expect(Object.keys(seen[0] as object)).toEqual(['conversation-a'])

    await upsertConversationExecutionTask(makeTask('task-3', 'conversation-a'))
    expect(seen.length).toBe(1)
  })

  it('upsertConversationExecutionTask creates, appends to and replaces history per conversation', async () => {
    const first = makeTask('task-1', 'conversation-a')
    await upsertConversationExecutionTask(first)

    let history = await getConversationExecutionHistory('conversation-a')
    expect(history?.conversationId).toBe('conversation-a')
    expect(history?.tasks).toEqual([first])
    expect(typeof history?.updatedAt).toBe('number')

    // A different task for the same conversation is appended, not swapped.
    await upsertConversationExecutionTask(makeTask('task-2', 'conversation-a'))
    history = await getConversationExecutionHistory('conversation-a')
    expect(history?.tasks.map((task) => task.id)).toEqual(['task-1', 'task-2'])

    // Re-upserting an existing id replaces that task and keeps the rest.
    await upsertConversationExecutionTask({
      ...first,
      status: 'failed',
    } satisfies ExecutionTaskRecord)
    history = await getConversationExecutionHistory('conversation-a')
    expect(history?.tasks.map((task) => task.id)).toEqual(['task-1', 'task-2'])
    expect(history?.tasks[0]?.status).toBe('failed')

    // Writes for another conversation leave this one untouched.
    await upsertConversationExecutionTask(makeTask('task-9', 'conversation-b'))
    const map = await getExecutionHistoryByConversation()
    expect(Object.keys(map).sort()).toEqual([
      'conversation-a',
      'conversation-b',
    ])
    expect(map['conversation-a']?.tasks.map((task) => task.id)).toEqual([
      'task-1',
      'task-2',
    ])
  })

  it('getConversationExecutionHistory returns null for unknown conversations and the stored history otherwise', async () => {
    expect(await getConversationExecutionHistory('missing')).toBeNull()

    const task = makeTask('task-1', 'conversation-a')
    await upsertConversationExecutionTask(task)

    const history = await getConversationExecutionHistory('conversation-a')
    expect(history).not.toBeNull()
    expect(history?.conversationId).toBe('conversation-a')
    expect(history?.tasks).toEqual([task])
  })

  it('getExecutionHistoryByConversation returns an empty map when nothing is stored and every conversation afterwards', async () => {
    expect(await getExecutionHistoryByConversation()).toEqual({})

    await upsertConversationExecutionTask(makeTask('task-1', 'conversation-a'))
    await upsertConversationExecutionTask(makeTask('task-1', 'conversation-b'))

    const map = await getExecutionHistoryByConversation()
    expect(Object.keys(map).sort()).toEqual([
      'conversation-a',
      'conversation-b',
    ])
    expect(map['conversation-a']?.tasks[0]?.id).toBe('task-1')
    expect(map['conversation-b']?.tasks[0]?.id).toBe('task-1')
  })

  it('removeConversationExecutionHistory deletes only the named conversation and ignores unknown ones', async () => {
    await upsertConversationExecutionTask(makeTask('task-1', 'conversation-a'))
    await upsertConversationExecutionTask(makeTask('task-2', 'conversation-b'))

    await removeConversationExecutionHistory('conversation-a')
    expect(Object.keys(await getExecutionHistoryByConversation())).toEqual([
      'conversation-b',
    ])

    // Removing an id that is not stored changes nothing.
    await removeConversationExecutionHistory('conversation-zz')
    expect(Object.keys(await getExecutionHistoryByConversation())).toEqual([
      'conversation-b',
    ])
  })

  it('removeConversationExecutionTask drops the named task, drops emptied conversations and ignores no-ops', async () => {
    const tasks = [
      makeTask('task-a1', 'conversation-a'),
      makeTask('task-a2', 'conversation-a'),
      makeTask('task-b1', 'conversation-b'),
    ]
    for (const task of tasks) {
      await upsertConversationExecutionTask(task)
    }

    // Unknown conversation: nothing changes anywhere.
    await removeConversationExecutionTask({
      conversationId: 'conversation-zz',
      taskId: 'task-a1',
    })
    expect(
      Object.keys(await getExecutionHistoryByConversation()).sort(),
    ).toEqual(['conversation-a', 'conversation-b'])

    // Unknown task id inside a known conversation: nothing changes.
    await removeConversationExecutionTask({
      conversationId: 'conversation-a',
      taskId: 'task-zz',
    })
    let history = await getConversationExecutionHistory('conversation-a')
    expect(history?.tasks.map((task) => task.id)).toEqual([
      'task-a1',
      'task-a2',
    ])

    // Removing one of several tasks keeps the conversation with the rest.
    await removeConversationExecutionTask({
      conversationId: 'conversation-a',
      taskId: 'task-a1',
    })
    history = await getConversationExecutionHistory('conversation-a')
    expect(history?.tasks.map((task) => task.id)).toEqual(['task-a2'])

    // Removing the last task of a conversation removes the whole entry.
    await removeConversationExecutionTask({
      conversationId: 'conversation-a',
      taskId: 'task-a2',
    })
    expect(Object.keys(await getExecutionHistoryByConversation())).toEqual([
      'conversation-b',
    ])
    expect(await getConversationExecutionHistory('conversation-a')).toBeNull()
  })

  it('useConversationExecutionHistory loads, live-updates, switches and stops watching on unmount', async () => {
    await upsertConversationExecutionTask(makeTask('task-1', 'conversation-a'))
    await upsertConversationExecutionTask(makeTask('task-9', 'conversation-b'))

    const rendered = renderHook(
      (conversationId: string | undefined) =>
        useConversationExecutionHistory(conversationId),
      'conversation-a',
    )
    try {
      // Before the load settles the hook reports null.
      expect(rendered.current).toBeNull()

      await settle(rendered)
      expect(rendered.current?.tasks.map((task) => task.id)).toEqual(['task-1'])

      // A write to the watched conversation flows through without a rerender.
      await upsertConversationExecutionTask(
        makeTask('task-2', 'conversation-a'),
      )
      await settle(rendered)
      expect(rendered.current?.tasks.map((task) => task.id)).toEqual([
        'task-1',
        'task-2',
      ])

      // Switching conversations loads the other history and stops
      // following the previous one.
      rendered.rerender('conversation-b')
      await settle(rendered)
      expect(rendered.current?.tasks.map((task) => task.id)).toEqual(['task-9'])
      await upsertConversationExecutionTask(
        makeTask('task-3', 'conversation-a'),
      )
      await settle(rendered)
      expect(rendered.current?.tasks.map((task) => task.id)).toEqual(['task-9'])

      // Clearing the conversation id resets the hook to null and keeps
      // it there regardless of what happens in storage.
      rendered.rerender(undefined)
      await settle(rendered)
      expect(rendered.current).toBeNull()

      // Remounting onto a conversation watches it again...
      rendered.rerender('conversation-b')
      await settle(rendered)
      expect(rendered.current?.tasks.map((task) => task.id)).toEqual(['task-9'])

      // ...and after unmount the value freezes: later writes never reach
      // the hook because the watcher was cleaned up.
      rendered.unmount()
      await upsertConversationExecutionTask(
        makeTask('task-4', 'conversation-b'),
      )
      await settle(rendered)
      expect(rendered.current?.tasks.map((task) => task.id)).toEqual(['task-9'])
    } finally {
      rendered.unmount()
    }
  })

  it('useExecutionHistoryByConversation loads the full map and live-updates until unmounted', async () => {
    const rendered = renderHook(() => useExecutionHistoryByConversation(), null)
    try {
      // Starts as an empty map, before and after the initial load.
      expect(rendered.current).toEqual({})
      await settle(rendered)
      expect(rendered.current).toEqual({})

      // Upserts flow through the watcher as they happen.
      await upsertConversationExecutionTask(
        makeTask('task-1', 'conversation-a'),
      )
      await settle(rendered)
      expect(Object.keys(rendered.current)).toEqual(['conversation-a'])

      await upsertConversationExecutionTask(
        makeTask('task-2', 'conversation-b'),
      )
      await settle(rendered)
      expect(Object.keys(rendered.current).sort()).toEqual([
        'conversation-a',
        'conversation-b',
      ])

      // Removals flow through as well.
      await removeConversationExecutionHistory('conversation-a')
      await settle(rendered)
      expect(Object.keys(rendered.current)).toEqual(['conversation-b'])

      // After unmount the value freezes: a write to a brand-new
      // conversation never shows up because the watcher was cleaned up.
      rendered.unmount()
      await upsertConversationExecutionTask(
        makeTask('task-3', 'conversation-c'),
      )
      await settle(rendered)
      expect(Object.keys(rendered.current)).toEqual(['conversation-b'])
    } finally {
      rendered.unmount()
    }
  })
})
