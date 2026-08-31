/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * What `POST /queen/lease/tick` must leave behind: a usable pool.
 *
 * The round hands its pool to a background reader that keeps writing the bee's
 * transcript for the whole model turn, long after this route has answered. The
 * route used to end that pool in a `finally`, and pg's own guard - "Cannot use
 * a pool after calling end on the pool" - then rejected every later write. Both
 * rejections are swallowed on the writing side, so nothing about the response
 * changed: the only observable difference is the state of the pool the round
 * was given, which is what this file asserts on.
 */

import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import type { Pool } from 'pg'

// Parseable, and refuses instantly. No test here reaches a database; the point
// is which ERROR a query comes back with, and "connection refused" is a
// different sentence from "pool already ended".
const UNREACHABLE = 'postgres://queen:none@127.0.0.1:1/queen'

const savedDatabaseUrl = process.env.DATABASE_URL
const savedSsotUrl = process.env.RAILWAY_SSOT_URL

const QUEEN_TICK = '../../../src/api/services/queen-tick'

// Captured before anything is mocked, and put back by hand afterwards.
// `mock.restore()` does NOT undo `mock.module` in bun 1.3: leaving the mock in
// place made a sibling file's real `startLeaseHeartbeat` test fail in a full
// suite run while passing on its own.
const realQueenTick = await import(QUEEN_TICK)

async function tickWithCapturedPool(): Promise<{
  status: number
  pool: Pool
}> {
  let captured: Pool | undefined
  mock.module(QUEEN_TICK, () => ({
    ...realQueenTick,
    runQueenTickOnce: async (pool: Pool) => {
      captured = pool
      // The pool must survive a round that dispatched, because that is the
      // round whose drain is still writing.
      return { ran: true, dispatch: { started: true } }
    },
  }))

  const { createQueenLeaseRoute } = await import(
    '../../../src/api/routes/queen-lease'
  )
  const response = await createQueenLeaseRoute().request('/tick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!captured) throw new Error('the round was never handed a pool')
  // An idle-client failure on an unreachable host would otherwise surface as an
  // unhandled emitter error and fail an unrelated test.
  captured.on('error', () => {})
  return { status: response.status, pool: captured }
}

describe('POST /queen/lease/tick', () => {
  afterEach(() => {
    mock.module(QUEEN_TICK, () => realQueenTick)
    mock.restore()
  })

  afterAll(() => {
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = savedDatabaseUrl
    if (savedSsotUrl === undefined) delete process.env.RAILWAY_SSOT_URL
    else process.env.RAILWAY_SSOT_URL = savedSsotUrl
  })

  it('leaves the round its pool after answering', async () => {
    process.env.DATABASE_URL = UNREACHABLE
    const { status, pool } = await tickWithCapturedPool()
    expect(status).toBe(200)

    // Stand in for the background drain: a write attempted after the response
    // has already gone out. It is expected to fail - there is no database - but
    // it must fail on the network, not on a pool this route closed.
    const message = await pool
      .query('SELECT 1')
      .then(() => '')
      .catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      )
    expect(message).not.toContain('after calling end')
  })

  it('reuses one pool across rounds rather than opening one per request', async () => {
    process.env.DATABASE_URL = UNREACHABLE
    const first = await tickWithCapturedPool()
    const second = await tickWithCapturedPool()
    expect(second.pool).toBe(first.pool)
  })

  it('refuses without a database rather than opening a pool on nothing', async () => {
    delete process.env.DATABASE_URL
    delete process.env.RAILWAY_SSOT_URL
    const { createQueenLeaseRoute } = await import(
      '../../../src/api/routes/queen-lease'
    )
    const response = await createQueenLeaseRoute().request('/tick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(503)
  })
})
