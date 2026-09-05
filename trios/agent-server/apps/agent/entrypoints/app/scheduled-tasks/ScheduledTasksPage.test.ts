/**
 * Contract suite for the exports of ScheduledTasksPage.tsx.
 *
 * The module exports exactly one symbol: `ScheduledTasksPage`. The test
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ScheduledTasksPage`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's live dependencies are the extension storage, alarm and
 * messaging surfaces behind `@/lib/schedules/scheduleStorage`, and the
 * metrics adapter behind `@/lib/metrics/track`. Both modules are swapped
 * for inert in-memory stubs via `mock.module`, and the router hook the
 * page consumes is satisfied by a real `MemoryRouter`, so this suite
 * needs no network, no database and no container.
 *
 * Not pinned, and why: everything past the initial render. The tab strip
 * and both tab panes appear only after a `useEffect` reads
 * `scheduledJobRunStorage` and picks the starting tab; the create/edit
 * dialog opens only from a click or from the `openDialog` search-param
 * effect; the delete confirmation and the run-result viewer open only
 * from clicks. `renderToString` runs no effects and dispatches no
 * events, and there is no DOM environment available to `bun test` in
 * this project - `@testing-library`, `happy-dom` and `jsdom` are all
 * absent from the lockfile - so those transitions cannot be driven here.
 * That is a gap in interaction coverage, not an export left unexercised:
 * the export itself is rendered and asserted on, so no export belongs in
 * the blocked list above. What the suite pins is the one state every
 * visitor first sees: the header with its affordances, and every overlay
 * closed.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { scheduledTasksHelpUrl } from '../../../lib/constants/productUrls'
import type {
  ScheduledJob,
  ScheduledJobRun,
} from '../../../lib/schedules/scheduleTypes'

const job: ScheduledJob = {
  id: 'job-morning-brief',
  name: 'Morning brief',
  query: "Summarise today's top news",
  scheduleType: 'daily',
  scheduleTime: '09:00',
  scheduleInterval: 1,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const run: ScheduledJobRun = {
  id: 'run-morning-brief-1',
  jobId: job.id,
  startedAt: '2026-01-02T09:00:00.000Z',
  completedAt: '2026-01-02T09:02:00.000Z',
  status: 'completed',
}

/**
 * Stand-ins for the two hooks the page consumes. The mutators are inert:
 * under `renderToString` no event handler ever runs, so only the data the
 * hooks return can influence the markup, and even that waits behind the
 * tab state the initialisation effect would set.
 */
const jobsHook = {
  jobs: [job],
  addJob: () => Promise.resolve(undefined),
  editJob: () => Promise.resolve(undefined),
  toggleJob: () => Promise.resolve(undefined),
  removeJob: () => Promise.resolve(undefined),
  runJob: () => Promise.resolve(undefined),
}

const runsHook = {
  jobRuns: [run],
  cancelJobRun: () => Promise.resolve(undefined),
}

mock.module('@/lib/schedules/scheduleStorage', () => ({
  scheduledJobRunStorage: {
    getValue: () => Promise.resolve([run]),
  },
  useScheduledJobs: () => jobsHook,
  useScheduledJobRuns: () => runsHook,
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => undefined,
}))

/**
 * The provider storage would otherwise drag the generated GraphQL client
 * into the module graph. The page itself never touches these items
 * outside event handlers; the stubs exist so importing the page needs no
 * build artifact and no extension storage.
 */
mock.module('@/lib/llm-providers/storage', () => ({
  defaultProviderIdStorage: {
    getValue: () => Promise.resolve(undefined),
  },
  providersStorage: {
    getValue: () => Promise.resolve([]),
  },
  createDefaultBrowserOSProvider: () => ({
    id: 'browseros',
    name: 'BrowserOS',
    type: 'browseros',
  }),
}))

const { ScheduledTasksPage } = await import('./ScheduledTasksPage')

describe('ScheduledTasksPageTsxContract', () => {
  it('renders ScheduledTasksPage as the header alone, with the create, delete and run-result overlays closed and no tab strip yet', () => {
    const html = renderToString(
      createElement(MemoryRouter, null, createElement(ScheduledTasksPage)),
    )

    // The header is present with all three of its affordances: the page
    // title, the description beneath it, the New Task button, and the
    // link out to the scheduled-tasks documentation.
    expect(html).toContain('>Scheduled Tasks</h2>')
    expect(html).toContain('Automate recurring browser tasks')
    expect(html).toContain('New Task')
    expect(html).toContain(`href="${scheduledTasksHelpUrl}"`)

    // Every overlay starts closed. None of the three dialog titles is
    // emitted, and no dialog or alertdialog role appears anywhere in the
    // markup.
    expect(html).not.toContain('Create Scheduled Task')
    expect(html).not.toContain('Edit Scheduled Task')
    expect(html).not.toContain('Delete Scheduled Task')
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain('role="alertdialog"')

    // The tab strip and both tab panes are absent from the initial
    // render: the page mounts them only once the storage-backed
    // initialisation effect has picked a starting tab. Neither the tab
    // roles nor any job or run data has leaked into the markup.
    expect(html).not.toContain('role="tab"')
    expect(html).not.toContain('>Results<')
    expect(html).not.toContain('Morning brief')
    expect(html).not.toContain("Summarise today's top news")
  })
})
