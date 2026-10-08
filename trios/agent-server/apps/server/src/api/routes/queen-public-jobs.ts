/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The Queen's multi-step jobs, as anyone may read them (gHashTag/t27
 * specs/queen/jobs.t27, t27#7676): which card, which version, which step, what
 * each step answered. A release run by the swarm is watched here instead of in
 * somebody's terminal. Nothing secret is in a job row: the card, the version,
 * the issue that asked, the pinned commit and the steps' own sentences.
 */

import { Hono } from 'hono'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import { ensureJobTables, listJobs } from '../services/queen-jobs'

const STATE_NAMES = ['running', 'done', 'failed', 'cancelled']

export function createQueenPublicJobsRoute() {
  return new Hono().get('/', async (c) => {
    const url = process.env.DATABASE_URL
    if (!url) return c.json({ error: 'No database configured' }, 503)
    try {
      const pool = createQueenPool(url)
      await ensureJobTables(pool)
      const jobs = (await listJobs(pool, 20)).map((j) => ({
        id: Number(j.id),
        card: j.card,
        version: j.params?.version ?? null,
        issue: j.params?.issue ? Number(j.params.issue) : null,
        rehearsal: j.rehearsal,
        state: STATE_NAMES[j.state] ?? String(j.state),
        step: j.step,
        subject: j.subject,
        note: j.note,
        log: j.log,
        startedBy: j.started_by,
        createdAt: j.created_at,
        updatedAt: j.updated_at,
      }))
      return c.json({ jobs }, 200, { 'Cache-Control': 'public, max-age=15' })
    } catch (error) {
      logger.warn('Queen jobs could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'The jobs are unavailable' }, 503)
    }
  })
}
