#!/usr/bin/env node
// A retry ceiling spent on silence rather than on the work.
//
// THE MEASUREMENT, 2026-09-04. One bee was running of four. The tick's own skip
// summary said `claimed: 11`, and nine of those eleven were dispatches parked at
// or over `QueenRetryPolicy.maximumRealAttempts = 2` - three escalated, six sent
// back - the oldest idle for 52 hours. Meanwhile `author.mjs` found fourteen
// real deficits and could file none of them, because every one already had an
// issue: one of the parked ones. Work existed; it was locked.
//
// Then read the review notes together:
//
//   #1133  4 criterion(s) still unmet   "omitted 4 verdict lines"
//   #1175  4 criterion(s) still unmet   "omitted 4 verdict lines"
//   #1316  3 criterion(s) still unmet   "omitted 3 verdict lines"
//   #1318  4 criterion(s) still unmet   "omitted 4 verdict lines"
//
// The unmet count IS the omitted count. Those criteria were not judged and
// found wanting - they were never judged at all. The reviewer marks a criterion
// unmet when the bee's `## VERDICT` block has no line for it, which is the right
// default (silence must never read as success) and is a different fact from a
// criterion that was tested and failed.
//
// So the ceiling was reached without the work ever being assessed. Two attempts
// and an escalation, on the shape of a report.
//
// WHAT THIS TOOL CLAIMS, AND WHAT IT DOES NOT. `maximumRealAttempts` counts REAL
// attempts. An attempt that returned no verdict on a criterion did not attempt
// that criterion. This releases only those, and only when the note says so in
// the reviewer's own words. A dispatch whose criteria were judged and failed -
// #1328, #1329, #1350 carry no omission at all - keeps its ceiling, because
// there the count means exactly what it says and a person should decide.
//
// It also refuses to release anything whose issue body asks for a person, on
// the same grounds as `stale-escalations.mjs`, and for the same reason: a
// deliberate request must not be overruled by a database column.
//
// Usage:
//   node unpark.mjs                # report
//   node unpark.mjs --release      # return the never-judged ones to the pool

import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REPO = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'
const SVC = process.env.QUEEN_SERVICE || 'trios-agent-server'
const CEILING = Number(process.env.RETRY_CEILING ?? 2)
const isMain = process.argv[1] && process.argv[1].endsWith('/unpark.mjs')

const SE = await import(path.join(DIR, 'stale-escalations.mjs'))
const { shq, remote } = SE

const tryShell = (c) => {
  try {
    return execSync(c, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}

/**
 * How many verdict lines the bee failed to write, in the reviewer's own words.
 *
 * Read from the note rather than recomputed, because the reviewer is the only
 * thing that knows what it judged. Recomputing it here would be a second copy
 * of a rule, and a second copy is the defect this repository repeats most.
 */
export function omittedVerdictLines(note) {
  const m = String(note ?? '').match(/omitted (\d+) verdict line/i)
  return m ? Number(m[1]) : 0
}

/** How many criteria the review called unmet. */
export function unmetCount(note) {
  const m = String(note ?? '').match(/(\d+) criterion\(s\)[^\n]*?(?:not met|still unmet)/i)
  return m ? Number(m[1]) : 0
}

/**
 * Whether the ceiling was spent on silence.
 *
 * The test is deliberately strict: EVERY criterion the review called unmet must
 * be accounted for by an omitted verdict line. One criterion that was actually
 * judged and failed is enough to keep the ceiling, because then the count means
 * what it says.
 */
export function classify(note) {
  const omitted = omittedVerdictLines(note)
  const unmet = unmetCount(note)
  if (omitted === 0) {
    return { kind: 'judged', why: 'the review names no omitted verdict lines, so its count is of criteria that were tested' }
  }
  if (unmet === 0) {
    return { kind: 'unclear', why: 'the note mentions omissions but states no unmet count - unreadable is not releasable' }
  }
  if (omitted >= unmet) {
    return { kind: 'never-judged', unmet, omitted, why: `all ${unmet} unmet criteria are accounted for by ${omitted} missing verdict line(s)` }
  }
  return { kind: 'judged', unmet, omitted, why: `${unmet} unmet against ${omitted} omitted - at least ${unmet - omitted} criterion was tested and failed` }
}

export function survey() {
  const js = `
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL});
p.query("select issue, review_state, send_backs, review_note, extract(epoch from (now()-finished_at))/3600 as idle from queen_dispatch where review_state in ('sendBack','escalate') and send_backs >= ${CEILING} order by idle desc nulls last")
 .then(r=>{console.log(JSON.stringify(r.rows)); return p.end()})
 .catch(e=>{console.log(JSON.stringify({error:e.message})); process.exit(1)})
`
  const raw = remote(js)
  if (raw === null) return { rows: [], error: 'could not reach the service' }
  // Name what could not be parsed. "unparseable answer" sent me hunting the
  // query for ten minutes when the query was fine; a diagnostic that withholds
  // the evidence is the same failure this whole loop keeps finding.
  let rows
  const line = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[') || l.startsWith('{')).pop()
  if (!line) return { rows: [], error: `no JSON line in the answer; it began: ${raw.slice(0, 160)}` }
  try { rows = JSON.parse(line) } catch (e) { return { rows: [], error: `${e.message}; the line began: ${line.slice(0, 160)}` } }
  if (!Array.isArray(rows)) return { rows: [], error: rows?.error || 'unexpected shape' }

  return {
    error: null,
    rows: rows.map((r) => {
      const c = classify(r.review_note)
      const rec = {
        issue: Number(r.issue),
        state: r.review_state,
        sendBacks: Number(r.send_backs ?? 0),
        idleHours: Math.round(Number(r.idle ?? 0) * 10) / 10,
        kind: c.kind,
        why: c.why,
        release: false,
      }
      if (c.kind !== 'never-judged') return rec
      const body = tryShell(`gh issue view ${rec.issue} --repo ${REPO} --json body -q .body`)
      if (body === null) {
        rec.kind = 'unclear'
        rec.why = 'the issue body could not be read, and unreadable is not releasable'
        return rec
      }
      const asks = SE.bodyAsksForAPerson(body)
      if (asks) {
        rec.kind = 'asks-for-a-person'
        rec.why = `the issue asks for a person in its own words ("${asks}")`
        return rec
      }
      rec.release = true
      return rec
    }),
  }
}

/**
 * Return the never-judged ones to the pool, and reset the count that was spent
 * on silence.
 *
 * `send_backs = 0` is the part that needs defending. Leaving it at the ceiling
 * would make the very next review escalate again on the first stumble, so the
 * release would buy one round and nothing more. The reset is honest only
 * because the attempts being cleared produced no verdict on any criterion -
 * `maximumRealAttempts` counts real attempts, and these were not attempts on
 * the work. The note records the reset and its reason, so nobody later has to
 * guess why a counter moved backwards.
 */
export function release(issues, note) {
  if (!issues.length) return { released: 0 }
  const list = issues.map(Number).filter(Number.isFinite).join(',')
  const js = `
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL});
p.query("update queen_dispatch set review_state='failed', send_backs=0, review_note=$1, reviewed_at=now() where issue in (${list}) and review_state in ('sendBack','escalate') and send_backs >= ${CEILING}", [${JSON.stringify(note)}])
 .then(r=>{console.log('released='+r.rowCount); return p.end()})
 .catch(e=>{console.log('ERR '+e.message); process.exit(1)})
`
  const out = remote(js)
  const m = out && out.match(/released=(\d+)/)
  return { released: m ? Number(m[1]) : 0, raw: out }
}

if (isMain) {
  const doRelease = process.argv.includes('--release')
  const { rows, error } = survey()
  if (error) {
    console.log(`could not survey the parked work: ${error}`)
    process.exit(1)
  }

  console.log(`dispatches at or over the retry ceiling of ${CEILING}\n`)
  for (const r of rows) {
    const mark = r.release ? 'FREE  ' : r.kind === 'judged' ? 'keep  ' : '??    '
    console.log(`  ${mark}#${String(r.issue).padEnd(6)} ${String(r.state).padEnd(9)} sb=${r.sendBacks} ${String(r.idleHours).padStart(6)} h  ${r.why}`)
  }

  const free = rows.filter((r) => r.release)
  console.log(`\n${rows.length} parked: ${free.length} reached the ceiling without a single criterion being judged`)

  if (!free.length) {
    console.log('\nNothing to release. A criterion that was tested and failed keeps its count,')
    console.log('and at the ceiling that is a decision for a person rather than for this tool.')
    process.exit(0)
  }
  if (!doRelease) {
    console.log('\nRe-run with --release. Each of these spent its whole retry budget on the')
    console.log('shape of a report, and the work itself was never assessed.')
    process.exit(0)
  }

  const note =
    'released by the unpark sweep: the retry ceiling was reached without any ' +
    'criterion being judged - every criterion the review called unmet was one ' +
    'the worker omitted from its VERDICT block, so no attempt on the work was ' +
    'ever assessed. send_backs reset to 0 for the same reason'
  const { released } = release(free.map((r) => r.issue), note)
  console.log(`\nreleased ${released} of ${free.length} back to the pool`)
  process.exit(released === free.length ? 0 : 1)
}
