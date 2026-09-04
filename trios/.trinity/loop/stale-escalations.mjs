#!/usr/bin/env node
// An escalation whose stated cause no longer reproduces.
//
// THE DEFECT THIS FOUND, and it had been standing for 3.8 days when this tool
// was written:
//
//   #1216, #1240 and #1244 were escalated to a person with the reason "the task
//   has no acceptance criteria, so there is nothing to judge it against". All
//   three were dispatched on 2026-08-31 and all three recorded
//   `criteria_source = none, items = 0`.
//
//   All three issues visibly contain four acceptance criteria. #1216 has an
//   English `## Success Criteria` section whose last line is a `grep` that must
//   exit 0; #1240 and #1244 have `## Готово, когда` with four bullets each.
//
//   The cause was `QueenSpecQuality.criteriaHeadings`, which knew four headings
//   and none of the ones those issues use. It was fixed the SAME DAY in
//   edbc05e11, 2026-08-31 21:15, whose title is "fix: the bees were judged
//   against criteria nobody ever gave them" and whose own comment says a
//   perfectly written spec yielded ZERO criteria. Run today's parser on today's
//   bodies and every one of the three answers `stated`, 4 items.
//
//   Every dispatch since 2026-09-01 records `stated`. The three `none` rows are
//   the only ones in the table, and they are exactly the three escalations.
//
//   So: a defect escalated three tasks to a person, the defect was fixed four
//   hours later, and NOTHING ever re-examined the escalations it raised. They
//   are frozen on a question that was never real.
//
// WHY THIS IS NOT A TIMER. `sendBack` and `wait` are released by a clock
// precisely because their input can never change. An escalation is different:
// it names a CAUSE, and a cause is a claim about the world that can be measured
// again. This tool re-measures. A cause that still holds keeps its escalation
// for ever, however old - three of the six escalations here are of that kind
// and this tool leaves every one of them alone.
//
// WHY IT CALLS SWIFT. The question "does this issue state criteria?" has one
// answer, and it lives in `QueenSpecQuality.criteriaWithSource`. A second copy
// in JavaScript would agree until the day someone edited one of them, which is
// this repository's most frequently repeated defect. The real parser is
// compiled and run.
//
// Usage:
//   node stale-escalations.mjs              # report
//   node stale-escalations.mjs --release    # clear the ones whose cause is void

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REPO = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'
const SVC = process.env.QUEEN_SERVICE || 'trios-agent-server'
const CORE = path.join(ROOT, 'trios/agent-server/queen-core/Sources/QueenCore')
const BIN = path.join(DIR, 'state', 'criteria-probe')
const isMain = process.argv[1] && process.argv[1].endsWith('/stale-escalations.mjs')

export const shq = (s) => `'` + String(s).replace(/'/g, `'\\''`) + `'`

const sh = (c, opts = {}) =>
  execSync(c, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim()
const tryShell = (c, opts) => { try { return sh(c, opts) } catch { return null } }

/** Strip railway's own chatter, which is not output of the command we ran. */
const clean = (s) =>
  s.split('\n').filter((l) => !/Using SSH|railway\.json|Migrate|Existing/.test(l)).join('\n').trim()

/**
 * Run a node snippet inside the deployed service.
 *
 * `shq` twice, deliberately. `execSync` hands the string to the LOCAL /bin/sh,
 * and a `$` or a backtick inside double quotes expands HERE rather than there -
 * which is how `any($1)` once reached Postgres as `any()` and a branch survey
 * reported 0 of 118.
 */
export function remote(js) {
  const script = `cd /app && node -e ${shq(js)}`
  const out = tryShell(`railway ssh --service ${SVC} -- sh -c ${shq(script)}`, {
    cwd: path.join(ROOT, 'trios'),
  })
  return out === null ? null : clean(out)
}

/**
 * The real `criteriaWithSource`, compiled on demand.
 *
 * Rebuilt whenever a source file is newer than the binary, so a parser change
 * cannot be masked by a stale executable - the exact shape of the defect this
 * tool exists to catch.
 */
export function buildProbe() {
  const sources = [
    path.join(CORE, 'QueenSpecQuality.swift'),
    path.join(CORE, 'QueenIssueBoundary.swift'),
  ]
  for (const s of sources) if (!fs.existsSync(s)) return { ok: false, why: `missing ${path.basename(s)}` }

  const newest = Math.max(...sources.map((s) => fs.statSync(s).mtimeMs))
  if (fs.existsSync(BIN) && fs.statSync(BIN).mtimeMs > newest) return { ok: true, cached: true }

  // The file MUST be called `main.swift`. Swift only allows top-level statements
  // in a file with that exact name, and under any other name the compiler
  // rejects `while let line = readLine()` as an expression at file scope. The
  // first build here was named after the process and failed for that alone,
  // which the survey reported as `??` rather than clean - the one behaviour that
  // made the mistake visible instead of silently retiring six escalations.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'criteria-probe-'))
  const main = path.join(tmp, 'main.swift')
  fs.writeFileSync(main, `import Foundation
// Reads one issue body on stdin and prints "<source>\\t<count>". Nothing else:
// the point is to ask the shipping parser, not to re-implement it.
var body = ""
while let line = readLine(strippingNewline: false) { body += line }
let c = QueenSpecQuality.criteriaWithSource(from: body)
print("\\(c.source)\\t\\(c.items.count)")
`)
  fs.mkdirSync(path.dirname(BIN), { recursive: true })
  const built = tryShell(
    `DEVELOPER_DIR=/Library/Developer/CommandLineTools swiftc -O ${sources.map(shq).join(' ')} ${shq(main)} -o ${shq(BIN)}`,
  )
  fs.rmSync(tmp, { recursive: true, force: true })
  if (built === null || !fs.existsSync(BIN)) return { ok: false, why: 'swiftc could not build the parser probe' }
  return { ok: true, cached: false }
}

/** What the shipping parser says about a body TODAY. */
export function criteriaToday(body) {
  const out = tryShell(`${shq(BIN)}`, { input: body, stdio: ['pipe', 'pipe', 'ignore'] })
  if (out === null) return null
  const [source, count] = out.split('\t')
  return { source, count: Number(count) }
}

/**
 * The causes this tool knows how to re-measure.
 *
 * A cause NOT on this list is never called stale. An escalation says a person is
 * needed, and a tool that cannot check the reason must not overrule it - the
 * silent default here is "leave it alone", which is why `kind: null` returns.
 */
/**
 * Headings by which an issue asks for a person IN ITS OWN WORDS.
 *
 * THE NEAR MISS. The first working run of this tool called #1244 stale and
 * would have returned it to the pool. Its recorded reason was the criteria bug,
 * and that reason is indeed void. But the issue body carries a section headed
 * `## Почему жду слова` - "why I am waiting for your word" - explaining that the
 * change rewrites the main window's tabs and that the bee will not do that
 * silently while the operator sleeps.
 *
 * The escalation was therefore right for a reason the review never recorded.
 * Retiring it because the RECORDED reason went stale would have overruled a
 * deliberate request with a database column, which is precisely the failure this
 * whole tool exists to stop - acting on a stated cause without reading the thing
 * the cause is about.
 *
 * So: a body that asks for a person is never auto-released, whatever the
 * recorded reason says. The two gates must BOTH open.
 */
const ASKS_FOR_A_PERSON = [
  'почему жду слова',
  'жду слова',
  'ждёт слова',
  'ждет слова',
  'waiting on your word',
  'waiting for your word',
  'needs your decision',
  'needs a decision from you',
  'requires operator approval',
]

/** Whether the issue itself, not the review, asks for a person. */
export function bodyAsksForAPerson(body) {
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('#')) continue
    const title = line.replace(/^#+/, '').trim().toLowerCase()
    if (ASKS_FOR_A_PERSON.some((h) => title.includes(h))) return title
  }
  return null
}

export function causeOf(note) {
  const n = String(note ?? '')
  if (/no acceptance criteria/i.test(n)) return { kind: 'no-criteria', remeasurable: true }
  if (/returned \d+ time\(s\) already/i.test(n)) return { kind: 'retry-ceiling', remeasurable: false }
  return { kind: null, remeasurable: false }
}

export function survey() {
  const build = buildProbe()
  const js = `
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL});
p.query("select issue, review_note, criteria_source, jsonb_array_length(criteria) as n, extract(epoch from (now()-finished_at))/3600 as age from queen_dispatch where review_state = 'escalate' order by finished_at asc")
 .then(r=>{console.log(JSON.stringify(r.rows)); return p.end()})
 .catch(e=>{console.log(JSON.stringify({error:e.message})); process.exit(1)})
`
  const raw = remote(js)
  if (raw === null) return { rows: [], error: 'could not reach the service' }
  let rows
  try { rows = JSON.parse(raw.split('\n').pop()) } catch { return { rows: [], error: 'unparseable answer from the service' } }
  if (!Array.isArray(rows)) return { rows: [], error: rows?.error || 'unexpected answer shape' }

  const out = []
  for (const r of rows) {
    const cause = causeOf(r.review_note)
    const rec = {
      issue: Number(r.issue),
      ageHours: Math.round(Number(r.age ?? 0) * 10) / 10,
      atDispatch: `${r.criteria_source}/${r.n}`,
      cause: cause.kind ?? 'unrecognised',
      state: 'stands',
      why: '',
    }
    if (!cause.remeasurable) {
      rec.why = cause.kind
        ? 'the cause is a fact about the conversation, not about the issue text - no timer retires it'
        : 'the reason is not one this tool knows how to re-measure, so it is left alone'
      out.push(rec)
      continue
    }
    if (!build.ok) {
      rec.state = 'unchecked'
      rec.why = build.why
      out.push(rec)
      continue
    }
    const body = tryShell(`gh issue view ${rec.issue} --repo ${REPO} --json body -q .body`)
    if (body === null) {
      rec.state = 'unchecked'
      rec.why = 'the issue body could not be read, and unreadable is not stale'
      out.push(rec)
      continue
    }
    const now = criteriaToday(body)
    if (!now) {
      rec.state = 'unchecked'
      rec.why = 'the parser probe produced no answer'
      out.push(rec)
      continue
    }
    rec.today = `${now.source}/${now.count}`
    const asks = bodyAsksForAPerson(body)
    if (asks) {
      rec.why = `the issue asks for a person in its own words ("${asks}") - the recorded reason is void, the request is not`
      out.push(rec)
      continue
    }
    if (now.source !== 'none' && now.count > 0) {
      rec.state = 'STALE'
      rec.why = `escalated for having no criteria; the shipping parser reads ${now.count} today`
    } else {
      rec.why = 'the issue still states no criteria, so the escalation is as true as it was'
    }
    out.push(rec)
  }
  return { rows: out, error: null, build }
}

/**
 * Clear the escalations whose cause is void, and say so in the record.
 *
 * `failed` rather than a delete: the row is evidence that a dispatch happened,
 * and the delegation policy treats `failed` as free - "a failure is the state
 * that most obviously means do this again". The note records what happened, so
 * the next reader is not left guessing why an escalation vanished.
 */
export function release(issues, note) {
  if (!issues.length) return { released: 0 }
  const list = issues.map((n) => Number(n)).filter(Number.isFinite).join(',')
  const js = `
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL});
p.query("update queen_dispatch set review_state='failed', review_note=$1, reviewed_at=now() where issue in (${list}) and review_state='escalate'", [${JSON.stringify(note)}])
 .then(r=>{console.log('released='+r.rowCount); return p.end()})
 .catch(e=>{console.log('ERR '+e.message); process.exit(1)})
`
  const out = remote(js)
  const m = out && out.match(/released=(\d+)/)
  return { released: m ? Number(m[1]) : 0, raw: out }
}

if (isMain) {
  const doRelease = process.argv.includes('--release')
  const { rows, error, build } = survey()
  if (error) {
    console.log(`could not survey the escalations: ${error}`)
    process.exit(1)
  }

  console.log('escalations whose stated cause may no longer hold\n')
  if (build && !build.ok) console.log(`  (the parser probe did not build: ${build.why})\n`)
  for (const r of rows) {
    const mark = { STALE: 'STALE ', stands: 'ok    ', unchecked: '??    ' }[r.state]
    console.log(
      `  ${mark}#${String(r.issue).padEnd(6)} ${String(r.ageHours).padStart(6)} h  ` +
        `at dispatch ${String(r.atDispatch).padEnd(12)}` +
        (r.today ? `today ${String(r.today).padEnd(10)}` : ' '.repeat(16)) +
        r.why,
    )
  }

  const stale = rows.filter((r) => r.state === 'STALE')
  console.log(`\n${rows.length} escalation(s): ${stale.length} raised on a cause that no longer holds`)

  if (!stale.length) {
    console.log('\nNothing to retire. An escalation whose cause still holds waits for a person,')
    console.log('however old it is - age is not evidence that a question was never real.')
    process.exit(0)
  }

  if (!doRelease) {
    console.log('\nRe-run with --release to return these to the pool. They are frozen on a')
    console.log('question that the parser fix of 2026-08-31 already answered.')
    process.exit(0)
  }

  const note =
    'released by the stale-escalation sweep: escalated for stating no acceptance ' +
    'criteria, but the parser that produced that reading was fixed the same day ' +
    '(edbc05e11) and the shipping parser reads the criteria today'
  const { released } = release(stale.map((r) => r.issue), note)
  console.log(`\nreleased ${released} of ${stale.length} back to the pool`)
  process.exit(released === stale.length ? 0 : 1)
}
