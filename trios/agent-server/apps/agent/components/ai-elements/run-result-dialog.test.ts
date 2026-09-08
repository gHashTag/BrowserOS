/**
 * Contract suite for the exports of run-result-dialog.tsx.
 *
 * The module exports exactly one symbol: `RunResultDialog`. Every
 * assertion below renders that export with `renderToString` and asserts
 * on the markup it emits, so the suite pins observable behaviour rather
 * than the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`RunResultDialog`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component is purely presentational: it renders from its props and
 * needs no network, database or container.
 *
 * Why `@radix-ui/react-portal` is stubbed: the real Radix portal mounts
 * its children into `document.body`, and the container only exists once
 * a layout effect has run - on the server the portal therefore renders
 * null and the entire dialog body is invisible to `renderToString`. The
 * stub renders the very same wrapper div the real portal produces, just
 * in place instead of mounted into a document that does not exist. It
 * is a stub of a rendering-environment dependency, not of the subject:
 * the project's own dialog wrapper, the Radix dialog context, the
 * overlay, the title and the buttons all run for real.
 *
 * `bun test` runs every file of a group in one shared process, so the
 * stub leaks into files loaded after this one. It stays faithful to the
 * real portal for them: Radix already renders a closed dialog's content
 * as nothing (presence is driven by the dialog's open state, not by the
 * portal), so suites that assert on closed dialogs observe exactly what
 * they observed before.
 *
 * Not pinned, and why:
 *   - Click wiring: Cancel calling `onCancelRun(run.id)`, Retry calling
 *     `onRetryRun(run.jobId)` and closing, Copy writing to
 *     `navigator.clipboard` and swapping to "Copied", Close calling
 *     `onOpenChange(false)`. Dispatching DOM events needs a DOM
 *     environment, and none is available to `bun test` here:
 *     `@testing-library`, `happy-dom` and `jsdom` are all absent from
 *     the lockfile. The rendered markup of each control is still
 *     pinned.
 *   - The body text of a successful result. Streamdown parses its
 *     blocks into component state from inside an effect, so on the
 *     server the markdown container renders empty and the result text
 *     never reaches the markup. Only the prose container the subject
 *     wraps around the result is observable here, and only that is
 *     asserted.
 *   - The formatted start time assumes the suite runs in UTC, the
 *     timezone of this container; the durations are
 *     timezone-independent.
 */
import { describe, expect, it, mock } from 'bun:test'
import { type ComponentProps, createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import type { ScheduledJobRun } from '@/lib/schedules/scheduleTypes'

// See the header: render the portal's wrapper div in place, because
// there is no document to mount it into.
mock.module('@radix-ui/react-portal', () => {
  const Portal = ({
    asChild: _asChild,
    container: _container,
    children,
    ...rest
  }: {
    asChild?: boolean
    children?: ReactNode
    container?: unknown
  } & Record<string, unknown>) => createElement('div', rest, children)
  return { Portal, Root: Portal }
})

const { RunResultDialog } = await import('./run-result-dialog')

const makeRun = (over: Partial<ScheduledJobRun>): ScheduledJobRun => ({
  id: 'run-1',
  jobId: 'job-9',
  startedAt: '2024-06-15T13:00:00Z',
  status: 'completed',
  ...over,
})

const renderDialog = (props: ComponentProps<typeof RunResultDialog>): string =>
  renderToString(createElement(RunResultDialog, props))

const noop = () => {}

describe('runResultDialogTsxContract', () => {
  it('RunResultDialog renders status, timing and controls for each kind of run', () => {
    // A missing run renders nothing at all.
    expect(renderDialog({ run: null, onOpenChange: noop })).toBe('')

    // A completed run with a result: opens a dialog named after the
    // job, green check icon, start time and elapsed time, the markdown
    // prose container, and a copy control.
    const done = renderDialog({
      run: makeRun({
        completedAt: '2024-06-15T13:02:30Z',
        result: 'Report delivered: 3 pages summarised.',
      }),
      jobName: 'Morning Report',
      onOpenChange: noop,
    })
    expect(done).toContain('role="dialog"')
    expect(done).toContain('sm:w-[70vw] sm:max-w-4xl')
    expect(done).toContain('Morning Report')
    expect(done).not.toContain('Run Result')
    expect(done).toContain('lucide-circle-check')
    expect(done).toContain('text-green-500')
    expect(done).not.toContain('lucide-circle-x')
    expect(done).not.toContain('lucide-loader-circle')
    expect(done).toContain('Jun 15, 2024, 1:00 PM')
    expect(done).toContain('2m 30s')
    expect(done).toContain('prose prose-sm dark:prose-invert')
    expect(done).not.toContain('Task failed')
    expect(done).not.toContain('No result available')
    expect(done).toContain('>Copy<')
    expect(done).not.toContain('>Retry<')
    expect(done).not.toContain('>Cancel<')
    expect(done).toContain('>Close<')

    // A completed run with no result and no job name: the generic
    // title, sub-minute duration wording, and an explicit empty-state
    // message in place of a result.
    const empty = renderDialog({
      run: makeRun({ completedAt: '2024-06-15T13:00:05Z' }),
      onOpenChange: noop,
    })
    expect(empty).toContain('Run Result')
    expect(empty).toContain('5 seconds')
    expect(empty).toContain('No result available')
    expect(empty).not.toContain('prose prose-sm')
    expect(empty).not.toContain('>Copy<')
    expect(empty).toContain('>Close<')

    // A failed run with a result: red cross icon, a failure panel
    // carrying the error text, and both retry and copy controls.
    const failed = renderDialog({
      run: makeRun({
        status: 'failed',
        completedAt: '2024-06-15T13:00:05Z',
        result: 'The agent could not reach the mailbox.',
      }),
      onOpenChange: noop,
      onRetryRun: noop,
    })
    expect(failed).toContain('lucide-circle-x')
    expect(failed).not.toContain('lucide-circle-check')
    expect(failed).toContain('Task failed')
    expect(failed).toContain('The agent could not reach the mailbox.')
    expect(failed).not.toContain('prose prose-sm')
    expect(failed).toContain('>Retry<')
    expect(failed).toContain('>Copy<')
    expect(failed).not.toContain('>Cancel<')
    expect(failed).toContain('>Close<')

    // A failed run without a retry handler offers no retry button.
    const failedNoRetry = renderDialog({
      run: makeRun({
        status: 'failed',
        completedAt: '2024-06-15T13:00:05Z',
        result: 'The agent could not reach the mailbox.',
      }),
      onOpenChange: noop,
    })
    expect(failedNoRetry).not.toContain('>Retry<')
    expect(failedNoRetry).toContain('>Close<')

    // A running run: spinner icon, "Still running" in place of a
    // duration, a destructive cancel control, and no copy button
    // without a result.
    const running = renderDialog({
      run: makeRun({ status: 'running' }),
      onOpenChange: noop,
      onCancelRun: noop,
    })
    expect(running).toContain('lucide-loader-circle')
    expect(running).toContain('animate-spin')
    expect(running).not.toContain('lucide-circle-check')
    expect(running).toContain('Still running')
    expect(running).toContain('No result available')
    expect(running).toContain('data-variant="destructive"')
    expect(running).toContain('>Cancel<')
    expect(running).not.toContain('>Copy<')
    expect(running).not.toContain('>Retry<')
    expect(running).toContain('>Close<')

    // A running run without a cancel handler offers no cancel button.
    const runningNoCancel = renderDialog({
      run: makeRun({ status: 'running' }),
      onOpenChange: noop,
    })
    expect(runningNoCancel).not.toContain('>Cancel<')
    expect(runningNoCancel).toContain('>Close<')
  })
})
