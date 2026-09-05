/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Contract suite for the exports of useLlmProviders.ts.
 *
 * The module exports exactly one symbol: `useLlmProviders`. Every assertion
 * below mounts that export inside a probe component and asserts on the
 * values the hook returns and on what it does to the provider storage it
 * talks to, so the suite pins observable behaviour rather than the shape of
 * the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`useLlmProviders`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The hook's only live dependency is the wxt-backed provider storage in
 * `./storage`, whose real bindings need a browser `chrome.storage` API that
 * does not exist under `bun test`. That module is swapped for an in-memory
 * substrate with the same surface (getValue / setValue / watch, change
 * notifications on write) via `mock.module`, so this suite needs no
 * network, no database and no container.
 *
 * Rendering: `bun test` has no DOM environment in this project
 * (`@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile), so this suite brings its own minimal fake DOM surface - just
 * enough for `react-dom/client`'s `createRoot` to mount a component that
 * renders `null` - and drives it with React 19's `act`. The hook's effects
 * (initial load, storage watch, cleanup on unmount) run for real; only the
 * DOM nodes are fake, and none are ever created.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from 'bun:test'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LlmProviderConfig } from './types'

// ---------------------------------------------------------------------------
// Minimal fake DOM surface for `react-dom/client`
// ---------------------------------------------------------------------------

class FakeNode {
  nodeType: number
  parentNode: FakeNode | null = null
  childNodes: FakeNode[] = []
  constructor(nodeType: number) {
    this.nodeType = nodeType
  }
  appendChild(child: FakeNode) {
    this.childNodes.push(child)
    child.parentNode = this
    return child
  }
  insertBefore(child: FakeNode, ref: FakeNode | null) {
    const i = ref ? this.childNodes.indexOf(ref) : -1
    if (i < 0) this.childNodes.push(child)
    else this.childNodes.splice(i, 0, child)
    child.parentNode = this
    return child
  }
  removeChild(child: FakeNode) {
    const i = this.childNodes.indexOf(child)
    if (i >= 0) this.childNodes.splice(i, 1)
    child.parentNode = null
    return child
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
}

// React DOM reads `window.event` when resolving update priority, and the
// owner document's `defaultView` when looking for the active element.
const g = globalThis as Record<string, unknown>
const previousWindow = g.window
const previousActEnv = g.IS_REACT_ACT_ENVIRONMENT

const fakeWindow = {
  event: undefined,
  HTMLIFrameElement: class HTMLIFrameElement {},
  document: null as unknown,
}
const fakeDocument = Object.assign(new FakeNode(9), {
  createElement: () => new FakeNode(1),
  createTextNode: (_text: string) => new FakeNode(3),
  createComment: () => new FakeNode(8),
  defaultView: fakeWindow,
  activeElement: null,
})
fakeWindow.document = fakeDocument

g.window = fakeWindow
g.IS_REACT_ACT_ENVIRONMENT = true

afterAll(() => {
  if (previousWindow === undefined) delete g.window
  else g.window = previousWindow
  if (previousActEnv === undefined) delete g.IS_REACT_ACT_ENVIRONMENT
  else g.IS_REACT_ACT_ENVIRONMENT = previousActEnv
})

// ---------------------------------------------------------------------------
// In-memory substrate for `./storage`
// ---------------------------------------------------------------------------

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

const DEFAULT_PROVIDER_ID = 'browseros'

/** Mirrors createDefaultProvidersConfig() with fixed timestamps. */
const defaultProvidersConfig = (): LlmProviderConfig[] => [
  {
    id: DEFAULT_PROVIDER_ID,
    type: 'browseros',
    name: 'BrowserOS',
    baseUrl: 'https://api.browseros.com/v1',
    modelId: 'browseros-auto',
    supportsImages: true,
    contextWindow: 200000,
    temperature: 0.2,
    createdAt: 111,
    updatedAt: 111,
  },
]

const state = {
  providers: null as LlmProviderConfig[] | null,
  defaultId: null as string | null,
  failProvidersLoad: false,
}

type Listener<T> = (value: T) => void

const watchers = {
  providers: new Set<Listener<LlmProviderConfig[]>>(),
  defaultId: new Set<Listener<string>>(),
}

const providersStorage = {
  async getValue() {
    return state.providers === null ? null : clone(state.providers)
  },
  async setValue(value: LlmProviderConfig[]) {
    state.providers = clone(value)
    for (const listener of [...watchers.providers]) listener(clone(value))
  },
  watch(listener: Listener<LlmProviderConfig[]>) {
    watchers.providers.add(listener)
    return () => watchers.providers.delete(listener)
  },
}

const defaultProviderIdStorage = {
  async getValue() {
    return state.defaultId
  },
  async setValue(value: string) {
    state.defaultId = value
    for (const listener of [...watchers.defaultId]) listener(value)
  },
  watch(listener: Listener<string>) {
    watchers.defaultId.add(listener)
    return () => watchers.defaultId.delete(listener)
  },
}

const loadProviders = async () => {
  if (state.failProvidersLoad) {
    throw new Error('providers storage read failed')
  }
  return state.providers === null ? [] : clone(state.providers)
}

mock.module('./storage', () => ({
  DEFAULT_PROVIDER_ID,
  createDefaultProvidersConfig: defaultProvidersConfig,
  loadProviders,
  providersStorage,
  defaultProviderIdStorage,
}))

const { useLlmProviders } = await import('./useLlmProviders')

// ---------------------------------------------------------------------------
// Fixtures and mounting harness
// ---------------------------------------------------------------------------

const provider = (
  id: string,
  overrides: Partial<LlmProviderConfig> = {},
): LlmProviderConfig => ({
  id,
  type: 'openai-compatible',
  name: `Provider ${id}`,
  baseUrl: `https://${id}.example.com/v1`,
  modelId: `${id}-model`,
  supportsImages: false,
  contextWindow: 8192,
  temperature: 0.1,
  createdAt: 111,
  updatedAt: 111,
  ...overrides,
})

let roots: Root[] = []
let history: ReturnType<typeof useLlmProviders>[] = []

function Probe() {
  history.push(useLlmProviders())
  return null
}

const mount = async (): Promise<Root> => {
  const root = createRoot(
    Object.assign(new FakeNode(1), {
      tagName: 'div',
      ownerDocument: fakeDocument,
    }),
  )
  roots.push(root)
  history = []
  await act(async () => {
    root.render(createElement(Probe))
  })
  return root
}

/** Lets the microtask continuations of the load effect settle. */
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })

const current = () => history[history.length - 1]

beforeEach(() => {
  state.providers = null
  state.defaultId = null
  state.failProvidersLoad = false
  watchers.providers.clear()
  watchers.defaultId.clear()
})

afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount()
  })
  roots = []
  setSystemTime()
})

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('useLlmProvidersContract', () => {
  it('useLlmProviders exposes a loading frame before storage resolves', async () => {
    state.providers = [provider('a')]
    state.defaultId = 'a'
    await mount()

    const first = history[0]
    expect(first.isLoading).toBe(true)
    expect(first.providers).toEqual([])
    expect(first.defaultProviderId).toBe(DEFAULT_PROVIDER_ID)
    expect(first.selectedProvider).toBe(null)
  })

  it('useLlmProviders loads providers and the default id from storage', async () => {
    const [a, b] = [provider('a'), provider('b')]
    state.providers = [a, b]
    state.defaultId = 'b'
    await mount()
    await settle()

    expect(current().isLoading).toBe(false)
    expect(current().providers).toEqual([a, b])
    expect(current().defaultProviderId).toBe('b')
    expect(current().selectedProvider).toEqual(b)
    // Nothing was rewritten back to storage.
    expect(await providersStorage.getValue()).toEqual([a, b])
    expect(await defaultProviderIdStorage.getValue()).toBe('b')
  })

  it('useLlmProviders seeds and persists the default configuration when storage is empty', async () => {
    await mount()
    await settle()

    const defaults = defaultProvidersConfig()
    expect(current().isLoading).toBe(false)
    expect(current().providers).toEqual(defaults)
    expect(current().defaultProviderId).toBe(DEFAULT_PROVIDER_ID)
    expect(current().selectedProvider).toEqual(defaults[0])
    // The seeded defaults and the default id were both written back.
    expect(await providersStorage.getValue()).toEqual(defaults)
    expect(await defaultProviderIdStorage.getValue()).toBe(DEFAULT_PROVIDER_ID)
  })

  it('useLlmProviders repairs a stale default id that matches no provider', async () => {
    const [a, b] = [provider('a'), provider('b')]
    state.providers = [a, b]
    state.defaultId = 'ghost'
    await mount()
    await settle()

    expect(current().defaultProviderId).toBe('a')
    expect(current().selectedProvider).toEqual(a)
    // The repair was persisted.
    expect(await defaultProviderIdStorage.getValue()).toBe('a')
  })

  it('useLlmProviders fails quietly to an empty, non-loading state when storage fails to load', async () => {
    state.failProvidersLoad = true
    await mount()
    await settle()

    expect(current().isLoading).toBe(false)
    expect(current().providers).toEqual([])
    expect(current().defaultProviderId).toBe(DEFAULT_PROVIDER_ID)
    expect(current().selectedProvider).toBe(null)
    // Nothing was seeded into storage by the failed load.
    expect(await providersStorage.getValue()).toBe(null)
    expect(await defaultProviderIdStorage.getValue()).toBe(null)
  })

  it('useLlmProviders reflects provider and default changes written by other writers', async () => {
    const [a, b, c] = [provider('a'), provider('b'), provider('c')]
    state.providers = [a, b]
    state.defaultId = 'a'
    await mount()
    await settle()

    await act(async () => {
      await providersStorage.setValue([a, b, c])
    })
    expect(current().providers).toEqual([a, b, c])
    // Selection is untouched until the default id itself changes.
    expect(current().selectedProvider).toEqual(a)

    await act(async () => {
      await defaultProviderIdStorage.setValue('c')
    })
    expect(current().defaultProviderId).toBe('c')
    expect(current().selectedProvider).toEqual(c)
  })

  it('useLlmProviders saveProvider appends a new provider with fresh timestamps', async () => {
    state.providers = defaultProvidersConfig()
    state.defaultId = DEFAULT_PROVIDER_ID
    await mount()
    await settle()

    const frozenAt = 1_700_000_000_000
    setSystemTime(frozenAt)
    const fresh = provider('openrouter-alt', { createdAt: 0, updatedAt: 0 })
    await act(async () => {
      await current().saveProvider(fresh)
    })

    const stored = await providersStorage.getValue()
    expect(stored).toHaveLength(2)
    const saved = stored?.find((p) => p.id === 'openrouter-alt')
    expect(saved?.createdAt).toBe(frozenAt)
    expect(saved?.updatedAt).toBe(frozenAt)
    // The hook's own state sees the saved provider.
    expect(current().providers).toHaveLength(2)
  })

  it('useLlmProviders saveProvider updates an existing provider and keeps its creation time', async () => {
    state.providers = defaultProvidersConfig()
    state.defaultId = DEFAULT_PROVIDER_ID
    await mount()
    await settle()

    const renamedAt = 1_700_000_500_000
    setSystemTime(renamedAt)
    await act(async () => {
      await current().saveProvider({
        ...defaultProvidersConfig()[0],
        name: 'BrowserOS (renamed)',
        updatedAt: 0,
      })
    })

    const stored = await providersStorage.getValue()
    expect(stored).toHaveLength(1)
    expect(stored?.[0].name).toBe('BrowserOS (renamed)')
    expect(stored?.[0].createdAt).toBe(111)
    expect(stored?.[0].updatedAt).toBe(renamedAt)
    expect(current().providers[0].name).toBe('BrowserOS (renamed)')
  })

  it('useLlmProviders setDefaultProvider persists and selects the new default', async () => {
    const [a, b] = [provider('a'), provider('b')]
    state.providers = [a, b]
    state.defaultId = 'a'
    await mount()
    await settle()

    await act(async () => {
      await current().setDefaultProvider('b')
    })

    expect(await defaultProviderIdStorage.getValue()).toBe('b')
    expect(current().defaultProviderId).toBe('b')
    expect(current().selectedProvider).toEqual(b)
  })

  it('useLlmProviders falls back to the first provider when the default id matches nothing', async () => {
    const [a, b] = [provider('a'), provider('b')]
    state.providers = [a, b]
    state.defaultId = 'a'
    await mount()
    await settle()

    await act(async () => {
      await current().setDefaultProvider('ghost')
    })

    expect(current().defaultProviderId).toBe('ghost')
    expect(current().selectedProvider).toEqual(a)
  })

  it('useLlmProviders deleteProvider removes a deleted default and reassigns it to the first survivor', async () => {
    const [a, b, c] = [provider('a'), provider('b'), provider('c')]
    state.providers = [a, b, c]
    state.defaultId = 'a'
    await mount()
    await settle()

    await act(async () => {
      await current().deleteProvider('a')
    })

    expect(await providersStorage.getValue()).toEqual([b, c])
    expect(await defaultProviderIdStorage.getValue()).toBe('b')
    expect(current().providers).toEqual([b, c])
    expect(current().defaultProviderId).toBe('b')
    expect(current().selectedProvider).toEqual(b)
  })

  it('useLlmProviders deleteProvider keeps the default when a non-default provider is removed', async () => {
    const [a, b] = [provider('a'), provider('b')]
    state.providers = [a, b]
    state.defaultId = 'a'
    await mount()
    await settle()

    await act(async () => {
      await current().deleteProvider('b')
    })

    expect(await providersStorage.getValue()).toEqual([a])
    expect(await defaultProviderIdStorage.getValue()).toBe('a')
    expect(current().defaultProviderId).toBe('a')
    expect(current().selectedProvider).toEqual(a)
  })

  it('useLlmProviders deleteProvider refuses to remove the built-in browseros provider', async () => {
    const [builtIn, custom] = [defaultProvidersConfig()[0], provider('custom')]
    state.providers = [builtIn, custom]
    state.defaultId = DEFAULT_PROVIDER_ID
    await mount()
    await settle()

    await act(async () => {
      await current().deleteProvider(DEFAULT_PROVIDER_ID)
    })

    expect(await providersStorage.getValue()).toEqual([builtIn, custom])
    expect(await defaultProviderIdStorage.getValue()).toBe(DEFAULT_PROVIDER_ID)
    expect(current().providers).toEqual([builtIn, custom])
    expect(current().selectedProvider).toEqual(builtIn)
  })

  it('useLlmProviders stops watching storage once the component unmounts', async () => {
    state.providers = [provider('a')]
    state.defaultId = 'a'
    const root = await mount()
    await settle()

    const activeWatchers = () =>
      watchers.providers.size + watchers.defaultId.size
    expect(activeWatchers()).toBeGreaterThan(0)

    await act(async () => {
      root.unmount()
    })
    expect(activeWatchers()).toBe(0)

    // Writes after unmount are not observed by the departed component.
    await act(async () => {
      await providersStorage.setValue([provider('late')])
    })
    expect(activeWatchers()).toBe(0)
  })
})
