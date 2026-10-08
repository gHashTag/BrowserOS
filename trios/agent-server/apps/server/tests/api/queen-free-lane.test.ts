/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A side job's model call takes a lane no bee holds (queen-free-lane.ts).
 * Measured 2026-10-08: the shaper always took the first lane, queued behind
 * the bees on a two-request z.ai key, and timed out.
 */

import { describe, expect, it } from 'bun:test'
import type { WorkerProvider } from '../../src/api/services/queen-dispatch'
import { freeLaneLlm } from '../../src/api/services/queen-free-lane'

const lane = (keyIndex: number, laneIndex = 0): WorkerProvider =>
  ({
    provider: 'zai',
    model: 'glm',
    baseUrl: 'https://api.z.ai',
    keyIndex,
    laneIndex,
    poolNumber: 1,
  }) as WorkerProvider

describe('a side job takes a free lane', () => {
  it('asks for lanes without the keys running bees hold', async () => {
    let asked: number[] = []
    const llm = freeLaneLlm({} as never, {
      taken: async () => [0, 1],
      candidates: (taken) => {
        asked = taken
        return [lane(2)]
      },
      call: async () => ({ ok: true, text: 'shaped' }),
    })
    expect(await llm('s', 'm')).toEqual({
      ok: true,
      text: 'shaped',
      model: 'zai/glm',
    })
    expect(asked).toEqual([0, 1])
  })
  it('tries the next lane on "not now", each lane once, and stops on a real failure', async () => {
    const called: number[] = []
    const llm = freeLaneLlm(null, {
      candidates: () => [lane(3), lane(4, 1), lane(5, 2), lane(6, 3)],
      call: async (l) => {
        called.push(l.keyIndex as number)
        return { ok: false, error: '1302 busy', transient: true }
      },
    })
    expect(await llm('s', 'm')).toEqual({
      ok: false,
      error: '1302 busy',
      transient: true,
    })
    expect(called).toEqual([3, 4, 5])
    const hard = freeLaneLlm(null, {
      candidates: () => [lane(3), lane(4, 1)],
      call: async () => ({ ok: false, error: '401 bad key', transient: false }),
    })
    expect(await hard('s', 'm')).toEqual({
      ok: false,
      error: '401 bad key',
      transient: false,
    })
  })
  it('says not now when no lane is free', async () => {
    const llm = freeLaneLlm(null, {
      candidates: () => [],
      call: async () => ({ ok: true, text: 'x' }),
    })
    expect(await llm('s', 'm')).toEqual({
      ok: false,
      error: 'no reviewer lane is free',
      transient: true,
    })
  })
})
