/**
 * Contract suite for the exports of QuickSetupSection.tsx.
 *
 * The module exports exactly one symbol: `QuickSetupSection`. The single
 * test below renders that export and asserts on the markup it emits, so
 * the suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`QuickSetupSection`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component has no live dependency to stub: `lucide-react`,
 * `@/components/ui/button` and `@/components/ui/tabs` render to static
 * markup, and `navigator.clipboard` is only reached from a click handler
 * that server rendering never invokes. This suite therefore needs no
 * network, no database and no container.
 *
 * Not pinned, and why: Radix Tabs mounts the content of inactive tab
 * panels neither during server rendering nor after hydration (the
 * component passes no `forceMount`), so only the default tab's snippet
 * reaches the markup. The snippets for the four non-default clients and
 * the "Add to <file>" notes for the JSON clients are pinned here only
 * insofar as their tab panels exist and are hidden. Clicking a tab
 * trigger or a copy button dispatches DOM events, and no DOM
 * environment is available to `bun test` in this project
 * (`@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile). These are gaps in behaviour coverage inside the single
 * export, not exports left unexercised: the export itself is rendered
 * and asserted on, so no export belongs in the blocked list above.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import { QuickSetupSection } from './QuickSetupSection'

const URL_UNDER_TEST = 'http://127.0.0.1:9/mcp'

const render = (serverUrl: string | null): string =>
  renderToString(createElement(QuickSetupSection, { serverUrl }))

const occurrences = (html: string, needle: RegExp): number =>
  (html.match(needle) ?? []).length

describe('QuickSetupSectionTsxContract', () => {
  it('QuickSetupSection renders nothing without a server URL, and with one offers five client tabs with the default command mounted', () => {
    // No server URL: the whole section is absent from the page.
    expect(render(null)).toBe('')

    const html = render(URL_UNDER_TEST)

    // The section header explains what the card is for.
    expect(html).toContain('>Quick Setup</h2>')
    expect(html).toContain('Copy and run the command for your tool')

    // One tab per supported client, offered in a fixed order, and no
    // sixth tab beyond them.
    const clientNames = [
      'Claude Code',
      'Gemini CLI',
      'Codex',
      'Claude Desktop',
      'OpenClaw',
    ]
    let cursor = html.indexOf('role="tablist"')
    expect(cursor).toBeGreaterThanOrEqual(0)
    for (const name of clientNames) {
      const at = html.indexOf(`>${name}</button>`, cursor)
      expect(at).toBeGreaterThan(cursor)
      cursor = at
    }
    expect(occurrences(html, /role="tab"/g)).toBe(5)
    expect(occurrences(html, /role="tabpanel"/g)).toBe(5)

    // Claude Code is the tab open by default: exactly one trigger is
    // selected and it is the Claude Code one; the other four panels
    // exist but are hidden, so only the default snippet is shown.
    expect(occurrences(html, /aria-selected="true"/g)).toBe(1)
    expect(occurrences(html, /aria-selected="false"/g)).toBe(4)
    const selectedTriggerAt = html.indexOf('aria-selected="true"')
    const selectedTriggerEnd = html.indexOf('</button>', selectedTriggerAt)
    expect(selectedTriggerEnd).toBeGreaterThan(selectedTriggerAt)
    const selectedTrigger = html.slice(
      selectedTriggerAt,
      selectedTriggerEnd + '</button>'.length,
    )
    expect(selectedTrigger).toContain('>Claude Code</button>')
    expect(occurrences(html, /hidden=""/g)).toBe(4)

    // The mounted panel shows the exact Claude Code command with the
    // server URL interpolated, behind a shell prompt marker.
    expect(html).toContain(
      `<span class="mr-1 text-muted-foreground">$</span>claude mcp add --transport http browseros ${URL_UNDER_TEST} --scope user`,
    )

    // The mounted snippet is paired with one copy affordance, which
    // starts in its un-copied state.
    expect(occurrences(html, /lucide-copy/g)).toBe(1)
    expect(occurrences(html, /lucide-check/g)).toBe(0)
  })
})
