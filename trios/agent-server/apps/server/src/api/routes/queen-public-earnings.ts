/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * WHAT ACCEPTED SPEC WORK HAS EARNED, AND WHAT WAS TAKEN BACK.
 *
 * Public on the same terms as the leaderboard, plus what an earning needs to
 * be checkable: the repository, issue number, judged commit and declared
 * `.t27` paths - all of them already public on GitHub - and the work id, which
 * anyone can recompute from those. It carries no issue title, no worker text,
 * no review note and no credential: a revocation says only which verdict
 * revoked it.
 *
 * Nothing here is withdrawable and the answer says so in its own body, since a
 * number on a page reads as money (queen-tri-earnings.ts).
 */
import { Hono } from 'hono'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import { earningsLedger } from '../services/queen-tri-earnings'

export function createQueenPublicEarningsRoute() {
  return new Hono().get('/', async (c) => {
    const url = process.env.DATABASE_URL
    if (!url) return c.json({ error: 'No database configured' }, 503)
    // One pool per request, closed when the answer is built, so a public
    // route that anyone can call cannot accumulate connections.
    const pool = createQueenPool(url, { max: 1 })
    try {
      const ledger = await earningsLedger(pool)
      return c.json(ledger, 200, { 'Cache-Control': 'public, max-age=60' })
    } catch (error) {
      logger.warn('Queen earnings could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'The earnings ledger is unavailable' }, 503)
    } finally {
      await pool.end().catch(() => {})
    }
  })
}
