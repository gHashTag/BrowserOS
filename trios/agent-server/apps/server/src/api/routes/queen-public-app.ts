/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The t27-bees app, as anyone may read it (gHashTag/t27 specs/queen/app.t27):
 * - whether it is configured (true or false, never a value);
 * - which repositories it skips;
 * - the public repositories it serves (a private one is counted, never named);
 * - its last week of reviews, and its recent reviews on public repositories.
 *
 * Every review it lists is a comment GitHub already shows to anyone who can see
 * that pull request.
 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import { appStatus } from '../services/queen-app'

let pool: Pool | null = null

export function createQueenPublicAppRoute() {
  return new Hono().get('/', async (c) => {
    const url = process.env.DATABASE_URL
    if (!url) return c.json({ error: 'No database configured' }, 503)
    try {
      pool ??= createQueenPool(url)
      return c.json(await appStatus(pool), 200, {
        'Cache-Control': 'public, max-age=15',
      })
    } catch (error) {
      logger.warn('t27-bees status could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'The app status is unavailable' }, 503)
    }
  })
}
