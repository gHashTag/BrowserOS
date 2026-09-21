/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Which worker model a bee's next request should go to, decided by what the
 * endpoint is actually doing rather than by a variable someone typed.
 *
 * Measured 2026-09-21 against integrate.api.nvidia.com: at ten lanes the bees'
 * model (nemotron-3-super-120b) answered 1,369 of its requests in twenty
 * minutes with 429 or 503, and every one of ten keys drew 503s at random - the
 * model was overloaded, not our keys. The same afternoon five of the seven
 * models the swarm might have fallen back to answered 410 Gone or 404: a
 * fixed fallback list goes stale without anyone noticing.
 *
 * So the ranking is a measurement with two inputs:
 *
 *   - probes: a short request to each candidate every few minutes. They give
 *     speed (completion tokens per second), whether the model calls a tool
 *     when handed one, and whether it exists at all (404/410).
 *   - live outcomes: every request a bee sends, as the retry wrapper sees it -
 *     answered, or turned away with 429/5xx.
 *
 * The score is the expected seconds a 500-token step costs, retries included:
 *
 *   cost = (500 / tokensPerSecond) / successRate
 *
 * so a fast model that fails half its calls can still beat a slow one that
 * never fails, which is what the numbers said: super-120b at 66 tok/s and 60%
 * costs 12.6s a step; ultra-550b at 10 tok/s and 80% costs 62.5s.
 *
 * A model is only chosen once it has been probed and called a tool; the
 * primary (TRIOS_QUEEN_WORKER_MODEL) is the answer until something measurably
 * beats it by SWITCH_MARGIN, so two close models do not flap.
 */

export type LiveOutcome = 'ok' | 'overloaded' | 'gone'

export interface ProbeResult {
  ok: boolean
  /** 404 or 410: the endpoint no longer serves this model. */
  gone?: boolean
  tokensPerSecond?: number
  /** Whether the model answered a tool-offering prompt with a tool call. */
  toolCalls?: boolean
}

interface Event {
  at: number
  ok: boolean
  /** For a refusal: '429', '503', 'stream', 'threw'. */
  cause?: string
}

interface ModelState {
  events: Event[]
  gone: boolean
  goneAt?: number
  tokensPerSecond?: number
  toolCalls?: boolean
  probedAt?: number
  /** Probes in a row that did not succeed; drives the retry backoff. */
  probeFailures: number
}

export interface RankedModel {
  model: string
  score: number | null
  successRate: number
  samples: number
  tokensPerSecond?: number
  toolCalls?: boolean
  gone: boolean
  /**
   * Refusals in the window by cause. 503 means the MODEL is overloaded and
   * switching helps; 429 means one KEY is over its rate and fewer lanes per
   * key helps. One number for both hid which lever to pull.
   */
  refusals: Record<string, number>
}

const STEP_TOKENS = 500
const DEFAULT_WINDOW_MS = 15 * 60_000
/** A challenger must be this much cheaper before the swarm moves to it. */
const SWITCH_MARGIN = 0.8
/** A model that answered 404/410 is re-probed after this long, not forgotten. */
const GONE_RETRY_MS = 60 * 60_000
/** A measured model is re-probed this often. */
const PROBE_EVERY_MS = 5 * 60_000
/**
 * A failed probe is retried after a minute, doubling to half an hour. Every
 * deploy starts the ranking from nothing, and measured 2026-09-21 12:02 the
 * first probe of ultra-550b failed under boot load: the model the swarm had
 * been using for an hour sat unscored for five minutes, and the bees went
 * back to the one that was drawing 429s.
 */
const PROBE_RETRY_MIN_MS = 60_000
const PROBE_RETRY_MAX_MS = 30 * 60_000
const MAX_EVENTS = 2_000
/** Live answers needed before an unscored model counts as failing. */
const FAILING_MIN_SAMPLES = 5
/**
 * How long a choice stands before a challenger may replace it. Measured
 * 2026-09-21 11:48: three switches in 35 seconds, each on a handful of
 * samples - a single refusal moved a lightly-sampled model's cost by half.
 * A switch changes nothing for a bee mid-step; flapping only muddies the
 * evidence both models are being judged on.
 */
const MIN_DWELL_MS = 3 * 60_000

export class ModelRanking {
  private readonly states = new Map<string, ModelState>()
  private current: string
  private chosenAt = Number.NEGATIVE_INFINITY

  constructor(
    readonly candidates: string[],
    private readonly options: { windowMs?: number; now?: () => number } = {},
  ) {
    if (candidates.length === 0) throw new Error('no candidate models')
    for (const model of candidates)
      this.states.set(model, { events: [], gone: false, probeFailures: 0 })
    this.current = candidates[0]
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  has(model: string): boolean {
    return this.states.has(model)
  }

  recordLive(model: string, outcome: LiveOutcome, cause?: string): void {
    const state = this.states.get(model)
    if (!state) return
    if (outcome === 'gone') {
      state.gone = true
      state.goneAt = this.now()
      return
    }
    state.events.push({ at: this.now(), ok: outcome === 'ok', cause })
    if (state.events.length > MAX_EVENTS)
      state.events.splice(0, state.events.length - MAX_EVENTS)
  }

  recordProbe(model: string, result: ProbeResult): void {
    const state = this.states.get(model)
    if (!state) return
    state.probedAt = this.now()
    state.probeFailures = result.ok ? 0 : state.probeFailures + 1
    if (result.gone) {
      state.gone = true
      state.goneAt = this.now()
      return
    }
    state.gone = false
    state.events.push({ at: this.now(), ok: result.ok })
    if (result.tokensPerSecond !== undefined && result.tokensPerSecond > 0) {
      // Smooth: one probe on a busy minute should not decide the hour.
      state.tokensPerSecond =
        state.tokensPerSecond === undefined
          ? result.tokensPerSecond
          : state.tokensPerSecond * 0.5 + result.tokensPerSecond * 0.5
    }
    if (result.toolCalls !== undefined) {
      // A model keeps its tool-calling verdict once it has shown it can; one
      // refusal on a busy answer is not evidence it cannot.
      state.toolCalls = state.toolCalls === true ? true : result.toolCalls
    }
  }

  /**
   * Whether a probe is owed: never probed, a measured model every five
   * minutes, a failing one on backoff, a gone one hourly.
   */
  dueForProbe(model: string): boolean {
    const state = this.states.get(model)
    if (!state) return false
    if (state.gone) return this.now() - (state.goneAt ?? 0) >= GONE_RETRY_MS
    if (state.probedAt === undefined) return true
    const wait =
      state.probeFailures > 0
        ? Math.min(
            PROBE_RETRY_MIN_MS * 2 ** (state.probeFailures - 1),
            PROBE_RETRY_MAX_MS,
          )
        : PROBE_EVERY_MS
    return this.now() - state.probedAt >= wait
  }

  private successRate(state: ModelState): { rate: number; samples: number } {
    const since = this.now() - (this.options.windowMs ?? DEFAULT_WINDOW_MS)
    const recent = state.events.filter((event) => event.at >= since)
    const ok = recent.filter((event) => event.ok).length
    // Laplace: two samples must not read as certainty either way.
    return { rate: (ok + 1) / (recent.length + 2), samples: recent.length }
  }

  /** At least FAILING_MIN_SAMPLES live answers, fewer than half of them ok. */
  private failingLive(model: string): boolean {
    const state = this.states.get(model)
    if (!state) return false
    const { rate, samples } = this.successRate(state)
    return samples >= FAILING_MIN_SAMPLES && rate < 0.5
  }

  /** Expected seconds per step; null when the model cannot be chosen. */
  private score(model: string): number | null {
    const state = this.states.get(model)
    if (!state || state.gone) return null
    if (!state.tokensPerSecond || state.toolCalls !== true) return null
    const { rate } = this.successRate(state)
    return STEP_TOKENS / state.tokensPerSecond / rate
  }

  /** The model the next request should use. */
  best(): string {
    const primary = this.candidates[0]
    const currentScore = this.score(this.current)
    // The current choice died: fall back to the primary unless it died too.
    if (currentScore === null && this.current !== primary) {
      this.current = primary
    }
    // Hold a live choice for MIN_DWELL_MS; only its death ends it sooner.
    if (
      this.score(this.current) !== null &&
      this.now() - this.chosenAt < MIN_DWELL_MS
    ) {
      return this.current
    }
    let bestModel = this.current
    let bestScore = this.score(this.current)
    for (const model of this.candidates) {
      const score = this.score(model)
      if (score === null || model === bestModel) continue
      const beats =
        bestScore === null
          ? // The current model is unmeasured or gone. A measured model
            // replaces it when it is known gone, or when it is FAILING: its
            // own probe can be refused by the same 429s that are failing the
            // bees, and then it has no score at all. Measured 2026-09-21
            // 12:41: super-120b answered 31% of live calls, had no score
            // because its probe drew a 429, and "not yet probed" kept every
            // bee on it. Unmeasured and quiet still keeps the primary.
            this.states.get(bestModel)?.gone === true ||
            this.failingLive(bestModel)
          : score < bestScore * SWITCH_MARGIN
      if (beats) {
        bestModel = model
        bestScore = score
      }
    }
    if (bestModel !== this.current) this.chosenAt = this.now()
    this.current = bestModel
    return bestModel
  }

  /** The ranking with its evidence, best first; for /queen/status and logs. */
  snapshot(): RankedModel[] {
    return this.candidates
      .map((model) => {
        const state = this.states.get(model) as ModelState
        const { rate, samples } = this.successRate(state)
        const since = this.now() - (this.options.windowMs ?? DEFAULT_WINDOW_MS)
        const refusals: Record<string, number> = {}
        for (const event of state.events) {
          if (event.at < since || event.ok) continue
          const cause = event.cause ?? 'probe'
          refusals[cause] = (refusals[cause] ?? 0) + 1
        }
        return {
          model,
          score: this.score(model),
          successRate: Math.round(rate * 100) / 100,
          samples,
          tokensPerSecond:
            state.tokensPerSecond === undefined
              ? undefined
              : Math.round(state.tokensPerSecond),
          toolCalls: state.toolCalls,
          gone: state.gone,
          refusals,
        }
      })
      .sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity))
  }
}

/**
 * The candidates, primary first: TRIOS_QUEEN_WORKER_MODEL, then the
 * comma-separated TRIOS_QUEEN_WORKER_MODEL_CANDIDATES. Empty when no
 * candidates are configured - and then nothing is rerouted, byte for byte the
 * behaviour before this file existed.
 */
export function candidatesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const extra = (env.TRIOS_QUEEN_WORKER_MODEL_CANDIDATES ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
  const primary = env.TRIOS_QUEEN_WORKER_MODEL?.trim()
  if (!primary || extra.length === 0) return []
  return [...new Set([primary, ...extra])]
}

let shared: ModelRanking | null | undefined

/** The process-wide ranking, or null when switching is not configured. */
export function workerModelRanking(): ModelRanking | null {
  if (shared === undefined) {
    const candidates = candidatesFromEnv()
    shared = candidates.length > 0 ? new ModelRanking(candidates) : null
  }
  return shared
}

/** Tests only. */
export function resetWorkerModelRanking(): void {
  shared = undefined
}

const PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file from the repository',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
}

async function post(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json?: any; seconds: number }> {
  const started = Date.now()
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = response.ok
    ? await response.json().catch(() => undefined)
    : undefined
  if (!response.ok) await response.body?.cancel().catch(() => {})
  return {
    status: response.status,
    json,
    seconds: (Date.now() - started) / 1000,
  }
}

/**
 * Two requests: one for speed (plain generation), one for tool calling.
 * Never throws; a timeout or network failure is an unsuccessful probe.
 */
export async function probeModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 90_000
  try {
    const speed = await post(
      fetchImpl,
      baseUrl,
      apiKey,
      {
        model,
        messages: [
          {
            role: 'user',
            content:
              'Write a TypeScript function that parses an ISO date and returns the weekday name, with two tests.',
          },
        ],
        max_tokens: 300,
      },
      timeoutMs,
    )
    if (speed.status === 404 || speed.status === 410)
      return { ok: false, gone: true }
    if (speed.status !== 200) return { ok: false }
    const tokens = Number(speed.json?.usage?.completion_tokens) || 0
    const tokensPerSecond =
      speed.seconds > 0 ? tokens / speed.seconds : undefined

    const tool = await post(
      fetchImpl,
      baseUrl,
      apiKey,
      {
        model,
        messages: [
          {
            role: 'user',
            content: 'Read src/app.ts with the tool, then say what it does.',
          },
        ],
        tools: [PROBE_TOOL],
        max_tokens: 300,
      },
      timeoutMs,
    )
    const toolCalls =
      tool.status === 200
        ? Array.isArray(tool.json?.choices?.[0]?.message?.tool_calls) &&
          tool.json.choices[0].message.tool_calls.length > 0
        : undefined
    return { ok: true, tokensPerSecond, toolCalls }
  } catch {
    return { ok: false }
  }
}

/**
 * Check every `intervalMs` which candidates are owed a probe (see
 * ModelRanking.dueForProbe) and probe those, rotating keys so no
 * single account carries the probes. Returns a stop function.
 */
export function startModelProbes(
  ranking: ModelRanking,
  endpoint: { baseUrl: string; keys: string[] },
  options: {
    intervalMs?: number
    fetchImpl?: typeof fetch
    onRound?: (snapshot: RankedModel[], chosen: string) => void
  } = {},
): () => void {
  if (endpoint.keys.length === 0) return () => {}
  let keyCursor = 0
  let running = false
  const round = async () => {
    if (running) return
    running = true
    try {
      let probed = 0
      for (const model of ranking.candidates) {
        if (!ranking.dueForProbe(model)) continue
        probed++
        const key = endpoint.keys[keyCursor++ % endpoint.keys.length]
        ranking.recordProbe(
          model,
          await probeModel(endpoint.baseUrl, key, model, {
            fetchImpl: options.fetchImpl,
          }),
        )
      }
      if (probed > 0) options.onRound?.(ranking.snapshot(), ranking.best())
    } finally {
      running = false
    }
  }
  void round()
  const timer = setInterval(
    () => void round(),
    options.intervalMs ?? PROBE_RETRY_MIN_MS,
  )
  timer.unref?.()
  return () => clearInterval(timer)
}
