import { afterEach, describe, expect, it } from 'bun:test'

import { githubReadHeaders } from '../../src/api/services/queen-tick'

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
