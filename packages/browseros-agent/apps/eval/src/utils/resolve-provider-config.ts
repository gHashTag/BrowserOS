import {
  fetchTRIOSConfig,
  getLLMConfigFromProvider,
} from '@trios/server/lib/clients/gateway'
import { LLM_PROVIDERS, type LLMConfig } from '@trios/shared/schemas/llm'
import { resolveEnvValue } from './resolve-env'

export interface ResolvedProviderConfig extends LLMConfig {
  upstreamProvider?: string
}

export async function resolveProviderConfig(
  agent: LLMConfig,
): Promise<ResolvedProviderConfig> {
  if (agent.provider === LLM_PROVIDERS.trios) {
    const configUrl = process.env.trios_CONFIG_URL
    if (!configUrl) {
      throw new Error(
        'trios_CONFIG_URL environment variable is required for TRIOS provider',
      )
    }
    const browserosConfig = await fetchTRIOSConfig(configUrl)
    const llmConfig = getLLMConfigFromProvider(browserosConfig, 'default')
    return {
      provider: LLM_PROVIDERS.trios,
      model: llmConfig.modelName,
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      upstreamProvider: llmConfig.providerType,
    }
  }

  return {
    ...agent,
    apiKey: resolveEnvValue(agent.apiKey),
    accessKeyId: resolveEnvValue(agent.accessKeyId),
    secretAccessKey: resolveEnvValue(agent.secretAccessKey),
    sessionToken: resolveEnvValue(agent.sessionToken),
  }
}
