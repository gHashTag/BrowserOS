/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The Queen's delegation registry, mirrored into Postgres.
 *
 * A mirror, not the record. The registry is a JSON file on the operator's Mac
 * and stays that way for now: it is the account of every task the swarm has
 * done, and moving it wholesale is a migration with real consequences if it
 * goes wrong. What a cloud-resident tick needs first is to SEE it, and a
 * write-through copy gives that without putting the record at risk.
 *
 * So this route is deliberately unopinionated: it takes the registry as the
 * app wrote it and stores it whole. Decomposing it here would be a second
 * model of the same thing, free to disagree with the first - which is the
 * defect this whole line of work keeps having to repair.
 */

import { Hono } from 'hono'
import { Pool } from 'pg'
import { logger } from '../../lib/logger'

function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || undefined
}

export function createQueenRegistryRoute() {
  return new Hono()
    .put('/', async (c) => {
      const url = databaseUrl()
      if (!url) return c.json({ error: 'No database configured' }, 503)

      const body = await c.req.json().catch(() => null)
      const tasks = body?.tasks
      const variant = typeof body?.variant === 'string' ? body.variant : 'prod'
      if (!Array.isArray(tasks)) {
        // An empty array is a real registry; a missing one is a caller bug, and
        // storing it as empty would report the swarm as idle.
        return c.json({ error: 'tasks must be an array' }, 400)
      }

      const pool = new Pool({ connectionString: url })
      try {
        await pool.query(
          `INSERT INTO queen_registry (variant, tasks, task_count, published_at)
           VALUES ($1, $2::jsonb, $3, now())
           ON CONFLICT (variant) DO UPDATE
             SET tasks = EXCLUDED.tasks,
                 task_count = EXCLUDED.task_count,
                 published_at = EXCLUDED.published_at`,
          [variant, JSON.stringify(tasks), tasks.length],
        )
        return c.json({ stored: tasks.length, variant })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('Queen registry mirror failed', { error: message })
        return c.json({ error: message }, 500)
      } finally {
        await pool.end()
      }
    })
    .get('/', async (c) => {
      const url = databaseUrl()
      if (!url) return c.json({ error: 'No database configured' }, 503)
      const variant = c.req.query('variant') ?? 'prod'
      const pool = new Pool({ connectionString: url })
      try {
        const result = await pool.query(
          'SELECT tasks, task_count, published_at FROM queen_registry WHERE variant = $1',
          [variant],
        )
        if (result.rowCount === 0)
          return c.json({ error: 'nothing published yet' }, 404)
        const row = result.rows[0]
        return c.json({
          tasks: row.tasks,
          taskCount: row.task_count,
          // The caller decides whether a mirror this old is worth reading, so
          // the age travels with it rather than being assumed fresh.
          publishedAt: row.published_at,
        })
      } finally {
        await pool.end()
      }
    })
}
