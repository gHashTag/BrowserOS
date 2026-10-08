/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * How the Queen is shaping issues that are not ready (gHashTag/t27
 * specs/queen/shaping.t27, t27#7714). It shows:
 * - how many open issues the last batch found ready or not;
 * - how many she shaped, how many authors she told, and how many she is
 *   still trying;
 * - her recent shapes with their boundary paths and notes.
 * The repository is public, so nothing here is not already on GitHub.
 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import { shapingStatus } from '../services/queen-shaper'

let pool: Pool | null = null

export function createQueenPublicShapingRoute() {
  return new Hono().get('/', async (c) => {
    const url = process.env.DATABASE_URL
    if (!url) return c.json({ error: 'No database configured' }, 503)
    try {
      pool ??= createQueenPool(url)
      return c.json(await shapingStatus(pool), 200, {
        'Cache-Control': 'public, max-age=15',
      })
    } catch (error) {
      logger.warn('Shaping status could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'The shaping status is unavailable' }, 503)
    }
  })
}
