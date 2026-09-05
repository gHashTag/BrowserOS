/**
 * Contract suite for the exports of scheduledJobRuns.ts.
 *
 * The module exports exactly one symbol: `scheduledJobRuns`. The export is a
 * background entrypoint: calling it subscribes to the browser hooks and the
 * schedule messages it serves, and everything it does afterwards is observable
 * through four boundaries - the job/run storage it writes, the chat responses
 * it requests, the alarms it creates, and the replies its message handlers
 * return. Every assertion below reads one of those boundaries, so the suite
 * pins observable behaviour rather than the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`scheduledJobRuns`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The export's live dependencies are the extension messaging bus, the chrome
 * alarms API, the persistent job stores and the agent chat endpoint. All four
 * are swapped for in-memory fakes via `mock.module` and a fake `chrome`
 * global, so this suite needs no network, no database and no container. The
 * clock is frozen at a fixed instant (see VIRTUAL_NOW) because the module's
 * decisions - staleness after ten minutes, the twenty-four-hour window, the
 * daily and interval schedules - are all comparisons against "now"; a frozen
 * now makes every one of them deterministic and timezone-independent.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import type {
  ScheduledJob,
  ScheduledJobRun,
  ToolCallExecution,
} from '@/lib/schedules/scheduleTypes'

// ---------------------------------------------------------------- the clock

const VIRTUAL_NOW_ISO = '2025-06-15T12:00:00.000Z'
const VIRTUAL_NOW = Date.parse(VIRTUAL_NOW_ISO)
const RealDate = globalThis.Date

class FixedDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date>) {
    if (args.length === 0) {
      super(VIRTUAL_NOW)
    } else {
      super(...args)
    }
  }

  static now(): number {
    return VIRTUAL_NOW
  }
}
FixedDate.parse = RealDate.parse

// Timestamps for fixtures are epoch arithmetic around the frozen now, so they
// hold in every timezone. Noon UTC means every local timezone is between
// 00:00 and 02:00, which makes the local-time daily schedules used below
// ('00:00' already due, '23:59' not yet due) deterministic everywhere.
const minutesAgo = (minutes: number): string =>
  new Date(VIRTUAL_NOW - minutes * 60_000).toISOString()

// ---------------------------------------------------------------- the fakes

type AlarmListener = (alarm: { name: string }) => Promise<void> | void
type RuntimeListener = () => Promise<void> | void

const alarmListeners: AlarmListener[] = []
const startupListeners: RuntimeListener[] = []
const installedListeners: RuntimeListener[] = []
const existingAlarms = new Map<string, { name: string }>()

const chromeFake = {
  alarms: {
    get: async (name: string) => existingAlarms.get(name),
    create: async (name: string) => {
      existingAlarms.set(name, { name })
    },
    onAlarm: {
      addListener: (listener: AlarmListener) => {
        alarmListeners.push(listener)
      },
    },
  },
  runtime: {
    onStartup: {
      addListener: (listener: RuntimeListener) => {
        startupListeners.push(listener)
      },
    },
    onInstalled: {
      addListener: (listener: RuntimeListener) => {
        installedListeners.push(listener)
      },
    },
  },
}

type ScheduleHandlerMessage<T> = { data: T }
type ScheduleHandler<T> = (
  message: ScheduleHandlerMessage<T>,
) => Promise<{ success: boolean; error?: string }>

const scheduleHandlers = new Map<string, ScheduleHandler<unknown>>()

let jobs: ScheduledJob[] = []
let runs: ScheduledJobRun[] = []

const alarmCreations: ScheduledJob[] = []

interface ChatRequest {
  message: string
  signal?: AbortSignal
  providerId?: string
}

interface ChatResponse {
  text: string
  conversationId: string
  finalResult: string
  executionLog: string
  toolCalls: ToolCallExecution[]
}

const chatRequests: ChatRequest[] = []

const cannedResponse: ChatResponse = {
  text: 'The digest is ready.',
  conversationId: 'conversation-1',
  finalResult: 'FINAL RESULT',
  executionLog: 'EXECUTION LOG',
  toolCalls: [
    {
      id: 'tool-call-1',
      name: 'web_search',
      input: { query: 'the news' },
      timestamp: minutesAgo(1),
    },
  ],
}

let chatBehaviour: (request: ChatRequest) => Promise<ChatResponse> = () => {
  throw new Error('getChatServerResponse was called with no behaviour installed')
}

mock.module('@/lib/messaging/schedules/scheduleMessages', () => ({
  onScheduleMessage: <T>(
    type: string,
    handler: ScheduleHandler<T>,
  ): void => {
    scheduleHandlers.set(
      type,
      handler as unknown as ScheduleHandler<unknown>,
    )
  },
  sendScheduleMessage: () => {
    throw new Error('sendScheduleMessage is not part of this suite')
  },
}))

mock.module('@/lib/schedules/createAlarmFromJob', () => ({
  createAlarmFromJob: async (job: ScheduledJob) => {
    alarmCreations.push(job)
  },
}))

mock.module('@/lib/schedules/getChatServerResponse', () => ({
  getChatServerResponse: (request: ChatRequest) => chatBehaviour(request),
}))

mock.module('@/lib/schedules/scheduleStorage', () => ({
  scheduledJobStorage: {
    getValue: async () => jobs,
    setValue: async (value: ScheduledJob[]) => {
      jobs = value
    },
  },
  scheduledJobRunStorage: {
    getValue: async () => runs,
    setValue: async (value: ScheduledJobRun[]) => {
      runs = value
    },
  },
}))

const { scheduledJobRuns } = await import('./scheduledJobRuns')

// --------------------------------------------------------------- fixtures

const makeJob = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: 'job-1',
  name: 'Daily digest',
  query: 'Summarise the news',
  scheduleType: 'daily',
  scheduleTime: '00:00',
  enabled: true,
  createdAt: minutesAgo(60 * 48),
  updatedAt: minutesAgo(60 * 48),
  ...overrides,
})

const makeRun = (overrides: Partial<ScheduledJobRun> = {}): ScheduledJobRun => ({
  id: 'run-1',
  jobId: 'job-1',
  startedAt: minutesAgo(30),
  status: 'completed',
  ...overrides,
})

const fireAlarm = (name: string): Promise<void> => {
  const fired = alarmListeners.map((listener) => listener({ name }))
  return Promise.all(fired).then(() => undefined)
}

// The handlers are registered when the suite calls the export, so they are
// looked up lazily rather than captured at module-evaluation time.
const messageHandler = <T>(type: string): ScheduleHandler<T> => {
  const handler = scheduleHandlers.get(type)
  if (!handler) throw new Error(`no handler registered for ${type}`)
  return handler as unknown as ScheduleHandler<T>
}

const runJobOverMessaging = (jobId: string) =>
  messageHandler<{ jobId: string }>('runScheduledJob')({ data: { jobId } })

const cancelRunOverMessaging = (runId: string) =>
  messageHandler<{ runId: string }>('cancelScheduledJobRun')({
    data: { runId },
  })

const jobRuns = (jobId: string): ScheduledJobRun[] =>
  runs.filter((each) => each.jobId === jobId)

describe('scheduledJobRunsContract', () => {
  let originalChrome: typeof chrome | undefined

  beforeAll(async () => {
    originalChrome = globalThis.chrome
    globalThis.chrome = chromeFake as unknown as typeof chrome
    globalThis.Date = FixedDate as unknown as DateConstructor
    await scheduledJobRuns()
  })

  afterAll(() => {
    globalThis.chrome = originalChrome
    globalThis.Date = RealDate
  })

  beforeEach(() => {
    jobs = []
    runs = []
    alarmCreations.length = 0
    chatRequests.length = 0
    existingAlarms.clear()
    chatBehaviour = async (request) => {
      chatRequests.push(request)
      return cannedResponse
    }
  })

  it('scheduledJobRuns subscribes to the browser hooks and does nothing until an event arrives', () => {
    // One listener on each browser hook, and both schedule messages served.
    expect(alarmListeners.length).toBe(1)
    expect(startupListeners.length).toBe(1)
    expect(installedListeners.length).toBe(1)
    expect([...scheduleHandlers.keys()].sort()).toEqual([
      'cancelScheduledJobRun',
      'runScheduledJob',
    ])
    // And merely being wired up performed no work of its own.
    expect(runs).toEqual([])
    expect(chatRequests).toEqual([])
    expect(alarmCreations).toEqual([])
  })

  it('scheduledJobRuns ignores alarms that are not scheduled-job alarms', async () => {
    jobs = [makeJob()]

    await fireAlarm('keep-alive')

    expect(runs).toEqual([])
    expect(chatRequests).toEqual([])
  })

  it('scheduledJobRuns completes a run when the job alarm fires', async () => {
    jobs = [makeJob({ providerId: 'provider-a' })]

    await fireAlarm('scheduled-job-job-1')

    expect(chatRequests.length).toBe(1)
    expect(chatRequests[0].message).toBe('Summarise the news')
    expect(chatRequests[0].providerId).toBe('provider-a')

    expect(jobRuns('job-1').length).toBe(1)
    const run = jobRuns('job-1')[0]
    expect(run.status).toBe('completed')
    expect(run.result).toBe('The digest is ready.')
    expect(run.finalResult).toBe('FINAL RESULT')
    expect(run.executionLog).toBe('EXECUTION LOG')
    expect(run.toolCalls).toEqual(cannedResponse.toolCalls)
    expect(run.startedAt).toBe(VIRTUAL_NOW_ISO)
    expect(run.completedAt).toBe(VIRTUAL_NOW_ISO)

    // A completed attempt records when the job last ran.
    expect(jobs[0].lastRunAt).toBe(VIRTUAL_NOW_ISO)
  })

  it('scheduledJobRuns records a failed run when the job errors', async () => {
    jobs = [makeJob()]
    chatBehaviour = async (request) => {
      chatRequests.push(request)
      throw new Error('model unavailable')
    }

    await fireAlarm('scheduled-job-job-1')

    const run = jobRuns('job-1')[0]
    expect(run.status).toBe('failed')
    expect(run.result).toBe('model unavailable')
    expect(run.error).toBe('model unavailable')
    expect(run.completedAt).toBe(VIRTUAL_NOW_ISO)
    // A failed attempt still counts as an attempt.
    expect(jobs[0].lastRunAt).toBe(VIRTUAL_NOW_ISO)
  })

  it('scheduledJobRuns keeps at most fifteen runs per job', async () => {
    jobs = [makeJob()]
    const history = Array.from({ length: 15 }, (_, index) =>
      makeRun({
        id: `old-run-${index + 1}`,
        startedAt: minutesAgo(60 + (15 - index)),
      }),
    )
    runs = [...history, makeRun({ id: 'other-job-run', jobId: 'job-2' })]

    await fireAlarm('scheduled-job-job-1')

    // The new run plus the fourteen newest previous runs, oldest dropped.
    expect(jobRuns('job-1').length).toBe(15)
    const keptIds = jobRuns('job-1').map((each) => each.id)
    expect(keptIds).not.toContain('old-run-1')
    expect(keptIds).toContain('old-run-2')
    expect(keptIds).toContain('old-run-15')
    // Other jobs keep their history untouched.
    expect(jobRuns('job-2').length).toBe(1)
  })

  it('scheduledJobRuns runs a job asked for over messaging and reports success', async () => {
    jobs = [makeJob()]

    const reply = await runJobOverMessaging('job-1')

    expect(reply).toEqual({ success: true })
    expect(chatRequests.length).toBe(1)
    expect(jobRuns('job-1')[0].status).toBe('completed')
  })

  it('scheduledJobRuns reports failure when asked to run an unknown job', async () => {
    jobs = [makeJob()]

    const reply = await runJobOverMessaging('no-such-job')

    expect(reply).toEqual({
      success: false,
      error: 'Job not found: no-such-job',
    })
    expect(runs).toEqual([])
    expect(chatRequests).toEqual([])
  })

  it('scheduledJobRuns still reports success over messaging when the job itself fails', async () => {
    jobs = [makeJob()]
    chatBehaviour = async (request) => {
      chatRequests.push(request)
      throw new Error('model unavailable')
    }

    const reply = await runJobOverMessaging('job-1')

    // The transport succeeded; the failure is recorded on the run.
    expect(reply).toEqual({ success: true })
    expect(jobRuns('job-1')[0].status).toBe('failed')
    expect(jobRuns('job-1')[0].error).toBe('model unavailable')
  })

  it('scheduledJobRuns refuses to cancel a run that is not in flight', async () => {
    const reply = await cancelRunOverMessaging('gone')

    expect(reply).toEqual({
      success: false,
      error: 'Run not found or already completed',
    })
  })

  it('scheduledJobRuns cancels an in-flight run and marks it cancelled', async () => {
    jobs = [makeJob()]
    let rejectChat: (error: Error) => void = () => {}
    chatBehaviour = (request) => {
      chatRequests.push(request)
      return new Promise((_resolve, reject) => {
        rejectChat = reject
      })
    }

    const started = runJobOverMessaging('job-1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const inFlight = jobRuns('job-1').find((each) => each.status === 'running')
    expect(inFlight).toBeDefined()

    const reply = await cancelRunOverMessaging(inFlight.id)
    expect(reply).toEqual({ success: true })

    rejectChat(new Error('the request was aborted'))
    expect(await started).toEqual({ success: true })

    const run = jobRuns('job-1')[0]
    expect(run.status).toBe('failed')
    expect(run.result).toBe('Cancelled by user')
    expect(run.error).toBe('Cancelled by user')
    expect(jobs[0].lastRunAt).toBe(VIRTUAL_NOW_ISO)

    // Once the run has settled it can no longer be cancelled.
    const again = await cancelRunOverMessaging(inFlight.id)
    expect(again).toEqual({
      success: false,
      error: 'Run not found or already completed',
    })
  })

  it('scheduledJobRuns on startup fails stale running runs and creates missing alarms', async () => {
    // A recent run keeps this job out of the missed-jobs pass, isolating the
    // cleanup and the alarm sync.
    jobs = [
      makeJob(),
      makeJob({ id: 'job-2', enabled: false, name: 'Disabled digest' }),
    ]
    runs = [
      makeRun({ startedAt: minutesAgo(30) }),
      makeRun({
        id: 'stale-run',
        jobId: 'job-2',
        status: 'running',
        startedAt: minutesAgo(20),
      }),
    ]

    await startupListeners[0]()

    // A run still marked running after ten minutes is failed as timed out.
    const stale = runs.find((each) => each.id === 'stale-run')
    expect(stale.status).toBe('failed')
    expect(stale.result).toBe('Job timed out!')
    expect(stale.completedAt).toBe(VIRTUAL_NOW_ISO)
    // A fresh run is left alone.
    expect(runs.find((each) => each.id === 'run-1').status).toBe('completed')
    // No new work was started, and only the enabled job got an alarm.
    expect(runs.length).toBe(2)
    expect(chatRequests).toEqual([])
    expect(alarmCreations.map((each) => each.id)).toEqual(['job-1'])
  })

  it('scheduledJobRuns on startup runs a daily job whose time has come and was missed', async () => {
    jobs = [
      makeJob(),
      makeJob({ id: 'job-2', enabled: false, name: 'Disabled digest' }),
    ]

    await startupListeners[0]()

    expect(chatRequests.length).toBe(1)
    expect(chatRequests[0].message).toBe('Summarise the news')
    expect(jobRuns('job-1').length).toBe(1)
    expect(jobRuns('job-1')[0].status).toBe('completed')
    expect(jobs.find((each) => each.id === 'job-1').lastRunAt).toBe(
      VIRTUAL_NOW_ISO,
    )
    // A disabled job is neither run nor given an alarm.
    expect(jobRuns('job-2')).toEqual([])
    expect(alarmCreations.map((each) => each.id)).toEqual(['job-1'])
  })

  it('scheduledJobRuns defers a daily job whose time has not come yet today', async () => {
    // With the clock frozen at noon UTC, 23:59 local is still ahead today in
    // every timezone (noon UTC is between 00:00 and 02:00 local everywhere).
    jobs = [makeJob({ scheduleTime: '23:59' })]

    await startupListeners[0]()

    expect(runs).toEqual([])
    expect(chatRequests).toEqual([])
    // The alarm for the next occurrence is still put in place.
    expect(alarmCreations.map((each) => each.id)).toEqual(['job-1'])
  })

  it('scheduledJobRuns on startup honours the interval of recurring jobs', async () => {
    jobs = [
      makeJob({
        id: 'job-frequent',
        name: 'Every five minutes',
        scheduleType: 'minutes',
        scheduleInterval: 5,
        createdAt: minutesAgo(2),
        updatedAt: minutesAgo(2),
      }),
      makeJob({
        id: 'job-hourly',
        name: 'Every hour',
        scheduleType: 'hourly',
        scheduleInterval: 1,
        createdAt: minutesAgo(150),
        updatedAt: minutesAgo(150),
      }),
    ]

    await startupListeners[0]()

    // Two minutes of a five-minute interval have passed: not yet due.
    // Two and a half hours of a one-hour interval have passed: due.
    expect(chatRequests.length).toBe(1)
    expect(jobRuns('job-frequent')).toEqual([])
    expect(jobRuns('job-hourly')[0].status).toBe('completed')
  })

  it('scheduledJobRuns on startup reruns a job only outside the last day', async () => {
    jobs = [
      makeJob({
        id: 'job-recent',
        name: 'Ran an hour shy of a day ago',
      }),
      makeJob({
        id: 'job-older',
        name: 'Ran a day and an hour ago',
      }),
    ]
    runs = [
      makeRun({ id: 'recent-run', jobId: 'job-recent', startedAt: minutesAgo(23 * 60) }),
      makeRun({ id: 'older-run', jobId: 'job-older', startedAt: minutesAgo(25 * 60) }),
    ]

    await startupListeners[0]()

    expect(chatRequests.length).toBe(1)
    expect(jobRuns('job-recent').length).toBe(1)
    expect(jobRuns('job-older').length).toBe(2)
    expect(jobRuns('job-older').map((each) => each.status)).toEqual([
      'completed',
      'completed',
    ])
  })

  it('scheduledJobRuns treats a fresh install like a startup', async () => {
    jobs = [makeJob()]

    await installedListeners[0]()

    expect(jobRuns('job-1').length).toBe(1)
    expect(jobRuns('job-1')[0].status).toBe('completed')
    expect(alarmCreations.map((each) => each.id)).toEqual(['job-1'])
  })

  it('scheduledJobRuns leaves an existing job alarm alone', async () => {
    jobs = [makeJob()]
    runs = [makeRun({ startedAt: minutesAgo(30) })]
    existingAlarms.set('scheduled-job-job-1', { name: 'scheduled-job-job-1' })

    await startupListeners[0]()

    expect(alarmCreations).toEqual([])
    expect(runs.length).toBe(1)
  })
})
