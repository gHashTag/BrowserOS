/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Shared PostgreSQL retry helper with exponential backoff and jitter.
 */

import { logger } from '../logger'

export interface WithDbRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitterMaxMs?: number
  label?: string
}

export function isRetryableDbError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /connection terminated|connection refused|timeout|ECONNRESET|ETIMEDOUT|socket/i.test(
    message,
  )
}

export async function withDbRetry<T>(
  operation: () => Promise<T>,
  options: WithDbRetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    jitterMaxMs = 100,
    label = 'DB operation',
  } = options

  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (err) {
      lastError = err
      if (!isRetryableDbError(err) || attempt === maxAttempts - 1) {
        break
      }

      const jitter = Math.floor(Math.random() * (jitterMaxMs + 1))
      const delay = Math.min(baseDelayMs * 2 ** attempt + jitter, maxDelayMs)

      logger.warn(`${label} failed, retrying`, {
        attempt: attempt + 1,
        delayMs: delay,
        error: err instanceof Error ? err.message : String(err),
      })

      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError
}
