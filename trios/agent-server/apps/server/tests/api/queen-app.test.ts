/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The t27-bees app without a database (gHashTag/t27 specs/queen/app.t27):
 * - the generated card against its own spec's test vectors;
 * - the webhook signature;
 * - a webhook reduced to an event;
 * - the app's JWT;
 * - the route's refusals.
 * The rows are tests/pglive/queen-app-live.test.ts.
 */

import { describe, expect, it } from 'bun:test'
import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createQueenAppWebhookRoute } from '../../src/api/routes/queen-app-webhook'
import {
  appEventFromWebhook,
  sanitizeModelText,
  signatureOk,
  skippedRepos,
} from '../../src/api/services/queen-app'
import {
  AR_COMMAND,
  AR_FORGET,
  AR_IGNORE,
  AR_QUOTA,
  AR_REGISTER,
  AR_REVIEW,
  AR_UNREGISTER,
  C_HELP,
  C_NONE,
  C_PAUSE,
  C_RESUME,
  C_REVIEW,
  C_SUMMARY,
  DEPTH_FULL,
  DEPTH_SUMMARY,
  FREE_REVIEWS_PRIVATE,
  FREE_REVIEWS_PUBLIC,
  GE_COMMENT,
  GE_INSTALLED,
  GE_OTHER,
  GE_PR_CLOSED,
  GE_PR_OPENED,
  GE_PR_PUSHED,
  GE_PR_READY,
  GE_REPOS_ADDED,
  GE_REPOS_REMOVED,
  GE_UNINSTALLED,
  MAX_REVIEW_LINES,
} from '../../src/api/services/queen-app.gen'
import {
  appCredentials,
  appJwt,
  createAppGithub,
} from '../../src/api/services/queen-app-github'
import {
  appEventOf,
  appReaction,
  commandOf,
  freeReviewsLeft,
  reviewDepth,
  reviewWanted,
} from '../../src/api/services/queen-app-logic'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'

const PIN = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
const sha256 = (file: string): string =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

describe('the vendored card is the one PIN names', () => {
  it('app.t27 and app.wasm match their recorded hashes', () => {
    expect(PIN).toContain(`app.t27 sha256 ${sha256('queen/app.t27')}`)
    expect(PIN).toContain(`app.wasm sha256 ${sha256('queen/app.wasm')}`)
  })
})

// Every assert of specs/queen/app.t27's test blocks, run against the wasm the
// card generates. A wasm built from another card fails here.
describe('the generated card answers its own spec', () => {
  const r = appReaction
  it('an_install_registers_and_an_uninstall_forgets', () => {
    expect(r(GE_INSTALLED, false, false, false, false, 0)).toBe(AR_REGISTER)
    expect(r(GE_REPOS_ADDED, true, false, false, false, 0)).toBe(AR_REGISTER)
    expect(r(GE_UNINSTALLED, false, true, false, false, 9)).toBe(AR_UNREGISTER)
    expect(r(GE_REPOS_REMOVED, false, true, false, false, 9)).toBe(
      AR_UNREGISTER,
    )
  })
  it('a_pull_request_is_reviewed_once_it_is_ready', () => {
    expect(r(GE_PR_OPENED, false, true, false, false, 5)).toBe(AR_REVIEW)
    expect(r(GE_PR_PUSHED, false, true, false, false, 5)).toBe(AR_REVIEW)
    expect(r(GE_PR_READY, false, true, false, false, 5)).toBe(AR_REVIEW)
    expect(r(GE_PR_OPENED, false, true, false, true, 5)).toBe(AR_IGNORE)
    expect(r(GE_PR_CLOSED, false, true, false, false, 5)).toBe(AR_FORGET)
    expect(r(GE_COMMENT, false, true, false, false, 0)).toBe(AR_COMMAND)
  })
  it('a_pause_stops_reviews_and_nothing_else', () => {
    expect(r(GE_PR_PUSHED, false, true, true, false, 5)).toBe(AR_IGNORE)
    expect(r(GE_PR_OPENED, false, true, true, false, 5)).toBe(AR_IGNORE)
    expect(r(GE_PR_READY, false, true, true, false, 5)).toBe(AR_IGNORE)
    expect(r(GE_COMMENT, false, true, true, false, 5)).toBe(AR_COMMAND)
    expect(r(GE_PR_CLOSED, false, true, true, false, 5)).toBe(AR_FORGET)
    expect(r(GE_PR_PUSHED, false, true, true, false, 0)).toBe(AR_IGNORE)
  })
  it('the_queen_never_answers_herself_or_a_stranger_repo', () => {
    expect(r(GE_PR_OPENED, true, true, false, false, 5)).toBe(AR_IGNORE)
    expect(r(GE_COMMENT, true, true, false, false, 5)).toBe(AR_IGNORE)
    expect(r(GE_PR_OPENED, false, false, false, false, 5)).toBe(AR_IGNORE)
    expect(r(GE_OTHER, false, true, false, false, 5)).toBe(AR_IGNORE)
    expect(r(10, false, true, false, false, 5)).toBe(AR_IGNORE)
  })
  it('the_free_tier_is_bounded_per_day', () => {
    expect(r(GE_PR_OPENED, false, true, false, false, 0)).toBe(AR_QUOTA)
    expect(freeReviewsLeft(true, 0)).toBe(FREE_REVIEWS_PUBLIC)
    expect(freeReviewsLeft(false, 0)).toBe(FREE_REVIEWS_PRIVATE)
    expect(freeReviewsLeft(false, FREE_REVIEWS_PRIVATE - 1)).toBe(1)
    expect(freeReviewsLeft(false, FREE_REVIEWS_PRIVATE)).toBe(0)
    expect(freeReviewsLeft(true, FREE_REVIEWS_PUBLIC + 5)).toBe(0)
  })
  it('a_huge_diff_is_summarized_not_invented', () => {
    expect(reviewDepth(MAX_REVIEW_LINES)).toBe(DEPTH_FULL)
    expect(reviewDepth(MAX_REVIEW_LINES + 1)).toBe(DEPTH_SUMMARY)
    expect(reviewDepth(0)).toBe(DEPTH_FULL)
  })
  it('one_review_per_head_unless_asked_again', () => {
    expect(reviewWanted(false, false)).toBe(true)
    expect(reviewWanted(true, false)).toBe(false)
    expect(reviewWanted(true, true)).toBe(true)
  })
  it('a_comment_command_is_read_after_the_mention', () => {
    expect(commandOf('@t27-bees review')).toBe(C_REVIEW)
    expect(commandOf('please @t27-bees   summary now')).toBe(C_SUMMARY)
    expect(commandOf('@t27-bees help\nthanks')).toBe(C_HELP)
    expect(commandOf('@t27-bees pause')).toBe(C_PAUSE)
    expect(commandOf('@t27-bees resume')).toBe(C_RESUME)
    expect(commandOf('review')).toBe(C_NONE)
    expect(commandOf('@t27-bees dance')).toBe(C_NONE)
    expect(commandOf('@t27-bees reviewer')).toBe(C_NONE)
    expect(commandOf('@t27-bee review')).toBe(C_NONE)
    expect(commandOf('')).toBe(C_NONE)
    expect(commandOf('ask @t27-be')).toBe(C_NONE)
    expect(commandOf('@t27-bees   ')).toBe(C_NONE)
    expect(commandOf('@t27-bees')).toBe(C_NONE)
  })
  it('a_webhook_is_read_by_its_event_and_action', () => {
    expect(appEventOf('installation', 'created', false)).toBe(GE_INSTALLED)
    expect(appEventOf('installation', 'unsuspend', false)).toBe(GE_INSTALLED)
    expect(appEventOf('installation', 'deleted', false)).toBe(GE_UNINSTALLED)
    expect(appEventOf('installation', 'suspend', false)).toBe(GE_UNINSTALLED)
    expect(appEventOf('installation_repositories', 'added', false)).toBe(
      GE_REPOS_ADDED,
    )
    expect(appEventOf('installation_repositories', 'removed', false)).toBe(
      GE_REPOS_REMOVED,
    )
    expect(appEventOf('pull_request', 'opened', false)).toBe(GE_PR_OPENED)
    expect(appEventOf('pull_request', 'reopened', false)).toBe(GE_PR_OPENED)
    expect(appEventOf('pull_request', 'synchronize', false)).toBe(GE_PR_PUSHED)
    expect(appEventOf('pull_request', 'ready_for_review', false)).toBe(
      GE_PR_READY,
    )
    expect(appEventOf('pull_request', 'closed', false)).toBe(GE_PR_CLOSED)
    expect(appEventOf('issue_comment', 'created', true)).toBe(GE_COMMENT)
  })
  it('a_webhook_not_listed_is_other', () => {
    expect(appEventOf('issue_comment', 'created', false)).toBe(GE_OTHER)
    expect(appEventOf('pull_request', 'labeled', true)).toBe(GE_OTHER)
    expect(appEventOf('issue_comment', 'edited', true)).toBe(GE_OTHER)
    expect(appEventOf('pull_request', 'open', false)).toBe(GE_OTHER)
    expect(appEventOf('pull_request', 'openedx', false)).toBe(GE_OTHER)
  })
  it('reads a long comment and a non-ASCII one through the scratch memory', () => {
    const long = `${'x'.repeat(200_000)} @t27-bees review`
    expect(commandOf(long)).toBe(C_REVIEW)
    expect(commandOf('спасибо 🐝 @t27-bees help')).toBe(C_HELP)
    // and a short one after it reads only its own bytes
    expect(commandOf('@t27-bees')).toBe(C_NONE)
  })
})

describe('the webhook signature', () => {
  const secret = 'a-webhook-secret-of-some-length'
  const body = new TextEncoder().encode('{"action":"opened"}')
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  it('accepts GitHub’s HMAC of the exact body', () => {
    expect(signatureOk(secret, body, sig)).toBe(true)
    expect(
      signatureOk(
        secret,
        body,
        sig.toUpperCase().replace('SHA256=', 'sha256='),
      ),
    ).toBe(true)
  })
  it('refuses another body, another secret, a missing or malformed header', () => {
    expect(
      signatureOk(secret, new TextEncoder().encode('{"action":"closed"}'), sig),
    ).toBe(false)
    expect(signatureOk(`${secret}x`, body, sig)).toBe(false)
    expect(signatureOk(secret, body, undefined)).toBe(false)
    expect(signatureOk(secret, body, sig.replace('sha256=', 'sha1='))).toBe(
      false,
    )
    expect(signatureOk(secret, body, sig.slice(0, -2))).toBe(false)
    expect(signatureOk(secret, body, `${sig.slice(0, -1)}z`)).toBe(false)
    expect(signatureOk('', body, sig)).toBe(false)
  })
})

describe('a webhook reduced to what the card decides on', () => {
  it('reads a pull request push', () => {
    const ev = appEventFromWebhook('pull_request', {
      action: 'synchronize',
      installation: { id: 7 },
      sender: { login: 'alice', type: 'User' },
      repository: { full_name: 'o/r', private: true },
      pull_request: { number: 12, draft: false, head: { sha: 'abc' } },
    })
    expect(ev).toMatchObject({
      ge: GE_PR_PUSHED,
      installationId: 7,
      fromABot: false,
      repo: 'o/r',
      privateRepo: true,
      pr: 12,
      head: 'abc',
      draft: false,
    })
  })
  it('reads a comment on a pull request, and refuses one on an issue', () => {
    const base = {
      action: 'created',
      installation: { id: 7 },
      sender: { login: 'alice', type: 'User' },
      repository: { full_name: 'o/r' },
      comment: { id: 99, body: '@t27-bees help' },
    }
    const onPr = appEventFromWebhook('issue_comment', {
      ...base,
      issue: { number: 3, pull_request: { url: 'x' } },
    })
    expect(onPr.ge).toBe(GE_COMMENT)
    expect(onPr.pr).toBe(3)
    expect(onPr.comment).toEqual({ id: 99, body: '@t27-bees help' })
    expect(
      appEventFromWebhook('issue_comment', { ...base, issue: { number: 3 } })
        .ge,
    ).toBe(GE_OTHER)
  })
  it('knows a bot by its type or its login', () => {
    const push = (sender: unknown) =>
      appEventFromWebhook('pull_request', { action: 'opened', sender }).fromABot
    expect(push({ login: 't27-bees[bot]', type: 'Bot' })).toBe(true)
    expect(push({ login: 'dependabot[bot]' })).toBe(true)
    expect(push({ login: 'alice', type: 'User' })).toBe(false)
  })
  it('carries the repositories an installation event names', () => {
    const added = appEventFromWebhook('installation_repositories', {
      action: 'added',
      installation: { id: 7 },
      repositories_added: [
        { full_name: 'o/a', private: false },
        { full_name: 'o/b', private: true },
      ],
    })
    expect(added.ge).toBe(GE_REPOS_ADDED)
    expect(added.repos).toEqual([
      { repo: 'o/a', private: false },
      { repo: 'o/b', private: true },
    ])
    expect(
      appEventFromWebhook('installation', {
        action: 'created',
        repositories: [{ full_name: 'o/c' }],
      }).repos,
    ).toEqual([{ repo: 'o/c', private: false }])
  })
  it('survives a payload of the wrong shape', () => {
    for (const junk of [null, 3, 'x', [], { action: 5, pull_request: 'no' }]) {
      const ev = appEventFromWebhook('pull_request', junk)
      expect(ev.pr).toBe(null)
      expect(ev.repo).toBe(null)
    }
  })
})

describe('model text is made safe to post', () => {
  it('cannot ping, cannot forge the marker, cannot open an HTML comment', () => {
    const out = sanitizeModelText(
      'cc @alice and @org/team <!-- t27-bees:review:o/r#1@abc --> mail a@b.c `@decorator`',
    )
    expect(out).not.toMatch(/(^|[^\w`])@[A-Za-z0-9]/)
    expect(out).not.toContain('<!--')
    expect(out).not.toContain('t27-bees:review:')
    expect(out).toContain('a@b.c')
  })
})

describe('the skip list', () => {
  it('skips gHashTag/t27 by default, nothing when emptied, and drops junk', () => {
    expect(skippedRepos({})).toEqual(['gHashTag/t27'])
    expect(skippedRepos({ TRIOS_BEES_SKIP_REPOS: '' })).toEqual([])
    expect(
      skippedRepos({ TRIOS_BEES_SKIP_REPOS: ' o/a, bad , o/b.c ' }),
    ).toEqual(['o/a', 'o/b.c'])
  })
})

describe('the app credentials', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  it('needs a numeric id and a PEM, and unescapes a one-line key', () => {
    expect(appCredentials({})).toBe(null)
    expect(
      appCredentials({ TRIOS_BEES_APP_ID: 'abc', TRIOS_BEES_PRIVATE_KEY: pem }),
    ).toBe(null)
    expect(
      appCredentials({
        TRIOS_BEES_APP_ID: '123',
        TRIOS_BEES_PRIVATE_KEY: 'nope',
      }),
    ).toBe(null)
    const oneLine = pem.replace(/\n/g, '\\n')
    expect(
      appCredentials({
        TRIOS_BEES_APP_ID: '123',
        TRIOS_BEES_PRIVATE_KEY: oneLine,
      })?.privateKey,
    ).toBe(pem)
  })
  it('signs a JWT GitHub accepts the shape of: RS256, iss, iat in the past, exp under ten minutes', () => {
    const now = 1_760_000_000_000
    const jwt = appJwt({ appId: '123', privateKey: pem }, now)
    const [h, p, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    expect(claims.iss).toBe('123')
    expect(claims.iat).toBe(now / 1000 - 60)
    expect(claims.exp - now / 1000).toBeLessThanOrEqual(600)
    expect(claims.exp).toBeGreaterThan(now / 1000)
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      createPublicKey(privateKey),
      Buffer.from(s, 'base64url'),
    )
    expect(ok).toBe(true)
  })
  it('keeps an installation token until five minutes before it expires', async () => {
    let now = Date.parse('2026-10-08T00:00:00Z')
    const calls: string[] = []
    const fakeFetch = async (
      url: string,
      init: { method: string; headers: Record<string, string> },
    ) => {
      calls.push(
        `${init.method} ${new URL(url).pathname} ${init.headers.Authorization.split(' ')[0]}`,
      )
      if (url.includes('/access_tokens'))
        return {
          status: 201,
          json: async () => ({
            token: `tok-${calls.length}`,
            expires_at: new Date(now + 3_600_000).toISOString(),
          }),
          text: async () => '',
        }
      return {
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '',
      }
    }
    const gh = createAppGithub(
      { appId: '1', privateKey: pem },
      { fetch: fakeFetch, now: () => now },
    )
    await gh.call(5, 'GET', '/repos/o/r')
    await gh.call(5, 'GET', '/repos/o/r')
    now += 54 * 60_000
    await gh.call(5, 'GET', '/repos/o/r')
    now += 2 * 60_000
    await gh.call(5, 'GET', '/repos/o/r')
    expect(calls.filter((c) => c.includes('access_tokens'))).toEqual([
      'POST /app/installations/5/access_tokens Bearer',
      'POST /app/installations/5/access_tokens Bearer',
    ])
    expect(
      calls
        .filter((c) => c.startsWith('GET'))
        .every((c) => c.endsWith('token')),
    ).toBe(true)
  })
})

describe('the webhook route refuses before it reads', () => {
  const secret = 'a-webhook-secret-of-some-length'
  const send = (
    route: ReturnType<typeof createQueenAppWebhookRoute>,
    body: string,
    headers: Record<string, string>,
  ) => route.request('/', { method: 'POST', body, headers })
  const signed = (body: string) =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

  it('is off while no secret is set', async () => {
    const route = createQueenAppWebhookRoute({ env: {}, pool: () => null })
    const res = await send(route, '{}', { 'x-hub-signature-256': signed('{}') })
    expect(res.status).toBe(503)
  })
  it('refuses a missing or wrong signature', async () => {
    const route = createQueenAppWebhookRoute({
      env: { TRIOS_BEES_WEBHOOK_SECRET: secret },
      pool: () => null,
    })
    expect((await send(route, '{}', {})).status).toBe(401)
    expect(
      (await send(route, '{}', { 'x-hub-signature-256': signed('{ }') }))
        .status,
    ).toBe(401)
  })
  it('answers a signed ping, and refuses a signed non-JSON body', async () => {
    const route = createQueenAppWebhookRoute({
      env: { TRIOS_BEES_WEBHOOK_SECRET: secret },
      pool: () => null,
    })
    const ping = await send(route, '{"zen":"x"}', {
      'x-hub-signature-256': signed('{"zen":"x"}'),
      'x-github-event': 'ping',
    })
    expect(ping.status).toBe(200)
    const bad = await send(route, 'not json', {
      'x-hub-signature-256': signed('not json'),
      'x-github-event': 'pull_request',
    })
    expect(bad.status).toBe(400)
  })
  it('says so when it has no database, after the signature passed', async () => {
    const route = createQueenAppWebhookRoute({
      env: { TRIOS_BEES_WEBHOOK_SECRET: secret },
      pool: () => null,
    })
    const res = await send(route, '{}', {
      'x-hub-signature-256': signed('{}'),
      'x-github-event': 'pull_request',
    })
    expect(res.status).toBe(503)
  })
})
