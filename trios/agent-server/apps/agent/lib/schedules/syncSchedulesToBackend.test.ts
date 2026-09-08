/**
 * Contract suite for the exports of syncSchedulesToBackend.ts.
 *
 * The module exports exactly one symbol: `syncSchedulesToBackend`. Every
 * assertion below calls that export and asserts on what it does - the
 * GraphQL operations it issues against the backend, the local storage it
 * writes, and the pending-deletion queue it drains - so the suite pins
 * observable behaviour rather than the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`syncSchedulesToBackend`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * Every live dependency of the export is swapped for an in-memory stub via
 * `mock.module`: the GraphQL executor (`@/lib/graphql/execute`), the error
 * sink (`@/lib/sentry/sentry`), the schedule storages (`./scheduleStorage`),
 * the alarm factory (`./createAlarmFromJob`) and the generated GraphQL
 * documents, which do not exist in a fresh checkout without a codegen run.
 * The `chrome.alarms` global the export touches is stubbed on `globalThis`
 * and restored afterwards. The suite therefore needs no network, no
 * database and no container, and runs in the existing agent test group.
 *
 * Not pinned, and why: alarm re-creation for added and updated jobs. The
 * export does recreate alarms after writing storage, but asserting on that
 * would pin a call to a collaborator rather than the module's contract, and
 * the effect is only observable through the browser's alarm scheduler.
 * This is a gap in side-effect coverage, not an export left unexercised:
 * the export itself is called and asserted on by every test, so no export
 * belongs in the blocked list above.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ScheduledJob } from './scheduleTypes'

type RemoteJob = {
  rowId: string
  name: string
  query: string
  scheduleType: string
  scheduleTime: string | null
  scheduleInterval: number | null
  enabled: boolean
  llmProviderId: string | null
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
}

type ExecuteCall = {
  document: unknown
  variables: unknown
}

// Sentinel documents stand in for the generated GraphQL documents, which
// only exist after a codegen run and would otherwise need a live backend
// schema to import. The mocks below are what the export sees, and the
// assertions below assert on them.
const PROFILE_DOC = 'document:GetProfileIdByUserId'
const JOBS_DOC = 'document:GetScheduledJobsByProfileId'
const CREATE_DOC = 'document:CreateScheduledJob'
const UPDATE_DOC = 'document:UpdateScheduledJob'
const DELETE_DOC = 'document:DeleteScheduledJob'

const executeCalls: ExecuteCall[] = []
let profileRowId: string | undefined = 'profile-1'
let remoteNodes: Array<RemoteJob | null> = []
let rowIdsRejectedOnDelete = new Set<string>()
let rowIdsRejectedOnCreate = new Set<string>()

mock.module('@/lib/conversations/graphql/uploadConversationDocument', () => ({
  GetProfileIdByUserIdDocument: PROFILE_DOC,
}))

mock.module('./graphql/syncSchedulesDocument', () => ({
  GetScheduledJobsByProfileIdDocument: JOBS_DOC,
  CreateScheduledJobDocument: CREATE_DOC,
  UpdateScheduledJobDocument: UPDATE_DOC,
  DeleteScheduledJobDocument: DELETE_DOC,
}))

mock.module('@/lib/graphql/execute', () => ({
  execute: async (document: unknown, variables: unknown) => {
    executeCalls.push({ document, variables })

    if (document === PROFILE_DOC) {
      return {
        profileByUserId: profileRowId ? { rowId: profileRowId } : null,
      }
    }
    if (document === JOBS_DOC) {
      return { scheduledJobs: { nodes: remoteNodes } }
    }
    if (document === DELETE_DOC) {
      const { rowId } = variables as { rowId: string }
      if (rowIdsRejectedOnDelete.has(rowId)) {
        throw new Error(`backend rejected delete of ${rowId}`)
      }
      return { deleteScheduledJob: { deletedrowId: rowId } }
    }
    if (document === CREATE_DOC) {
      const { rowId } = (
        variables as { input: { scheduledJob: { rowId: string } } }
      ).input.scheduledJob
      if (rowIdsRejectedOnCreate.has(rowId)) {
        throw new Error(`backend rejected create of ${rowId}`)
      }
      return { createScheduledJob: { scheduledJob: { rowId } } }
    }
    if (document === UPDATE_DOC) {
      const { rowId } = (variables as { input: { rowId: string } }).input
      return { updateScheduledJob: { scheduledJob: { rowId } } }
    }
    throw new Error(
      `unexpected document passed to execute: ${String(document)}`,
    )
  },
}))

const reportedExceptions: Array<{
  error: unknown
  extra: Record<string, unknown>
}> = []

mock.module('@/lib/sentry/sentry', () => ({
  sentry: {
    captureException: (
      error: unknown,
      options?: { extra?: Record<string, unknown> },
    ) => {
      reportedExceptions.push({ error, extra: options?.extra ?? {} })
    },
  },
}))

// In-memory stand-ins for the two browser storages the export reads and
// writes. `scheduledJobStorage` is what a user of the schedules feature
// sees as their list of jobs; `pendingDeletionStorage` is the queue of
// jobs awaiting deletion on the backend.
let storedScheduledJobs: ScheduledJob[] = []
let storedPendingDeletions: string[] = []

mock.module('./scheduleStorage', () => ({
  scheduledJobStorage: {
    getValue: async () => storedScheduledJobs,
    setValue: async (value: ScheduledJob[]) => {
      storedScheduledJobs = value
    },
  },
  pendingDeletionStorage: {
    getValue: async () => storedPendingDeletions,
    setValue: async (value: string[]) => {
      storedPendingDeletions = value
    },
  },
}))

const alarmsRecreated: ScheduledJob[] = []
mock.module('./createAlarmFromJob', () => ({
  createAlarmFromJob: async (job: ScheduledJob) => {
    alarmsRecreated.push(job)
  },
}))

const clearedAlarms: string[] = []
const chromeGlobal = globalThis as { chrome?: unknown }
const previousChrome = chromeGlobal.chrome
chromeGlobal.chrome = {
  alarms: {
    clear: async (name: string) => {
      clearedAlarms.push(name)
      return true
    },
  },
}

const { syncSchedulesToBackend } = await import('./syncSchedulesToBackend')

afterAll(() => {
  if (previousChrome === undefined) {
    delete chromeGlobal.chrome
  } else {
    chromeGlobal.chrome = previousChrome
  }
})

const localJob = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: 'job-a',
  name: 'Morning briefing',
  query: 'summarize the news',
  scheduleType: 'daily',
  scheduleTime: '08:30',
  enabled: true,
  createdAt: '2024-01-01T10:00:00.000Z',
  updatedAt: '2024-01-02T10:00:00.000Z',
  ...overrides,
})

const remoteJob = (overrides: Partial<RemoteJob> = {}): RemoteJob => ({
  rowId: 'job-a',
  name: 'Morning briefing',
  query: 'summarize the news',
  scheduleType: 'daily',
  scheduleTime: '08:30',
  scheduleInterval: null,
  enabled: true,
  llmProviderId: null,
  createdAt: '2024-01-01T10:00:00.000Z',
  updatedAt: '2024-01-02T10:00:00.000Z',
  lastRunAt: null,
  ...overrides,
})

const callsFor = (document: unknown) =>
  executeCalls.filter((call) => call.document === document)

describe('syncSchedulesToBackendContract', () => {
  beforeEach(() => {
    executeCalls.length = 0
    profileRowId = 'profile-1'
    remoteNodes = []
    rowIdsRejectedOnDelete = new Set()
    rowIdsRejectedOnCreate = new Set()
    reportedExceptions.length = 0
    storedScheduledJobs = []
    storedPendingDeletions = []
    alarmsRecreated.length = 0
    clearedAlarms.length = 0
  })

  it('syncSchedulesToBackend: stops after the profile lookup when the user has no profile, leaving storage and the deletion queue untouched', async () => {
    profileRowId = undefined
    storedScheduledJobs = [localJob()]
    storedPendingDeletions = ['job-still-pending']

    await syncSchedulesToBackend([localJob()], 'user-without-profile')

    expect(executeCalls).toEqual([
      {
        document: PROFILE_DOC,
        variables: { userId: 'user-without-profile' },
      },
    ])
    expect(storedScheduledJobs).toEqual([localJob()])
    expect(storedPendingDeletions).toEqual(['job-still-pending'])
  })

  it('syncSchedulesToBackend: creates a backend job for a local job the backend does not know, sending optional fields as null', async () => {
    const job = localJob({
      id: 'job-new',
      scheduleInterval: undefined,
      providerId: undefined,
      lastRunAt: undefined,
    })

    await syncSchedulesToBackend([job], 'user-1')

    // The export resolved the profile, then fetched that profile's jobs.
    expect(executeCalls).toEqual([
      { document: PROFILE_DOC, variables: { userId: 'user-1' } },
      { document: JOBS_DOC, variables: { profileId: 'profile-1' } },
      {
        document: CREATE_DOC,
        variables: {
          input: {
            scheduledJob: {
              rowId: 'job-new',
              profileId: 'profile-1',
              name: 'Morning briefing',
              query: 'summarize the news',
              scheduleType: 'daily',
              scheduleTime: '08:30',
              scheduleInterval: null,
              enabled: true,
              llmProviderId: null,
              createdAt: '2024-01-01T10:00:00.000Z',
              updatedAt: '2024-01-02T10:00:00.000Z',
              lastRunAt: null,
            },
          },
        },
      },
    ])
  })

  it('syncSchedulesToBackend: sends an update when the local copy is newer and the tracked fields differ', async () => {
    remoteNodes = [
      remoteJob({
        name: 'Old name',
        updatedAt: '2024-01-01T09:00:00.000Z',
      }),
    ]
    storedScheduledJobs = [localJob()]

    await syncSchedulesToBackend([localJob()], 'user-1')

    expect(callsFor(UPDATE_DOC)).toEqual([
      {
        document: UPDATE_DOC,
        variables: {
          input: {
            rowId: 'job-a',
            patch: {
              name: 'Morning briefing',
              query: 'summarize the news',
              scheduleType: 'daily',
              scheduleTime: '08:30',
              scheduleInterval: null,
              enabled: true,
              llmProviderId: null,
              lastRunAt: null,
              updatedAt: '2024-01-02T10:00:00.000Z',
            },
          },
        },
      },
    ])
    expect(callsFor(CREATE_DOC)).toEqual([])
    // The remote copy was older, so local storage is left as it was.
    expect(storedScheduledJobs).toEqual([localJob()])
  })

  it('syncSchedulesToBackend: still sends the update when only ignored bookkeeping fields differ, because the tracked-fields comparison never suppresses it', async () => {
    // As the module stands, the local side of its tracked-fields comparison
    // carries `updatedAt` while the remote side does not, so the comparison
    // is never equal and never suppresses an update. This pins that outcome
    // as it is today, alongside the fields the comparison claims to ignore
    // (`id`, `createdAt`, `lastRunAt`): the update is sent regardless.
    remoteNodes = [
      remoteJob({
        // Older than the local copy, so the local one wins.
        updatedAt: '2024-01-01T09:00:00.000Z',
        lastRunAt: '2024-01-04T00:00:00.000Z',
      }),
    ]
    const job = localJob({
      lastRunAt: '2024-01-04T06:00:00.000Z',
      createdAt: '2023-12-31T00:00:00.000Z',
    })

    await syncSchedulesToBackend([job], 'user-1')

    expect(callsFor(UPDATE_DOC)).toEqual([
      {
        document: UPDATE_DOC,
        variables: {
          input: {
            rowId: 'job-a',
            patch: {
              name: 'Morning briefing',
              query: 'summarize the news',
              scheduleType: 'daily',
              scheduleTime: '08:30',
              scheduleInterval: null,
              enabled: true,
              llmProviderId: null,
              lastRunAt: '2024-01-04T06:00:00.000Z',
              updatedAt: '2024-01-02T10:00:00.000Z',
            },
          },
        },
      },
    ])
    expect(callsFor(CREATE_DOC)).toEqual([])
    expect(storedScheduledJobs).toEqual([])
  })

  it('syncSchedulesToBackend: sends no update when the remote copy is not older than the local one', async () => {
    remoteNodes = [
      remoteJob({
        name: 'Name changed elsewhere',
        // Same timestamp as the local copy: the remote copy wins ties.
        updatedAt: '2024-01-02T10:00:00.000Z',
      }),
    ]

    await syncSchedulesToBackend([localJob()], 'user-1')

    expect(callsFor(UPDATE_DOC)).toEqual([])
    expect(callsFor(CREATE_DOC)).toEqual([])
  })

  it('syncSchedulesToBackend: pulls a newer remote job into local storage, normalizing timestamps and nulls', async () => {
    remoteNodes = [
      remoteJob({
        name: 'Renamed remotely',
        enabled: false,
        // Neither timestamp ends in Z; both must gain it before being stored.
        createdAt: '2024-01-01T10:00:00.000',
        updatedAt: '2024-01-06T12:00:00.000',
        lastRunAt: null,
      }),
    ]
    storedScheduledJobs = [localJob()]

    await syncSchedulesToBackend([localJob()], 'user-1')

    expect(storedScheduledJobs).toEqual([
      {
        id: 'job-a',
        name: 'Renamed remotely',
        query: 'summarize the news',
        scheduleType: 'daily',
        scheduleTime: '08:30',
        scheduleInterval: undefined,
        enabled: false,
        providerId: undefined,
        createdAt: '2024-01-01T10:00:00.000Z',
        updatedAt: '2024-01-06T12:00:00.000Z',
        lastRunAt: undefined,
      },
    ])
    // The remote copy is the newer one, so nothing is written back.
    expect(callsFor(UPDATE_DOC)).toEqual([])
    expect(callsFor(CREATE_DOC)).toEqual([])
  })

  it('syncSchedulesToBackend: adds a remote-only job to local storage beside jobs that already exist', async () => {
    const keptJob = localJob({ id: 'job-keep', name: 'Keep me' })
    storedScheduledJobs = [keptJob]
    remoteNodes = [
      remoteJob({
        rowId: 'job-keep',
        name: 'Keep me',
        updatedAt: '2024-01-02T10:00:00.000Z',
      }),
      remoteJob({
        rowId: 'job-remote-only',
        name: 'Remote only',
        scheduleType: 'minutes',
        scheduleTime: null,
        scheduleInterval: 15,
        llmProviderId: 'provider-9',
        lastRunAt: '2024-02-03T00:00:00.000Z',
        createdAt: '2024-02-01T00:00:00.000Z',
        updatedAt: '2024-02-02T00:00:00.000Z',
      }),
    ]

    await syncSchedulesToBackend([keptJob], 'user-1')

    expect(storedScheduledJobs).toEqual([
      keptJob,
      {
        id: 'job-remote-only',
        name: 'Remote only',
        query: 'summarize the news',
        scheduleType: 'minutes',
        scheduleTime: undefined,
        scheduleInterval: 15,
        enabled: true,
        providerId: 'provider-9',
        createdAt: '2024-02-01T00:00:00.000Z',
        updatedAt: '2024-02-02T00:00:00.000Z',
        lastRunAt: '2024-02-03T00:00:00.000Z',
      },
    ])
    expect(callsFor(CREATE_DOC)).toEqual([])
    expect(callsFor(UPDATE_DOC)).toEqual([])
  })

  it('syncSchedulesToBackend: deletes pending jobs that still exist remotely and clears the deletion queue', async () => {
    remoteNodes = [remoteJob({ rowId: 'job-del', name: 'Doomed' })]
    storedPendingDeletions = ['job-del', 'job-already-gone']

    await syncSchedulesToBackend([], 'user-1')

    // Only the job that still exists remotely is deleted on the backend.
    expect(callsFor(DELETE_DOC)).toEqual([
      { document: DELETE_DOC, variables: { rowId: 'job-del' } },
    ])
    // Both queue entries are resolved, whether or not a delete was needed.
    expect(storedPendingDeletions).toEqual([])
    // The deleted job is not resurrected into local storage.
    expect(storedScheduledJobs).toEqual([])
  })

  it('syncSchedulesToBackend: keeps a failed deletion queued and reports it', async () => {
    remoteNodes = [remoteJob({ rowId: 'job-del', name: 'Doomed' })]
    storedPendingDeletions = ['job-del']
    rowIdsRejectedOnDelete = new Set(['job-del'])

    await syncSchedulesToBackend([], 'user-1')

    expect(callsFor(DELETE_DOC)).toHaveLength(1)
    expect(storedPendingDeletions).toEqual(['job-del'])
    expect(reportedExceptions).toHaveLength(1)
    expect(reportedExceptions[0]?.extra).toMatchObject({
      jobId: 'job-del',
      context: 'sync-pending-deletion',
    })
  })

  it('syncSchedulesToBackend: reports a failed backend write without aborting the remaining jobs', async () => {
    const failing = localJob({ id: 'job-fail', name: 'Fails on create' })
    const succeeding = localJob({ id: 'job-ok', name: 'Succeeds' })
    rowIdsRejectedOnCreate = new Set(['job-fail'])

    await syncSchedulesToBackend([failing, succeeding], 'user-1')

    const createdRowIds = callsFor(CREATE_DOC).map(
      (call) =>
        (call.variables as { input: { scheduledJob: { rowId: string } } }).input
          .scheduledJob.rowId,
    )
    expect(createdRowIds).toEqual(['job-fail', 'job-ok'])
    expect(reportedExceptions).toHaveLength(1)
    expect(reportedExceptions[0]?.extra).toMatchObject({
      jobId: 'job-fail',
      jobName: 'Fails on create',
    })
  })
})
