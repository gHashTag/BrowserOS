/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A person moves ONE card: "not doing this" and "take it back".
 *
 * WHY THIS IS NOT A BOARD-ONLY OVERRIDE. The board computes a card's column
 * (registry task, then the dispatch verdict, then the open issue), and the
 * round takes its candidates from every open issue (queen-tick.ts, the
 * `open.map` branch). A drop that only the board read would draw a card in
 * DROPPED while the next round handed it to a bee - a board saying one thing
 * about work the Queen does another way. So a drop is a row both read: the
 * board draws it, and the round leaves the issue out of its candidates.
 *
 * WHY ONLY TWO TARGETS. Running and review are a dispatch, blocked is a held
 * boundary, done is her acceptance - none of them is a person's to set. A
 * person may say "not doing" (backlog or blocked -> dropped) and take back
 * their own drop (dropped -> backlog). A card dropped by her verdict on a
 * bee's attempt is hers: only her next round moves it.
 *
 * WHY THE CALLER SAYS WHERE THE CARD WAS. The person tapped a card they saw
 * in one column; if it moved since (a bee took it), the tap is about a board
 * that no longer exists. `from` must equal the column now, or nothing moves
 * and the answer says where the card is. Every refusal carries a reason a
 * person can read - the contract is the t27 spec kanban-card-chat.t27 v4
 * (MOVE_DOOR_ONE_CARD, MOVE_SAYS_FROM, MOVE_ANSWER_HAS_REASON).
 *
 * `PUT /queen/registry` is not this door: it replaces every task at once, and
 * a sheet using it to move one card would race every other writer.
 */

/** The columns a person may ask for. */
export const MOVE_TARGETS = ['backlog', 'dropped'] as const
export type MoveTarget = (typeof MOVE_TARGETS)[number]

/** Columns a person's "not doing" may start from. */
const DROPPABLE_FROM = new Set(['backlog', 'blocked'])

/** How long a reason may be: one sentence on a card, not an essay. */
export const MOVE_REASON_MAX = 200

/** A person's drop, as stored in `queen_card_move`. */
export interface CardMove {
  number: number
  fromColumn: string
  reason: string
  movedBy: string
  movedAt: string
}

/** The smallest card this file needs from the board. */
export interface MovableCard {
  number: number
  column: string
  detail?: string
}

export interface MoveRequest {
  number: number
  from: string
  to: string
}

export type MoveDecision =
  | { ok: true; action: 'drop' | 'undrop' }
  | { ok: false; status: 400 | 404 | 409; reason: string }

export function isMoveTarget(value: string): value is MoveTarget {
  return (MOVE_TARGETS as readonly string[]).includes(value)
}

/**
 * Whether one card may move, decided against the board as it is NOW.
 *
 * Pure, so every refusal is pinned by a test without a database.
 */
export function decideMove(
  request: MoveRequest,
  card: MovableCard | undefined,
  personDropped: boolean,
): MoveDecision {
  if (!isMoveTarget(request.to)) {
    return {
      ok: false,
      status: 400,
      reason:
        'a person may ask only for backlog or dropped: running and review ' +
        'are a dispatch, blocked is a held boundary, done is her acceptance',
    }
  }
  if (!card) {
    return {
      ok: false,
      status: 404,
      reason: `#${request.number} is not on the board`,
    }
  }
  if (request.from !== card.column) {
    return {
      ok: false,
      status: 409,
      reason: `#${card.number} is in ${card.column} now, not ${request.from}`,
    }
  }
  if (request.to === card.column) {
    return {
      ok: false,
      status: 409,
      reason: `#${card.number} is already in ${card.column}`,
    }
  }
  if (request.to === 'dropped') {
    if (!DROPPABLE_FROM.has(card.column)) {
      return {
        ok: false,
        status: 409,
        reason:
          `#${card.number} is in ${card.column}: a bee or her verdict has it, ` +
          'and only backlog or blocked work can be dropped by a person',
      }
    }
    return { ok: true, action: 'drop' }
  }
  // to === 'backlog'
  if (card.column !== 'dropped' || !personDropped) {
    return {
      ok: false,
      status: 409,
      reason:
        `#${card.number} was dropped by her verdict on a bee's attempt, not ` +
        'by a person: only her next round moves it',
    }
  }
  return { ok: true, action: 'undrop' }
}

/**
 * Draw people's drops on a computed board.
 *
 * A drop applies only while the card is still free work (backlog or
 * blocked). If a bee is on it or she has judged it, that is the newer fact and
 * it stands - the round never starts a dropped issue, so this happens only for
 * work that was already in flight when the drop was written.
 */
export function applyCardMoves<C extends MovableCard>(
  cards: C[],
  moves: CardMove[],
): C[] {
  if (moves.length === 0) return cards
  const byNumber = new Map(moves.map((m) => [m.number, m]))
  return cards.map((card) => {
    const move = byNumber.get(card.number)
    if (!move || !DROPPABLE_FROM.has(card.column)) return card
    const why = move.reason ? ` - ${move.reason}` : ''
    return { ...card, column: 'dropped', detail: `dropped by a person${why}` }
  })
}

interface QueryResult {
  rowCount: number | null
  rows: Array<Record<string, unknown>>
}

interface Queryable {
  query(sql: string, values?: unknown[]): Promise<QueryResult>
}

export const READ_CARD_MOVES_SQL =
  'SELECT number, from_column, reason, moved_by, moved_at FROM queen_card_move WHERE repo = $1'

/** Every person's drop in one repository, as rows -> moves. */
export async function readCardMoves(
  pool: Queryable,
  repo: string,
): Promise<CardMove[]> {
  const result = await pool.query(READ_CARD_MOVES_SQL, [repo])
  return result.rows.map((row) => ({
    number: Number(row.number),
    fromColumn: String(row.from_column ?? ''),
    reason: String(row.reason ?? ''),
    movedBy: String(row.moved_by ?? ''),
    movedAt:
      row.moved_at == null
        ? ''
        : new Date(row.moved_at as string | number | Date).toISOString(),
  }))
}

/** The issue numbers a round must not hand to a bee. */
export async function droppedByPeople(
  pool: Queryable,
  repo: string,
): Promise<Set<number>> {
  const moves = await readCardMoves(pool, repo)
  return new Set(moves.map((m) => m.number))
}

/** Leave people's drops out of a round's candidates. */
export function withoutDropped(
  candidates: number[],
  dropped: Set<number>,
): number[] {
  return dropped.size === 0
    ? candidates
    : candidates.filter((n) => !dropped.has(n))
}

/**
 * Write one decided move. Conditional, so two taps racing each other cannot
 * both win: the second finds the row already written (or already gone) and
 * is told so instead of being told it moved.
 */
export async function writeCardMove(
  pool: Queryable,
  action: 'drop' | 'undrop',
  move: {
    repo: string
    number: number
    fromColumn: string
    reason: string
    by: string
  },
): Promise<boolean> {
  if (action === 'drop') {
    const result = await pool.query(
      `INSERT INTO queen_card_move (repo, number, from_column, reason, moved_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (repo, number) DO NOTHING`,
      [move.repo, move.number, move.fromColumn, move.reason, move.by],
    )
    return (result.rowCount ?? 0) > 0
  }
  const result = await pool.query(
    'DELETE FROM queen_card_move WHERE repo = $1 AND number = $2',
    [move.repo, move.number],
  )
  return (result.rowCount ?? 0) > 0
}
