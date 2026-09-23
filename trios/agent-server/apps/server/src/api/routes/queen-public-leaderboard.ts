/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * WHO LENT THE SWARM A LANE, AND WHAT IT DID.
 *
 * Public, on the same terms as the board and the activity feed: it carries no
 * issue titles, no worker text and no credential - a lane's index, the work it
 * did, and the name the operator gave its lender (TRIOS_KEY_OWNERS). A lane
 * nobody claimed appears as `key #N`, because hiding it would make the swarm
 * look as if it ran on fewer keys than it did.
 *
 * The score is derived on every read from the dispatches themselves
 * (queen-leaderboard.ts). There is no XP column anywhere: a number nobody can
 * recompute is a number nobody can check, and this one is a sum over rows that
 * already exist.
 */
import { Hono } from 'hono'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import { leaderboard } from '../services/queen-leaderboard'

/** The window, in days. A month covers the swarm's memory of its own turns. */
const DEFAULT_DAYS = 30
const MAX_DAYS = 90

export function createQueenPublicLeaderboardRoute() {
  return new Hono().get('/', async (c) => {
    const asked = Number(c.req.query('days'))
    const days = Number.isFinite(asked)
      ? Math.min(MAX_DAYS, Math.max(1, Math.trunc(asked)))
      : DEFAULT_DAYS
    const url = process.env.DATABASE_URL
    if (!url) return c.json({ error: 'No database configured' }, 503)
    try {
      const board = await leaderboard(createQueenPool(url), days)
      return c.json(board, 200, { 'Cache-Control': 'public, max-age=60' })
    } catch (error) {
      // The failure answer is as public as the success answer, and says
      // nothing about the database beyond that it could not be read.
      logger.warn('Queen leaderboard could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'The leaderboard is unavailable' }, 503)
    }
  })
}
