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
