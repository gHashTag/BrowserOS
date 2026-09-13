/**
 * Two Hono apps for the scheduler:
 *
 * - `/api/inngest` - the Inngest serve handler. The Inngest server (999's
 *   self-hosted instance on Railway) PUTs here to register the functions and
 *   POSTs here to run them; every request is signed with INNGEST_SIGNING_KEY and
 *   the SDK verifies it, which is why this route is not behind the trusted-origin
 *   guard: the caller is a server, not a browser.
 * - `/queen/scheduler` - a read-only JSON projection of what was derived from
 *   the cards: each function, its trigger, its dispatch and the reason, the
 *   refused cards, the pin, and WHICH env vars are set (never their values).
 */

import { Hono } from 'hono'
import { serve } from 'inngest/hono'
import { envReport, type QueenApp, type SchedulerEnv } from './functions'

export interface SchedulerRoutes {
  inngest: Hono
  scheduler: Hono
}

export function schedulerProjection(app: QueenApp, env: SchedulerEnv) {
  const { catalog, plan } = app
  return {
    app: catalog.scheduler.appId,
    servePath: catalog.scheduler.servePath,
    version: catalog.scheduler.version,
    pin: catalog.pin,
    env: envReport(catalog, env),
    counts: {
      crons: plan.crons.length,
      cronsScheduled: plan.crons.filter((c) => c.cron !== null).length,
      cronsTickOnly: plan.crons.filter((c) => c.cron === null).length,
      skills: plan.skills.length,
      refused: catalog.refused.length,
      danglingRuns: plan.danglingRuns.length,
    },
    crons: plan.crons.map((c) => ({
      function: c.functionId,
      card: c.cardId,
      file: c.file,
      cron: c.cron,
      tick: c.tickEvent,
      dispatch: c.dispatch,
      repo: c.repo,
      service: c.service,
      runs: c.runs,
      enabled: c.enabled,
      control: c.control,
      reason: c.reason,
    })),
    skills: plan.skills.map((s) => ({
      function: s.functionId,
      card: s.cardId,
      file: s.file,
      run: s.runEvent,
      repo: s.repo,
      issue: s.issueTitle,
      enabled: s.enabled,
    })),
    refused: catalog.refused,
    danglingRuns: plan.danglingRuns,
  }
}

export function createSchedulerRoutes(
  app: QueenApp,
  env: SchedulerEnv,
): SchedulerRoutes {
  const handler = serve({
    client: app.client,
    functions: app.functions,
    servePath: app.catalog.scheduler.servePath,
    serveOrigin: env.INNGEST_SERVE_HOST,
  })
  const inngest = new Hono().all('/*', (c) => handler(c))
  const scheduler = new Hono().get('/', (c) =>
    c.json(schedulerProjection(app, env)),
  )
  return { inngest, scheduler }
}

/** What `/queen/scheduler` says when the CONTRACT itself could not be read. */
export function createSchedulerUnavailableRoutes(
  reason: string,
): SchedulerRoutes {
  const body = { app: null, error: 'scheduler contract unreadable', reason }
  return {
    inngest: new Hono().all('/*', (c) => c.json(body, 503)),
    scheduler: new Hono().get('/', (c) => c.json(body, 503)),
  }
}
