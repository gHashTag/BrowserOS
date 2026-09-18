/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The Queen runs an issue's own acceptance commands on the bee's commit.
 *
 * WHY IT EXISTS. In the gHashTag/t27 swarm nearly every acceptance criterion is
 * already a measurement: a shell command and the output it must print -
 *
 *   - 1. `t27c spec-status specs/tri/graph/prims_mst.t27` prints `IMPLEMENTED`
 *
 * The adversarial reviewer (queen-reviewer.ts) has no tools, so for exactly
 * these criteria it can only answer could-not-check, and a review that refutes
 * nothing and establishes nothing is escalated to a person (`beyondThePatch`).
 * Measured on the six live issues read while this was written (#4251, #4259,
 * #4246, #3939, #3974, #3880): 19 of their 23 criteria are a command with an
 * expected output. Sending every one of those to a person makes the operator
 * the compiler; "let the compiler judge where the criteria are mechanical" is
 * what they asked for instead.
 *
 * WHAT IT IS. A parser that turns a criterion line into checks, a filter that
 * admits only a small read-only command language, and a runner that executes
 * the admitted commands AS THE BEE, in a detached temporary worktree at the
 * bee's COMMIT - never in the bee's own worktree, whose uncommitted leftovers
 * are not the deliverable - with a timeout, an output cap and a total budget.
 *
 * WHAT IT IS NOT. A sandbox. The commands run with the bee's own uid, which is
 * the privilege the bee's turn already had; the filter exists so that a
 * criterion that happens to contain `; curl` or `$(...)` is refused as
 * unrunnable rather than obeyed, and so that a command cannot write outside a
 * private scratch directory.
 */

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { logger } from '../../lib/logger'
import { spawnEnv } from '../../tools/filesystem/bash'
import { workspaceRoot } from './queen-dispatch'

export type CheckOp = 'equals' | 'atLeast' | 'notContains'

/** One mechanical check read from a criterion line. */
export interface CriterionCheck {
  cmd: string
  op: CheckOp
  expected: string
}

/**
 * The words between a command and its expected output.
 *
 * Only these. "prints a line beginning `ok:`" (#4246) and "reports 0, 0 and 0"
 * (#3880) say something a person can check and this parser cannot read
 * exactly, so they yield no check and stay the reviewer's.
 */
const CONNECTOR =
  /^\s+(prints at least|prints more than|prints|does not print)\s+$/

/**
 * The command as the container can run it.
 *
 * Older issues name the operator's laptop binary
 * (`/Users/playom/t27/target/release/t27c`, `./target/release/t27c`) and
 * sometimes start with `cd /Users/playom/t27 && `. In the container the
 * compiler is `t27c` on PATH and the checkout is the working directory, so
 * both are rewritten to what they meant rather than refused for where they
 * were written.
 */
export function normaliseCriterionCommand(cmd: string): string {
  let out = cmd.trim()
  out = out.replace(/^cd\s+(?:\/Users\/[^/\s'"]+\/t27|~\/t27)\/?\s*&&\s*/, '')
  out = out.replace(
    /(^|[\s|&])(?:\/Users\/[^/\s'"]+\/t27\/target\/release\/t27c|\.\/target\/release\/t27c)(?=\s|$)/g,
    '$1t27c',
  )
  return out
}

/**
 * The checks one criterion line states, in the order it states them.
 *
 * Read by pairing backtick spans, so a prose span such as "the `&&` in the
 * second command" can never be taken as a command: a check is a code span, a
 * connector and nothing else, and a code span. "prints more than `N`" is
 * `atLeast N+1`. Trailing "(today: ...)" and prose are ignored because they
 * are not between two spans. A line with no such pair yields [].
 */
export function parseCriterionChecks(criterion: string): CriterionCheck[] {
  const parts = criterion.split('`')
  const checks: CriterionCheck[] = []
  // Odd indices are code spans; parts[i + 1] is the text after span i.
  for (let i = 1; i + 2 < parts.length; i += 2) {
    const connector = parts[i + 1].match(CONNECTOR)
    if (!connector) continue
    const cmd = normaliseCriterionCommand(parts[i])
    const expected = parts[i + 2]
    if (cmd.length === 0) continue
    switch (connector[1]) {
      case 'prints':
        checks.push({ cmd, op: 'equals', expected })
        break
      case 'does not print':
        if (expected.length > 0)
          checks.push({ cmd, op: 'notContains', expected })
        break
      case 'prints at least':
        if (/^\d+$/.test(expected.trim()))
          checks.push({ cmd, op: 'atLeast', expected: expected.trim() })
        break
      case 'prints more than':
        if (/^\d+$/.test(expected.trim()))
          checks.push({
            cmd,
            op: 'atLeast',
            expected: String(Number(expected.trim()) + 1),
          })
        break
    }
    // The expected span is consumed; the next command starts after it.
    i += 2
  }
  return checks
}

type Token =
  | {
      kind: 'word'
      value: string
      quoted: boolean
      /** The word exactly as it was written, quotes and escapes included. */
      raw: string
    }
  | { kind: 'op'; op: '|' | '&&' | '>' | '2>&1' }

/** The programs a criterion may start a pipeline segment with. */
export const CRITERION_PROGRAMS: ReadonlySet<string> = new Set([
  't27c',
  'grep',
  'wc',
  'head',
  'tail',
  'sort',
  'uniq',
  'cut',
  'tr',
  'cat',
  'test',
  'echo',
])

/**
 * The `t27c` subcommands a criterion may name.
 *
 * `t27c --help` lists 180 of them, and they are not all readers. `battery` and
 * `gates` RUN every `check_*.py` in the tree, `silicon` drives a bitstream
 * build, `fpga-flash` writes to hardware, `serve` and `bridge` open sockets,
 * `fmt`, `rename` and `seal` edit files. The tree they would act on is the bee's
 * own commit, so an allowlist of programs alone hands a bee the ability to run
 * a script it just wrote by putting `t27c battery` in an issue's criteria.
 *
 * So the subcommand is allowlisted too, to the ones that only READ a spec and
 * print an answer - which is all an acceptance criterion in this repository has
 * ever needed (measured over the open backlog: spec-status, gen, parse and
 * typecheck cover every criterion that names the compiler).
 */
export const CRITERION_T27C_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'spec-status',
  'impl-status',
  'classify',
  'parse',
  'parse-complete',
  'parse-conform',
  'typecheck',
  'gen',
  'gen-c',
  'gen-rust',
  'gen-verilog',
  'frozen-digest',
  'version',
  '--version',
])

/** The one place a command may write, before the runner rewrites it. */
const SCRATCH_PREFIX = '/tmp/t27-'
const SCRATCH_TARGET = /^\/tmp\/t27-[A-Za-z0-9._-]+$/

/**
 * A shell-like tokenizer that refuses instead of guessing.
 *
 * Single quotes are literal; double quotes allow backslash escapes and refuse
 * `$` and backticks; a backslash outside quotes escapes one character. Every
 * character bash would give a meaning this language does not have - `;`, `&`,
 * `||`, `<`, parentheses, backticks, `$`, globs, braces, `~`, `#`, a newline -
 * is a refusal when unquoted, because a filter that admits a subset of a
 * grammar it does not fully parse admits whatever it misparses.
 */
function tokenize(
  cmd: string,
): { ok: true; tokens: Token[] } | { ok: false; reason: string } {
  const tokens: Token[] = []
  let buf = ''
  let raw = ''
  let inWord = false
  let quoted = false
  const flush = () => {
    if (inWord) tokens.push({ kind: 'word', value: buf, quoted, raw })
    buf = ''
    raw = ''
    inWord = false
    quoted = false
  }
  const fail = (reason: string) => ({ ok: false as const, reason })
  let i = 0
  while (i < cmd.length) {
    const c = cmd[i]
    if (c === ' ' || c === '\t') {
      flush()
      i++
      continue
    }
    const text = readQuoted(cmd, i)
    if (text) {
      if ('reason' in text) return fail(text.reason)
      buf += text.value
      raw += cmd.slice(i, text.end)
      inWord = true
      quoted = true
      i = text.end
      continue
    }
    if (c === '>' && inWord && !quoted && /^\d+$/.test(buf)) {
      return fail('a file-descriptor redirect other than 2>&1')
    }
    const op = readOperator(cmd, i, inWord)
    if (op) {
      if ('reason' in op) return fail(op.reason)
      flush()
      tokens.push({ kind: 'op', op: op.op })
      i = op.end
      continue
    }
    if ('\n\r\0'.includes(c)) return fail('a newline')
    if (';<()`$*?[]{}~#!'.includes(c)) return fail(`an unquoted ${c}`)
    buf += c
    raw += c
    inWord = true
    i++
  }
  flush()
  return { ok: true, tokens }
}

/**
 * A quoted run or a backslash escape starting at `i`, or null when `cmd[i]`
 * starts neither. `end` is the index after it.
 */
function readQuoted(
  cmd: string,
  i: number,
): { value: string; end: number } | { reason: string } | null {
  const c = cmd[i]
  if (c === '\\') {
    const next = cmd[i + 1]
    if (next === undefined || '\n\r\0'.includes(next)) {
      return { reason: 'a trailing backslash' }
    }
    return { value: next, end: i + 2 }
  }
  if (c === "'") {
    const end = cmd.indexOf("'", i + 1)
    if (end < 0) return { reason: 'an unterminated single quote' }
    const literal = cmd.slice(i + 1, end)
    if (/[\n\r\0]/.test(literal)) return { reason: 'a newline' }
    return { value: literal, end: end + 1 }
  }
  if (c !== '"') return null
  let value = ''
  for (let j = i + 1; j < cmd.length; j++) {
    const d = cmd[j]
    if (d === '"') return { value, end: j + 1 }
    if ('\n\r\0'.includes(d)) return { reason: 'a newline' }
    if (d === '$' || d === '`') {
      return { reason: `${d} inside double quotes (an expansion)` }
    }
    if (d === '\\' && j + 1 < cmd.length && '$`"\\'.includes(cmd[j + 1])) {
      // Inside double quotes a backslash escapes only these; before any
      // other character bash keeps it, and so does this.
      value += cmd[j + 1]
      j++
      continue
    }
    value += d
  }
  return { reason: 'an unterminated double quote' }
}

/** The operator starting at `i`, a refusal, or null when there is none. */
function readOperator(
  cmd: string,
  i: number,
  inWord: boolean,
): { op: '|' | '&&' | '>' | '2>&1'; end: number } | { reason: string } | null {
  const c = cmd[i]
  const next = cmd[i + 1] ?? ''
  if (
    c === '2' &&
    !inWord &&
    cmd.startsWith('2>&1', i) &&
    (i + 4 === cmd.length || ' \t|'.includes(cmd[i + 4]))
  ) {
    return { op: '2>&1', end: i + 4 }
  }
  if (c === '|') {
    return next === '|' ? { reason: '||' } : { op: '|', end: i + 1 }
  }
  if (c === '&') {
    return next === '&'
      ? { op: '&&', end: i + 2 }
      : { reason: '& (a background job)' }
  }
  if (c === '>') {
    return next === '>' || next === '&' || next === '|'
      ? { reason: `>${next} (only > to ${SCRATCH_PREFIX}... is allowed)` }
      : { op: '>', end: i + 1 }
  }
  return null
}

/**
 * Whether a word that decodes to the scratch prefix also SPELLS it.
 *
 * The validators read a token's decoded value while `runOneCheck` redirects
 * the write by replacing the literal `/tmp/t27-` in the raw command text. A
 * spelling that decodes to the scratch prefix without containing it
 * literally - `/tmp/t27"-"x`, `/tmp/t27\-x`, `/tmp/'t27-'x` - therefore
 * passed the validator and reached bash UNREWRITTEN, so the command read and
 * wrote the container's real `/tmp` at a name the criterion chose: a
 * predictable path every process with that uid can see, outside the private
 * directory this module promises, surviving the measurement's `rm -rf`, and
 * shared between two issues measured under the same name. Refusing the
 * spelling is what keeps the validator and the rewrite from disagreeing.
 */
function scratchSpelledPlainly(raw: string): boolean {
  return raw.includes(SCRATCH_PREFIX)
}

/** Why an argument is refused, or '' when it is not. */
function argumentProblem(
  token: { value: string; raw: string },
  program: string,
): string {
  const { value, raw } = token
  const candidates = [value]
  const eq = value.indexOf('=')
  if (eq >= 0) candidates.push(value.slice(eq + 1))
  // `-f/etc/passwd`: a short option with its value attached.
  if (/^-[A-Za-z]/.test(value) && !value.startsWith('--'))
    candidates.push(value.slice(2))
  for (const candidate of candidates) {
    if (candidate.startsWith('/') && !SCRATCH_TARGET.test(candidate)) {
      return `an absolute path outside ${SCRATCH_PREFIX} (${value})`
    }
    if (SCRATCH_TARGET.test(candidate) && !scratchSpelledPlainly(raw)) {
      return `${SCRATCH_PREFIX} spelled with quotes or escapes (${value})`
    }
  }
  if (/(^|[/=])\.\.($|\/)/.test(value)) {
    return `a path out of the checkout (${value})`
  }
  // Options that read a list of FILE NAMES from a file, or run a program.
  if (/^--files0-from/.test(value)) return `${value} reads names from a file`
  if (program === 'sort' && /^--c/.test(value)) {
    return `${value} (sort --compress-program runs a program)`
  }
  return ''
}

/** Why a `>` target is refused, or '' when it is the scratch prefix. */
function redirectProblem(target: Token | undefined): string {
  if (target?.kind === 'word' && SCRATCH_TARGET.test(target.value)) {
    return scratchSpelledPlainly(target.raw)
      ? ''
      : `${SCRATCH_PREFIX} spelled with quotes or escapes (${target.value})`
  }
  return `a redirect to anything but ${SCRATCH_PREFIX}<name> (${
    target?.kind === 'word' ? target.value : 'nothing'
  })`
}

export interface CommandSafety {
  safe: boolean
  reason: string
  /** The `t27c <sub> <file.t27>` invocations inside the command. */
  t27cCalls: Array<{ sub: string; file: string }>
}

/**
 * Whether a criterion command may be run, and why not.
 *
 * Each pipeline segment (split on `|` and `&&`) starts with a program from
 * `CRITERION_PROGRAMS` named bare - so a leading `X=1` assignment, `env`, a
 * path to a binary or a quoted `$(...)` never gets to be the program. Stdout
 * may be redirected only to `/tmp/t27-<name>`, which the runner points at a
 * private directory, and `2>&1` is the one descriptor redirect admitted.
 * Arguments may not name an absolute path (other than that scratch prefix) or
 * climb out with `..`: a criterion reads the checkout, nothing else.
 */
export function commandSafety(cmd: string): CommandSafety {
  const refused = (reason: string): CommandSafety => ({
    safe: false,
    reason,
    t27cCalls: [],
  })
  const lexed = tokenize(cmd)
  if (!lexed.ok) return refused(lexed.reason)
  const { tokens } = lexed
  const t27cCalls: Array<{ sub: string; file: string }> = []
  let expectProgram = true
  let program = ''
  let args: string[] = []
  const endSegment = () => {
    if (program === 't27c' && args.length >= 2) {
      const file = args.slice(1).find((a) => a.endsWith('.t27'))
      if (file && !args[0].startsWith('-')) {
        t27cCalls.push({ sub: args[0], file })
      }
    }
    program = ''
    args = []
  }
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]
    if (token.kind === 'op') {
      if (expectProgram) return refused(`${token.op} with no command before it`)
      if (token.op === '|' || token.op === '&&') {
        endSegment()
        expectProgram = true
        continue
      }
      if (token.op === '2>&1') continue
      const problem = redirectProblem(tokens[k + 1])
      if (problem) return refused(problem)
      k++
      continue
    }
    if (expectProgram) {
      if (!CRITERION_PROGRAMS.has(token.value)) {
        return refused(
          `${token.value || 'an empty word'} is not an allowed program`,
        )
      }
      // The subcommand is part of which program this is: `t27c battery` runs
      // the tree's own scripts, and the tree is the bee's commit.
      if (token.value === 't27c') {
        const sub = tokens[k + 1]
        if (!sub || sub.kind !== 'word') {
          return refused('t27c with no subcommand')
        }
        if (!CRITERION_T27C_SUBCOMMANDS.has(sub.value)) {
          return refused(`t27c ${sub.value} is not a read-only subcommand`)
        }
      }
      program = token.value
      expectProgram = false
      continue
    }
    const problem = argumentProblem(token, program)
    if (problem) return refused(problem)
    args.push(token.value)
  }
  if (expectProgram) return refused('no command after the last operator')
  endSegment()
  return { safe: true, reason: '', t27cCalls }
}

export function isSafeCommand(cmd: string): boolean {
  return commandSafety(cmd).safe
}

/** What one process did. */
export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Stdout passed the cap and the process group was killed. */
  capped: boolean
  error?: string
}

export interface ExecRequest {
  argv: string[]
  cwd: string
  timeoutMs: number
  maxBytes: number
  /** Only the exit code matters: stdout is not read at all. */
  discardStdout?: boolean
}

export type Exec = (request: ExecRequest) => Promise<ExecResult>

/**
 * The argv that runs a program as the bee.
 *
 * The same drop `run()` in queen-dispatch.ts makes through `shellArgv`: with
 * TRIOS_TOOL_SHELL_USER set, `su -s /bin/bash <bee> -c '<quoted argv>'`, so a
 * criterion command runs with the bee's uid and cannot read the server's
 * environment; unset (a developer's machine) the argv runs as it is.
 */
export function beeArgv(argv: string[]): string[] {
  const user = process.env.TRIOS_TOOL_SHELL_USER
  if (process.platform === 'win32' || !user) return argv
  const quoted = argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ')
  return ['su', '-s', '/bin/bash', user, '-c', quoted]
}

/**
 * Spawn, bounded three ways: stdin closed, a timeout that kills the whole
 * process group (a `su` killed alone leaves its child holding the pipes - the
 * hang `run()` already paid for), and a stdout cap that kills at the cap.
 * The environment is the tool shell's allowlist, not the server's.
 */
export const defaultExec: Exec = (request) =>
  new Promise((resolve) => {
    const argv = beeArgv(request.argv)
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let capped = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: request.cwd,
        detached: true,
        env: spawnEnv() as NodeJS.ProcessEnv,
        stdio: ['ignore', request.discardStdout ? 'ignore' : 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        capped: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const finish = (code: number | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      clearTimeout(hardTimer)
      resolve({ code, stdout, stderr, timedOut, capped, error })
    }
    const killTimer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, request.timeoutMs)
    const hardTimer = setTimeout(
      () => finish(null, 'timed out and never closed'),
      request.timeoutMs + 5_000,
    )
    child.stdout?.on('data', (d) => {
      if (capped) return
      stdout += d
      if (Buffer.byteLength(stdout) > request.maxBytes) {
        capped = true
        stdout = stdout.slice(0, request.maxBytes)
        killGroup()
      }
    })
    child.stderr?.on('data', (d) => {
      // Stderr is only read for a diagnosis; a few KiB of it is enough.
      if (stderr.length < 8_192) stderr += d
    })
    child.on('error', (e) => finish(null, String(e)))
    child.on('close', (code) => finish(code))
  })

export type CheckStatus = 'passed' | 'failed' | 'unrunnable'

/** One check as run. `ok` is `status === 'passed'`. */
export interface CheckRun {
  cmd: string
  op: CheckOp
  expected: string
  status: CheckStatus
  ok: boolean
  /** Trimmed stdout, bounded for storage. */
  output: string
  exitCode: number | null
  reason: string
}

/** Commands one measurement may run, and for how long in total. */
export interface CriteriaBudget {
  commandsLeft: number
  deadline: number
}

export const CRITERION_COMMAND_TIMEOUT_MS = 60_000
export const CRITERION_OUTPUT_MAX_BYTES = 64 * 1024
export const CRITERIA_MAX_COMMANDS = 20
export const CRITERIA_TOTAL_MS = 5 * 60 * 1000
/** Stdout kept per check in the cache and the messages built from it. */
const STORED_OUTPUT_CHARS = 400

export interface RunCheckOptions {
  /** The checkout root the commands run in. */
  checkoutDir: string
  /** Stands in for `/tmp/t27-`; a command naming it is unrunnable without. */
  scratchDir?: string
  timeoutMs?: number
  maxOutputBytes?: number
  exec?: Exec
  budget?: CriteriaBudget
  now?: () => number
}

const PATH_SAFE = /^[A-Za-z0-9._/-]+$/

/** Bash's own words for a program it could not start. */
const NOT_STARTED = /command not found|Permission denied/

/**
 * Run checks, one command at a time, and say what each one printed.
 *
 * THE COUNT AFTER A FAILED COMMAND. `t27c gen X 2>&1 | grep -c stub` prints
 * `0` when generation FAILS, because the pipeline counts the stubs in an
 * error message. The issues' own authors noticed ("an absent or empty file
 * makes the grep print `0` on its own", #3974) and wrote `&&` or a second
 * half, and not every issue did (#3939, #3880). So every `t27c <sub>
 * <file.t27>` inside a command is also run alone, and a non-zero exit fails
 * the check whatever the pipeline printed.
 *
 * Unrunnable is neither met nor unmet: an unsafe command (never executed), a
 * compiler that is not there, a timeout, a spent budget. None of those is a
 * fact about the work, and a check that spends the bee's retry budget must be.
 */
export async function runCriterionChecks(
  checks: CriterionCheck[],
  options: RunCheckOptions,
): Promise<CheckRun[]> {
  const now = options.now ?? Date.now
  const context: RunContext = {
    options,
    exec: options.exec ?? defaultExec,
    now,
    timeoutMs: options.timeoutMs ?? CRITERION_COMMAND_TIMEOUT_MS,
    maxBytes: options.maxOutputBytes ?? CRITERION_OUTPUT_MAX_BYTES,
    budget: options.budget ?? {
      commandsLeft: CRITERIA_MAX_COMMANDS,
      deadline: now() + CRITERIA_TOTAL_MS,
    },
    soloRuns: new Map(),
  }
  const out: CheckRun[] = []
  for (const check of checks) out.push(await runOneCheck(check, context))
  return out
}

interface RunContext {
  options: RunCheckOptions
  exec: Exec
  now: () => number
  timeoutMs: number
  maxBytes: number
  budget: CriteriaBudget
  /** One solo compiler run per (subcommand, file), shared by every check. */
  soloRuns: Map<string, Promise<ExecResult>>
}

function checkResult(
  check: CriterionCheck,
  status: CheckStatus,
  reason: string,
  output = '',
  exitCode: number | null = null,
): CheckRun {
  return {
    cmd: check.cmd,
    op: check.op,
    expected: check.expected,
    status,
    ok: status === 'passed',
    output: output.slice(0, STORED_OUTPUT_CHARS),
    exitCode,
    reason,
  }
}

async function runOneCheck(
  check: CriterionCheck,
  context: RunContext,
): Promise<CheckRun> {
  const { options, budget } = context
  const safety = commandSafety(check.cmd)
  if (!safety.safe) {
    return checkResult(check, 'unrunnable', `unsafe command: ${safety.reason}`)
  }
  const remainingMs = budget.deadline - context.now()
  if (budget.commandsLeft <= 0 || remainingMs <= 0) {
    return checkResult(
      check,
      'unrunnable',
      'the measurement budget for this commit is spent',
    )
  }
  let command = check.cmd
  if (command.includes(SCRATCH_PREFIX)) {
    if (!options.scratchDir || !PATH_SAFE.test(options.scratchDir)) {
      return checkResult(
        check,
        'unrunnable',
        `no private directory for ${SCRATCH_PREFIX}`,
      )
    }
    command = command.replaceAll(SCRATCH_PREFIX, `${options.scratchDir}/t27-`)
  }
  budget.commandsLeft -= 1
  const limit = Math.max(1, Math.min(context.timeoutMs, remainingMs))
  const ran = await context.exec({
    argv: ['bash', '-c', command],
    cwd: options.checkoutDir,
    timeoutMs: limit,
    maxBytes: context.maxBytes,
  })
  const stdout = ran.stdout.trim()
  if (ran.error && ran.code === null && !ran.timedOut) {
    return checkResult(
      check,
      'unrunnable',
      `could not start: ${ran.error.slice(0, 200)}`,
    )
  }
  if (ran.timedOut) {
    return checkResult(
      check,
      'unrunnable',
      `timed out after ${limit} ms`,
      stdout,
    )
  }
  if (ran.code === 127 || ran.code === 126 || NOT_STARTED.test(ran.stderr)) {
    return checkResult(
      check,
      'unrunnable',
      `a program could not be started: ${ran.stderr.trim().slice(0, 200)}`,
      stdout,
      ran.code,
    )
  }
  const compared = compareOutput(check, ran, context.maxBytes)
  const compiler = await compilerAlone(safety.t27cCalls, context)
  if (compiler) {
    // A CRITERION MAY DEMAND A DIAGNOSTIC. The solo run exists for the answer
    // an ERROR can print by accident: `... | grep -c 'not yet implemented'`
    // prints `0` when generation fails, which is the passing answer (#3939),
    // and `wc -l` prints nothing at all. Every such hole has the same shape -
    // the criterion is satisfied by ABSENCE, so an empty or broken output
    // satisfies it - and those the compiler's exit still refutes.
    //
    // A criterion satisfied by PRESENCE is the opposite case, and in a
    // compiler repository it is ordinary: "the parser must reject this spec",
    // `t27c parse specs/bad.t27 2>&1 | grep -c "Parse error"` prints `1`,
    // with the real binary exiting 1 exactly as the criterion asserts. That
    // was deterministically judged unmet and charged to the bee, which cannot
    // fix it - making the compiler exit 0 makes the grep print 0 - so every
    // redispatch failed the same way until the ceiling handed correct work to
    // a person. The machine says it cannot tell, and the reviewer judges it
    // as it did before the measurement existed.
    const satisfiedByAbsence =
      check.op === 'notContains' ||
      (check.op === 'atLeast' && Number(check.expected) <= 0) ||
      (check.op === 'equals' &&
        (check.expected.trim() === '' || check.expected.trim() === '0'))
    if (
      compiler.status === 'failed' &&
      compared.status === 'passed' &&
      !satisfiedByAbsence
    ) {
      return checkResult(
        check,
        'unrunnable',
        `${compiler.reason}, but the command printed what the criterion ` +
          'demands: the machine cannot tell a broken spec from a criterion ' +
          'that asks for the diagnostic',
        stdout,
        ran.code,
      )
    }
    return checkResult(
      check,
      compiler.status,
      compiler.reason,
      stdout,
      ran.code,
    )
  }
  return checkResult(check, compared.status, compared.reason, stdout, ran.code)
}

/**
 * Each `t27c <sub> <file>` of a command, run on its own: the first that did
 * not exit 0 decides the check (failed), or the first that could not run at
 * all (unrunnable). Null when every one exited 0.
 */
async function compilerAlone(
  calls: Array<{ sub: string; file: string }>,
  context: RunContext,
): Promise<{ status: CheckStatus; reason: string } | null> {
  for (const call of calls) {
    const file = call.file.replaceAll(
      SCRATCH_PREFIX,
      `${context.options.scratchDir ?? ''}/t27-`,
    )
    const key = `${call.sub}\0${file}`
    let solo = context.soloRuns.get(key)
    if (!solo) {
      solo = context.exec({
        argv: ['t27c', call.sub, file],
        cwd: context.options.checkoutDir,
        timeoutMs: Math.max(
          1,
          Math.min(context.timeoutMs, context.budget.deadline - context.now()),
        ),
        maxBytes: context.maxBytes,
        discardStdout: true,
      })
      context.soloRuns.set(key, solo)
    }
    const alone = await solo
    const stderr = alone.stderr.trim().slice(0, 160)
    if (alone.timedOut) {
      return {
        status: 'unrunnable',
        reason: `t27c ${call.sub} ${call.file} timed out`,
      }
    }
    if (alone.code === null || alone.code === 127 || alone.code === 126) {
      return {
        status: 'unrunnable',
        reason: `t27c could not be started (${(alone.error ?? stderr).slice(0, 160)})`,
      }
    }
    if (alone.code !== 0) {
      return {
        status: 'failed',
        reason: `t27c ${call.sub} ${call.file} failed (exit ${alone.code}${stderr ? `: ${stderr}` : ''})`,
      }
    }
  }
  return null
}

/** What the command printed, against what the criterion says it must. */
function compareOutput(
  check: CriterionCheck,
  ran: ExecResult,
  maxBytes: number,
): { status: CheckStatus; reason: string } {
  const stdout = ran.stdout.trim()
  const printed = ran.capped
    ? `more than ${maxBytes} bytes`
    : JSON.stringify(stdout.slice(0, 120))
  if (check.op === 'equals') {
    return !ran.capped && stdout === check.expected.trim()
      ? { status: 'passed', reason: `printed ${printed}` }
      : {
          status: 'failed',
          reason: `expected "${check.expected}", printed ${printed}`,
        }
  }
  if (check.op === 'atLeast') {
    return !ran.capped &&
      /^-?\d+$/.test(stdout) &&
      Number(stdout) >= Number(check.expected)
      ? { status: 'passed', reason: `printed ${printed}` }
      : {
          status: 'failed',
          reason: `expected at least ${check.expected}, printed ${printed}`,
        }
  }
  if (ran.stdout.includes(check.expected)) {
    return {
      status: 'failed',
      reason: `printed "${check.expected}", which it must not`,
    }
  }
  // Absence cannot be proven from the first 64 KiB of the output.
  return ran.capped
    ? {
        status: 'unrunnable',
        reason: `output passed ${maxBytes} bytes; absence of "${check.expected}" not established`,
      }
    : {
        status: 'passed',
        reason: `did not print "${check.expected}" (printed ${printed})`,
      }
}

/** One criterion's checks, as run. `number` is the criterion's 1-based slot. */
export interface CriterionRun {
  number: number
  criterion: string
  checks: CheckRun[]
  /**
   * Whether the same checks already passed at the MERGE BASE.
   *
   * A pass at the head says "true on this commit", not "this commit made it
   * true", and t27 criteria are routinely guard-shaped ("the name still
   * exists", "does not print NOPARSE") or stale (the spec was implemented on
   * master before the issue was dispatched). Undefined when the base was not
   * measured - no base sha, nothing passed at the head, or the budget ran out
   * before the base run.
   */
  basePassed?: boolean
}

export type CriteriaMeasurement =
  | { ok: true; criteria: CriterionRun[] }
  | { ok: false; error: string }

export interface MeasureOptions {
  /** The repository the bee's branch lives in. Default `workspaceRoot()`. */
  repoRoot?: string
  /**
   * The commit the branch was cut from. When it is given, every criterion
   * that PASSED at the head is run again there, and the answer is recorded as
   * `basePassed` - so the sweep can tell a criterion this commit satisfied
   * from one that was already true before the bee started.
   */
  baseSha?: string | null
  /** Where the temporary directory is made. Default `os.tmpdir()`. */
  tmpRoot?: string
  exec?: Exec
  timeoutMs?: number
  maxCommands?: number
  totalMs?: number
  now?: () => number
}

/**
 * Measure an issue's criteria on the bee's COMMIT.
 *
 * A detached worktree at `headSha`, cut as the bee in a fresh temporary
 * directory, is the checkout the commands run in. Not the bee's own worktree:
 * it is reused across attempts and holds whatever a killed turn left
 * uncommitted, and the commit is the deliverable - a file the bee edited and
 * never committed must not make a check pass. Hooks are switched off for the
 * checkout because the bee can write the shared `.git`, and a
 * `post-checkout` hook would run before the measurement it could then rig.
 *
 * The worktree is always removed; a removal that fails is pruned, so a
 * crashed measurement leaves no registered worktree behind.
 */
export async function measureCriteria(
  issue: number,
  headSha: string,
  criteria: string[],
  options: MeasureOptions = {},
): Promise<CriteriaMeasurement> {
  const parsed = criteria
    .map((criterion, i) => ({
      number: i + 1,
      criterion,
      checks: parseCriterionChecks(criterion),
    }))
    .filter((c) => c.checks.length > 0)
  if (parsed.length === 0) return { ok: true, criteria: [] }
  if (!/^[0-9a-f]{40,64}$/.test(headSha)) {
    return { ok: false, error: `not a commit id: ${headSha.slice(0, 80)}` }
  }
  const exec = options.exec ?? defaultExec
  const now = options.now ?? Date.now
  const root = options.repoRoot ?? workspaceRoot()
  const tmpRoot = (options.tmpRoot ?? tmpdir()).replace(/\/+$/, '')
  const made = await exec({
    argv: ['mktemp', '-d', `${tmpRoot}/queen-criteria-${issue}.XXXXXX`],
    cwd: root,
    timeoutMs: 15_000,
    maxBytes: 4_096,
  })
  const dir = made.stdout.trim()
  if (made.code !== 0 || !dir || !PATH_SAFE.test(dir)) {
    return {
      ok: false,
      error: `could not make a temporary directory: ${(made.error ?? made.stderr).trim().slice(0, 200)}`,
    }
  }
  const checkout = `${dir}/queen-${issue}-criteria`
  const baseCheckout = `${dir}/queen-${issue}-base`
  const scratch = `${dir}/scratch`
  const added: string[] = []
  const cutWorktree = async (at: string, sha: string): Promise<string> => {
    const add = await exec({
      argv: [
        'git',
        '-C',
        root,
        '-c',
        'core.hooksPath=/dev/null',
        'worktree',
        'add',
        '--detach',
        at,
        sha,
      ],
      cwd: root,
      timeoutMs: 120_000,
      maxBytes: 16_384,
    })
    if (add.code !== 0) {
      return `git worktree add at ${sha.slice(0, 12)} failed: ${(add.error ?? add.stderr).trim().slice(0, 200)}`
    }
    added.push(at)
    return ''
  }
  try {
    // THE PRIVATE DIRECTORY A REDIRECT IS POINTED AT. Its result is read: an
    // unmade directory left every `... > /tmp/t27-gen.zig && grep ...`
    // criterion printing nothing, which `compareOutput` reads as the bee
    // failing to produce the file - a harness fault charged to the work as a
    // real send-back. Without a directory, `runOneCheck` answers unrunnable.
    const madeScratch = await exec({
      argv: ['mkdir', scratch],
      cwd: root,
      timeoutMs: 15_000,
      maxBytes: 4_096,
    })
    const scratchDir = madeScratch.code === 0 ? scratch : undefined
    if (!scratchDir) {
      logger.warn('Queen could not make a criteria scratch directory', {
        issue,
        scratch,
        error: (madeScratch.error ?? madeScratch.stderr).trim().slice(0, 200),
      })
    }
    const failure = await cutWorktree(checkout, headSha)
    if (failure) return { ok: false, error: failure }
    const budget: CriteriaBudget = {
      commandsLeft: options.maxCommands ?? CRITERIA_MAX_COMMANDS,
      deadline: now() + (options.totalMs ?? CRITERIA_TOTAL_MS),
    }
    const runs: CriterionRun[] = []
    for (const item of parsed) {
      runs.push({
        number: item.number,
        criterion: item.criterion,
        checks: await runCriterionChecks(item.checks, {
          checkoutDir: checkout,
          scratchDir,
          timeoutMs: options.timeoutMs,
          exec,
          budget,
          now,
        }),
      })
    }

    await markWhatWasAlreadyTrue(runs, {
      issue,
      headSha,
      baseSha: options.baseSha ?? '',
      cutWorktree,
      baseCheckout,
      run: (checks) =>
        runCriterionChecks(checks, {
          checkoutDir: baseCheckout,
          scratchDir,
          timeoutMs: options.timeoutMs,
          exec,
          budget,
          now,
        }),
      budget,
      now,
    })
    return { ok: true, criteria: runs }
  } finally {
    for (const at of added) {
      const removed = await exec({
        argv: ['git', '-C', root, 'worktree', 'remove', '--force', at],
        cwd: root,
        timeoutMs: 60_000,
        maxBytes: 16_384,
      })
      if (removed.code !== 0) {
        logger.warn('Queen could not remove a criteria worktree; pruning', {
          issue,
          checkout: at,
          error: (removed.error ?? removed.stderr).trim().slice(0, 200),
        })
      }
    }
    await exec({
      argv: ['rm', '-rf', dir],
      cwd: root,
      timeoutMs: 60_000,
      maxBytes: 4_096,
    })
    if (added.length > 0) {
      await exec({
        argv: ['git', '-C', root, 'worktree', 'prune'],
        cwd: root,
        timeoutMs: 60_000,
        maxBytes: 4_096,
      })
    }
  }
}

/**
 * Run the criteria that PASSED at the head again at the merge base, and
 * record which of them were already true there.
 *
 * A criterion that passes at the head says "this is true", never "this commit
 * made it true", and the sweep turns a passing measurement into `met` - so a
 * stale issue (the spec implemented on master while the issue queued) or one
 * whose criteria are all guards ("the name still exists", "does not print
 * NOPARSE") could carry an accept with no person and no send-back. Only the
 * criteria that passed are re-run: the rest are unmet whatever the base says.
 * The head's budget is shared, so this can never double a measurement's cost
 * ceiling, and a base that could not be cut or could not run every check
 * leaves `basePassed` undefined - unknown, not proven.
 */
async function markWhatWasAlreadyTrue(
  runs: CriterionRun[],
  context: {
    issue: number
    headSha: string
    baseSha: string
    baseCheckout: string
    cutWorktree: (at: string, sha: string) => Promise<string>
    run: (checks: CriterionCheck[]) => Promise<CheckRun[]>
    budget: CriteriaBudget
    now: () => number
  },
): Promise<void> {
  const passedAtHead = runs.filter(
    (run) =>
      run.checks.length > 0 && run.checks.every((c) => c.status === 'passed'),
  )
  if (
    passedAtHead.length === 0 ||
    !/^[0-9a-f]{40,64}$/.test(context.baseSha) ||
    context.baseSha === context.headSha ||
    context.budget.commandsLeft <= 0 ||
    context.budget.deadline <= context.now()
  ) {
    return
  }
  const failure = await context.cutWorktree(
    context.baseCheckout,
    context.baseSha,
  )
  if (failure) {
    // Not a failed measurement: the head is measured and says what it says.
    logger.warn('Queen could not measure the criteria at the merge base', {
      issue: context.issue,
      error: failure,
    })
    return
  }
  for (const run of passedAtHead) {
    const before = await context.run(
      run.checks.map((c) => ({ cmd: c.cmd, op: c.op, expected: c.expected })),
    )
    if (before.some((c) => c.status === 'unrunnable')) continue
    run.basePassed = before.every((c) => c.status === 'passed')
  }
}

/** A criterion's measured outcome, when the machine established one. */
export interface CriterionWitnessLine {
  number: number
  criterion: string
  met: boolean
}

const oneLine = (text: string, max: number): string =>
  text
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

const opWords = (check: { op: CheckOp; expected: string }): string =>
  check.op === 'equals'
    ? `must print "${check.expected}"`
    : check.op === 'atLeast'
      ? `must print at least ${check.expected}`
      : `must not print "${check.expected}"`

/**
 * The measurements as machine verdict lines, one per criterion that ran.
 *
 * Any check that FAILED makes the line unmet - a finding, spent exactly like a
 * compiler refusal. Every check passed makes it met. A criterion with an
 * unrunnable check and no failure gets no line: half a measurement
 * establishes nothing, and it is left to the reviewer as before.
 */
export function criteriaWitness(runs: CriterionRun[]): CriterionWitnessLine[] {
  const lines: CriterionWitnessLine[] = []
  for (const run of runs) {
    const ran = run.checks.filter((c) => c.status !== 'unrunnable')
    if (ran.length === 0) continue
    const failed = run.checks.filter((c) => c.status === 'failed')
    if (failed.length > 0) {
      lines.push({
        number: run.number,
        met: false,
        criterion: oneLine(
          `criterion ${run.number} measured on the commit FAILED: ` +
            failed
              .map((c) => `\`${c.cmd}\` ${opWords(c)} - ${c.reason}`)
              .join('; '),
          600,
        ),
      })
      continue
    }
    if (ran.length !== run.checks.length) continue
    lines.push({
      number: run.number,
      met: true,
      criterion: oneLine(
        `criterion ${run.number} measured on the commit: ` +
          run.checks
            .map((c) => `\`${c.cmd}\` ${opWords(c)} and ${c.reason}`)
            .join('; '),
        600,
      ),
    })
  }
  return lines
}

/**
 * The measurements as the reviewer reads them, inside its MEASUREMENTS fence:
 * the criterion number as a citable tag `[Mn]`, the exact command, what it had
 * to print and what it printed. Unrunnable checks are listed too, so a
 * reviewer knows a criterion was tried and why it was not established.
 */
export function measurementLines(runs: CriterionRun[]): string[] {
  const lines: string[] = []
  // ONE TAG, ONE MEANING. The tag was printed per CHECK while the sweep
  // honours it per CRITERION: a criterion whose first command passed and
  // whose second could not run was shown as a passing `[M3]`, the reviewer
  // cited M3 exactly as the line above the fence instructs, and
  // `citesMeasurement` rejected it because 3 was never established - the met
  // was rewritten to could-not-check and a person was called in about a
  // criterion whose own command had passed. A check of a criterion the
  // machine did not settle is still shown, so the reviewer knows it was
  // tried, but it carries no citable tag.
  const citable = new Set(criteriaWitness(runs).map((line) => line.number))
  for (const run of runs) {
    const tag = citable.has(run.number) ? `[M${run.number}] ` : ''
    for (const check of run.checks) {
      const word =
        check.status === 'passed'
          ? 'passed'
          : check.status === 'failed'
            ? 'FAILED'
            : 'not run'
      lines.push(
        oneLine(
          `- ${tag}criterion ${run.number} ${word}: \`${check.cmd}\` ` +
            `${opWords(check)}; printed ${JSON.stringify(check.output.slice(0, 160))}` +
            `${check.exitCode === null ? '' : ` (exit ${check.exitCode})`}` +
            `${check.status === 'passed' ? '' : ` - ${check.reason}`}`,
          700,
        ),
      )
    }
    if (run.basePassed === true) {
      lines.push(
        oneLine(
          `- criterion ${run.number} ALSO passed at the merge base: it was ` +
            'true before this branch existed, so it is no evidence that this ' +
            'commit did the work',
          700,
        ),
      )
    }
  }
  return lines
}

/** Per-check counts for the review log line. */
export function criteriaCounts(runs: CriterionRun[]): {
  checks: number
  passed: number
  failed: number
  unrunnable: number
} {
  const all = runs.flatMap((r) => r.checks)
  const passed = all.filter((c) => c.status === 'passed').length
  const failed = all.filter((c) => c.status === 'failed').length
  return {
    checks: passed + failed,
    passed,
    failed,
    unrunnable: all.length - passed - failed,
  }
}

/** Whether a stored `criteria_runs` value has the shape this module writes. */
export function isCriterionRuns(value: unknown): value is CriterionRun[] {
  return (
    Array.isArray(value) &&
    value.every(
      (r) =>
        r !== null &&
        typeof r === 'object' &&
        typeof (r as CriterionRun).number === 'number' &&
        typeof (r as CriterionRun).criterion === 'string' &&
        Array.isArray((r as CriterionRun).checks),
    )
  )
}
