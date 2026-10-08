/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * What happened since a cursor, as anyone may read it (gHashTag/t27
 * specs/queen/events.t27; queen-events.ts says what is public and why). The
 * board and the game take a snapshot from /queen/public-tasks, which carries
 * the cursor, and from then on read only this.
 *
 * `?after=<cursor>&limit=200&wait=25` - with nothing newer, the answer waits
 * up to `wait` seconds (the card's wait_seconds) for the next event. No
 * `after` answers the cursor to start from. `resync: true` means the events
 * right after the cursor are gone: take a snapshot.
 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import { loadControlSpec } from '../services/queen-control'
import {
  publicEventsPage,
  waitForNewer,
  waitSeconds,
} from '../services/queen-events'

let pool: Pool | null = null

const count = (v: string | undefined): number | null => {
  if (v === undefined || !/^\d{1,15}$/.test(v.trim())) return null
  return Number(v.trim())
}

export function createQueenPublicEventsRoute() {
  return new Hono().get('/', async (c) => {
    const url = process.env.DATABASE_URL
    if (!url) return c.json({ error: 'No database configured' }, 503)
    const after = count(c.req.query('after'))
    const limit = count(c.req.query('limit')) ?? 0
    const wait = waitSeconds(count(c.req.query('wait')) ?? 0)
    const headers = { 'Cache-Control': 'no-store' }
    try {
      pool ??= createQueenPool(url)
      const names = (await loadControlSpec()).eventNames
      const repo = process.env.TRIOS_GITHUB_REPO || 'gHashTag/t27'
      const read = () =>
        publicEventsPage(pool as Pool, 'queen', after, limit, names, repo)
      let page = await read()
      if (
        after !== null &&
        !page.resync &&
        page.events.length === 0 &&
        wait > 0
      ) {
        await waitForNewer(pool, 'queen', after, wait)
        page = await read()
      }
      return c.json(page, 200, headers)
    } catch (error) {
      logger.warn('Queen public events could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'The events are unavailable' }, 503)
    }
  })
}
