/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Custom fetch for BrowserOS gateway requests. Adds X-BrowserOS-ID header for
 * credit tracking, routes terminal-error classification (e.g. CREDITS_EXHAUSTED
 * 429s) through the shared provider-error classifier, and extracts
 * OpenRouter-style error details.
 */

import { APICallError } from '@ai-sdk/provider'
import { logger } from './logger'
import { isTerminalProviderError } from './provider-error-classifier'

function resolveUrl(url: RequestInfo | URL): string {
  return typeof url === 'string' ? url : url.toString()
}

function parseErrorBody(
  body: string,
): { message?: string; code?: string; metadata?: { raw?: unknown } } | null {
  try {
    const parsed = JSON.parse(body)
    return parsed.error ?? null
  } catch {
    return null
  }
}

function buildErrorMessage(
  statusCode: number,
  statusText: string,
  error: NonNullable<ReturnType<typeof parseErrorBody>>,
): string {
  if (!error.message) return `HTTP ${statusCode}: ${statusText}`
  let msg = error.message
  if (error.code) msg = `[${error.code}] ${msg}`
  if (error.metadata?.raw) msg += ` (${JSON.stringify(error.metadata.raw)})`
  return msg
}

export function createBrowserOSFetch(browserosId: string): typeof fetch {
  return (async (url: RequestInfo | URL, options?: RequestInit) => {
    const headers = new Headers(options?.headers)
    headers.set('X-BrowserOS-ID', browserosId)

    const response = await globalThis.fetch(url, { ...options, headers })

    const creditsRemaining = response.headers.get('X-Credits-Remaining')
    if (creditsRemaining !== null) {
      logger.debug('Credits remaining', { creditsRemaining })
    }

    if (!response.ok) {
      const statusCode = response.status
      const responseBody = await response.text()
      const error = parseErrorBody(responseBody)

      // The SDK derives isRetryable from the status alone, so a 429 that
      // really means a spent balance would be retried three times. Both
      // gateway fetch wrappers make that decision through the shared
      // classifier, and override isRetryable only when the body proves the
      // condition is permanent.
      const terminal = isTerminalProviderError({ statusCode, responseBody })

      throw new APICallError({
        message: error
          ? buildErrorMessage(statusCode, response.statusText, error)
          : `HTTP ${statusCode}: ${response.statusText}`,
        url: resolveUrl(url),
        requestBodyValues: {},
        statusCode,
        responseBody,
        ...(terminal && { isRetryable: false }),
      })
    }

    return response
  }) as typeof fetch
}
