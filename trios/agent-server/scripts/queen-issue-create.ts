#!/usr/bin/env bun
/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The canonical preflight wrapper for creating Queen GitHub tasks.
 *
 * There are many ways to run `gh issue create`, and that is the problem: a
 * Russian task slips into the queue whenever any one of them forgets to
 * check. So there is now one blessed door - this script - and the door does
 * the checking itself:
 *
 *   1. Validate the title and body with the language policy BEFORE any
 *      GitHub command is built, spawned or invoked. A refused task never
 *      reaches `gh`, not even to be rejected there.
 *   2. Pass accepted content through VERBATIM. No rewriting, no translating,
 *      no re-encoding - `gh` receives the exact strings through an argv array,
 *      never a shell, so nothing can mangle them in transit.
 *   3. Say nothing about secrets. The wrapper does not read, print or log
 *      credentials, tokens or environment values; a refusal names the field
 *      and the rule, and quotes none of the submitted text.
 *
 * The policy is creation-only. Reading issues (`gh issue list`, `gh issue
 * view`) and the RU/EN dashboard localisation are outside this gate and stay
 * exactly as they are.
 *
 * Usage:
 *
 *   bun agent-server/scripts/queen-issue-create.ts --title '...' --body '...'
 *
 * Run with --help for the full option list.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import {
  ENGLISH_ONLY_RULE,
  validateIssueLanguage,
} from '../apps/server/src/api/services/queen-issue-language'

/** Exit codes, kept distinct so callers can tell refusal from GitHub failure. */
export const EXIT_OK = 0
export const EXIT_REFUSED = 1
export const EXIT_USAGE = 2
export const EXIT_GH_FAILED = 3

/**
 * A GitHub CLI invocation, as an argv array.
 *
 * Arrays, not strings: the title and body travel as single arguments without
 * any shell ever seeing them, which is what makes "pass content unchanged" a
 * property of the code rather than a hope about quoting.
 */
export interface GhInvocation {
  command: string
  args: string[]
}

/** What a finished `gh` run looks like. */
export interface GhResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * How the wrapper talks to `gh`. Injectable so tests can prove - with a fake
 * that records every call - that a refused task produces exactly zero
 * invocations.
 */
export type GhRunner = (invocation: GhInvocation) => GhResult

/** The task to create. Title and body are the only required content. */
export interface CreateIssueRequest {
  title: string
  body: string
  repo?: string
  labels?: string[]
  assignee?: string
}

/** Success: the issue exists, and `gh` printed its URL. */
export interface CreateIssueOk {
  ok: true
  /** The command that ran, for tests and for audits of what was sent. */
  invocation: GhInvocation
  url: string
}

/** The language policy refused the task; `gh` was never invoked. */
export interface CreateIssueRefused {
  ok: false
  refused: true
  field: 'title' | 'body'
  reason: string
}

/** `gh` ran and failed; the task may or may not exist on GitHub. */
export interface CreateIssueGhFailure {
  ok: false
  refused: false
  invocation: GhInvocation
  gh: GhResult
}

export type CreateIssueOutcome =
  | CreateIssueOk
  | CreateIssueRefused
  | CreateIssueGhFailure

/** The real runner: spawn `gh` directly, no shell in between. */
export const spawnGh: GhRunner = (invocation) => {
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
  })
  return {
    status: result.status ?? EXIT_GH_FAILED,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * Build the `gh issue create` argv for a request.
 *
 * The title and body go in as the exact strings given - this function has no
 * opportunity to rewrite them, and that is the point of its shape.
 */
export function buildGhArgs(request: CreateIssueRequest): string[] {
  const args = [
    'issue',
    'create',
    '--title',
    request.title,
    '--body',
    request.body,
  ]
  if (request.repo !== undefined && request.repo.length > 0) {
    args.push('--repo', request.repo)
  }
  for (const label of request.labels ?? []) {
    if (label.length > 0) {
      args.push('--label', label)
    }
  }
  if (request.assignee !== undefined && request.assignee.length > 0) {
    args.push('--assignee', request.assignee)
  }
  return args
}

/**
 * Create a task issue through the one blessed door.
 *
 * Validation runs first and alone: when it fails, this returns without
 * touching the runner at all, so a fake `gh` in a test observes zero calls -
 * the same zero the production path guarantees.
 */
export function createQueenIssue(
  request: CreateIssueRequest,
  options: { gh?: GhRunner } = {},
): CreateIssueOutcome {
  const verdict = validateIssueLanguage(request.title, request.body)
  if (!verdict.ok) {
    return {
      ok: false,
      refused: true,
      field: verdict.field,
      reason: verdict.reason,
    }
  }

  const gh = options.gh ?? spawnGh
  const invocation = { command: 'gh', args: buildGhArgs(request) }
  const result = gh(invocation)
  if (result.status === EXIT_OK) {
    return { ok: true, invocation, url: result.stdout.trim() }
  }
  return { ok: false, refused: false, invocation, gh: result }
}

/** What `parseCliArgs` can hand back. Help and errors stay data, not exits. */
export type CliParse =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'request'; request: CreateIssueRequest; bodyFile?: string }

/** Every option that takes a value. Anything else is a usage error. */
const KNOWN_OPTIONS = new Set([
  '--title',
  '--body',
  '--body-file',
  '--repo',
  '--label',
  '--assignee',
])

/** The value of an option, inline (`--title=X`) or as the next argument. */
function optionValue(
  args: string[],
  index: number,
  name: string,
): { value: string; next: number } | { error: string } {
  const arg = args[index]
  const eq = arg.indexOf('=')
  if (eq !== -1) {
    return { value: arg.slice(eq + 1), next: index + 1 }
  }
  if (index + 1 >= args.length) {
    return { error: `--${name} requires a value` }
  }
  return { value: args[index + 1], next: index + 2 }
}

/**
 * Parse command-line arguments deterministically.
 *
 * Pure: no process access, no file reads, no exits. `--body-file` only
 * records the path; the caller decides what reading it means, so a bad path
 * and a refusal stay distinguishable.
 */
export function parseCliArgs(argv: string[]): CliParse {
  const request: CreateIssueRequest = { title: '', body: '' }
  const labels: string[] = []
  let titleSet = false
  let bodySet = false
  let bodyFile: string | undefined
  let hasBodyFile = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      return { kind: 'help' }
    }
    // Both spellings route through the same lookup: `--title X` and
    // `--title=X` must never behave differently.
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const token = eq === -1 ? arg : arg.slice(0, eq)
    const name = token.slice(2)

    const got = KNOWN_OPTIONS.has(token)
      ? optionValue(argv, i, name)
      : undefined
    if (got !== undefined) {
      if ('error' in got) {
        return { kind: 'error', message: got.error }
      }
      switch (token) {
        case '--title':
          request.title = got.value
          titleSet = true
          break
        case '--body':
          request.body = got.value
          bodySet = true
          break
        case '--body-file':
          bodyFile = got.value
          hasBodyFile = true
          break
        case '--repo':
          request.repo = got.value
          break
        case '--label':
          labels.push(got.value)
          break
        case '--assignee':
          request.assignee = got.value
          break
      }
      i = got.next - 1
      continue
    }
    return { kind: 'error', message: `unknown option: ${arg}` }
  }

  if (!titleSet) {
    return { kind: 'error', message: '--title is required' }
  }
  if (bodySet && hasBodyFile) {
    return {
      kind: 'error',
      message: 'use either --body or --body-file, not both',
    }
  }
  if (labels.length > 0) {
    request.labels = labels
  }
  return hasBodyFile
    ? { kind: 'request', request, bodyFile }
    : { kind: 'request', request }
}

/** The help text. Documents the English-only rule, because help that hides
 * the one rule the tool enforces is how the rule gets discovered too late. */
export function usageText(): string {
  return `queen-issue-create - the canonical preflight for creating Queen GitHub tasks

USAGE
  bun agent-server/scripts/queen-issue-create.ts --title <text> --body <text> [options]

OPTIONS
  --title <text>        Issue title. Required.
  --body <text>         Issue body as a literal string.
  --body-file <path>    Read the issue body from a file. Either this or --body.
  --repo <owner/name>   Target repository. Defaults to the gh default.
  --label <name>        Label to attach. Repeatable.
  --assignee <login>    Account to assign the issue to.
  -h, --help            Show this help and exit 0.

LANGUAGE POLICY (READ THIS BEFORE YOUR FIRST RUN)
  ${ENGLISH_ONLY_RULE}
  The check runs before any GitHub command is invoked, so a refused task
  never leaves this machine. Nothing is translated or rewritten for you -
  rewrite the task in English and run again. This policy is creation-only:
  reading historical issues and the RU/EN dashboard localisation are not
  affected.

  On refusal this tool prints the field and the rule above - never the
  submitted text - and it never reads, prints or logs credentials.

EXIT STATUS
  0  issue created (the new issue URL is printed)
  1  refused by the English-only language policy
  2  usage error
  3  the gh command failed

WHY A WRAPPER AT ALL
  The policy lives in one place (the language validator imported by this
  script) instead of in the memory of every agent that can type
  "gh issue create".`
}

/** Run the CLI. Returns the process exit code; never throws to the shell. */
export function main(argv: string[], runner: GhRunner = spawnGh): number {
  const parsed = parseCliArgs(argv)
  if (parsed.kind === 'help') {
    console.log(usageText())
    return EXIT_OK
  }
  if (parsed.kind === 'error') {
    console.error(`error: ${parsed.message}`)
    console.error('Run with --help for usage.')
    return EXIT_USAGE
  }

  let request = parsed.request
  if (parsed.bodyFile !== undefined) {
    let fileBody: string
    try {
      fileBody = readFileSync(parsed.bodyFile, 'utf8')
    } catch {
      console.error(`error: cannot read --body-file: ${parsed.bodyFile}`)
      return EXIT_USAGE
    }
    request = { ...request, body: fileBody }
  }

  const outcome = createQueenIssue(request, { gh: runner })
  if (outcome.ok) {
    console.log(outcome.url)
    return EXIT_OK
  }
  if (outcome.refused) {
    console.error(`error: ${outcome.field}: ${outcome.reason}`)
    console.error('Nothing was sent to GitHub.')
    return EXIT_REFUSED
  }
  console.error(`gh exited ${outcome.gh.status}`)
  if (outcome.gh.stderr.length > 0) {
    console.error(outcome.gh.stderr.trimEnd())
  }
  return EXIT_GH_FAILED
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
