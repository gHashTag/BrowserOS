/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Contract suite for lib/llm-providers/storage.ts
 *
 * The subject owns where the agent's LLM provider list lives, what the
 * built-in provider looks like, how a profile written by an older schema is
 * upgraded, and which copies follow when the list changes (the BrowserOS
 * providers pref, the GraphQL backend). This suite pins that behaviour as it
 * stands today: no socket is opened, no database is reached, no container is
 * started.
 *
 * The doubles sit at the browser boundary, never inside the subject:
 * - @wxt-dev/storage resolves its `browser` object from globalThis.chrome at
 *   import time, so a fake chrome (in-memory storage area, in-memory
 *   BrowserOS prefs) is installed before the subject loads. The real storage
 *   library, the real BrowserOSAdapter and the real session storage item all
 *   run unmodified, and their real semantics - fallbacks, version
 *   migrations, change listeners - are what the assertions observe.
 * - uploadLlmProvidersToGraphql is the one collaborator that cannot load
 *   outside a build (its documents are generated into generated/graphql) and
 *   whose real target is the live backend. mock.module swaps it, before the
 *   subject is imported, for a recording stand-in. Assertions read only the
 *   payloads the recording captured - what shipped, for which user - and the
 *   values the fake browser ended up holding; none of them inspect how the
 *   subject called anything.
 *
 * Exports of the subject not exercised by an assertion: none. All nine
 * exports are covered below, one `it` block per export and named for the
 * export it pins, so a reader can map assertions to exports one to one. No
 * export was left out for want of a live dependency, so the issue's
 * blocked-export list is empty.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { LlmProviderConfig } from './types'

// ---------------------------------------------------------------------------
// In-memory web-extension environment
// ---------------------------------------------------------------------------

type StorageChanges = Record<string, { newValue: unknown; oldValue: unknown }>

const localAreaBacking = new Map<string, unknown>()
const storageChangeListeners = new Set<(changes: StorageChanges) => void>()

function deliverStorageChanges(changes: StorageChanges) {
  for (const listener of storageChangeListeners) listener(changes)
}

/** chrome.storage.local, apart from the parts nothing here exercises. */
const fakeLocalStorageArea = {
  async get(keys?: string | string[] | null) {
    if (keys == null) return Object.fromEntries(localAreaBacking)
    const wanted = typeof keys === 'string' ? [keys] : keys
    const found: Record<string, unknown> = {}
    for (const key of wanted) {
      if (localAreaBacking.has(key)) found[key] = localAreaBacking.get(key)
    }
    return found
  },
  async set(entries: Record<string, unknown>) {
    const changes: StorageChanges = {}
    for (const [key, value] of Object.entries(entries)) {
      const had = localAreaBacking.has(key)
      const oldValue = had ? localAreaBacking.get(key) : undefined
      localAreaBacking.set(key, value)
      changes[key] = { newValue: value, oldValue }
    }
    deliverStorageChanges(changes)
  },
  async remove(keys: string | string[]) {
    const changes: StorageChanges = {}
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      if (!localAreaBacking.has(key)) continue
      changes[key] = {
        newValue: undefined,
        oldValue: localAreaBacking.get(key),
      }
      localAreaBacking.delete(key)
    }
    deliverStorageChanges(changes)
  },
  async clear() {
    localAreaBacking.clear()
  },
  onChanged: {
    addListener(listener: (changes: StorageChanges) => void) {
      storageChangeListeners.add(listener)
    },
    removeListener(listener: (changes: StorageChanges) => void) {
      storageChangeListeners.delete(listener)
    },
  },
}

/** chrome.browserOS prefs, as the real BrowserOSAdapter reaches them. */
const prefBacking = new Map<string, unknown>()

const fakeBrowserOS = {
  setPref(name: string, value: unknown, callback: (success: boolean) => void) {
    prefBacking.set(name, value)
    callback(true)
  },
  getPref(name: string, callback: (pref: unknown) => void) {
    callback(prefBacking.has(name) ? prefBacking.get(name) : null)
  },
}

// Installed before the subject is imported: @wxt-dev/browser captures
// globalThis.chrome while it loads, so the fake must already be in place.
globalThis.chrome = {
  runtime: { id: 'storage-contract-suite' },
  storage: { local: fakeLocalStorageArea },
  browserOS: fakeBrowserOS,
} as unknown as typeof chrome

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function providerFixture(
  overrides: Partial<LlmProviderConfig> = {},
): LlmProviderConfig {
  return {
    id: 'openrouter-main',
    type: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    supportsImages: false,
    contextWindow: 131072,
    temperature: 0.4,
    createdAt: 1_730_000_000_000,
    updatedAt: 1_730_000_000_000,
    ...overrides,
  }
}

// A profile last written by schema v1: the built-in provider carries a stale
// context window under its historical name, a third-party entry sits next to
// it. Seeded before the subject loads so its module-load migration runs
// against real history; the trailing-$ key is where @wxt-dev/storage keeps
// per-item version metadata.
const legacyBuiltIn = providerFixture({
  id: 'browseros',
  type: 'browseros',
  name: 'Kimi K2.5',
  contextWindow: 128000,
})
const legacyThirdParty = providerFixture({
  id: 'bedrock-old',
  type: 'bedrock',
  name: 'Old Bedrock',
  contextWindow: 8192,
})

localAreaBacking.set('llm-providers', [legacyBuiltIn, legacyThirdParty])
localAreaBacking.set('llm-providers$', { v: 1 })

// ---------------------------------------------------------------------------
// Recording stand-in for the GraphQL upload
// ---------------------------------------------------------------------------

interface RecordedUpload {
  providers: LlmProviderConfig[]
  userId: string
}

const recordedUploads: RecordedUpload[] = []
let uploadsToReject = 0

// Registered before the subject is imported, so the subject's static import
// of this module resolves to the recording rather than the generated GraphQL
// client. The recording is wanted for the lifetime of this file, and
// mock.restore() does not undo mock.module in bun 1.3 anyway.
mock.module('./uploadLlmProvidersToGraphql', () => ({
  uploadLlmProvidersToGraphql: async (
    providers: LlmProviderConfig[],
    userId: string,
  ) => {
    if (uploadsToReject > 0) {
      uploadsToReject -= 1
      throw new Error('recording backend rejected the upload')
    }
    recordedUploads.push({ providers, userId })
  },
}))

// ---------------------------------------------------------------------------
// Subject and collaborators
// ---------------------------------------------------------------------------

const {
  DEFAULT_PROVIDER_ID,
  providersStorage,
  defaultProviderIdStorage,
  setupLlmProvidersBackupToBrowserOS,
  setupLlmProvidersSyncToBackend,
  syncLlmProviders,
  loadProviders,
  createDefaultBrowserOSProvider,
  createDefaultProvidersConfig,
} = await import('./storage')

const { sessionStorage } = await import('@/lib/auth/sessionStorage')

// The v1 profile seeded above is upgraded while the module loads; capture
// the outcome before any test wipes the area.
const loadTimeMigratedProviders = await providersStorage.getValue()

// The session item's full better-auth shape does not matter here; only
// `user.id` decides whether a sync may ship.
type SessionWithUserId = { user?: { id?: string } }
const sessionItem = sessionStorage as unknown as {
  getValue: () => Promise<SessionWithUserId | null>
  setValue: (value: SessionWithUserId | null) => Promise<void>
}

/** Lets fire-and-forget watchers and their promise chains run to the end. */
async function settle() {
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('storageContract', () => {
  beforeEach(() => {
    localAreaBacking.clear()
    prefBacking.clear()
    recordedUploads.length = 0
    uploadsToReject = 0
    storageChangeListeners.clear()
  })

  it('DEFAULT_PROVIDER_ID is "browseros", the id the defaults are built from', () => {
    expect(DEFAULT_PROVIDER_ID).toBe('browseros')
    expect(createDefaultBrowserOSProvider().id).toBe(DEFAULT_PROVIDER_ID)
    expect(createDefaultProvidersConfig().map((p) => p.id)).toEqual([
      DEFAULT_PROVIDER_ID,
    ])
  })

  it('providersStorage round-trips at local:llm-providers and upgrades a seeded v1 profile on load', async () => {
    // The seeded v1 profile was migrated while the module loaded: the
    // built-in entry got the current context window and kept everything
    // else; the third-party entry was left alone.
    expect(loadTimeMigratedProviders).toEqual([
      { ...legacyBuiltIn, contextWindow: 200000 },
      legacyThirdParty,
    ])

    // Empty item: no fallback is declared, so a fresh profile reads as null.
    expect(await providersStorage.getValue()).toBe(null)

    // A stored list comes back unchanged, persisted under the historical
    // key where every other reader of the profile finds it.
    const stored = [providerFixture()]
    await providersStorage.setValue(stored)
    expect(await providersStorage.getValue()).toEqual(stored)
    expect(localAreaBacking.get('llm-providers')).toEqual(stored)
  })

  it('defaultProviderIdStorage falls back to the built-in id until a default is chosen', async () => {
    expect(await defaultProviderIdStorage.getValue()).toBe(DEFAULT_PROVIDER_ID)

    await defaultProviderIdStorage.setValue('chosen-one')
    expect(await defaultProviderIdStorage.getValue()).toBe('chosen-one')
    expect(localAreaBacking.get('default-provider-id')).toBe('chosen-one')
  })

  it('loadProviders returns [] for an empty profile and repairs a mistitled built-in provider in storage', async () => {
    expect(await loadProviders()).toEqual([])

    const mistitled = providerFixture({
      id: 'browseros',
      type: 'browseros',
      name: 'Kimi K2.5',
    })
    const foreign = providerFixture({ name: 'Kept As Written' })
    await providersStorage.setValue([mistitled, foreign])

    const loaded = await loadProviders()
    expect(loaded).toEqual([{ ...mistitled, name: 'BrowserOS' }, foreign])

    // The repaired name is persisted, so every other consumer of the item
    // sees the same provider name.
    expect(localAreaBacking.get('llm-providers')).toEqual(loaded)
  })

  it("createDefaultBrowserOSProvider returns the built-in provider with today's pinned fields", () => {
    const provider = createDefaultBrowserOSProvider()
    const { createdAt, updatedAt, ...fields } = provider
    expect(fields).toEqual({
      id: 'browseros',
      type: 'browseros',
      name: 'BrowserOS',
      baseUrl: 'https://api.browseros.com/v1',
      modelId: 'browseros-auto',
      supportsImages: true,
      contextWindow: 200000,
      temperature: 0.2,
    })
    expect(Number.isFinite(createdAt)).toBe(true)
    expect(updatedAt).toBe(createdAt)
  })

  it('createDefaultProvidersConfig seeds exactly the built-in provider', () => {
    const config = createDefaultProvidersConfig()
    expect(config).toHaveLength(1)
    const [seeded] = config
    const reference = createDefaultBrowserOSProvider()
    expect(seeded.id).toBe(reference.id)
    expect(seeded.type).toBe(reference.type)
    expect(seeded.name).toBe(reference.name)
    expect(seeded.baseUrl).toBe(reference.baseUrl)
    expect(seeded.modelId).toBe(reference.modelId)
    expect(seeded.supportsImages).toBe(reference.supportsImages)
    expect(seeded.contextWindow).toBe(reference.contextWindow)
    expect(seeded.temperature).toBe(reference.temperature)
  })

  it('syncLlmProviders ships the stored list under the signed-in user, and nothing otherwise', async () => {
    await sessionItem.setValue({ user: { id: 'user-1' } })
    // Nothing stored: nothing ships.
    await syncLlmProviders()
    expect(recordedUploads).toEqual([])

    const providers = [providerFixture(), providerFixture({ id: 'second' })]
    await providersStorage.setValue(providers)

    // Signed out: the list stays local.
    await sessionItem.setValue(null)
    await syncLlmProviders()
    expect(recordedUploads).toEqual([])

    // Signed in: exactly the stored list ships, under the session's user.
    await sessionItem.setValue({ user: { id: 'user-42' } })
    await syncLlmProviders()
    expect(recordedUploads).toEqual([{ providers, userId: 'user-42' }])
  })

  it('setupLlmProvidersBackupToBrowserOS mirrors the list into the BrowserOS providers pref until unsubscribed', async () => {
    const stop = setupLlmProvidersBackupToBrowserOS()

    await defaultProviderIdStorage.setValue('chosen-one')
    const providers = [providerFixture()]
    await providersStorage.setValue(providers)
    await settle()

    const backedUp = prefBacking.get('browseros.providers')
    expect(typeof backedUp).toBe('string')
    expect(JSON.parse(backedUp as string)).toEqual({
      defaultProviderId: 'chosen-one',
      providers,
    })

    // After unsubscribe the mirror is gone: later changes never reach prefs.
    stop()
    prefBacking.delete('browseros.providers')
    await providersStorage.setValue([providerFixture({ id: 'next' })])
    await settle()
    expect(prefBacking.has('browseros.providers')).toBe(false)
  })

  it('setupLlmProvidersSyncToBackend uploads once up front, follows changes, swallows a rejected upload, and stops when unsubscribed', async () => {
    const initial = providerFixture()
    await providersStorage.setValue([initial])
    await sessionItem.setValue({ user: { id: 'user-7' } })

    // The setup call ships the current list without waiting for a change.
    const stop = setupLlmProvidersSyncToBackend()
    await settle()
    expect(recordedUploads).toEqual([
      { providers: [initial], userId: 'user-7' },
    ])

    // A later change ships the new list.
    const changed = providerFixture({ modelId: 'new-model' })
    await providersStorage.setValue([changed])
    await settle()
    expect(recordedUploads).toHaveLength(2)
    expect(recordedUploads[1]).toEqual({
      providers: [changed],
      userId: 'user-7',
    })

    // A rejected upload is swallowed; the next change still ships.
    uploadsToReject = 1
    await providersStorage.setValue([providerFixture({ modelId: 'rejected' })])
    await settle()
    expect(recordedUploads).toHaveLength(2)
    const recovered = providerFixture({ modelId: 'recovered' })
    await providersStorage.setValue([recovered])
    await settle()
    expect(recordedUploads).toHaveLength(3)
    expect(recordedUploads[2]).toEqual({
      providers: [recovered],
      userId: 'user-7',
    })

    // After unsubscribe, changes no longer ship.
    stop()
    await providersStorage.setValue([providerFixture({ modelId: 'stopped' })])
    await settle()
    expect(recordedUploads).toHaveLength(3)
  })
})
