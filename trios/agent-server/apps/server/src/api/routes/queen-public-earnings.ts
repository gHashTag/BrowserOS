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
import { parseOwners } from '../services/queen-leaderboard'
import { earningByWorkId, earningsLedger } from '../services/queen-tri-earnings'

const WORK_ID = /^[0-9a-f]{64}$/

export function createQueenPublicEarningsRoute() {
  return (
    new Hono()
      .get('/', async (c) => {
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
      // One earning and who it is credited to: what a TRI signer reads before
      // it signs for this work id. A malformed id is refused before any query.
      .get('/:workId', async (c) => {
        const workId = c.req.param('workId')
        if (!WORK_ID.test(workId))
          return c.json({ error: 'work id must be 64 lowercase hex' }, 400)
        const url = process.env.DATABASE_URL
        if (!url) return c.json({ error: 'No database configured' }, 503)
        const pool = createQueenPool(url, { max: 1 })
        try {
          const found = await earningByWorkId(
            pool,
            workId,
            parseOwners(process.env.TRIOS_KEY_OWNERS),
          )
          if (!found) return c.json({ error: 'No such earning' }, 404)
          return c.json(found, 200, { 'Cache-Control': 'public, max-age=60' })
        } catch (error) {
          logger.warn('Queen earning could not be read', {
            error: error instanceof Error ? error.message : String(error),
          })
          return c.json({ error: 'The earnings ledger is unavailable' }, 503)
        } finally {
          await pool.end().catch(() => {})
        }
      })
  )
}
