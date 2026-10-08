/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Where GitHub delivers the t27-bees app's webhooks (gHashTag/t27
 * specs/queen/app.t27). The caller is GitHub's server, so there is no browser
 * Origin to check. The guard is the signature:
 * - X-Hub-Signature-256 is an HMAC-SHA256 of the exact body under
 *   TRIOS_BEES_WEBHOOK_SECRET, compared in constant time;
 * - an unsigned or missigned request is refused before its body is parsed;
 * - with no secret set (fewer than 16 characters), the route refuses
 *   everything, so it is off rather than open.
 *
 * A delivery is acted on once (X-GitHub-Delivery, queen_app_seen). GitHub
 * redelivers on a timeout, and a head is reviewed once anyway (its primary
 * key). The answer is 202 as soon as the event is written down. The review
 * itself is written by the Queen's round, never inside GitHub's ten-second
 * window.
 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import {
  appEventFromWebhook,
  ensureAppTables,
  firstSight,
  handleAppEvent,
  signatureOk,
} from '../services/queen-app'

/** GitHub caps a payload at 25 MB; nothing this app reads is near 5. */
export const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024

let pool: Pool | null = null

export function createQueenAppWebhookRoute(
  options: { pool?: () => Pool | null; env?: NodeJS.ProcessEnv } = {},
) {
  const env = options.env ?? process.env
  const poolOf =
    options.pool ??
    (() => {
      const url = env.DATABASE_URL
      if (!url) return null
      pool ??= createQueenPool(url)
      return pool
    })
  return new Hono().post('/', async (c) => {
    const secret = env.TRIOS_BEES_WEBHOOK_SECRET ?? ''
    if (secret.length < 16)
      return c.json({ error: 'The t27-bees webhook is not configured' }, 503)
    if (Number(c.req.header('content-length') ?? '0') > MAX_WEBHOOK_BYTES)
      return c.json({ error: 'Payload too large' }, 413)
    const body = new Uint8Array(await c.req.arrayBuffer())
    if (body.length > MAX_WEBHOOK_BYTES)
      return c.json({ error: 'Payload too large' }, 413)
    if (!signatureOk(secret, body, c.req.header('x-hub-signature-256')))
      return c.json({ error: 'Bad signature' }, 401)

    const name = c.req.header('x-github-event') ?? ''
    if (name === 'ping') return c.json({ ok: true, pong: true })
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder().decode(body))
    } catch {
      return c.json({ error: 'The body is not JSON' }, 400)
    }
    const db = poolOf()
    if (!db) return c.json({ error: 'No database configured' }, 503)
    try {
      await ensureAppTables(db)
      const delivery = c.req.header('x-github-delivery') ?? ''
      if (
        delivery &&
        !(await firstSight(db, `delivery:${delivery.slice(0, 80)}`))
      )
        return c.json({ ok: true, duplicate: true })
      const result = await handleAppEvent(
        db,
        appEventFromWebhook(name, payload),
        env,
      )
      return c.json(
        { ok: true, reaction: result.reaction, note: result.note },
        202,
      )
    } catch (error) {
      logger.warn('t27-bees webhook failed', {
        event: name,
        error: error instanceof Error ? error.message : String(error),
      })
      // 500 makes GitHub show the failure and lets the owner redeliver it.
      return c.json({ error: 'The event could not be handled' }, 500)
    }
  })
}
