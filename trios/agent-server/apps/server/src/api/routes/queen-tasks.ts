/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A PERSON ASSIGNS AND CANCELS THROUGH THE SAME MACHINE (specs/queen/control.t27
 * section 3, gHashTag/t27#6657).
 *
 * Until this route the card's CANCEL_RULE was measured as "none: no route aborts
 * a running turn or drops a dispatch", and the only way to move a task by hand
 * was to edit the database. Two doors, guarded like every other route that
 * writes (requireTrustedAppOrigin, which in production means the bearer token):
 *
 *   POST /queen/tasks/:issue/cancel   { by?, reason? }
 *   POST /queen/tasks/:issue/assign   { by? }
 *   GET  /queen/tasks/assigned        the assignments still waiting
 *
 * Neither is a second scheduler. A cancel ends the dispatch row the review and
 * the board already read, and a running turn is interrupted by the process
 * that streams it. An assignment is a row the next round puts first in the
 * candidate list it hands `queend`, which still applies every rule it applies
 * to an automatic choice. Each publishes its event to the control log, and the
 * event wakes the Queen (wakes_queen), so a person's move does not wait for the
 * tick.
 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import {
  type CancelResult,
  cancelTask,
  ensureControlTables,
  pendingAssigns,
  publishEvent,
  requestAssign,
  taskLeasedLive,
} from '../services/queen-control'
import {
  A_HELD,
  A_OK,
  assignAnswer,
  cancelAllowed,
} from '../services/queen-control-rules'
import { abortBeeHere } from '../services/queen-dispatch'
import { queenLeaseDatabaseUrl } from '../services/queen-lease'
import { ensureQueenColumns } from '../services/queen-tick'

/** The seams a test replaces; every default is the production function. */
export interface QueenTasksDeps {
  pool?: () => Pool | null
  cancelTask?: typeof cancelTask
  requestAssign?: typeof requestAssign
  pendingAssigns?: typeof pendingAssigns
  taskLeasedLive?: typeof taskLeasedLive
  publishEvent?: typeof publishEvent
  abortBeeHere?: typeof abortBeeHere
  /** The tables and columns the statements below read. */
  ensureTables?: (pool: Pool) => Promise<void>
}

/**
 * What a round makes sure of before it reads the dispatch table, made sure of
 * here too: the columns a cancel writes (judged_note, send_backs...) are added
 * by the round's own migration, and a person may call this door on a fresh
 * database before the first round has run.
 */
async function ensureTables(pool: Pool): Promise<void> {
  await ensureQueenColumns(pool)
  await ensureControlTables(pool)
}

let sharedPool: Pool | null = null

function defaultPool(): Pool | null {
  const url = queenLeaseDatabaseUrl()
  if (!url) return null
  if (!sharedPool) sharedPool = createQueenPool(url)
  return sharedPool
}

/** An issue number from the path, or null for anything that is not one. */
function issueOf(raw: string): number | null {
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) return null
  return Number(raw)
}

/** A short printable name for who asked, never empty. */
function nameOf(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return clean ? clean.slice(0, 80) : fallback
}

export function createQueenTasksRoute(deps: QueenTasksDeps = {}) {
  const poolOf = deps.pool ?? defaultPool
  const cancel = deps.cancelTask ?? cancelTask
  const assign = deps.requestAssign ?? requestAssign
  const pending = deps.pendingAssigns ?? pendingAssigns
  const leasedLive = deps.taskLeasedLive ?? taskLeasedLive
  const publish = deps.publishEvent ?? publishEvent
  const abortHere = deps.abortBeeHere ?? abortBeeHere
  const ensure = deps.ensureTables ?? ensureTables

  return new Hono()
    .get('/assigned', async (c) => {
      const pool = poolOf()
      if (!pool) return c.json({ error: 'No database configured' }, 503)
      await ensure(pool)
      return c.json({ assigned: await pending(pool) })
    })
    .post('/:issue/cancel', async (c) => {
      const issue = issueOf(c.req.param('issue'))
      if (issue === null) return c.json({ error: 'not an issue number' }, 400)
      const pool = poolOf()
      if (!pool) return c.json({ error: 'No database configured' }, 503)
      const body = await c.req.json().catch(() => ({}))
      const by = nameOf(body?.by, 'operator')
      const reason = nameOf(body?.reason, '')
      await ensure(pool)

      const result: CancelResult = await cancel(pool, issue, by, reason)
      if (result.status === 'none') {
        return c.json({ issue, error: 'no dispatch for this issue' }, 404)
      }
      if (result.status === 'accepted') {
        // cancel_allowed(true) is false: the accept stands. Asked of the rule
        // rather than assumed, so the answer and the card cannot drift apart.
        return c.json(
          {
            issue,
            cancelled: cancelAllowed(true),
            error:
              'the dispatch is accepted; only the CI take-back undoes an accept',
          },
          409,
        )
      }
      // The turn stops where it streams. On a runner that is the runner, which
      // sees its row end within one poll and closes the stream itself.
      const interruptedHere =
        result.wasRunning && result.conversationId
          ? abortHere(issue, result.conversationId)
          : false
      await publish(pool, 'queen/task.cancel', { issue, by }).catch(() => 0)
      return c.json({
        issue,
        cancelled: true,
        wasRunning: result.wasRunning,
        interruptedHere,
        fence: result.fence,
      })
    })
    .post('/:issue/assign', async (c) => {
      const issue = issueOf(c.req.param('issue'))
      if (issue === null) return c.json({ error: 'not an issue number' }, 400)
      const pool = poolOf()
      if (!pool) return c.json({ error: 'No database configured' }, 503)
      const body = await c.req.json().catch(() => ({}))
      const by = nameOf(body?.by, 'operator')
      await ensure(pool)

      // The supervisor keeps no domain agents yet (card section 5), so every
      // lane is of the task's domain, and whether one is free is the round's
      // capacity question: an assignment waits for it rather than being
      // refused for it.
      const answer = assignAnswer(await leasedLive(pool, issue), true, true)
      if (answer === A_HELD) {
        return c.json(
          {
            issue,
            answer: 'held',
            error: 'a bee holds this task; cancel it first',
          },
          409,
        )
      }
      if (answer !== A_OK) {
        return c.json({ issue, answer }, 409)
      }
      await assign(pool, issue, by)
      await publish(pool, 'queen/task.assign', { issue, by }).catch(() => 0)
      return c.json({ issue, answer: 'ok', queued: true }, 202)
    })
}
