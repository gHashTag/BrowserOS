/**
 * A bee's terminal recording: the commands that prove its work, as asciicast v2.
 *
 * WHY. A bee's VERDICT block is its own word. The review already measures what
 * it can (t27c on the commit, the criteria commands), but the commands the bee
 * says it ran - the test, the `tri` step the issue named - were never seen by
 * anyone. This records them where the bee runs them, real output bytes at the
 * real time they arrived, with each command's exit code, so the Queen's review
 * can check the recording and the operator can replay it.
 *
 * THE FORMAT IS `tri cast`'s (skills/trinity-blog/scripts/termgif.py
 * `record`), field for field, so `tri cast check` / `tri cast publish` accept a
 * bee cast unchanged: a header line `{version: 2, width, height, timestamp,
 * title, commands, redacted}`, then `[t, "o", text]` events, and after each
 * command one `[t, "x", "<exit code>"]` event. The prompt and the typing of
 * each command are staged (as termgif stages them); everything a command
 * printed is real.
 *
 * TWO HONEST DIFFERENCES from termgif. The bee container has no pty helper, so
 * commands run on pipes with stderr merged into stdout (`exec 2>&1`): order is
 * preserved, but a program that colours only on a terminal prints plain text.
 * And the staged typing is not slept through - its 35 ms per key is added to
 * the clock instead of being waited out, so a bee does not spend its turn
 * watching itself type.
 *
 * WHAT IS NEVER WRITTEN. No environment value goes into the file: the header
 * holds the commands as typed and nothing else from the process. The home
 * directory is replaced by `~` in every event and the header says so, exactly
 * as `tri cast scrub` does. A secret a command PRINTS is not edited out - the
 * only edit a published cast may carry is the home scrub - it is found by
 * `checkCast` and reported, and the review says so.
 *
 * IMPORTS NOTHING BUT node:* ON PURPOSE. The bee runs this file directly with
 * `bun <this file> record ...`; importing the server's modules would start the
 * server's graph (logger, database pool) inside the bee's shell.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CAST_COLS = 104
export const CAST_ROWS = 30
/** Output kept per recording; past it the rest of the bytes are dropped and the cast says so. */
export const CAST_MAX_OUTPUT_CHARS = 1024 * 1024
/** Default per-command ceiling, seconds. A hung command ends as exit 124. */
export const CAST_DEFAULT_TIMEOUT_S = 600
const HOME_REDACTION = 'home directory shown as ~'
const PROMPT_COLOUR = '\x1b[38;2;255;215;0m'
const RESET = '\x1b[0m'

/** Where a bee's recording for an issue lives: on the volume, outside every worktree. */
export function castPathFor(
  issue: number,
  env: Record<string, string | undefined> = process.env,
): string {
  // Outside the worktree so it is never dirt the salvage or the dirt count
  // sees, and on the workspace volume so a redeploy (which wipes worktrees)
  // does not take the recording with it. One file per issue, overwritten by
  // the next attempt - `checkCast` dates it against the dispatch.
  const dir = env.WORKSPACE_DIR || '/workspace'
  return `${dir}/casts/queen-${issue}.cast`
}

/** This file, as the bee runs it. Derived, never hardcoded: the brief names what the image holds. */
export function castRecorderPath(): string {
  return fileURLToPath(import.meta.url)
}

export type CastEvent = [number, string, string]

export interface CastHeader {
  version: number
  width: number
  height: number
  timestamp: number
  title: string
  commands?: string[]
  redacted?: string[]
  [key: string]: unknown
}

/** Every home-directory spelling to scrub: longest first, so `/home/bee` is not left as `~bee`-ish halves. */
export function homesToScrub(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const homes = [env.HOME, homedir()].filter(
    (h): h is string => typeof h === 'string' && h.length > 1,
  )
  return [...new Set(homes)].sort((a, b) => b.length - a.length)
}

export function scrubHome(text: string, homes: string[]): string {
  let out = text
  for (const home of homes) out = out.split(home).join('~')
  return out
}

/** Pipes give `\n`; a terminal player needs `\r\n`, which a pty would have made. */
function crlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

export interface RecordOptions {
  title?: string
  cwd?: string
  timeoutS?: number
  env?: Record<string, string | undefined>
  /** Injected clock for tests; seconds since the recording began. */
  now?: () => number
}

export interface RecordResult {
  path: string
  events: number
  seconds: number
  codes: string[]
}

/**
 * Run each command in turn and write the recording. Never throws on a failing
 * command - a non-zero exit is the evidence, and is recorded as such.
 */
export async function recordCast(
  path: string,
  commands: string[],
  options: RecordOptions = {},
): Promise<RecordResult> {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const timeoutMs = (options.timeoutS ?? CAST_DEFAULT_TIMEOUT_S) * 1000
  const started = performance.now()
  const now = options.now ?? (() => (performance.now() - started) / 1000)
  const homes = homesToScrub(env)
  const prompt = `${basename(cwd)} $ `
  const events: CastEvent[] = []
  // Staged time: the typing is added to the clock instead of slept through.
  let staged = 0
  let kept = 0
  let dropped = 0
  const at = () => Math.round((now() + staged) * 10_000) / 10_000
  const out = (text: string) => {
    const nothing = text.length === 0
    if (nothing) return
    events.push([at(), 'o', text])
  }
  const real = (text: string) => {
    const room = CAST_MAX_OUTPUT_CHARS - kept
    const full = room <= 0
    if (full) {
      dropped += text.length
      return
    }
    const part = text.length > room ? text.slice(0, room) : text
    dropped += text.length - part.length
    kept += part.length
    out(crlf(scrubHome(part, homes)))
  }

  for (const command of commands) {
    out(`${PROMPT_COLOUR}${prompt}${RESET}`)
    staged += 0.4
    for (const ch of scrubHome(command, homes)) {
      out(ch)
      staged += 0.035
    }
    staged += 0.3
    out('\r\n')
    const child = Bun.spawn(['/bin/sh', '-c', `exec 2>&1\n${command}`], {
      cwd,
      env: {
        ...env,
        COLUMNS: String(CAST_COLS),
        LINES: String(CAST_ROWS),
        TERM: 'xterm-256color',
      },
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    const decoder = new TextDecoder()
    const reader = child.stdout.getReader()
    let timedOut = false
    // The reader is cancelled too, not only the shell killed: a grandchild the
    // shell started keeps the pipe open, and the read would wait on it forever
    // (the same hang the bash tool's own timeout races against, trios#1340).
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      reader.cancel().catch(() => {})
    }, timeoutMs)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      real(decoder.decode(value, { stream: true }))
    }
    real(decoder.decode())
    clearTimeout(timer)
    const code = timedOut ? 124 : await child.exited
    if (timedOut) {
      out(`\r\n[queen-cast: stopped after ${timeoutMs / 1000} s]\r\n`)
    }
    events.push([at(), 'x', String(code)])
    staged += 1.0
  }
  const cut = dropped > 0
  if (cut) {
    out(
      `\r\n[queen-cast: ${dropped} further characters of output were not kept]\r\n`,
    )
  }
  out(`${PROMPT_COLOUR}${prompt}${RESET}`)

  const header: CastHeader = {
    version: 2,
    width: CAST_COLS,
    height: CAST_ROWS,
    timestamp: Math.floor(Date.now() / 1000),
    title: scrubHome(options.title ?? commands.join(' ; '), homes),
    commands: commands.map((c) => scrubHome(c, homes)),
    redacted: [HOME_REDACTION],
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeCast(header, events))
  const codes = events.filter((e) => e[1] === 'x').map((e) => e[2])
  return {
    path,
    events: events.length,
    seconds: events.length ? events[events.length - 1][0] : 0,
    codes,
  }
}

export function serializeCast(header: CastHeader, events: CastEvent[]): string {
  return (
    `${JSON.stringify(header)}\n` +
    events.map((e) => `${JSON.stringify(e)}\n`).join('')
  )
}

export function parseCast(
  text: string,
): { header: CastHeader; events: CastEvent[] } | null {
  const rows = text.split('\n').filter((r) => r.trim().length > 0)
  const empty = rows.length === 0
  if (empty) return null
  try {
    const header = JSON.parse(rows[0]) as CastHeader
    const versionOk = header?.version === 2
    if (!versionOk) return null
    const events = rows.slice(1).map((r) => JSON.parse(r) as CastEvent)
    const shapeOk = events.every(
      (e) => Array.isArray(e) && e.length >= 3 && typeof e[2] === 'string',
    )
    if (!shapeOk) return null
    return { header, events }
  } catch {
    return null
  }
}

/**
 * Secret shapes worth refusing on sight, whoever's they are. Counted, never
 * printed or returned.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
]

const SECRET_NAME =
  /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|DATABASE_URL/i

/**
 * The values of this process's secret-named environment variables, for
 * comparison only. Short values are skipped: a 4-character "secret" would match
 * ordinary output and accuse a bee of a leak it did not make.
 */
export function secretValues(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const values: string[] = []
  for (const [name, value] of Object.entries(env)) {
    const named = SECRET_NAME.test(name)
    const long = typeof value === 'string' && value.length >= 12
    const isSecret = named && long
    if (isSecret) values.push(value as string)
  }
  return values
}

export interface CastCheck {
  ok: boolean
  /** One reason per failed rule, in `tri cast check`'s words where they overlap. */
  problems: string[]
  codes: string[]
  homeHits: number
  secretHits: number
  events: number
  seconds: number
  commands: string[]
  timestamp: number | null
}

export interface CheckOptions {
  /** Home paths that must not occur. */
  homes?: string[]
  /** Literal secret values that must not occur. */
  secrets?: string[]
  /** A recording older than this (unix seconds) belongs to an earlier attempt. */
  notBefore?: number | null
}

/**
 * The same rules `tri cast check` applies, on the container's side: every
 * command exited 0, the home path is scrubbed, no secret occurs - and, because
 * one path serves every attempt at an issue, the recording is this attempt's.
 */
export function checkCast(text: string, options: CheckOptions = {}): CastCheck {
  const parsed = parseCast(text)
  if (!parsed) {
    return {
      ok: false,
      problems: ['not an asciicast v2 recording'],
      codes: [],
      homeHits: 0,
      secretHits: 0,
      events: 0,
      seconds: 0,
      commands: [],
      timestamp: null,
    }
  }
  const { header, events } = parsed
  const shown = events
    .filter((e) => e[1] === 'o')
    .map((e) => e[2])
    .join('')
  const typed = (header.commands ?? []).join('\n')
  const all = `${shown}\n${typed}\n${header.title ?? ''}`
  const codes = events.filter((e) => e[1] === 'x').map((e) => e[2])
  const problems: string[] = []
  const noCodes = codes.length === 0
  if (noCodes) problems.push('no exit codes (not made by a cast recorder?)')
  const failing = codes.filter((c) => c !== '0')
  const anyFailed = failing.length > 0
  if (anyFailed) problems.push(`exit codes ${codes.join(' ')}`)
  const homes = (options.homes ?? []).filter((h) => h.length > 1)
  const homeHits = homes.reduce((n, h) => n + all.split(h).length - 1, 0)
  const homeShown = homeHits > 0
  if (homeShown) problems.push(`home path occurs ${homeHits} times`)
  const literal = (options.secrets ?? []).reduce(
    (n, s) => n + all.split(s).length - 1,
    0,
  )
  const shaped = SECRET_PATTERNS.reduce(
    (n, re) => n + (all.match(re)?.length ?? 0),
    0,
  )
  const secretHits = literal + shaped
  const secretShown = secretHits > 0
  if (secretShown) problems.push(`secret hits ${secretHits}`)
  const timestamp =
    typeof header.timestamp === 'number' ? header.timestamp : null
  const stale =
    options.notBefore != null &&
    timestamp != null &&
    timestamp < options.notBefore
  if (stale) problems.push('recorded before this attempt was dispatched')
  return {
    ok: problems.length === 0,
    problems,
    codes,
    homeHits,
    secretHits,
    events: events.length,
    seconds: events.length ? events[events.length - 1][0] : 0,
    commands: header.commands ?? [],
    timestamp,
  }
}

/** What the review found about a bee's recording. */
export type CastReport =
  | { kind: 'missing'; path: string }
  | { kind: 'checked'; path: string; check: CastCheck }

/** Read and check the recording for an issue. Never throws: an unreadable file is `missing`. */
export function readBeeCast(
  issue: number,
  dispatchedAt: unknown,
  env: Record<string, string | undefined> = process.env,
): CastReport {
  const path = castPathFor(issue, env)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { kind: 'missing', path }
  }
  const user = env.TRIOS_TOOL_SHELL_USER
  const homes = [...homesToScrub(env), ...(user ? [`/home/${user}`] : [])]
  // pg hands back a Date for timestamptz; a fake or a JSON path hands a string.
  const isDate = dispatchedAt instanceof Date
  const dispatchedMs = isDate
    ? dispatchedAt.getTime()
    : dispatchedAt == null
      ? Number.NaN
      : Date.parse(String(dispatchedAt))
  const notBefore = Number.isFinite(dispatchedMs)
    ? Math.floor(dispatchedMs / 1000)
    : null
  return {
    kind: 'checked',
    path,
    check: checkCast(text, { homes, secrets: secretValues(env), notBefore }),
  }
}

/**
 * The cast, in one sentence for the review note. A WARNING, not a verdict: it
 * moves no state and no counter. `named` is the `cast:` line the bee wrote.
 */
export function castSentence(report: CastReport, named: string | null): string {
  const absent = report.kind === 'missing'
  if (absent) {
    return named
      ? `Cast: the bee named ${named} but no recording was found at ${report.path}.`
      : `Cast: no recording of the work was found at ${report.path} and the verdict names none.`
  }
  const { check } = report
  const where =
    named && named !== report.path
      ? ` (the verdict names ${named}; the review read ${report.path})`
      : ''
  const passed = check.ok
  if (passed) {
    return (
      `Cast: ${report.path} records ${check.commands.length} command(s), ` +
      `all exited 0, home scrubbed, no secret found${where}.`
    )
  }
  return `Cast: ${report.path} fails its check - ${check.problems.join('; ')}${where}.`
}

/** The cast status as one word, for the review log line. */
export function castStatus(report: CastReport): string {
  const absent = report.kind === 'missing'
  if (absent) return 'missing'
  return report.check.ok ? 'ok' : 'fail'
}

function usage(): never {
  console.error(
    'usage: bun queen-cast.ts record OUT [--title T] [--timeout S] -- "cmd 1" "cmd 2" ...\n' +
      '       bun queen-cast.ts check CAST',
  )
  process.exit(2)
}

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv
  const recording = verb === 'record'
  const checking = verb === 'check' && Boolean(rest[0])
  if (recording) {
    const sep = rest.indexOf('--')
    const noCommands = sep < 1 || sep === rest.length - 1
    if (noCommands) usage()
    const head = rest.slice(0, sep)
    const commands = rest.slice(sep + 1)
    const out = head[0]
    const title = head.includes('--title')
      ? head[head.indexOf('--title') + 1]
      : undefined
    const timeoutS = head.includes('--timeout')
      ? Number(head[head.indexOf('--timeout') + 1])
      : undefined
    const r = await recordCast(out, commands, { title, timeoutS })
    console.log(
      `record: ${r.path} (${r.events} events, ${r.seconds.toFixed(1)} s, exit codes ${r.codes.join(' ')})`,
    )
    return printCheck(out)
  }
  if (checking) return printCheck(rest[0])
  usage()
}

function printCheck(path: string): number {
  const check = checkCast(readFileSync(path, 'utf8'), {
    homes: homesToScrub(),
  })
  console.log(
    `check: ${path}: ${check.events} events, ${check.seconds.toFixed(1)} s, ` +
      `exit codes ${check.codes.join(' ') || '-'}, secret hits ${check.secretHits} -> ` +
      (check.ok ? 'OK' : `FAIL: ${check.problems.join('; ')}`),
  )
  return check.ok ? 0 : 1
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
