/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * POST /queen/move - a person moves ONE card.
 *
 *   { number, from, to: 'dropped' | 'backlog', reason?, by?, repo? }
 *
 * The rules are in services/queen-card-move.ts (decideMove); this file reads
 * the board as it is now, asks the rules, and writes one conditional row.
 * Every answer - moved or refused - carries a `reason` a person can read.
 *
 * Behind requireTrustedAppOrigin() like every other write here: a door that
 * takes an issue away from the swarm is not a public door.
 */

import { Hono } from 'hono'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import {
  decideMove,
  MOVE_REASON_MAX,
  readCardMoves,
  writeCardMove,
} from '../services/queen-card-move'
import { queenLeaseDatabaseUrl } from '../services/queen-lease'
import { boardRepo, build } from './queen-kanban'

type BoardPool = Parameters<typeof build>[0]

interface QueenCardMoveDeps {
  databaseUrl?: () => string | undefined
  createPool?: (url: string) => BoardPool
}

function refuse(status: 400 | 404 | 409 | 503, reason: string) {
  return { status, body: { moved: false, reason } }
}

interface ParsedMove {
  number: number
  from: string
  to: string
  reason: string
  by: string
}

/** The body, or the refusal a person can read - before any database read. */
export function parseMove(
  raw: unknown,
  repo: string,
): ParsedMove | ReturnType<typeof refuse> {
  const body = (raw ?? {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const number = Number(body.number)
  const from = text(body.from)
  const to = text(body.to)
  const reason = text(body.reason)
  if (!Number.isInteger(number) || number <= 0) {
    return refuse(400, 'number must be a positive issue number')
  }
  if (!from || !to) {
    return refuse(
      400,
      'from and to are both required: the column you saw, and the one you want',
    )
  }
  if (reason.length > MOVE_REASON_MAX) {
    return refuse(
      400,
      `a reason is one sentence, at most ${MOVE_REASON_MAX} characters`,
    )
  }
  if (typeof body.repo === 'string' && body.repo !== repo) {
    return refuse(409, `this board is ${repo}, not ${body.repo}`)
  }
  return { number, from, to, reason, by: text(body.by).slice(0, 80) }
}

export function createQueenCardMoveRoute(deps: QueenCardMoveDeps = {}) {
  const databaseUrl = deps.databaseUrl ?? queenLeaseDatabaseUrl
  const createPool =
    deps.createPool ?? ((url: string) => createQueenPool(url) as BoardPool)

  return new Hono().post('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const repo = boardRepo()
    const parsed = parseMove(await c.req.json().catch(() => null), repo)
    if ('status' in parsed) return c.json(parsed.body, parsed.status)
    const { number, from, to, reason, by } = parsed

    const url = databaseUrl()
    if (!url) return c.json(refuse(503, 'No database configured').body, 503)
    const pool = createPool(url)
    try {
      // The board and the drops are read fresh for every tap: the rule is
      // "the column you saw must be the column now", and a cached board would
      // agree with a tap about a card a bee took a minute ago.
      const [board, moves] = await Promise.all([
        build(pool),
        readCardMoves(pool, repo),
      ])
      const card = board.cards.find((x) => x.number === number)
      const personDropped = moves.some((m) => m.number === number)
      const decision = decideMove({ number, from, to }, card, personDropped)
      if (!decision.ok) {
        return c.json(
          { moved: false, reason: decision.reason, column: card?.column },
          decision.status,
        )
      }
      const wrote = await writeCardMove(pool, decision.action, {
        repo,
        number,
        fromColumn: from,
        reason,
        by,
      })
      if (!wrote) {
        return c.json(
          {
            moved: false,
            reason: `#${number} was moved by someone else a moment ago - look again`,
          },
          409,
        )
      }
      const said =
        decision.action === 'drop'
          ? `#${number} dropped: the Queen will not hand it to a bee${reason ? ` - ${reason}` : ''}`
          : `#${number} back in backlog: the next round may hand it to a bee`
      return c.json({ moved: true, number, from, to, reason: said })
    } catch (error) {
      // Same as the public board: pg's own words name hosts and relations, so
      // the caller gets a fixed sentence and the log keeps the diagnosis.
      logger.warn('Queen card move failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json(
        refuse(503, 'the board could not be read - nothing moved').body,
        503,
      )
    } finally {
      await pool.end()
    }
  })
}
