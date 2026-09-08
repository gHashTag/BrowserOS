/**
 * First contract suite for `NewTab.tsx`.
 *
 * The module exports exactly one symbol, and this suite pins that export's
 * observable behaviour as it stands today:
 *
 *   - `NewTab` — exercised below end-to-end: server-render of the first
 *     paint, mounted client render, typing into the search box, keyboard
 *     selection of a suggestion, and the `@`-mention tab picker. No export
 *     of this module is blocked by a live dependency, so the
 * "could not be pinned" list required by the issue is empty. (Should an
 * export ever become untestable without a live service, name that export
 * and the dependency in a comment here rather than dropping the coverage
 * silently.)
 *
 * The suite runs entirely offline. A clean checkout has neither the GraphQL
 * codegen output under `@/generated` (that artifact is produced by
 * `codegen`, which needs the live agent server) nor the WXT build-time
 * virtual module `#imports` (produced by `wxt prepare`), and there is no
 * extension host or agent server at test time. Those build/live inputs are
 * replaced with local stand-ins below; every assertion observes behaviour
 * through the rendered DOM (markup, navigation, host messaging) rather than
 * internal wiring.
 */
import { describe, expect, it, mock } from 'bun:test'
import { act, createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

// ---------------------------------------------------------------------------
// Local stand-in for the extension host APIs the component tree touches.
// Installed before any module of the tree is imported, because
// `webextension-polyfill` (pulled in by `@webext-core/messaging`) refuses to
// load outside an extension.
// ---------------------------------------------------------------------------

type ChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) => void

const storageChangeListeners = new Set<ChangeListener>()
const storageData = new Map<string, Record<string, unknown>>()

const makeStorageArea = (areaName: string) => ({
  // wxt/storage watches for changes through each area's `onChanged`.
  onChanged: {
    addListener: (listener: ChangeListener) => {
      storageChangeListeners.add(listener)
    },
    removeListener: (listener: ChangeListener) => {
      storageChangeListeners.delete(listener)
    },
    hasListener: (listener: ChangeListener) =>
      storageChangeListeners.has(listener),
  },
  get: (
    keys: string | string[] | Record<string, unknown> | null,
    callback?: (result: Record<string, unknown>) => void,
  ) => {
    const area = storageData.get(areaName) ?? {}
    const result: Record<string, unknown> = {}
    if (keys == null) {
      Object.assign(result, area)
    } else if (typeof keys === 'string') {
      if (keys in area) result[keys] = area[keys]
    } else if (Array.isArray(keys)) {
      for (const key of keys) {
        if (key in area) result[key] = area[key]
      }
    } else {
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = key in area ? area[key] : fallback
      }
    }
    if (typeof callback === 'function') callback(result)
    return Promise.resolve(result)
  },
  set: (items: Record<string, unknown>, callback?: () => void) => {
    const area = storageData.get(areaName) ?? {}
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> =
      {}
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: area[key], newValue: value }
      area[key] = value
    }
    storageData.set(areaName, area)
    for (const listener of storageChangeListeners) listener(changes, areaName)
    if (typeof callback === 'function') callback()
    return Promise.resolve()
  },
  remove: (keys: string | string[] | null, callback?: () => void) => {
    const area = storageData.get(areaName) ?? {}
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (key != null) delete area[key]
    }
    storageData.set(areaName, area)
    if (typeof callback === 'function') callback()
    return Promise.resolve()
  },
})

const makeEvent = () => {
  const listeners = new Set<(...args: unknown[]) => void>()
  return {
    addListener: (listener: (...args: unknown[]) => void) => {
      listeners.add(listener)
    },
    removeListener: (listener: (...args: unknown[]) => void) => {
      listeners.delete(listener)
    },
    hasListener: (listener: (...args: unknown[]) => void) =>
      listeners.has(listener),
  }
}

const hostMessages: unknown[] = []

const fakeChrome = {
  runtime: {
    id: 'newtab-contract-suite',
    getManifest: () => ({ version: '0.0.0-contract-suite' }),
    getURL: (path: string) =>
      `chrome-extension://newtab-contract-suite/${path}`,
    onMessage: makeEvent(),
    sendMessage: (message: unknown, callback?: (response: unknown) => void) => {
      hostMessages.push(message)
      if (typeof callback === 'function') callback(undefined)
      return Promise.resolve(undefined)
    },
    lastError: undefined as { message?: string } | undefined,
  },
  storage: {
    local: makeStorageArea('local'),
    sync: makeStorageArea('sync'),
    session: makeStorageArea('session'),
    onChanged: {
      addListener: (listener: ChangeListener) => {
        storageChangeListeners.add(listener)
      },
      removeListener: (listener: ChangeListener) => {
        storageChangeListeners.delete(listener)
      },
      hasListener: (listener: ChangeListener) =>
        storageChangeListeners.has(listener),
    },
  },
  tabs: {
    query: (
      _queryInfo: unknown,
      callback?: (tabs: unknown[]) => void,
    ) => {
      const tabs: unknown[] = []
      if (typeof callback === 'function') callback(tabs)
      return Promise.resolve(tabs)
    },
  },
  topSites: {
    get: (callback?: (sites: { title: string; url: string }[]) => void) => {
      const sites: { title: string; url: string }[] = []
      if (typeof callback === 'function') callback(sites)
      return Promise.resolve(sites)
    },
  },
  // Feature-detected by the BrowserOS adapter: an empty object makes every
  // browserOS capability report "unsupported", which is exactly the state of
  // a machine without the BrowserOS host.
  browserOS: {} as Record<string, unknown>,
}

// The onboarding hint timers must never fire mid-suite, so both hint
// dismissal timestamps are pre-seeded as "dismissed a moment ago".
storageData.set('local', {
  importHintDismissedAt: Date.now(),
  signInHintDismissedAt: Date.now(),
})

const savedGlobals: Record<string, unknown> = {}
const installGlobal = (name: string, value: unknown) => {
  if (!(name in savedGlobals)) savedGlobals[name] = (globalThis as never)[name]
  ;(globalThis as Record<string, unknown>)[name] = value
}

installGlobal('chrome', fakeChrome)
installGlobal('browser', fakeChrome)

// ---------------------------------------------------------------------------
// Build-time inputs that a clean checkout does not have.
// ---------------------------------------------------------------------------

// The GraphQL codegen artifact only exists after `codegen` runs against the
// live agent server. Consumers only need the `graphql` document tag, whose
// documents are never executed here (every network attempt below receives a
// canned 503), so the tag is stood in with an identity template function.
mock.module('@/generated/graphql/gql', () => ({
  graphql: (...args: unknown[]) => {
    if (args.length === 1) return args[0]
    const strings = args[0] as TemplateStringsArray
    const values = args.slice(1)
    return strings.reduce(
      (acc: string, part: string, index: number) =>
        `${acc}${part}${String(values[index] ?? '')}`,
      '',
    )
  },
}))

// The WXT virtual module `#imports` only exists after `wxt prepare`. The only
// name consumed from the whole graph is `storage`, which WXT itself aliases
// to `@wxt-dev/storage` - so that real package is what the stand-in serves.
const wxtStorageModule = await import('@wxt-dev/storage')
mock.module('#imports', () => ({ storage: wxtStorageModule.storage }))

// ---------------------------------------------------------------------------
// Subject under test, imported only after the environment above is in place.
// ---------------------------------------------------------------------------

const { NewTab } = await import('./NewTab')
const { ChatSessionProvider } = await import(
  '../../sidepanel/layout/ChatSessionContext'
)
const { QueryClient, QueryClientProvider } = await import(
  '@tanstack/react-query'
)

// linkedom ships as a transitive dependency of the pinned `wxt` dev
// dependency and gives the client-side render pass a DOM with working
// effects, which `react-dom/server` cannot provide.
const { parseHTML } = await import(
  '../../../../../node_modules/.bun/linkedom@0.18.12/node_modules/linkedom/esm/index.js'
)

const settle = async (rounds = 4) => {
  for (let index = 0; index < rounds; index++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('NewTabTsxContract', () => {
  it('NewTab: first paint, mounted affordances, suggestions, keyboard search hand-off and @-mention picker', async () => {
    // -----------------------------------------------------------------------
    // 1. Server render: the contract of the very first paint, before any
    //    effect has run.
    // -----------------------------------------------------------------------
    const ssrQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const ssrMarkup = renderToStaticMarkup(
      h(
        MemoryRouter,
        { initialEntries: ['/'] },
        h(
          QueryClientProvider,
          { client: ssrQueryClient },
          h(ChatSessionProvider, { origin: 'newtab' }, h(NewTab)),
        ),
      ),
    )

    // The search box addresses the default engine (Google) and offers voice.
    expect(ssrMarkup).toContain('Ask BrowserOS or search Google...')
    expect(ssrMarkup).toContain('title="Voice input"')
    // Top sites render immediately on the first paint.
    expect(ssrMarkup).toContain('Top Sites')
    // Nothing effect-gated is present yet: no Tabs footer, no suggestion
    // listbox, no suggestion rows.
    expect(ssrMarkup).not.toContain('>Tabs<')
    expect(ssrMarkup).not.toContain('listbox')
    expect(ssrMarkup).not.toContain('Ask BrowserOS:')

    // -----------------------------------------------------------------------
    // 2. Client render: effects run, so the mounted footer appears.
    // -----------------------------------------------------------------------
    const dom = parseHTML(
      '<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>',
    )
    const domWindow = dom.window as unknown as {
      document: Document
      Event: new (type: string, init?: { bubbles?: boolean }) => Event
      KeyboardEvent?: new (type: string, init?: { key?: string }) => Event
      open: (...args: unknown[]) => unknown
      fetch: typeof fetch
      HTMLInputElement: { prototype: HTMLInputElement }
    }
    const domDocument = domWindow.document

    installGlobal('window', domWindow)
    installGlobal('document', domDocument)
    // A deterministic non-Mac platform keeps shortcut hints stable.
    installGlobal('navigator', {
      platform: 'Linux x86_64',
      userAgent: 'newtab-contract-suite',
      language: 'en-US',
    })
    // NewTabTip reads the browser's web storage synchronously on mount.
    const makeWebStorage = () => {
      const data = new Map<string, string>()
      return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
          data.set(key, value)
        },
        removeItem: (key: string) => {
          data.delete(key)
        },
        clear: () => data.clear(),
      }
    }
    installGlobal('sessionStorage', makeWebStorage())
    installGlobal('localStorage', makeWebStorage())
    installGlobal(
      'requestAnimationFrame',
      (callback: (time: number) => void) =>
        setTimeout(() => callback(Date.now()), 0) as unknown as number,
    )
    installGlobal(
      'cancelAnimationFrame',
      (handle: number) => clearTimeout(handle),
    )
    installGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    installGlobal(
      'matchMedia',
      () =>
        ({
          matches: false,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    )

    // Geometry that layout-less DOMs cannot provide, needed by the mounted
    // glowing border (SVG) and by floating UI positioning.
    const svgElement = domDocument.createElementNS(
      'http://www.w3.org/2000/svg',
      'rect',
    )
    const svgPrototype = Object.getPrototypeOf(svgElement) as Record<
      string,
      unknown
    >
    if (typeof svgPrototype.getTotalLength !== 'function') {
      svgPrototype.getTotalLength = () => 100
    }
    if (typeof svgPrototype.getBBox !== 'function') {
      svgPrototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 100 })
    }

    // Every network attempt is answered locally with a 503: the pinned state
    // is "no agent server reachable", which is how the page must behave.
    const offlineResponse = () =>
      new Response('{"detail":"offline"}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    installGlobal('fetch', offlineResponse as typeof fetch)
    domWindow.fetch = offlineResponse as typeof fetch

    const openedUrls: string[][] = []
    domWindow.open = (...args: unknown[]) => {
      openedUrls.push(args.map(String))
      return null
    }

    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    const { createRoot } = await import('react-dom/client')
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const container = domDocument.getElementById('root') as HTMLElement
    const root = createRoot(container)

    const inputSelector = 'input[type="text"]'
    const bodyText = () => domDocument.body.textContent ?? ''
    const setInputValue = (value: string) => {
      const input = domDocument.querySelector(
        inputSelector,
      ) as unknown as HTMLInputElement
      const descriptor = Object.getOwnPropertyDescriptor(
        domWindow.HTMLInputElement.prototype,
        'value',
      )
      if (descriptor?.set) {
        descriptor.set.call(input, value)
      } else {
        input.value = value
      }
      input.dispatchEvent(new domWindow.Event('input', { bubbles: true }))
    }
    const pressKey = (key: string) => {
      const input = domDocument.querySelector(inputSelector) as HTMLElement
      const EventConstructor =
        domWindow.KeyboardEvent ??
        (domWindow.Event as unknown as typeof KeyboardEvent)
      const event = new EventConstructor('keydown', { key })
      Object.defineProperty(event, 'key', {
        value: key,
        configurable: true,
      })
      input.dispatchEvent(event as Event)
    }

    try {
      await act(async () => {
        root.render(
          h(
            MemoryRouter,
            { initialEntries: ['/'] },
            h(
              QueryClientProvider,
              { client: queryClient },
              h(ChatSessionProvider, { origin: 'newtab' }, h(NewTab)),
            ),
          ),
        )
      })
      await settle()

      // The mount effect reveals the footer: the Tabs picker button is now
      // present, and with no BrowserOS host reachable the version-gated
      // Apps affordance stays hidden.
      expect(domDocument.body.innerHTML).toContain('>Tabs<')
      expect(bodyText()).not.toContain('>Apps<')
      expect(bodyText()).toContain('Top Sites')
      expect(
        domDocument.querySelector('button[title="Voice input"]'),
      ).not.toBeNull()

      // ---------------------------------------------------------------------
      // 3. Typing a query surfaces the suggestion list: the always-on agent
      //    row plus the default engine's section with the query as the first
      //    search entry.
      // ---------------------------------------------------------------------
      await act(async () => {
        setInputValue('hello')
      })
      await settle()

      expect(bodyText()).toContain('Ask BrowserOS: hello')
      expect(bodyText()).toContain('Google Search')
      expect(bodyText()).toContain('hello')

      // ---------------------------------------------------------------------
      // 4. Keyboard hand-off: arrow down past the agent row onto the Google
      //    row, then Enter - the page must navigate the default engine to
      //    the typed query.
      // ---------------------------------------------------------------------
      await act(async () => {
        pressKey('ArrowDown')
        pressKey('ArrowDown')
        pressKey('Enter')
      })
      await settle()

      expect(openedUrls.length).toBeGreaterThan(0)
      expect(openedUrls[0]?.[0]).toBe(
        'https://www.google.com/search?q=hello',
      )
      expect(openedUrls[0]?.[1]).toBe('_self')

      // ---------------------------------------------------------------------
      // 5. Typing `@` at the cursor opens the tab-attach mention picker.
      // ---------------------------------------------------------------------
      await act(async () => {
        setInputValue('@')
      })
      await settle()

      expect(bodyText()).toContain('Attach Tabs')
      expect(bodyText()).toContain('No active tabs')
    } finally {
      await act(async () => {
        root.unmount()
      })
      queryClient.clear()
      for (const [name, value] of Object.entries(savedGlobals)) {
        ;(globalThis as Record<string, unknown>)[name] = value
      }
      delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
    }
  })
})
