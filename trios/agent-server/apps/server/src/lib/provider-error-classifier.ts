/**
 * Classifies provider HTTP errors that must never be retried.
 *
 * The Vercel AI SDK derives `isRetryable` from the HTTP status alone, so 429 is
 * always treated as a transient rate limit. Several providers reuse 429 (or 400)
 * for permanent conditions - Z.AI answers an exhausted account balance with
 * HTTP 429 and business code 1113. Retrying those turns one dead request into
 * three, tripling latency and log noise while the outcome cannot change.
 */

/** Z.AI business code for an exhausted balance or missing resource package. */
export const ZAI_INSUFFICIENT_BALANCE_CODE = '1113'

/**
 * Wording that indicates a spent account, matched case-insensitively as a
 * fallback for providers that renumber their codes.
 */
const TERMINAL_BALANCE_PHRASES = [
  'insufficient balance',
  'no resource package',
  'please recharge',
  'insufficient credits',
  'insufficient_quota',
  'billing_hard_limit_reached',
  'exceeded your current quota',
]

export interface ProviderErrorContext {
  statusCode: number
  /** Raw response body, if it could be read. */
  responseBody?: string
}

/**
 * Returns true when retrying the identical request cannot succeed.
 *
 * Conservative by design: an unrecognised error stays retryable, so a transient
 * provider blip is never misclassified as permanent.
 */
export function isTerminalProviderError({
  statusCode,
  responseBody,
}: ProviderErrorContext): boolean {
  // 402 Payment Required is unambiguous across providers.
  if (statusCode === 402) return true

  if (!responseBody) return false

  const lower = responseBody.toLowerCase()
  if (TERMINAL_BALANCE_PHRASES.some((phrase) => lower.includes(phrase))) {
    return true
  }

  // Structured check for the Z.AI envelope: {"error":{"code":"1113",...}}
  try {
    const parsed = JSON.parse(responseBody)
    const code = parsed?.error?.code
    if (code !== undefined && String(code) === ZAI_INSUFFICIENT_BALANCE_CODE) {
      return true
    }
  } catch {
    // A non-JSON body is covered by the phrase scan above.
  }

  return false
}
