/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * /queen/tasks: a person cancels or assigns a task through the control card's
 * section 3 (gHashTag/t27#6657). Every seam is the route's own dependency
 * list, so these tests read what the route DECIDED, not how SQL spells it;
 * the statements themselves are exercised against Postgres in
 * tests/pglive/queen-control-live.test.ts.
 */

import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import {
  createQueenTasksRoute,
  type QueenTasksDeps,
} from '../../src/api/routes/queen-tasks'
import type { CancelResult } from '../../src/api/services/queen-control'
import {
  abortBeeHere,
  clearBeeRunningHere,
  markBeeRunningHere,
} from '../../src/api/services/queen-dispatch'

const pool = {} as Pool

function route(over: Partial<QueenTasksDeps> = {}) {
  const published: Array<[string, Record<string, unknown>]> = []
  const assigned: Array<[number, string]> = []
  const aborted: Array<[number, string | undefined]> = []
  const app = createQueenTasksRoute({
    pool: () => pool,
    ensureTables: async () => {},
    publishEvent: async (_pool, name, payload) => {
      published.push([name, payload])
      return published.length
    },
    requestAssign: async (_pool, issue, by) => {
      assigned.push([issue, by])
    },
    pendingAssigns: async () => assigned.map(([issue]) => issue),
    taskLeasedLive: async () => false,
    abortBeeHere: (issue, conversationId) => {
      aborted.push([issue, conversationId])
      return true
    },
    ...over,
  })
  return { app, published, assigned, aborted }
}

const post = (body: unknown = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

describe('cancel', () => {
  it('ends a running task, interrupts it here and wakes the Queen', async () => {
    const asked: Array<[number, string, string]> = []
    const { app, published, aborted } = route({
      cancelTask: async (_pool, issue, by, reason): Promise<CancelResult> => {
        asked.push([issue, by, reason])
        return {
          status: 'cancelled',
          wasRunning: true,
          conversationId: 'conv-1',
          fence: 8,
        }
      },
    })
    const res = await app.request(
      '/4242/cancel',
      post({ by: 'owner', reason: 'wrong issue' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      issue: 4242,
      cancelled: true,
      wasRunning: true,
      interruptedHere: true,
      fence: 8,
    })
    expect(asked).toEqual([[4242, 'owner', 'wrong issue']])
    expect(aborted).toEqual([[4242, 'conv-1']])
    expect(published).toEqual([
      ['queen/task.cancel', { issue: 4242, by: 'owner' }],
    ])
  })

  it('does not interrupt a task that had already finished', async () => {
    const { app, aborted, published } = route({
      cancelTask: async () => ({
        status: 'cancelled',
        wasRunning: false,
        conversationId: 'conv-2',
        fence: null,
      }),
    })
    const res = await app.request('/7/cancel', post())
    expect(res.status).toBe(200)
    expect((await res.json()).interruptedHere).toBe(false)
    expect(aborted).toEqual([])
    expect(published.length).toBe(1)
  })

  it('refuses to cancel an accept', async () => {
    const { app, published } = route({
      cancelTask: async () => ({ status: 'accepted' }),
    })
    const res = await app.request('/7/cancel', post())
    expect(res.status).toBe(409)
    expect((await res.json()).cancelled).toBe(false)
    expect(published).toEqual([])
  })

  it('answers 404 for an issue the Queen never dispatched', async () => {
    const { app } = route({ cancelTask: async () => ({ status: 'none' }) })
    expect((await app.request('/7/cancel', post())).status).toBe(404)
  })

  it('refuses a path that is not an issue number', async () => {
    const { app } = route()
    for (const bad of ['abc', '0', '-1', '1e3', '12345678901']) {
      expect((await app.request(`/${bad}/cancel`, post())).status).toBe(400)
    }
  })

  it('answers 503 with no database', async () => {
    const { app } = route({ pool: () => null })
    expect((await app.request('/7/cancel', post())).status).toBe(503)
  })
})

describe('assign', () => {
  it('queues the assignment and wakes the Queen', async () => {
    const { app, assigned, published } = route()
    const res = await app.request('/55/assign', post({ by: 'owner' }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ issue: 55, answer: 'ok', queued: true })
    expect(assigned).toEqual([[55, 'owner']])
    expect(published).toEqual([
      ['queen/task.assign', { issue: 55, by: 'owner' }],
    ])
  })

  it('will not take a task from under a live lease', async () => {
    const { app, assigned, published } = route({
      taskLeasedLive: async () => true,
    })
    const res = await app.request('/55/assign', post())
    expect(res.status).toBe(409)
    expect((await res.json()).answer).toBe('held')
    expect(assigned).toEqual([])
    expect(published).toEqual([])
  })

  it('names an anonymous caller and strips control characters', async () => {
    const { app, assigned } = route()
    await app.request('/1/assign', post())
    await app.request('/2/assign', post({ by: 'a\u0000b\nc' }))
    expect(assigned).toEqual([
      [1, 'operator'],
      [2, 'a b c'],
    ])
  })

  it('lists what is still waiting', async () => {
    const { app } = route()
    await app.request('/3/assign', post())
    const res = await app.request('/assigned')
    expect(await res.json()).toEqual({ assigned: [3] })
  })
})

describe('a running turn is stopped only by the process that streams it', () => {
  it('aborts the attempt it was asked about, once', () => {
    let calls = 0
    markBeeRunningHere(9001, 'conv-a', () => {
      calls += 1
    })
    expect(abortBeeHere(9001, 'conv-other')).toBe(false)
    expect(abortBeeHere(9001, 'conv-a')).toBe(true)
    expect(abortBeeHere(9001, 'conv-a')).toBe(false)
    expect(calls).toBe(1)
    clearBeeRunningHere(9001, 'conv-a')
  })

  it('forgets the turn once it closed', () => {
    let calls = 0
    markBeeRunningHere(9002, 'conv-b', () => {
      calls += 1
    })
    clearBeeRunningHere(9002, 'conv-b')
    expect(abortBeeHere(9002)).toBe(false)
    expect(calls).toBe(0)
  })

  it('keeps the newer attempt when an older one closes late', () => {
    let newer = 0
    markBeeRunningHere(9003, 'conv-new', () => {
      newer += 1
    })
    clearBeeRunningHere(9003, 'conv-old')
    expect(abortBeeHere(9003)).toBe(true)
    expect(newer).toBe(1)
    clearBeeRunningHere(9003, 'conv-new')
  })
})
