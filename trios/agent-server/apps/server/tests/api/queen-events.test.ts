/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE BUS (gHashTag/t27 specs/queen/events.t27, epic t27#7718 slice 3): the
 * card's functions as the wasm runs them, and the wiring around them. What
 * only Postgres can answer - two writers at once, the counter seed - is asked
 * of Postgres in tests/pglive/queen-events-live.test.ts.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  addControlEventReader,
  type ControlEvent,
  followControlEvents,
  publishEvent,
  setControlEventListener,
  stopFollowing,
} from '../../src/api/services/queen-control'
import {
  cursorRead,
  deltaAction,
  LogFollower,
  logDue,
  pageSize,
  pruneThrough,
  publicEventsPage,
  publicPayload,
  runnerClaimsNow,
  tokenOk,
  waitSeconds,
  wakesHere,
} from '../../src/api/services/queen-events'
import {
  CR_EMPTY,
  CR_PAGE,
  CR_RESYNC,
  DA_APPLY,
  DA_RESYNC,
  DA_SKIP,
  EVENTS_PAGE_DEFAULT,
  EVENTS_PAGE_MAX,
  KEEP_AT_LEAST,
  WAIT_MAX_SECONDS,
} from '../../src/api/services/queen-events.gen'
import { queenHolderName } from '../../src/api/services/queen-lease'
import { wakeOnControlEvents } from '../../src/api/services/queen-tick'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'

afterEach(() => {
  setControlEventListener(null)
  stopFollowing()
})

const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

describe('the vendored events card is the one PIN names', () => {
  it('events.t27 and events.wasm match', () => {
    const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
    expect(pin).toContain(`queen/events.t27 sha256 ${sha('queen/events.t27')}`)
    expect(pin).toContain(
      `queen/events.wasm sha256 ${sha('queen/events.wasm')}`,
    )
  })
})

describe('the card, as the wasm runs it', () => {
  // test evidence_is_thinned_and_heartbeats_are_not_logged
  it('writes every kind but the heartbeat, and evidence once a minute', () => {
    expect(logDue(0, true, 0)).toBe(true)
    expect(logDue(4, false, 0)).toBe(true)
    expect(logDue(4, true, 59)).toBe(false)
    expect(logDue(4, true, 60)).toBe(true)
    expect(logDue(8, false, 0)).toBe(false)
    expect(logDue(10, false, 0)).toBe(false)
  })

  // test a_token_is_short_and_plain
  it('passes a short plain token and nothing else', () => {
    expect(tokenOk('accepted')).toBe(true)
    expect(tokenOk('gHashTag/t27')).toBe(true)
    expect(tokenOk('')).toBe(false)
    expect(tokenOk('two words')).toBe(false)
    expect(tokenOk('a?b=c')).toBe(false)
    expect(tokenOk('ключ')).toBe(false)
    expect(tokenOk('a'.repeat(128))).toBe(true)
    expect(tokenOk('a'.repeat(129))).toBe(false)
  })

  // test a_cursor_reads_a_page_nothing_or_a_resync
  it('reads a page, nothing, or a resync', () => {
    expect(cursorRead(0, 0, 0)).toBe(CR_EMPTY)
    expect(cursorRead(4, 1, 5)).toBe(CR_PAGE)
    expect(cursorRead(9, 1, 5)).toBe(CR_RESYNC)
    expect(cursorRead(10, 12, 40)).toBe(CR_RESYNC)
    expect(cursorRead(11, 12, 40)).toBe(CR_PAGE)
  })

  // test a_reader_skips_applies_or_resyncs
  it('skips, applies or resyncs', () => {
    expect(deltaAction(5, 5)).toBe(DA_SKIP)
    expect(deltaAction(5, 6)).toBe(DA_APPLY)
    expect(deltaAction(5, 7)).toBe(DA_RESYNC)
    // past 2^32, where a u32 would have wrapped
    expect(deltaAction(2 ** 33, 2 ** 33 + 1)).toBe(DA_APPLY)
  })

  // test pages_and_waits_are_bounded
  it('bounds a page and a wait', () => {
    expect(pageSize(0)).toBe(EVENTS_PAGE_DEFAULT)
    expect(pageSize(EVENTS_PAGE_MAX + 1)).toBe(EVENTS_PAGE_MAX)
    expect(waitSeconds(3600)).toBe(WAIT_MAX_SECONDS)
    expect(waitSeconds(3)).toBe(3)
  })

  // test an_event_wakes_once / a_runner_claims_on_created_only / the_log_keeps_a_floor
  it('wakes once, claims on created, keeps a floor', () => {
    expect(wakesHere(true, 1, false)).toBe(true)
    expect(wakesHere(true, 1, true)).toBe(false)
    expect(wakesHere(true, 6, true)).toBe(true)
    expect(runnerClaimsNow(0, 1)).toBe(true)
    expect(runnerClaimsNow(0, 0)).toBe(false)
    expect(runnerClaimsNow(1, 4)).toBe(false)
    expect(pruneThrough(KEEP_AT_LEAST)).toBe(0)
    expect(pruneThrough(KEEP_AT_LEAST + 900)).toBe(900)
  })
})

describe('what anyone may read of a payload', () => {
  it('keeps the public keys with plain values and drops the rest', () => {
    expect(
      publicPayload({
        issue: 7789,
        outcome: 'accepted',
        verdict: 'needs a rewrite of section 2',
        repo: 'gHashTag/t27',
        slots: 4,
        branch: 'queen-7789',
        holder: 'replica:12',
        reason: 'token=abc',
      }),
    ).toEqual({
      issue: 7789,
      outcome: 'accepted',
      repo: 'gHashTag/t27',
      slots: 4,
    })
  })

  it('drops an object, an array and a number that is not finite', () => {
    expect(
      publicPayload({ issue: Number.NaN, outcome: { a: 1 }, verdict: ['x'] }),
    ).toEqual({})
  })
})

interface Row {
  seq: number
  kind: number
  payload: Record<string, unknown>
  origin: string | null
  recorded_at: Date
}

/** The log as a list: enough SQL to read past a cursor and to append. */
function logPool(rows: Row[] = []) {
  const calls: Array<{ sql: string; args: unknown[] }> = []
  const pool = {
    calls,
    rows,
    query: async (sql: string, args: unknown[] = []) => {
      calls.push({ sql, args })
      if (/MIN\(seq\)/.test(sql)) {
        const seqs = rows.map((r) => r.seq)
        return {
          rows: [
            {
              oldest: seqs.length ? Math.min(...seqs) : 0,
              newest: seqs.length ? Math.max(...seqs) : 0,
            },
          ],
        }
      }
      if (/WHERE stream = \$1 AND seq > \$2/.test(sql)) {
        const after = Number(args[1])
        const limit = Number(args[2])
        return {
          rows: rows
            .filter((r) => r.seq > after)
            .sort((a, b) => a.seq - b.seq)
            .slice(0, limit),
        }
      }
      if (/INSERT INTO queen_event_log/.test(sql)) {
        const seq = rows.length ? Math.max(...rows.map((r) => r.seq)) + 1 : 1
        rows.push({
          seq,
          kind: Number(args[1]),
          payload: JSON.parse(String(args[2])),
          origin: String(args[3]),
          recorded_at: new Date(),
        })
        return { rowCount: 1, rows: [{ seq }] }
      }
      return { rowCount: 0, rows: [] }
    },
  }
  return pool as typeof pool & Pool
}

const at = new Date('2026-10-08T12:00:00Z')

describe('publishing', () => {
  it('numbers from the counter row and writes who wrote it', async () => {
    const pool = logPool()
    expect(await publishEvent(pool, 'queen/task.cancel', { issue: 1 })).toBe(1)
    const insert = pool.calls.find((c) =>
      /INSERT INTO queen_event_log/.test(c.sql),
    )
    expect(insert?.sql).toMatch(/queen_event_counter/)
    expect(insert?.sql).not.toMatch(
      /SELECT \$1, COALESCE\(MAX\(seq\), 0\) \+ 1, \$2/,
    )
    expect(insert?.args[3]).toBe(queenHolderName())
  })

  it('writes no heartbeat at all', async () => {
    const pool = logPool()
    expect(
      await publishEvent(pool, 'queen/lease.heartbeat', { issue: 2 }),
    ).toBe(0)
    expect(pool.calls).toHaveLength(0)
  })

  it('writes one evidence row a minute per issue', async () => {
    const pool = logPool()
    await publishEvent(pool, 'queen/task.evidence', { issue: 90001 })
    await publishEvent(pool, 'queen/task.evidence', { issue: 90001 })
    await publishEvent(pool, 'queen/task.evidence', { issue: 90002 })
    expect(pool.rows.map((r) => r.payload.issue)).toEqual([90001, 90002])
  })

  it('retries a key collision with a writer from before the bus', async () => {
    let tries = 0
    const pool = {
      query: async () => {
        tries += 1
        if (tries === 1)
          throw Object.assign(new Error('duplicate key'), { code: '23505' })
        return { rowCount: 1, rows: [{ seq: 12 }] }
      },
    } as unknown as Pool
    expect(await publishEvent(pool, 'queen/task.assign', { issue: 3 })).toBe(12)
    expect(tries).toBe(2)
  })

  it('does not retry any other failure', async () => {
    const pool = {
      query: async () => {
        throw Object.assign(new Error('gone'), { code: '57P01' })
      },
    } as unknown as Pool
    await expect(
      publishEvent(pool, 'queen/task.assign', { issue: 3 }),
    ).rejects.toThrow('gone')
  })
})

describe('a follower reads every row once, in order', () => {
  it('starts at the newest row and delivers what comes after', async () => {
    const pool = logPool([
      { seq: 1, kind: 0, payload: {}, origin: 'x', recorded_at: at },
    ])
    const seen: Array<[number, boolean]> = []
    const f = new LogFollower(pool, 'queen', 'me', (e, here) =>
      seen.push([e.seq, here]),
    )
    await f.start(60_000)
    pool.rows.push(
      { seq: 2, kind: 1, payload: {}, origin: 'me', recorded_at: at },
      { seq: 3, kind: 1, payload: {}, origin: 'runner', recorded_at: at },
    )
    await f.read()
    await f.read()
    f.stop()
    expect(seen).toEqual([
      [2, true],
      [3, false],
    ])
    expect(f.position()).toBe(3)
  })

  it('goes on past a gap', async () => {
    const pool = logPool()
    const seen: number[] = []
    const f = new LogFollower(pool, 'queen', 'me', (e) => seen.push(e.seq))
    await f.start(60_000)
    pool.rows.push(
      { seq: 1, kind: 1, payload: {}, origin: null, recorded_at: at },
      { seq: 4, kind: 1, payload: {}, origin: null, recorded_at: at },
    )
    await f.read()
    f.stop()
    expect(seen).toEqual([1, 4])
  })

  it('keeps reading when a reader throws', async () => {
    const pool = logPool()
    const seen: number[] = []
    const f = new LogFollower(pool, 'queen', 'me', (e) => {
      seen.push(e.seq)
      throw new Error('reader down')
    })
    await f.start(60_000)
    pool.rows.push(
      { seq: 1, kind: 1, payload: {}, origin: null, recorded_at: at },
      { seq: 2, kind: 1, payload: {}, origin: null, recorded_at: at },
    )
    await f.read()
    f.stop()
    expect(seen).toEqual([1, 2])
  })
})

describe('the Queen wakes from the log', () => {
  const settle = () => new Promise((r) => setTimeout(r, 30))

  it("wakes for a runner's task.ended and not for her own", async () => {
    const pool = logPool()
    const asked: string[] = []
    wakeOnControlEvents((why) => asked.push(why))
    await followControlEvents(pool)
    // her own, through publishEvent: the publisher already reacted
    await publishEvent(pool, 'queen/task.ended', { issue: 1 })
    await settle()
    // a runner's, written by another process
    pool.rows.push({
      seq: pool.rows.length + 1,
      kind: 1,
      payload: { issue: 2 },
      origin: 'runner-2:7',
      recorded_at: at,
    })
    await publishEvent(pool, 'queen/task.cancel', { issue: 3 })
    await settle()
    expect(asked).toEqual([
      'event queen/task.ended #2',
      'event queen/task.cancel #3',
    ])
  })

  it('lets a runner take an order the moment one is created', async () => {
    const pool = logPool()
    const taken: number[] = []
    const stop = addControlEventReader(({ kind, seq }: ControlEvent) => {
      if (runnerClaimsNow(kind, 1)) taken.push(seq)
    })
    await followControlEvents(pool)
    await publishEvent(pool, 'queen/task.created', { issue: 5 })
    await publishEvent(pool, 'queen/task.reviewed', {
      issue: 5,
      verdict: 'accept',
    })
    await settle()
    stop()
    expect(taken).toEqual([1])
  })
})

describe('a public page past a cursor', () => {
  const names = [
    'queen/task.created',
    'queen/task.ended',
    'queen/worker.idle',
    'queen/lease.expired',
    'queen/task.evidence',
    'queen/task.reviewed',
    'queen/task.assign',
    'queen/task.cancel',
    'queen/lease.heartbeat',
    'queen/tick',
  ]
  const rows = (): Row[] => [
    {
      seq: 7,
      kind: 0,
      payload: { issue: 11, holder: 'r:1' },
      origin: 'a',
      recorded_at: at,
    },
    {
      seq: 8,
      kind: 5,
      payload: { issue: 11, verdict: 'accept' },
      origin: 'a',
      recorded_at: at,
    },
    { seq: 9, kind: 9, payload: {}, origin: 'a', recorded_at: at },
  ]

  it('answers the cursor to start from when asked with none', async () => {
    const page = await publicEventsPage(
      logPool(rows()),
      'queen',
      null,
      0,
      names,
      'o/r',
    )
    expect(page).toMatchObject({
      cursor: 9,
      oldest: 7,
      newest: 9,
      resync: false,
      events: [],
    })
  })

  it('pages the events with their public fields and task', async () => {
    const page = await publicEventsPage(
      logPool(rows()),
      'queen',
      7,
      0,
      names,
      'o/r',
    )
    expect(page.cursor).toBe(9)
    expect(page.events).toEqual([
      {
        seq: 8,
        name: 'queen/task.reviewed',
        at: at.toISOString(),
        task: 'o/r#11',
        issue: 11,
        verdict: 'accept',
      },
      { seq: 9, name: 'queen/tick', at: at.toISOString(), task: null },
    ])
  })

  it('tells a reader whose events were pruned to resync', async () => {
    const page = await publicEventsPage(
      logPool(rows()),
      'queen',
      3,
      0,
      names,
      'o/r',
    )
    expect(page).toMatchObject({ resync: true, cursor: 9, events: [] })
  })

  it('answers nothing new with the same cursor', async () => {
    const page = await publicEventsPage(
      logPool(rows()),
      'queen',
      9,
      0,
      names,
      'o/r',
    )
    expect(page).toMatchObject({ resync: false, cursor: 9, events: [] })
  })
})
