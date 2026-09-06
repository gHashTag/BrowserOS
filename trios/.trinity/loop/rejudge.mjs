#!/usr/bin/env node
// A recorded verdict the current code cannot reproduce.
//
// WHAT THIS WOULD HAVE CAUGHT. On 2026-09-06 the board held 153 dispatches in
// `sendBack` that had spent no retry budget. Every one carried a complete,
// parseable VERDICT block. Not one had a single criterion that was tested and
// FAILED. They had been returned for criteria they had already answered, and
// they had been sitting there for up to twenty-six hours.
//
// The cause was one line. The brief hands the bee numbered slots and asks for
// `- 1. <criterion>: met`, so the parsed criterion begins "1. " while the
// promised text carries no number. `unjudgedCriteria` matches by containment in
// EITHER direction - and one of those two directions could not fire even once,
// because the line always held a prefix the promise did not. Only
// `line.includes(want)` survived, and that demands the bee reproduce the
// criterion WHOLE; shorten it by a sentence and it reads as never answered.
//
// NOBODY WAS LOOKING FOR A VERDICT THAT HAD STOPPED BEING TRUE. Every other
// instrument in this directory asks whether the swarm is stuck, or whether a
// tool is lying about what it did. None asked the simplest question available:
// take the work as it is stored, run the review's OWN functions over it again,
// and see whether the answer that was recorded is the answer the code gives.
//
// That question is cheap, it needs no new source of truth, and it is
// self-updating: every time the review is fixed, this reports the rows the old
// behaviour left behind. It is how a fix finds the work it should release.
//
// WHAT IT DOES NOT DO. It changes nothing. A disagreement is not automatically
// a defect in the past - the code may have been corrected since, which is the
// good case and the common one. What it produces is a LIST: these rows carry a
// verdict the current code would not give them, so either the code regressed or
// the rows are owed a re-review. Deciding which is a person's job.
//
// Usage:
//   node rejudge.mjs                 # rows whose recorded verdict no longer reproduces
//   node rejudge.mjs --limit 20      # show more of them
//   node rejudge.mjs --state accept  # ask it of a different recorded verdict

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/rejudge.mjs')

/**
 * Compare one recorded verdict against what the review's functions say now.
 *
 * `verdictLines` is how many criteria the bee actually answered, `failedNow`
 * how many of those it marked unmet, `unjudgedNow` how many promised criteria
 * no answered line matches. Those three are exactly the inputs the review
 * weighs, so a disagreement here is a disagreement the review would have.
 *
 * `reproducible` is the branch that refutes this file. A `sendBack` that still
 * has something failed or something unjudged is a send-back the current code
 * would give again, and the more of those there are the less this tool has
 * found. It is counted and reported first for that reason.
 */
export function disagreement(row) {
  const issue = row && row.issue
  const recorded = row && row.recorded
  const lines = Number(row && row.verdictLines)
  const failed = Number(row && row.failedNow)
  const unjudged = Number(row && row.unjudgedNow)
  if (!recorded || !Number.isFinite(lines) || !Number.isFinite(failed) || !Number.isFinite(unjudged)) {
    return { issue, kind: 'unknown', why: 'the stored work could not be re-read - this says nothing about the row' }
  }
  if (lines === 0) {
    // No block at all is the torn-transcript case `unverdicted` already owns,
    // and it is NOT a disagreement: the review would say the same thing today.
    return { issue, kind: 'no-block', lines, failed, unjudged,
      why: 'no verdict lines to re-judge - this is the case `tri unverdicted` reports' }
  }
  if (recorded === 'sendBack' && failed === 0 && unjudged === 0) {
    return { issue, kind: 'UNREPRODUCIBLE', lines, failed, unjudged,
      why: 'recorded as sent back, yet every promised criterion is answered and none is unmet' }
  }
  if (recorded === 'accept' && (failed > 0 || unjudged > 0)) {
    return { issue, kind: 'UNREPRODUCIBLE', lines, failed, unjudged,
      why: 'recorded as accepted, yet the code now finds unmet or unanswered criteria' }
  }
  return { issue, kind: 'reproducible', lines, failed, unjudged,
    why: 'the current code would record the same verdict' }
}

export function render(rows, recorded, limit = 12) {
  const by = { UNREPRODUCIBLE: [], reproducible: [], 'no-block': [], unknown: [] }
  for (const r of rows) by[r.kind].push(r)
  const n = rows.length
  const out = [`${n} dispatch(es) recorded as \`${recorded}\`, re-judged with the review's own functions`, '']

  out.push(`${by.reproducible.length} of ${n} reproduce - the code today would record the same verdict.`)
  if (by['no-block'].length) {
    out.push(`${by['no-block'].length} carry no verdict block at all, which is \`tri unverdicted\`'s question, not this one.`)
  }
  out.push('')
  out.push(`${by.UNREPRODUCIBLE.length} of ${n} DO NOT reproduce:`)
  for (const r of by.UNREPRODUCIBLE.slice(0, limit)) {
    out.push(`   #${r.issue}  ${r.lines} answered, ${r.failed} unmet, ${r.unjudged} unanswered`)
  }
  if (by.UNREPRODUCIBLE.length > limit) out.push(`   ... and ${by.UNREPRODUCIBLE.length - limit} more`)
  if (by.unknown.length) {
    out.push(`${by.unknown.length} could not be re-read, so they are NOT accused: ${by.unknown.map((r) => `#${r.issue}`).join(' ')}`)
  }

  out.push('')
  if (by.UNREPRODUCIBLE.length === 0) {
    // AGREEMENT IS NOT CORRECTNESS, and reading it that way would make this
    // tool a comforting lie of exactly the kind the rest of this directory
    // exists to catch. It compares the record against the code RUNNING IN
    // PRODUCTION. On 2026-09-06 all 159 agreed while every one of them was
    // wrong in the same way, because the defect was in the deployed matcher and
    // the record was a faithful copy of its answer.
    out.push('Nothing here contradicts the record. That means the stored verdicts and the')
    out.push('code RUNNING IN PRODUCTION agree - it is not evidence that either is right.')
    out.push('A defect in the deployed review reproduces perfectly, because the record is')
    out.push('its own output. This goes quiet exactly when it should be loudest, so it is')
    out.push('a companion to a deploy and never a verdict on the review.')
    out.push('')
    out.push('What it is FOR: when a review fix ships, the rows the old behaviour left')
    out.push('behind appear here, and that is the list of work the fix has released.')
  } else {
    out.push('A row that does not reproduce is not automatically a past defect: the code')
    out.push('may have been CORRECTED since, which is the good case and the common one.')
    out.push('What this is, is the list of work the old behaviour left behind - either the')
    out.push('review regressed, or these rows are owed a re-review. Which one it is, is a')
    out.push('question for a person; this changes nothing on its own.')
  }
  return out.join('\n')
}

if (isMain) {
  const CH = await import(path.join(DIR, 'channel.mjs'))
  const L = await import(path.join(DIR, 'loop.mjs'))

  const at = process.argv.indexOf('--limit')
  const limit = at >= 0 ? Number(process.argv[at + 1]) || 12 : 12
  const st = process.argv.indexOf('--state')
  const recorded = st >= 0 ? String(process.argv[st + 1] || 'sendBack') : 'sendBack'
  if (!/^[a-zA-Z]+$/.test(recorded)) {
    console.log('--state takes a verdict name, letters only')
    process.exit(2)
  }

  // RUN THE REVIEW'S OWN FUNCTIONS, never a copy of them.
  //
  // A second implementation of the matching rule is exactly the defect this
  // tool was built after: `missingVerdictSlots` and `unjudgedCriteria` were two
  // implementations of one rule, they disagreed, and a comment asserted they
  // could not. So this imports the deployed module and calls it. If that import
  // fails, the answer is that nothing was measured - not that nothing is wrong.
  const prog = `
    const {Pool} = require('pg')
    const mod = await import('/app/apps/server/src/api/services/queen-tick.ts')
    const p = new Pool({connectionString: process.env.DATABASE_URL})
    const q = await p.query(\`
      select d.issue, d.review_state as recorded, coalesce(d.criteria,'[]'::jsonb) as criteria,
             (select string_agg(t.text, '' order by t.seq) from queen_transcript t
               where t.conversation_id = d.conversation_id and t.kind='say') as said
        from queen_dispatch d
       where d.review_state = '${recorded}'\`)
    const out = []
    for (const r of q.rows) {
      const promised = Array.isArray(r.criteria) ? r.criteria : []
      const verdicts = mod.parseVerdictBlock(String(r.said || ''))
      out.push({
        issue: r.issue,
        recorded: r.recorded,
        verdictLines: verdicts.length,
        failedNow: verdicts.filter((v) => !v.met).length,
        unjudgedNow: verdicts.length ? mod.unjudgedCriteria(promised, verdicts).length : 0,
      })
    }
    console.log('@@' + JSON.stringify(out))
    process.exit(0)
  `
  let rows = null
  try {
    const out = String(CH.remote(`cd /app/apps/server && bun -e ${L.shq(prog)}`, { attempts: 2 }))
    const i = out.indexOf('@@[')
    if (i >= 0) rows = JSON.parse(out.slice(i + 2))
  } catch { rows = null }
  if (!rows) {
    console.log('the stored work could not be re-judged - NOTHING was examined. An unreachable board is not an empty one.')
    process.exit(3)
  }
  if (!rows.length) {
    console.log(`no dispatch is recorded as \`${recorded}\` - nothing to re-judge`)
    process.exit(0)
  }

  const judged = rows.map(disagreement)
  console.log(render(judged, recorded, limit))
  const bad = judged.filter((r) => r.kind === 'UNREPRODUCIBLE').length
  console.log(`\n${judged.length} re-judged, ${bad} carrying a verdict the current code would not give`)
  process.exit(bad ? 2 : 0)
}
