import { afterAll, describe, expect, it, mock } from 'bun:test'

/**
 * Contract suite for the single export of ./SidebarNavigation.tsx:
 * SidebarNavigation.
 *
 * Every assertion below reads rendered markup produced by
 * react-dom/server's renderToStaticMarkup inside a StaticRouter: the anchor
 * hrefs, the visible labels, the active-state class the component applies,
 * and the label opacity classes. Nothing reaches into the module internals.
 *
 * useCapabilities is substituted with a controllable stub via mock.module so
 * capability gating can be exercised both ways without a live BrowserOS
 * environment, network, or browser. The stub is replaced with the real module
 * in afterAll because mock.restore() does not undo mock.module in bun 1.3 and
 * a whole-group bun test run shares the module registry across files.
 */

const realUseCapabilitiesModule = await import(
  '@/lib/browseros/useCapabilities'
)

let stubSupports: (feature: string) => boolean = () => true

mock.module('@/lib/browseros/useCapabilities', () => ({
  useCapabilities: () => ({
    supports: stubSupports,
    isLoading: false,
    browserOSVersion: null,
    serverVersion: null,
  }),
}))

const { SidebarNavigation } = await import('./SidebarNavigation')
const { renderToStaticMarkup } = await import('react-dom/server')
const { StaticRouter } = await import('react-router')
const { createElement } = await import('react')

afterAll(() => {
  mock.module(
    '@/lib/browseros/useCapabilities',
    () => realUseCapabilitiesModule,
  )
})

const ACTIVE_CLASS = 'bg-sidebar-accent'

function renderNav(pathname: string, props: { expanded?: boolean } = {}) {
  return renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location: pathname },
      createElement(SidebarNavigation, props),
    ),
  )
}

/** Opening tags of every rendered anchor, in document order. */
function anchorTags(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>/g)].map((match) => match[0])
}

function hrefs(html: string): string[] {
  return anchorTags(html)
    .map((tag) => /href="([^"]*)"/.exec(tag)?.[1] ?? '')
    .filter(Boolean)
}

function anchorFor(html: string, href: string): string {
  const tag = anchorTags(html).find((entry) => entry.includes(`href="${href}"`))
  if (!tag) {
    throw new Error(`rendered markup has no anchor with href="${href}"`)
  }
  return tag
}

/** Whether an anchor's class list contains the active-state token exactly. */
function hasActiveClass(anchorTag: string): boolean {
  const classAttr = /class="([^"]*)"/.exec(anchorTag)?.[1] ?? ''
  return (classAttr.match(/\S+/g) ?? []).includes(ACTIVE_CLASS)
}

/** Visible text of the anchor for a href: markup stripped, whitespace trimmed. */
function labelOf(html: string, href: string): string {
  const start = html.indexOf(anchorFor(html, href))
  const end = html.indexOf('</a>', start)
  return html
    .slice(start, end)
    .replace(/<[^>]*>/g, '')
    .trim()
}

describe('SidebarNavigationTsxContract', () => {
  it('SidebarNavigation renders gated links with labels, highlights the current route, and hides labels when collapsed', () => {
    stubSupports = () => true

    // Full navigation set, in order, each item linking to its route.
    const all = renderNav('/home')
    expect(hrefs(all)).toEqual([
      '/home',
      '/connect-apps',
      '/scheduled',
      '/agents',
      '/home/skills',
      '/home/memory',
      '/home/soul',
      '/admin',
      '/settings/ai',
    ])

    // Each link carries its human-readable label.
    expect(labelOf(all, '/home')).toBe('Home')
    expect(labelOf(all, '/connect-apps')).toBe('Connect Apps')
    expect(labelOf(all, '/scheduled')).toBe('Scheduled Tasks')
    expect(labelOf(all, '/agents')).toBe('Agents')
    expect(labelOf(all, '/home/skills')).toBe('Skills')
    expect(labelOf(all, '/home/memory')).toBe('Memory')
    expect(labelOf(all, '/home/soul')).toBe('Soul')
    expect(labelOf(all, '/admin')).toBe('Governance')
    expect(labelOf(all, '/settings/ai')).toBe('Settings')

    // Exact-match rule: the current route is highlighted, others are not.
    expect(hasActiveClass(anchorFor(all, '/home'))).toBe(true)
    expect(hasActiveClass(anchorFor(all, '/scheduled'))).toBe(false)

    // Settings rule: any /settings* route highlights the Settings entry,
    // even though the entry's own href is /settings/ai.
    const settings = renderNav('/settings/general')
    expect(hasActiveClass(anchorFor(settings, '/settings/ai'))).toBe(true)

    // Agents rule: /agents descendants highlight the Agents entry.
    const agents = renderNav('/agents/123')
    expect(hasActiveClass(anchorFor(agents, '/agents'))).toBe(true)

    // Capability gating: items whose feature is unsupported are dropped
    // entirely; only the ungated entries remain.
    stubSupports = () => false
    const gated = renderNav('/home')
    expect(hrefs(gated)).toEqual(['/home', '/scheduled', '/settings/ai'])

    // Labels are visible by default...
    stubSupports = () => true
    const expanded = renderNav('/home')
    expect(expanded).toContain('opacity-100')
    expect(expanded).not.toContain('opacity-0')

    // ...and hidden when the sidebar is collapsed, while the links survive.
    const collapsed = renderNav('/home', { expanded: false })
    expect(collapsed).toContain('opacity-0')
    expect(collapsed).not.toContain('opacity-100')
    expect(hrefs(collapsed)).toHaveLength(9)
  })
})
