/**
 * Contract suite for the exports of ScheduleResults.tsx.
 *
 * The module exports exactly one symbol: `ScheduleResults`. Every
 * assertion below renders that export with `renderToString` and asserts
 * on the markup it emits, so the suite pins observable behaviour rather
 * than the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ScheduleResults`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's live dependencies are the extension storage hooks in
 * `@/lib/schedules/scheduleStorage` (backed by `@wxt-dev/storage` and
 * `chrome.*` extension APIs) plus the browser's `localStorage`. None of
 * those exist under `bun test`, so the hooks are swapped for in-memory
 * stubs via `mock.module` and a `localStorage` stand-in is installed on
 * the global object before the first render. The suite therefore needs
 * no network, no database and no container.
 *
 * Not pinned, and why: user interactions (clicking a run row to open the
 * result dialog, cancelling a running run, retrying a failed run,
 * toggling the section open and closed) dispatch DOM events through
 * Radix widgets, and the analytics calls they trigger ride on `chrome.*`
 * extension APIs. There is no DOM environment available to `bun test` in
 * this project - `@testing-library`, `happy-dom` and `jsdom` are all
 * absent from the lockfile - so only the component's rendered output is
 * pinned. That is a gap in interaction coverage, not an export left
 * unexercised: the export itself is rendered and asserted on, so no
 * export belongs in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type {
  ScheduledJob,
  ScheduledJobRun,
} from '@/lib/schedules/scheduleTypes'

/**
 * `bun test` provides no Web Storage, yet the component reads
 * `localStorage` during its very first render to restore the collapsed
 * state. This in-memory stand-in makes that browser API available, and
 * stays writable so individual scenarios can pre-seed it.
 */
const storageBacking = new Map<string, string>()
const localStorageStandIn = {
  getItem: (key: string) => storageBacking.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storageBacking.set(key, String(value))
  },
  removeItem: (key: string) => {
    storageBacking.delete(key)
  },
  clear: () => {
    storageBacking.clear()
  },
  key: (index: number) => Array.from(storageBacking.keys())[index] ?? null,
  get length() {
    return storageBacking.size
  },
}
const globalScope = globalThis as unknown as { localStorage?: unknown }
if (!globalScope.localStorage) {
  globalScope.localStorage = localStorageStandIn
}

type UseScheduledJobsResult = {
  jobs: ScheduledJob[]
  runJob: (id: string) => Promise<unknown>
}

type UseScheduledJobRunsResult = {
  jobRuns: ScheduledJobRun[]
  cancelJobRun: (runId: string) => Promise<unknown>
}

let jobsHook: UseScheduledJobsResult
let runsHook: UseScheduledJobRunsResult

mock.module('@/lib/schedules/scheduleStorage', () => ({
  useScheduledJobs: () => jobsHook,
  useScheduledJobRuns: () => runsHook,
}))

const { ScheduleResults } = await import('./ScheduleResults')

const COLLAPSED_KEY = 'schedule-results-collapsed'

const job = (id: string, name: string): ScheduledJob => ({
  id,
  name,
  query: `query for ${name}`,
  scheduleType: 'daily',
  scheduleTime: '08:00',
  enabled: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
})

const digestJob = job('job-digest', 'Morning digest')
const reportsJob = job('job-reports', 'Weekly reports')
const scraperJob = job('job-scraper', 'Price scraper')
const sweepJob = job('job-sweep', 'Mail sweep')

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString()

const jobRun = (input: {
  id: string
  jobId: string
  status: ScheduledJobRun['status']
  startedMinutesAgo: number
  result?: string
}): ScheduledJobRun => ({
  id: input.id,
  jobId: input.jobId,
  startedAt: minutesAgo(input.startedMinutesAgo),
  status: input.status,
  ...(input.result !== undefined ? { result: input.result } : {}),
})

const renderSubject = (options: {
  jobs?: ScheduledJob[]
  jobRuns?: ScheduledJobRun[]
  collapsedLastTime?: boolean
}): string => {
  jobsHook = {
    jobs: options.jobs ?? [],
    runJob: () => Promise.resolve(undefined),
  }
  runsHook = {
    jobRuns: options.jobRuns ?? [],
    cancelJobRun: () => Promise.resolve(undefined),
  }
  storageBacking.delete(COLLAPSED_KEY)
  if (options.collapsedLastTime) {
    storageBacking.set(COLLAPSED_KEY, 'true')
  }
  // React inserts "<!-- -->" separators between adjacent text nodes in
  // server-rendered markup (for example inside the count badge), so they
  // are stripped to assert on the text a user would actually read.
  return renderToString(createElement(ScheduleResults)).replace(/<!-- -->/g, '')
}

describe('ScheduleResultsTsxContract', () => {
  it('renders no markup at all while there are no job runs to show', () => {
    expect(renderSubject({ jobs: [digestJob] })).toBe('')
  })

  it('renders the section header, a running count badge and a link to the scheduled page', () => {
    const html = renderSubject({
      jobs: [digestJob],
      jobRuns: [
        jobRun({
          id: 'run-live',
          jobId: 'job-digest',
          status: 'running',
          startedMinutesAgo: 5,
        }),
      ],
    })

    expect(html).toContain('Scheduled Task Outputs')
    expect(html).toContain('1 running')
    expect(html).toContain('View more')
    expect(html).toContain('href="/app.html#/scheduled"')
  })

  it('omits the running count badge when nothing is executing', () => {
    const html = renderSubject({
      jobs: [digestJob],
      jobRuns: [
        jobRun({
          id: 'run-done',
          jobId: 'job-digest',
          status: 'completed',
          startedMinutesAgo: 30,
          result: 'digest done text',
        }),
      ],
    })

    expect(html).toContain('Scheduled Task Outputs')
    expect(html).toContain('digest done text')
    expect(html).not.toContain('running')
  })

  it('shows every running run in preference to finished ones once the display is full', () => {
    const html = renderSubject({
      jobs: [digestJob, reportsJob, scraperJob, sweepJob],
      jobRuns: [
        jobRun({
          id: 'run-a',
          jobId: 'job-digest',
          status: 'running',
          startedMinutesAgo: 12,
        }),
        jobRun({
          id: 'run-b',
          jobId: 'job-reports',
          status: 'running',
          startedMinutesAgo: 9,
        }),
        jobRun({
          id: 'run-c',
          jobId: 'job-scraper',
          status: 'running',
          startedMinutesAgo: 7,
        }),
        jobRun({
          id: 'run-d',
          jobId: 'job-sweep',
          status: 'running',
          startedMinutesAgo: 3,
        }),
        jobRun({
          id: 'run-old',
          jobId: 'job-digest',
          status: 'completed',
          startedMinutesAgo: 600,
          result: 'finished earlier text',
        }),
      ],
    })

    expect(html).toContain('Morning digest')
    expect(html).toContain('Weekly reports')
    expect(html).toContain('Price scraper')
    expect(html).toContain('Mail sweep')
    expect(html).toContain('4 running')
    expect(html).not.toContain('finished earlier text')
  })

  it('fills leftover display slots with the newest finished runs and drops the oldest overflow', () => {
    const html = renderSubject({
      jobs: [digestJob, reportsJob, scraperJob, sweepJob],
      jobRuns: [
        jobRun({
          id: 'run-live',
          jobId: 'job-sweep',
          status: 'running',
          startedMinutesAgo: 10,
        }),
        jobRun({
          id: 'run-oldest',
          jobId: 'job-digest',
          status: 'completed',
          startedMinutesAgo: 300,
          result: 'digest output text',
        }),
        jobRun({
          id: 'run-middle',
          jobId: 'job-reports',
          status: 'completed',
          startedMinutesAgo: 200,
        }),
        jobRun({
          id: 'run-newest',
          jobId: 'job-scraper',
          status: 'completed',
          startedMinutesAgo: 100,
        }),
      ],
    })

    const sweepAt = html.indexOf('Mail sweep')
    const newestAt = html.indexOf('Price scraper')
    const middleAt = html.indexOf('Weekly reports')

    expect(sweepAt).toBeGreaterThanOrEqual(0)
    expect(newestAt).toBeGreaterThan(sweepAt)
    expect(middleAt).toBeGreaterThan(newestAt)
    // The oldest finished run did not make the cut, by name or by result.
    expect(html).not.toContain('Morning digest')
    expect(html).not.toContain('digest output text')
  })

  it('labels each row with its job name, its relative start time and its result text', () => {
    const html = renderSubject({
      jobs: [digestJob, reportsJob],
      jobRuns: [
        jobRun({
          id: 'run-digest',
          jobId: 'job-digest',
          status: 'completed',
          startedMinutesAgo: 180,
          result: 'digest finished text',
        }),
        jobRun({
          id: 'run-reports',
          jobId: 'job-reports',
          status: 'completed',
          startedMinutesAgo: 120,
          result: 'reports finished text',
        }),
      ],
    })

    expect(html).toContain('Morning digest')
    expect(html).toContain('Weekly reports')
    expect(html).toContain('3 hours ago')
    expect(html).toContain('2 hours ago')
    expect(html).toContain('digest finished text')
    expect(html).toContain('reports finished text')
  })

  it('still renders a row for a run whose job no longer exists', () => {
    const html = renderSubject({
      jobs: [],
      jobRuns: [
        jobRun({
          id: 'run-orphan',
          jobId: 'job-vanished',
          status: 'completed',
          startedMinutesAgo: 90,
          result: 'orphaned run text',
        }),
      ],
    })

    expect(html).toContain('orphaned run text')
    expect(html).toContain('View more')
  })

  it('offers cancellation on running rows and retry on failed rows only', () => {
    const html = renderSubject({
      jobs: [digestJob, reportsJob, scraperJob],
      jobRuns: [
        jobRun({
          id: 'run-live',
          jobId: 'job-digest',
          status: 'running',
          startedMinutesAgo: 4,
        }),
        jobRun({
          id: 'run-failed',
          jobId: 'job-reports',
          status: 'failed',
          startedMinutesAgo: 240,
          result: 'reports failure text',
        }),
        jobRun({
          id: 'run-done',
          jobId: 'job-scraper',
          status: 'completed',
          startedMinutesAgo: 480,
          result: 'scraper done text',
        }),
      ],
    })

    // Exactly one row of three can be cancelled and exactly one can be
    // retried, so the completed row carries neither affordance.
    const cancelControls = html.match(/aria-label="Cancel run"/g) ?? []
    const retryControls = html.match(/aria-label="Retry run"/g) ?? []
    expect(cancelControls.length).toBe(1)
    expect(retryControls.length).toBe(1)
    expect(html).toContain('1 running')
    expect(html).toContain('reports failure text')
  })

  it('stays collapsed behind its header when it was collapsed the last time it rendered', () => {
    const jobs = [digestJob]
    const jobRuns = [
      jobRun({
        id: 'run-done',
        jobId: 'job-digest',
        status: 'completed',
        startedMinutesAgo: 150,
        result: 'digest output text',
      }),
    ]

    const collapsed = renderSubject({ jobs, jobRuns, collapsedLastTime: true })
    expect(collapsed).toContain('Scheduled Task Outputs')
    expect(collapsed).not.toContain('Morning digest')
    expect(collapsed).not.toContain('View more')

    const expanded = renderSubject({ jobs, jobRuns })
    expect(expanded).toContain('Morning digest')
    expect(expanded).toContain('View more')
  })
})
