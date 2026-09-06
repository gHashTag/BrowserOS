import { afterEach, describe, expect, it } from 'bun:test'

import {
  githubReadHeaders,
  openIssues,
} from '../../src/api/services/queen-tick'

/**
 * The round died 144 times in twelve hours on `GitHub returned 403`, and the
 * swarm sat with zero bees for half of the wall clock, because every GitHub
 * read went out anonymous - sixty requests an hour - while `GH_TOKEN` sat in
 * the environment unused.
 *
 * These cases pin the header, not the fetch: a test that mocked `fetch` would
 * pass against a call that still forgot to ask for these headers.
 */
describe('githubReadHeaders', () => {
  const saved = { gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN }

  afterEach(() => {
    if (saved.gh === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = saved.gh
    if (saved.github === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = saved.github
  })

  it('carries the token this service actually has', () => {
    delete process.env.GITHUB_TOKEN
    process.env.GH_TOKEN = 'test-token-value'
    // GH_TOKEN is the name set on the deployed service. Reading only
    // GITHUB_TOKEN would leave the limit at sixty an hour on the one
    // deployment that matters, and every test here would still pass.
    expect(githubReadHeaders().Authorization).toBe('Bearer test-token-value')
  })

  it('accepts GITHUB_TOKEN as well, so a differently-configured host still works', () => {
    delete process.env.GH_TOKEN
    process.env.GITHUB_TOKEN = 'other-token'
    expect(githubReadHeaders().Authorization).toBe('Bearer other-token')
  })

  it('stays anonymous when there is no token, rather than failing to start', () => {
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    const headers = githubReadHeaders()
    expect(headers.Authorization).toBeUndefined()
    // A local run with no secrets must behave as it always has.
    expect(headers.Accept).toBe('application/vnd.github+json')
  })

  it('always asks for the JSON media type', () => {
    process.env.GH_TOKEN = 'x'
    expect(githubReadHeaders().Accept).toBe('application/vnd.github+json')
  })
})

/**
 * One 403 used to take the whole round with it - no review, no choice, no
 * dispatch - and 135 of 136 round failures measured on 2026-09-06 were exactly
 * that, leaving the swarm with ZERO bees for half the day.
 *
 * `globalThis.fetch` is replaced and restored here rather than mocked with
 * `mock.module`, which is process-global in bun and cannot be undone: a fake
 * left behind by this file would be inherited by every test that ran after it.
 */
describe('openIssues when GitHub refuses', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const page = (n: number) =>
    new Response(
      JSON.stringify(
        Array.from({ length: n }, (_, i) => ({
          number: i + 1,
          title: 't',
          body: 'b',
        })),
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  it('treats a refusal on a later page as a truncated list, not a dead round', async () => {
    let call = 0
    globalThis.fetch = (async () => {
      call += 1
      return call === 1
        ? page(100)
        : new Response('rate limited', { status: 403 })
    }) as typeof fetch

    const got = await openIssues('owner/repo')
    // The work from page one survives, and the caller is told it is partial.
    expect(got.issues).toHaveLength(100)
    expect(got.complete).toBe(false)
  })

  it('still throws when the FIRST page is refused, because nothing was read', async () => {
    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 403 })) as typeof fetch
    // A round with no issue list at all has nothing to decide against, so this
    // one must stay fatal - tolerating it would dispatch against an empty board.
    await expect(openIssues('owner/repo')).rejects.toThrow(
      'GitHub returned 403',
    )
  })

  it('marks a short page complete, as it always has', async () => {
    globalThis.fetch = (async () => page(7)) as typeof fetch
    const got = await openIssues('owner/repo')
    expect(got.issues).toHaveLength(7)
    expect(got.complete).toBe(true)
  })
})
