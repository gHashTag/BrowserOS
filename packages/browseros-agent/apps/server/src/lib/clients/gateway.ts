/**
 * @license
 * Copyright 2025 TRIOS
 */

import { logger } from '../logger'

export interface Provider {
  name: string
  model: string
  apiKey: string
  baseUrl?: string
  dailyRateLimit?: number
  dailyCredits?: number
  creditCostPerRequest?: number
  resetInterval?: string
  providerType?: string // LLMProvider value from ai-gateway: "openrouter" | "azure" | "anthropic"
}

export interface CreditsInfo {
  credits: number
  dailyLimit: number
  lastResetAt?: string
}

export interface TRIOSConfig {
  providers: Provider[]
}

export interface LLMConfig {
  modelName: string
  baseUrl?: string
  apiKey: string
  provider: Provider
  providerType?: string
}

export async function fetchTRIOSConfig(
  configUrl: string,
  triosId?: string,
): Promise<TRIOSConfig> {
  logger.debug('Fetching TRIOS config', { configUrl, triosId })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (triosId) {
    headers['X-TRIOS-ID'] = triosId
  }

  try {
    const response = await fetch(configUrl, {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(
        `Failed to fetch config: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const config = (await response.json()) as TRIOSConfig

    if (!Array.isArray(config.providers) || config.providers.length === 0) {
      throw new Error(
        'Invalid config response: providers array is empty or missing',
      )
    }

    for (const provider of config.providers) {
      if (!provider.name || !provider.model || !provider.apiKey) {
        throw new Error('Invalid provider: missing name, model, or apiKey')
      }
    }

    const defaultProvider = config.providers.find((p) => p.name === 'default')
    logger.info('✅ TRIOS config fetched', {
      providerCount: config.providers.length,
      dailyRateLimit: defaultProvider?.dailyRateLimit,
    })

    return config
  } catch (error) {
    logger.error('❌ Failed to fetch TRIOS config', {
      configUrl,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Get LLM config from a provider in the TRIOS config
 * @param config - TRIOS config containing providers
 * @param providerName - Name of the provider to use (defaults to 'default')
 * @returns LLM config with modelName, baseUrl, apiKey, and provider
 */
export function getLLMConfigFromProvider(
  config: TRIOSConfig,
  providerName = 'default',
): LLMConfig {
  const provider = config.providers.find((p) => p.name === providerName)

  if (!provider) {
    throw new Error(
      `Provider '${providerName}' not found in config. Available providers: ${config.providers.map((p) => p.name).join(', ')}`,
    )
  }

  return {
    modelName: provider.model,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    provider,
    providerType: provider.providerType,
  }
}

export async function fetchCredits(
  gatewayBaseUrl: string,
  triosId: string,
): Promise<CreditsInfo> {
  const url = new URL(`/credits/${triosId}`, gatewayBaseUrl).href
  const response = await fetch(url)
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Failed to fetch credits: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }
  const result = (await response.json()) as CreditsInfo
  logger.debug('Credits fetched', { credits: result.credits })
  return result
}
