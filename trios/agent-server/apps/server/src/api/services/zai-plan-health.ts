/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Is the paid Z.ai plan actually usable RIGHT NOW?
 *
 * The Queen can see configured credentials and active dispatches, but neither
 * answers the question that decides whether dispatching more work is safe:
 * is the quota window nearly spent, or is there healthy spare capacity? An
 * idle subscription and a throttled one read identically from the inside.
 * Today the only way to tell is an operator querying Z.ai by hand.
 *
 * This service answers it once per explicit read, from the provider's own
 * monitor endpoint, and reports NOTHING but bounded, secret-free facts:
 *
 *   - which plan level the subscription is on,
 *   - how much of the quota window is used, as an integer 0-100,
 *   - when the window resets,
 *   - when this observation was made.
 *
 * THREE PROPERTIES, all of them easy to get wrong:
 *
 *   1. FAIL CLOSED. A timeout, a transport failure, a non-2xx status, or a
 *      payload that does not match the documented shape reports UNAVAILABLE -
 *      never a guess that capacity is healthy. A scheduler that mistakes
 *      "could not read" for "all clear" dispatches work into a wall and blames
 *      the work. Unknown is a fact; healthy is a claim.
 *
 *   2. THE KEY NEVER COMES BACK. The credential exists in exactly one place:
 *      the Authorization header of the outbound request. Results carry only
 *      the four allowlisted fields above, error reasons come from a fixed
 *      vocabulary rather than payload- or exception-derived text (a provider
 *      error body can echo the key it was given), and the one log line per
 *      read carries the same allowlisted facts.
 *
 *   3. ONE BOUNDED REQUEST PER READ. No retries, no caching, no polling: a
 *      read that did not finish within its timeout returns unavailable, and
 *      the timeout bounds the whole exchange - headers AND body - because a
 *      server that stalls mid-body would otherwise hang the read forever.
 *
 * This file adds no route, persists nothing, and changes no dispatch
 * decision. It is a private read the scheduler will consume later.
 */

import { logger } from '../../lib/logger'

/**
 * The official Z.ai Coding Plan monitor endpoint.
 *
 * Documented by Z.ai for querying a Coding Plan subscription's usage; it is
 * served alongside (not under) the `.../coding/paas/v4` completion base the
 * provider factory uses. Authentication is the plan's API key in the
 * Authorization header.
 */
export const ZAI_CODING_USAGE_URL = 'https://api.z.ai/api/coding/usage'

/** Default and hard bounds for the read timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 8_000
const MIN_TIMEOUT_MS = 1
const MAX_TIMEOUT_MS = 60_000

/**
 * What a plan level may look like after normalization: lowercase, 1-24
 * characters, drawn from letters, digits, dots, underscores, hyphens. Anything
 * outside this is not a tier name this service will pass through - a freeform
 * string from the provider would be a channel for anything to reach the logs.
 */
const PLAN_LEVEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,23}$/

/** Fixed vocabulary for why a read is unavailable. Never payload-derived. */
export type ZaiPlanHealthReason =
  /** No API key was supplied, so nothing was requested. */
  | 'missing-credential'
  /** The read exceeded its timeout, headers or body. */
  | 'timeout'
  /** The request could not be completed at all. */
  | 'transport'
  /** The provider answered, but not with success. */
  | 'http-status'
  /** The answer was not usable, parseable, documented-shaped JSON. */
  | 'invalid-payload'

/** The bounded facts of a readable, healthy plan. */
export interface ZaiPlanHealthyFacts {
  status: 'healthy'
  /** Normalized plan level, e.g. 'lite'. */
  planLevel: string
  /** Share of the quota window spent: an integer from 0 through 100. */
  usagePercent: number
  /** ISO 8601 instant at which the provider says the window resets. */
  resetsAt: string
  /** ISO 8601 instant at which this server observed the facts. */
  observedAt: string
}

/** The fail-closed answer. Carries no facts it could not verify. */
export interface ZaiPlanUnavailable {
  status: 'unavailable'
  reason: ZaiPlanHealthReason
  observedAt: string
}

export type ZaiPlanHealth = ZaiPlanHealthyFacts | ZaiPlanUnavailable

/** Minimal fetch shape, so tests inject responses without a network. */
export type ZaiPlanHealthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface ReadZaiPlanHealthOptions {
  /** Plan API key. Defaults to `ZAI_API_KEY`, read per call. */
  apiKey?: string
  /** Fetch implementation. Defaults to the global fetch. */
  fetchImpl?: ZaiPlanHealthFetch
  /** Read timeout in milliseconds, clamped to [1, 60000]. */
  timeoutMs?: number
  /** Clock, for deterministic observation timestamps in tests. */
  now?: () => Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A number, or a string holding one. Anything else is not a usage number. */
function toFiniteNumber(value: unknown): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN
  return Number.isFinite(numeric) ? numeric : null
}

/**
 * `used / total` as an integer percentage clamped to [0, 100].
 *
 * The provider reports `used` and `total`; when `total` is absent entirely,
 * `used + remaining` is the denominator instead. A `total` that is PRESENT
 * but zero or negative gets no fallback: a payload claiming usage against a
 * zero quota is contradicting itself, and inventing a denominator for it
 * would report a confident percentage out of inconsistent data.
 *
 * Non-finite numbers are not percentages and are refused rather than
 * clamped: clamping says "a lot or a little", while NaN says nothing at
 * all, and a scheduler cannot act on nothing.
 */
function usagePercentOf(resource: unknown): number | null {
  if (!isRecord(resource)) return null
  const used = toFiniteNumber(resource.used)
  if (used === null) return null
  const total = toFiniteNumber(resource.total)

  let denominator: number | null = null
  if (total !== null) {
    if (total <= 0) return null
    denominator = total
  } else {
    const remaining = toFiniteNumber(resource.remaining)
    if (remaining !== null) {
      const span = used + remaining
      if (Number.isFinite(span) && span > 0) denominator = span
    }
  }
  if (denominator === null) return null

  const ratio = used / denominator
  if (!Number.isFinite(ratio)) return null
  return Math.min(100, Math.max(0, Math.round(ratio * 100)))
}

/**
 * Reduce a monitor response body to the four allowlisted facts.
 *
 * Everything the provider sends that is not plan level, quota percentage, or
 * reset time is discarded HERE, at the boundary - request ids, token counts,
 * subscription details, and any field this parser has never heard of. `null`
 * means the payload did not match the documented shape, which the caller
 * reports as unavailable rather than partially healthy.
 */
function reduceMonitorResponse(
  bodyText: string,
  observedAt: string,
): ZaiPlanHealthyFacts | null {
  let payload: unknown
  try {
    payload = JSON.parse(bodyText)
  } catch {
    return null
  }

  // The documented envelope wraps the facts in `data` behind `success: true`.
  // A 200 whose business envelope says otherwise is not a healthy answer.
  if (!isRecord(payload) || payload.success !== true) return null
  const data = payload.data
  if (!isRecord(data)) return null

  const planLevel =
    typeof data.subscriptionTier === 'string'
      ? data.subscriptionTier.trim().toLowerCase()
      : ''
  if (!PLAN_LEVEL_PATTERN.test(planLevel)) return null

  const expireTime = toFiniteNumber(data.expireTime)
  if (expireTime === null) return null
  const resetsAt = new Date(expireTime)
  if (Number.isNaN(resetsAt.getTime())) return null

  const usagePercent = usagePercentOf(data.resource)
  if (usagePercent === null) return null

  // Constructed field by field: unknown provider fields cannot ride along.
  return {
    status: 'healthy',
    planLevel,
    usagePercent,
    resetsAt: resetsAt.toISOString(),
    observedAt,
  }
}

/**
 * One bounded log line per read, carrying the same allowlisted facts the
 * result does. The credential, the URL, headers, and response bodies never
 * reach the logger - a provider error body can quote the key it was called
 * with, and the third thing an operator reaches for when a scheduler misreads
 * capacity is the log.
 */
function recordOutcome(
  health: ZaiPlanHealth,
  startedAtMs: number,
): ZaiPlanHealth {
  const meta: Record<string, unknown> = {
    status: health.status,
    reason: health.status === 'unavailable' ? health.reason : undefined,
    planLevel: health.status === 'healthy' ? health.planLevel : undefined,
    usagePercent: health.status === 'healthy' ? health.usagePercent : undefined,
    resetsAt: health.status === 'healthy' ? health.resetsAt : undefined,
    observedAt: health.observedAt,
    elapsedMs: Date.now() - startedAtMs,
  }
  if (health.status === 'healthy') {
    logger.info('Z.ai coding plan health read', meta)
  } else {
    logger.warn('Z.ai coding plan health read', meta)
  }
  return health
}

/**
 * Read the plan's health once. Never throws: every failure is an unavailable
 * result, because a caller that had to try/catch would eventually catch
 * nothing and guess.
 */
export async function readZaiPlanHealth(
  options: ReadZaiPlanHealthOptions = {},
): Promise<ZaiPlanHealth> {
  const startedAtMs = Date.now()
  // Read per call, not at import: a platform injecting variables after module
  // load would otherwise read as unconfigured forever. Whitespace counts as
  // absent - an editor's empty box leaves the name behind, supplying nothing.
  const apiKey = (options.apiKey ?? process.env.ZAI_API_KEY ?? '').trim()
  const now = options.now ?? (() => new Date())
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))

  const requested = options.timeoutMs
  const timeoutMs =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.min(
          MAX_TIMEOUT_MS,
          Math.max(MIN_TIMEOUT_MS, Math.round(requested)),
        )
      : DEFAULT_TIMEOUT_MS

  const observedAt = now().toISOString()

  // No credential: nothing is requested, and the scheduler learns the truth -
  // that this deployment cannot read the plan at all - not a fabricated
  // healthy verdict.
  if (apiKey.length === 0) {
    return recordOutcome(
      { status: 'unavailable', reason: 'missing-credential', observedAt },
      startedAtMs,
    )
  }

  // The timeout bounds the WHOLE exchange. The timer stays armed until the
  // read finishes: clearing it the moment headers arrive would let a server
  // that stalls mid-body hold the read open past any bound.
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  // Rejects when the abort fires, whether or not the injected fetch honors
  // the signal. A fetch that ignores signals must not be able to wedge the
  // read open forever.
  const deadline = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) {
      reject(new Error('deadline'))
      return
    }
    controller.signal.addEventListener('abort', () =>
      reject(new Error('deadline')),
    )
  })

  try {
    const request = fetchImpl(ZAI_CODING_USAGE_URL, {
      method: 'GET',
      headers: {
        // The key's ONLY appearance, on purpose. FR-002.
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    })
    // Observe the request promise so a rejection arriving after the deadline
    // has already settled the read cannot surface as unhandled.
    request.catch(() => {})

    const response = await Promise.race([request, deadline])
    if (!response.ok) {
      return recordOutcome(
        { status: 'unavailable', reason: 'http-status', observedAt },
        startedAtMs,
      )
    }

    // text() then JSON.parse, so a malformed body becomes this service's own
    // error instead of one carrying fragments of the payload in its message.
    const body = response.text()
    body.catch(() => {})
    const bodyText = await Promise.race([body, deadline])

    const facts = reduceMonitorResponse(bodyText, observedAt)
    if (!facts) {
      return recordOutcome(
        { status: 'unavailable', reason: 'invalid-payload', observedAt },
        startedAtMs,
      )
    }
    return recordOutcome(facts, startedAtMs)
  } catch {
    // The error object is deliberately discarded. Its message can quote the
    // URL, the cause, or response text; the reason vocabulary cannot.
    return recordOutcome(
      {
        status: 'unavailable',
        reason: timedOut ? 'timeout' : 'transport',
        observedAt,
      },
      startedAtMs,
    )
  } finally {
    clearTimeout(timer)
  }
}
