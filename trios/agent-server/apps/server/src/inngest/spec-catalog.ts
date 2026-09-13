/**
 * The cards the scheduler serves, read from `trios/agent-server/specs/`.
 *
 * `specs/automation/inngest-queen-scheduler.t27` (gHashTag/t27) is the contract;
 * `specs/crons/*.t27` and `specs/skills/*.t27` are the cards. A card that does
 * not typecheck, drops a token, or lacks a required field is REFUSED and listed
 * under `refused` - the app serves the rest and never guesses a field
 * (`ON_BAD_CARD = "refuse-card-serve-rest"`).
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type Analyze, type SpecConst, loadCompiler } from './t27-consts'

export interface CronCard {
  file: string
  id: string
  name: string
  host: string
  repo: string
  service: string
  summary: string
  schedule: string
  intervalMs: number | null
  tz: string
  runs: string[]
  enabled: boolean
  control: string
  onFailure: string
}

export interface SkillCard {
  file: string
  id: string
  name: string
  repo: string
  source: string
  summary: string
  command: string
  specs: string[]
  tags: string[]
  enabled: boolean
  timeoutMin: number
}

export interface SchedulerSpec {
  appId: string
  servePath: string
  env: string[]
  tokenEnv: string
  githubOwner: string
  scope: string[]
  cronFunctionId: string
  skillFunctionId: string
  cronTickEvent: string
  skillRunEvent: string
  runsFanout: boolean
  skillIssueTitle: string
  skillIssueLabel: string
  skillIssueSections: string[]
  version: number
}

export interface RefusedCard {
  file: string
  reason: string
}

export interface SpecCatalog {
  scheduler: SchedulerSpec
  crons: CronCard[]
  skills: SkillCard[]
  refused: RefusedCard[]
  /** Where the cards were read from, for the status route. */
  root: string
  pin: string
}

const CRON_REQUIRED: Record<string, string> = {
  KIND: 'str',
  ID: 'str',
  NAME: 'str',
  HOST: 'str',
  REPO: 'str',
  SERVICE: 'str',
  SUMMARY_EN: 'str',
  TZ: 'str',
  RUNS: 'arr',
  RUNS_NOTE: 'str',
  ENABLED: 'bool',
  ON_FAILURE: 'str',
  CONTROL: 'str',
}
const SKILL_REQUIRED: Record<string, string> = {
  KIND: 'str',
  ID: 'str',
  NAME: 'str',
  REPO: 'str',
  SOURCE: 'str',
  SUMMARY_EN: 'str',
  COMMAND: 'str',
  SPECS: 'arr',
  TAGS: 'arr',
  ENABLED: 'bool',
  TIMEOUT_MIN: 'u16',
}
const SCHEDULER_REQUIRED: Record<string, string> = {
  APP_ID: 'str',
  SERVE_PATH: 'str',
  ENV: 'arr',
  TOKEN_ENV: 'str',
  GITHUB_OWNER: 'str',
  SCOPE: 'arr',
  CRON_FUNCTION_ID: 'str',
  SKILL_FUNCTION_ID: 'str',
  CRON_TICK_EVENT: 'str',
  SKILL_RUN_EVENT: 'str',
  RUNS_FANOUT: 'bool',
  SKILL_ISSUE_TITLE: 'str',
  SKILL_ISSUE_LABEL: 'str',
  SKILL_ISSUE_SECTIONS: 'arr',
  VERSION: 'u8',
}

function shapeProblem(c: SpecConst, shape: string): string | null {
  const v = c.value
  if (shape === 'str') return typeof v === 'string' ? null : 'expected str'
  if (shape === 'bool') return typeof v === 'boolean' ? null : 'expected bool'
  if (shape === 'arr') return Array.isArray(v) ? null : 'expected array'
  if (shape === 'u8' || shape === 'u16' || shape === 'u32') {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0
      ? null
      : `expected ${shape}`
  }
  return `unknown shape ${shape}`
}

/** The first problem of a card against its schema, or null. */
export function schemaProblem(
  consts: Record<string, SpecConst>,
  required: Record<string, string>,
  kind: string | null,
): string | null {
  if (kind !== null && consts.KIND?.value !== kind)
    return `KIND is ${JSON.stringify(consts.KIND?.value)}, expected ${kind}`
  for (const [name, shape] of Object.entries(required)) {
    const c = consts[name]
    if (!c) return `missing ${name}`
    if (!c.pub) return `${name} must be pub`
    const bad = shapeProblem(c, shape)
    if (bad) return `${name}: ${bad}`
  }
  return null
}

const str = (c: Record<string, SpecConst>, k: string) => String(c[k].value)
const strs = (c: Record<string, SpecConst>, k: string) =>
  (c[k].value as unknown[]).map(String)

export function cronCardOf(
  file: string,
  consts: Record<string, SpecConst>,
): CronCard {
  return {
    file,
    id: str(consts, 'ID'),
    name: str(consts, 'NAME'),
    host: str(consts, 'HOST'),
    repo: str(consts, 'REPO'),
    service: str(consts, 'SERVICE'),
    summary: str(consts, 'SUMMARY_EN'),
    schedule:
      typeof consts.SCHEDULE?.value === 'string' ? consts.SCHEDULE.value : '',
    intervalMs:
      typeof consts.INTERVAL_MS?.value === 'number'
        ? consts.INTERVAL_MS.value
        : null,
    tz: str(consts, 'TZ'),
    runs: strs(consts, 'RUNS'),
    enabled: consts.ENABLED.value === true,
    control: str(consts, 'CONTROL'),
    onFailure: str(consts, 'ON_FAILURE'),
  }
}

export function skillCardOf(
  file: string,
  consts: Record<string, SpecConst>,
): SkillCard {
  return {
    file,
    id: str(consts, 'ID'),
    name: str(consts, 'NAME'),
    repo: str(consts, 'REPO'),
    source: str(consts, 'SOURCE'),
    summary: str(consts, 'SUMMARY_EN'),
    command: str(consts, 'COMMAND'),
    specs: strs(consts, 'SPECS'),
    tags: strs(consts, 'TAGS'),
    enabled: consts.ENABLED.value === true,
    timeoutMin: Number(consts.TIMEOUT_MIN.value),
  }
}

export function schedulerSpecOf(
  consts: Record<string, SpecConst>,
): SchedulerSpec {
  return {
    appId: str(consts, 'APP_ID'),
    servePath: str(consts, 'SERVE_PATH'),
    env: strs(consts, 'ENV'),
    tokenEnv: str(consts, 'TOKEN_ENV'),
    githubOwner: str(consts, 'GITHUB_OWNER'),
    scope: strs(consts, 'SCOPE'),
    cronFunctionId: str(consts, 'CRON_FUNCTION_ID'),
    skillFunctionId: str(consts, 'SKILL_FUNCTION_ID'),
    cronTickEvent: str(consts, 'CRON_TICK_EVENT'),
    skillRunEvent: str(consts, 'SKILL_RUN_EVENT'),
    runsFanout: consts.RUNS_FANOUT.value === true,
    skillIssueTitle: str(consts, 'SKILL_ISSUE_TITLE'),
    skillIssueLabel: str(consts, 'SKILL_ISSUE_LABEL'),
    skillIssueSections: strs(consts, 'SKILL_ISSUE_SECTIONS'),
    version: Number(consts.VERSION.value),
  }
}

/** Analyze one file; null with a reason when the compiler refuses it. */
function analyzeCard(
  analyze: Analyze,
  text: string,
): { consts: Record<string, SpecConst> } | { reason: string } {
  let a: ReturnType<Analyze>
  try {
    a = analyze(text)
  } catch (err) {
    return {
      reason: `compiler: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!a.typecheckOk) return { reason: `typecheck: ${a.errors} error(s)` }
  if (a.discarded > 0)
    return { reason: `parser discarded ${a.discarded} token(s)` }
  return { consts: a.consts }
}

export const DEFAULT_SPECS_ROOT = resolve(import.meta.dir, '../../../../specs')
export const SCHEDULER_SPEC = 'automation/inngest-queen-scheduler.t27'

/**
 * Read the contract and every card. Throws only when the CONTRACT itself is
 * unreadable - without it there is no app to describe; a bad card is refused.
 */
export async function loadSpecCatalog(
  root: string = DEFAULT_SPECS_ROOT,
): Promise<SpecCatalog> {
  const wasm = new Uint8Array(await readFile(join(root, 't27_compiler.wasm')))
  const analyze = await loadCompiler(wasm)
  const pin = (await readFile(join(root, 'PIN'), 'utf8').catch(() => '')).trim()

  const contractText = await readFile(join(root, SCHEDULER_SPEC), 'utf8')
  const contract = analyzeCard(analyze, contractText)
  if ('reason' in contract)
    throw new Error(`${SCHEDULER_SPEC}: ${contract.reason}`)
  const contractProblem = schemaProblem(
    contract.consts,
    SCHEDULER_REQUIRED,
    null,
  )
  if (contractProblem) throw new Error(`${SCHEDULER_SPEC}: ${contractProblem}`)
  const scheduler = schedulerSpecOf(contract.consts)

  const crons: CronCard[] = []
  const skills: SkillCard[] = []
  const refused: RefusedCard[] = []
  const seen = new Map<string, string>()

  for (const dir of scheduler.scope) {
    const sub = dir.replace(/^specs\//, '')
    const names = (await readdir(join(root, sub)))
      .filter((n) => n.endsWith('.t27'))
      .sort()
    for (const name of names) {
      const file = `${dir}/${name}`
      const text = await readFile(join(root, sub, name), 'utf8')
      const r = analyzeCard(analyze, text)
      if ('reason' in r) {
        refused.push({ file, reason: r.reason })
        continue
      }
      const isCron = sub === 'crons'
      const problem = schemaProblem(
        r.consts,
        isCron ? CRON_REQUIRED : SKILL_REQUIRED,
        isCron ? 'cron' : 'skill',
      )
      if (problem) {
        refused.push({ file, reason: problem })
        continue
      }
      const id = String(r.consts.ID.value)
      const other = seen.get(`${sub}:${id}`)
      if (other) {
        refused.push({ file, reason: `ID ${id} already declared by ${other}` })
        continue
      }
      seen.set(`${sub}:${id}`, file)
      if (isCron) crons.push(cronCardOf(file, r.consts))
      else skills.push(skillCardOf(file, r.consts))
    }
  }
  return { scheduler, crons, skills, refused, root, pin }
}
