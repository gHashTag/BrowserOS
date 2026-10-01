/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A LANE THAT RUNS ON SOMEBODY ELSE'S MACHINE.
 *
 * Every bee runs on one provider key, and until now every key lived in the
 * operator's environment. The article that invites people to lend one
 * (how-to-join-the-swarm) also says why that is the wrong shape: OpenAI,
 * Anthropic and Google all forbid handing a key to a third party, and a key in
 * somebody else's container is a key handed over. The design that asks nobody
 * to breach anything is the one where the key never moves: the swarm hands out
 * the task, the bee runs on the lender's machine under the lender's account,
 * and the work comes back.
 *
 * This file is the registry half of that. A signed-in person mints a RUNNER
 * TOKEN in their cabinet; a runner process on their machine presents it. The
 * token authorises exactly one thing - speaking as that runner - and it is not
 * a provider key: nothing in this table can spend anybody's quota.
 *
 * WHAT IS STORED. The SHA-256 of the token and its last four characters, so the
 * cabinet can say "…a1b2" without being able to say the rest. The token itself
 * is shown once, in the answer that created it, and never again.
 *
 * WHICH LANE. A runner's lane is `RUNNER_KEY_BASE + id`. Every dispatch row
 * already records the lane it ran on as `key_index`, and the leaderboard sums
 * work by that column, so a runner that does work is credited by the same
 * arithmetic as an operator key - with a block of indices no operator pool can
 * reach (pools use `(pool - 1) * 10_000 + position`).
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

export const RUNNER_KEY_BASE = 100_000_000
/** A person may hold this many live runners; a revoked one does not count. */
export const MAX_RUNNERS_PER_PERSON = 5
/** A runner that heartbeated within this long is shown as online. */
export const RUNNER_ONLINE_MS = 3 * 60_000
export const LABEL_MAX = 40
const TOKEN_PREFIX = 'qr_'

export interface RunnerRow {
  id: number
  telegramId: string
  ownerName: string
  label: string
  tokenHint: string
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

/** What the cabinet shows. No hash, no telegram id. */
export interface RunnerView {
  id: number
  label: string
  lane: number
  tokenHint: string
  createdAt: string
  lastSeenAt: string | null
  state: 'never-seen' | 'online' | 'offline'
}

export const laneOf = (id: number) => RUNNER_KEY_BASE + id
export const isRunnerLane = (keyIndex: number) => keyIndex > RUNNER_KEY_BASE

export function hashRunnerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function mintRunnerToken(): {
  token: string
  hash: string
  hint: string
} {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  return { token, hash: hashRunnerToken(token), hint: token.slice(-4) }
}

/** `qr_` + 43 base64url characters, exactly as minted. */
export function looksLikeRunnerToken(value: string): boolean {
  return /^qr_[A-Za-z0-9_-]{43}$/.test(value)
}

/**
 * A label is a few words the person chooses ("my laptop"). Control characters
 * and markup-ish brackets are dropped rather than escaped: it is rendered as a
 * text node, and there is no reason for it to contain them at all.
 */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const label = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_MAX)
  return label || null
}

export function viewOf(row: RunnerRow, now = Date.now()): RunnerView {
  const seen = row.lastSeenAt ? Date.parse(row.lastSeenAt) : null
  return {
    id: row.id,
    label: row.label,
    lane: laneOf(row.id),
    tokenHint: row.tokenHint,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    state:
      seen === null
        ? 'never-seen'
        : now - seen <= RUNNER_ONLINE_MS
          ? 'online'
          : 'offline',
  }
}

const iso = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v.toISOString()
      : String(v)

function rowOf(r: Record<string, unknown>): RunnerRow {
  return {
    id: Number(r.id),
    telegramId: String(r.telegram_id),
    ownerName: String(r.owner_name),
    label: String(r.label),
    tokenHint: String(r.token_hint),
    createdAt: iso(r.created_at) ?? '',
    lastSeenAt: iso(r.last_seen_at),
    revokedAt: iso(r.revoked_at),
  }
}

type Queryable = Pick<Pool, 'query'>

export async function listRunners(
  pool: Queryable,
  telegramId: string,
): Promise<RunnerRow[]> {
  const { rows } = await pool.query(
    `SELECT id, telegram_id, owner_name, label, token_hint, created_at,
            last_seen_at, revoked_at
       FROM queen_runner
      WHERE telegram_id = $1 AND revoked_at IS NULL
      ORDER BY id`,
    [telegramId],
  )
  return rows.map(rowOf)
}

export type CreateRunnerResult =
  | { ok: true; runner: RunnerRow; token: string }
  | { ok: false; reason: 'limit' }

/**
 * One INSERT guarded by a count in the same statement, so two presses of
 * "create" racing each other cannot both slip under the limit by reading the
 * count before either wrote.
 */
export async function createRunner(
  pool: Queryable,
  person: { telegramId: string; name: string },
  label: string,
): Promise<CreateRunnerResult> {
  const minted = mintRunnerToken()
  const { rows } = await pool.query(
    `INSERT INTO queen_runner (telegram_id, owner_name, label, token_hash, token_hint)
     SELECT $1, $2, $3, $4, $5
      WHERE (SELECT count(*) FROM queen_runner
              WHERE telegram_id = $1 AND revoked_at IS NULL) < $6
     RETURNING id, telegram_id, owner_name, label, token_hint, created_at,
               last_seen_at, revoked_at`,
    [
      person.telegramId,
      person.name,
      label,
      minted.hash,
      minted.hint,
      MAX_RUNNERS_PER_PERSON,
    ],
  )
  if (rows.length === 0) return { ok: false, reason: 'limit' }
  return { ok: true, runner: rowOf(rows[0]), token: minted.token }
}

/** True when a live runner of this person was revoked by this call. */
export async function revokeRunner(
  pool: Queryable,
  telegramId: string,
  id: number,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE queen_runner SET revoked_at = now()
      WHERE id = $1 AND telegram_id = $2 AND revoked_at IS NULL`,
    [id, telegramId],
  )
  return (rowCount ?? 0) > 0
}

/**
 * The live runner a token names, touching its last-seen time. The lookup is by
 * the token's SHA-256: a caller cannot steer the bytes of a hash, so the
 * comparison leaks nothing a guess could use, and the token itself never
 * reaches the database.
 */
export async function heartbeatRunner(
  pool: Queryable,
  token: string,
): Promise<RunnerRow | null> {
  if (!looksLikeRunnerToken(token)) return null
  const { rows } = await pool.query(
    `UPDATE queen_runner SET last_seen_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING id, telegram_id, owner_name, label, token_hint, created_at,
               last_seen_at, revoked_at`,
    [hashRunnerToken(token)],
  )
  return rows[0] ? rowOf(rows[0]) : null
}

/**
 * Lane -> who it belongs to, for the leaderboard. Revoked runners are included:
 * the work a lane did stays its owner's after the token is withdrawn.
 *
 * `person` is the merge key, so every runner of one person adds up to one row,
 * and no runner can merge into an operator's row by choosing the same name.
 */
export async function runnerOwners(
  pool: Queryable,
): Promise<Record<number, { name: string; person: string }>> {
  const { rows } = await pool.query(
    `SELECT id, telegram_id, owner_name FROM queen_runner`,
  )
  const owners: Record<number, { name: string; person: string }> = {}
  for (const r of rows) {
    owners[laneOf(Number(r.id))] = {
      name: String(r.owner_name),
      person: String(r.telegram_id),
    }
  }
  return owners
}
