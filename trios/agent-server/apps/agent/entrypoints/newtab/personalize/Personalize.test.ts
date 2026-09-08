/**
 * Contract suite for the exports of Personalize.tsx.
 *
 * The module exports exactly one symbol: `Personalize`. Every assertion
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`Personalize`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's only live dependency is the extension storage area
 * (`local:personalization`) that `@/lib/personalization/personalizationStorage`
 * reads and writes through `@wxt-dev/storage`, which requires a
 * browser-extension host at import time. The hook is swapped for an
 * in-memory stub via `mock.module`, so this suite needs no network, no
 * database and no container.
 *
 * Not pinned, and why: user interactions and the storage round-trip.
 * Toggling the template accordions, clicking the copy-to-clipboard
 * buttons and typing edits into the editor dispatch DOM events, call
 * `navigator.clipboard` and write to extension storage, and the editor's
 * content is populated by its Lexical engine after mounting rather than
 * in the server-rendered markup. There is no DOM environment available
 * to `bun test` in this project - `@testing-library`, `happy-dom` and
 * `jsdom` are all absent from the lockfile - so only the component's
 * rendered output is pinned. That is a gap in interaction coverage, not
 * an export left unexercised: the export itself is rendered and asserted
 * on, so no export belongs in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

type UsePersonalizationResult = {
  personalization: string
  setPersonalization: (value: string) => void
}

let hookResult: UsePersonalizationResult

mock.module('@/lib/personalization/personalizationStorage', () => ({
  usePersonalization: () => hookResult,
}))

const { Personalize } = await import('./Personalize')

const settledHook: UsePersonalizationResult = {
  personalization: '',
  setPersonalization: () => undefined,
}

const render = (result: UsePersonalizationResult = settledHook): string => {
  hookResult = result
  return renderToString(createElement(Personalize))
}

const countOf = (html: string, needle: string): number => {
  let count = 0
  let at = html.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = html.indexOf(needle, at + needle.length)
  }
  return count
}

describe('PersonalizeTsxContract', () => {
  it('renders the branding, the personalization form and its privacy note', () => {
    const html = render()

    // The new-tab branding sits at the top of the page.
    expect(html).toContain('alt="BrowserOS"')

    // The form's label is wired to the editor container by id.
    expect(html).toContain('Your Information')
    expect(html).toContain('for="personalization"')
    expect(html).toContain('id="personalization"')
    expect(html).toContain('Tell BrowserOS about yourself')

    // The editor carries the promised privacy disclosure.
    expect(html).toContain(
      'Your information is saved locally and never leaves your device',
    )
    expect(html).toContain('Markdown formatting is supported')

    // Until the mount effect runs, both content blocks render in their
    // pre-reveal hidden state rather than fully visible.
    expect(html).toContain('opacity-0')
  })

  it('renders the help heading and every section with its description', () => {
    const html = render()

    expect(html).toContain('Need help getting started?')
    expect(html).toContain('Add more info about you')
    expect(html).toContain('Help BrowserOS understand who you are')
    expect(html).toContain('What you expect from the browser')
    expect(html).toContain('Share your preferences and needs')
    expect(html).toContain('Your commonly performed actions')
    expect(html).toContain('Describe your daily workflows')
  })

  it('expands only the first section initially and hides the others', () => {
    const html = render()

    // Three accordion sections exist, one per help topic, and the first
    // is the only one whose trigger announces itself expanded; the other
    // two section roots render closed.
    expect(countOf(html, 'data-slot="collapsible-trigger"')).toBe(3)
    expect(countOf(html, 'aria-expanded="true" data-state="open"')).toBe(1)
    expect(countOf(html, 'data-state="closed" data-slot="collapsible"')).toBe(2)
    const expandedAt = html.indexOf('aria-expanded="true"')
    expect(expandedAt).toBeGreaterThan(
      html.indexOf('Need help getting started?'),
    )
    expect(expandedAt).toBeLessThan(html.indexOf('Add more info about you'))
    expect(html.indexOf('What you expect from the browser')).toBeGreaterThan(
      expandedAt,
    )
    // Exactly one chevron is flipped to point up: the expanded one.
    expect(countOf(html, 'rotate-180')).toBe(1)

    // The expanded section shows its copyable template and its worked
    // example inline.
    expect(html).toContain('Template (click to copy):')
    expect(html).toContain('# About Me')
    expect(html).toContain('[Your name]')
    expect(html).toContain('Example:')
    expect(html).toContain('Alex Johnson')
    expect(html).toContain('Click the copy button to add this template')

    // The collapsed sections do not leak their templates or examples.
    expect(html).not.toContain('## What I Expect from the Browser')
    expect(html).not.toContain('Research and development work')
    expect(html).not.toContain('## Commonly Performed Actions')
    expect(html).not.toContain('GitHub - Code collaboration')
  })

  it('offers exactly one copy control for the one open section', () => {
    const html = render()

    expect(countOf(html, 'title="Copy template"')).toBe(1)
    // Every section trigger carries a chevron, so there are three of them.
    expect(countOf(html, 'lucide-chevron-down')).toBe(3)
    // No section has been copied from yet, so no confirmations are shown.
    expect(html).not.toContain('Copied')
  })
})
