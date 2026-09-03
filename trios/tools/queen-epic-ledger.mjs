#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * queen-epic-ledger - keep the map of epic gHashTag/trios#1334 true.
 *
 * The epic froze a table of counts (done 41, review 12, backlog 17, 0
 * startable) at the moment it was written, and observed that every number in
 * it goes stale within the day. An epic is a map, not a task: what a tool can
 * do is rewrite the table from measurement. This script is that tool.
 *
 * On every run it reads, and reads only:
 *
 *   1. GET /queen/status       on the configured supervisor origin
 *   2. GET /queen/public-board on the configured supervisor origin
 *   3. GET /repos/<repo>/issues/<n> on api.github.com for the seven blockers
 *
 * and writes docs/queen-epic-1334-ledger.md next to the docs directory. Every
 * number in that file carries the ISO-8601 timestamp of the response it came
 * from; nothing is carried over from a previous run or from the epic text.
 *
 * Failure discipline (FR-003): if the supervisor answers anything but HTTP 200
 * on either route, the script names the route on stderr and exits 1 without
 * writing the ledger - a ledger of missing numbers is worse than no ledger.
 * The same holds for any blocker whose GitHub state could not be read: the
 * file only ever says `open` or `closed` about a state it actually observed.
 *
 * Credential discipline (FR-004): no Authorization header is sent anywhere,
 * nothing is read from any environment variable whose name contains KEY or
 * TOKEN (enforced structurally by readEnv below, not by hope), and nothing
 * that could be a credential is printed. Both endpoints are public on
 * purpose; the issue states come from the public REST API of a public repo.
 *
 * Run from anywhere:  node tools/queen-epic-ledger.mjs [--origin <url>]
 * The output path is resolved from this file's own location, so the working
 * directory does not decide where the ledger lands.
 *
 * Node >= 18 (or any runtime with global fetch). No dependencies outside the
 * Node standard library.
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The production supervisor, as deployed in .trinity/dashboard/CLOUD-MIGRATION.md. */
const DEFAULT_ORIGIN = 'https://trios-agent-server-production.up.railway.app'

/** The two public routes this ledger is built from (FR-001). */
const STATUS_ROUTE = '/queen/status'
const BOARD_ROUTE = '/queen/public-board'

/** The seven blockers of epic #1334, in the order FR-002 lists them. */
const BLOCKER_ISSUES = [1327, 1328, 1329, 1330, 1331, 1332, 1333]

const EPIC_ISSUE = 1334

const REQUEST_TIMEOUT_MS = 20_000

/** Where the ledger lands, resolved from this file: <trios>/docs/. */
const LEDGER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'queen-epic-1334-ledger.md',
)

/**
 * The only environment variables this script may consult.
 *
 * Neither name contains KEY or TOKEN. The guard in readEnv below makes that
 * constraint executable rather than aspirational: an allow-list entry that
 * violates it fails the run loudly instead of reading a secret.
 */
const ENV_ALLOWLIST = ['TRIOS_SUPERVISOR_ORIGIN']

function readEnv(name) {
  if (/KEY|TOKEN/i.test(name)) {
    throw new Error(`refusing to read environment variable "${name}": its name contains KEY or TOKEN`)
  }
  if (!ENV_ALLOWLIST.includes(name)) {
    throw new Error(`environment variable "${name}" is not in the allowlist: ${ENV_ALLOWLIST.join(', ')}`)
  }
  return process.env[name]
}

/** Fetch with a hard timeout. Returns the Response; HTTP status is checked by callers. */
async function fetchJson(url, headers) {
  if (typeof fetch !== 'function') {
    throw new Error('this runtime has no global fetch; run with Node >= 18')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', ...headers },
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A supervisor route that did not answer HTTP 200 (FR-003).
 *
 * The route is part of the message, never just the status: "the supervisor
 * answered 404" names nothing, while "route /queen/status answered 404" names
 * the exact promise that broke.
 */
class SupervisorRouteError extends Error {
  constructor(route, status) {
    super(`supervisor route ${route} answered HTTP ${status}, expected 200`)
    this.route = route
    this.status = status
  }
}

/**
 * GET one supervisor route and parse its JSON, timestamping the read.
 *
 * Anything but HTTP 200 throws SupervisorRouteError naming the route. A body
 * that is not JSON is the same failure: a 200 with an HTML error page behind
 * a proxy has lied about its status line before.
 */
async function readSupervisorRoute(origin, route) {
  let response
  try {
    response = await fetchJson(origin + route)
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timed out' : error?.message
    throw new Error(`supervisor route ${route} could not be read: ${reason}`)
  }
  if (response.status !== 200) {
    throw new SupervisorRouteError(route, response.status)
  }
  let body
  try {
    body = await response.json()
  } catch (error) {
    throw new Error(`supervisor route ${route} answered HTTP 200 but not JSON: ${error.message}`)
  }
  return { route, body, readAt: new Date().toISOString() }
}

/**
 * The board's own column counts, measured live from /queen/public-board.
 *
 * The columns are the Queen's own states (the route serializes them in
 * `columns`); cards are counted by their `column` value rather than by
 * assumptions about which columns exist, so a column the route adds or drops
 * appears or disappears here without this code changing.
 *
 * Returns one entry per column actually present on the board, in the order
 * the route lists them, each with the timestamp of the single response all of
 * them were read from - one ISO timestamp per count, and the same honest
 * instant for counts that arrived in one response.
 */
async function readBoardCounts(origin) {
  const { body, readAt } = await readSupervisorRoute(origin, BOARD_ROUTE)
  const cards = Array.isArray(body?.cards) ? body.cards : []
  const columnOrder = (Array.isArray(body?.columns) ? body.columns : [])
    .map((column) => column?.key)
    .filter((key) => typeof key === 'string')

  const tallies = new Map()
  for (const card of cards) {
    const column = card?.column
    if (typeof column !== 'string') continue
    tallies.set(column, (tallies.get(column) ?? 0) + 1)
  }

  const counts = columnOrder.map((key) => ({
    column: key,
    cards: tallies.get(key) ?? 0,
    readAt,
  }))
  return {
    repo: typeof body?.repo === 'string' ? body.repo : null,
    totalCards: cards.length,
    pulse: body?.pulse ?? null,
    counts,
    readAt,
  }
}

/**
 * The public swarm status from /queen/status, timestamped at its read.
 *
 * Only the fields the ledger quotes are picked out, and the swarmState
 * vocabulary is the closed one from docs/public-swarm-state.md - this script
 * prints it verbatim and never interprets it.
 */
async function readSwarmStatus(origin) {
  const { body, readAt } = await readSupervisorRoute(origin, STATUS_ROUTE)
  return {
    swarmState: typeof body?.swarmState === 'string' ? body.swarmState : null,
    scheduler: body?.scheduler ?? null,
    dispatches: body?.dispatches ?? null,
    lastTick: body?.lastTick ?? null,
    readAt,
  }
}

/**
 * GitHub state of one issue, read from the public REST API (FR-002).
 *
 * `gh issue view --json state` and this call answer from the same source; the
 * REST API needs no credential for a public repository, which is why it is
 * the one used here. No Authorization header is ever attached, so no token
 * can leak through this path even if one existed in the environment.
 */
async function readIssueState(repo, number) {
  const url = `https://api.github.com/repos/${repo}/issues/${number}`
  const response = await fetchJson(url, {
    'User-Agent': 'queen-epic-ledger',
    'X-GitHub-Api-Version': '2022-11-28',
  })
  if (response.status !== 200) {
    throw new Error(`GitHub REST API answered HTTP ${response.status} for ${repo}#${number}, expected 200`)
  }
  const issue = await response.json()
  const state = issue?.state
  if (state !== 'open' && state !== 'closed') {
    throw new Error(`GitHub returned no open/closed state for ${repo}#${number}`)
  }
  return {
    number,
    state,
    title: typeof issue?.title === 'string' ? issue.title : '',
    readAt: new Date().toISOString(),
  }
}

/** Escape text for a markdown table cell so a title can never break the row. */
function markdownCell(text) {
  return String(text).replaceAll('|', '\\|')
}

/**
 * Render a measured scalar, or `n/a` when the field was genuinely absent.
 *
 * A boolean that arrived as `true` must print as `true`, never as `n/a`:
 * turning an observed value into a missing one is the same lie as inventing
 * one. `n/a` is reserved for fields the response did not carry.
 */
function formatScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string' && value.length > 0) return value
  return 'n/a'
}

/**
 * Render the ledger.
 *
 * Every measured value sits next to the ISO-8601 timestamp of the response it
 * came from. The epic's own frozen table is deliberately not reproduced here:
 * hardcoding it would put the issue's text into the tool, and the day it was
 * written about is exactly what this file replaces.
 */
function renderLedger({ origin, generatedAt, board, status, blockers }) {
  const lines = []
  lines.push(`# Queen epic #${EPIC_ISSUE} ledger - a swarm that does not stop while there is a backlog`)
  lines.push('')
  lines.push(`Regenerated by \`tools/queen-epic-ledger.mjs\`. Every number below was`)
  lines.push(`measured from the live board and the GitHub REST API at the timestamp on`)
  lines.push(`its own line; nothing is carried over from the epic text or from a`)
  lines.push(`previous run. The epic's own table froze the day it was written and is`)
  lines.push(`deliberately not reproduced - this file is what supersedes it.`)
  lines.push('')
  lines.push(`- supervisor origin: ${origin}`)
  lines.push(`- repository: ${board.repo ?? 'unknown'}`)
  lines.push(`- ledger generated at: ${generatedAt}`)
  lines.push('')
  lines.push(`## Board counts (live)`)
  lines.push('')
  lines.push(`Read from \`GET ${BOARD_ROUTE}\`. Columns are the Queen's own states, in`)
  lines.push(`the route's own order; each count is cards-per-column, timestamped at`)
  lines.push(`the response that carried it.`)
  lines.push('')
  lines.push(`| column | cards | read at |`)
  lines.push(`|---|---|---|`)
  for (const count of board.counts) {
    lines.push(`| ${markdownCell(count.column)} | ${count.cards} | ${count.readAt} |`)
  }
  lines.push(`| total | ${board.totalCards} | ${board.readAt} |`)
  lines.push('')
  if (board.pulse) {
    lines.push(`Pulse, from the same response: ${JSON.stringify(board.pulse)}`)
    lines.push('')
  }
  lines.push(`## Swarm status (live)`)
  lines.push('')
  lines.push(`Read from \`GET ${STATUS_ROUTE}\` at ${status.readAt}.`)
  lines.push('')
  lines.push(`- swarmState: \`${status.swarmState ?? 'n/a'}\``)
  if (status.scheduler) {
    lines.push(`- scheduler: enabled=${formatScalar(status.scheduler.enabled)} intervalSeconds=${formatScalar(status.scheduler.intervalSeconds)} billingMode=\`${markdownCell(status.scheduler.billingMode ?? 'n/a')}\``)
  }
  if (status.dispatches) {
    lines.push(`- dispatches: total=${formatScalar(status.dispatches.total)} finished=${formatScalar(status.dispatches.finished)} running=${formatScalar(status.dispatches.running)} unreviewed=${formatScalar(status.dispatches.unreviewed)} (read at ${status.readAt})`)
    const latest = status.dispatches.latest
    if (latest) {
      lines.push(`- latest dispatch: issue #${formatScalar(latest.issue)} dispatched at ${markdownCell(latest.dispatchedAt ?? 'n/a')} (finished: ${markdownCell(latest.finishedAt ?? 'not yet')})`)
    }
  }
  if (status.lastTick) {
    lines.push(`- last tick: decided at ${markdownCell(status.lastTick.decidedAt ?? 'n/a')}, allowed=${formatScalar(status.lastTick.allowed)} skipped=${formatScalar(status.lastTick.skippedCount)}`)
  }
  lines.push('')
  lines.push(`## Blockers of the epic (GitHub state, live)`)
  lines.push('')
  lines.push(`State read per issue from \`GET https://api.github.com/repos/${board.repo ?? 'gHashTag/trios'}/issues/<n>\``)
  lines.push(`at the timestamp on its line - never from the epic's own text, which`)
  lines.push(`described these issues on the day the epic was written.`)
  lines.push('')
  lines.push(`| issue | state | title | read at |`)
  lines.push(`|---|---|---|---|`)
  for (const blocker of blockers) {
    lines.push(`| #${blocker.number} | ${blocker.state} | ${markdownCell(blocker.title)} | ${blocker.readAt} |`)
  }
  lines.push('')
  lines.push(`## How to refresh`)
  lines.push('')
  lines.push(`    node tools/queen-epic-ledger.mjs [--origin <supervisor origin>]`)
  lines.push('')
  lines.push(`Exits non-zero, naming the route, if the supervisor answers anything`)
  lines.push(`but HTTP 200 on either of the two routes above. Reads no credential`)
  lines.push(`and no environment variable whose name contains KEY or TOKEN.`)
  lines.push('')
  return lines.join('\n')
}

function usage() {
  return [
    'Usage: node tools/queen-epic-ledger.mjs [--origin <supervisor origin>]',
    '',
    'Reads /queen/status and /queen/public-board from the supervisor origin',
    `(default: ${DEFAULT_ORIGIN}, override with --origin or TRIOS_SUPERVISOR_ORIGIN)`,
    'plus the GitHub state of the seven blockers of epic #1334, and rewrites',
    'docs/queen-epic-1334-ledger.md from those measurements alone.',
  ].join('\n')
}

function parseArgs(argv) {
  const parsed = { origin: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--origin' && index + 1 < argv.length) {
      parsed.origin = argv[(index += 1)]
    } else if (argument === '--help' || argument === '-h') {
      parsed.help = true
    } else {
      throw new Error(`unknown argument: ${argument}\n\n${usage()}`)
    }
  }
  return parsed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  const origin = (args.origin ?? readEnv('TRIOS_SUPERVISOR_ORIGIN') ?? DEFAULT_ORIGIN).replace(/\/+$/, '')

  const board = await readBoardCounts(origin)
  const status = await readSwarmStatus(origin)
  const repo = board.repo ?? 'gHashTag/trios'
  const blockers = []
  for (const number of BLOCKER_ISSUES) {
    blockers.push(await readIssueState(repo, number))
  }

  const ledger = renderLedger({
    origin,
    generatedAt: new Date().toISOString(),
    board,
    status,
    blockers,
  })
  writeFileSync(LEDGER_PATH, ledger, 'utf8')
  process.stdout.write(
    `wrote ${path.relative(process.cwd(), LEDGER_PATH) || LEDGER_PATH} (${ledger.length} characters) from ${origin}\n`,
  )
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  },
)
