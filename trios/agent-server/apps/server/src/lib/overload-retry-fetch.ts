/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A fetch that retries an OpenAI-compatible endpoint whose overload answer is
 * NOT an HTTP error.
 *
 * Measured against integrate.api.nvidia.com on 2026-09-16: under load the
 * endpoint answers `200 text/event-stream` whose only event is
 *
 *   data: {"error":{"message":"Service temporarily overloaded","code":503}}
 *   data: [DONE]
 *
 * The AI SDK retries a 503 status; it cannot retry a 200, so the error reaches
 * the agent loop as a terminal error part and the bee's turn ends there. Three
 * of three bees died this way, after 10, 13 and 71 tool calls - the work was
 * fine, the tenth-or-so request was unlucky. Six sequential probes of one model
 * scored three such answers, so a turn of seventy requests could not survive.
 *
 * This wrapper peeks at the first event of a streaming 200. An error object
 * there, or a 429/5xx status, is retried with backoff; anything else is handed
 * on with the peeked bytes put back in front of the stream, so the SDK sees the
 * response it would have seen. Non-streaming responses are not touched.
 */

export interface OverloadRetryOptions {
  /** Total attempts including the first. */
  maxAttempts?: number
  /** Delay before attempt n+1, in ms; the last entry repeats. */
  delaysMs?: number[]
  /** Called once per retry, with why. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void
  /**
   * The model this attempt should be sent to, given the one the caller asked
   * for. Returning the same name (or undefined) leaves the body untouched.
   * See model-ranking.ts: this is how the swarm follows the best-measured
   * model without every caller knowing there is a choice.
   */
  routeModel?: (requested: string, attempt: number) => string | undefined
  /** Every answer, attributed to the model that gave it. */
  onOutcome?: (
    model: string,
    outcome: 'ok' | 'overloaded' | 'gone',
    /** Why a request was refused: '429', '503', 'stream', 'threw'. */
    cause?: string,
  ) => void
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>
}

const DEFAULT_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 45_000]
const PEEK_LIMIT_BYTES = 64 * 1024

function defaultSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The error message when the first SSE event is an error object, else null.
 * Exported for the test; the shape is the endpoint's, not ours.
 */
export function streamErrorInFirstEvent(text: string): string | null {
  const firstEvent = text.split(/\r?\n\r?\n/, 1)[0] ?? ''
  const data = firstEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('')
  if (!data.startsWith('{')) return null
  try {
    const parsed = JSON.parse(data) as {
      error?: { message?: string; code?: unknown }
    }
    if (parsed && typeof parsed === 'object' && parsed.error) {
      const code =
        parsed.error.code !== undefined ? `[${String(parsed.error.code)}] ` : ''
      return `${code}${parsed.error.message ?? 'error in stream'}`
    }
  } catch {
    // Not JSON: a real event, hand it on.
  }
  return null
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** Read until one complete SSE event is buffered, or the stream ends. */
async function peekFirstEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ bytes: Uint8Array; done: boolean }> {
  const chunks: Uint8Array[] = []
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return { bytes: concat(chunks), done: true }
    chunks.push(value)
    size += value.length
    text += decoder.decode(value, { stream: true })
    if (/\r?\n\r?\n/.test(text) || size >= PEEK_LIMIT_BYTES) {
      return { bytes: concat(chunks), done: false }
    }
  }
}

function replay(
  head: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  headOnly: boolean,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length > 0) controller.enqueue(head)
      if (headOnly) controller.close()
    },
    async pull(controller) {
      const { value, done } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

/** An abort the caller asked for, rather than a network failure. */
export function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

interface ParsedBody {
  model?: string
  json: Record<string, unknown>
}

/** The JSON request body, when there is one we can read and rewrite. */
function requestBody(init?: RequestInit): ParsedBody | undefined {
  if (typeof init?.body !== 'string') return undefined
  try {
    const json = JSON.parse(init.body) as unknown
    if (!json || typeof json !== 'object' || Array.isArray(json))
      return undefined
    const model = (json as { model?: unknown }).model
    return {
      model: typeof model === 'string' ? model : undefined,
      json: json as Record<string, unknown>,
    }
  } catch {
    return undefined
  }
}

function route(
  body: ParsedBody | undefined,
  attempt: number,
  routeModel: OverloadRetryOptions['routeModel'],
): { model: string; body: string } | undefined {
  if (!body?.model || !routeModel) return undefined
  const chosen = routeModel(body.model, attempt)
  if (!chosen || chosen === body.model) return undefined
  return {
    model: chosen,
    body: JSON.stringify({ ...body.json, model: chosen }),
  }
}

export function createOverloadRetryFetch(
  options: OverloadRetryOptions = {},
): typeof fetch {
  const maxAttempts = Math.max(
    1,
    options.maxAttempts ?? DEFAULT_DELAYS_MS.length + 1,
  )
  const delays = options.delaysMs?.length ? options.delaysMs : DEFAULT_DELAYS_MS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep

  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal
    const body = requestBody(init)
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= maxAttempts
      const delayMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0
      const routed = route(body, attempt, options.routeModel)
      const sent = routed ? { ...init, body: routed.body } : init
      const model = routed?.model ?? body?.model
      const outcome = (
        result: 'ok' | 'overloaded' | 'gone',
        cause?: string,
      ) => {
        if (model) options.onOutcome?.(model, result, cause)
      }

      // A THROW is the same outage wearing different clothes. Measured against
      // integrate.api.nvidia.com on 2026-09-20 at concurrency four on one key:
      // two answers 200, one 503, and one that never answered at all - the
      // socket simply hung until the client gave up. The status branches below
      // never saw that fourth one, because there was no response to branch on,
      // so it reached the agent loop as a terminal error and ended the turn.
      //
      // An abort the CALLER asked for is not an outage and is re-thrown at
      // once: retrying a cancelled request would outlive the thing that
      // cancelled it.
      let response: Response
      try {
        response = await fetchImpl(url, sent)
      } catch (error) {
        if (signal?.aborted || isAbort(error)) throw error
        outcome('overloaded', 'threw')
        if (last) throw error
        options.onRetry?.({
          attempt,
          delayMs,
          reason: `fetch threw: ${error instanceof Error ? error.message : String(error)}`,
        })
        await sleep(delayMs, signal)
        continue
      }

      if (response.status === 404 || response.status === 410) outcome('gone')
      if (response.status === 429 || response.status >= 500) {
        outcome('overloaded', String(response.status))
        if (last) return response
        await response.body?.cancel().catch(() => {})
        options.onRetry?.({
          attempt,
          delayMs,
          reason: `HTTP ${response.status}`,
        })
        await sleep(delayMs, signal)
        continue
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (
        !response.ok ||
        !response.body ||
        !contentType.includes('text/event-stream')
      ) {
        if (response.ok) outcome('ok')
        return response
      }

      const reader = response.body.getReader()
      const { bytes, done } = await peekFirstEvent(reader)
      const reason = streamErrorInFirstEvent(new TextDecoder().decode(bytes))
      if (reason === null) {
        outcome('ok')
        return new Response(replay(bytes, reader, done), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      await reader.cancel().catch(() => {})
      outcome('overloaded', 'stream')
      if (last) {
        // Out of attempts: surface it as the status the body claimed, so the
        // SDK raises a real error with the endpoint's own words in it.
        return new Response(JSON.stringify({ error: { message: reason } }), {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'content-type': 'application/json' },
        })
      }
      options.onRetry?.({ attempt, delayMs, reason })
      await sleep(delayMs, signal)
    }
  }) as typeof fetch
}
