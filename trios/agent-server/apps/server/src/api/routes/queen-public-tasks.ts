/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Every task and the bees on them, as anyone may read them (gHashTag/t27
 * specs/queen/tasks.t27; queen-tasks-view.ts says what is public and why).
 * The board at app.t27.ai/game/kanban filters it, and the game draws its bees
 * over the issues they work on.
 *
 * `?kind=issue,review,job&state=running,review&repo=owner/name&q=text&limit=500`
 * filters with the card's task_matches, plus repository and text. One answer per
 * query is kept for a few seconds, because the board and the game both poll it.
 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import {
  buildTasksView,
  parseTasksQuery,
  type TasksView,
} from '../services/queen-tasks-view'

export const TASKS_CACHE_MS = 3_000

let pool: Pool | null = null
const cache = new Map<string, { at: number; view: TasksView }>()

export function createQueenPublicTasksRoute() {
  return new Hono().get('/', async (c) => {
    const url = process.env.DATABASE_URL
    if (!url) return c.json({ error: 'No database configured' }, 503)
    const query = parseTasksQuery(c.req.query())
    const key = JSON.stringify(query)
    const hit = cache.get(key)
    const headers = { 'Cache-Control': 'public, max-age=3' }
    if (hit && Date.now() - hit.at < TASKS_CACHE_MS)
      return c.json(hit.view, 200, headers)
    try {
      pool ??= createQueenPool(url)
      const repo = process.env.TRIOS_GITHUB_REPO || 'gHashTag/t27'
      const view = await buildTasksView(pool, query, repo)
      if (cache.size > 64) cache.clear()
      cache.set(key, { at: Date.now(), view })
      return c.json(view, 200, headers)
    } catch (error) {
      logger.warn('Queen public tasks could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'The tasks are unavailable' }, 503)
    }
  })
}
