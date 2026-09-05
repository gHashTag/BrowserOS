/**
 * Contract suite for AISettingsPage.tsx.
 *
 * The subject module exports a single symbol, `AISettingsPage`, and this suite
 * pins the behaviour of that export exactly as it stands today. The real
 * component is mounted with the real child components and a real react-dom
 * root inside an in-memory DOM, and is driven with real DOM events, so every
 * assertion below is about what a user of the page can observe.
 *
 * Everything the page touches outside itself — extension storage, the agent
 * server, the GraphQL backend, OAuth flows, analytics, toasts — is replaced at
 * the module boundary with in-memory fakes. The suite therefore needs no
 * network, no database and no container; plain `bun test <this file>` runs
 * hermetically.
 *
 * Export accounting for this module (1 export in total):
 *   - `AISettingsPage` — exercised by the assertions of the single registered
 *     case inside the `AISettingsPageTsxContract` describe below. No export of
 *     this module had to be left untested, so no export is listed here as
 *     blocked by a live dependency.
 *
 * One note on the DOM: the in-memory DOM comes from linkedom, which this
 * repository already ships as a transitive dependency of the wxt toolchain.
 * The suite locates that copy in bun's isolated install store rather than
 * adding a new devDependency, so nothing outside this file has to change.
 */

import { describe, expect, it, mock } from 'bun:test'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import type { LlmProviderConfig } from '@/lib/llm-providers/types'

/* ------------------------------------------------------------------ *
 * In-memory DOM (linkedom), installed as the global browser ambient  *
 * ------------------------------------------------------------------ */

type LinkedomParseHTML = (html: string) => {
  document: Document
  window: Window & typeof globalThis
}

/**
 * Locate linkedom inside bun's isolated install store. The store keeps one
 * directory per resolved package (for example `linkedom@0.18.12`), so the
 * exact version is discovered rather than hard-coded.
 */
function locateLinkedom(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const monorepoRoot = join(here, '..', '..', '..', '..', '..')
  const installStore = join(monorepoRoot, 'node_modules', '.bun')
  const linkedomDir = readdirSync(installStore).find((entry) =>
    /^linkedom@\d/.test(entry),
  )
  if (!linkedomDir) {
    throw new Error(
      `linkedom was not found in the bun install store at ${installStore}; ` +
        'run bun install in trios/agent-server first',
    )
  }
  return join(
    installStore,
    linkedomDir,
    'node_modules',
    'linkedom',
    'cjs',
    'index.js',
  )
}

const linkedom = (await import(locateLinkedom())) as unknown as {
  parseHTML: LinkedomParseHTML
}

const dom = linkedom.parseHTML(
  '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
)

function installBrowserAmbient(): void {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = dom.window
  globals.document = dom.document
  globals.navigator = dom.window.navigator
  globals.HTMLElement = dom.window.HTMLElement
  globals.Element = dom.window.Element
  globals.Node = dom.window.Node
  globals.Text = dom.window.Text
  globals.Comment = dom.window.Comment
  // linkedom does not expose a NodeFilter global; Radix focus scopes walk the
  // tabbable candidates of overlays with one.
  globals.NodeFilter = {
    SHOW_ALL: 0xffffffff,
    SHOW_ELEMENT: 0x1,
    SHOW_TEXT: 0x4,
    SHOW_COMMENT: 0x80,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
  }
  globals.DocumentFragment = class {
    constructor() {
      // Radix constructs fragments directly via `new DocumentFragment()`,
      // which linkedom forbids; route such construction through the
      // document, which is the standards-blessed way to obtain one.
      return dom.document.createDocumentFragment()
    }
  }
  globals.CustomEvent = dom.window.CustomEvent
  globals.Event = dom.window.Event
  globals.KeyboardEvent = dom.window.KeyboardEvent
  globals.MouseEvent = dom.window.MouseEvent
  globals.getComputedStyle =
    (dom.window as unknown as { getComputedStyle?: unknown })
      .getComputedStyle ??
    ((element: Element) => ({
      getPropertyValue: () => '',
      // Radix presence surfaces read a few standard properties when deciding
      // whether an exit animation is running; empty answers mean "no
      // animation", which unmounts overlays immediately.
      animationName: '',
      animationDuration: '0s',
      transitionDuration: '0s',
      ...element,
    })) as unknown as typeof getComputedStyle
  globals.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number) as (
    callback: FrameRequestCallback,
  ) => number
  globals.cancelAnimationFrame = ((handle: number) => {
    clearTimeout(handle)
  }) as (handle: number) => void
  // Radix positioned surfaces consult these; static no-ops are enough here.
  globals.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // linkedom ships no MutationObserver; Radix focus scopes install one to
  // track removed nodes. A quiet observer is observably equivalent here
  // because no node removal happens while an overlay holds focus.
  globals.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return []
    }
  }
  globals.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  globals.matchMedia =
    globals.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener(): void {},
      removeEventListener(): void {},
      addListener(): void {},
      removeListener(): void {},
      dispatchEvent(): boolean {
        return false
      },
    })) as unknown as typeof matchMedia
  // React 19 expects tests to declare the act environment explicitly.
  globals.IS_REACT_ACT_ENVIRONMENT = true
}

installBrowserAmbient()

/**
 * React's controlled-input change tracking reads the `checked` accessor from
 * the HTMLInputElement prototype; linkedom does not define one, so plain
 * `input.checked = x` would create a shadowing own property and React's
 * radio handling would crash on the missing descriptor. Install a real
 * accessor that also keeps the DOM attribute in sync.
 */
function patchCheckedAccessor(): void {
  for (const tag of ['input', 'textarea', 'select']) {
    const element = dom.document.createElement(tag)
    const proto = Object.getPrototypeOf(element) as object | null
    if (!proto) continue
    if (Object.getOwnPropertyDescriptor(proto, 'checked')) continue
    Object.defineProperty(proto, 'checked', {
      configurable: true,
      get(this: { __checked?: boolean }): boolean {
        return this.__checked === true
      },
      set(this: { __checked?: boolean }, next: boolean): void {
        this.__checked = next === true
        if (next) {
          ;(this as unknown as Element).setAttribute('checked', '')
        } else {
          ;(this as unknown as Element).removeAttribute('checked')
        }
      },
    })
  }
  const globals = globalThis as unknown as Record<string, unknown>
  const windowAsRecord = dom.window as unknown as Record<string, unknown>
  globals.HTMLInputElement = windowAsRecord.HTMLInputElement
  globals.HTMLTextAreaElement = windowAsRecord.HTMLTextAreaElement
  globals.HTMLSelectElement = windowAsRecord.HTMLSelectElement
}

patchCheckedAccessor()

/* ------------------------------------------------------------------ *
 * The faked environment the page talks to                            *
 * ------------------------------------------------------------------ */

interface DeviceCode {
  userCode: string
  providerName: string
  verificationUri: string
}

interface OAuthFlowState {
  disconnectCalls: number
  startCalls: (string | undefined)[]
  pendingDeviceCode: DeviceCode | null
  clearCalls: number
}

function freshFlow(): OAuthFlowState {
  return {
    disconnectCalls: 0,
    startCalls: [],
    pendingDeviceCode: null,
    clearCalls: 0,
  }
}

const builtInProvider: LlmProviderConfig = {
  id: 'browseros',
  type: 'browseros',
  name: 'BrowserOS',
  baseUrl: 'https://api.browseros.com/v1',
  modelId: 'browseros-auto',
  supportsImages: true,
  contextWindow: 200000,
  temperature: 0.2,
  createdAt: 1000,
  updatedAt: 1000,
}

const anthropicProvider: LlmProviderConfig = {
  id: 'anthropic-main',
  type: 'anthropic',
  name: 'Anthropic Sonnet',
  baseUrl: 'https://api.anthropic.com',
  modelId: 'claude-sonnet-4-6',
  apiKey: 'sk-ant-test',
  supportsImages: true,
  contextWindow: 200000,
  temperature: 0.2,
  createdAt: 1000,
  updatedAt: 1000,
}

const chatgptProvider: LlmProviderConfig = {
  id: 'chatgpt-pro-main',
  type: 'chatgpt-pro',
  name: 'ChatGPT Plus/Pro',
  modelId: 'gpt-5.3-codex',
  supportsImages: true,
  contextWindow: 200000,
  temperature: 0.2,
  createdAt: 1000,
  updatedAt: 1000,
}

interface RemoteNode {
  rowId: string
  type: string
  name: string
  baseUrl: string | null
  modelId: string
  supportsImages: boolean
  contextWindow: number | null
  temperature: number | null
  resourceName: string | null
  region: string | null
  createdAt: string
  updatedAt: string
}

const syncedAwayNode: RemoteNode = {
  rowId: 'glm-remote',
  type: 'zai',
  name: 'GLM Remote',
  baseUrl: 'https://api.z.ai/api/paas/v4',
  modelId: 'glm-4.6',
  supportsImages: false,
  contextWindow: 128000,
  temperature: 0.2,
  resourceName: null,
  region: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
}

const alsoLocalNode: RemoteNode = {
  rowId: 'anthropic-main',
  type: 'anthropic',
  name: 'Anthropic Sonnet',
  baseUrl: 'https://api.anthropic.com',
  modelId: 'claude-sonnet-4-6',
  supportsImages: true,
  contextWindow: 200000,
  temperature: 0.2,
  resourceName: null,
  region: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
}

interface ToastRecord {
  kind: 'success' | 'error' | 'info' | 'warning' | 'loading'
  title: string
}

const world = {
  providers: [builtInProvider, anthropicProvider],
  defaultProviderId: 'browseros',
  deletedProviderIds: [] as string[],
  savedProviders: [] as LlmProviderConfig[],
  newDefaultProviderIds: [] as string[],
  sessionInfo: { user: { id: 'user-1' } },
  profileId: 'profile-9',
  remoteNodes: [alsoLocalNode, syncedAwayNode] as RemoteNode[],
  agentServerUrl: null as string | null,
  graphqlQueries: [] as { document: string; variables: unknown }[],
  remoteDeleteRequests: [] as { rowId: string }[],
  flows: {
    'chatgpt-pro': freshFlow(),
    'github-copilot': freshFlow(),
    'qwen-code': freshFlow(),
  } as Record<string, OAuthFlowState>,
  testRequests: [] as { providerId: string; serverUrl: string }[],
  nextTestResult: { success: true, message: 'Model responded' },
  toasts: [] as ToastRecord[],
  trackedEvents: [] as { event: string }[],
  navigations: [] as string[],
}

/* ------------------------------------------------------------------ *
 * Module-boundary fakes, registered before the subject is imported   *
 * ------------------------------------------------------------------ */

mock.module('@/lib/llm-providers/useLlmProviders', () => ({
  useLlmProviders: () => ({
    providers: world.providers,
    defaultProviderId: world.defaultProviderId,
    selectedProvider:
      world.providers.find((p) => p.id === world.defaultProviderId) ?? null,
    isLoading: false,
    saveProvider: async (provider: LlmProviderConfig) => {
      world.savedProviders.push(provider)
    },
    setDefaultProvider: async (providerId: string) => {
      world.newDefaultProviderIds.push(providerId)
      world.defaultProviderId = providerId
    },
    deleteProvider: async (providerId: string) => {
      world.deletedProviderIds.push(providerId)
    },
  }),
}))

mock.module('@/lib/auth/sessionStorage', () => ({
  useSessionInfo: () => ({
    sessionInfo: world.sessionInfo,
    isLoading: false,
  }),
}))

mock.module('@/lib/browseros/useBrowserOSProviders', () => ({
  useAgentServerUrl: () => ({
    baseUrl: world.agentServerUrl,
    isLoading: false,
    error: null,
  }),
}))

mock.module('@/lib/graphql/useGraphqlQuery', () => ({
  useGraphqlQuery: (
    document: unknown,
    variables: unknown,
    options?: { enabled?: boolean },
  ) => {
    const source = String(document)
    world.graphqlQueries.push({
      document: source,
      variables: options?.enabled === false ? undefined : variables,
    })
    if (source.includes('profileByUserId')) {
      const userId = world.sessionInfo.user?.id
      return {
        data: userId
          ? { profileByUserId: { rowId: world.profileId } }
          : undefined,
      }
    }
    return { data: { llmProviders: { nodes: world.remoteNodes } } }
  },
}))

mock.module('@/lib/graphql/useGraphqlMutation', () => ({
  useGraphqlMutation: (
    document: unknown,
    options?: {
      onSuccess?: (data: unknown, variables: unknown, context: unknown) => void
    },
  ) => ({
    mutate: (variables: { rowId: string }) => {
      if (String(document).includes('deleteLlmProvider')) {
        world.remoteDeleteRequests.push(variables)
        options?.onSuccess?.(undefined, variables, undefined)
      }
    },
  }),
}))

mock.module('@/lib/llm-providers/useOAuthProviderFlow', () => ({
  useOAuthProviderFlow: (config: { providerType: string }) => {
    const flow = world.flows[config.providerType]
    return {
      status: null,
      disconnect: async () => {
        flow.disconnectCalls += 1
      },
      startOAuthFlow: async (agentServerUrl: string | undefined) => {
        flow.startCalls.push(agentServerUrl)
      },
      pendingDeviceCode: flow.pendingDeviceCode,
      clearDeviceCode: () => {
        flow.clearCalls += 1
        flow.pendingDeviceCode = null
      },
    }
  },
}))

mock.module('@/lib/metrics/track', () => ({
  track: (event: string) => {
    world.trackedEvents.push({ event })
  },
}))

mock.module('@/lib/llm-providers/testProvider', () => ({
  testProvider: async (
    provider: { id: string },
    serverUrl: string,
  ): Promise<{ success: boolean; message: string }> => {
    world.testRequests.push({ providerId: provider.id, serverUrl })
    return world.nextTestResult
  },
}))

mock.module('@/lib/browseros/useCapabilities', () => ({
  useCapabilities: () => ({
    supports: () => true,
    isLoading: false,
    browserOSVersion: '1.0.0-test',
    serverVersion: '1.0.0-test',
  }),
}))

mock.module('sonner', () => ({
  toast: Object.assign(
    (_message: string, _data?: unknown) => {},
    {
      success: (title: string) => {
        world.toasts.push({ kind: 'success', title })
      },
      error: (title: string) => {
        world.toasts.push({ kind: 'error', title })
      },
      warning: (title: string) => {
        world.toasts.push({ kind: 'warning', title })
      },
      info: (title: string) => {
        world.toasts.push({ kind: 'info', title })
      },
      loading: (title: string) => {
        world.toasts.push({ kind: 'loading', title })
      },
      message: (title: string) => {
        world.toasts.push({ kind: 'info', title })
      },
      promise: async <T,>(value: T | Promise<T>) => value,
      custom: () => {},
      dismiss: () => {},
    },
  ),
}))

mock.module('react-router', () => ({
  useNavigate: () => (to: string) => {
    world.navigations.push(to)
  },
}))

/* ------------------------------------------------------------------ *
 * The subject, imported only after every fake is in place            *
 * ------------------------------------------------------------------ */

const { AISettingsPage } = await import('./AISettingsPage')
const { createRoot } = await import('react-dom/client')

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
})

const container = dom.document.getElementById('root') as unknown as HTMLElement
const root = createRoot(container)

function renderPage(): Promise<void> {
  return act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AISettingsPage),
      ),
    )
  })
}

/* ------------------------------------------------------------------ *
 * Tiny DOM helpers over the in-memory document                       *
 * ------------------------------------------------------------------ */

function normalizedTextOf(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function allElements(): Element[] {
  return Array.from(dom.document.querySelectorAll('*'))
}

function elementsWithText(text: string): Element[] {
  return allElements().filter(
    (element) => normalizedTextOf(element) === text,
  )
}

function bodyText(): string {
  return normalizedTextOf(dom.document.body)
}

function buttonsWithText(text: string): HTMLButtonElement[] {
  return elementsWithText(text).filter(
    (element) => element.tagName === 'BUTTON',
  ) as unknown as HTMLButtonElement[]
}

function providerCardByName(name: string): Element {
  const card = allElements().find(
    (element) =>
      element.tagName === 'LABEL' && normalizedTextOf(element).includes(name),
  )
  if (!card) {
    throw new Error(`provider card "${name}" was not rendered`)
  }
  return card
}

/** The action row of an "incomplete provider" card, anchored on its button. */
function actionsAround(button: HTMLButtonElement): Element {
  const actions = button.parentElement
  if (!actions) {
    throw new Error('action row was not found around the given button')
  }
  return actions
}

function cardButtons(card: Element): HTMLButtonElement[] {
  return Array.from(card.querySelectorAll('button')) as unknown as HTMLButtonElement[]
}

function silentButtonsIn(card: Element): HTMLButtonElement[] {
  return cardButtons(card).filter(
    (button) => normalizedTextOf(button) === '',
  )
}

function openDialog(): Element | undefined {
  return (
    allElements().find(
      (element) =>
        element.getAttribute('role') === 'alertdialog' ||
        element.getAttribute('role') === 'dialog',
    ) ?? undefined
  )
}

function inputValues(): string[] {
  return Array.from(dom.document.querySelectorAll('input')).map(
    (input) => (input as HTMLInputElement).value,
  )
}

async function press(element: Element): Promise<void> {
  const MouseEventCtor =
    (dom.window as unknown as { MouseEvent?: typeof globalThis.Event })
      .MouseEvent ?? globalThis.Event
  await act(async () => {
    element.dispatchEvent(
      new MouseEventCtor('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }) as Event,
    )
  })
  await act(async () => {})
}

/**
 * Toggle a radio the way a browser does: the default action of a click flips
 * the internal checked state first, and React fires the change handler from
 * the click itself. Flipping the backing field directly (instead of the
 * tracked property setter) is what makes React treat the change as
 * user-initiated rather than its own echo.
 */
async function chooseRadio(input: HTMLInputElement): Promise<void> {
  const backing = input as unknown as { __checked?: boolean }
  backing.__checked = true
  input.setAttribute('checked', '')
  const MouseEventCtor =
    (dom.window as unknown as { MouseEvent?: typeof globalThis.Event })
      .MouseEvent ?? globalThis.Event
  await act(async () => {
    input.dispatchEvent(
      new MouseEventCtor('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }) as Event,
    )
  })
  await act(async () => {})
}

/* ------------------------------------------------------------------ *
 * The pinned contract of AISettingsPage                              *
 * ------------------------------------------------------------------ */

describe('AISettingsPageTsxContract', () => {
  it('AISettingsPage: renders the settings surface and drives every user flow', async () => {
    // --- the page as it first appears --------------------------------
    await renderPage()

    expect(bodyText()).toContain('LLM Providers')
    expect(bodyText()).toContain(
      'Add your provider and choose the default LLM',
    )
    expect(bodyText()).toContain('Quick provider templates')
    expect(bodyText()).toContain('templates available')
    expect(bodyText()).toContain(
      'Use BrowserOS with Claude Code, Cursor & more',
    )

    // Both configured providers are listed as cards.
    expect(elementsWithText('BrowserOS').length).toBeGreaterThan(0)
    expect(elementsWithText('Anthropic Sonnet').length).toBeGreaterThan(0)

    // The default badge sits on the default provider and nowhere else.
    const defaultBadges = elementsWithText('DEFAULT')
    expect(defaultBadges.length).toBe(1)
    expect(
      defaultBadges[0].closest('label')?.textContent ?? '',
    ).toContain('BrowserOS')

    // Only the custom provider offers Test and Edit actions; the built-in
    // provider card does not.
    const customCard = providerCardByName('Anthropic Sonnet')
    expect(buttonsWithText('Test').length).toBe(1)
    expect(buttonsWithText('Edit').length).toBe(1)
    const builtInCard = providerCardByName('BrowserOS')
    expect(cardButtons(builtInCard).length).toBe(0)

    // --- providers synced from another device but missing locally ----
    // The remote node whose rowId matches a local provider is complete and
    // must not be offered again; the other one is listed for key entry.
    expect(bodyText()).toContain('Synced Providers (Missing API Keys)')
    expect(bodyText()).toContain(
      'were synced from another device but need API keys',
    )
    expect(bodyText()).toContain('GLM Remote')
    expect(bodyText()).toContain('glm-4.6')
    expect(buttonsWithText('Add Keys').length).toBe(1)

    // --- choosing a different default provider -----------------------
    const radio = dom.document.getElementById(
      'provider-anthropic-main',
    ) as unknown as HTMLInputElement
    await chooseRadio(radio)
    expect(world.newDefaultProviderIds).toEqual(['anthropic-main'])

    world.defaultProviderId = 'anthropic-main'
    await renderPage()
    const movedBadges = elementsWithText('DEFAULT')
    expect(movedBadges.length).toBe(1)
    expect(
      movedBadges[0].closest('label')?.textContent ?? '',
    ).toContain('Anthropic Sonnet')

    // --- templates: OAuth providers start their flow, others open the
    // --- configuration dialog pre-filled from the template ------------
    world.agentServerUrl = 'http://agent.local'
    await renderPage()

    const qwenCard = allElements().find(
      (element) =>
        element.tagName === 'BUTTON' &&
        normalizedTextOf(element).includes('Qwen Code'),
    ) as unknown as HTMLButtonElement
    await press(qwenCard)
    expect(world.flows['qwen-code'].startCalls).toEqual(['http://agent.local'])
    expect(openDialog()).toBeUndefined()

    world.agentServerUrl = null
    await renderPage()
    await press(qwenCard)
    expect(world.flows['qwen-code'].startCalls).toEqual([
      'http://agent.local',
      undefined,
    ])

    const moonshotCard = allElements().find(
      (element) =>
        element.tagName === 'BUTTON' &&
        normalizedTextOf(element).includes('Moonshot AI'),
    ) as unknown as HTMLButtonElement
    await press(moonshotCard)
    let dialog = openDialog()
    expect(dialog).toBeDefined()
    expect(normalizedTextOf(dialog as Element)).toContain(
      'Configure New Provider',
    )
    // The dialog is pre-filled from the template: name, base URL and model.
    expect(inputValues()).toContain('Moonshot AI')
    expect(inputValues()).toContain('https://api.moonshot.ai/v1')
    expect(normalizedTextOf(dialog as Element)).toContain('kimi-k2.5')
    const closeButtons = buttonsWithText('Close')
    await press(closeButtons[closeButtons.length - 1])
    expect(openDialog()).toBeUndefined()

    // --- device-code dialog for client-auth OAuth flows ---------------
    world.flows['github-copilot'].pendingDeviceCode = {
      userCode: 'WDJB-MJHT',
      providerName: 'GitHub Copilot',
      verificationUri: 'https://github.com/login/device',
    }
    await renderPage()
    dialog = openDialog()
    expect(dialog).toBeDefined()
    expect(normalizedTextOf(dialog as Element)).toContain(
      'Connect to GitHub Copilot',
    )
    expect(normalizedTextOf(dialog as Element)).toContain('WDJB-MJHT')
    expect(normalizedTextOf(dialog as Element)).toContain(
      'Open verification page',
    )
    const deviceClose = buttonsWithText('Close')
    await press(deviceClose[deviceClose.length - 1])
    // Closing asks the OAuth flow to drop the pending code (the fake clears
    // its state above), and the dialog disappears with the re-render that
    // the real hook would trigger from that same state change.
    expect(world.flows['github-copilot'].clearCalls).toBe(1)
    await renderPage()
    expect(openDialog()).toBeUndefined()

    // --- testing a provider connection --------------------------------
    // Without a reachable agent server the test is refused up front.
    world.agentServerUrl = null
    await renderPage()
    await press(buttonsWithText('Test')[0])
    expect(world.testRequests).toEqual([])
    expect(world.toasts).toEqual([
      { kind: 'error', title: 'Test Failed' },
    ])
    expect(buttonsWithText('Testing...').length).toBe(0)

    // With a server, the provider is tested through the server and the
    // outcome is reported as a toast.
    world.agentServerUrl = 'http://agent.local'
    world.nextTestResult = { success: true, message: 'Model responded' }
    await renderPage()
    await press(buttonsWithText('Test')[0])
    expect(world.testRequests).toEqual([
      { providerId: 'anthropic-main', serverUrl: 'http://agent.local' },
    ])
    expect(world.toasts[world.toasts.length - 1]).toEqual({
      kind: 'success',
      title: 'Test Successful',
    })
    expect(buttonsWithText('Testing...').length).toBe(0)

    // A failing probe is reported as a failure.
    world.nextTestResult = { success: false, message: '401 unauthorized' }
    await press(buttonsWithText('Test')[0])
    expect(world.toasts[world.toasts.length - 1]).toEqual({
      kind: 'error',
      title: 'Test Failed',
    })
    expect(buttonsWithText('Testing...').length).toBe(0)

    // --- deleting a configured provider needs confirmation ------------
    const deleteButton = silentButtonsIn(customCard)[0]
    await press(deleteButton)
    dialog = openDialog()
    expect(dialog).toBeDefined()
    expect(normalizedTextOf(dialog as Element)).toContain('Delete Provider')
    expect(normalizedTextOf(dialog as Element)).toContain(
      'Are you sure you want to delete "Anthropic Sonnet"? This action cannot be undone.',
    )

    // Cancelling changes nothing.
    await press(buttonsWithText('Cancel')[buttonsWithText('Cancel').length - 1])
    expect(openDialog()).toBeUndefined()
    expect(world.deletedProviderIds).toEqual([])
    expect(world.remoteDeleteRequests).toEqual([])

    // Confirming removes the provider locally and remotely.
    await press(deleteButton)
    await press(buttonsWithText('Delete')[buttonsWithText('Delete').length - 1])
    expect(openDialog()).toBeUndefined()
    expect(world.deletedProviderIds).toEqual(['anthropic-main'])
    expect(world.remoteDeleteRequests).toEqual([{ rowId: 'anthropic-main' }])
    expect(world.flows['chatgpt-pro'].disconnectCalls).toBe(0)
    expect(world.flows['qwen-code'].disconnectCalls).toBe(0)

    // --- deleting an OAuth-backed provider also signs it out ----------
    world.providers = [builtInProvider, chatgptProvider]
    world.deletedProviderIds = []
    await renderPage()
    const chatgptCard = providerCardByName('ChatGPT Plus/Pro')
    await press(silentButtonsIn(chatgptCard)[0])
    await press(buttonsWithText('Delete')[buttonsWithText('Delete').length - 1])
    expect(world.deletedProviderIds).toEqual(['chatgpt-pro-main'])
    expect(world.remoteDeleteRequests).toEqual([
      { rowId: 'anthropic-main' },
      { rowId: 'chatgpt-pro-main' },
    ])
    expect(world.flows['chatgpt-pro'].disconnectCalls).toBe(1)

    // --- removing a synced provider that never landed locally ---------
    // Drop the Anthropic entry from both stores so the only remote provider
    // left is the one that never landed on this device.
    world.providers = [builtInProvider]
    world.remoteNodes = [syncedAwayNode]
    world.remoteDeleteRequests = []
    await renderPage()
    const addKeysButtons = buttonsWithText('Add Keys')
    const remoteActions = actionsAround(addKeysButtons[0])
    await press(silentButtonsIn(remoteActions)[0])
    dialog = openDialog()
    expect(dialog).toBeDefined()
    expect(normalizedTextOf(dialog as Element)).toContain(
      'Delete Synced Provider',
    )
    expect(normalizedTextOf(dialog as Element)).toContain(
      'Are you sure you want to delete "GLM Remote"? This will remove it from all your devices.',
    )
    await press(buttonsWithText('Delete')[buttonsWithText('Delete').length - 1])
    expect(openDialog()).toBeUndefined()
    expect(world.remoteDeleteRequests).toEqual([{ rowId: 'glm-remote' }])
    expect(world.deletedProviderIds).toEqual(['chatgpt-pro-main'])

    // --- adding keys to a synced provider opens the dialog in edit mode,
    // --- with the synced values already filled in ----------------------
    await press(buttonsWithText('Add Keys')[0])
    dialog = openDialog()
    expect(dialog).toBeDefined()
    // The synced row carries its id, so the dialog offers to edit rather
    // than configure from scratch.
    expect(normalizedTextOf(dialog as Element)).toContain('Edit Provider')
    expect(normalizedTextOf(dialog as Element)).toContain('z.ai')
    expect(inputValues()).toContain('GLM Remote')
    expect(inputValues()).toContain('glm-4.6')
    expect(inputValues()).toContain('https://api.z.ai/api/paas/v4')

    // --- the plain "add provider" entry point opens an empty dialog ---
    const prefillCount = inputValues().filter((v) => v === '').length
    const addButtons = buttonsWithText('Add custom provider')
    await press(addButtons[addButtons.length - 1])
    expect(openDialog()).toBeDefined()
    // Still an empty configuration form, not a pre-filled one.
    expect(inputValues().filter((v) => v === '').length).toBeGreaterThan(
      prefillCount - 1,
    )

    // --- the page resolved the user's profile before loading remote ---
    // providers (the profile id flows into the provider query).
    const remoteQuery = world.graphqlQueries.find((query) =>
      query.document.includes('llmProviders'),
    )
    expect(remoteQuery?.variables).toEqual({ profileId: 'profile-9' })
    const profileQuery = world.graphqlQueries.find((query) =>
      query.document.includes('profileByUserId'),
    )
    expect(profileQuery?.variables).toEqual({ userId: 'user-1' })

    await act(async () => {
      root.unmount()
    })
  })
})
