/**
 * Entry point the HTTP server calls once at start-up: read the cards with the
 * compiler, build the Inngest app, hand back the two routes. Never throws - a
 * contract that cannot be read yields 503 routes that say why, and the rest of
 * the server keeps serving.
 */

import { logger } from '../lib/logger'
import { buildQueenApp, type SchedulerEnv } from './functions'
import {
  createSchedulerRoutes,
  createSchedulerUnavailableRoutes,
  type SchedulerRoutes,
} from './route'
import { loadSpecCatalog } from './spec-catalog'

export async function mountQueenScheduler(
  env: SchedulerEnv = process.env as SchedulerEnv,
  specsRoot?: string,
): Promise<SchedulerRoutes> {
  try {
    const catalog = await loadSpecCatalog(specsRoot)
    const app = buildQueenApp(catalog, { env })
    const scheduled = app.plan.crons.filter((c) => c.cron !== null).length
    logger.info(
      `[queen-scheduler] ${catalog.scheduler.appId}: ${app.plan.crons.length} cron functions (${scheduled} with a schedule), ${app.plan.skills.length} skill functions, ${catalog.refused.length} refused card(s)`,
    )
    for (const r of catalog.refused)
      logger.warn(`[queen-scheduler] refused ${r.file}: ${r.reason}`)
    for (const d of app.plan.danglingRuns)
      logger.warn(
        `[queen-scheduler] ${d.cardId} RUNS ${d.skillId}, which is not a skill card`,
      )
    if (!env.INNGEST_BASE_URL)
      logger.warn(
        '[queen-scheduler] INNGEST_BASE_URL is not set; functions are served but no Inngest server is registered',
      )
    return createSchedulerRoutes(app, env)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.error(`[queen-scheduler] contract unreadable: ${reason}`)
    return createSchedulerUnavailableRoutes(reason)
  }
}

export { buildQueenApp } from './functions'
export { planCatalog } from './plan'
export { loadSpecCatalog } from './spec-catalog'
