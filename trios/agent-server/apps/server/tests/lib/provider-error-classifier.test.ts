import { describe, expect, test } from 'bun:test'
import {
  isTerminalProviderError,
  ZAI_INSUFFICIENT_BALANCE_CODE,
} from '../../src/lib/provider-error-classifier'

describe('isTerminalProviderError', () => {
  test('treats Z.AI code 1113 on HTTP 429 as terminal', () => {
    // This is the exact payload that produced "Failed after 3 attempts".
    const responseBody = JSON.stringify({
      error: {
        code: ZAI_INSUFFICIENT_BALANCE_CODE,
        message: 'Insufficient balance or no resource package. Please recharge.',
      },
    })
    expect(isTerminalProviderError({ statusCode: 429, responseBody })).toBe(true)
  })

  test('tolerates a numeric business code', () => {
    const responseBody = JSON.stringify({ error: { code: 1113, message: 'nope' } })
    expect(isTerminalProviderError({ statusCode: 429, responseBody })).toBe(true)
  })

  test('treats HTTP 402 as terminal regardless of body', () => {
    expect(isTerminalProviderError({ statusCode: 402 })).toBe(true)
    expect(isTerminalProviderError({ statusCode: 402, responseBody: 'anything' })).toBe(true)
  })

  test('matches balance wording when the code changes', () => {
    const responseBody = JSON.stringify({
      error: { code: '9999', message: 'Insufficient balance, please recharge' },
    })
    expect(isTerminalProviderError({ statusCode: 429, responseBody })).toBe(true)
  })

  test('matches wording case-insensitively', () => {
    expect(
      isTerminalProviderError({ statusCode: 400, responseBody: 'PLEASE RECHARGE' }),
    ).toBe(true)
  })

  test('recognises OpenAI-style quota exhaustion', () => {
    const responseBody = JSON.stringify({
      error: { code: 'insufficient_quota', message: 'You exceeded your current quota' },
    })
    expect(isTerminalProviderError({ statusCode: 429, responseBody })).toBe(true)
  })

  test('keeps a genuine rate limit retryable', () => {
    const responseBody = JSON.stringify({
      error: { code: '1302', message: 'Concurrency limit reached, please try again later' },
    })
    expect(isTerminalProviderError({ statusCode: 429, responseBody })).toBe(false)
  })

  test('keeps server errors retryable', () => {
    expect(isTerminalProviderError({ statusCode: 500, responseBody: 'upstream boom' })).toBe(
      false,
    )
    expect(isTerminalProviderError({ statusCode: 503 })).toBe(false)
  })

  test('does not crash on a missing or non-JSON body', () => {
    expect(isTerminalProviderError({ statusCode: 429 })).toBe(false)
    expect(isTerminalProviderError({ statusCode: 429, responseBody: '' })).toBe(false)
    expect(isTerminalProviderError({ statusCode: 429, responseBody: '<html>502</html>' })).toBe(
      false,
    )
  })

  test('does not treat an unrelated 1113-like number as terminal', () => {
    const responseBody = JSON.stringify({ error: { code: '11130', message: 'other' } })
    expect(isTerminalProviderError({ statusCode: 429, responseBody })).toBe(false)
  })
})
