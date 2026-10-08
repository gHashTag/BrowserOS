/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A MULTI-STEP JOB THE QUEEN DRIVES TO ITS END, WITH NO SESSION OPEN ANYWHERE
 * (gHashTag/t27 specs/queen/jobs.t27, t27#7676).
 *
 * The t27c 0.5.0 release was run by a Claude session from a laptop, on a
 * 15-minute cron, for about three hours: poll the queue, check the manifests,
 * tag, publish, watch the pipeline, delete its own cron. Every step was a
 * decision the spec now makes and every wait was for something the Queen
 * already sees. Here the Queen does it: a job is a row, each round (and each
 * control event) advances every running job by what its next step answers.
 *
 * WHAT IS DECIDED WHERE. Every decision is in the specs and mirrored in
 * queen-jobs-rules.ts / queen-control-rules.ts: what a step's answer does
 * (step_action), when an effect may run (effect_may_run), what the effects
 * journal does before a publish (effect_action, after_look). The job card
 * (specs/jobs/<card>.t27, vendored, read by the compiler wasm) names the steps.
 * What is written here is I/O: reading GitHub and the registry, and the one
 * effect, a GitHub release, through the journal.
 *
 * CREDENTIALS. Reads use the Queen's read token, as every other GitHub read
 * here does. The publish step needs TRIOS_QUEEN_RELEASE_TOKEN (contents:
 * write on the repository); without it the step answers BLOCKED and the job
 * waits, visibly, until the token exists or the wait limit fails it. A
 * rehearsal needs no token: it walks every step and records what the publish
 * would have done.
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { DEFAULT_SPECS_ROOT } from '../../inngest/spec-catalog'
import { type Analyze, loadCompiler } from '../../inngest/t27-consts'
import { QUEEN_JOBS_SQL } from '../../lib/db/pg-migrate'
import { logger } from '../../lib/logger'
import {
  afterLook,
  DO_GIVE_UP,
  DO_LOOK,
  DO_NOTHING,
  DO_RUN,
  DO_SKIP,
  EFF_DONE,
  EFF_INTENT,
  EFF_NONE,
  EK_RELEASE,
  effectAction,
  runsAfterIntent,
} from './queen-control-rules'
import {
  A_FAIL,
  A_RETRY,
  E_REFUSE,
  E_REHEARSE,
  effectMayRun,
  J_CANCELLED,
  J_RUNNING,
  jobCancelAllowed,
  jobStateAfter,
  O_BLOCKED,
  O_FAIL,
  O_NOT_YET,
  O_PASS,
  SK_CHECK,
  SK_EFFECT,
  STEP_KINDS,
  stepAction,
  stepAfter,
} from './queen-jobs-rules'

/** A job card, as its constants say. */
export interface JobCard {
  name: string
  file: string
  repo: string
  baseBranch: string
  crate: string
  tagPrefix: string
  releaseWorkflow: string
  cargoManifest: string
  zenodoFile: string
  params: string[]
  stepKind: number[]
  stepWhat: string[]
  publishStep: number
}

/** Cards the Queen may run, by name -> vendored file. A closed list. */
export const JOB_CARDS: Record<string, string> = {
  'release-t27c': 'jobs/release_t27c.t27',
}

const cardCache = new Map<string, Promise<JobCard>>()

/**
 * Read a card through the real compiler, as loadControlSpec reads the control
 * card: one that does not typecheck, drops a token, or whose arrays disagree is
 * refused, with no fallback.
 */
export async function loadJobCard(
  name: string,
  root: string = DEFAULT_SPECS_ROOT,
): Promise<JobCard> {
  const file = JOB_CARDS[name]
  if (!file) throw new Error(`no job card named ${JSON.stringify(name)}`)
  const key = `${resolve(root)}:${name}`
  const cached = cardCache.get(key)
  if (cached) return cached
  const read = async (): Promise<JobCard> => {
    const text = await readFile(join(root, file), 'utf8')
    const wasm = new Uint8Array(await readFile(join(root, 't27_compiler.wasm')))
    const analyze: Analyze = await loadCompiler(wasm)
    const a = analyze(text)
    if (!a.typecheckOk)
      throw new Error(`${file}: typecheck: ${a.errors} error(s)`)
    if (a.discarded > 0)
      throw new Error(`${file}: parser discarded ${a.discarded} token(s)`)
    const str = (k: string): string => {
      const v = a.consts[k]?.value
      if (typeof v !== 'string') throw new Error(`${file}: ${k} is missing`)
      return v
    }
    const num = (k: string): number => {
      const v = a.consts[k]?.value
      if (typeof v !== 'number') throw new Error(`${file}: ${k} is missing`)
      return v
    }
    const list = (k: string): unknown[] => {
      const v = a.consts[k]?.value
      if (!Array.isArray(v)) throw new Error(`${file}: ${k} is missing`)
      return v
    }
    const card: JobCard = {
      name: str('JOB_NAME'),
      file,
      repo: str('REPO'),
      baseBranch: str('BASE_BRANCH'),
      crate: str('CRATE'),
      tagPrefix: str('TAG_PREFIX'),
      releaseWorkflow: str('RELEASE_WORKFLOW'),
      cargoManifest: str('CARGO_MANIFEST'),
      zenodoFile: str('ZENODO_FILE'),
      params: list('PARAMS').map(String),
      stepKind: list('STEP_KIND').map(Number),
      stepWhat: list('STEP_WHAT').map(String),
      publishStep: num('PUBLISH_STEP'),
    }
    const count = num('STEP_COUNT')
    if (card.name !== name)
      throw new Error(`${file}: JOB_NAME is ${card.name}, asked for ${name}`)
    if (card.stepKind.length !== count || card.stepWhat.length !== count)
      throw new Error(`${file}: STEP_COUNT disagrees with its step lists`)
    if (card.stepKind.some((k) => !(k >= 0 && k < STEP_KINDS)))
      throw new Error(`${file}: a step kind is not one of jobs.t27's`)
    return card
  }
  const p = read()
  cardCache.set(key, p)
  p.catch(() => cardCache.delete(key))
  return p
}

export async function ensureJobTables(pool: Pool): Promise<void> {
  await pool.query(QUEEN_JOBS_SQL)
}

export interface JobRow {
  id: number
  card: string
  params: Record<string, string>
  rehearsal: boolean
  state: number
  step: number
  step_runs: number
  step_started_at: string
  subject: string | null
  checks_at_subject: boolean
  note: string | null
  log: unknown[]
  started_by: string
  created_at: string
  updated_at: string
}

export type StartResult =
  | { ok: true; job: JobRow }
  | { ok: false; status: 400 | 409; error: string }

/** Start a job of a card (job_may_start: one running job per card). */
export async function startJob(
  pool: Pool,
  cardName: string,
  params: Record<string, unknown>,
  rehearsal: boolean,
  by: string,
): Promise<StartResult> {
  let card: JobCard
  try {
    card = await loadJobCard(cardName)
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const clean: Record<string, string> = {}
  for (const p of card.params) {
    const v = params[p]
    if (typeof v !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(v)) {
      return { ok: false, status: 400, error: `parameter ${p} is required` }
    }
    clean[p] = v
  }
  // The unique index on (card) WHERE state = running is job_may_start in the
  // database: two starts that race cannot both insert.
  const inserted = await pool.query(
    `INSERT INTO queen_job (card, params, rehearsal, started_by)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [cardName, JSON.stringify(clean), rehearsal, by],
  )
  if (!inserted.rowCount) {
    return {
      ok: false,
      status: 409,
      error: `a ${cardName} job is already running (one per card)`,
    }
  }
  logger.info('Queen job started', {
    id: inserted.rows[0].id,
    card: cardName,
    rehearsal,
    by,
  })
  return { ok: true, job: inserted.rows[0] as JobRow }
}

export async function getJob(pool: Pool, id: number): Promise<JobRow | null> {
  const r = await pool.query('SELECT * FROM queen_job WHERE id = $1', [id])
  return (r.rows[0] as JobRow) ?? null
}

export async function listJobs(pool: Pool, limit = 20): Promise<JobRow[]> {
  const r = await pool.query(
    'SELECT * FROM queen_job ORDER BY id DESC LIMIT $1',
    [limit],
  )
  return r.rows as JobRow[]
}

/** cancel_allowed: a running job stops; nothing it did is undone. */
export async function cancelJob(
  pool: Pool,
  id: number,
  by: string,
): Promise<'cancelled' | 'not-running' | 'none'> {
  const job = await getJob(pool, id)
  if (!job) return 'none'
  if (!jobCancelAllowed(job.state)) return 'not-running'
  const r = await pool.query(
    `UPDATE queen_job SET state = $2, note = $3, updated_at = now()
      WHERE id = $1 AND state = $4`,
    [id, J_CANCELLED, `cancelled by ${by}`, J_RUNNING],
  )
  return (r.rowCount ?? 0) > 0 ? 'cancelled' : 'not-running'
}

/** What one executor answered. */
export interface StepAnswer {
  outcome: number
  detail: string
  /** The commit a CHECK pinned as the job's subject. */
  subject?: string
}

/** The I/O a job needs; a test replaces it. */
export interface JobIo {
  /** GET, returning the status and the parsed JSON body (null for none). */
  get: (
    url: string,
    auth: 'read' | 'none',
  ) => Promise<{ status: number; body: unknown }>
  /** POST JSON with the release credential. */
  postRelease: (
    url: string,
    payload: unknown,
  ) => Promise<{ status: number; body: unknown }>
  /** Whether the release credential exists in this deployment. */
  hasReleaseToken: () => boolean
}

const UA = 't27-queen (github.com/gHashTag/t27)'

export const defaultJobIo: JobIo = {
  async get(url, auth) {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': UA,
    }
    const token = process.env.TRIOS_GITHUB_API_TOKEN?.trim()
    if (auth === 'read' && token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { status: res.status, body }
  },
  async postRelease(url, payload) {
    const token = process.env.TRIOS_QUEEN_RELEASE_TOKEN?.trim()
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { status: res.status, body }
  },
  hasReleaseToken: () => Boolean(process.env.TRIOS_QUEEN_RELEASE_TOKEN?.trim()),
}

const gh = (card: JobCard, path: string): string =>
  `https://api.github.com/repos/${card.repo}${path}`

const field = (body: unknown, k: string): unknown =>
  body && typeof body === 'object'
    ? (body as Record<string, unknown>)[k]
    : undefined

/** The first `version = "..."` line of a Cargo manifest - release.yml's VERSION TRUTH reading. */
export function cargoVersion(text: string): string | null {
  for (const line of text.split('\n')) {
    if (/^version/.test(line)) {
      const m = line.match(/"([^"]*)"/)
      return m ? m[1] : null
    }
  }
  return null
}

async function fileAt(
  io: JobIo,
  card: JobCard,
  path: string,
  sha: string,
): Promise<string | null> {
  const r = await io.get(
    gh(card, `/contents/${path}?ref=${encodeURIComponent(sha)}`),
    'read',
  )
  const content = field(r.body, 'content')
  if (r.status !== 200 || typeof content !== 'string') return null
  return Buffer.from(content, 'base64').toString('utf8')
}

/** One executor per step name the card may use. A name not here fails. */
export type Executor = (ctx: {
  job: JobRow
  card: JobCard
  io: JobIo
  pool: Pool
}) => Promise<StepAnswer>

const tagOf = (job: JobRow, card: JobCard): string =>
  `${card.tagPrefix}${job.params.version}`

export const EXECUTORS: Record<string, Executor> = {
  async 'version-truth'({ job, card, io }) {
    const version = job.params.version
    let subject = job.subject
    if (!subject) {
      const head = await io.get(gh(card, `/commits/${card.baseBranch}`), 'read')
      const sha = field(head.body, 'sha')
      if (head.status !== 200 || typeof sha !== 'string')
        return {
          outcome: O_FAIL,
          detail: `could not read ${card.baseBranch} (${head.status})`,
        }
      subject = sha
    }
    const cargo = await fileAt(io, card, card.cargoManifest, subject)
    const zenodo = await fileAt(io, card, card.zenodoFile, subject)
    if (cargo === null || zenodo === null)
      return {
        outcome: O_FAIL,
        detail: 'a manifest could not be read',
        subject,
      }
    const c = cargoVersion(cargo)
    let z: unknown = null
    try {
      z = field(JSON.parse(zenodo), 'version')
    } catch {
      z = null
    }
    if (c !== version || z !== version)
      return {
        outcome: O_FAIL,
        detail: `${card.cargoManifest} says ${c}, ${card.zenodoFile} says ${String(z)}, wanted ${version}`,
        subject,
      }
    return {
      outcome: O_PASS,
      detail: `both manifests say ${version} at ${subject.slice(0, 12)}`,
      subject,
    }
  },

  async 'tag-absent'({ job, card, io }) {
    const tag = tagOf(job, card)
    const ref = await io.get(gh(card, `/git/ref/tags/${tag}`), 'read')
    if (ref.status === 200)
      return { outcome: O_FAIL, detail: `tag ${tag} already exists` }
    if (ref.status !== 404)
      return {
        outcome: O_FAIL,
        detail: `could not read tag ${tag} (${ref.status})`,
      }
    const crate = await io.get(
      `https://crates.io/api/v1/crates/${card.crate}/${job.params.version}`,
      'none',
    )
    if (crate.status === 200)
      return {
        outcome: O_FAIL,
        detail: `${card.crate} ${job.params.version} is already on the registry`,
      }
    if (crate.status !== 404)
      return {
        outcome: O_FAIL,
        detail: `could not read the registry (${crate.status})`,
      }
    return {
      outcome: O_PASS,
      detail: `no tag ${tag}, no ${card.crate} ${job.params.version} on the registry`,
    }
  },

  async 'github-release'({ job, card, io, pool }) {
    const tag = tagOf(job, card)
    const step = job.step
    const may = effectMayRun(
      job.rehearsal,
      job.subject !== null,
      job.checks_at_subject,
    )
    if (may === E_REFUSE)
      return { outcome: O_FAIL, detail: 'refused: no checked, pinned subject' }
    if (may === E_REHEARSE)
      return {
        outcome: O_PASS,
        detail: `rehearsal: would publish release ${tag} at ${String(job.subject).slice(0, 12)}`,
      }
    if (!io.hasReleaseToken())
      return {
        outcome: O_BLOCKED,
        detail:
          'blocked: TRIOS_QUEEN_RELEASE_TOKEN is not set in this deployment',
      }
    // The effects journal (control.t27 section 7): a Queen that restarted
    // mid-publish looks before she publishes, and never publishes twice.
    const key = `job:${job.id}:step:${step}:release:${tag}`
    const entry = await readEffect(pool, key)
    let action = effectAction(entry.state, EK_RELEASE, entry.runs, 0, 0)
    if (action === DO_LOOK) {
      const found = await io.get(gh(card, `/releases/tags/${tag}`), 'read')
      action = afterLook(found.status === 200, entry.runs)
      if (action === DO_SKIP) {
        await doneEffect(pool, key, { found: true })
        return {
          outcome: O_PASS,
          detail: `release ${tag} found published (journal look-up)`,
        }
      }
    }
    if (action === DO_SKIP)
      return {
        outcome: O_PASS,
        detail: `release ${tag} already published (journal)`,
      }
    if (action === DO_GIVE_UP || action === DO_NOTHING)
      return {
        outcome: O_FAIL,
        detail: `release ${tag}: the journal gave up after ${entry.runs} run(s)`,
      }
    if (action !== DO_RUN)
      return {
        outcome: O_FAIL,
        detail: `release ${tag}: unknown journal action ${action}`,
      }
    await intentEffect(pool, key, runsAfterIntent(entry.runs))
    const r = await io.postRelease(gh(card, '/releases'), {
      tag_name: tag,
      target_commitish: job.subject,
      name: `${card.crate} v${job.params.version}`,
      generate_release_notes: true,
    })
    if (r.status === 201) {
      await doneEffect(pool, key, {
        id: field(r.body, 'id'),
        url: field(r.body, 'html_url'),
      })
      return {
        outcome: O_PASS,
        detail: `published release ${tag} at ${String(job.subject).slice(0, 12)}`,
      }
    }
    return {
      outcome: O_FAIL,
      detail: `release ${tag}: GitHub answered ${r.status}`,
    }
  },

  async 'release-workflow'({ job, card, io }) {
    if (job.rehearsal)
      return {
        outcome: O_PASS,
        detail: 'rehearsal: no release, so no pipeline to wait for',
      }
    const runs = await io.get(
      gh(
        card,
        `/actions/workflows/${card.releaseWorkflow}/runs?event=release&head_sha=${job.subject}&per_page=5`,
      ),
      'read',
    )
    const list = field(runs.body, 'workflow_runs')
    if (runs.status !== 200 || !Array.isArray(list))
      return {
        outcome: O_NOT_YET,
        detail: `could not read the pipeline (${runs.status})`,
      }
    const run = list[0] as Record<string, unknown> | undefined
    if (!run)
      return {
        outcome: O_NOT_YET,
        detail: 'the release pipeline has not started',
      }
    if (run.status !== 'completed')
      return {
        outcome: O_NOT_YET,
        detail: `the release pipeline is ${String(run.status)}`,
      }
    if (run.conclusion === 'success')
      return {
        outcome: O_PASS,
        detail: `the release pipeline succeeded (${String(run.html_url)})`,
      }
    return {
      outcome: O_FAIL,
      detail: `the release pipeline ended ${String(run.conclusion)} (${String(run.html_url)})`,
    }
  },

  async 'crate-published'({ job, card, io }) {
    if (job.rehearsal)
      return { outcome: O_PASS, detail: 'rehearsal: nothing was published' }
    const r = await io.get(
      `https://crates.io/api/v1/crates/${card.crate}/${job.params.version}`,
      'none',
    )
    if (r.status === 200)
      return {
        outcome: O_PASS,
        detail: `${card.crate} ${job.params.version} is on the registry`,
      }
    return {
      outcome: O_NOT_YET,
      detail: `${card.crate} ${job.params.version} is not on the registry yet`,
    }
  },
}

async function readEffect(
  pool: Pool,
  key: string,
): Promise<{ state: number; runs: number }> {
  const r = await pool.query(
    'SELECT state, runs FROM queen_effect WHERE key = $1',
    [key],
  )
  const row = r.rows[0]
  if (!row) return { state: EFF_NONE, runs: 0 }
  return { state: Number(row.state), runs: Number(row.runs) }
}

async function intentEffect(
  pool: Pool,
  key: string,
  runs: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO queen_effect (key, kind, state, runs)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET state = $3, runs = $4, updated_at = now()`,
    [key, EK_RELEASE, EFF_INTENT, runs],
  )
}

async function doneEffect(
  pool: Pool,
  key: string,
  result: unknown,
): Promise<void> {
  await pool.query(
    `INSERT INTO queen_effect (key, kind, state, runs, result)
     VALUES ($1, $2, $3, 1, $4::jsonb)
     ON CONFLICT (key) DO UPDATE SET state = $3, result = $4::jsonb, updated_at = now()`,
    [key, EK_RELEASE, EFF_DONE, JSON.stringify(result)],
  )
}

/** How many steps one job may take in one round: checks are quick, waits stop it. */
export const STEPS_PER_ROUND = 8

/**
 * Advance every running job by what its next step answers. Called by each
 * round (the Queen's lease makes her the only writer). Never throws: a job
 * whose step crashed is retried on the next round, within step_action's limit.
 */
export async function advanceJobs(
  pool: Pool,
  io: JobIo = defaultJobIo,
  now: () => number = Date.now,
): Promise<number> {
  await ensureJobTables(pool)
  const running = await pool.query(
    'SELECT * FROM queen_job WHERE state = $1 ORDER BY id',
    [J_RUNNING],
  )
  let moved = 0
  for (const row of running.rows as JobRow[]) {
    let job = row
    for (let i = 0; i < STEPS_PER_ROUND && job.state === J_RUNNING; i += 1) {
      const next = await advanceOne(pool, job, io, now).catch((error) => {
        logger.warn('Queen job step crashed', {
          id: job.id,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      })
      if (!next) break
      moved += 1
      const stayed = next.step === job.step && next.state === J_RUNNING
      job = next
      if (stayed) break
    }
  }
  return moved
}

async function advanceOne(
  pool: Pool,
  job: JobRow,
  io: JobIo,
  now: () => number,
): Promise<JobRow | null> {
  const card = await loadJobCard(job.card)
  const kind = card.stepKind[job.step]
  const what = card.stepWhat[job.step]
  const exec = EXECUTORS[what]
  const runs = job.step_runs + 1
  const waited = Math.floor((now() - Date.parse(job.step_started_at)) / 60_000)
  const answer: StepAnswer = exec
    ? await exec({ job, card, io, pool })
    : { outcome: O_FAIL, detail: `no executor named ${what}` }
  const action = stepAction(kind, answer.outcome, runs, waited)
  const state = jobStateAfter(action, job.step, card.stepKind.length)
  const step = stepAfter(action, job.step)
  // The first CHECK pins the subject for the job. A check that passed at a
  // DIFFERENT commit means the effects after it would ship what nobody
  // checked, so the subject stops being "checked" (effect_may_run refuses). A
  // check that failed and then passed on a retry, at the same commit, passed.
  const subject = job.subject ?? answer.subject ?? null
  const checksAtSubject =
    job.checks_at_subject &&
    !(
      kind === SK_CHECK &&
      answer.subject !== undefined &&
      job.subject !== null &&
      answer.subject !== job.subject
    )
  const entry = {
    at: new Date(now()).toISOString(),
    step: job.step,
    what,
    outcome: answer.outcome,
    detail: answer.detail,
  }
  const advanced = step !== job.step
  const r = await pool.query(
    `UPDATE queen_job
        SET state = $2, step = $3,
            step_runs = CASE WHEN $4 THEN 0 ELSE $5 END,
            step_started_at = CASE WHEN $4 THEN now() ELSE step_started_at END,
            subject = $6, checks_at_subject = $7, note = $8,
            log = log || $9::jsonb, updated_at = now()
      WHERE id = $1 AND state = $10
      RETURNING *`,
    [
      job.id,
      state,
      step,
      advanced,
      action === A_RETRY ||
      answer.outcome === O_NOT_YET ||
      answer.outcome === O_BLOCKED
        ? runs
        : job.step_runs,
      subject,
      checksAtSubject,
      answer.detail,
      JSON.stringify([entry]),
      J_RUNNING,
    ],
  )
  if (state !== J_RUNNING || action === A_FAIL || kind === SK_EFFECT) {
    logger.info('Queen job moved', {
      id: job.id,
      card: job.card,
      step: job.step,
      what,
      outcome: answer.outcome,
      state,
      detail: answer.detail,
    })
  }
  return (r.rows[0] as JobRow) ?? null
}
