#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The parked dispatch queue, counted (#1362).
 *
 * Thirteen dispatches sat finished with no path forward on 2026-09-03 - seven
 * sent back and re-dispatched by nothing, six escalated and waiting for a
 * person who was not watching a Postgres column - and the only way to see
 * that was to read the table by hand. This prints the queue in sentences:
 * each row with its issue, state, attempt count and age, the kind for every
 * escalation, and totals per state.
 *
 * WHY THE ROWS COME FROM A FILE THE CALLER SUPPLIES. The worker container
 * holds no database credential by design, and a report tool that connected
 * for itself would fail that connection SILENTLY where a tool is most
 * tempted to: an empty queue printed from a dead connection looks exactly
 * like a queue nobody is stuck in. So the operator dumps the rows where the
 * credential lives, for example:
 *
 *   psql "$QUEEN_DATABASE_URL" -Atc "
 *     SELECT json_agg(row_to_json(d))
 *       FROM queen_dispatch d
 *      WHERE d.started = true
 *        AND d.finished_at IS NOT NULL
 *        AND d.review_state IN ('sendBack', 'escalate')
 *        AND d.outcome NOT LIKE 'reaped%'" > rows.json
 *
 *   node trios/tools/parked-dispatch-report.mjs rows.json
 *
 * and this tool refuses loudly when the file cannot be read or does not hold
 * a row array, because the silent empty queue is the failure this exists to
 * prevent.
 *
 * ROW SHAPE, the columns the query above produces:
 *   issue            the issue number
 *   review_state     'sendBack' or 'escalate' (anything else is printed as-is)
 *   send_backs       times the work has been returned, 0 when absent
 *   finished_at      when the bee finished, any ISO 8601 form
 *   escalation_kind  classified cause, null when not yet classified
 *
 * Plain node, no dependencies: this may run on a laptop that has nothing of
 * the agent server installed.
 */

import { readFileSync } from 'node:fs'

const USAGE =
  'usage: node trios/tools/parked-dispatch-report.mjs <rows.json>\n' +
  '  rows.json: an array of queen_dispatch rows (see the header of this file ' +
  'for the query that produces them)'

const path = process.argv[2]
if (!path) {
  console.error(USAGE)
  process.exit(1)
}

let rows
try {
  rows = JSON.parse(readFileSync(path, 'utf8'))
} catch (error) {
  console.error(`could not read rows from ${path}: ${error.message}`)
  console.error(USAGE)
  process.exit(1)
}
if (!Array.isArray(rows)) {
  console.error(
    `${path} does not hold an array of rows - a connection failure dumped ` +
      'as an empty file must not read as an empty queue',
  )
  process.exit(1)
}

/** Whole days since the bee finished, or null for an unreadable date. */
const ageInDays = (when) => {
  const at = Date.parse(String(when ?? ''))
  if (!Number.isFinite(at)) return null
  return Math.floor((Date.now() - at) / 86_400_000)
}

console.log(`Parked dispatches, ${rows.length} row(s) from ${path}`)
if (rows.length > 0) console.log('')

const totals = {}
for (const row of rows) {
  const issue = row.issue ?? '?'
  const state = String(row.review_state ?? 'unknown')
  totals[state] = (totals[state] ?? 0) + 1
  const sendBacks = row.send_backs ?? 0
  const age = ageInDays(row.finished_at)
  const ageText = age === null ? 'unknown' : `${age}d`
  const line =
    `#${issue}  ${state}  send_backs=${sendBacks}  age=${ageText}`
  if (state === 'escalate') {
    // The kind an escalation carries, or the honest statement that it has
    // not been classified yet - which is 'needs-a-person' the moment the
    // classifier pass runs, and reads as exactly that to whoever is deciding
    // what to do with the queue.
    const kind = row.escalation_kind ?? 'needs-a-person (not yet classified)'
    console.log(`${line}  kind=${kind}`)
  } else {
    console.log(line)
  }
}

console.log('')
console.log('Totals')
for (const [state, count] of Object.entries(totals)) {
  console.log(`  ${state}: ${count}`)
}
