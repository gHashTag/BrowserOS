/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { MiddlewareHandler } from 'hono'
import type { cors } from 'hono/cors'

type CorsOptions = Parameters<typeof cors>[0]

const DEFAULT_ALLOW_METHODS = ['GET', 'POST', 'DELETE', 'OPTIONS']
const DEFAULT_ALLOW_HEADERS = ['Content-Type', 'Authorization', 'Accept']

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1'])
const EXTENSION_PROTOCOLS = new Set(['chrome-extension:', 'moz-extension:'])

function parseTrustedOrigins(): Set<string> {
  const raw = process.env.TRUSTED_ORIGINS
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
}

/**
 * Check whether an Origin value is allowed by the server CORS allowlist.
 *
 * Allowed origins:
 * - Local extension origins (`chrome-extension://*`, `moz-extension://*`)
 * - Loopback origins on any port (`http(s)://localhost:*`, `http(s)://127.0.0.1:*`)
 * - Any origin listed in the `TRUSTED_ORIGINS` environment variable
 *
 * Returns the origin string when allowed so Hono emits it in
 * `Access-Control-Allow-Origin`, or `null` when the origin is not permitted.
 */
export function isAllowedCorsOrigin(origin: string | undefined): string | null {
  if (!origin) return null

  try {
    const url = new URL(origin)

    if (EXTENSION_PROTOCOLS.has(url.protocol)) {
      return origin
    }

    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_HOSTS.has(url.hostname)
    ) {
      return origin
    }

    if (parseTrustedOrigins().has(origin)) {
      return origin
    }

    return null
  } catch {
    return null
  }
}

/**
 * Default CORS configuration for the HTTP server.
 *
 * The allowlist is restricted to local browser extensions, loopback origins,
 * and any origins declared via `TRUSTED_ORIGINS`. `credentials: true` is only
 * applied when the request origin matches the allowlist because Hono's CORS
 * middleware only emits `Access-Control-Allow-Credentials` for matching
 * origins.
 */
export const defaultCorsConfig: CorsOptions = {
  origin: (origin: string) => isAllowedCorsOrigin(origin),
  allowMethods: DEFAULT_ALLOW_METHODS,
  allowHeaders: DEFAULT_ALLOW_HEADERS,
  credentials: true,
}

/**
 * Hono CORS middleware that only emits `Access-Control-Allow-Credentials` when the
 * request origin is on the allowlist. Hono's bundled `cors()` cannot express a
 * conditional credentials header, so we handle preflight and simple requests
 * manually on top of the same allowlist.
 */
export function trustedCorsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    const allowedOrigin = isAllowedCorsOrigin(origin)

    if (allowedOrigin) {
      c.header('Access-Control-Allow-Origin', allowedOrigin)
      c.header('Access-Control-Allow-Credentials', 'true')
    }

    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', DEFAULT_ALLOW_METHODS.join(','))
      c.header('Access-Control-Allow-Headers', DEFAULT_ALLOW_HEADERS.join(','))
      c.header('Vary', 'Origin', { append: true })
      c.header('Vary', 'Access-Control-Request-Method', { append: true })
      c.header('Vary', 'Access-Control-Request-Headers', { append: true })
      return c.body(null, 204)
    }

    await next()

    if (origin) {
      c.header('Vary', 'Origin', { append: true })
    }
    return
  }
}
