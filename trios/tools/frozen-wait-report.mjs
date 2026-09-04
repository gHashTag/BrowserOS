#!/usr/bin/env node
//
// frozen-wait-report — the third one-way valve, made visible.
//
// A `wait` verdict on a FINISHED dispatch is a promise that a later judgement
// will arrive. None can. The bee's transcript is finished and immutable, so
// `reviewFinishedDispatches` re-reading a wait row every round yields the same
// "N of M criteria judged so far" for ever, and the dispatch holds its
// boundary paths against every candidate that touches them, counted in the
// round's `claimed` skips, until the 48-hour window expires. Measured in
// production 2026-09-04: #1361 finished after 289 s and #1362 after 1870 s,
// both `review_state = wait`, both still `wait` hours later.
//
// `sendBack` promises a bee will return and none does. `escalate` waits for a
// person and reaches no person. `wait` promises a later judgement that cannot
// arrive. Each is a state that means "not finished" and behaves as "never".
// This tool names the third one. It does not repair it: it writes no dispatch
// row, no issue, nothing (FR-001). Naming the condition is the deliverable;
// what to do about a frozen wait is a separate decision for a person, and the
// repair must not invent a verdict an unfinished transcript cannot support.
//
// Usage:
//   node trios/tools/frozen-wait-report.mjs <rows.json>
//   node trios/tools/frozen-wait-report.mjs --selftest
//
// <rows.json> is a file the CALLER supplies (FR-002), holding dispatch rows in
// the shape `reviewFinishedDispatches` selects from `queen_dispatch`:
//
//   { "issue": 1361, "conversation_id": "...", "review_state": "wait",
//     "criteria": ["...", "..."], "criteria_source": "issue",
//     "send_backs": 0, "owned_paths": ["src/a.ts"], "said": "<transcript>",
//     "finished_at": "2026-09-05T05:55:00Z" }
//
// Either a bare array of such rows, or an envelope fixing the reference clock:
//   { "asOf": "2026-09-05T12:00:00Z", "rows": [ ... ] }
// The worker container holds no database credential, so rows arrive by file —
// and a file that cannot be read or parsed is an ERROR, never an empty report,
// because an empty report is the one answer that hides exactly the condition
// this exists to find.
//
// Outcomes (FR-003), one per wait row, never shared:
//   frozen      finished past the fresh window with fewer criteria judged than
//               the dispatch row declares — the wait cannot change, because
//               the transcript cannot change
//   fresh       finished inside the fresh window — a verdict not yet swept is
//               not a stuck verdict
//   unreadable  no `## VERDICT` block could be found in the transcript — the
//               row says the transcript was unreadable, never "0 criteria
//               judged", because zero-because-unparsed and
//               zero-because-unjudged are different findings and must not
//               share a number
// A wait row whose transcript judged every declared criterion is NOT listed:
// the next sweep will judge it for real, so it is not frozen.
//
// Node standard library only (FR-005).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** FR-004: the line between "not swept yet" and "stuck". Named, and printed
 *  by every run. A dispatch that finished within this window of the report
 *  time is `fresh`; one that finished before it can only be frozen, because
 *  the sweep re-reads every wait row each round and an unchanged transcript
 *  yields the same wait every time. */
export const FRESH_WINDOW_MS = 60 * 60 * 1000

/** How many held paths to print per row before eliding. The totals are always
 *  exact; only the listing is capped. */
const MAX_PATHS_LISTED = 8

/**
 * The bee's own VERDICT block, or nothing.
 *
 * A deliberate JS twin of `parseVerdictBlock` in
 * agent-server/apps/server/src/api/services/queen-tick.ts — the same rule the
 * review runs, so this report counts what the review counts and never invents
 * its own arithmetic. Keep the two in lockstep: a header found here but not
 * there, or a bullet joined here but split there, would make the report
 * disagree with the verdict it is reporting on.
 */
export function parseVerdictBlock(text) {
  const at = text.lastIndexOf('## VERDICT')
  if (at < 0) return []
  const out = []
  // A wrapped criterion is still one criterion: a non-bullet line following an
  // incomplete bullet (one not ending in a verdict word) is glued on, while a
  // line after a COMPLETE bullet still ends the block, because the bee was
  // told nothing follows it.
  const joined = []
  for (const raw of text.slice(at).split('\n').slice(1)) {
    const isBullet = /^\s*[-*]\s/.test(raw)
    const previous = joined[joined.length - 1]
    const previousIsComplete =
      previous === undefined ||
      /:\s*(met|unmet|could-not-check)\s*$/i.test(previous)
    if (!isBullet && !previousIsComplete && raw.trim() !== '') {
      joined[joined.length - 1] = `${previous} ${raw.trim()}`
      continue
    }
    joined.push(raw)
  }
  for (const line of joined) {
    const m = line.match(/^\s*[-*]\s*(.+?):\s*(met|unmet|could-not-check)\s*$/i)
    if (!m) {
      // A blank line inside the block is fine; anything else ends it.
      if (line.trim() === '') continue
      break
    }
    out.push({
      criterion: m[1].trim().slice(0, 300),
      // could-not-check is UNMET, exactly as the review reads it.
      met: m[2].toLowerCase() === 'met',
    })
  }
  return out
}

/**
 * Whether the transcript holds a verdict block at all.
 *
 * The torn-header case (#1335: the scribe split `## VERDICT` across rows) and
 * every parser gap look like this — the block is simply not there. That is
 * `unreadable`, a finding of its own, and never a criteria count.
 */
function verdictBlockReadable(said) {
  if (typeof said !== 'string' || said.length === 0) return false
  return said.lastIndexOf('## VERDICT') >= 0
}

/** Milliseconds between two Dates, floored for display only. */
function differenceMs(from, to) {
  return Math.max(0, to.getTime() - from.getTime())
}

/** "5h 12m" / "48m" / "2d 3h" / "unknown". */
function formatAge(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'unknown'
  const minutes = Math.floor(ms / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function parseDate(value, what) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${what} is not a valid date`)
    }
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  throw new Error(`${what} is not a valid date: ${JSON.stringify(value)}`)
}

/**
 * Classify one dispatch row in `wait`.
 *
 * The review's own arithmetic decides the answer: it waits when
 * `verdicts.length < promised.length` (its `totalCriteria` is
 * `max(promised, verdicts)`, so a bee that wrote more than it was given is
 * judged on what it wrote and does not wait). A row whose transcript judged
 * every declared criterion is `resolving`: the next sweep will decide it for
 * real, so the report does not list it. A row with no verdict block is
 * `unreadable` before anything else, because unreadability is not
 * time-dependent — the transcript of a finished bee never changes, so a block
 * missing now is missing for ever, whatever the clock says.
 *
 * Outcomes, in precedence order:
 *   notWait     the row is not in `wait`; not this report's subject
 *   unreadable  no `## VERDICT` block in the transcript (judged is null, and
 *               null is not 0)
 *   resolving   every declared criterion judged; not listed, it resolves on
 *               the next sweep
 *   fresh       finished inside FRESH_WINDOW_MS of `asOf`
 *   frozen      everything else: judged < declared, past the window, and the
 *               transcript can no longer change
 *
 * `judged` is null for unreadable rows and a number for every other outcome.
 * A missing `finished_at` is classified frozen with age "unknown" rather than
 * trusted as fresh: unknown is not zero, and a row that cannot prove it is
 * fresh must not be counted as harmless.
 *
 * `options.unreadableAsZero` exists only so the self-test can demonstrate the
 * defect this report forbids: with it set, an unreadable transcript is
 * reported as zero criteria judged — collapsing zero-because-unparsed and
 * zero-because-unjudged into one number — and the self-test's guard fails.
 * Production never sets it. The environment variable
 * FROZEN_WAIT_DEFECT=unreadable-as-zero turns the same defect on for a whole
 * run, which is how the failing run is produced for the record.
 */
export function classifyWaitRow(row, asOf = new Date(), options = {}) {
  if (row === null || typeof row !== 'object') {
    throw new Error('classifyWaitRow: row must be an object')
  }
  const when = parseDate(asOf, 'classifyWaitRow: asOf')
  const freshWindowMs =
    options.freshWindowMs === undefined ? FRESH_WINDOW_MS : options.freshWindowMs
  const unreadableAsZero =
    options.unreadableAsZero === undefined
      ? process.env.FROZEN_WAIT_DEFECT === 'unreadable-as-zero'
      : options.unreadableAsZero

  const state = String(row.review_state ?? '')
  const criteria = Array.isArray(row.criteria) ? row.criteria : []
  const paths = Array.isArray(row.owned_paths)
    ? row.owned_paths.map((p) => String(p)).filter((p) => p !== '')
    : []

  const base = {
    issue: row.issue === undefined ? 'unknown' : row.issue,
    state,
    declared: criteria.length,
    criteriaSource: String(row.criteria_source ?? 'none'),
    paths,
  }

  if (state !== 'wait') {
    return {
      ...base,
      outcome: 'notWait',
      judged: null,
      finishedAt: null,
      ageMs: null,
      ageText: 'n/a',
      reason: `review_state is "${state || 'none'}", not "wait"`,
    }
  }

  const said = typeof row.said === 'string' ? row.said : null
  const readable = verdictBlockReadable(said)
  const verdicts = readable ? parseVerdictBlock(said) : []

  let finishedAt = null
  let ageMs = null
  if (typeof row.finished_at === 'string' && row.finished_at.trim() !== '') {
    const parsed = new Date(row.finished_at)
    if (!Number.isNaN(parsed.getTime())) {
      finishedAt = parsed
      ageMs = differenceMs(parsed, when)
    }
  }

  if (!readable) {
    if (unreadableAsZero) {
      // The defect, simulated: the missing verdict block is read as a verdict
      // block with nothing in it, and "could not read it" becomes "read zero".
      const outcome =
        ageMs !== null && ageMs <= freshWindowMs ? 'fresh' : 'frozen'
      return {
        ...base,
        outcome,
        judged: 0,
        finishedAt,
        ageMs,
        ageText: formatAge(ageMs),
        reason:
          'transcript unreadable, reported as zero criteria judged ' +
          '(this is the defect: unreadable is not zero)',
      }
    }
    return {
      ...base,
      outcome: 'unreadable',
      judged: null,
      finishedAt,
      ageMs,
      ageText: formatAge(ageMs),
      reason:
        'the transcript holds no ## VERDICT block, so no criteria count can ' +
        'be read from it — unreadable, not zero',
    }
  }

  const judged = verdicts.length
  if (judged >= base.declared) {
    return {
      ...base,
      outcome: 'resolving',
      judged,
      finishedAt,
      ageMs,
      ageText: formatAge(ageMs),
      reason: `judged ${judged} of ${base.declared} declared criteria; the next sweep decides it for real`,
    }
  }
  const fresh = ageMs !== null && ageMs <= freshWindowMs
  return {
    ...base,
    outcome: fresh ? 'fresh' : 'frozen',
    judged,
    finishedAt,
    ageMs,
    ageText: formatAge(ageMs),
    reason: fresh
      ? `judged ${judged} of ${base.declared} declared criteria, finished inside the fresh window — not swept yet, not stuck yet`
      : `judged ${judged} of ${base.declared} declared criteria and the transcript is finished: the wait can never change`,
  }
}

/**
 * Read rows from a JSON file the caller supplied (FR-002).
 *
 * Unreadable file and unparseable JSON are errors, never an empty report.
 */
export function readRowsFile(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(
      `cannot read rows file ${file}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `rows file ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (Array.isArray(parsed)) return { asOf: null, rows: parsed }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rows)) {
    return { asOf: parsed.asOf ?? null, rows: parsed.rows }
  }
  throw new Error(
    `rows file ${file} must be an array of dispatch rows or { "asOf": "...", "rows": [...] }`,
  )
}

function distinctPaths(classifications) {
  const set = new Set()
  for (const row of classifications) {
    for (const path of row.paths) set.add(path)
  }
  return set
}

function listPaths(classification) {
  if (classification.paths.length === 0) return []
  const shown = classification.paths.slice(0, MAX_PATHS_LISTED)
  const lines = shown.map((path) => `         - ${path}`)
  if (classification.paths.length > MAX_PATHS_LISTED) {
    lines.push(
      `         - … +${classification.paths.length - MAX_PATHS_LISTED} more (totals count every path)`,
    )
  }
  return lines
}

/**
 * The report. Pure: rows and a clock in, text and a summary out.
 */
export function buildReport(rows, asOf = new Date(), options = {}) {
  const when = parseDate(asOf, 'buildReport: asOf')
  const all = rows.map((row) => classifyWaitRow(row, when, options))
  const inWait = all.filter((row) => row.outcome !== 'notWait')
  const notWait = all.length - inWait.length
  const frozen = inWait.filter((row) => row.outcome === 'frozen')
  const fresh = inWait.filter((row) => row.outcome === 'fresh')
  const unreadable = inWait.filter((row) => row.outcome === 'unreadable')
  const resolving = inWait.filter((row) => row.outcome === 'resolving')

  const lines = []
  lines.push(
    'frozen-wait-report — read-only: writes no dispatch row, no issue, nothing',
  )
  lines.push(
    `reference time: ${when.toISOString()}  rows supplied: ${all.length}  in wait: ${inWait.length}` +
      (notWait > 0 ? `  (not in wait, ignored: ${notWait})` : ''),
  )
  lines.push(
    `threshold: FRESH_WINDOW_MS = ${FRESH_WINDOW_MS} ms (${formatAge(FRESH_WINDOW_MS)}) — ` +
      `a dispatch finished within it of the reference time is fresh, not frozen`,
  )
  lines.push('')

  lines.push(
    `FROZEN — ${frozen.length}: the transcript is finished, so the wait can never change`,
  )
  if (frozen.length === 0) lines.push('  (none)')
  for (const row of frozen) {
    lines.push(
      `  #${row.issue}  waited ${row.ageText} since finish  judged ${row.judged} of ${row.declared} criteria (source: ${row.criteriaSource})  holds ${row.paths.length} path(s)`,
    )
    lines.push(...listPaths(row))
  }
  lines.push('')

  lines.push(
    `FRESH — ${fresh.length}: finished inside the threshold; a verdict not yet swept is not a stuck verdict`,
  )
  if (fresh.length === 0) lines.push('  (none)')
  for (const row of fresh) {
    lines.push(
      `  #${row.issue}  waited ${row.ageText} since finish  judged ${row.judged} of ${row.declared} criteria (source: ${row.criteriaSource})  holds ${row.paths.length} path(s)`,
    )
    lines.push(...listPaths(row))
  }
  lines.push('')

  lines.push(
    `UNREADABLE — ${unreadable.length}: no verdict block could be found; this is not "zero criteria judged"`,
  )
  if (unreadable.length === 0) lines.push('  (none)')
  for (const row of unreadable) {
    lines.push(
      `  #${row.issue}  waited ${row.ageText} since finish  transcript unreadable (no ## VERDICT block)  declared ${row.declared} criteria (source: ${row.criteriaSource})  holds ${row.paths.length} path(s)`,
    )
    lines.push(...listPaths(row))
  }
  lines.push('')

  const frozenPaths = distinctPaths(frozen)
  const stuckPaths = distinctPaths([...frozen, ...unreadable])
  lines.push(
    `totals: frozen ${frozen.length}, fresh ${fresh.length}, unreadable ${unreadable.length}`,
  )
  lines.push(
    `distinct paths held by frozen rows: ${frozenPaths.size}` +
      (frozenPaths.size > 0
        ? ' — each one is a candidate the round skips as claimed'
        : ''),
  )
  lines.push(
    `distinct paths held by frozen + unreadable rows: ${stuckPaths.size}`,
  )
  if (resolving.length > 0) {
    lines.push(
      `not listed: ${resolving.length} wait row(s) judged every declared criterion — they resolve on the next sweep`,
    )
  }
  return {
    text: lines.join('\n'),
    summary: {
      rowsSupplied: all.length,
      inWait: inWait.length,
      notWait,
      frozen: frozen.length,
      fresh: fresh.length,
      unreadable: unreadable.length,
      resolving: resolving.length,
      distinctFrozenPaths: frozenPaths.size,
      distinctStuckPaths: stuckPaths.size,
    },
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`selftest failed: ${message}`)
  }
}

/**
 * Build a fixture, run the report over the real file-reading path, and assert
 * the four outcomes: one fresh, one frozen, one fully-judged (not listed), one
 * unreadable.
 *
 * The load-bearing assertion is that the unreadable row reports
 * `judged === null`, never 0: an unreadable transcript is a finding about the
 * transcript, not a criteria count. Setting FROZEN_WAIT_DEFECT=unreadable-as-zero
 * removes that distinction for the whole run, this guard trips, and the
 * process exits non-zero — the failing run is as much a deliverable as the
 * passing one.
 */
function selftest() {
  const asOf = new Date('2026-09-05T12:00:00.000Z')
  const rows = [
    {
      // Fresh: finished 20 minutes ago, two of four criteria judged. Not
      // swept yet; nothing here says stuck.
      issue: 2001,
      conversation_id: '00000000-0000-4000-8000-000000000001',
      review_state: 'wait',
      criteria_source: 'issue',
      send_backs: 0,
      criteria: [
        'the round reads its candidates oldest first',
        'a candidate is skipped when a path is held',
        'the skip is written with its reason',
        'the report names the holder',
      ],
      owned_paths: ['docs/rounds.md'],
      finished_at: '2026-09-05T11:40:00.000Z',
      said: [
        'Worked the round ordering.',
        '',
        '## VERDICT',
        '- the round reads its candidates oldest first: met',
        '- a candidate is skipped when a path is held: met',
      ].join('\n'),
    },
    {
      // Frozen: finished three hours ago, three of five criteria judged. The
      // fourth bullet is wrapped, so this also pins the joining rule.
      issue: 2002,
      conversation_id: '00000000-0000-4000-8000-000000000002',
      review_state: 'wait',
      criteria_source: 'issue',
      send_backs: 0,
      criteria: [
        'a wait row is re-read each round',
        'a re-read yields the same verdict',
        'the transcript is immutable once finished',
        'the hold is released after 48 hours',
        'the release is visible on the board',
      ],
      owned_paths: [
        'agent-server/apps/server/src/api/services/queen-tick.ts',
        'agent-server/apps/server/src/api/routes/queen-public-status.ts',
      ],
      finished_at: '2026-09-05T09:00:00.000Z',
      said: [
        'Chased the re-read.',
        '',
        '## VERDICT',
        '- a wait row is re-read each round: met',
        '- a re-read yields the same verdict: met',
        '- the transcript is immutable once finished: could-not-check',
        '- the hold is released after 48 hours: met',
      ].join('\n'),
    },
    {
      // Fully judged: four of four. Not listed — the next sweep decides it.
      issue: 2003,
      conversation_id: '00000000-0000-4000-8000-000000000003',
      review_state: 'wait',
      criteria_source: 'issue',
      send_backs: 0,
      criteria: [
        'the sweep updates reviewed_at with every verdict',
        'accept releases the boundary paths',
        'sendBack increments send_backs in the same statement',
        'escalate is the only arm that reaches a person',
      ],
      owned_paths: ['agent-server/apps/server/src/lib/db/pg-migrate.ts'],
      finished_at: '2026-09-05T08:00:00.000Z',
      said: [
        'Closed the loop.',
        '',
        '## VERDICT',
        '- the sweep updates reviewed_at with every verdict: met',
        '- accept releases the boundary paths: met',
        '- sendBack increments send_backs in the same statement: met',
        '- escalate is the only arm that reaches a person: met',
      ].join('\n'),
    },
    {
      // Unreadable: prose, no ## VERDICT block at all. The torn-header shape.
      issue: 2004,
      conversation_id: '00000000-0000-4000-8000-000000000004',
      review_state: 'wait',
      criteria_source: 'issue',
      send_backs: 0,
      criteria: [
        'the scribe joins say rows with the empty string',
        'a torn header is detected rather than misread',
        'the detection is tested',
        'the misread is not counted as zero judged',
        'the report separates the two findings',
      ],
      owned_paths: ['agent-server/queen-core/Sources/QueenCore/QueenReviewDecision.swift'],
      finished_at: '2026-09-05T10:00:00.000Z',
      said: [
        'The scribe flushes on a size-or-time bound, so a row boundary can',
        'fall inside a word. The closing block came back as VERD on one row',
        'and ICT on the next, and the join restored it — but this transcript',
        'is the case where it did not.',
      ].join('\n'),
    },
  ]

  // The fixture goes through the same file path production uses (FR-002),
  // in a throwaway temp file the self-test writes and then removes.
  const dir = mkdtempSync(join(tmpdir(), 'frozen-wait-report-selftest-'))
  let report
  try {
    const file = join(dir, 'rows.json')
    writeFileSync(file, JSON.stringify({ asOf: asOf.toISOString(), rows }))
    const loaded = readRowsFile(file)
    assert(loaded.rows.length === 4, `expected 4 rows loaded, got ${loaded.rows.length}`)
    assert(
      loaded.asOf === asOf.toISOString(),
      'the envelope asOf must survive the file round-trip',
    )

    const byIssue = {}
    for (const row of loaded.rows) {
      byIssue[String(row.issue)] = classifyWaitRow(row, asOf)
    }

    assert(byIssue['2001'].outcome === 'fresh', `#2001 must be fresh, got ${byIssue['2001'].outcome}`)
    assert(byIssue['2002'].outcome === 'frozen', `#2002 must be frozen, got ${byIssue['2002'].outcome}`)
    assert(byIssue['2002'].judged === 4, `#2002 must show 4 criteria judged, got ${byIssue['2002'].judged}`)
    assert(byIssue['2002'].declared === 5, `#2002 must show 5 criteria declared, got ${byIssue['2002'].declared}`)
    assert(byIssue['2003'].outcome === 'resolving', `#2003 must be resolving, got ${byIssue['2003'].outcome}`)

    // THE GUARD THIS FILE EXISTS TO KEEP, asserted before anything else about
    // the row so its failure names the conflation it forbids: an unreadable
    // transcript is never a criteria count. judged is null, and the report
    // never prints a "0 of N criteria" line for it.
    assert(
      byIssue['2004'].judged === null,
      `#2004 (unreadable transcript) must NOT be counted as zero criteria judged — judged must be null, got ${JSON.stringify(byIssue['2004'].judged)}`,
    )
    assert(byIssue['2004'].outcome === 'unreadable', `#2004 must be unreadable, got ${byIssue['2004'].outcome}`)

    report = buildReport(loaded.rows, asOf)

    assert(report.summary.frozen === 1, `totals must count 1 frozen, got ${report.summary.frozen}`)
    assert(report.summary.fresh === 1, `totals must count 1 fresh, got ${report.summary.fresh}`)
    assert(report.summary.unreadable === 1, `totals must count 1 unreadable, got ${report.summary.unreadable}`)
    assert(report.summary.resolving === 1, `totals must count 1 resolving, got ${report.summary.resolving}`)
    assert(
      report.summary.distinctFrozenPaths === 2,
      `the frozen row holds 2 distinct paths, got ${report.summary.distinctFrozenPaths}`,
    )
    assert(
      report.text.includes(`FRESH_WINDOW_MS = ${FRESH_WINDOW_MS}`),
      'the run must print the named threshold',
    )
    assert(report.text.includes('#2001'), 'the fresh row must be listed')
    assert(report.text.includes('#2002'), 'the frozen row must be listed')
    assert(report.text.includes('#2004'), 'the unreadable row must be listed')
    assert(
      !report.text.includes('#2003'),
      'the fully-judged row must NOT be listed',
    )
    assert(
      !/#2004[^\n]*0 of 5 criteria/.test(report.text),
      'the unreadable row must not be reported as "0 of 5 criteria judged"',
    )
    assert(
      report.text.includes('distinct paths held by frozen rows: 2'),
      'the totals must print the distinct frozen-path count',
    )

    // The defect, demonstrated in-process without failing the run: with the
    // distinction removed, the unreadable row reports judged 0 and turns into
    // an ordinary frozen row — exactly what the guard above forbids.
    const defective = classifyWaitRow(rows[3], asOf, { unreadableAsZero: true })
    assert(
      defective.judged === 0 && defective.outcome === 'frozen',
      `with the distinction removed the unreadable row must read judged 0 / frozen (got ${defective.judged} / ${defective.outcome}); the guard above must be load-bearing`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('selftest OK — four outcomes asserted over a temp fixture file:')
  console.log('  fresh      #2001  waited 20m            judged 2 of 4 criteria')
  console.log('  frozen     #2002  waited 3h 0m           judged 4 of 5 criteria')
  console.log('  resolving  #2003  judged every criterion — NOT listed')
  console.log('  unreadable #2004  no ## VERDICT block — judged is null, never 0')
  console.log(
    '  guard: unreadable is not zero-judged — holds; removing it ' +
      '(FROZEN_WAIT_DEFECT=unreadable-as-zero) fails this run',
  )
  return 0
}

function usage() {
  return [
    'usage: node trios/tools/frozen-wait-report.mjs <rows.json>',
    '       node trios/tools/frozen-wait-report.mjs --selftest',
    '',
    'rows.json: an array of queen_dispatch rows as reviewFinishedDispatches',
    'selects them, or { "asOf": "<ISO timestamp>", "rows": [...] }.',
  ].join('\n')
}

function main(argv) {
  if (argv[0] === '--selftest') return selftest()
  if (argv.length !== 1) {
    process.stderr.write(`${usage()}\n`)
    return 2
  }
  const { asOf, rows } = readRowsFile(argv[0])
  const when = asOf ? parseDate(asOf, `asOf in ${argv[0]}`) : new Date()
  const { text } = buildReport(rows, when)
  process.stdout.write(`${text}\n`)
  return 0
}

// Run only when executed, never when imported.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`frozen-wait-report: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
