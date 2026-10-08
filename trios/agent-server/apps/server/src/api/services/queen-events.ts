/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE EVENT LOG AS A BUS (gHashTag/t27 specs/queen/events.t27, epic t27#7718
 * slice 3).
 *
 * WHY. Measured 2026-10-08: the log numbered events MAX(seq)+1, so two writers
 * at once got one number and the second event was dropped with its error;
 * five of the ten kinds were never written; nothing read the log back, so a
 * runner's task.ended woke nobody; and the board and the game redrew whole
 * snapshots because nobody could ask what changed.
 *
 * WHAT DECIDES. The card, as generated wasm: log_due (what is written),
 * token_ok (what is public), cursor_read and delta_action (how a reader
 * reads), page_size and wait_seconds (how much and how long), wakes_here and
 * runner_claims_now (who reacts), prune_through (what is kept). This file
 * carries rows in and out.
 */

import type { Pool } from 'pg'
import { logger } from '../../lib/logger'
import { flag, loadCardWasm, u32, u64 } from './queen-card-wasm'
import {
  BUS_KINDS,
  CR_PAGE,
  CR_RESYNC,
  DA_APPLY,
  DA_SKIP,
  EVENTS_PAGE_MAX,
  FOLLOW_MS,
  KEEP_SECONDS,
  PUBLIC_KEYS,
} from './queen-events.gen'

export const EVENTS_CARD = 'queen/events.wasm'

const card = () => loadCardWasm(EVENTS_CARD)
export const logDue = (
  kind: number,
  seenBefore: boolean,
  secondsSince: number,
): boolean =>
  card().call('log_due', kind, flag(seenBefore), u32(secondsSince)) !== 0
export const tokenOk = (text: string): boolean => {
  const [b] = card().put(text)
  return card().call('token_ok', b.at, b.len) !== 0
}
export const cursorRead = (cursor: number, oldest: number, newest: number) =>
  Number(card().call64('cursor_read', u64(cursor), u64(oldest), u64(newest)))
export const deltaAction = (cursor: number, seq: number): number =>
  Number(card().call64('delta_action', u64(cursor), u64(seq)))
export const pageSize = (asked: number): number =>
  card().call('page_size', u32(asked))
export const waitSeconds = (asked: number): number =>
  card().call('wait_seconds', u32(asked))
export const wakesHere = (
  wakes: boolean,
  kind: number,
  publishedHere: boolean,
): boolean =>
  card().call('wakes_here', flag(wakes), kind, flag(publishedHere)) !== 0
export const runnerClaimsNow = (kind: number, freeSlots: number): boolean =>
  card().call('runner_claims_now', kind, u32(freeSlots)) !== 0
export const pruneThrough = (newest: number): number =>
  Number(card().call64('prune_through', u64(newest)))

/** One row of the log. */
export interface LoggedEvent {
  stream: string
  seq: number
  kind: number
  payload: Record<string, unknown>
  origin: string | null
  at: string
}

const rowOf = (stream: string, r: Record<string, unknown>): LoggedEvent => ({
  stream,
  seq: Number(r.seq),
  kind: Number(r.kind),
  payload:
    r.payload && typeof r.payload === 'object'
      ? (r.payload as Record<string, unknown>)
      : {},
  origin: typeof r.origin === 'string' ? r.origin : null,
  at:
    r.recorded_at instanceof Date
      ? r.recorded_at.toISOString()
      : String(r.recorded_at ?? ''),
})

/** The oldest and newest number the log keeps on a stream; both 0 when empty. */
export async function logBounds(
  pool: Pool,
  stream: string,
): Promise<{ oldest: number; newest: number }> {
  const r = await pool.query(
    `SELECT COALESCE(MIN(seq), 0) AS oldest, COALESCE(MAX(seq), 0) AS newest
       FROM queen_event_log WHERE stream = $1`,
    [stream],
  )
  return {
    oldest: Number(r.rows[0]?.oldest ?? 0),
    newest: Number(r.rows[0]?.newest ?? 0),
  }
}

/** Events past `after`, in order, at most `limit`. */
export async function readAfter(
  pool: Pool,
  stream: string,
  after: number,
  limit: number,
): Promise<LoggedEvent[]> {
  const r = await pool.query(
    `SELECT seq, kind, payload, origin, recorded_at FROM queen_event_log
      WHERE stream = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [stream, after, limit],
  )
  return r.rows.map((row) => rowOf(stream, row))
}

/**
 * One process reading the log past its own cursor: every FOLLOW_MS, and at
 * once when poked (publishEvent pokes the follower of its own process). Each
 * row is delivered once, in order, with whether this process wrote it.
 *
 * It starts at the newest row, not the oldest: a process that starts has
 * nothing to react to in the past, and the Queen's first round reconciles.
 */
export class LogFollower {
  private cursor = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private reading = false
  private again = false

  constructor(
    private readonly pool: Pool,
    private readonly stream: string,
    private readonly me: string,
    private readonly deliver: (event: LoggedEvent, here: boolean) => void,
  ) {}

  async start(everyMs: number = FOLLOW_MS): Promise<void> {
    this.cursor = (await logBounds(this.pool, this.stream)).newest
    this.timer = setInterval(() => this.poke(), everyMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Read now; a poke during a read asks for one more read after it. */
  poke(): void {
    if (this.reading) {
      this.again = true
      return
    }
    this.reading = true
    void this.read()
      .catch((error) =>
        logger.warn('Queen event follower could not read the log', {
          stream: this.stream,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        this.reading = false
        if (this.again) {
          this.again = false
          this.poke()
        }
      })
  }

  /** The cursor, for a test and for the status line. */
  position(): number {
    return this.cursor
  }

  async read(): Promise<void> {
    const rows = await readAfter(
      this.pool,
      this.stream,
      this.cursor,
      EVENTS_PAGE_MAX,
    )
    for (const event of rows) {
      const action = deltaAction(this.cursor, event.seq)
      if (action === DA_SKIP) continue
      if (action !== DA_APPLY)
        // The log is gapless, so a gap is rows pruned under the reader or a
        // writer from before the bus during a deploy. The reconciliation
        // round repairs what they would have caused; say so and go on.
        logger.warn('Queen event follower found a gap in the log', {
          stream: this.stream,
          from: this.cursor + 1,
          to: event.seq - 1,
        })
      this.cursor = event.seq
      try {
        this.deliver(event, event.origin === this.me)
      } catch (error) {
        logger.warn('Queen event follower: a reader failed', {
          seq: event.seq,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (rows.length === EVENTS_PAGE_MAX) this.again = true
  }
}

/**
 * The public projection of a payload: the card's PUBLIC_KEYS only, a number
 * or a boolean as it is, a string only when token_ok passes it.
 */
export function publicPayload(
  payload: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const key of PUBLIC_KEYS as readonly string[]) {
    const v = payload[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    else if (typeof v === 'boolean') out[key] = v
    else if (typeof v === 'string' && tokenOk(v)) out[key] = v
  }
  return out
}

export interface PublicEvent {
  seq: number
  /** control.t27 EV_* - what a board's board_action reads. */
  kind: number
  name: string
  at: string
  task: string | null
  [field: string]: string | number | boolean | null
}

export interface EventsPage {
  cursor: number
  oldest: number
  newest: number
  resync: boolean
  events: PublicEvent[]
}

/**
 * One public read past `after`. With no `after`, the answer is the cursor to
 * start from and no events. RESYNC tells the reader to take a snapshot.
 */
export async function publicEventsPage(
  pool: Pool,
  stream: string,
  after: number | null,
  asked: number,
  names: readonly string[],
  repo: string,
): Promise<EventsPage> {
  const { oldest, newest } = await logBounds(pool, stream)
  if (after === null)
    return { cursor: newest, oldest, newest, resync: false, events: [] }
  const read = cursorRead(after, oldest, newest)
  if (read === CR_RESYNC)
    return { cursor: newest, oldest, newest, resync: true, events: [] }
  if (read !== CR_PAGE)
    return { cursor: after, oldest, newest, resync: false, events: [] }
  const rows = await readAfter(pool, stream, after, pageSize(asked))
  const events = rows.map((e) => {
    const fields = publicPayload(e.payload)
    return {
      ...fields,
      seq: e.seq,
      kind: e.kind,
      name: names[e.kind] ?? 'unknown',
      at: e.at,
      task: typeof fields.issue === 'number' ? `${repo}#${fields.issue}` : null,
    }
  })
  return {
    cursor: rows.length > 0 ? rows[rows.length - 1].seq : after,
    oldest,
    newest,
    resync: false,
    events,
  }
}

/**
 * Resolves when the stream holds a row past `after`, or after `seconds`. One
 * shared check every FOLLOW_MS serves every waiting reader of a process.
 */
const waiters = new Set<{ stream: string; after: number; done: () => void }>()
let watching: ReturnType<typeof setInterval> | null = null

export function waitForNewer(
  pool: Pool,
  stream: string,
  after: number,
  seconds: number,
): Promise<void> {
  if (seconds <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const waiter = {
      stream,
      after,
      done: () => {
        clearTimeout(timeout)
        waiters.delete(waiter)
        resolve()
      },
    }
    const timeout = setTimeout(waiter.done, seconds * 1000)
    waiters.add(waiter)
    watching ??= setInterval(() => {
      if (waiters.size === 0) {
        if (watching) clearInterval(watching)
        watching = null
        return
      }
      const streams = [...new Set([...waiters].map((w) => w.stream))]
      void pool
        .query(
          `SELECT stream, MAX(seq) AS newest FROM queen_event_log
            WHERE stream = ANY($1) GROUP BY stream`,
          [streams],
        )
        .then((r) => {
          const newest = new Map(
            r.rows.map((row) => [String(row.stream), Number(row.newest)]),
          )
          for (const w of [...waiters])
            if ((newest.get(w.stream) ?? 0) > w.after) w.done()
        })
        .catch(() => {})
    }, FOLLOW_MS)
  })
}

/** Drop what the card no longer keeps. Returns the rows removed. */
export async function pruneEvents(pool: Pool, stream: string): Promise<number> {
  const { newest } = await logBounds(pool, stream)
  const through = pruneThrough(newest)
  if (through <= 0) return 0
  const r = await pool.query(
    `DELETE FROM queen_event_log
      WHERE stream = $1 AND seq <= $2
        AND recorded_at < now() - make_interval(secs => $3)`,
    [stream, through, KEEP_SECONDS],
  )
  return r.rowCount ?? 0
}

/** The card has a row for every kind control.t27 names, or the bus refuses to run. */
export function busKindsAgree(eventKinds: number): boolean {
  return eventKinds === BUS_KINDS
}
