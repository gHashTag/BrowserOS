/**
 * The Inngest app `t27-queen`: one function per card, built from the plan.
 *
 * - `cron-<slug>`: fires on the card's SCHEDULE (github-actions cards only) and
 *   on `cron/<ID>.tick`; a github-actions card is workflow-dispatched, any other
 *   HOST only records the tick. When RUNS_FANOUT is on, every skill in RUNS gets
 *   a `skill/<ID>.run` event.
 * - `skill-<slug>`: fires on `skill/<ID>.run` and opens (or reuses) the Queen
 *   issue `[skill] <ID>` in `gHashTag/<REPO>` with the two sections a bee needs.
 */

import { Inngest, type InngestFunction } from 'inngest'
import {
  type FetchLike,
  type GitHubApi,
  dispatchWorkflow,
  openOrReuseIssue,
  skillIssueBody,
} from './dispatch'
import { type Plan, planCatalog, workflowFileOf } from './plan'
import type { SpecCatalog } from './spec-catalog'

export interface SchedulerEnv {
  INNGEST_BASE_URL?: string
  INNGEST_EVENT_KEY?: string
  INNGEST_SIGNING_KEY?: string
  INNGEST_SERVE_HOST?: string
  [key: string]: string | undefined
}

export interface QueenApp {
  client: Inngest
  functions: InngestFunction.Like[]
  plan: Plan
  catalog: SpecCatalog
}

export interface BuildOptions {
  env: SchedulerEnv
  fetch?: FetchLike
  now?: () => string
}

/** The env the contract lists (`ENV`) and which of them are set, for the status route. */
export function envReport(catalog: SpecCatalog, env: SchedulerEnv) {
  const vars = [...catalog.scheduler.env, catalog.scheduler.tokenEnv]
  return Object.fromEntries(vars.map((v) => [v, Boolean(env[v])]))
}

export function buildQueenApp(
  catalog: SpecCatalog,
  opts: BuildOptions,
): QueenApp {
  const { scheduler } = catalog
  const plan = planCatalog(catalog)
  const fetchImpl: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i))
  const now = opts.now ?? (() => new Date().toISOString())
  const api = (): GitHubApi => ({
    fetch: fetchImpl,
    token: opts.env[scheduler.tokenEnv],
  })

  const client = new Inngest({
    id: scheduler.appId,
    baseUrl: opts.env.INNGEST_BASE_URL,
    eventKey: opts.env.INNGEST_EVENT_KEY,
    // v4: the serve handler verifies request signatures with the CLIENT's key.
    signingKey: opts.env.INNGEST_SIGNING_KEY,
    isDev: false,
  })

  const skillByEvent = new Map(plan.skills.map((s) => [s.cardId, s]))
  const cards = new Map(catalog.skills.map((c) => [c.id, c]))

  const cronFunctions = plan.crons.map((p) => {
    const triggers: Array<{ cron: string } | { event: string }> = [
      { event: p.tickEvent },
    ]
    if (p.cron) triggers.unshift({ cron: p.cron })
    return client.createFunction(
      { id: p.functionId, name: `cron ${p.cardId}`, triggers, retries: 3 },
      async ({ event, step }) => {
        const tick = {
          card: p.cardId,
          file: p.file,
          host: p.dispatch,
          firedBy: event.name.startsWith('inngest/') ? 'schedule' : event.name,
          at: now(),
        }
        let dispatched: unknown = null
        if (p.dispatch === 'workflow-dispatch' && p.enabled) {
          dispatched = await step.run('workflow-dispatch', () =>
            dispatchWorkflow(api(), {
              owner: scheduler.githubOwner,
              repo: p.repo,
              workflowFile: workflowFileOf(p.service),
            }),
          )
        }
        let fanout: string[] = []
        if (scheduler.runsFanout && p.runs.length) {
          fanout = p.runs.flatMap((r) => {
            const s = skillByEvent.get(r)
            return s ? [s.runEvent] : []
          })
          if (fanout.length) {
            await step.sendEvent(
              'runs-fanout',
              fanout.map((name) => ({
                name,
                data: { by: p.cardId, cron: p.functionId, at: tick.at },
              })),
            )
          }
        }
        return { tick, dispatched, fanout }
      },
    )
  })

  const skillFunctions = plan.skills.map((p) =>
    client.createFunction(
      {
        id: p.functionId,
        name: `skill ${p.cardId}`,
        triggers: [{ event: p.runEvent }],
        retries: 3,
      },
      async ({ event, step }) => {
        const card = cards.get(p.cardId)
        if (!card) throw new Error(`no card for ${p.cardId}`)
        if (!card.enabled) return { skipped: 'ENABLED = false', card: p.cardId }
        const by = (event.data as { by?: string } | undefined)?.by ?? event.name
        const issue = await step.run('queen-issue', () =>
          openOrReuseIssue(api(), {
            owner: scheduler.githubOwner,
            repo: p.repo,
            title: p.issueTitle,
            label: scheduler.skillIssueLabel,
            body: skillIssueBody(card, scheduler, {
              triggeredBy: by,
              eventId: event.id,
            }),
          }),
        )
        return { card: p.cardId, issue }
      },
    ),
  )

  return {
    client,
    functions: [...cronFunctions, ...skillFunctions],
    plan,
    catalog,
  }
}
