/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * One task, opened, as anyone may read it (gHashTag/t27 specs/queen/dashboard.t27
 * section 2; queen-task-drawer.ts says what is public and why). The board's
 * drawer reads it when a card is opened.
 *
 * `?issue=7804` for an issue of the Queen's repository, `?job=12` for a job.
 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import { loadControlSpec } from '../services/queen-control'
import {
  buildTaskDrawer,
  parseDrawerRef,
  type TaskDrawer,
} from '../services/queen-task-drawer'

export const DRAWER_CACHE_MS = 3_000

let pool: Pool | null = null
const cache = new Map<string, { at: number; drawer: TaskDrawer }>()

export function createQueenPublicTaskRoute() {
  return new Hono().get('/', async (c) => {
    const url = process.env.DATABASE_URL
    if (!url) return c.json({ error: 'No database configured' }, 503)
    const ref = parseDrawerRef(c.req.query())
    if (!ref) return c.json({ error: 'Name a task: ?issue=N or ?job=N' }, 400)
    const key = JSON.stringify(ref)
    const headers = { 'Cache-Control': 'public, max-age=3' }
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < DRAWER_CACHE_MS)
      return c.json(hit.drawer, 200, headers)
    try {
      pool ??= createQueenPool(url)
      const repo = process.env.TRIOS_GITHUB_REPO || 'gHashTag/t27'
      const names = (await loadControlSpec()).eventNames
      const drawer = await buildTaskDrawer(pool, ref, repo, names)
      if (cache.size > 256) cache.clear()
      cache.set(key, { at: Date.now(), drawer })
      return c.json(drawer, 200, headers)
    } catch (error) {
      logger.warn('Queen public task could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'The task is unavailable' }, 503)
    }
  })
}
