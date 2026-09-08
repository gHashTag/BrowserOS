/**
 * Contract suite for the exports of ExecutionStepItem.tsx.
 *
 * The module exports exactly one symbol: `ExecutionStepItem`. The test
 * below renders that export with `renderToString` and asserts on the
 * markup it emits for every branch of its render tree, so the suite pins
 * observable behaviour rather than the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ExecutionStepItem`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component is a pure function of its `step` and `defaultOpen` props
 * and talks to nothing outside its render tree, so the suite needs no
 * network, no database and no container.
 *
 * Not pinned, and why: two behaviours that are visible in a browser are
 * not visible to `bun test` in this project.
 *   1. Clicking the header button toggles the step open and closed. There
 *      is no DOM environment available to `bun test` here -
 *      `@testing-library`, `happy-dom` and `jsdom` are all absent from
 *      the lockfile - so click handling cannot be driven; only the
 *      initial render of each open state is pinned, seeded through
 *      `defaultOpen`.
 *   2. The highlighted JSON of the input and output payloads is produced
 *      asynchronously by `shiki` inside `CodeBlock`, after mount, so the
 *      server-rendered markup carries the section headings but not the
 *      payload text.
 *
 * Neither gap leaves an export unexercised: the export itself is rendered
 * and asserted on, so no export belongs in the blocked list above.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { ExecutionStepRecord } from '../../lib/execution-history/types'
import { ExecutionStepItem } from './ExecutionStepItem'

const makeStep = (
  overrides: Partial<ExecutionStepRecord> = {},
): ExecutionStepRecord => ({
  id: 'step-1',
  toolName: 'navigate_page',
  order: 0,
  state: 'output-available',
  startedAt: '2026-01-01T10:00:00.000Z',
  previewText: 'Fetching weather for Paris',
  ...overrides,
})

const renderStep = (
  step: ExecutionStepRecord,
  props: { defaultOpen?: boolean } = {},
): string =>
  renderToString(createElement(ExecutionStepItem, { step, ...props }))

// Every state of a step, paired with the label its status badge shows.
const stateLabels: Array<[ExecutionStepRecord['state'], string]> = [
  ['input-streaming', 'Preparing'],
  ['input-available', 'Running'],
  ['approval-requested', 'Approval Needed'],
  ['approval-responded', 'Approval Responded'],
  ['output-available', 'Completed'],
  ['output-denied', 'Denied'],
  ['output-error', 'Error'],
]

// Every state of a step, paired with the icon its status glyph shows.
const stateIcons: Array<[ExecutionStepRecord['state'], string]> = [
  ['output-available', 'lucide-circle-check'],
  ['input-streaming', 'lucide-clock-3'],
  ['input-available', 'lucide-clock-3'],
  ['approval-requested', 'lucide-clock-3'],
  ['approval-responded', 'lucide-shield-check'],
  ['output-denied', 'lucide-shield-alert'],
  ['output-error', 'lucide-circle-x'],
]

// States in which the running preview line is shown in the header.
const previewStates: Array<ExecutionStepRecord['state']> = [
  'input-streaming',
  'input-available',
  'approval-requested',
  'approval-responded',
]

// States in which the running preview line is no longer shown.
const terminalStates = [
  'output-available',
  'output-error',
  'output-denied',
] as const

describe('ExecutionStepItemTsxContract', () => {
  it('ExecutionStepItem renders the step header, badges, icons and body from its props', () => {
    // The tool name is humanised for display: underscores become spaces,
    // camelCase words come apart, and the first letter is capitalised.
    expect(renderStep(makeStep())).toContain('>Navigate page</p>')
    expect(renderStep(makeStep({ toolName: 'openNewTab' }))).toContain(
      '>Open New Tab</p>',
    )
    expect(renderStep(makeStep({ toolName: 'bash' }))).toContain('>Bash</p>')
    // The expand affordance is part of every header.
    expect(renderStep(makeStep())).toContain('lucide-chevron-down')

    // Each step state shows its own status badge label.
    for (const [state, label] of stateLabels) {
      expect(renderStep(makeStep({ state }))).toContain(`>${label}</span>`)
    }

    // Each step state shows its own status icon.
    for (const [state, icon] of stateIcons) {
      expect(renderStep(makeStep({ state }))).toContain(icon)
    }

    // The running preview line is shown only while the step has not yet
    // reached a terminal state.
    for (const state of previewStates) {
      expect(renderStep(makeStep({ state }))).toContain(
        '>Fetching weather for Paris</p>',
      )
    }
    for (const state of terminalStates) {
      expect(renderStep(makeStep({ state }))).not.toContain(
        'Fetching weather for Paris',
      )
    }

    // A step blocked by an ACL rule carries an extra badge, whichever
    // field of the record carries the marker.
    expect(
      renderStep(
        makeStep({
          state: 'input-available',
          previewText: 'Blocked by ACL rule',
        }),
      ),
    ).toContain('>ACL Blocked</span>')
    expect(
      renderStep(
        makeStep({
          state: 'output-error',
          errorText: 'Action blocked by ACL rule: write outside the sandbox',
        }),
      ),
    ).toContain('>ACL Blocked</span>')
    expect(
      renderStep(
        makeStep({
          state: 'output-denied',
          approval: {
            id: 'appr-1',
            approved: false,
            reason: 'Action blocked by ACL rule: filesystem guard',
          },
        }),
      ),
    ).toContain('>ACL Blocked</span>')
    expect(renderStep(makeStep({ state: 'input-available' }))).not.toContain(
      'ACL Blocked',
    )

    // A step renders collapsed by default: the trigger reports itself
    // closed and the body markup is absent entirely.
    const collapsed = renderStep(
      makeStep({
        input: { url: 'https://example.com' },
        output: { pageId: 7 },
      }),
    )
    expect(collapsed).toContain('aria-expanded="false"')
    expect(collapsed).toContain('data-state="closed"')
    expect(collapsed).not.toContain('rotate-180')
    expect(collapsed).not.toContain('Parameters')
    expect(collapsed).not.toContain('Result')
    expect(collapsed).not.toContain('data-state="open"')

    // Opened through defaultOpen, the body shows the parameters and the
    // result of the step.
    const expanded = renderStep(
      makeStep({
        input: { url: 'https://example.com' },
        output: { pageId: 7 },
      }),
      { defaultOpen: true },
    )
    expect(expanded).toContain('aria-expanded="true"')
    expect(expanded).toContain('data-state="open"')
    expect(expanded).toContain('rotate-180')
    expect(expanded).toContain('>Parameters</h4>')
    expect(expanded).toContain('>Result</h4>')
    expect(expanded).not.toContain('>Error</h4>')

    // Sections whose payload is missing are omitted rather than rendered
    // empty: no input means no parameters block, and a finished step with
    // neither output nor error text renders no result block at all.
    const bareExpanded = renderStep(
      makeStep({ input: undefined, output: undefined }),
      { defaultOpen: true },
    )
    expect(bareExpanded).not.toContain('>Parameters</h4>')
    expect(bareExpanded).not.toContain('>Result</h4>')
    expect(bareExpanded).not.toContain('>Error</h4>')

    // A denied step shows the recorded approval reason as its result, and
    // falls back to fixed copy when no reason was recorded.
    const deniedWithReason = renderStep(
      makeStep({
        state: 'output-denied',
        approval: {
          id: 'appr-2',
          approved: false,
          reason: 'Writes outside the workspace are not allowed',
        },
      }),
      { defaultOpen: true },
    )
    expect(deniedWithReason).toContain('>Result</h4>')
    expect(deniedWithReason).toContain(
      'Writes outside the workspace are not allowed',
    )
    expect(deniedWithReason).not.toContain('The requested action was denied.')
    const deniedWithoutReason = renderStep(
      makeStep({ state: 'output-denied' }),
      { defaultOpen: true },
    )
    expect(deniedWithoutReason).toContain('The requested action was denied.')

    // A failed step shows its error text under an error heading instead
    // of a result heading.
    const errored = renderStep(
      makeStep({
        state: 'output-error',
        errorText: 'Timed out after 30 seconds',
      }),
      { defaultOpen: true },
    )
    expect(errored).toContain('>Error</h4>')
    expect(errored).toContain('Timed out after 30 seconds')
    expect(errored).not.toContain('>Result</h4>')
  })
})
