/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Local-authorization middleware for high-impact routes.
 *
 * Complements requireTrustedAppOrigin by requiring a server-issued, in-memory
 * access token in the X-TriOS-Local-Auth header. The access token is only
 * exposed to trusted origins via GET /auth/local-token, so only the local
 * app/extension that already passed origin checks can obtain it.
 *
 * Validation events are appended token-free to
 * .trinity/state/local-auth-audit.jsonl for incident response.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../types'
import { presentsValidApiToken } from './request-auth'

export const LOCAL_AUTH_HEADER = 'X-TriOS-Local-Auth'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_AUDIT_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'trios',
  '.trinity',
  'state',
  'local-auth-audit.jsonl',
)

export interface LocalAuthValidator {
  validate(headerValue: string | undefined): boolean
  isExpired?(): boolean
}

function resolveAuditPath(providedPath?: string): string {
  return providedPath ?? process.env.LOCAL_AUTH_AUDIT_PATH ?? DEFAULT_AUDIT_PATH
}

function getSocketAddress(c: Context<Env>): string | undefined {
  const server = c.env?.server
  if (!server || typeof server.requestIP !== 'function') return undefined
  try {
    const info = server.requestIP(c.req.raw)
    return info?.address
  } catch {
    return undefined
  }
}

async function logLocalAuthAudit(
  auditPath: string,
  routePath: string,
  socketAddress: string | undefined,
  result: 'ok' | 'expired' | 'invalid' | 'unconfigured' | 'api-token',
): Promise<void> {
  try {
    await mkdir(dirname(auditPath), { recursive: true })
    const entry = JSON.stringify({
      path: routePath,
      timestamp: new Date().toISOString(),
      socketAddress: socketAddress ?? 'unknown',
      result,
    })
    await appendFile(auditPath, `${entry}\n`, 'utf8')
  } catch {
    // Best-effort audit logging. Never fail a request because of an I/O error.
  }
}

export function requireLocalAuth(
  validator: LocalAuthValidator | undefined,
  auditPath?: string,
): MiddlewareHandler {
  return async (c, next) => {
    const path = resolveAuditPath(auditPath)
    const routePath = c.req.path
    const socketAddress = getSocketAddress(c)

    // A deployed server's credential also satisfies this gate.
    //
    // This middleware proves "you are on this machine": it hands a token to
    // trusted origins over loopback and then checks it back. That argument is
    // sound for a server the app started locally and empty for one in a
    // container, where there is no local anything and the token can never be
    // fetched.
    //
    // Measured on the first autonomous delegation into the cloud: the Queen
    // chose an issue, cut the bee's worktree in the container, opened a turn -
    // and /chat answered `403 Local authorization required`. Two attempts went
    // that way and the issue was retired as exhausted, blaming the work.
    //
    // TRIOS_API_TOKEN is what a remote caller can actually hold, and setting it
    // is already a statement that the perimeter is not the machine - the same
    // statement that disables the origin and loopback fallbacks next door. It
    // is checked first because when it is present the rest of this gate has
    // nothing left to establish.
    if (presentsValidApiToken(c.req.header('authorization'))) {
      await logLocalAuthAudit(path, routePath, socketAddress, 'api-token')
      return next()
    }

    if (!validator) {
      await logLocalAuthAudit(path, routePath, socketAddress, 'unconfigured')
      return c.json({ error: 'Local authorization not configured' }, 503)
    }

    const headerValue = c.req.header(LOCAL_AUTH_HEADER.toLowerCase())
    if (!headerValue) {
      await logLocalAuthAudit(path, routePath, socketAddress, 'invalid')
      return c.json({ error: 'Local authorization required' }, 403)
    }

    if (validator.isExpired?.()) {
      await logLocalAuthAudit(path, routePath, socketAddress, 'expired')
      return c.json({ error: 'Local authorization expired' }, 401)
    }

    if (!validator.validate(headerValue)) {
      await logLocalAuthAudit(path, routePath, socketAddress, 'invalid')
      return c.json({ error: 'Local authorization required' }, 403)
    }

    await logLocalAuthAudit(path, routePath, socketAddress, 'ok')
    return next()
  }
}
