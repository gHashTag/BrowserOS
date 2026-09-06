#!/usr/bin/env node
// An attempt that spends no retry budget can be repeated for ever.
//
// WHAT THIS FOUND, and it is the opposite of what this round set out to prove.
// The question was whether `sendBack` is a dead end - 158 issues sit in it, and
// `lease.mjs` says plainly that nothing reopens a worker on a send-back. The
// first measurement seemed to confirm it: 391 dispatches across 391 issues,
// every issue with exactly one row, no issue ever dispatched twice.
//
// THAT MEASUREMENT WAS WORTHLESS. `queen_dispatch` is written with
// `ON CONFLICT (issue) DO UPDATE`, so it holds one row per issue BY SCHEMA. A
// re-dispatch overwrites; it does not insert. Counting rows in a table keyed by
// the thing being counted answers nothing, and it answered nothing here.
//
// The archive holds the real history: 602 attempts across 170 issues, 113 of
// them attempted more than once, one attempted thirteen times. Work is
// re-dispatched constantly. `sendBack` is not a dead end.
//
// THE REAL DEFECT IS THE OPPOSITE ONE - not a loop that never runs, a loop that
// never stops. The deployed reviewer decides whether an attempt counts against
// the retry ceiling:
//
//   const countsAgainstTheIssue = !(failed.length === 0 && unjudged.length > 0)
//
// An attempt whose unmet criteria are ALL unjudged does not spend the budget,
// and the reasoning is sound and documented (#1420 FR-003): the bee went silent
// rather than wrong, and counting silence was escalating work to a person that
// had never been assessed - the oldest after 91 hours. Fixing that was right.
//
// What nobody measured is the other side of it. A bee that is silent ONCE
// should not be charged. A bee that is silent EVERY TIME is now in a loop with
// no ceiling at all, because the counter that would end it never moves.
// Measured 2026-09-06: 60 of 159 send-back issues have been attempted three or
// more times and have spent ZERO budget. #1558 has been attempted twelve times
// over twenty hours. Eleven issues sit at nine or ten attempts, every one of
// them reviewed within the last hour - that is the swarm's four slots, looping
// now.
//
// WHAT WOULD REFUTE THIS. If those issues had spent budget, the ceiling would
// be working and they would simply be hard. So `counted` is a real branch and
// it is reported first: an issue whose attempts DID charge the budget is
// evidence against this file's thesis, not for it, and if that group is the
// larger one the summary says the thesis failed rather than burying it.
//
// AN ISSUE WITH NO ARCHIVE ROW IS NOT AN ISSUE WITH NO ATTEMPTS. The archive
// holds finished attempts; the live one is still on the board. So attempts are
// reported as `archived + 1`, with the assumption named rather than folded in.
//
// A LEFT JOIN THAT FINDS NO PARTNER IS AN ANSWER, NOT A SILENCE - and the first
// draft got this backwards, calling 51 issues "no readable history" when a
// successful query returning no archived row is positive evidence that this is
// the first attempt. That is the reverse of the mistake this directory usually
// makes and it is still a mistake: `unknown` has to mean the query failed, not
// that it succeeded and said zero. The whole-query failure is handled once, at
// the top, where an unreachable board exits without examining anything.
//
// THE ARCHIVE HAS A HORIZON. Its earliest attempt is 2026-08-31; anything
// re-dispatched before that leaves no trace here, so an attempt count is a
// FLOOR and never an upper bound. Every issue named in the looping group above
// is numbered well past that date, so the horizon does not explain them.
//
// Usage:
//   node silent-loop.mjs             # what is looping without a ceiling
//   node silent-loop.mjs --limit 20  # show more rows

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/silent-loop.mjs')

/** Attempts that have run for an issue: the archived ones plus the live one. */
export function attemptsOf(row) {
  const archived = row == null ? null : row.archived
  if (archived === null || archived === undefined) return null
  const n = Number(archived)
  if (!Number.isFinite(n) || n < 0) return null
  return n + 1
}

/**
 * Sort one send-back issue by whether its attempts ever charged the ceiling.
 *
 * `counted` is the branch that can refute the file. It is not a leftover case:
 * a send-back that spent budget is one the existing mechanism is handling, and
 * the more of those there are the weaker this instrument's claim becomes.
 */
export function classify(row) {
  const attempts = attemptsOf(row)
  const issue = row && row.issue
  if (attempts === null) {
    return { issue, kind: 'unknown', attempts: null, spent: null, hours: row && row.hours,
      why: 'the attempt history could not be read - this says nothing about the issue' }
  }
  const spent = Number(row.spent ?? 0)
  if (!Number.isFinite(spent)) {
    return { issue, kind: 'unknown', attempts, spent: null, hours: row.hours,
      why: 'the budget column could not be read as a number' }
  }
  const base = { issue, attempts, spent, hours: row.hours }
  if (spent > 0) {
    return { ...base, kind: 'counted',
      why: 'attempts here DID charge the ceiling - the mechanism is working on this issue' }
  }
  if (attempts >= 3) {
    return { ...base, kind: 'looping',
      why: 'attempted three or more times and the ceiling has never moved, so nothing can end it' }
  }
  return { ...base, kind: 'young',
    why: 'too few attempts to say anything - one silent pass is exactly what the rule intends to forgive' }
}

export function render(rows, limit = 12) {
  const by = { looping: [], counted: [], young: [], unknown: [] }
  for (const r of rows) by[r.kind].push(r)
  const n = rows.length
  const out = [`${n} send-back issue(s) examined`, '']

  if (by.counted.length) {
    out.push(`${by.counted.length} of ${n} spent retry budget - on these the ceiling is working:`)
    for (const r of by.counted.slice(0, limit)) {
      out.push(`   #${r.issue}  ${r.attempts} attempt(s), ${r.spent} charged`)
    }
    out.push('')
  }

  out.push(`${by.looping.length} of ${n} have been attempted 3+ times and charged NOTHING:`)
  for (const r of by.looping.slice(0, limit)) {
    const waited = r.hours === null || r.hours === undefined ? '' : `, looping ${r.hours}h`
    out.push(`   #${r.issue}  ${r.attempts} attempt(s), 0 charged${waited}`)
  }
  if (by.looping.length > limit) out.push(`   ... and ${by.looping.length - limit} more`)

  if (by.young.length) out.push(`${by.young.length} have been attempted once or twice - the rule is meant to forgive those`)
  if (by.unknown.length) {
    out.push(`${by.unknown.length} had no readable history, so they are NOT accused: ${by.unknown.map((r) => `#${r.issue}`).join(' ')}`)
  }

  out.push('')
  out.push('Attempts come from the archive, whose earliest row is 2026-08-31, so every count')
  out.push('here is a floor and never an upper bound.')
  out.push('')
  out.push('An attempt is charged only when a criterion was tested and failed. Silence is')
  out.push('deliberately free (#1420 FR-003), so that work nobody assessed does not reach a')
  out.push('person. The cost of that, unmeasured until now, is the group above: an issue')
  out.push('whose bee is silent EVERY time can be re-attempted without any ceiling at all.')

  if (by.counted.length > by.looping.length) {
    out.push('')
    out.push('THIS RUN REFUTES THE THESIS: more issues charged the ceiling than looped past')
    out.push('it. The mechanism is doing its job here, and the paragraph above does not')
    out.push('describe this board.')
  }
  return out.join('\n')
}

if (isMain) {
  const CH = await import(path.join(DIR, 'channel.mjs'))
  const L = await import(path.join(DIR, 'loop.mjs'))

  const at = process.argv.indexOf('--limit')
  const limit = at >= 0 ? Number(process.argv[at + 1]) || 12 : 12

  // `send_backs` is NOT NULL DEFAULT 0, checked against information_schema
  // rather than assumed, so a zero here is a real zero and not an absence
  // wearing a coalesce. The archive is LEFT JOINed: an issue with no archived
  // attempt must come back as null and be classified `unknown`, not silently
  // become a zero.
  //
  // THE AGE IS MEASURED FROM THE FIRST DISPATCH, NOT FROM THE LAST REVIEW.
  // `reviewed_at` is rewritten every time the sweep looks at the row, so an
  // issue that has been looping for a day reads as "1h old" the moment it is
  // re-reviewed - and this file's first draft printed exactly that, until
  // `clocks.mjs` refused it. The archive's `dispatched_at` is written once per
  // attempt and never updated, so its minimum is when the loop began.
  //
  // The archive keeps the whole row as a JSONB `snapshot` rather than as
  // columns - it holds only (id, issue, archived_at, snapshot) - so the field
  // is read out of the document. All 605 archived rows carry it, checked rather
  // than assumed.
  const sql = `
    select d.issue,
           coalesce(h.n, 0) as archived,
           d.send_backs as spent,
           round(extract(epoch from (now() - h.first_dispatch)) / 3600)::int as hours
      from queen_dispatch d
      left join (select issue, count(*)::int as n,
                        min((snapshot->>'dispatched_at')::timestamptz) as first_dispatch
                   from queen_dispatch_history group by issue) h
        on h.issue = d.issue
     where d.review_state = 'sendBack'
     order by h.n desc nulls last, h.first_dispatch asc`
  const js = 'const {Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL}); p.query(' +
    JSON.stringify(sql) + ').then(r => { console.log(JSON.stringify(r.rows)); process.exit(0); })' +
    '.catch(e => { console.log("ERR " + e.message); process.exit(1); });'

  let rows = null
  try {
    const out = String(CH.remote(`cd /app/apps/server && bun -e ${L.shq(js)}`, { attempts: 2 }))
    const i = out.indexOf('[')
    if (i >= 0) rows = JSON.parse(out.slice(i))
  } catch { rows = null }
  if (!rows) {
    console.log('the board could not be read - NOTHING was examined. An unreachable board is not an empty one.')
    process.exit(3)
  }
  if (!rows.length) {
    console.log('no issue is in send-back - nothing to examine')
    process.exit(0)
  }

  const classified = rows.map(classify)
  console.log(render(classified, limit))
  const looping = classified.filter((r) => r.kind === 'looping').length
  console.log(`\n${classified.length} examined, ${looping} looping with no ceiling`)
  process.exit(looping ? 2 : 0)
}
