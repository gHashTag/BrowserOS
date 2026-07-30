import type { MiddlewareHandler } from 'hono'
import { isLocalhostRequest } from './security'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const EXTENSION_PROTOCOLS = new Set(['chrome-extension:', 'moz-extension:'])

export function isTrustedAppOrigin(origin: string | undefined): boolean {
  if (!origin) return false

  try {
    const url = new URL(origin)

    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_HOSTS.has(url.hostname)
    ) {
      return true
    }

    return EXTENSION_PROTOCOLS.has(url.protocol)
  } catch {
    return false
  }
}

/**
 * Require that the request originate from a trusted application.
 *
 * Trust policy:
 * - Browser extension origins (`chrome-extension://*`, `moz-extension://*`) are
 *   allowed based on the Origin header alone; browsers do not allow web pages
 *   to spoof these schemes in CORS requests.
 * - Loopback origins (`http://localhost:*`, `http://127.0.0.1:*`) must also pass
 *   `isLocalhostRequest(c)` so a remote client cannot bypass the check by
 *   sending a spoofed Origin header.
 * - Requests without an Origin header are allowed only when the actual TCP
 *   socket is loopback.
 */
export function requireTrustedAppOrigin(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    if (origin) {
      if (!isTrustedAppOrigin(origin)) {
        return c.json({ error: 'Forbidden' }, 403)
      }

      // Loopback origins additionally require a loopback socket; otherwise a
      // remote client could spoof the Origin header.
      try {
        const url = new URL(origin)
        if (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          LOOPBACK_HOSTS.has(url.hostname) &&
          !isLocalhostRequest(c)
        ) {
          return c.json({ error: 'Forbidden' }, 403)
        }
      } catch {
        return c.json({ error: 'Forbidden' }, 403)
      }

      return next()
    }

    // Some local reads arrive without an Origin header. Allow those only when
    // the actual client socket is loopback. This avoids Host-header spoofing.
    if (isLocalhostRequest(c)) {
      return next()
    }

    return c.json({ error: 'Forbidden' }, 403)
  }
}
