/**
 * Contract suite for `Features.tsx` — the onboarding features page.
 *
 * The module exports exactly one symbol: `FeaturesPage`. It is exercised
 * below through every phase the suite can observe, so nothing had to be
 * skipped for want of a dependency and there is no blocked-export list for
 * this file: one export, one `it`, covered end to end.
 *
 * How the suite observes the component. The agent test group runs under
 * plain `bun test`, which has no DOM, no jsdom/happy-dom and no browser
 * event loop, so the three phases are observed like this:
 *
 *  - First paint: the component is serialized with React's server renderer,
 *    which captures exactly the markup produced before any effect runs.
 *  - Settled paint: `FeaturesPage` keeps the feature grid and the entrance
 *    transitions behind a `mounted` flag that its mount effect flips. To
 *    observe the settled markup the suite drives the component's own hooks
 *    through React's client-internals hook slot — the same slot a real
 *    renderer occupies while rendering — so `useState` reports the mounted
 *    flag as `true` and effects are inert. The returned element tree is
 *    then serialized with the same server renderer. If React ever stops
 *    exposing that slot, this suite fails loudly rather than silently
 *    testing nothing.
 *  - Start button: the rendered element tree is walked to find the Start
 *    button control; invoking the click handler bound to that control is
 *    observed against a stubbed `chrome.runtime`/`chrome.tabs`, the only
 *    external dependency the component touches. The stub is removed again
 *    so nothing leaks into sibling suites in the group run.
 */
import { describe, expect, it } from 'bun:test'
import type { ReactElement } from 'react'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '@/components/ui/button'
import { FeaturesPage } from './Features'

type HookDispatcher = Record<string, unknown>
type ClientInternals = { H: HookDispatcher | null }

const clientInternals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: ClientInternals
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

function hookInternals(): ClientInternals {
  if (!clientInternals) {
    throw new Error(
      'React client internals are unavailable; this suite cannot drive the component hooks',
    )
  }
  return clientInternals
}

/** Render FeaturesPage with its mounted flag held at the given value. */
function featuresPageElement(mounted: boolean): ReactElement {
  const internals = hookInternals()
  const previousDispatcher = internals.H
  internals.H = {
    useState: (initialValue: boolean) => [
      mounted ? true : initialValue,
      () => undefined,
    ],
    useEffect: () => undefined,
  } as HookDispatcher
  try {
    return FeaturesPage() as ReactElement
  } finally {
    internals.H = previousDispatcher
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countWithin(haystack: string, needle: string): number {
  return [...haystack.matchAll(new RegExp(escapeForRegExp(needle), 'g'))].length
}

/** Depth-first walk of an element tree, visiting every element node. */
function eachElement(node: unknown, walk: (element: ReactElement) => void) {
  if (Array.isArray(node)) {
    for (const child of node) eachElement(child, walk)
    return
  }
  if (node === null || typeof node !== 'object') return
  const element = node as ReactElement
  if (typeof element.type === 'string' || typeof element.type === 'function') {
    walk(element)
  }
  const children = (element.props as { children?: unknown } | null)?.children
  if (children !== undefined) eachElement(children, walk)
}

type TabCall = { name: string; argument: unknown }

function stubChrome(activeTab: unknown): { calls: TabCall[] } {
  const calls: TabCall[] = []
  ;(globalThis as unknown as Record<string, unknown>).chrome = {
    runtime: {
      getURL: (path: string) => {
        calls.push({ name: 'getURL', argument: path })
        return `chrome-extension://kappa/${path}`
      },
    },
    tabs: {
      query: async (query: unknown) => {
        calls.push({ name: 'query', argument: query })
        return [activeTab]
      },
      create: async (options: unknown) => {
        calls.push({ name: 'create', argument: options })
      },
      remove: async (tabId: number) => {
        calls.push({ name: 'remove', argument: tabId })
      },
    },
  }
  return { calls }
}

function unstubChrome() {
  delete (globalThis as unknown as Record<string, unknown>).chrome
}

describe('FeaturesTsxContract', () => {
  it('FeaturesPage: pins hero, gated feature grid, community links and the Start-button tab swap as rendered today', async () => {
    // -- First paint: everything the user gets before the mount effect runs.
    const initial = renderToStaticMarkup(React.createElement(FeaturesPage))

    // Hero copy and its pre-mount hidden state.
    expect(initial).toContain('WELCOME')
    expect(initial).toContain('Why Switch to')
    expect(initial).toContain('>BrowserOS?</span>')
    expect(initial).toContain(
      'Watch our launch video to understand the vision of BrowserOS and key features!',
    )
    expect(initial).toContain('scale-95 opacity-0')
    expect(initial).toContain('translate-y-4 opacity-0')
    expect(initial).toContain('Scroll for Features')

    // Intro video, inside its browser-chrome frame.
    expect(initial).toContain(
      '<video class="h-full w-full" src="https://pub-80f8a01e6e8b4239ae53a7652ef85877.r2.dev/resources/animated-launch-vide.mp4" title="BrowserOS MCP Server Demonstration" autoPlay="" muted="" loop="" playsInline="" controls="">',
    )
    expect(initial).toContain('browseros.com/demo')

    // Features section copy.
    expect(initial).toContain('>FEATURES<')
    expect(initial).toContain('Explore What&#x27;s')
    expect(initial).toContain('>Possible</span>')
    expect(initial).toContain(
      'Skim the highlights below, then click any card to see a focused walkthrough with video and deeper details.',
    )
    expect(initial).toContain(
      '💡 Tip: Click any card to open a focused walkthrough with video',
    )

    // The feature grid is gated behind the mount effect: no cards yet.
    expect(countWithin(initial, 'feature-card')).toBe(0)
    expect(countWithin(initial, 'md:grid-cols-3')).toBe(0)
    expect(initial).not.toContain('Built-in AI Agent')
    expect(initial).not.toContain('Agentic Coding')

    // Community section: four outbound cards with their destinations.
    expect(initial).toContain('Join our community and help us improve')
    expect(initial).toContain('>BrowserOS!</span>')
    expect(initial).toContain(
      '<a href="https://discord.gg/browseros" target="_blank" rel="noopener noreferrer" class="community-card',
    )
    expect(initial).toContain(
      '<a href="https://dub.sh/browserOS-slack" target="_blank" rel="noopener noreferrer" class="community-card',
    )
    expect(initial).toContain(
      '<a href="https://github.com/browseros-ai/BrowserOS" target="_blank" rel="noopener noreferrer" class="community-card',
    )
    expect(initial).toContain(
      '<a href="https://docs.browseros.com/" target="_blank" rel="noopener noreferrer" class="community-card',
    )
    expect(initial).toContain('>Join Discord</h3>')
    expect(initial).toContain('>Join Slack</h3>')
    expect(initial).toContain('>GitHub</h3>')
    expect(initial).toContain('>Documentation</h3>')
    expect(initial).toContain('alt="discord-logo"')
    expect(initial).toContain('alt="slack-logo"')
    expect(initial).toContain('alt="github-logo"')
    expect(initial).toContain('To suggest features / provide feedback')
    expect(initial).toContain('Star our repository')
    expect(initial).toContain('Learn more')

    // The Start control is a large button carrying the launch label.
    expect(initial).toContain('Start Using BrowserOS')
    expect(initial).toContain('data-size="lg"')

    // -- Settled paint: after the mount effect flips the flag.
    const settled = renderToStaticMarkup(featuresPageElement(true))

    // The five feature cards appear, one bento grid, five cards inside.
    expect(countWithin(settled, 'md:grid-cols-3')).toBe(1)
    expect(countWithin(settled, 'feature-card')).toBe(5)
    expect(settled).toContain('Built-in AI Agent')
    expect(settled).toContain('BrowserOS as MCP Server')
    expect(settled).toContain('>Cowork</h3>')
    expect(settled).toContain('Split-View Mode')
    expect(settled).toContain('Agentic Coding')
    expect(settled).toContain('>AI AGENT<')
    expect(settled).toContain('>MCP<')
    expect(settled).toContain('>FILES<')
    expect(settled).toContain('>CORE<')
    expect(settled).toContain('>DEV<')
    expect(settled).toContain(
      'Describe any task and watch BrowserOS execute it—clicking, typing, and navigating for you.',
    )
    expect(settled).toContain(
      'Give the agent access to local files. Research the web, then save reports to your computer.',
    )

    // The bento layout: three wide cards, two narrow cards.
    expect(countWithin(settled, 'md:col-span-2')).toBe(3)
    expect(countWithin(settled, 'md:col-span-1')).toBe(2)

    // Entrance transitions have flipped from hidden to shown.
    expect(settled).toContain('translate-y-0 opacity-100')
    expect(settled).toContain('scale-100 opacity-100')
    expect(settled).not.toContain('scale-95 opacity-0')

    // The rest of the page survives the settle.
    expect(settled).toContain('Start Using BrowserOS')
    expect(settled).toContain(
      '<a href="https://discord.gg/browseros" target="_blank" rel="noopener noreferrer" class="community-card',
    )

    // -- The Start button: clicking swaps the active tab for the app page.
    try {
      const tree = featuresPageElement(false)
      let startButton: ReactElement | undefined
      eachElement(tree, (element) => {
        if (element.type === Button) startButton = element
      })
      if (!startButton) {
        throw new Error('The rendered Start button could not be located')
      }
      const buttonChildren = (startButton.props as { children: unknown[] })
        .children
      expect(buttonChildren[0]).toBe('Start Using BrowserOS')

      // With an active tab id: resolve app.html, open it, close the old tab.
      const withId = stubChrome({ id: 42 })
      await (startButton.props as { onClick: () => Promise<void> }).onClick()
      expect(withId.calls).toEqual([
        { name: 'getURL', argument: 'app.html' },
        { name: 'query', argument: { active: true, currentWindow: true } },
        {
          name: 'create',
          argument: { url: 'chrome-extension://kappa/app.html' },
        },
        { name: 'remove', argument: 42 },
      ])

      // Without an active tab id: the old tab is left alone.
      const withoutId = stubChrome({})
      await (startButton.props as { onClick: () => Promise<void> }).onClick()
      expect(withoutId.calls).toEqual([
        { name: 'getURL', argument: 'app.html' },
        { name: 'query', argument: { active: true, currentWindow: true } },
        {
          name: 'create',
          argument: { url: 'chrome-extension://kappa/app.html' },
        },
      ])
    } finally {
      unstubChrome()
    }
  })
})
