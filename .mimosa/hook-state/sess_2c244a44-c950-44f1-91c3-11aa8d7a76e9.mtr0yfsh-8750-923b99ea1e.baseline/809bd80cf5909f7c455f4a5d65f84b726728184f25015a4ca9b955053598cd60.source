/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it } from 'bun:test'
import assert from 'node:assert'
import { isRetryableDbError, withDbRetry } from './retry'

describe('isRetryableDbError', () => {
  it('matches ECONNRESET', () => {
    assert.strictEqual(isRetryableDbError(new Error('read ECONNRESET')), true)
  })

  it('matches timeout', () => {
    assert.strictEqual(
      isRetryableDbError(new Error('connection terminated by timeout')),
      true,
    )
  })

  it('returns false for non-retryable errors', () => {
    assert.strictEqual(
      isRetryableDbError(new Error('syntax error at or near "SELECT"')),
      false,
    )
  })
})

describe('withDbRetry', () => {
  it('exhausts after maxAttempts', async () => {
    let attempts = 0
    const error = new Error('read ECONNRESET')
    await assert.rejects(
      withDbRetry(
        async () => {
          attempts++
          throw error
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitterMaxMs: 0 },
      ),
      /read ECONNRESET/,
    )
    assert.strictEqual(attempts, 3)
  })

  it('jitter stays within bounds', async () => {
    let _attempts = 0
    const start = performance.now()
    await assert.rejects(
      withDbRetry(
        async () => {
          _attempts++
          throw new Error('connection timeout')
        },
        { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 50, jitterMaxMs: 3 },
      ),
      /connection timeout/,
    )
    const elapsed = performance.now() - start

    // Two delays: attempt 0 → 1 and attempt 1 → 2.
    // Each delay is bounded by [base * 2^i, base * 2^i + jitterMax] and maxDelayMs.
    // Lower bound: 5 + 10 = 15ms. Upper bound: (5+3) + (10+3) = 21ms.
    assert.ok(
      elapsed >= 10,
      `total elapsed ${elapsed}ms should be at least the lower bound`,
    )
    assert.ok(
      elapsed <= 100,
      `total elapsed ${elapsed}ms should stay well below maxDelayMs total`,
    )
  })
})
