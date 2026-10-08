/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The t27-bees GitHub App's own credentials, and nothing else.
 *
 * The app signs a ten-minute JWT with its private key (RS256) and trades it,
 * per installation, for a one-hour installation token. That token can act only
 * on the repositories the installation chose, with only the permissions the app
 * was granted. It is never logged, never stored in the database and never
 * echoed. The cache below keeps it in memory until five minutes before GitHub
 * says it expires.
 *
 * Two variables, both set by the owner: TRIOS_BEES_APP_ID and
 * TRIOS_BEES_PRIVATE_KEY (the PEM text; a single line with literal "\n" is
 * accepted, because that is how most dashboards store one). Without them the
 * app is dormant, and GET /queen/public-app says so.
 *
 * This is GitHub's own API spoken in its own types: the JWT, the token
 * exchange and the REST paths. The decisions about what to do with an event
 * are in specs/queen/app.t27 (queen-app-logic.ts).
 */

import { createPrivateKey, sign } from 'node:crypto'

export const GITHUB_API = 'https://api.github.com'

export interface AppCredentials {
  appId: string
  privateKey: string
}

/** The app's id and key from the environment, or null when either is missing. */
export function appCredentials(
  env: NodeJS.ProcessEnv = process.env,
): AppCredentials | null {
  const appId = env.TRIOS_BEES_APP_ID?.trim() ?? ''
  const raw = env.TRIOS_BEES_PRIVATE_KEY ?? ''
  if (!/^\d{1,12}$/.test(appId)) return null
  if (!raw.includes('PRIVATE KEY')) return null
  const privateKey =
    raw.includes('\\n') && !raw.includes('\n') ? raw.replace(/\\n/g, '\n') : raw
  return { appId, privateKey }
}

const b64url = (bytes: Buffer | string): string =>
  Buffer.from(bytes).toString('base64url')

/**
 * The app's JWT. `iat` is a minute in the past, because GitHub refuses a token
 * issued "in the future" by a clock that runs a little ahead. `exp` stays
 * under GitHub's ten-minute ceiling.
 */
export function appJwt(credentials: AppCredentials, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({ iat, exp: iat + 540, iss: credentials.appId }),
  )
  const signature = sign(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    createPrivateKey(credentials.privateKey),
  )
  return `${header}.${payload}.${b64url(signature)}`
}

export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

export interface GithubAnswer {
  status: number
  body: unknown
}

export interface AppRepo {
  repo: string
  private: boolean
  /** When the repository was last pushed to (ISO), when GitHub said. */
  pushedAt?: string | null
}

export interface AppGithub {
  /** Every installation of the app: its id and its account. */
  installations(): Promise<Array<{ id: number; account: string }>>
  /** The repositories one installation chose. */
  installationRepos(installationId: number): Promise<AppRepo[]>
  /** The installation that serves one repository (`owner/name`). */
  installationFor(repo: string): Promise<number>
  /** One REST call made as the installation (its token, its permissions). */
  call(
    installationId: number,
    method: string,
    path: string,
    body?: unknown,
    accept?: string,
  ): Promise<GithubAnswer>
}

export const GITHUB_TIMEOUT_MS = 20_000
const TOKEN_MARGIN_MS = 5 * 60_000

export function createAppGithub(
  credentials: AppCredentials,
  options: { fetch?: FetchLike; now?: () => number; api?: string } = {},
): AppGithub {
  const doFetch = options.fetch ?? (fetch as unknown as FetchLike)
  const now = options.now ?? Date.now
  const api = (options.api ?? GITHUB_API).replace(/\/+$/, '')
  const tokens = new Map<number, { token: string; until: number }>()

  const request = async (
    auth: string,
    method: string,
    path: string,
    body?: unknown,
    accept = 'application/vnd.github+json',
  ): Promise<GithubAnswer> => {
    const res = await doFetch(`${api}${path}`, {
      method,
      headers: {
        Accept: accept,
        Authorization: auth,
        'User-Agent': 't27-bees',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })
    const parsed = accept.includes('json')
      ? await res.json().catch(() => null)
      : await res.text().catch(() => '')
    return { status: res.status, body: parsed }
  }

  const asApp = (method: string, path: string, body?: unknown) =>
    request(`Bearer ${appJwt(credentials, now())}`, method, path, body)

  const tokenFor = async (installationId: number): Promise<string> => {
    const hit = tokens.get(installationId)
    if (hit && hit.until > now()) return hit.token
    const answer = await asApp(
      'POST',
      `/app/installations/${installationId}/access_tokens`,
    )
    const body = answer.body as { token?: unknown; expires_at?: unknown }
    if (answer.status !== 201 || typeof body?.token !== 'string')
      throw new Error(
        `installation ${installationId}: token refused (http ${answer.status})`,
      )
    const expires = Date.parse(String(body.expires_at ?? ''))
    tokens.set(installationId, {
      token: body.token,
      until:
        (Number.isFinite(expires) ? expires : now() + 3_600_000) -
        TOKEN_MARGIN_MS,
    })
    return body.token
  }

  return {
    async installations() {
      const all: Array<{ id: number; account: string }> = []
      for (let page = 1; page <= 10; page += 1) {
        const answer = await asApp(
          'GET',
          `/app/installations?per_page=100&page=${page}`,
        )
        if (answer.status !== 200 || !Array.isArray(answer.body))
          throw new Error(`installations: http ${answer.status}`)
        for (const item of answer.body as Array<Record<string, unknown>>) {
          const account = item.account as Record<string, unknown> | undefined
          if (typeof item.id === 'number')
            all.push({ id: item.id, account: String(account?.login ?? '') })
        }
        if (answer.body.length < 100) break
      }
      return all
    },

    async installationRepos(installationId) {
      const all: AppRepo[] = []
      const token = await tokenFor(installationId)
      for (let page = 1; page <= 20; page += 1) {
        const answer = await request(
          `token ${token}`,
          'GET',
          `/installation/repositories?per_page=100&page=${page}`,
        )
        const repos = (answer.body as { repositories?: unknown })?.repositories
        if (answer.status !== 200 || !Array.isArray(repos))
          throw new Error(
            `installation ${installationId} repositories: http ${answer.status}`,
          )
        for (const r of repos as Array<Record<string, unknown>>)
          if (typeof r.full_name === 'string')
            all.push({
              repo: r.full_name,
              private: r.private === true,
              pushedAt: typeof r.pushed_at === 'string' ? r.pushed_at : null,
            })
        if (repos.length < 100) break
      }
      return all
    },

    async installationFor(repo) {
      const answer = await asApp('GET', `/repos/${repo}/installation`)
      const id = (answer.body as { id?: unknown } | null)?.id
      if (answer.status !== 200 || typeof id !== 'number')
        throw new Error(
          `${repo}: the app is not installed (http ${answer.status})`,
        )
      return id
    },

    async call(installationId, method, path, body, accept) {
      const token = await tokenFor(installationId)
      return request(`token ${token}`, method, path, body, accept)
    },
  }
}
