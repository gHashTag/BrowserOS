/**
 * Contract suite for the exports of scheduleStorage.ts.
 *
 * Export accounting (the module has 7 exports in total):
 *   - exercised by the test blocks below: 7, one per export, with each
 *     test named after the symbol it covers
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - seven test blocks plus zero blocked exports equals seven exports,
 *     matching the export count of the module.
 *
 * The suite needs no network, no database and no container:
 *   - the browser extension environment (`chrome.storage.local`,
 *     `chrome.alarms`, `chrome.runtime` messaging) is an in-memory fake
 *     installed on `globalThis` before the subject is imported, so the
 *     real `@wxt-dev/storage` and `@webext-core/messaging` libraries run
 *     unchanged against it;
 *   - `syncSchedulesToBackend`, the module's only network edge (it talks
 *     GraphQL to the agent server), is swapped for an in-memory recorder
 *     via `mock.module`, which also keeps that module's codegen-only
 *     imports out of the suite.
 *
 * Coverage gap that is not a blocked export: `useScheduledJobs` and
 * `useScheduledJobRuns` refresh their React state from a `useEffect`
 * subscription. No DOM-capable renderer exists in this project's test
 * toolchain (`@testing-library`, `happy-dom` and `jsdom` are all absent
 * from the lockfile), so a server render captures each hook's return
 * value and the suite drives the captured mutators. Both exports are
 * exercised through everything they return; the subscription-fed state
 * refresh itself is the part left unpinned.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { ScheduledJob, ScheduledJobRun } from './scheduleTypes'

type StorageChanges = Record<string, { oldValue: unknown; newValue: unknown }>

/** An in-memory, Chrome-shaped `storage.local` area. */
const createLocalStorageArea = () => {
  const entries = new Map<string, unknown>()
  const listeners = new Set<
    (changes: StorageChanges, areaName: string) => void
  >()
  const fire = (changes: StorageChanges) => {
    for (const listener of [...listeners]) listener(changes, 'local')
  }
  return {
    entries,
    async get(keys: string | string[] | null) {
      if (keys === null) return Object.fromEntries(entries)
      const wanted = Array.isArray(keys) ? keys : [keys]
      const found: Record<string, unknown> = {}
      for (const key of wanted) {
        if (entries.has(key)) found[key] = entries.get(key)
      }
      return found
    },
    async set(items: Record<string, unknown>) {
      const changes: StorageChanges = {}
      for (const [key, value] of Object.entries(items)) {
        changes[key] = {
          oldValue: entries.has(key) ? entries.get(key) : undefined,
          newValue: value,
        }
        entries.set(key, value)
      }
      fire(changes)
    },
    async remove(keys: string | string[]) {
      const wanted = Array.isArray(keys) ? keys : [keys]
      const changes: StorageChanges = {}
      for (const key of wanted) {
        if (!entries.has(key)) continue
        changes[key] = { oldValue: entries.get(key), newValue: undefined }
        entries.delete(key)
      }
      fire(changes)
    },
    onChanged: {
      addListener: (
        listener: (changes: StorageChanges, areaName: string) => void,
      ) => {
        listeners.add(listener)
      },
      removeListener: (
        listener: (changes: StorageChanges, areaName: string) => void,
      ) => {
        listeners.delete(listener)
      },
    },
  }
}

const localArea = createLocalStorageArea()

/** Real alarm state, so assertions can observe what the browser holds. */
const alarms = new Map<
  string,
  { name: string; scheduledTime: number; periodInMinutes?: number }
>()

/** Every message the fake extension runtime has been asked to deliver. */
const sentRuntimeMessages: Array<Record<string, unknown>> = []

// The browser environment must exist before the subject (and the storage
// and messaging libraries it pulls in) is imported, because
// `@wxt-dev/browser` captures `globalThis.chrome` at import time and
// `webextension-polyfill` wraps it at import time.
const globals = globalThis as unknown as Record<string, unknown>
globals.chrome = {
  runtime: {
    id: 'schedule-storage-contract-suite',
    lastError: null,
    onMessage: {
      addListener: () => {},
      removeListener: () => {},
    },
    sendMessage: (
      message: Record<string, unknown>,
      callback?: (reply: unknown) => void,
    ) => {
      sentRuntimeMessages.push(message)
      callback?.({ res: { success: true } })
    },
  },
  storage: { local: localArea },
  alarms: {
    create: (name: string, info: chrome.alarms.AlarmCreateInfo) => {
      alarms.set(name, {
        name,
        scheduledTime: info.when ?? Date.now(),
        periodInMinutes: info.periodInMinutes,
      })
    },
    get: async (name: string) => alarms.get(name),
    clear: async (name: string) => alarms.delete(name),
    clearAll: async () => {
      alarms.clear()
      return true
    },
  },
}

/** Record of every handoff the backend sync edge received. */
const backendHandoffs: Array<{ jobs: ScheduledJob[]; userId: string }> = []

mock.module('./syncSchedulesToBackend', () => ({
  syncSchedulesToBackend: async (jobs: ScheduledJob[], userId: string) => {
    backendHandoffs.push({ jobs, userId })
  },
}))

const scheduleStorage = await import('./scheduleStorage')
const {
  pendingDeletionStorage,
  scheduledJobRunStorage,
  scheduledJobStorage,
  setupScheduledJobsSyncToBackend,
  syncScheduledJobs,
  useScheduledJobRuns,
  useScheduledJobs,
} = scheduleStorage

const { sessionStorage } = await import('../auth/sessionStorage')

const makeJob = (
  id: string,
  overrides: Partial<ScheduledJob> = {},
): ScheduledJob => ({
  id,
  name: `Job ${id}`,
  query: 'Summarise the news',
  scheduleType: 'daily',
  scheduleTime: '09:00',
  enabled: true,
  createdAt: '2024-05-01T08:00:00.000Z',
  updatedAt: '2024-05-01T08:00:00.000Z',
  ...overrides,
})

const makeRun = (id: string, jobId: string): ScheduledJobRun => ({
  id,
  jobId,
  startedAt: '2024-05-01T09:00:00.000Z',
  status: 'running',
})

const signInAs = async (userId: string) => {
  // better-auth's `User` type carries server-side bookkeeping fields this
  // contract never touches; only `user.id` is ever read from the session.
  await sessionStorage.setValue({
    user: { id: userId },
  } as unknown as Parameters<typeof sessionStorage.setValue>[0])
}

/** Capture a hook's return value with a one-shot server render. */
const captureHook = <T>(useHook: () => T): T => {
  let captured: T | undefined
  renderToString(
    createElement(() => {
      captured = useHook()
      return null
    }),
  )
  if (captured === undefined) throw new Error('the hook never rendered')
  return captured
}

/** Yield to pending microtasks and timers until a condition holds. */
const settle = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

beforeEach(() => {
  localArea.entries.clear()
  alarms.clear()
  sentRuntimeMessages.length = 0
  backendHandoffs.length = 0
})

describe('scheduleStorageContract', () => {
  beforeAll(() => {
    // Pin the export surface the accounting comment above counts; if the
    // export list drifts, the accounting must be redone, not silently
    // trusted.
    expect(Object.keys(scheduleStorage).sort()).toEqual([
      'pendingDeletionStorage',
      'scheduledJobRunStorage',
      'scheduledJobStorage',
      'setupScheduledJobsSyncToBackend',
      'syncScheduledJobs',
      'useScheduledJobRuns',
      'useScheduledJobs',
    ])
  })

  it('scheduledJobStorage persists jobs, reports changes, and falls back to an empty list', async () => {
    // No job was ever stored, and the item still yields a usable list.
    expect(await scheduledJobStorage.getValue()).toEqual([])

    const job = makeJob('job-watch')
    const seen: Array<[ScheduledJob[], ScheduledJob[]]> = []
    const stopWatching = scheduledJobStorage.watch((newValue, oldValue) => {
      seen.push([newValue, oldValue])
    })

    await scheduledJobStorage.setValue([job])
    expect(await scheduledJobStorage.getValue()).toEqual([job])
    // The new list reaches watchers, and the absent previous list is
    // reported through the same fallback.
    expect(seen).toEqual([[[job], []]])
    // The value is visible to any other reader of the extension storage
    // area, not just cached inside this item.
    expect(await localArea.get(null)).toEqual({ scheduledJobs: [job] })

    stopWatching()
    await scheduledJobStorage.setValue([])
    expect(seen).toHaveLength(1)
  })

  it('scheduledJobRunStorage keeps run history with an empty fallback', async () => {
    expect(await scheduledJobRunStorage.getValue()).toEqual([])

    const run = makeRun('run-history', 'job-watch')
    await scheduledJobRunStorage.setValue([run])
    expect(await scheduledJobRunStorage.getValue()).toEqual([run])
  })

  it('pendingDeletionStorage tracks job ids queued for backend deletion', async () => {
    expect(await pendingDeletionStorage.getValue()).toEqual([])

    await pendingDeletionStorage.setValue(['job-gone-1', 'job-gone-2'])
    expect(await pendingDeletionStorage.getValue()).toEqual([
      'job-gone-1',
      'job-gone-2',
    ])
  })

  it('useScheduledJobs adds, toggles, edits, removes, and runs scheduled jobs', async () => {
    const hook = captureHook(() => useScheduledJobs())
    // A freshly rendered consumer starts with no jobs.
    expect(hook.jobs).toEqual([])

    await hook.addJob({
      name: 'Morning digest',
      query: 'Summarise the news',
      scheduleType: 'daily',
      scheduleTime: '09:00',
      enabled: true,
    })
    await hook.addJob({
      name: 'Hourly digest',
      query: 'Summarise the news',
      scheduleType: 'hourly',
      scheduleInterval: 2,
      enabled: false,
    })

    const stored = await scheduledJobStorage.getValue()
    expect(stored).toHaveLength(2)
    const [enabledJob, disabledJob] = stored
    // addJob stamps identity and bookkeeping the caller never supplied.
    expect(enabledJob.id).not.toBe(disabledJob.id)
    expect(enabledJob.name).toBe('Morning digest')
    expect(enabledJob.createdAt).toBe(enabledJob.updatedAt)
    // An enabled daily job leaves a daily-repeating alarm in the browser.
    expect(
      (await chrome.alarms.get(`scheduled-job-${enabledJob.id}`))
        ?.periodInMinutes,
    ).toBe(24 * 60)
    // A disabled job is stored without ever touching the alarm clock.
    expect(
      await chrome.alarms.get(`scheduled-job-${disabledJob.id}`),
    ).toBeUndefined()

    await hook.toggleJob(enabledJob.id, false)
    const toggled = (await scheduledJobStorage.getValue()).find(
      (job) => job.id === enabledJob.id,
    )
    expect(toggled?.enabled).toBe(false)
    expect(toggled?.updatedAt >= toggled?.createdAt).toBe(true)
    expect(
      await chrome.alarms.get(`scheduled-job-${enabledJob.id}`),
    ).toBeUndefined()

    await hook.editJob(enabledJob.id, {
      name: 'Every half hour',
      query: 'Summarise the news',
      scheduleType: 'minutes',
      scheduleInterval: 30,
      enabled: true,
    })
    const edited = (await scheduledJobStorage.getValue()).find(
      (job) => job.id === enabledJob.id,
    )
    // editJob replaces the schedule while keeping the job's identity.
    expect(edited?.name).toBe('Every half hour')
    expect(edited?.createdAt).toBe(enabledJob.createdAt)
    expect(edited?.scheduleInterval).toBe(30)
    expect(
      (await chrome.alarms.get(`scheduled-job-${enabledJob.id}`))
        ?.periodInMinutes,
    ).toBe(30)

    await scheduledJobRunStorage.setValue([
      makeRun('run-of-enabled', enabledJob.id),
      makeRun('run-of-disabled', disabledJob.id),
    ])
    await hook.removeJob(enabledJob.id)
    // removeJob drops the job, queues it for backend deletion, removes
    // its run history, and clears its alarm.
    const remaining = await scheduledJobStorage.getValue()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(disabledJob.id)
    expect(await pendingDeletionStorage.getValue()).toEqual([enabledJob.id])
    expect(await scheduledJobRunStorage.getValue()).toEqual([
      makeRun('run-of-disabled', disabledJob.id),
    ])
    expect(
      await chrome.alarms.get(`scheduled-job-${enabledJob.id}`),
    ).toBeUndefined()

    // runJob dispatches the run request through the extension runtime.
    const response = await hook.runJob(disabledJob.id)
    expect(response).toEqual({ success: true })
    expect(sentRuntimeMessages.at(-1)).toMatchObject({
      type: 'runScheduledJob',
      data: { jobId: disabledJob.id },
    })
  })

  it('useScheduledJobRuns records, edits, removes, and cancels job runs', async () => {
    const hook = captureHook(() => useScheduledJobRuns())
    // A freshly rendered consumer starts with no run history.
    expect(hook.jobRuns).toEqual([])

    const run = makeRun('run-edit', 'job-watch')
    await hook.addJobRun(run)
    expect(await scheduledJobRunStorage.getValue()).toEqual([run])

    await hook.editJobRun('run-edit', { status: 'completed', result: 'Done' })
    expect(await scheduledJobRunStorage.getValue()).toEqual([
      { ...run, status: 'completed', result: 'Done' },
    ])

    const otherRun = makeRun('run-keep', 'job-watch')
    await hook.addJobRun(otherRun)
    await hook.removeJobRun('run-edit')
    expect(await scheduledJobRunStorage.getValue()).toEqual([otherRun])

    // cancelJobRun dispatches the cancellation through the extension
    // runtime.
    const response = await hook.cancelJobRun('run-keep')
    expect(response).toEqual({ success: true })
    expect(sentRuntimeMessages.at(-1)).toMatchObject({
      type: 'cancelScheduledJobRun',
      data: { runId: 'run-keep' },
    })
  })

  it('syncScheduledJobs hands the stored jobs to the backend only for a signed-in user', async () => {
    // With nobody signed in, the stored jobs never leave the browser.
    await scheduledJobStorage.setValue([makeJob('job-sync')])
    await syncScheduledJobs()
    expect(backendHandoffs).toEqual([])

    await signInAs('user-77')
    await syncScheduledJobs()
    expect(backendHandoffs).toEqual([
      { jobs: [makeJob('job-sync')], userId: 'user-77' },
    ])
  })

  it('setupScheduledJobsSyncToBackend syncs immediately, on change, and stops after unsubscribe', async () => {
    const jobA = makeJob('job-a')
    const jobB = makeJob('job-b')
    await scheduledJobStorage.setValue([jobA])
    await signInAs('user-9')

    const unsubscribe = setupScheduledJobsSyncToBackend()
    // The first sync fires as soon as the sync is set up.
    await settle(() => backendHandoffs.length === 1)
    expect(backendHandoffs[0]).toEqual({ jobs: [jobA], userId: 'user-9' })

    // Every stored change triggers another sync with the latest list.
    await scheduledJobStorage.setValue([jobA, jobB])
    await settle(() => backendHandoffs.length === 2)
    expect(backendHandoffs[1]).toEqual({
      jobs: [jobA, jobB],
      userId: 'user-9',
    })

    unsubscribe()
    await scheduledJobStorage.setValue([jobB])
    await settle(() => backendHandoffs.length === 3)
    expect(backendHandoffs).toHaveLength(2)
  })
})
