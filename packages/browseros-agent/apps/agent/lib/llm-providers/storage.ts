import { storage } from '@wxt-dev/storage'
import { sessionStorage } from '@/lib/auth/sessionStorage'
import { getTRIOSAdapter } from '@/lib/trios/adapter'
import { trios_PREFS } from '@/lib/trios/prefs'
import type { LlmProviderConfig, LlmProvidersBackup } from './types'
import { uploadLlmProvidersToGraphql } from './uploadLlmProvidersToGraphql'

/** Default provider ID constant */
export const DEFAULT_PROVIDER_ID = 'trios'
const DEFAULT_PROVIDER_NAME = 'TRIOS'

/** Storage key for LLM providers array */
export const providersStorage = storage.defineItem<LlmProviderConfig[]>(
  'local:llm-providers',
  {
    version: 2,
    migrations: {
      2: (
        providers: LlmProviderConfig[] | null,
      ): LlmProviderConfig[] | null => {
        if (!providers) return providers
        return providers.map((provider) => {
          if (
            provider.id === DEFAULT_PROVIDER_ID &&
            provider: trios'
          ) {
            return { ...provider, contextWindow: 200000 }
          }
          return provider
        })
      },
    },
  },
)

/** Backup providers to TRIOS prefs (write-only, best-effort) */
async function backupToTRIOS(backup: LlmProvidersBackup): Promise<void> {
  try {
    const adapter = getTRIOSAdapter()
    await adapter.setPref(trios_PREFS.PROVIDERS, JSON.stringify(backup))
  } catch {
    // TRIOS API not available - ignore
  }
}

/**
 * Setup one-way sync of LLM providers to TRIOS prefs
 * @public
 */
export function setupLlmProvidersBackupToTRIOS(): () => void {
  const unsubscribe = providersStorage.watch(async (providers) => {
    if (providers) {
      const defaultProviderId = await defaultProviderIdStorage.getValue()
      await backupToTRIOS({ defaultProviderId, providers })
    }
  })
  return unsubscribe
}

export async function syncLlmProviders(): Promise<void> {
  const providers = await providersStorage.getValue()
  if (!providers || providers.length === 0) return

  const session = await sessionStorage.getValue()
  const userId = session?.user?.id
  if (!userId) return

  await uploadLlmProvidersToGraphql(providers, userId)
}

/**
 * Setup one-way sync of LLM providers to GraphQL backend
 * Watches for storage changes and uploads non-sensitive provider data
 * @public
 */
export function setupLlmProvidersSyncToBackend(): () => void {
  syncLlmProviders().catch(() => {})

  const unsubscribe = providersStorage.watch(async () => {
    try {
      await syncLlmProviders()
    } catch {
      // Sync failed silently - will retry on next storage change
    }
  })
  return unsubscribe
}

/** Load providers from storage */
export async function loadProviders(): Promise<LlmProviderConfig[]> {
  const providers = (await providersStorage.getValue()) || []
  const normalizedProviders = normalizeProviderNames(providers)

  // Keep storage consistent so every consumer sees the same provider name.
  if (
    normalizedProviders.some((provider, index) => provider !== providers[index])
  ) {
    await providersStorage.setValue(normalizedProviders)
  }

  return normalizedProviders
}

/** Creates the default TRIOS provider configuration */
export function createDefaultTRIOSProvider(): LlmProviderConfig {
  const timestamp = Date.now()
  return {
    id: DEFAULT_PROVIDER_ID,
    type: 'trios',
    name: DEFAULT_PROVIDER_NAME,
    baseUrl: 'https://api.trios.com/v1',
    modelId: 'trios-auto',
    supportsImages: true,
    contextWindow: 200000,
    temperature: 0.2,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

/** Creates the default providers configuration. Only call when storage is empty. */
export function createDefaultProvidersConfig(): LlmProviderConfig[] {
  return [createDefaultTRIOSProvider()]
}

/**
 * Normalize built-in provider names back to "TRIOS" (e.g. from "Kimi K2.5"
 * which was set during a previous partnership launch).
 */
function normalizeProviderNames(
  providers: LlmProviderConfig[],
): LlmProviderConfig[] {
  return providers.map((provider) => {
    if (
      provider.id === DEFAULT_PROVIDER_ID &&
      provider: trios' &&
      provider.name !== DEFAULT_PROVIDER_NAME
    ) {
      return {
        ...provider,
        name: DEFAULT_PROVIDER_NAME,
      }
    }
    return provider
  })
}

/** Storage key for the default provider ID */
export const defaultProviderIdStorage = storage.defineItem<string>(
  'local:default-provider-id',
  {
    fallback: DEFAULT_PROVIDER_ID,
  },
)
