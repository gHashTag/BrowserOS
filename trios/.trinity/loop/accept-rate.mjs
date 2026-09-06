#!/usr/bin/env node
// Does a brief that can be FAILED get accepted less often?
//
// THE MEASUREMENT NOBODY HAD MADE, and it inverts the obvious reading of every
// acceptance number this project has ever printed.
//
// Split every issue carrying a review verdict by whether its brief passes
// `brief-gate` - that is, whether it states anything a checker could fail the
// work against - and compare the acceptance rates. Measured 2026-09-06 over the
// 382 issues that have one, restricted to the recent era where nearly all the
// volume is:
//
//   brief PASSES the gate   38% accepted   (n = 271)
//   brief FAILS  the gate  100% accepted   (n =  40)
//
// FORTY OF FORTY. In the recent era a brief with no checkable criterion has
// never once been rejected. That is not forty pieces of excellent work: it is
// forty reviews with nothing to fail against, which is the self-report problem
// this project already quotes at the top of `judge-packet.mjs` - Terminal-Bench
// stopped accepting self-reported results after the top of two boards turned
// out to sit 13.5 and 2.5 points above independent re-runs.
//
// So a HIGH acceptance rate on ungated briefs is not quality. It is the absence
// of a test, and reading it as quality is the mistake this file exists to make
// impossible.
//
// THE ERA SPLIT IS NOT DECORATION. The failing briefs are visibly the older
// ones, and an era effect would explain the whole result without the gate
// meaning anything. Split by issue number, the effect is SHARPEST in the newest
// bucket, which is what says it is not an artefact of when the briefs were
// written. Every bucket prints its denominator, because a 100% over three
// issues is a sentence and not a finding.
//
// AN ISSUE WITH NO VERDICT IS EXCLUDED, NEVER COUNTED AS A REJECTION. The
// question is what happened to work that was judged, and an unjudged issue
// answers a different one.
//
// Usage:
//   node accept-rate.mjs            # the split, with denominators
//   node accept-rate.mjs --json     # the same, as data

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/accept-rate.mjs')

const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REPO = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'

/**
 * The eras, by issue number.
 *
 * Numbers rather than dates because the issue number is on the wire already and
 * a date would need a second field from a second source. The boundaries are the
 * two points where this backlog visibly changed hands - the template arriving,
 * and the swarm going continuous - and they are named so a reader can disagree
 * with them rather than having to reverse-engineer them.
 */
export const ERAS = [
  { label: 'up to #1200', holds: (n) => n <= 1200 },
  { label: '#1201-#1350', holds: (n) => n > 1200 && n <= 1350 },
  { label: 'after #1350', holds: (n) => n > 1350 },
]

/**
 * Accepted versus judged, split by whether the brief could be failed at all.
 *
 * `rate` is null rather than 0 when nothing was judged in a cell: a rate over
 * an empty denominator is not zero, it is absent, and printing 0% would invent
 * a finding out of no data.
 */
export function split(issues, verdictOf, briefPasses) {
  const cell = () => ({ accepted: 0, judged: 0 })
  const out = { pass: cell(), fail: cell(), byEra: ERAS.map((e) => ({ label: e.label, pass: cell(), fail: cell() })) }
  for (const issue of issues) {
    const verdict = verdictOf(issue)
    if (!verdict) continue
    const side = briefPasses(issue) ? 'pass' : 'fail'
    const accepted = verdict === 'accept'
    out[side].judged++
    if (accepted) out[side].accepted++
    const era = ERAS.findIndex((e) => e.holds(Number(issue.number)))
    if (era >= 0) {
      out.byEra[era][side].judged++
      if (accepted) out.byEra[era][side].accepted++
    }
  }
  const rate = (c) => (c.judged ? Math.round((100 * c.accepted) / c.judged) : null)
  out.passRate = rate(out.pass)
  out.failRate = rate(out.fail)
  for (const e of out.byEra) { e.passRate = rate(e.pass); e.failRate = rate(e.fail) }
  return out
}

export function render(s) {
  const cell = (r, c) => (r === null ? '   -      ' : `${String(r).padStart(3)}% (n=${String(c.judged).padStart(3)})`)
  const out = [
    'acceptance rate, split by whether the brief states anything a checker could fail',
    '',
    `  brief PASSES the gate   ${cell(s.passRate, s.pass)}`,
    `  brief FAILS  the gate   ${cell(s.failRate, s.fail)}`,
    '',
    'by era, because the failing briefs are the older ones and an era effect would',
    'explain the whole result without the gate meaning anything:',
  ]
  for (const e of s.byEra) {
    out.push(`  ${e.label.padEnd(12)} pass ${cell(e.passRate, e.pass)}   fail ${cell(e.failRate, e.fail)}`)
  }
  const newest = s.byEra[s.byEra.length - 1]
  if (newest.failRate === 100 && newest.fail.judged >= 20) {
    out.push('')
    out.push(`In the newest era a brief with no checkable criterion has been accepted`)
    out.push(`${newest.fail.accepted} times out of ${newest.fail.judged}. That is not ${newest.fail.judged} pieces of excellent work - it is`)
    out.push('that many reviews with nothing to fail against. A high acceptance rate on an')
    out.push('ungated brief measures the absence of a test, not the presence of quality.')
  }
  return out.join('\n')
}

if (isMain) {
  const G = await import(path.join(DIR, 'brief-gate.mjs'))
  const CH = await import(path.join(DIR, 'channel.mjs'))
  const L = await import(path.join(DIR, 'loop.mjs'))

  const cache = path.join('/tmp', 'trios-all-issues.json')
  let issues = null
  try {
    const raw = execSync(`gh issue list --repo ${REPO} --state all --limit 2000 --json number,body`,
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 128 * 1024 * 1024 })
    fs.writeFileSync(cache, raw)
    issues = JSON.parse(raw)
  } catch {
    try { issues = JSON.parse(fs.readFileSync(cache, 'utf8')) } catch { issues = null }
  }
  if (!issues || !issues.length) {
    console.log('the issue list could not be read - NOTHING was measured, which is not the same as no issues')
    process.exit(3)
  }

  const js = 'const {Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL}); ' +
    'p.query("select issue, review_state from queen_dispatch where review_state is not null")' +
    '.then(r => { console.log(JSON.stringify(r.rows)); process.exit(0); })' +
    '.catch(e => { console.log("ERR " + e.message); process.exit(1); });'
  let verdicts = null
  try {
    const out = String(CH.remote(`cd /app/apps/server && bun -e ${L.shq(js)}`, { attempts: 2 }))
    const at = out.indexOf('[')
    if (at >= 0) verdicts = new Map(JSON.parse(out.slice(at)).map((r) => [String(r.issue), r.review_state]))
  } catch { verdicts = null }
  if (!verdicts) {
    console.log('the board could not be read - NOTHING was measured. An unreachable board is not an empty one.')
    process.exit(3)
  }

  const s = split(
    issues,
    (i) => verdicts.get(String(i.number)) || null,
    (i) => G.gateBody(i.body || '', `#${i.number}`, { filed: true }).problems.length === 0,
  )
  console.log(render(s))
  if (process.argv.includes('--json')) console.log(JSON.stringify(s, null, 1))
  console.log(`\n${s.pass.judged + s.fail.judged} judged issue(s): ${s.passRate ?? '-'}% accepted when the brief passes, ${s.failRate ?? '-'}% when it fails`)
  process.exit(0)
}
