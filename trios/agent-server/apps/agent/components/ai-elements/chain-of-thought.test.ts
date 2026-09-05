/**
 * Contract suite for the exports of chain-of-thought.tsx.
 *
 * The module exports exactly seven symbols: ChainOfThought,
 * ChainOfThoughtHeader, ChainOfThoughtStep, ChainOfThoughtSearchResults,
 * ChainOfThoughtSearchResult, ChainOfThoughtContent and
 * ChainOfThoughtImage. Every test below names the export it pins and asserts
 * on the markup that export emits, so a reader can map assertions to
 * exports and the suite pins observable behaviour rather than the shape of
 * the implementation.
 *
 * Export accounting (the module has 7 exports in total):
 *   - exercised by assertions below: 7
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 7 + 0 = 7, matching the export count of the module.
 *
 * None of the seven exports has a live dependency: each is a presentational
 * React component whose whole contract is the markup it renders for a given
 * set of props. Each one is rendered here with react-dom/server, so this
 * suite needs no network, no database and no container.
 *
 * Not pinned, and why: user interactions (clicking the header trigger to
 * toggle the chain open and closed, and the resulting onOpenChange
 * callbacks) dispatch DOM events through Radix widgets and need an event
 * loop. There is no DOM environment available to `bun test` in this project
 * - `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so only server-rendered output is pinned. That is a gap in
 * interaction coverage, not an export left unexercised: every export is
 * rendered and asserted on, so no export belongs in the blocked list above.
 */
import { describe, expect, it } from 'bun:test'
import { CheckIcon } from 'lucide-react'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtImage,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from './chain-of-thought'

const render = (node: ReturnType<typeof createElement>): string =>
  renderToString(node)

describe('chainOfThoughtTsxContract', () => {
  it('ChainOfThought renders children, merges container classes and starts closed', () => {
    const html = render(
      createElement(
        ChainOfThought,
        { className: 'max-w-lg', 'data-testid': 'cot-root' },
        createElement('p', null, 'step one'),
      ),
    )

    // Children land inside the container, extra props are forwarded.
    expect(html).toContain('step one')
    expect(html).toContain('data-testid="cot-root"')
    // The caller's width class wins over the default, the rest survive.
    expect(html).toContain('not-prose space-y-4 max-w-lg')
    expect(html).not.toContain('max-w-prose')
    // The open state the provider hands down is closed by default, so a
    // nested content block renders no children, and defaultOpen opens it.
    const closed = render(
      createElement(
        ChainOfThought,
        null,
        createElement(ChainOfThoughtContent, null, 'hidden body'),
      ),
    )
    expect(closed).not.toContain('hidden body')
    const defaultOpen = render(
      createElement(
        ChainOfThought,
        { defaultOpen: true },
        createElement(ChainOfThoughtContent, null, 'visible body'),
      ),
    )
    expect(defaultOpen).toContain('visible body')
  })

  it('ChainOfThoughtHeader reads the shared open state and throws outside the provider', () => {
    // Outside ChainOfThought the component refuses to render.
    expect(() => render(createElement(ChainOfThoughtHeader))).toThrow(
      /must be used within ChainOfThought/,
    )

    const closed = render(
      createElement(ChainOfThought, null, createElement(ChainOfThoughtHeader)),
    )
    // Default title, brain glyph and a collapsed chevron while closed.
    expect(closed).toContain('Chain of Thought')
    expect(closed).toContain('lucide-brain')
    expect(closed).toContain('lucide-chevron-down')
    expect(closed).toContain('rotate-0')
    expect(closed).not.toContain('rotate-180')
    expect(closed).toContain('aria-expanded="false"')
    expect(closed).toContain('data-state="closed"')

    // Controlled open state from the parent flips the trigger.
    const open = render(
      createElement(
        ChainOfThought,
        { open: true },
        createElement(ChainOfThoughtHeader),
      ),
    )
    expect(open).toContain('rotate-180')
    expect(open).not.toContain('rotate-0')
    expect(open).toContain('aria-expanded="true"')
    expect(open).toContain('data-state="open"')

    // Custom children replace the default title; extra classes merge.
    const custom = render(
      createElement(
        ChainOfThought,
        null,
        createElement(
          ChainOfThoughtHeader,
          { className: 'gap-4' },
          'Reasoning steps',
        ),
      ),
    )
    expect(custom).toContain('Reasoning steps')
    expect(custom).not.toContain('Chain of Thought')
    expect(custom).toContain('gap-4')
    expect(custom).not.toContain('gap-2')
  })

  it('ChainOfThoughtStep renders label, optional description, every status and a custom icon', () => {
    // Minimal step: label plus the default dot glyph and connector line.
    const minimal = render(
      createElement(ChainOfThoughtStep, { label: 'Searching the web' }),
    )
    expect(minimal).toContain('<div>Searching the web</div>')
    expect(minimal).toContain('lucide-dot')
    expect(minimal).toContain('w-px bg-border')
    // Complete is the default status and is dimmed; no description block.
    expect(minimal).toContain('text-muted-foreground')
    expect(minimal).not.toContain('text-muted-foreground/50')
    expect(minimal).not.toContain('text-xs')

    // Description and children render below the label.
    const detailed = render(
      createElement(
        ChainOfThoughtStep,
        { label: 'Searching the web', description: '3 sources' },
        createElement('div', null, 'step output'),
      ),
    )
    expect(detailed).toContain(
      '<div class="text-muted-foreground text-xs">3 sources</div>',
    )
    expect(detailed).toContain('step output')

    // Active steps are rendered at full emphasis.
    const active = render(
      createElement(ChainOfThoughtStep, { label: 'Working', status: 'active' }),
    )
    expect(active).toContain('text-foreground')
    expect(active).not.toContain('text-muted-foreground')

    // Pending steps are faded to half emphasis.
    const pending = render(
      createElement(ChainOfThoughtStep, { label: 'Queued', status: 'pending' }),
    )
    expect(pending).toContain('text-muted-foreground/50')

    // A caller-supplied icon replaces the default dot.
    const customIcon = render(
      createElement(ChainOfThoughtStep, { label: 'Done', icon: CheckIcon }),
    )
    expect(customIcon).toContain('lucide-check')
    expect(customIcon).not.toContain('lucide-dot')
  })

  it('ChainOfThoughtSearchResults lays out result children in a forwarded flex row', () => {
    const html = render(
      createElement(
        ChainOfThoughtSearchResults,
        { className: 'gap-4', 'data-testid': 'search-results' },
        createElement(ChainOfThoughtSearchResult, null, 'example.com'),
      ),
    )

    // Children land inside the row and extra props are forwarded.
    expect(html).toContain('example.com')
    expect(html).toContain('data-testid="search-results"')
    expect(html).toContain('class="flex items-center gap-4"')
    // The caller's gap wins over the default.
    expect(html).not.toContain('gap-2')
  })

  it('ChainOfThoughtSearchResult badges its children with the secondary variant', () => {
    const html = render(
      createElement(
        ChainOfThoughtSearchResult,
        { className: 'text-lg' },
        'docs.acme.dev',
      ),
    )

    // The child text is inside a secondary-variant badge.
    expect(html).toContain('>docs.acme.dev</span>')
    expect(html).toContain('data-slot="badge"')
    expect(html).toContain('bg-secondary')
    expect(html).toContain('text-secondary-foreground')
    // The caller's text size wins over the badge's own.
    expect(html).toContain('font-normal text-lg')
    expect(html).not.toContain('text-xs')
  })

  it('ChainOfThoughtContent hides its children while closed and shows them while open', () => {
    // While the chain is closed the block renders empty and hidden.
    const closed = render(
      createElement(
        ChainOfThought,
        null,
        createElement(ChainOfThoughtContent, null, 'the reasoning body'),
      ),
    )
    expect(closed).not.toContain('the reasoning body')
    expect(closed).toContain('hidden=""')
    expect(closed).toContain('data-state="closed"')

    // While the chain is open the children render and extra classes merge.
    const open = render(
      createElement(
        ChainOfThought,
        { open: true },
        createElement(
          ChainOfThoughtContent,
          { className: 'mt-8' },
          'the reasoning body',
        ),
      ),
    )
    expect(open).toContain('the reasoning body')
    expect(open).not.toContain('hidden=""')
    expect(open).toContain('data-state="open"')
    expect(open).toContain('space-y-3')
    expect(open).toContain('mt-8')
    expect(open).not.toContain('mt-2')
  })

  it('ChainOfThoughtImage frames children and shows an optional caption', () => {
    // Without a caption only the framed children render.
    const bare = render(
      createElement(
        ChainOfThoughtImage,
        null,
        createElement('img', { src: 'chart.png', alt: 'A chart' }),
      ),
    )
    expect(bare).toContain('src="chart.png"')
    expect(bare).toContain('rounded-lg bg-muted')
    expect(bare).not.toContain('<p')

    // With a caption the paragraph renders beneath the frame; classes merge.
    const captioned = render(
      createElement(
        ChainOfThoughtImage,
        { className: 'mt-8', caption: 'Quarterly growth' },
        createElement('img', { src: 'chart.png', alt: 'A chart' }),
      ),
    )
    expect(captioned).toContain(
      '<p class="text-muted-foreground text-xs">Quarterly growth</p>',
    )
    expect(captioned).toContain('mt-8')
    expect(captioned).not.toContain('mt-2')
  })
})
