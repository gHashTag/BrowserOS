import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { isLocalhostRequest } from './security'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const EXTENSION_PROTOCOLS = new Set(['chrome-extension:', 'moz-extension:'])

/// A shared secret that admits a caller from anywhere.
///
/// Every other rule in this file establishes trust from *where the request came
/// from*, which works precisely as long as the server is reachable from one
/// machine. A deployment reachable over the internet has no such geography, and
/// needs something the caller knows rather than somewhere the caller is.
///
/// Read per-request rather than captured at import so a test can set it, and
/// so a platform that injects variables after module load is not silently
/// running without auth.
function configuredToken(): string | undefined {
  const token = process.env.TRIOS_API_TOKEN
  return token && token.length > 0 ? token : undefined
}

/// Constant-time comparison. A `===` here leaks the length of the matching
/// prefix through timing, which is enough to recover a token byte by byte.
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on length mismatch, and the length difference is
  // already observable from the request the attacker sent, so returning early
  // leaks nothing new.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/// `isLocalhostRequest` reads `c.env.server` and throws when it is absent.
///
/// On an authorisation path a thrown exception becomes a 500, which is both
/// less informative than a refusal and, in a handler that catches broadly,
/// capable of turning into a pass. Not being able to establish that a socket
/// is local is exactly the case for treating it as not local.
function isLocalRequestOrFalse(c: Parameters<MiddlewareHandler>[0]): boolean {
  try {
    return isLocalhostRequest(c as never)
  } catch {
    return false
  }
}

function presentsValidToken(authorization: string | undefined): boolean {
  const expected = configuredToken()
  if (!expected || !authorization) return false
  const prefix = 'Bearer '
  if (!authorization.startsWith(prefix)) return false
  return tokenMatches(authorization.slice(prefix.length), expected)
}

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
 * - A valid `Authorization: Bearer <TRIOS_API_TOKEN>` is accepted from any
 *   address. This is the only rule that survives the server being reachable
 *   from more than one machine.
 * - Every origin rule below additionally requires a loopback socket. The
 *   Origin header is a browser's promise, and only a browser makes it; a
 *   `curl` on the far side of the internet writes whatever it likes there.
 * - Requests without an Origin header are allowed only when the actual TCP
 *   socket is loopback.
 */
export function requireTrustedAppOrigin(): MiddlewareHandler {
  return async (c, next) => {
    if (presentsValidToken(c.req.header('authorization'))) {
      return next()
    }

    const origin = c.req.header('origin')
    if (origin) {
      if (!isTrustedAppOrigin(origin)) {
        return c.json({ error: 'Forbidden' }, 403)
      }

      // Every trusted origin needs a loopback socket, not just the loopback
      // ones.
      //
      // The extension case used to be exempt, on the reasoning that a browser
      // will not let a web page forge a `chrome-extension://` Origin. That is
      // true of browsers and irrelevant to everything else: the header is a
      // string, and a request from anywhere can carry it. The exemption was
      // sound only because the server was reachable from one machine, so the
      // guarantee it actually rested on was the socket - and it is the socket
      // that is checked here now.
      //
      // Measured, not reasoned: with the server on a public URL,
      // `curl -H 'Origin: chrome-extension://aaaa...' .../mcp` returned the
      // full tool list, filesystem and shell tools included.
      if (!isLocalRequestOrFalse(c)) {
        return c.json({ error: 'Forbidden' }, 403)
      }

      try {
        new URL(origin)
      } catch {
        return c.json({ error: 'Forbidden' }, 403)
      }

      return next()
    }

    // Some local reads arrive without an Origin header. Allow those only when
    // the actual client socket is loopback. This avoids Host-header spoofing.
    if (isLocalRequestOrFalse(c)) {
      return next()
    }

    return c.json({ error: 'Forbidden' }, 403)
  }
}
