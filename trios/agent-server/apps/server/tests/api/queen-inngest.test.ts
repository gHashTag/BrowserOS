/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The Queen's scheduler, held against its contract
 * (specs/automation/inngest-queen-scheduler.t27, gHashTag/t27#3595):
 *
 * - the vendored cards are read by the real compiler and every one of them
 *   becomes a function; a bad card is refused and the rest are served;
 * - the derivation (schedule only for github-actions, tick-only otherwise,
 *   ids and events from the templates) follows the constants, not this file;
 * - dispatch talks to GitHub the way the contract says (default branch from the
 *   API, 204 or throw; one open issue per skill, reused when it exists);
 * - the two routes answer: the projection is readable, the Inngest endpoint
 *   refuses an unsigned invocation instead of running it.
 */

import { describe, expect, it } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  dispatchWorkflow,
  openOrReuseIssue,
  skillIssueBody,
} from '../../src/inngest/dispatch'
import { buildQueenApp } from '../../src/inngest/functions'
import {
  cronTrigger,
  fill,
  fiveFieldCron,
  planCatalog,
  slug,
  workflowFileOf,
} from '../../src/inngest/plan'
import {
  createSchedulerRoutes,
  schedulerProjection,
} from '../../src/inngest/route'
import {
  DEFAULT_SPECS_ROOT,
  loadSpecCatalog,
} from '../../src/inngest/spec-catalog'

const catalogPromise = loadSpecCatalog()

/** A copy of the vendored specs with extra cards dropped in, for the refusal tests. */
function specsWith(extra: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'queen-specs-'))
  cpSync(DEFAULT_SPECS_ROOT, root, { recursive: true })
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(join(root, rel.split('/').slice(0, -1).join('/')), {
      recursive: true,
    })
    writeFileSync(join(root, rel), text)
  }
  return root
}

const cronCard = (id: string, over: Record<string, string> = {}) =>
  [
    'module cron_test;',
    'pub const KIND : str = "cron";',
    `pub const ID : str = "${id}";`,
    'pub const NAME : str = "test";',
    over.HOST ?? 'pub const HOST : str = "github-actions";',
    'pub const REPO : str = "t27";',
    'pub const SERVICE : str = ".github/workflows/test.yml";',
    'pub const SUMMARY_EN : str = "test card";',
    over.SCHEDULE ?? 'pub const SCHEDULE : str = "0 9 * * *";',
    over.TZ ?? 'pub const TZ : str = "Asia/Bangkok";',
    over.RUNS ?? 'pub const RUNS : [1]str = ["t27/measure-corpus"];',
    'pub const RUNS_NOTE : str = "";',
    over.ENABLED ?? 'pub const ENABLED : bool = true;',
    'pub const ON_FAILURE : str = "issue";',
    'pub const CONTROL : str = "inngest";',
    '',
  ].join('\n')

describe('the vendored catalog, read by the compiler', () => {
  it('holds the contract of t27#3595 and every card of specs/crons + specs/skills', async () => {
    const c = await catalogPromise
    expect(c.scheduler.appId).toBe('t27-queen')
    expect(c.scheduler.servePath).toBe('/api/inngest')
    expect(c.scheduler.scope).toEqual(['specs/crons', 'specs/skills'])
    expect(c.scheduler.env).toEqual([
      'INNGEST_BASE_URL',
      'INNGEST_EVENT_KEY',
      'INNGEST_SIGNING_KEY',
      'INNGEST_SERVE_HOST',
    ])
    expect(c.scheduler.tokenEnv).toBe('TRIOS_GITHUB_API_TOKEN')
    expect(c.crons.length).toBe(33)
    expect(c.skills.length).toBe(26)
    expect(c.refused).toEqual([])
    expect(c.pin).toContain('26294613')
    expect(new Set(c.crons.map((x) => x.host))).toEqual(
      new Set(['github-actions', 'inngest', 'timer', 'railway-cron']),
    )
  })

  it('refuses a card the compiler rejects, one missing a field, and a duplicate ID - and serves the rest', async () => {
    const root = specsWith({
      // The wasm analyzer is lenient: it drops the valueless declaration and
      // still says ok, so the SCHEMA is what refuses this card (measured).
      'crons/zz-broken.t27':
        'module zz;\npub const KIND : str = "cron";\npub const ID : str = ;\n',
      'crons/zz-garbled.t27': 'module zz3;\npub const ID : str = "a" "b";\n',
      'crons/zz-partial.t27':
        'module zz2;\npub const KIND : str = "cron";\npub const ID : str = "x/y";\n',
      'crons/zz-dup.t27': cronCard('github-actions/t27/pr-dashboard'),
      'skills/zz-kind.t27': cronCard('cron-as-skill'),
    })
    const c = await loadSpecCatalog(root)
    expect(c.crons.length).toBe(33)
    expect(c.skills.length).toBe(26)
    const reasons = Object.fromEntries(c.refused.map((r) => [r.file, r.reason]))
    expect(reasons['specs/crons/zz-broken.t27']).toBe('missing ID')
    expect(reasons['specs/crons/zz-garbled.t27']).toMatch(/^compiler: /)
    expect(reasons['specs/crons/zz-partial.t27']).toBe('missing NAME')
    expect(reasons['specs/crons/zz-dup.t27']).toMatch(
      /already declared by specs\/crons\/t27-pr-dashboard.t27/,
    )
    expect(reasons['specs/skills/zz-kind.t27']).toMatch(
      /KIND is "cron", expected skill/,
    )
  })
})

describe('the plan follows the constants', () => {
  it('schedules exactly the enabled github-actions cards with a five-field SCHEDULE; every other HOST is tick-only', async () => {
    const c = await catalogPromise
    const plan = planCatalog(c)
    const scheduled = plan.crons.filter((p) => p.cron !== null)
    const cards = new Map(c.crons.map((x) => [x.id, x]))
    expect(scheduled.length).toBe(12)
    for (const p of scheduled) {
      const card = cards.get(p.cardId)!
      expect(card.host).toBe('github-actions')
      expect(card.enabled).toBe(true)
      expect(fiveFieldCron(card.schedule)).toBe(true)
      expect(p.dispatch).toBe('workflow-dispatch')
      expect(p.cron).toBe(card.schedule) // all vendored cards are UTC
    }
    for (const p of plan.crons.filter((x) => x.cron === null)) {
      const card = cards.get(p.cardId)!
      if (card.host === 'github-actions')
        expect(card.schedule === '' || !card.enabled).toBe(true)
      else expect(p.dispatch).toBe('tick-only')
      expect(p.reason).toMatch(/tick-only/)
    }
    expect(plan.crons.filter((p) => p.dispatch === 'tick-only').length).toBe(21)
    expect(plan.danglingRuns).toEqual([])
  })

  it('derives ids and events from the templates and keeps them unique across 59 functions', async () => {
    const c = await catalogPromise
    const plan = planCatalog(c)
    const ids = [...plan.crons, ...plan.skills].map((f) => f.functionId)
    expect(ids.length).toBe(59)
    expect(new Set(ids).size).toBe(59)
    for (const p of plan.crons) {
      expect(p.functionId).toBe(`cron-${slug(p.cardId)}`)
      expect(p.tickEvent).toBe(`cron/${p.cardId}.tick`)
    }
    for (const p of plan.skills) {
      expect(p.functionId).toBe(`skill-${slug(p.cardId)}`)
      expect(p.runEvent).toBe(`skill/${p.cardId}.run`)
      expect(p.issueTitle).toBe(`[skill] ${p.cardId}`)
    }
    expect(slug('timer/999-multibots-telegraf/render-server.ts:919')).toBe(
      'timer-999-multibots-telegraf-render-server-ts-919',
    )
    expect(fill('cron/<ID>.tick', 'a/b')).toBe('cron/a/b.tick')
    expect(workflowFileOf('.github/workflows/ci.yml')).toBe('ci.yml')
  })

  it('prefixes the trigger with TZ= only when the card is not UTC, and treats a disabled card as tick-only', async () => {
    expect(cronTrigger('0 9 * * *', 'UTC')).toBe('0 9 * * *')
    expect(cronTrigger('0 9 * * *', 'Asia/Bangkok')).toBe(
      'TZ=Asia/Bangkok 0 9 * * *',
    )
    expect(fiveFieldCron('@daily')).toBe(false)
    expect(fiveFieldCron('0 9 * * * *')).toBe(false)
    const root = specsWith({
      'crons/zz-tz.t27': cronCard('github-actions/t27/tz'),
      'crons/zz-off.t27': cronCard('github-actions/t27/off', {
        ENABLED: 'pub const ENABLED : bool = false;',
      }),
      'crons/zz-empty.t27': cronCard('github-actions/t27/empty', {
        SCHEDULE: 'pub const SCHEDULE : str = "";',
      }),
    })
    const plan = planCatalog(await loadSpecCatalog(root))
    const by = new Map(plan.crons.map((p) => [p.cardId, p]))
    expect(by.get('github-actions/t27/tz')?.cron).toBe(
      'TZ=Asia/Bangkok 0 9 * * *',
    )
    expect(by.get('github-actions/t27/off')?.cron).toBeNull()
    expect(by.get('github-actions/t27/off')?.reason).toMatch(/DISABLED_CARD/)
    expect(by.get('github-actions/t27/empty')?.cron).toBeNull()
    expect(by.get('github-actions/t27/empty')?.reason).toMatch(
      /SCHEDULE is empty/,
    )
  })
})

type Call = { url: string; method: string; body?: unknown }
function fakeGitHub(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    const key = `${call.method} ${new URL(url).pathname}`
    const route = routes[key]
    if (!route) return new Response(`no route ${key}`, { status: 404 })
    return route(call)
  }
  return { calls, fetchImpl }
}

describe('dispatch, against a fake GitHub', () => {
  it('workflow-dispatch reads the default branch first and accepts only 204', async () => {
    const gh = fakeGitHub({
      'GET /repos/gHashTag/trinity': () =>
        Response.json({ default_branch: 'main' }),
      'POST /repos/gHashTag/trinity/actions/workflows/codegen.yml/dispatches':
        () => new Response(null, { status: 204 }),
    })
    const r = await dispatchWorkflow(
      { fetch: gh.fetchImpl, token: 'ghp_test' },
      { owner: 'gHashTag', repo: 'trinity', workflowFile: 'codegen.yml' },
    )
    expect(r).toEqual({
      ok: true,
      status: 204,
      ref: 'main',
      workflow: 'codegen.yml',
      repo: 'gHashTag/trinity',
    })
    expect(gh.calls.map((c) => c.method)).toEqual(['GET', 'POST'])
    expect(gh.calls[1].body).toEqual({ ref: 'main', inputs: {} })

    const denied = fakeGitHub({
      'GET /repos/gHashTag/trinity': () =>
        Response.json({ default_branch: 'main' }),
      'POST /repos/gHashTag/trinity/actions/workflows/codegen.yml/dispatches':
        () =>
          new Response('{"message":"Resource not accessible"}', {
            status: 403,
          }),
    })
    await expect(
      dispatchWorkflow(
        { fetch: denied.fetchImpl, token: 'ghp_test' },
        { owner: 'gHashTag', repo: 'trinity', workflowFile: 'codegen.yml' },
      ),
    ).rejects.toThrow(/403/)
    await expect(
      dispatchWorkflow(
        { fetch: gh.fetchImpl, token: undefined },
        { owner: 'gHashTag', repo: 'trinity', workflowFile: 'codegen.yml' },
      ),
    ).rejects.toThrow(/no GitHub token/)
  })

  it('a skill run opens "[skill] <ID>" with both sections, and reuses the open one next time', async () => {
    const c = await catalogPromise
    const card = c.skills.find((s) => s.id === 't27/measure-corpus')!
    const body = skillIssueBody(card, c.scheduler, {
      triggeredBy: 'cron-x',
      eventId: 'evt1',
    })
    expect(body).toContain('## Success Criteria')
    expect(body).toContain('## Boundary')
    expect(body).toContain('specs/skills/t27-measure-corpus.t27')
    expect(body).toContain('event evt1')

    const created: Call[] = []
    const gh = fakeGitHub({
      'GET /repos/gHashTag/t27/issues': () =>
        Response.json(
          created.length
            ? [
                {
                  number: 7,
                  title: '[skill] t27/measure-corpus',
                  html_url: 'u/7',
                },
              ]
            : [],
        ),
      'POST /repos/gHashTag/t27/issues': (call) => {
        created.push(call)
        return Response.json({ number: 7, html_url: 'u/7' }, { status: 201 })
      },
    })
    const api = { fetch: gh.fetchImpl, token: 'ghp_test' }
    const opts = {
      owner: 'gHashTag',
      repo: 't27',
      title: '[skill] t27/measure-corpus',
      body,
      label: 'queen-skill',
    }
    const first = await openOrReuseIssue(api, opts)
    expect(first).toEqual({
      number: 7,
      url: 'u/7',
      reused: false,
      repo: 'gHashTag/t27',
    })
    expect((created[0].body as { labels: string[] }).labels).toEqual([
      'queen-skill',
    ])
    const second = await openOrReuseIssue(api, opts)
    expect(second.reused).toBe(true)
    expect(created.length).toBe(1)
    expect(gh.calls[0].url).toContain('labels=queen-skill')
  })
})

describe('the app and its routes', () => {
  it('builds 59 functions and a projection with counts, reasons and env presence (never values)', async () => {
    const c = await catalogPromise
    const env = {
      INNGEST_SIGNING_KEY: 'signkey-test-secret',
      TRIOS_GITHUB_API_TOKEN: 'ghp_secret',
    }
    const app = buildQueenApp(c, { env })
    expect(app.functions.length).toBe(59)
    const p = schedulerProjection(app, env)
    expect(p.app).toBe('t27-queen')
    expect(p.counts).toEqual({
      crons: 33,
      cronsScheduled: 12,
      cronsTickOnly: 21,
      skills: 26,
      refused: 0,
      danglingRuns: 0,
    })
    expect(p.env).toEqual({
      INNGEST_BASE_URL: false,
      INNGEST_EVENT_KEY: false,
      INNGEST_SIGNING_KEY: true,
      INNGEST_SERVE_HOST: false,
      TRIOS_GITHUB_API_TOKEN: true,
    })
    const text = JSON.stringify(p)
    expect(text).not.toContain('signkey-test-secret')
    expect(text).not.toContain('ghp_secret')
  })

  it('GET /queen/scheduler answers; an unsigned invocation of /api/inngest is refused, not run', async () => {
    const c = await catalogPromise
    const env = { INNGEST_SIGNING_KEY: 'signkey-test-secret' }
    const routes = createSchedulerRoutes(buildQueenApp(c, { env }), env)
    const server = new Hono()
      .route('/api/inngest', routes.inngest)
      .route('/queen/scheduler', routes.scheduler)

    const status = await server.request('/queen/scheduler')
    expect(status.status).toBe(200)
    expect(
      ((await status.json()) as { counts: { skills: number } }).counts.skills,
    ).toBe(26)

    const run = await server.request(
      '/api/inngest?fnId=t27-queen-skill-t27-measure-corpus&stepId=step',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: { name: 'skill/t27/measure-corpus.run', data: {} },
          steps: {},
          ctx: {},
        }),
      },
    )
    expect(run.status).toBeGreaterThanOrEqual(400)
    expect(run.status).toBeLessThan(500)
  })
})
