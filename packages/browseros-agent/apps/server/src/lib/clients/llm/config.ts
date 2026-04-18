/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * LLM config resolution - handles trios provider lookup.
 */

import { LLM_PROVIDERS, type LLMConfig } from '@trios/shared/schemas/llm'
import { INLINED_ENV } from '../../../env'
import { logger } from '../../logger'
import { fetchTRIOSConfig, getLLMConfigFromProvider } from '../gateway'
import { getOAuthTokenManager } from '../oauth'
import type { ResolvedLLMConfig } from './types'

export async function resolveLLMConfig(
  config: LLMConfig,
  triosId?: string,
): Promise<ResolvedLLMConfig> {
  logger.debug('resolveLLMConfig input', {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
    hasApiKey: !!config.apiKey,
    triosId: triosId ?? undefined,
  })

  // OAuth providers: resolve token from server-side storage
  if (config.provider === LLM_PROVIDERS.CHATGPT_PRO) {
    return resolveOAuthConfig(config, triosId, {
      providerId: 'chatgpt-pro',
      displayName: 'ChatGPT Plus/Pro',
      defaultModel: 'gpt-5.3-codex',
      useRefresh: true,
      extraFields: (tokens) => ({
        upstreamProvider: 'openai',
        accountId: tokens.accountId,
      }),
    })
  }
  if (config.provider === LLM_PROVIDERS.GITHUB_COPILOT) {
    return resolveOAuthConfig(config, triosId, {
      providerId: 'github-copilot',
      displayName: 'GitHub Copilot',
      defaultModel: 'gpt-5-mini',
      useRefresh: false,
    })
  }
  if (config.provider === LLM_PROVIDERS.QWEN_CODE) {
    return resolveOAuthConfig(config, triosId, {
      providerId: 'qwen-code',
      displayName: 'Qwen Code',
      defaultModel: 'coder-model',
      useRefresh: true,
    })
  }

  // TRIOS gateway: fetch config from remote service
  if (config.provider === LLM_PROVIDERS.trios) {
    return resolveTRIOSConfig(config, triosId)
  }

  // All other providers: passthrough with model validation
  if (!config.model) {
    throw new Error(`model is required for ${config.provider} provider`)
  }

  if (config.provider === LLM_PROVIDERS.ZAI) {
    logger.info('resolveLLMConfig passthrough (zai)', {
      model: config.model,
      hasApiKey: !!config.apiKey,
      baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
    })
  }
  return config as ResolvedLLMConfig
}

interface OAuthResolveOptions {
  providerId: string
  displayName: string
  defaultModel: string
  useRefresh: boolean
  extraFields?: (tokens: { accountId?: string }) => Record<string, unknown>
}

async function resolveOAuthConfig(
  config: LLMConfig,
  triosId: string | undefined,
  opts: OAuthResolveOptions,
): Promise<ResolvedLLMConfig> {
  const tokenManager = getOAuthTokenManager()
  if (!tokenManager || !triosId) {
    throw new Error(
      `Not authenticated with ${opts.displayName}. Please login first.`,
    )
  }

  const tokens = opts.useRefresh
    ? await tokenManager.refreshIfExpired(opts.providerId)
    : tokenManager.getTokens(opts.providerId)

  if (!tokens) {
    throw new Error(
      `Not authenticated with ${opts.displayName}. Please login first.`,
    )
  }

  return {
    ...config,
    model: config.model || opts.defaultModel,
    apiKey: tokens.accessToken,
    ...opts.extraFields?.(tokens),
  }
}

async function resolveTRIOSConfig(
  config: LLMConfig,
  triosId?: string,
): Promise<ResolvedLLMConfig> {
  const configUrl = INLINED_ENV.trios_CONFIG_URL
  if (!configUrl) {
    throw new Error(
      'trios_CONFIG_URL environment variable is required for TRIOS provider',
    )
  }

  logger.debug('Resolving trios config', { configUrl, triosId })

  const browserosConfig = await fetchTRIOSConfig(configUrl, triosId)
  const llmConfig = getLLMConfigFromProvider(browserosConfig, 'default')

  return {
    ...config,
    model: llmConfig.modelName,
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    upstreamProvider: llmConfig.providerType,
    triosId,
  }
}
