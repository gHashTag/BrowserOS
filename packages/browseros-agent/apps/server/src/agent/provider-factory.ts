import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createAzure } from '@ai-sdk/azure'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { EXTERNAL_URLS } from '@browseros/shared/constants/urls'
import { LLM_PROVIDERS } from '@browseros/shared/schemas/llm'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import { createBrowserOSFetch } from '../lib/browseros-fetch'
import { createCodexFetch } from '../lib/clients/oauth/codex-fetch'
import { createCopilotFetch } from '../lib/clients/oauth/copilot-fetch'
import { logger } from '../lib/logger'
import { createOpenRouterCompatibleFetch } from '../lib/openrouter-fetch'
import type { ResolvedAgentConfig } from './types'

type ProviderFactory = (
  config: ResolvedAgentConfig,
) => (modelId: string) => unknown

function createAnthropicFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.apiKey) throw new Error('Anthropic provider requires apiKey')
  return createAnthropic({ apiKey: config.apiKey })
}

function createOpenAIFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.apiKey) throw new Error('OpenAI provider requires apiKey')
  return createOpenAI({ apiKey: config.apiKey })
}

function createGoogleFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.apiKey) throw new Error('Google provider requires apiKey')
  return createGoogleGenerativeAI({ apiKey: config.apiKey })
}

function createOpenRouterFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.apiKey) throw new Error('OpenRouter provider requires apiKey')
  return createOpenRouter({
    apiKey: config.apiKey,
    extraBody: { reasoning: {} },
    fetch: createOpenRouterCompatibleFetch(),
  })
}

function createAzureFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.apiKey || !config.resourceName) {
    throw new Error('Azure provider requires apiKey and resourceName')
  }
  return createAzure({
    resourceName: config.resourceName,
    apiKey: config.apiKey,
  })
}

function createLMStudioFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.baseUrl) throw new Error('LMStudio provider requires baseUrl')
  return createOpenAICompatible({
    name: 'lmstudio',
    baseURL: config.baseUrl,
    ...(config.apiKey && { apiKey: config.apiKey }),
  })
}

function createOllamaFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.baseUrl) throw new Error('Ollama provider requires baseUrl')
  return createOpenAICompatible({
    name: 'ollama',
    baseURL: config.baseUrl,
    ...(config.apiKey && { apiKey: config.apiKey }),
  })
}

function createBedrockFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.accessKeyId || !config.secretAccessKey || !config.region) {
    throw new Error(
      'Bedrock provider requires accessKeyId, secretAccessKey, and region',
    )
  }
  return createAmazonBedrock({
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
  })
}

function createBrowserOSFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.baseUrl) throw new Error('BrowserOS provider requires baseUrl')
  const { baseUrl, apiKey, upstreamProvider, browserosId } = config
  const browserosFetch = browserosId
    ? createBrowserOSFetch(browserosId)
    : createOpenRouterCompatibleFetch()

  if (upstreamProvider === LLM_PROVIDERS.OPENROUTER) {
    return createOpenRouter({
      baseURL: baseUrl,
      ...(apiKey && { apiKey }),
      fetch: browserosFetch,
    })
  }
  if (upstreamProvider === LLM_PROVIDERS.ANTHROPIC) {
    return createAnthropic({
      baseURL: baseUrl,
      ...(apiKey && { apiKey }),
      fetch: browserosFetch,
    })
  }
  if (upstreamProvider === LLM_PROVIDERS.AZURE) {
    return createAzure({
      baseURL: baseUrl,
      ...(apiKey && { apiKey }),
      fetch: browserosFetch,
    })
  }
  logger.debug('Creating OpenAI-compatible provider for BrowserOS')
  return createOpenAICompatible({
    name: 'browseros',
    baseURL: baseUrl,
    ...(apiKey && { apiKey }),
    fetch: browserosFetch,
  })
}

function createOpenAICompatibleFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.baseUrl)
    throw new Error('OpenAI-compatible provider requires baseUrl')
  return createOpenAICompatible({
    name: 'openai-compatible',
    baseURL: config.baseUrl,
    ...(config.apiKey && { apiKey: config.apiKey }),
  })
}

function createMoonshotFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.baseUrl) throw new Error('Moonshot provider requires baseUrl')
  if (!config.apiKey) throw new Error('Moonshot provider requires apiKey')
  return createOpenAICompatible({
    name: 'moonshot',
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  })
}

function createQwenCodeFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.apiKey) throw new Error('Qwen Code requires OAuth authentication')
  return createOpenAICompatible({
    name: 'qwen-code',
    baseURL: EXTERNAL_URLS.QWEN_CODE_API,
    apiKey: config.apiKey,
  })
}

function createGitHubCopilotFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.apiKey)
    throw new Error('GitHub Copilot requires OAuth authentication')
  return createOpenAICompatible({
    name: 'github-copilot',
    baseURL: EXTERNAL_URLS.GITHUB_COPILOT_API,
    apiKey: config.apiKey,
    fetch: createCopilotFetch() as typeof globalThis.fetch,
  })
}

function createChatGPTProFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.apiKey)
    throw new Error('ChatGPT Plus/Pro requires OAuth authentication')
  return createOpenAI({
    apiKey: config.apiKey,
    fetch: createCodexFetch(config.accountId) as typeof globalThis.fetch,
  }).responses
}

function createZaiFactory(
  config: ResolvedAgentConfig,
): (modelId: string) => unknown {
  if (!config.apiKey) throw new Error('z.ai provider requires apiKey')
  logger.info('[Step 9] Creating z.ai factory (Anthropic-compatible)', {
    baseURL: EXTERNAL_URLS.ZAI_API,
    hasApiKey: true,
  })

  // Logging fetch wrapper to debug z.ai API calls
  const loggingFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    logger.info('[Step 10] z.ai API request', {
      url: urlStr,
      method: init?.method ?? 'GET',
      bodyPreview: typeof init?.body === 'string' ? init.body.substring(0, 500) : '(non-string body)',
    })
    try {
      const response = await globalThis.fetch(url, init)
      const cloned = response.clone()
      const responseBody = await cloned.text()
      logger.info('[Step 11] z.ai API response', {
        url: urlStr,
        status: response.status,
        statusText: response.statusText,
        bodyPreview: responseBody.substring(0, 1000),
      })
      return response
    } catch (error) {
      logger.error('[Step 11] z.ai API request failed', {
        url: urlStr,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  // ZAI uses Anthropic-compatible API at api.z.ai/api/anthropic
  const anthropicFactory = createAnthropic({
    baseURL: EXTERNAL_URLS.ZAI_API,
    apiKey: config.apiKey,
    fetch: loggingFetch as typeof globalThis.fetch,
  })
  // Strip the "z-ai/" provider prefix — Anthropic API expects bare model names.
  return (modelId: string) => {
    const strippedId = modelId.replace(/^z-ai\//, '')
    logger.info('[Step 9b] z.ai factory: creating model instance', {
      originalModelId: modelId,
      strippedModelId: strippedId,
    })
    return anthropicFactory(strippedId)
  }
}

const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  [LLM_PROVIDERS.ANTHROPIC]: createAnthropicFactory,
  [LLM_PROVIDERS.OPENAI]: createOpenAIFactory,
  [LLM_PROVIDERS.GOOGLE]: createGoogleFactory,
  [LLM_PROVIDERS.OPENROUTER]: createOpenRouterFactory,
  [LLM_PROVIDERS.AZURE]: createAzureFactory,
  [LLM_PROVIDERS.LMSTUDIO]: createLMStudioFactory,
  [LLM_PROVIDERS.OLLAMA]: createOllamaFactory,
  [LLM_PROVIDERS.BEDROCK]: createBedrockFactory,
  [LLM_PROVIDERS.BROWSEROS]: createBrowserOSFactory,
  [LLM_PROVIDERS.OPENAI_COMPATIBLE]: createOpenAICompatibleFactory,
  [LLM_PROVIDERS.MOONSHOT]: createMoonshotFactory,
  [LLM_PROVIDERS.CHATGPT_PRO]: createChatGPTProFactory,
  [LLM_PROVIDERS.GITHUB_COPILOT]: createGitHubCopilotFactory,
  [LLM_PROVIDERS.QWEN_CODE]: createQwenCodeFactory,
  [LLM_PROVIDERS.ZAI]: createZaiFactory,
}

export function createLanguageModel(
  config: ResolvedAgentConfig,
): LanguageModel {
  const provider = config.provider as string
  const factory = PROVIDER_FACTORIES[provider]
  if (!factory) throw new Error(`Unknown provider: ${provider}`)

  logger.info('[Step 9] Creating language model (agent)', {
    provider: config.provider,
    model: config.model,
    hasApiKey: !!config.apiKey,
    baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
  })

  try {
    const model = factory(config)(config.model) as LanguageModel
    logger.info('[Step 9c] Language model created successfully', {
      provider: config.provider,
      model: config.model,
      modelType: typeof model,
    })
    return model
  } catch (error) {
    logger.error('[Step 9] Failed to create language model', {
      provider: config.provider,
      model: config.model,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    throw error
  }
}
