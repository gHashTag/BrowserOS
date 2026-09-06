#!/usr/bin/env node
// Two implementations of one rule, asked the same question about real data.
//
// WHY THIS EXISTS. This repository's most expensive defects are all the same
// shape: one rule written twice, drifting apart, with nothing comparing them.
// The boundary rule had three copies and only two knew `## Границы`, so seven
// bees were accused of straying. `can_start_another` has five. Five SR-00 rules
// were retyped into TypeScript and three disagreed in production. The rings
// audit found eleven more.
//
// On 2026-09-06 it cost 153 dispatches. `unjudgedCriteria` and
// `missingVerdictSlots` both answer "which promised criteria did the bee
// answer?" - one by matching text, one by reading the slot number. They
// disagree on 347 of 358 rows. The comment above the second one asserted they
// could not disagree, and that sentence is precisely what kept the defect
// hidden: it made a real divergence look like somebody else's solved problem.
//
// A COMMENT CLAIMING TWO FUNCTIONS AGREE IS A TEST THAT HAS NOT BEEN WRITTEN.
// This is that test. It does not read the comment and it does not reason about
// the code; it runs both implementations over the rows the system actually
// holds and prints where the answers differ.
//
// THE PRECEDENT IS ALREADY HERE. `t27-parity.mjs` does exactly this across
// languages - the generated ring against the hand-written twin, 460 cases. It
// has never once been wrong about a divergence, because a differential test
// cannot be talked out of its result. This is the same instrument pointed at
// two functions in one file, which is where the drift is cheapest to create
// and hardest to see.
//
// AGREEMENT IS NOT CORRECTNESS. Two implementations that agree may be wrong
// together, and this says nothing about that case - the same limit `rejudge`
// carries and states. What it rules out is the other case, which is the one
// nobody checks: a divergence that has been sitting in the open behind a
// sentence saying it cannot happen.
//
// DIVERGENCE HAS A DIRECTION, and reporting only a count hides the finding.
// Here the two disagree BOTH ways: text matching missed numbered lines that
// were shortened (153 send-backs of finished work), and slot matching is blind
// to 156 blocks that carry no numbering at all. Neither side is the answer, and
// a report that said only "347 differ" would have suggested picking one.
//
// Usage:
//   node agree.mjs                    # every declared pair, over real rows
//   node agree.mjs --limit 6          # fewer example shapes
//   node agree.mjs --pair <name>      # just one

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/agree.mjs')

/**
 * The pairs, each a question two implementations both claim to answer.
 *
 * `program` runs INSIDE the container against the deployed module, because a
 * differential test of a copy proves nothing about what ships - copying the
 * rule here would make this file the third implementation, which is the defect
 * it was written to catch.
 *
 * Each row it emits is `{ id, a, b }`, two arrays of the promised-criterion
 * numbers each side considers ANSWERED. Comparing a common representation
 * rather than each function's own return type is what lets one comparator serve
 * every pair.
 */
export const PAIRS = [
  {
    name: 'answered-criteria',
    question: 'which promised criteria did the bee answer?',
    a: 'unjudgedCriteria (matches by text)',
    b: 'missingVerdictSlots (matches by slot number)',
    // A DOUBLE-QUOTED STRING, NOT A TEMPLATE LITERAL. This fragment is pasted
    // into another template literal and then through `shq` into a shell, and a
    // backtick cannot survive that intact - the first draft emitted an escaped
    // backtick and bun refused the whole program. The SQL contains no double
    // quotes, so the one quoting style that needs no escaping is the one used.
    program: `
      const q = await p.query(
        "select d.issue as id, d.review_state, coalesce(d.criteria,'[]'::jsonb) as criteria, " +
        " (select string_agg(t.text, '' order by t.seq) from queen_transcript t " +
        "   where t.conversation_id = d.conversation_id and t.kind='say') as said " +
        " from queen_dispatch d where d.review_state is not null")
      for (const r of q.rows) {
        const said = String(r.said || '')
        const promised = Array.isArray(r.criteria) ? r.criteria : []
        const verdicts = mod.parseVerdictBlock(said)
        if (!verdicts.length || !promised.length) { out.push({ id: r.id, skip: 'no verdict block or no criteria' }); continue }
        const unjudged = new Set(mod.unjudgedCriteria(promised, verdicts))
        const a = []
        promised.forEach((c, i) => { if (!unjudged.has(c)) a.push(i + 1) })
        const missing = new Set(mod.missingVerdictSlots(said, promised.length))
        const b = []
        for (let i = 1; i <= promised.length; i++) if (!missing.has(i)) b.push(i)
        out.push({ id: r.id, tag: r.review_state, a, b, total: promised.length })
      }
    `,
  },
]

/** One row: do the two sides answer the same set? */
export function classify(row) {
  if (!row || row.id === undefined || row.id === null) {
    return { id: row && row.id, kind: 'unknown', why: 'the row could not be read - it accuses nobody' }
  }
  if (row.skip) return { id: row.id, kind: 'skipped', why: row.skip }
  if (!Array.isArray(row.a) || !Array.isArray(row.b)) {
    return { id: row.id, kind: 'unknown', why: 'one side produced no answer at all' }
  }
  const A = new Set(row.a)
  const B = new Set(row.b)
  const onlyA = row.a.filter((x) => !B.has(x))
  const onlyB = row.b.filter((x) => !A.has(x))
  if (!onlyA.length && !onlyB.length) return { id: row.id, kind: 'agree', tag: row.tag }
  return { id: row.id, kind: 'DIFFER', tag: row.tag, onlyA, onlyB, a: row.a.length, b: row.b.length, total: row.total }
}

/**
 * Which side is missing things the other found, counted separately.
 *
 * A single "347 differ" would invite picking a winner. Both directions being
 * populated is the finding: neither implementation is the rule.
 */
export function directions(rows) {
  let aMisses = 0
  let bMisses = 0
  for (const r of rows) {
    if (r.kind !== 'DIFFER') continue
    if (r.onlyB.length) aMisses++
    if (r.onlyA.length) bMisses++
  }
  return { aMisses, bMisses }
}

export function render(pair, rows, limit = 6) {
  const by = { agree: [], DIFFER: [], skipped: [], unknown: [] }
  for (const r of rows) by[r.kind].push(r)
  const compared = by.agree.length + by.DIFFER.length
  const out = [
    `pair "${pair.name}" - ${pair.question}`,
    `  A: ${pair.a}`,
    `  B: ${pair.b}`,
    '',
    `${compared} row(s) compared, ${by.skipped.length} skipped (nothing for either side to answer)`,
    `  agree : ${by.agree.length}`,
    `  DIFFER: ${by.DIFFER.length}`,
  ]
  if (by.unknown.length) out.push(`  unreadable, so NOT counted against either side: ${by.unknown.length}`)

  if (by.DIFFER.length) {
    const d = directions(rows)
    out.push('')
    out.push(`A missed something B found on ${d.aMisses} row(s); B missed something A found on ${d.bMisses}.`)
    if (d.aMisses && d.bMisses) {
      out.push('BOTH directions are populated, so neither side is the rule and picking')
      out.push('one would trade this defect for its mirror image.')
    }
    const shape = new Map()
    for (const r of by.DIFFER) {
      const k = `${r.tag ?? '-'}: A=${r.a} B=${r.b} of ${r.total}`
      shape.set(k, (shape.get(k) || 0) + 1)
    }
    out.push('')
    for (const [k, n] of [...shape.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit)) {
      out.push(`   ${String(n).padStart(4)}  ${k}`)
    }
    if (shape.size > limit) out.push(`   ... and ${shape.size - limit} more shapes`)
  } else if (compared) {
    out.push('')
    out.push('The two agree on every row compared. That is NOT a proof either is')
    out.push('right - two implementations can be wrong together, and this cannot see')
    out.push('that. What it rules out is a divergence sitting in the open.')
  }
  return out.join('\n')
}

if (isMain) {
  const CH = await import(path.join(DIR, 'channel.mjs'))
  const L = await import(path.join(DIR, 'loop.mjs'))

  const at = process.argv.indexOf('--limit')
  const limit = at >= 0 ? Number(process.argv[at + 1]) || 6 : 6
  const only = process.argv.indexOf('--pair')
  const wanted = only >= 0 ? String(process.argv[only + 1] || '') : ''
  const pairs = wanted ? PAIRS.filter((p) => p.name === wanted) : PAIRS
  if (!pairs.length) {
    console.log(`no pair named "${wanted}". Known: ${PAIRS.map((p) => p.name).join(', ')}`)
    process.exit(2)
  }

  let diverged = 0
  let measured = 0
  for (const pair of pairs) {
    const prog = `
      const {Pool} = require('pg')
      const mod = await import('/app/apps/server/src/api/services/queen-tick.ts')
      const p = new Pool({connectionString: process.env.DATABASE_URL})
      const out = []
      ${pair.program}
      console.log('@@' + JSON.stringify(out))
      process.exit(0)
    `
    let rows = null
    try {
      const res = String(CH.remote(`cd /app/apps/server && bun -e ${L.shq(prog)}`, { attempts: 2 }))
      const i = res.indexOf('@@[')
      if (i >= 0) rows = JSON.parse(res.slice(i + 2))
    } catch { rows = null }
    if (!rows) {
      console.log(`pair "${pair.name}": the rows could not be read - NOTHING was compared. An unreachable board is not an agreeing one.`)
      continue
    }
    measured++
    const judged = rows.map(classify)
    console.log(render(pair, judged, limit))
    console.log('')
    diverged += judged.filter((r) => r.kind === 'DIFFER').length
  }
  if (!measured) process.exit(3)
  console.log(`${measured} pair(s) compared, ${diverged} diverging row(s)`)
  process.exit(diverged ? 2 : 0)
}
