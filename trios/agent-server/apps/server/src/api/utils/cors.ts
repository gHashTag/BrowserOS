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
 * CORS for the two endpoints that are public ON PURPOSE.
 *
 * `/queen/status` and `/queen/public-board` are sanitized projections: no
 * holder, branch, transcript, provider or mutation route escapes them, and
 * anyone can already read them with `curl` and no token. What they could NOT do
 * was be read from a browser on another origin, so the public face of the Queen
 * at t27.ai showed "brain not connected" while the brain answered every request
 * made from a terminal. That gap was the whole distance between the site and the
 * supervisor.
 *
 * The fix is a wildcard WITHOUT credentials, not a new entry in
 * `TRUSTED_ORIGINS`. Adding an origin there grants it the credentialed
 * allowlist across every route, which is the shape of a defect this repository
 * has already shipped once: an Origin header is a string the caller types, so
 * an allowlist entry is a password anyone can spell. `*` with no credentials
 * grants strictly what `curl` already grants - the browser will not attach
 * cookies or an Authorization header to it.
 *
 * When the origin IS on the trusted allowlist this steps aside: the trusted
 * middleware has already emitted that exact origin plus
 * `Allow-Credentials: true`, and overwriting it with `*` would make the browser
 * reject the pair - breaking the public read for the one origin most likely to
 * be configured.
 */
export function publicReadCorsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')

    // A trusted origin is already fully served by trustedCorsMiddleware,
    // preflight included. Stepping aside means falling all the way through -
    // an early 204 here would answer the preflight with none of the headers
    // that middleware was about to add.
    if (isAllowedCorsOrigin(origin)) {
      await next()
      return
    }

    c.header('Access-Control-Allow-Origin', '*')
    c.header('Access-Control-Allow-Methods', 'GET,OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Accept,Content-Type')
    // the Queen page's round clock reads the server's clock from Date (P1-30)
    c.header('Access-Control-Expose-Headers', 'Date')

    if (c.req.method === 'OPTIONS') return c.body(null, 204)

    await next()
    c.header('Vary', 'Origin', { append: true })
    return
  }
}

/** The origin that serves the board with a signed-in person's session. */
export const APP_CABINET_ORIGIN = 'https://app.t27.ai'

/**
 * CORS for the runner cabinet (/queen/me/*), which the board at
 * https://app.t27.ai/queen/ calls with the person's own bearer token.
 *
 * Exactly one origin, no credentials. The credential is the Authorization
 * header the page chose to send, not a cookie the browser attaches on its own,
 * so a page on any other origin cannot borrow a session it does not hold - and
 * this grants nothing to any other route: it is mounted on the cabinet's path
 * alone, rather than added to TRUSTED_ORIGINS, which would hand the origin the
 * credentialed allowlist everywhere.
 */
export function appCabinetCorsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    if (origin !== APP_CABINET_ORIGIN || isAllowedCorsOrigin(origin)) {
      await next()
      return
    }

    c.header('Access-Control-Allow-Origin', origin)
    c.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Authorization,Content-Type')
    c.header('Access-Control-Max-Age', '600')
    c.header('Vary', 'Origin', { append: true })

    if (c.req.method === 'OPTIONS') return c.body(null, 204)

    await next()
    return
  }
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
      // the Queen page's round clock reads the server's clock from Date (P1-30)
      c.header('Access-Control-Expose-Headers', 'Date')
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
