/**
 * First test suite for components/ai-elements/reasoning.tsx.
 *
 * Pins the three exports of that module - Reasoning, ReasoningTrigger and
 * ReasoningContent - through their server-rendered output. Server rendering
 * needs no DOM, no network, no database and no container, so the suite runs
 * anywhere `bun test` does (it is picked up by the existing agent test group,
 * `bun test ./apps/agent`). Each `it` below is named after the export it
 * exercises, so a reader can map assertions one-to-one onto the module's
 * public surface.
 *
 * Not pinned here - behaviours that live inside effects and therefore need a
 * live DOM with timers (jsdom or happy-dom plus a user-event driver; neither
 * is a dependency of this tree, and introducing one is outside this suite's
 * scope):
 *  - the auto-close timer that collapses the panel ~1s after streaming ends,
 *  - the wall-clock duration accumulated between streaming start and end,
 *  - click-driven open/close toggling of the underlying Radix collapsible.
 * All three exports are nevertheless exercised by the assertions below; none
 * of them is blocked wholesale by a missing dependency.
 *
 * The markdown-to-HTML conversion inside ReasoningContent is delegated to
 * Streamdown. In its default streaming mode Streamdown defers block rendering
 * to an effect, so the converted markup never appears in a server render and
 * is not asserted here; what the server render does show - the collapsible
 * content shell, its state, and the Streamdown container - is pinned.
 */

import { describe, expect, it } from 'bun:test'
import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { Reasoning, ReasoningContent, ReasoningTrigger } from './reasoning'

const render = (element: ReactElement): string => renderToString(element)

// React separates adjacent text nodes with comment markers when serialising;
// strip them so human-visible text can be matched directly.
const visibleText = (html: string): string => html.replaceAll('<!-- -->', '')

describe('reasoningTsxContract', () => {
  it('Reasoning renders an open-by-default collapsible, honours defaultOpen/open and merges className', () => {
    // Open by default: root and trigger expose the open state.
    const openByDefault = render(
      createElement(Reasoning, null, createElement(ReasoningTrigger)),
    )
    expect(openByDefault).toContain('data-state="open"')
    expect(openByDefault).toContain('aria-expanded="true"')

    // defaultOpen={false} starts collapsed.
    const closedByDefault = render(
      createElement(
        Reasoning,
        { defaultOpen: false },
        createElement(ReasoningTrigger),
      ),
    )
    expect(closedByDefault).toContain('data-state="closed"')
    expect(closedByDefault).toContain('aria-expanded="false"')

    // A controlled open={false} wins over the uncontrolled default.
    const controlledClosed = render(
      createElement(
        Reasoning,
        { open: false },
        createElement(ReasoningTrigger),
      ),
    )
    expect(controlledClosed).toContain('aria-expanded="false"')

    // A caller className is merged with, not swapped for, the built-in one.
    const styled = render(
      createElement(Reasoning, { className: 'suite-reasoning-probe' }),
    )
    expect(styled).toContain('suite-reasoning-probe')
    expect(styled).toContain('not-prose mb-4')

    // Props given to Reasoning reach descendants: a duration drives the
    // trigger's completed-thinking message through the shared context.
    const withDuration = render(
      createElement(
        Reasoning,
        { duration: 5 },
        createElement(ReasoningTrigger),
      ),
    )
    expect(visibleText(withDuration)).toContain('Thought for 5 seconds')
  })

  it('ReasoningTrigger shows the streaming, completed and unknown-duration messages, honours custom children, rotates its chevron and requires the Reasoning context', () => {
    // While streaming: the shimmering "Thinking..." label.
    const streaming = render(
      createElement(
        Reasoning,
        { isStreaming: true },
        createElement(ReasoningTrigger),
      ),
    )
    expect(visibleText(streaming)).toContain('Thinking...')

    // A zero duration counts as still thinking.
    const zeroDuration = render(
      createElement(
        Reasoning,
        { duration: 0 },
        createElement(ReasoningTrigger),
      ),
    )
    expect(visibleText(zeroDuration)).toContain('Thinking...')

    // Streaming finished with a known duration: the count is shown.
    const completed = render(
      createElement(
        Reasoning,
        { duration: 7 },
        createElement(ReasoningTrigger),
      ),
    )
    expect(visibleText(completed)).toContain('Thought for 7 seconds')

    // Streaming finished with an unknown duration: the fallback copy.
    const unknownDuration = render(
      createElement(Reasoning, null, createElement(ReasoningTrigger)),
    )
    expect(visibleText(unknownDuration)).toContain(
      'Thought for a few seconds',
    )

    // Custom children replace the built-in label entirely.
    const custom = render(
      createElement(
        Reasoning,
        { isStreaming: true },
        createElement(
          ReasoningTrigger,
          null,
          createElement('span', null, 'suite-trigger-custom-label'),
        ),
      ),
    )
    expect(custom).toContain('suite-trigger-custom-label')
    expect(visibleText(custom)).not.toContain('Thinking...')

    // The chevron points down while open and straightens while closed.
    const open = render(
      createElement(
        Reasoning,
        { defaultOpen: true },
        createElement(ReasoningTrigger),
      ),
    )
    expect(open).toContain('rotate-180')
    const closed = render(
      createElement(
        Reasoning,
        { defaultOpen: false },
        createElement(ReasoningTrigger),
      ),
    )
    expect(closed).toContain('rotate-0')

    // Outside a Reasoning provider the trigger refuses to render.
    expect(() => render(createElement(ReasoningTrigger))).toThrow(
      'Reasoning components must be used within Reasoning',
    )
  })

  it('ReasoningContent renders the collapsible markdown shell, tracks the parent open state, merges className and links to the trigger', () => {
    // The content area renders inside the collapsible with the Streamdown
    // container mounted, and its data-state follows the parent.
    const open = render(
      createElement(
        Reasoning,
        { defaultOpen: true },
        createElement(ReasoningTrigger),
        createElement(ReasoningContent, null, '**suite-bold** plan'),
      ),
    )
    expect(open).toContain('data-slot="collapsible-content"')
    expect(open).toContain('data-state="open"')
    expect(open).toContain('space-y-4')
    expect(open).toContain('mt-4 text-sm')

    // A caller className is merged with the built-in one.
    const styled = render(
      createElement(
        Reasoning,
        { defaultOpen: true },
        createElement(
          ReasoningContent,
          { className: 'suite-content-probe' },
          'plain text',
        ),
      ),
    )
    expect(styled).toContain('suite-content-probe')
    expect(styled).toContain('mt-4 text-sm')

    // When the parent starts closed the content area reports closed too.
    const closed = render(
      createElement(
        Reasoning,
        { defaultOpen: false },
        createElement(ReasoningTrigger),
        createElement(ReasoningContent, null, 'suite-hidden-body'),
      ),
    )
    expect(closed).toContain('data-state="closed"')

    // The trigger's aria-controls points at the content element's id.
    const controlsId = open.match(/aria-controls="([^"]+)"/)?.[1]
    expect(controlsId).toBeDefined()
    expect(open).toContain(`id="${controlsId}"`)
  })
})
