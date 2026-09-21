/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it } from 'bun:test'
import assert from 'node:assert'
import { candidatesFromEnv, ModelRanking, probeModel } from './model-ranking'
import { createOverloadRetryFetch } from './overload-retry-fetch'

const FAST = 'nvidia/super'
const SLOW = 'nvidia/ultra'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

function ranking(now = clock()) {
  return new ModelRanking([FAST, SLOW], { now: now.now })
}

describe('ModelRanking', () => {
  it('stays on the primary until anything is measured', () => {
    assert.strictEqual(ranking().best(), FAST)
  })

  it('keeps a fast model that fails often over a slow one that does not (measured 2026-09-21)', () => {
    const r = ranking()
    r.recordProbe(FAST, { ok: true, tokensPerSecond: 66, toolCalls: true })
    r.recordProbe(SLOW, { ok: true, tokensPerSecond: 10, toolCalls: true })
    for (let i = 0; i < 40; i++) r.recordLive(FAST, 'overloaded')
    for (let i = 0; i < 60; i++) r.recordLive(FAST, 'ok')
    // 66 tok/s at ~60% is 12.6s a step; 10 tok/s at ~100% is ~50s.
    assert.strictEqual(r.best(), FAST)
  })

  it('moves to the runner-up when the primary is turned away almost always', () => {
    const r = ranking()
    r.recordProbe(FAST, { ok: true, tokensPerSecond: 66, toolCalls: true })
    r.recordProbe(SLOW, { ok: true, tokensPerSecond: 10, toolCalls: true })
    for (let i = 0; i < 200; i++) r.recordLive(FAST, 'overloaded')
    r.recordLive(FAST, 'ok')
    assert.strictEqual(r.best(), SLOW)
  })

  it('comes back once the primary recovers and the bad minutes age out', () => {
    const now = clock()
    const r = ranking(now)
    r.recordProbe(FAST, { ok: true, tokensPerSecond: 66, toolCalls: true })
    r.recordProbe(SLOW, { ok: true, tokensPerSecond: 10, toolCalls: true })
    for (let i = 0; i < 200; i++) r.recordLive(FAST, 'overloaded')
    assert.strictEqual(r.best(), SLOW)
    now.advance(20 * 60_000)
    for (let i = 0; i < 10; i++) r.recordLive(FAST, 'ok')
    assert.strictEqual(r.best(), FAST)
  })

  it('never picks a model that has not shown it can call a tool', () => {
    const r = ranking()
    r.recordProbe(FAST, { ok: true, tokensPerSecond: 66, toolCalls: true })
    r.recordProbe(SLOW, { ok: true, tokensPerSecond: 500, toolCalls: false })
    assert.strictEqual(r.best(), FAST)
  })

  it('leaves a primary that is gone, and re-probes it an hour later', () => {
    const now = clock()
    const r = ranking(now)
    r.recordProbe(SLOW, { ok: true, tokensPerSecond: 10, toolCalls: true })
    r.recordLive(FAST, 'gone')
    assert.strictEqual(r.best(), SLOW)
    assert.strictEqual(r.dueForProbe(FAST), false)
    now.advance(61 * 60_000)
    assert.strictEqual(r.dueForProbe(FAST), true)
  })

  it('does not flap between two close models', () => {
    const r = ranking()
    r.recordProbe(FAST, { ok: true, tokensPerSecond: 50, toolCalls: true })
    r.recordProbe(SLOW, { ok: true, tokensPerSecond: 55, toolCalls: true })
    assert.strictEqual(r.best(), FAST)
  })
})

describe('candidatesFromEnv', () => {
  it('is empty unless both the primary and candidates are set', () => {
    assert.deepStrictEqual(
      candidatesFromEnv({ TRIOS_QUEEN_WORKER_MODEL: 'a' }),
      [],
    )
    assert.deepStrictEqual(
      candidatesFromEnv({ TRIOS_QUEEN_WORKER_MODEL_CANDIDATES: 'b' }),
      [],
    )
  })

  it('puts the primary first and drops duplicates', () => {
    assert.deepStrictEqual(
      candidatesFromEnv({
        TRIOS_QUEEN_WORKER_MODEL: 'a',
        TRIOS_QUEEN_WORKER_MODEL_CANDIDATES: 'b, a ,c,',
      }),
      ['a', 'b', 'c'],
    )
  })
})

describe('probeModel', () => {
  it('reports 410 as gone', async () => {
    const fetchImpl = (async () =>
      new Response('gone', { status: 410 })) as unknown as typeof fetch
    assert.deepStrictEqual(
      await probeModel('http://x', 'k', 'm', { fetchImpl }),
      {
        ok: false,
        gone: true,
      },
    )
  })

  it('measures speed and tool calling', async () => {
    let call = 0
    const fetchImpl = (async () => {
      call++
      // A zero-duration answer has no speed; a real one never takes 0 ms.
      await new Promise((resolve) => setTimeout(resolve, 5))
      const message =
        call === 1
          ? { content: 'hi' }
          : {
              tool_calls: [
                {
                  id: '1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{}' },
                },
              ],
            }
      return Response.json({
        choices: [{ message }],
        usage: { completion_tokens: 100 },
      })
    }) as unknown as typeof fetch
    const result = await probeModel('http://x', 'k', 'm', { fetchImpl })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.toolCalls, true)
    assert.ok((result.tokensPerSecond ?? 0) > 0)
  })

  it('never throws on a network failure', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('socket hang up')
    }) as unknown as typeof fetch
    assert.deepStrictEqual(
      await probeModel('http://x', 'k', 'm', { fetchImpl }),
      { ok: false },
    )
  })
})

describe('overload retry routing', () => {
  const sse = (body: string) =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  const GOOD =
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n'

  it('sends each attempt to the routed model and attributes every answer', async () => {
    const seen: string[] = []
    const outcomes: string[] = []
    let calls = 0
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)).model)
      return calls++ === 0 ? new Response('busy', { status: 503 }) : sse(GOOD)
    }) as unknown as typeof fetch
    const wrapped = createOverloadRetryFetch({
      fetchImpl,
      sleep: async () => {},
      routeModel: (_requested, attempt) => (attempt === 1 ? FAST : SLOW),
      onOutcome: (model, outcome) => outcomes.push(`${model}:${outcome}`),
    })
    const response = await wrapped('http://x/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: FAST, messages: [], stream: true }),
    })
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(seen, [FAST, SLOW])
    assert.deepStrictEqual(outcomes, [`${FAST}:overloaded`, `${SLOW}:ok`])
  })

  it('leaves the body untouched without a router', async () => {
    let body = ''
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body)
      return sse(GOOD)
    }) as unknown as typeof fetch
    const original = JSON.stringify({ model: 'm', messages: [] })
    await createOverloadRetryFetch({ fetchImpl })('http://x', {
      method: 'POST',
      body: original,
    })
    assert.strictEqual(body, original)
  })
})

describe('refusal causes', () => {
  it('counts 429 and 503 apart, so the right lever is visible', () => {
    const r = new ModelRanking([FAST, SLOW])
    r.recordLive(FAST, 'overloaded', '429')
    r.recordLive(FAST, 'overloaded', '429')
    r.recordLive(FAST, 'overloaded', '503')
    r.recordLive(FAST, 'ok')
    const fast = r.snapshot().find((m) => m.model === FAST)
    assert.deepStrictEqual(fast?.refusals, { '429': 2, '503': 1 })
  })

  it('the retry wrapper names the status it was refused with', async () => {
    const causes: (string | undefined)[] = []
    let calls = 0
    const fetchImpl = (async () =>
      calls++ === 0
        ? new Response('slow down', { status: 429 })
        : new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch
    await createOverloadRetryFetch({
      fetchImpl,
      sleep: async () => {},
      onOutcome: (_model, _outcome, cause) => causes.push(cause),
    })('http://x', { method: 'POST', body: JSON.stringify({ model: 'm' }) })
    assert.deepStrictEqual(causes, ['429', undefined])
  })
})

describe('dwell', () => {
  it('holds a fresh choice for three minutes, then lets the evidence decide', () => {
    let t = 1_000_000
    const r = new ModelRanking([FAST, SLOW], { now: () => t })
    r.recordProbe(FAST, { ok: true, tokensPerSecond: 66, toolCalls: true })
    r.recordProbe(SLOW, { ok: true, tokensPerSecond: 60, toolCalls: true })
    for (let i = 0; i < 50; i++) r.recordLive(FAST, 'overloaded', '429')
    assert.strictEqual(r.best(), SLOW)
    // One bad minute for the new choice does not send it straight back.
    for (let i = 0; i < 30; i++) r.recordLive(SLOW, 'overloaded', 'stream')
    t += 60_000
    assert.strictEqual(r.best(), SLOW)
    t += 3 * 60_000
    for (let i = 0; i < 40; i++) r.recordLive(FAST, 'ok')
    assert.strictEqual(r.best(), FAST)
  })
})

describe('probe schedule', () => {
  it('retries a failed probe after a minute, doubling, and a measured one every five', () => {
    let t = 1_000_000
    const r = new ModelRanking([FAST, SLOW], { now: () => t })
    assert.strictEqual(r.dueForProbe(SLOW), true)
    r.recordProbe(SLOW, { ok: false })
    t += 59_000
    assert.strictEqual(r.dueForProbe(SLOW), false)
    t += 2_000
    assert.strictEqual(r.dueForProbe(SLOW), true)
    r.recordProbe(SLOW, { ok: false })
    t += 61_000
    assert.strictEqual(r.dueForProbe(SLOW), false)
    t += 60_000
    assert.strictEqual(r.dueForProbe(SLOW), true)
    r.recordProbe(SLOW, { ok: true, tokensPerSecond: 60, toolCalls: true })
    t += 4 * 60_000
    assert.strictEqual(r.dueForProbe(SLOW), false)
    t += 61_000
    assert.strictEqual(r.dueForProbe(SLOW), true)
  })
})

describe('an unscored primary that is failing', () => {
  it('gives way to a measured model (12:41, 2026-09-21)', () => {
    const r = new ModelRanking([FAST, SLOW])
    r.recordProbe(FAST, { ok: false })
    r.recordProbe(SLOW, { ok: true, tokensPerSecond: 60, toolCalls: true })
    for (let i = 0; i < 4; i++) r.recordLive(FAST, 'overloaded', '429')
    r.recordLive(FAST, 'ok')
    // 5 samples, 1 ok: Laplace 2/7 < 0.5.
    assert.strictEqual(r.best(), SLOW)
  })

  it('keeps an unscored primary that is merely quiet', () => {
    const r = new ModelRanking([FAST, SLOW])
    r.recordProbe(SLOW, { ok: true, tokensPerSecond: 60, toolCalls: true })
    r.recordLive(FAST, 'overloaded', '429')
    assert.strictEqual(r.best(), FAST)
  })
})

describe('per-key spill (13:25, 2026-09-21)', () => {
  const measured = () => {
    let t = 1_000_000
    const r = new ModelRanking([FAST, SLOW], { now: () => t })
    r.recordProbe(FAST, { ok: true, tokensPerSecond: 66, toolCalls: true })
    r.recordProbe(SLOW, { ok: true, tokensPerSecond: 20, toolCalls: true })
    return { r, advance: (ms: number) => (t += ms) }
  }

  it('sends a key refused for the best model to the runner-up, for a minute', () => {
    const { r, advance } = measured()
    assert.strictEqual(r.routeFor('k1'), FAST)
    r.recordLive(FAST, 'overloaded', '429', 'k1')
    assert.strictEqual(r.routeFor('k1'), SLOW)
    // Other keys are untouched by k1's limit.
    assert.strictEqual(r.routeFor('k2'), FAST)
    advance(61_000)
    assert.strictEqual(r.routeFor('k1'), FAST)
  })

  it('does not spill on a 503: that is the model, not the key', () => {
    const { r } = measured()
    r.recordLive(FAST, 'overloaded', '503', 'k1')
    assert.strictEqual(r.routeFor('k1'), FAST)
  })

  it('stays on the best model when every candidate is spent on the key', () => {
    const { r } = measured()
    r.recordLive(FAST, 'overloaded', '429', 'k1')
    r.recordLive(SLOW, 'overloaded', '429', 'k1')
    assert.strictEqual(r.routeFor('k1'), FAST)
  })

  it('the retry wrapper skips the backoff when the next attempt changes model', async () => {
    const { r } = measured()
    const slept: number[] = []
    const seen: string[] = []
    let calls = 0
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)).model)
      return calls++ === 0
        ? new Response('slow down', { status: 429 })
        : new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
    }) as unknown as typeof fetch
    await createOverloadRetryFetch({
      fetchImpl,
      sleep: async (ms) => {
        slept.push(ms)
      },
      routeModel: (_requested, _attempt, keyTag) => r.routeFor(keyTag),
      onOutcome: (model, outcome, cause, keyTag) =>
        r.recordLive(model, outcome, cause, keyTag),
    })('http://x', {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-real-key' },
      body: JSON.stringify({ model: FAST }),
    })
    assert.deepStrictEqual(seen, [FAST, SLOW])
    assert.deepStrictEqual(slept, [250])
  })
})

describe('tool probe retry (13:44, 2026-09-21)', () => {
  it('asks the tool question again after a refusal', async () => {
    let call = 0
    const fetchImpl = (async () => {
      call++
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (call === 1)
        return Response.json({
          choices: [{ message: { content: 'x' } }],
          usage: { completion_tokens: 50 },
        })
      if (call === 2) return new Response('busy', { status: 503 })
      return Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: '1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{}' },
                },
              ],
            },
          },
        ],
      })
    }) as unknown as typeof fetch
    const result = await probeModel('http://x', 'k', 'm', {
      fetchImpl,
      retryDelayMs: 1,
    })
    assert.strictEqual(result.toolCalls, true)
    assert.strictEqual(call, 3)
  })
})
