/**
 * Contract suite for the exports of ScheduledTaskCard.tsx.
 *
 * The module exports exactly one symbol: `ScheduledTaskCard`. The single
 * assertion block below renders that export repeatedly and asserts on the
 * markup it emits, so the suite pins observable behaviour rather than the
 * shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ScheduledTaskCard`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's storage layer cannot even be imported under `bun test`
 * here: `@/lib/schedules/scheduleStorage` and `@/lib/llm-providers/storage`
 * both reach `@/generated/graphql/gql`, a codegen artifact this tree does
 * not carry, and both talk to extension storage and the backend at runtime.
 * They are swapped for in-memory stubs via `mock.module`, so this suite
 * needs no network, no database and no container.
 *
 * Not pinned, and why: the per-run rows (status marks, durations, retry
 * and cancel affordances, newest-first ordering) sit inside a Radix
 * Collapsible that starts closed - the server-rendered content node is
 * empty until a user opens it - and the provider badge is filled in by an
 * effect that reads provider storage. Opening the panel dispatches DOM
 * events and the effect needs a storage round trip; there is no DOM
 * environment available to `bun test` in this project - `@testing-library`,
 * `happy-dom` and `jsdom` are all absent from the lockfile - and
 * `renderToString` runs no effects. Only what a user sees on first paint
 * is pinned. That is a gap in interaction coverage, not an export left
 * unexercised: the export itself is rendered and asserted on, so no export
 * belongs in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import type { ComponentProps } from 'react'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { ScheduledJob, ScheduledJobRun } from './types'

let jobRuns: ScheduledJobRun[] = []

mock.module('@/lib/schedules/scheduleStorage', () => ({
  useScheduledJobRuns: () => ({ jobRuns }),
}))

mock.module('@/lib/llm-providers/storage', () => ({
  providersStorage: {
    getValue: () => Promise.resolve([]),
  },
}))

const { ScheduledTaskCard } = await import('./ScheduledTaskCard')

const noop = () => {}

const jobWith = (overrides: Partial<ScheduledJob>): ScheduledJob => ({
  id: 'job-1',
  name: 'Morning Brief',
  query: 'Summarize tech news',
  scheduleType: 'daily',
  scheduleTime: '09:00',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const runWith = (overrides: Partial<ScheduledJobRun>): ScheduledJobRun => ({
  id: 'run-1',
  jobId: 'job-1',
  startedAt: '2026-01-02T10:00:00.000Z',
  status: 'completed',
  ...overrides,
})

// SSR may interleave adjacent text nodes with comment markers; a reader
// sees through them, so assertions read the markup with markers dropped.
const visibleText = (html: string): string => html.replaceAll('<!-- -->', '')

const renderCard = (overrides: Partial<ScheduledJob>): string =>
  visibleText(
    renderToString(
      createElement(ScheduledTaskCard, {
        job: jobWith(overrides),
        onEdit: noop,
        onDelete: noop,
        onToggle: noop,
        onRun: noop,
        onViewRun: noop,
        onCancelRun: noop,
        onRetryRun: noop,
      } satisfies ComponentProps<typeof ScheduledTaskCard>),
    ),
  )

describe('ScheduledTaskCardTsxContract', () => {
  it('ScheduledTaskCard renders the job header, schedule wording, enabled state and run-history affordance', () => {
    // Sixty minutes ago lands mid-range of "an hour ago", far from any
    // rounding boundary, so the relative-time wording is stable.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    jobRuns = [
      runWith({ id: 'run-1' }),
      runWith({ id: 'run-2', startedAt: '2026-01-02T09:00:00.000Z' }),
      runWith({ id: 'run-other', jobId: 'job-9' }),
    ]

    const briefHtml = renderCard({ lastRunAt: hourAgo })

    // The card names the task and quotes its prompt verbatim.
    expect(briefHtml).toContain('>Morning Brief<')
    expect(briefHtml).toContain('&quot;Summarize tech news&quot;')
    // A daily job with a time states the time.
    expect(briefHtml).toContain('Daily at 09:00')
    // The most recent run is described in relative terms.
    expect(briefHtml).toContain('Last run: an hour ago')
    // The run-history trigger counts only this job's runs: two of the
    // three stubbed runs belong to job-1, the third belongs to job-9.
    expect(briefHtml).toContain('Run History (2)')
    expect(briefHtml).not.toContain('Run History (3)')
    // The history trigger starts collapsed, per the closed content node.
    expect(briefHtml).toContain('aria-expanded="false"')
    // An enabled task is a checked switch offering to disable itself.
    expect(briefHtml).toContain('role="switch"')
    expect(briefHtml).toContain('aria-checked="true"')
    expect(briefHtml).toContain('aria-label="Disable Morning Brief"')
    expect(briefHtml).not.toContain('>Disabled<')
    // The three header actions render: run, edit, delete.
    expect(briefHtml).toContain('>Test<')
    expect(briefHtml).toContain('>Edit<')
    expect(briefHtml).toContain('aria-label="Delete Morning Brief"')

    const syncHtml = renderCard({
      id: 'job-2',
      name: 'Hourly Sync',
      query: 'Check the feed',
      scheduleType: 'hourly',
      scheduleInterval: 3,
      scheduleTime: undefined,
      enabled: false,
    })

    // An interval job states its cadence in plain words.
    expect(syncHtml).toContain('Every 3 hours')
    expect(syncHtml).toContain('>Hourly Sync<')
    expect(syncHtml).toContain('&quot;Check the feed&quot;')
    // A disabled task is an unchecked switch offering to enable itself,
    // and it wears the Disabled badge next to its name.
    expect(syncHtml).toContain('aria-checked="false"')
    expect(syncHtml).toContain('aria-label="Enable Hourly Sync"')
    expect(syncHtml).toContain('>Disabled<')
    // A task with no recorded runs offers no history and says nothing
    // about a last run.
    expect(syncHtml).not.toContain('Run History')
    expect(syncHtml).not.toContain('Last run:')

    // Every remaining cadence is worded, including the unscheduled one.
    expect(
      renderCard({
        scheduleType: 'hourly',
        scheduleInterval: 1,
        scheduleTime: undefined,
      }),
    ).toContain('Every hour')
    expect(
      renderCard({
        scheduleType: 'minutes',
        scheduleInterval: 1,
        scheduleTime: undefined,
      }),
    ).toContain('Every minute')
    expect(
      renderCard({
        scheduleType: 'minutes',
        scheduleInterval: 5,
        scheduleTime: undefined,
      }),
    ).toContain('Every 5 minutes')
    expect(
      renderCard({ scheduleType: 'daily', scheduleTime: undefined }),
    ).toContain('Not scheduled')
  })
})
