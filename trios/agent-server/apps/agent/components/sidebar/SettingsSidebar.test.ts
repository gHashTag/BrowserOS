/**
 * Contract suite for the exports of SettingsSidebar.tsx.
 *
 * The module exports exactly one symbol: `SettingsSidebar`. The single
 * registration below renders that export and asserts on the markup it
 * emits, so the suite pins observable behaviour rather than the shape
 * of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`SettingsSidebar`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's only live dependency is the BrowserOS host whose
 * feature support `useCapabilities` reports over the extension bridge.
 * The hook is swapped for an in-memory stub via `mock.module`, so this
 * suite needs no network, no database and no container. The stub lets
 * each render decide which features the host supports, which pins the
 * capability gating from both sides.
 *
 * Not pinned, and why: user interactions (hover styling, navigating by
 * click, opening the theme dropdown) dispatch DOM events, and there is
 * no DOM environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so only rendered output is pinned. That is a gap in
 * interaction coverage, not an export left unexercised: the export
 * itself is rendered and asserted on, so no export belongs in the
 * blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { ThemeProvider } from '@/components/theme-provider'

let hostSupportsFeature = true

mock.module('@/lib/browseros/useCapabilities', () => ({
  useCapabilities: () => ({
    supports: (_feature: unknown) => hostSupportsFeature,
    isLoading: false,
    browserOSVersion: null,
    serverVersion: null,
  }),
}))

console.log('DEBUG: importing theme-provider')
await import('@/components/theme-provider')
console.log('DEBUG: theme-provider ok')
console.log('DEBUG: importing SettingsSidebar')
const { SettingsSidebar } = await import('./SettingsSidebar')
console.log('DEBUG: SettingsSidebar ok')

const renderSidebar = (options: { location?: string; supports?: boolean } = {}) => {
  hostSupportsFeature = options.supports ?? true
  return renderToString(
    createElement(
      StaticRouter,
      { location: options.location ?? '/' },
      createElement(
        ThemeProvider,
        { defaultTheme: 'system' },
        createElement(SettingsSidebar),
      ),
    ),
  )
}

// Returns the full anchor markup for the first link whose href matches,
// so a label can be checked against the destination it belongs to.
const anchorWithHref = (html: string, href: string): string => {
  for (const tag of html.matchAll(/<a\b[^>]*>/g)) {
    if (!tag[0].includes(`href="${href}"`)) continue
    const start = tag.index ?? 0
    return html.slice(start, html.indexOf('</a>', start) + 4)
  }
  return ''
}

// Every internal destination the sidebar offers, paired as [href, label].
// The two labels containing an ampersand are HTML-escaped in the output.
const internalItems: [string, string][] = [
  ['/settings/ai', 'BrowserOS AI'],
  ['/settings/chat', 'Chat &amp; Council Provider'],
  ['/settings/search', 'Search Provider'],
  ['/settings/customization', 'Customize BrowserOS'],
  ['/settings/approvals', 'Tool Approvals'],
  ['/settings/mcp', 'BrowserOS as MCP'],
  ['/settings/acl', 'ACL Rules'],
  ['/settings/usage', 'Usage &amp; Billing'],
  ['/onboarding/features', 'Features'],
  ['/onboarding', 'Revisit Onboarding'],
]

// Items the host can gate away: four of the ten internal destinations.
const gatedItems: [string, string][] = internalItems.slice(3, 7)

describe('SettingsSidebarTsxContract', () => {
  it('SettingsSidebar: pins the header, every nav destination, the capability gating, the external link and the active route', () => {
    // --- a host that supports every feature sees the full menu
    const full = renderSidebar()
    expect(anchorWithHref(full, '/home')).toContain('>Back<')
    for (const [href, label] of internalItems) {
      expect(anchorWithHref(full, href)).toContain(label)
    }

    // The Docs entry is the one and only link that leaves the app.
    const docs = anchorWithHref(full, 'https://docs.browseros.com/')
    expect(docs).toContain('>Docs<')
    expect(docs).toContain('target="_blank"')
    expect(docs).toContain('rel="noopener noreferrer"')
    expect([...full.matchAll(/target="_blank"/g)]).toHaveLength(1)

    // Header chrome: the settings heading and the theme control.
    expect(full).toContain('>Settings<')
    expect(full).toContain('aria-label="Current theme: System"')

    // Sections are labelled and appear in a fixed order.
    const providerAt = full.indexOf('>Provider Settings<')
    const otherAt = full.indexOf('>Other<')
    const helpAt = full.indexOf('>Help<')
    expect(providerAt).toBeGreaterThanOrEqual(0)
    expect(otherAt).toBeGreaterThan(providerAt)
    expect(helpAt).toBeGreaterThan(otherAt)

    // --- a host that supports no feature loses exactly the gated items
    const bare = renderSidebar({ supports: false })
    for (const [href, label] of gatedItems) {
      expect(anchorWithHref(bare, href)).toBe('')
      expect(bare).not.toContain(label)
    }
    for (const [href, label] of internalItems) {
      if (gatedItems.some(([gatedHref]) => gatedHref === href)) continue
      expect(anchorWithHref(bare, href)).toContain(label)
    }
    // The ungated sections survive, so the menu never empties.
    expect(bare).toContain('>Provider Settings<')
    expect(bare).toContain('>Other<')

    // --- the item matching the current route is marked as active
    const atAi = renderSidebar({ location: '/settings/ai' })
    const activeAnchor = anchorWithHref(atAi, '/settings/ai')
    expect(activeAnchor).toContain('aria-current="page"')
    expect(activeAnchor).toContain('bg-sidebar-accent')
    expect(anchorWithHref(atAi, '/settings/chat')).not.toContain('bg-sidebar-accent')
  })
})
