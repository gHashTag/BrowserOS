/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * WHO IS ASKING, FOR A PERSON SIGNED IN TO https://app.t27.ai.
 *
 * This server has never known a person. Its only credentials are the
 * operator's TRIOS_API_TOKEN and the loopback local-auth token; Telegram
 * sessions belong to the player's own service (vibee-render, in
 * 999-multibots-telegraf), which issues the access token the board at
 * app.t27.ai/queen/ already holds in memory.
 *
 * So the answer to "who is this" is asked of the service that issued the
 * token, with the token: `tools/call whoami` on its /mcp, the same call the
 * board itself makes to put a name beside the avatar. Its answer carries
 * `telegram_id`, and that id is the only identity the runner cabinet keys on.
 *
 * WHAT THIS FILE DOES WITH THE TOKEN. It forwards it once to the issuer and
 * nowhere else. It is never logged, never stored and never echoed; the cache
 * below is keyed by its SHA-256, so a heap dump holds a hash, not a credential.
 *
 * THREE ANSWERS, NOT TWO. `null` means the issuer refused the token (sign in
 * again); a thrown IdentityUnavailableError means the issuer did not answer
 * (try again later). Collapsing them would tell a person whose session is fine
 * that they are signed out every time vibee-render redeploys.
 */
import { createHash } from 'node:crypto'

export const DEFAULT_APP_IDENTITY_URL =
  'https://vibee-render-production.up.railway.app'

/** How long a verified answer is trusted before the issuer is asked again. */
export const IDENTITY_CACHE_MS = 60_000
/** Bounded: a flood of distinct tokens must not grow the heap without limit. */
const IDENTITY_CACHE_MAX = 500
/** The issuer is abandoned after this long; the caller says "try again". */
export const IDENTITY_TIMEOUT_MS = 5_000

export interface AppPerson {
  /** Digits only: Telegram ids are integers, and the column is text. */
  telegramId: string
  /** Display name from the issuer's profile, for the person's own runners. */
  name: string
}

export class IdentityUnavailableError extends Error {
  constructor(reason: string) {
    super(`app identity unavailable: ${reason}`)
    this.name = 'IdentityUnavailableError'
  }
}

type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The payload of one MCP `tools/call` result: structured content when present,
 * otherwise the first text block parsed as JSON. Same rule as the board's
 * mcpAnswer.ts, because the same server is answering both.
 */
export function mcpPayload(result: unknown): unknown {
  if (!isRecord(result)) return undefined
  if (result.structuredContent !== undefined) return result.structuredContent
  if (!Array.isArray(result.content)) return undefined
  const text = result.content.find(
    (part): part is { type: string; text: string } =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string',
  )?.text
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** The person in a whoami answer, or null when it names nobody. */
export function personFromWhoami(body: unknown): AppPerson | null {
  if (!isRecord(body) || body.error !== undefined) return null
  const result = body.result
  if (isRecord(result) && result.isError === true) return null
  const data = mcpPayload(result)
  if (!isRecord(data)) return null
  const raw = data.telegram_id
  const telegramId =
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0
      ? String(raw)
      : typeof raw === 'string' && /^[1-9]\d{0,19}$/.test(raw)
        ? raw
        : null
  if (!telegramId) return null
  const profile = isRecord(data['профиль']) ? data['профиль'] : {}
  const name =
    [profile.display_name, profile.first_name, profile.username]
      .find((v): v is string => typeof v === 'string' && v.trim() !== '')
      ?.trim()
      .slice(0, 40) ?? `tg ${telegramId.slice(-4)}`
  return { telegramId, name }
}

/** `Authorization: Bearer x` -> 'x'. Anything else is no credential. */
export function bearerOf(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,4096})$/.exec(header.trim())
  return match ? match[1] : null
}

export interface AppIdentityOptions {
  baseUrl?: string
  fetch?: FetchLike
  now?: () => number
}

export type Identify = (bearer: string) => Promise<AppPerson | null>

export function createAppIdentity(options: AppIdentityOptions = {}): Identify {
  const baseUrl = (
    options.baseUrl ??
    process.env.TRIOS_APP_IDENTITY_URL ??
    DEFAULT_APP_IDENTITY_URL
  ).replace(/\/+$/, '')
  const doFetch: FetchLike = options.fetch ?? (fetch as unknown as FetchLike)
  const now = options.now ?? Date.now
  const cache = new Map<string, { person: AppPerson | null; until: number }>()

  return async (bearer) => {
    const key = createHash('sha256').update(bearer).digest('hex')
    const hit = cache.get(key)
    if (hit && hit.until > now()) return hit.person

    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), IDENTITY_TIMEOUT_MS)
    let status: number
    let body: unknown
    try {
      const res = await doFetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'whoami', arguments: {} },
        }),
        signal: abort.signal,
      })
      status = res.status
      body = res.ok ? await res.json() : null
    } catch (error) {
      throw new IdentityUnavailableError(
        error instanceof Error ? error.name : 'fetch failed',
      )
    } finally {
      clearTimeout(timer)
    }

    let person: AppPerson | null
    if (status === 401 || status === 403) person = null
    else if (status >= 200 && status < 300) person = personFromWhoami(body)
    else throw new IdentityUnavailableError(`http ${status}`)

    if (cache.size >= IDENTITY_CACHE_MAX) {
      // Oldest first: Map iterates in insertion order.
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, { person, until: now() + IDENTITY_CACHE_MS })
    return person
  }
}
