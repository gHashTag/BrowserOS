/**
 * From a card to a function plan. Pure: no I/O, no Inngest import, so a test
 * can hold the whole derivation against the contract in
 * `specs/automation/inngest-queen-scheduler.t27` without a server.
 *
 * Every rule here is a declared constant of that spec; a rule that is not in
 * the spec is not in this file.
 */

import type {
  CronCard,
  SchedulerSpec,
  SkillCard,
  SpecCatalog,
} from './spec-catalog'

/** `DISPATCH_GITHUB_ACTIONS = "workflow-dispatch"`, everything else `"tick-only"`. */
export type Dispatch = 'workflow-dispatch' | 'tick-only'

export interface CronPlan {
  functionId: string
  cardId: string
  name: string
  file: string
  /** The Inngest cron trigger, `TZ=<tz> <expr>` or null when the card gets none. */
  cron: string | null
  tickEvent: string
  dispatch: Dispatch
  /** Why the plan is what it is, in the words of the contract. */
  reason: string
  repo: string
  service: string
  runs: string[]
  enabled: boolean
  control: string
}

export interface SkillPlan {
  functionId: string
  cardId: string
  name: string
  file: string
  runEvent: string
  repo: string
  issueTitle: string
  enabled: boolean
}

export interface Plan {
  crons: CronPlan[]
  skills: SkillPlan[]
  /** RUNS entries that name no skill card; the contract fans out only to cards. */
  danglingRuns: Array<{ cardId: string; skillId: string }>
}

/** `slug(ID)`: lower-case, every run outside [a-z0-9] becomes one `-`. */
export function slug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function fill(template: string, id: string, slugOf = slug): string {
  return template.replace('<slug>', slugOf(id)).replace('<ID>', id)
}

const CRON_FIELD = /^(\*|[0-9]+|\*\/[0-9]+|[0-9]+-[0-9]+|[0-9,]+)$/

/** A five-field expression, or null; `SCHEDULE_FIELDS = 5`. */
export function fiveFieldCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f))
}

/** The trigger string Inngest reads: `TZ=` prefix only when the card is not UTC. */
export function cronTrigger(schedule: string, tz: string): string {
  return tz === 'UTC' || tz === ''
    ? schedule.trim()
    : `TZ=${tz} ${schedule.trim()}`
}

export function dispatchOf(host: string): Dispatch {
  return host === 'github-actions' ? 'workflow-dispatch' : 'tick-only'
}

export function planCron(card: CronCard, s: SchedulerSpec): CronPlan {
  const dispatch = dispatchOf(card.host)
  let cron: string | null = null
  let reason: string
  if (!card.enabled) {
    reason = 'ENABLED = false: DISABLED_CARD = tick-only'
  } else if (dispatch === 'tick-only') {
    reason =
      card.host === 'inngest'
        ? 'HOST inngest: the 999 app owns the schedule (no double fire); DISPATCH_INNGEST = tick-only'
        : card.host === 'timer'
          ? 'HOST timer: setInterval inside a 999 process, no remote handle; DISPATCH_TIMER = tick-only'
          : `HOST ${card.host}: DISPATCH_RAILWAY_CRON = tick-only`
  } else if (card.schedule === '') {
    reason = 'SCHEDULE is empty: DISABLED_CARD = tick-only'
  } else if (!fiveFieldCron(card.schedule)) {
    reason = `SCHEDULE ${JSON.stringify(card.schedule)} is not a five-field expression: tick-only`
  } else {
    cron = cronTrigger(card.schedule, card.tz)
    reason = `HOST github-actions: DISPATCH_GITHUB_ACTIONS = workflow-dispatch on ${card.schedule} ${card.tz}`
  }
  return {
    functionId: fill(s.cronFunctionId, card.id),
    cardId: card.id,
    name: card.name,
    file: card.file,
    cron,
    tickEvent: fill(s.cronTickEvent, card.id),
    dispatch,
    reason,
    repo: card.repo,
    service: card.service,
    runs: card.runs,
    enabled: card.enabled,
    control: card.control,
  }
}

export function planSkill(card: SkillCard, s: SchedulerSpec): SkillPlan {
  return {
    functionId: fill(s.skillFunctionId, card.id),
    cardId: card.id,
    name: card.name,
    file: card.file,
    runEvent: fill(s.skillRunEvent, card.id),
    repo: card.repo,
    issueTitle: fill(s.skillIssueTitle, card.id),
    enabled: card.enabled,
  }
}

export function planCatalog(catalog: SpecCatalog): Plan {
  const crons = catalog.crons.map((c) => planCron(c, catalog.scheduler))
  const skills = catalog.skills.map((c) => planSkill(c, catalog.scheduler))
  const skillIds = new Set(skills.map((s) => s.cardId))
  const danglingRuns: Plan['danglingRuns'] = []
  for (const c of crons)
    for (const r of c.runs)
      if (!skillIds.has(r)) danglingRuns.push({ cardId: c.cardId, skillId: r })
  const ids = new Set<string>()
  for (const f of [...crons, ...skills]) {
    if (ids.has(f.functionId))
      throw new Error(`function id collision: ${f.functionId}`)
    ids.add(f.functionId)
  }
  return { crons, skills, danglingRuns }
}

/** The workflow file name GitHub's dispatch endpoint takes: the basename of SERVICE. */
export function workflowFileOf(service: string): string {
  return service.split('/').pop() ?? service
}
