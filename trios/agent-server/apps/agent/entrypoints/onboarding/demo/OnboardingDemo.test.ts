/**
 * Contract suite for OnboardingDemo.tsx.
 *
 * Export coverage: the module exports exactly one symbol, OnboardingDemo,
 * and this suite exercises that export end to end - initial render, the
 * personalization effect, and every user action the component offers. No
 * exported symbol is blocked by a live dependency, so none is omitted.
 *
 * Environment: the suite needs no network, database or container. Every
 * extension-only boundary the component talks to is replaced with an
 * in-memory double via mock.module, registered before the subject is
 * imported (the house pattern - see apps/server/tests/skills/loader.test.ts):
 *
 *   - @/lib/messaging/sidepanel/openSidepanelWithSearch: cannot even be
 *     imported outside a browser extension (@webext-core/messaging throws
 *     at module scope), and a real message needs the extension runtime.
 *   - @/lib/onboarding/onboardingStorage: backed by @wxt-dev/storage, which
 *     requires the chrome.storage area at call time.
 *   - @/lib/metrics/track: forwards events to the BrowserOS adapter, which
 *     would reach the network.
 *   - @/entrypoints/app/connect-mcp/useGetUserMCPIntegrations: a react-query
 *     hook that fetches the integrations list over HTTP and requires a
 *     QueryClient context.
 *
 * The analytics event constants, the UI primitives (Button, Input) and the
 * app icons are the real modules, untouched.
 *
 * Why the driver below exists: this repo has no DOM-capable renderer under
 * bun test (jsdom/happy-dom are not in the lockfile and cannot be added
 * without editing it, which is out of bounds), and react-dom/server can
 * neither commit state updates nor run effects. To exercise the component's
 * real code rather than a rewrite, the 'react' module is swapped for the
 * real one plus two stateful, call-slot-keyed useState/useEffect
 * implementations. The suite can then call OnboardingDemo() directly,
 * flush its effects, re-render when state changes, and fire the very
 * handlers the component attaches to the DOM. Initial markup is still
 * verified through the real react-dom/server renderer. Assertions only
 * look at rendered output and at the observable side effects of user
 * actions - never at how the component is wired internally.
 */

import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { McpServerIcon } from '@/entrypoints/app/connect-mcp/McpServerIcon'
import {
  ONBOARDING_COMPLETED_EVENT,
  ONBOARDING_DEMO_TRIGGERED_EVENT,
} from '@/lib/constants/analyticsEvents'

/* ------------------------------------------------------------------ *
 * Stateful hooks: a minimal stand-in for React's dispatcher so the
 * component can be rendered outside a host renderer. Hooks are keyed by
 * call order, which the component honours (Rules of Hooks).
 * ------------------------------------------------------------------ */

type TreeElement = {
  type: unknown
  props: Record<string, unknown>
}

const stateSlots = new Map<number, unknown>()
const effectLastDeps = new Map<number, unknown[] | undefined>()
const queuedEffects: Array<() => void | Promise<void>> = []
let stateSlotCursor = 0
let effectSlotCursor = 0
let stateWrites = 0

function statefulUseState<T>(initial: T | (() => T)): [T, (value: T) => void] {
  const slot = stateSlotCursor++
  if (!stateSlots.has(slot)) {
    stateSlots.set(
      slot,
      typeof initial === 'function' ? (initial as () => T)() : initial,
    )
  }
  return [
    stateSlots.get(slot) as T,
    (value: T) => {
      stateSlots.set(slot, value)
      stateWrites++
    },
  ]
}

function recordingUseEffect(
  callback: () => void | Promise<void>,
  deps?: unknown[],
): void {
  const slot = effectSlotCursor++
  const firstRun = !effectLastDeps.has(slot)
  const previous = effectLastDeps.get(slot)
  const shouldRun =
    deps === undefined ||
    firstRun ||
    previous === undefined ||
    deps.length !== previous.length ||
    deps.some((dep, index) => dep !== previous[index])
  if (shouldRun) queuedEffects.push(callback)
  effectLastDeps.set(slot, deps)
}

/* ------------------------------------------------------------------ *
 * Boundary doubles. Each recorder is the observable contract of an
 * external system the component drives.
 * ------------------------------------------------------------------ */

const trackCalls: Array<{
  name: string
  props: Record<string, unknown> | undefined
}> = []
const openCalls: Array<unknown[]> = []
const completedWrites: boolean[] = []
const createdTabs: unknown[] = []
let profileOnDisk: { company: string } | null = null
let integrationsHookResult: {
  data: unknown
  isLoading: boolean
  isFetching: boolean
  isSuccess: boolean
  mutate: () => void
}

/** New payload identity means new hook-result identity, so the effect deps
 * change exactly when the integrations data changes - as with react-query. */
function setIntegrations(payload: unknown): void {
  integrationsHookResult = {
    data: payload,
    isLoading: false,
    isFetching: false,
    isSuccess: false,
    mutate: () => {},
  }
}
setIntegrations(undefined)

mock.module('react', () => ({
  ...React,
  useState: statefulUseState,
  useEffect: recordingUseEffect,
}))

mock.module('@/lib/metrics/track', () => ({
  track: (name: string, props?: Record<string, unknown>) => {
    trackCalls.push({ name, props })
  },
}))

mock.module('@/lib/messaging/sidepanel/openSidepanelWithSearch', () => ({
  openSidePanelWithSearch: (...args: unknown[]) => {
    openCalls.push(args)
  },
}))

mock.module('@/lib/onboarding/onboardingStorage', () => ({
  onboardingCompletedStorage: {
    setValue: async (value: boolean) => {
      completedWrites.push(value)
    },
  },
  onboardingProfileStorage: {
    getValue: async () => profileOnDisk,
  },
}))

mock.module('@/entrypoints/app/connect-mcp/useGetUserMCPIntegrations', () => ({
  useGetUserMCPIntegrations: () => integrationsHookResult,
}))

const { OnboardingDemo } = await import('./OnboardingDemo')
const { renderToStaticMarkup } = await import('react-dom/server')

/* ------------------------------------------------------------------ *
 * Render driver.
 * ------------------------------------------------------------------ */

function renderOnce(): TreeElement {
  stateSlotCursor = 0
  effectSlotCursor = 0
  return OnboardingDemo() as unknown as TreeElement
}

async function flushEffects(): Promise<void> {
  for (let round = 0; round < 6; round++) {
    const batch = queuedEffects.splice(0)
    for (const effect of batch) await effect()
  }
}

/** Renders, runs effects, and keeps re-rendering until state settles. */
async function mount(): Promise<TreeElement> {
  let tree = renderOnce()
  for (let attempt = 0; attempt < 4; attempt++) {
    const writesBefore = stateWrites
    await flushEffects()
    if (stateWrites === writesBefore) return tree
    tree = renderOnce()
  }
  return tree
}

/** The same component through the real react-dom/server renderer, so the
 * initial view is pinned as actual markup, not just as an element tree. */
function markup(): string {
  stateSlotCursor = 0
  effectSlotCursor = 0
  queuedEffects.length = 0
  return renderToStaticMarkup(React.createElement(OnboardingDemo))
}

/** Fresh component instance and clean recorders for each scenario. */
function resetWorld(): void {
  stateSlots.clear()
  effectLastDeps.clear()
  queuedEffects.length = 0
  stateSlotCursor = 0
  effectSlotCursor = 0
  stateWrites = 0
  trackCalls.length = 0
  openCalls.length = 0
  completedWrites.length = 0
  createdTabs.length = 0
  setIntegrations(undefined)
  profileOnDisk = null
}

/* ------------------------------------------------------------------ *
 * Element-tree helpers (React elements are plain objects).
 * ------------------------------------------------------------------ */

function isElement(node: unknown): node is TreeElement {
  return (
    typeof node === 'object' &&
    node !== null &&
    'type' in node &&
    'props' in node
  )
}

function walk(node: unknown, onElement: (element: TreeElement) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, onElement)
    return
  }
  if (!isElement(node)) return
  onElement(node)
  const children = node.props.children
  if (children !== undefined && children !== null) walk(children, onElement)
}

function elementText(element: TreeElement): string {
  const parts: string[] = []
  const gather = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === 'boolean') {
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      node.forEach(gather)
      return
    }
    if (isElement(node)) gather(node.props.children)
  }
  gather(element.props.children)
  return parts.join('')
}

function hostButtonsOf(tree: TreeElement): TreeElement[] {
  const found: TreeElement[] = []
  walk(tree, (element) => {
    if (element.type === 'button') found.push(element)
  })
  return found
}

function findElement(
  tree: TreeElement,
  matches: (element: TreeElement) => boolean,
): TreeElement {
  let hit: TreeElement | undefined
  walk(tree, (element) => {
    if (hit === undefined && matches(element)) hit = element
  })
  if (hit === undefined) {
    throw new Error('no matching element found in the rendered tree')
  }
  return hit
}

function containsElement(tree: TreeElement, componentType: unknown): boolean {
  let sawComponent = false
  walk(tree, (element) => {
    if (element.type === componentType) sawComponent = true
  })
  return sawComponent
}

/* ------------------------------------------------------------------ *
 * The suite. One describe, one test case covering the single export.
 * ------------------------------------------------------------------ */

describe('OnboardingDemoTsxContract', () => {
  it('pins the OnboardingDemo export: what renders, how suggestions personalize, and what every user action does', async () => {
    const windowState = { location: { href: 'about:blank' } }
    const runtimeBase = 'chrome-extension://probe'
    const globals = globalThis as Record<string, unknown>
    globals.window = windowState
    globals.chrome = {
      tabs: {
        create: async (options: { active?: boolean }) => {
          createdTabs.push(options)
          return { id: 1 }
        },
      },
      runtime: {
        getURL: (path: string) => `${runtimeBase}/${path}`,
        getManifest: () => ({ version: '0.0.0-test' }),
      },
    }

    // --- 1. Initial view: default suggestions, copy, and controls ------

    resetWorld()
    const initialTree = await mount()
    expect(hostButtonsOf(initialTree).map(elementText)).toEqual([
      "What's the top tech news today",
      "What's the top news today",
      'Find me a good restaurant nearby',
    ])
    expect(
      findElement(
        initialTree,
        (element) => element.props.placeholder === 'Or type your own task...',
      ).props.value,
    ).toBe('')

    const initialMarkup = markup()
    expect(initialMarkup).toContain('Try your first task')
    expect(initialMarkup).toContain(
      'Pick a suggestion or type your own to see BrowserOS in action',
    )
    expect(initialMarkup).toContain('placeholder="Or type your own task..."')
    expect(initialMarkup).toContain('Skip and go to homepage')
    expect(initialMarkup).toMatch(/<button[^>]*disabled=""[^>]*>Go<\/button>/)
    // Generic suggestions carry the globe icon, never an app icon.
    expect(containsElement(initialTree, McpServerIcon)).toBe(false)

    // --- 2. The effect personalizes suggestions from profile and apps --

    // A company in the profile swaps the first default suggestion.
    resetWorld()
    profileOnDisk = { company: 'Acme' }
    expect(hostButtonsOf(await mount()).map(elementText)).toEqual([
      'Search for Acme and summarize the latest news',
      "What's the top news today",
      'Find me a good restaurant nearby',
    ])

    // Authenticated apps come first, unauthenticated ones are ignored,
    // repeated apps appear once, and the company prompt follows.
    resetWorld()
    profileOnDisk = { company: 'Acme' }
    setIntegrations({
      integrations: [
        { name: 'GitHub', is_authenticated: false },
        { name: 'Slack', is_authenticated: true },
        { name: 'Slack', is_authenticated: true },
      ],
      count: 3,
    })
    const personalizedTree = await mount()
    expect(hostButtonsOf(personalizedTree).map(elementText)).toEqual([
      'Show my unread Slack mentions',
      'Search for Acme and summarize the latest news',
    ])
    // An app-backed suggestion renders that app's icon.
    expect(
      containsElement(hostButtonsOf(personalizedTree)[0], McpServerIcon),
    ).toBe(true)

    // Integrations arriving after the first render re-personalize.
    resetWorld()
    expect(hostButtonsOf(await mount()).map(elementText)).toEqual([
      "What's the top tech news today",
      "What's the top news today",
      'Find me a good restaurant nearby',
    ])
    setIntegrations({
      integrations: [{ name: 'Linear', is_authenticated: true }],
      count: 1,
    })
    profileOnDisk = { company: 'Globex' }
    renderOnce()
    await flushEffects()
    expect(hostButtonsOf(renderOnce()).map(elementText)).toEqual([
      'What Linear tickets are assigned to me?',
      'Search for Globex and summarize the latest news',
    ])

    // --- 3. Clicking a suggestion runs the whole demo pipeline ---------

    resetWorld()
    const firstSuggestion = hostButtonsOf(await mount())[0]
    const firstQuery = "What's the top tech news today? Give me a brief summary"
    await (firstSuggestion.props.onClick as () => Promise<void>)()
    expect(trackCalls).toEqual([
      {
        name: ONBOARDING_DEMO_TRIGGERED_EVENT,
        props: {
          query: firstQuery,
          mode: 'agent',
          source: 'suggestion',
          suggestion_index: 0,
        },
      },
      { name: ONBOARDING_COMPLETED_EVENT, props: undefined },
    ])
    expect(completedWrites).toEqual([true])
    expect(createdTabs).toEqual([{ active: true }])
    expect(openCalls).toEqual([['open', { query: firstQuery, mode: 'agent' }]])

    // --- 4. Typing a custom query: guard, control state, submit --------

    resetWorld()
    const idleTree = await mount()
    const idleForm = findElement(idleTree, (element) => element.type === 'form')
    const idleEvent = { preventDefault: () => {} }
    await (idleForm.props.onSubmit as (event: unknown) => Promise<void>)(
      idleEvent,
    )
    // An empty query is a no-op: nothing tracked, opened, or persisted.
    expect(trackCalls).toEqual([])
    expect(openCalls).toEqual([])
    expect(createdTabs).toEqual([])
    expect(completedWrites).toEqual([])

    // Typing updates the controlled input and enables the Go control.
    const idleInput = findElement(
      idleTree,
      (element) => element.props.placeholder === 'Or type your own task...',
    )
    ;(idleInput.props.onChange as (event: unknown) => void)({
      target: { value: '  Order pizza  ' },
    })
    const typedTree = renderOnce()
    expect(
      findElement(
        typedTree,
        (element) => element.props.placeholder === 'Or type your own task...',
      ).props.value,
    ).toBe('  Order pizza  ')
    expect(
      findElement(typedTree, (element) => element.props.children === 'Go').props
        .disabled,
    ).toBe(false)
    const typedMarkup = markup()
    expect(typedMarkup).toContain('value="  Order pizza  "')
    expect(typedMarkup).not.toContain('disabled=""')

    // Submitting trims the query and drives the same pipeline, tagged as a
    // custom entry rather than a suggestion.
    const typedForm = findElement(
      typedTree,
      (element) => element.type === 'form',
    )
    await (typedForm.props.onSubmit as (event: unknown) => Promise<void>)(
      idleEvent,
    )
    expect(trackCalls).toEqual([
      {
        name: ONBOARDING_DEMO_TRIGGERED_EVENT,
        props: { query: 'Order pizza', mode: 'agent', source: 'custom' },
      },
      { name: ONBOARDING_COMPLETED_EVENT, props: undefined },
    ])
    expect(completedWrites).toEqual([true])
    expect(createdTabs).toEqual([{ active: true }])
    expect(openCalls).toEqual([
      ['open', { query: 'Order pizza', mode: 'agent' }],
    ])

    // --- 5. Skipping completes onboarding and goes to the homepage -----

    resetWorld()
    const skipControl = findElement(
      await mount(),
      (element) => element.props.children === 'Skip and go to homepage',
    )
    await (skipControl.props.onClick as () => Promise<void>)()
    expect(trackCalls).toEqual([
      {
        name: ONBOARDING_DEMO_TRIGGERED_EVENT,
        props: { skipped: true },
      },
      { name: ONBOARDING_COMPLETED_EVENT, props: undefined },
    ])
    expect(completedWrites).toEqual([true])
    // Skipping navigates directly: no new tab, no side panel.
    expect(createdTabs).toEqual([])
    expect(openCalls).toEqual([])
    expect(windowState.location.href).toBe(`${runtimeBase}/app.html#/home`)
  })
})
