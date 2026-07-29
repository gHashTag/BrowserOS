import {
  HERMES_SUPPORTED_BROWSEROS_PROVIDER_TYPES,
  type HermesSupportedBrowserosProviderType,
} from '@browseros/shared/constants/hermes'
import type { LlmProviderConfig, ProviderType } from '@/lib/llm-providers/types'

export function isHermesSupportedProviderType(
  providerType: ProviderType,
): providerType is HermesSupportedBrowserosProviderType {
  return (
    HERMES_SUPPORTED_BROWSEROS_PROVIDER_TYPES as readonly ProviderType[]
  ).includes(providerType)
}

/**
 * Filters the user's global LLM providers down to ones Hermes can use.
 * A provider qualifies when its type is in the Hermes-supported set
 * AND it has an API key wired up. CLI-style providers (chatgpt-pro,
 * github-copilot, qwen-code) and other unsupported types (browseros,
 * ollama, lmstudio, bedrock, azure, google, moonshot) are filtered
 * out — Hermes can't drive them today.
 */
export function getHermesSupportedProviders(
  providers: LlmProviderConfig[],
): LlmProviderConfig[] {
  return providers.filter(
    (provider) =>
      !!provider.apiKey && isHermesSupportedProviderType(provider.type),
  )
}
