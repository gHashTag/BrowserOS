/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * GET /queen/public-credits - for each accepted issue, the GitHub login of the
 * person whose lane carried it (queen-lane-credits.ts). Read by the
 * spec-authors board in gHashTag/trinity.
 */
import { Hono } from 'hono'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import { laneCredits } from '../services/queen-lane-credits'

export function createQueenPublicCreditsRoute() {
  return new Hono().get('/', async (c) => {
    const url = process.env.DATABASE_URL
    if (!url) return c.json({ error: 'No database configured' }, 503)
    try {
      const body = await laneCredits(createQueenPool(url))
      return c.json(body, 200, { 'Cache-Control': 'public, max-age=300' })
    } catch (error) {
      logger.warn('Queen lane credits could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'The lane credits are unavailable' }, 503)
    }
  })
}
