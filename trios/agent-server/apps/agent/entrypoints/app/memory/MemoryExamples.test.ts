/**
 * Contract suite for the exports of MemoryExamples.tsx.
 *
 * The module exports exactly one symbol: `MemoryExamples`. The single
 * assertion block below renders that export and asserts on the markup
 * it emits, so the suite pins observable behaviour rather than the
 * shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`MemoryExamples`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's only live dependency is the extension runtime that
 * `@/lib/messaging/sidepanel/openSidepanelWithSearch` reaches through
 * `webextension-polyfill`, which refuses to even load outside a real
 * browser extension. That messaging module is swapped for a no-op stub
 * via `mock.module`, so this suite needs no network, no database and
 * no container.
 *
 * Not pinned, and why: the interaction flow - a Try-it button opening
 * the edit dialog with the prompt pre-filled, the textarea accepting
 * edits, the Send button staying disabled while the text is blank, and
 * Send dispatching the trimmed query to the side panel - can only be
 * exercised by dispatching DOM events through Radix widgets. There is
 * no DOM environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so only the component's rendered output is pinned. That
 * is a gap in interaction coverage, not an export left unexercised:
 * the export itself is rendered and asserted on, so no export belongs
 * in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

mock.module('@/lib/messaging/sidepanel/openSidepanelWithSearch', () => ({
  openSidePanelWithSearch: () => undefined,
}))

const { MemoryExamples } = await import('./MemoryExamples')

// The five teaching prompts a user can pick from, label and query as
// shown on screen. Duplicated here on purpose: the suite pins the copy.
const EXAMPLES: ReadonlyArray<{ label: string; query: string }> = [
  {
    label: 'Introduce yourself',
    query:
      'My name is [name] and I work as a [role] at [company]. Save this to your core memory.',
  },
  {
    label: 'Learn from my bookmarks',
    query:
      'Look through my bookmarks and figure out what topics and interests matter to me. Save the key themes to your core memory.',
  },
  {
    label: 'Learn my habits',
    query:
      'Go through my recent browsing history and figure out what tools and sites I rely on, what topics I keep coming back to, and what my day-to-day looks like. Save what you learn about me to core memory.',
  },
  {
    label: 'Know my open tabs',
    query:
      "Look at my open tabs right now and figure out what I'm working on. Save the relevant context to core memory.",
  },
  {
    label: 'Review memories',
    query:
      'Read your core memories and tell me what you know about me. Is anything outdated?',
  },
]

// react-dom/server escapes apostrophes in text content as `&#x27;`, so
// queries are matched in their on-the-wire form.
const asRendered = (text: string): string => text.replace(/'/g, '&#x27;')

describe('MemoryExamplesTsxContract', () => {
  it('MemoryExamples: renders the teaching header, all five prompt cards each pairing its label with its query and a Try-it button, and keeps the edit dialog closed on first render', () => {
    const html = renderToString(createElement(MemoryExamples))

    // Section heading and helper copy.
    expect(html).toContain('Teach your agent about you')
    expect(html).toContain('Use these prompts to help your agent learn')
    expect(html).toContain('Edit the message before sending.')

    // Every card pairs its label with its own query, and the cards
    // appear in the order written above.
    let previousAt = -1
    for (const example of EXAMPLES) {
      const labelAt = html.indexOf(example.label)
      const queryAt = html.indexOf(asRendered(example.query))

      expect(labelAt).toBeGreaterThan(previousAt)
      expect(queryAt).toBeGreaterThan(labelAt)
      previousAt = queryAt
    }

    // Each card offers exactly one Try-it button, and nothing else on
    // the page says Try it.
    expect(html.match(/Try it/g)?.length).toBe(EXAMPLES.length)

    // The edit dialog starts closed: its copy and its controls are
    // absent from the first paint.
    expect(html).not.toContain('Edit message')
    expect(html).not.toContain('Customize the prompt')
    expect(html).not.toContain('Cancel')
    expect(html).not.toContain('Send')
  })
})
