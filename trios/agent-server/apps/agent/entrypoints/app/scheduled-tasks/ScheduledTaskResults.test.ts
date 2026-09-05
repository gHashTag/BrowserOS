/**
 * Contract suite for ScheduledTaskResults.tsx.
 *
 * The module under test exports exactly one symbol, the ScheduledTaskResults
 * component, and every assertion below renders that export and inspects the
 * markup it produces, so a reader can map the whole file onto the export.
 *
 * No export was left unexercised, so there is no dependency-blocked list for
 * this module. The component reads its data through the two hooks from
 * @/lib/schedules/scheduleStorage; those hooks are replaced with controlled
 * doubles before the subject loads, which keeps this suite free of browser
 * storage, network, database and container needs.
 *
 * Note: dispatching a real click would need a DOM event system that a plain
 * `bun test` run does not provide. The interactive wiring is pinned through
 * the presence and the status gating of the rendered controls
 * (aria-label="Cancel run" for running runs, aria-label="Retry run" for
 * failed runs) rather than through dispatched events.
 */

import { describe, expect, it, mock } from 'bun:test'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type {
  ScheduledJob,
  ScheduledJobRun,
} from '@/lib/schedules/scheduleTypes'

dayjs.extend(relativeTime)

/** Controlled doubles: each render is driven by re-assigning these. */
let jobsNow: ScheduledJob[] = []
let runsNow: ScheduledJobRun[] = []

mock.module('@/lib/schedules/scheduleStorage', () => ({
  useScheduledJobs: () => ({ jobs: jobsNow }),
  useScheduledJobRuns: () => ({ jobRuns: runsNow }),
}))

const { ScheduledTaskResults } = await import('./ScheduledTaskResults.tsx')

const job = (id: string, name: string): ScheduledJob => ({
  id,
  name,
  query: `${name} query`,
  scheduleType: 'daily',
  scheduleTime: '09:00',
  enabled: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
})

const run = (
  id: string,
  jobId: string,
  status: ScheduledJobRun['status'],
  startedAt: string,
  result?: string,
): ScheduledJobRun => ({
  id,
  jobId,
  startedAt,
  status,
  ...(result === undefined ? {} : { result }),
})

const stamp = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString()

const noop = () => {}

const renderRuns = (jobs: ScheduledJob[], runs: ScheduledJobRun[]) => {
  jobsNow = jobs
  runsNow = runs
  return renderToString(
    createElement(ScheduledTaskResults, {
      onViewRun: noop,
      onCancelRun: noop,
      onRetryRun: noop,
    }),
  )
}

const firstIndex = (html: string, needle: string) => html.indexOf(needle)

describe('ScheduledTaskResultsTsxContract', () => {
  it('ScheduledTaskResults renders the empty state, orders and enriches runs, and gates the cancel and retry controls', () => {
    // With no runs at all, the component shows the empty state and no controls.
    const empty = renderRuns([], [])
    expect(empty).toContain('No task runs yet')
    expect(empty).not.toContain('aria-label="Cancel run"')
    expect(empty).not.toContain('aria-label="Retry run"')

    // A finished run renders its job's name, a relative timestamp of its
    // start, and its result text - and no per-run controls.
    const finishedAt = stamp(310)
    const finished = renderRuns(
      [job('job-digest', 'Morning Digest')],
      [run('run-1', 'job-digest', 'completed', finishedAt, 'Digest is ready')],
    )
    expect(finished).toContain('Morning Digest')
    expect(finished).toContain('Digest is ready')
    expect(finished).toContain(dayjs(finishedAt).fromNow())
    expect(finished).not.toContain('aria-label="Cancel run"')
    expect(finished).not.toContain('aria-label="Retry run"')

    // A run whose job id has no match still renders, and the names of
    // unrelated jobs do not leak into the output.
    const orphanAt = stamp(200)
    const orphan = renderRuns(
      [job('job-known', 'Known Job')],
      [run('run-2', 'job-gone', 'completed', orphanAt)],
    )
    expect(orphan).toContain(dayjs(orphanAt).fromNow())
    expect(orphan).not.toContain('Known Job')

    // A run without a result text renders no placeholder for it.
    const quiet = renderRuns(
      [job('job-quiet', 'Quiet Job')],
      [run('run-3', 'job-quiet', 'completed', stamp(125))],
    )
    expect(quiet).toContain('Quiet Job')
    expect(quiet).not.toContain('undefined')

    // Running runs come first, then finished runs newest-first.
    const liveAt = stamp(1)
    const failedAt = stamp(40)
    const midAt = stamp(400)
    const oldAt = stamp(605)
    const ordered = renderRuns(
      [
        job('job-old', 'Alpha Old'),
        job('job-live', 'Beta Live'),
        job('job-fail', 'Delta Fail'),
        job('job-mid', 'Gamma Mid'),
      ],
      [
        run('run-old', 'job-old', 'completed', oldAt, 'oldest outcome'),
        run('run-fail', 'job-fail', 'failed', failedAt, 'failed outcome'),
        run('run-live', 'job-live', 'running', liveAt),
        run('run-mid', 'job-mid', 'completed', midAt, 'middle outcome'),
      ],
    )
    expect(firstIndex(ordered, 'Beta Live')).toBeLessThan(
      firstIndex(ordered, 'Delta Fail'),
    )
    expect(firstIndex(ordered, 'Delta Fail')).toBeLessThan(
      firstIndex(ordered, 'Gamma Mid'),
    )
    expect(firstIndex(ordered, 'Gamma Mid')).toBeLessThan(
      firstIndex(ordered, 'Alpha Old'),
    )
    expect(ordered).toContain('aria-label="Cancel run"')

    // A failed run offers retry, not cancel.
    const retryOnly = renderRuns(
      [job('job-flare', 'Flare')],
      [run('run-f', 'job-flare', 'failed', stamp(30))],
    )
    expect(retryOnly).toContain('aria-label="Retry run"')
    expect(retryOnly).not.toContain('aria-label="Cancel run"')
  })
})
