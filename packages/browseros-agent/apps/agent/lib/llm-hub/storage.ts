import { getTRIOSAdapter } from '@/lib/trios/adapter'
import { trios_PREFS } from '@/lib/trios/prefs'

/** @public */
export interface LlmHubProvider {
  name: string
  url: string
}

export async function loadProviders(): Promise<LlmHubProvider[]> {
  try {
    const adapter = getTRIOSAdapter()
    const providersPref = await adapter.getPref(
      trios_PREFS.THIRD_PARTY_LLM_PROVIDERS,
    )
    return (providersPref?.value as LlmHubProvider[]) || []
  } catch {
    return []
  }
}

export async function saveProviders(
  providers: LlmHubProvider[],
): Promise<boolean> {
  try {
    const adapter = getTRIOSAdapter()
    return await adapter.setPref(
      trios_PREFS.THIRD_PARTY_LLM_PROVIDERS,
      providers,
    )
  } catch {
    return false
  }
}

export function getFaviconUrl(url: string, size = 128): string | undefined {
  try {
    const normalized = url.trim()
    if (!normalized) return undefined
    const parsed = new URL(
      normalized.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/)
        ? normalized
        : `https://${normalized}`,
    )
    return `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=${size}`
  } catch {
    return undefined
  }
}
