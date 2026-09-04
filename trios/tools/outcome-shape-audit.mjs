#!/usr/bin/env node
/**
 * #1360. Audit the SHAPE of `queen_dispatch.outcome`, and nothing else.
 *
 *   node trios/tools/outcome-shape-audit.mjs <rows.json>
 *
 * WHY A FILE, NOT A DATABASE (FR-006). The worker container holds no database
 * credential, so an audit that connected would fail its connection in
 * silence and report the table as clean - which is worse than no audit,
 * because it looks like an answer. This tool opens NO connection at all. The
 * caller exports the rows themselves, for example:
 *
 *   psql ... -c "SELECT issue, outcome FROM queen_dispatch" --json > rows.json
 *
 * and hands the file over. The accepted shapes are a bare JSON array of row
 * objects, or an object with a `rows` array (what pg's `pool.query` returns).
 *
 * WHAT IT REPORTS. Every row whose `outcome` is malformed by the two rules
 * the column now lives under (see DISPATCH_OUTCOME_LABELS in
 * trios/agent-server/apps/server/src/api/services/queen-dispatch.ts, which is
 * the source of truth this tool mirrors):
 *
 *   1. longer than the cap below; or
 *   2. a string that parses as JSON - an outcome is a short label, never a
 *      serialized event.
 *
 * For each malformed row it prints the label the row SHOULD have carried.
 * For the historical rows this defect is about - `provider refused: ` glued
 * to a serialized tool-output event - the honest label is the one that says
 * the cause was never determined, because nothing in the stored blob
 * measured why the turn stopped. A reviewer who knows a real cause may of
 * course pick a different label from the set; the audit prints the default,
 * not a prescription.
 *
 * IT REPORTS; IT NEVER REWRITES (FR-003). No existing row is modified, no
 * SQL is generated, no file is written - not even the input file is touched
 * after being read. Editing history to make a report clean is how the record
 * stops being a record.
 *
 * Exit codes: 0 the table is clean, 1 malformed rows were found (so a gate
 * can use this), 2 the tool was misused (bad invocation, unreadable file,
 * unparseable JSON).
 */

import { readFileSync } from 'node:fs'

/**
 * The longest `outcome` the dispatch path may write. Mirrors
 * DISPATCH_OUTCOME_MAX_LENGTH in
 * agent-server/apps/server/src/api/services/queen-dispatch.ts. When that
 * constant moves, this moves with it - the audit is only as honest as the
 * two numbers agreeing.
 */
const OUTCOME_MAX_LENGTH = 64

/**
 * The label a malformed row should have carried. Mirrors
 * DISPATCH_OUTCOME_LABELS.endedUnexpectedly in the same file. A row whose
 * stored outcome is a payload tells the reader nothing about cause, so the
 * honest replacement label is the one that admits the gap.
 */
const UNDETERMINED_LABEL = 'ended unexpectedly (cause undetermined)'

/** Enough of a blob to recognise it, not enough to reprint it. */
const PREVIEW_LENGTH = 120

const usage = () => {
  process.stderr.write(
    'usage: node trios/tools/outcome-shape-audit.mjs <rows.json>\n' +
      '  rows.json: a JSON array of queen_dispatch rows, or { "rows": [...] }\n',
  )
  process.exit(2)
}

const args = process.argv.slice(2)
if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') usage()

let raw
try {
  raw = readFileSync(args[0], 'utf8')
} catch (error) {
  process.stderr.write(`cannot read ${args[0]}: ${error.message}\n`)
  process.exit(2)
}

let parsed
try {
  parsed = JSON.parse(raw)
} catch (error) {
  process.stderr.write(`${args[0]} is not JSON: ${error.message}\n`)
  process.exit(2)
}

const rows = Array.isArray(parsed)
  ? parsed
  : parsed && Array.isArray(parsed.rows)
    ? parsed.rows
    : null
if (rows === null) {
  process.stderr.write(
    `${args[0]} holds neither a row array nor { "rows": [...] }\n`,
  )
  process.exit(2)
}

/** A string that parses as JSON is a payload, and a payload is not a label. */
const parsesAsJson = (text) => {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

const oneLine = (text) => text.replaceAll('\n', '\\n')

const malformed = []
let counted = 0

for (const row of rows) {
  if (row === null || typeof row !== 'object') continue
  counted += 1
  const outcome = row.outcome
  // NULL or absent means the row is not over (or predates the column); an
  // unfinished row has no ending to judge.
  if (typeof outcome !== 'string' || outcome.length === 0) continue

  const reasons = []
  if (outcome.length > OUTCOME_MAX_LENGTH) {
    reasons.push(`over cap (${outcome.length} > ${OUTCOME_MAX_LENGTH} chars)`)
  }
  if (parsesAsJson(outcome)) reasons.push('parses as JSON')

  if (reasons.length === 0) continue
  malformed.push({ row, outcome, reasons })
}

if (malformed.length > 0) {
  for (const { row, outcome, reasons } of malformed) {
    const issue = 'issue' in row ? row.issue : '(no issue field)'
    console.log(
      `issue ${issue}: malformed outcome - ${reasons.join('; ')}` +
        `\n  stored:    "${oneLine(outcome.slice(0, PREVIEW_LENGTH))}` +
        `${outcome.length > PREVIEW_LENGTH ? '...' : ''}"` +
        `\n  should be: "${UNDETERMINED_LABEL}"`,
    )
  }
}

console.log(
  `total: ${malformed.length} malformed of ${counted} rows read` +
    ` (cap ${OUTCOME_MAX_LENGTH} chars)`,
)
process.exit(malformed.length > 0 ? 1 : 0)
