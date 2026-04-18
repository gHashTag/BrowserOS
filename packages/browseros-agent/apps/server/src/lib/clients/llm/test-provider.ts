/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TIMEOUTS } from '@trios/shared/constants/timeouts'
import type { LLMConfig } from '@trios/shared/schemas/llm'
import { streamText } from 'ai'
import { logger } from '../../logger'
import { resolveLLMConfig } from './config'
import { createLLMProvider } from './provider'

export interface ProviderTestConfig extends LLMConfig {
  model: string
  upstreamProvider?: string
}

export interface ProviderTestResult {
  success: boolean
  message: string
  responseTime?: number
}

const TEST_PROMPT = "Respond with exactly: 'ok'"

export async function testProviderConnection(
  config: ProviderTestConfig,
  triosId?: string,
): Promise<ProviderTestResult> {
  const startTime = performance.now()

  try {
    logger.debug('testProviderConnection start', {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
      hasApiKey: !!config.apiKey,
      triosId: triosId ?? undefined,
    })
    const resolvedConfig = await resolveLLMConfig(config, triosId)
    const model = createLLMProvider(resolvedConfig)

    // streamText works for all providers including Codex (which requires streaming)
    const stream = streamText({
      model,
      messages: [{ role: 'user', content: TEST_PROMPT }],
      abortSignal: AbortSignal.timeout(TIMEOUTS.TEST_PROVIDER),
    })
    const text = await stream.text
    const responseTime = Math.round(performance.now() - startTime)

    if (text) {
      const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text
      return {
        success: true,
        message: `Connection successful. Response: "${preview}"`,
        responseTime,
      }
    }

    return {
      success: true,
      message: 'Connection successful. Provider responded.',
      responseTime,
    }
  } catch (error) {
    const responseTime = Math.round(performance.now() - startTime)
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('testProviderConnection failed', {
      provider: config.provider,
      model: config.model,
      errorMessage,
      errorStack: error instanceof Error ? error.stack : undefined,
      responseTimeMs: responseTime,
    })

    return {
      success: false,
      message: `[${config.provider}] ${errorMessage}`,
      responseTime,
    }
  }
}
