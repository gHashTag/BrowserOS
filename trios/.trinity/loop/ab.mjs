#!/usr/bin/env node
// Two windows, one number, and whether the difference is bigger than noise.
//
// WHY THIS EXISTS. I have compared percentages by eye all night and been wrong
// twice in ways that changed what I recommended to the operator.
//
//   "only 17% of dispatches are accepted, 50% get no verdict at all" - a rate
//   over a window that was still IN FLIGHT. Judged, the same window read 80%.
//   I called the system broken and wrote it into the skill.
//
//   the verdict-first brief: 94% complete blocks before, 86% after, on n=177
//   against n=22. Eyeballed, that is a regression. Measured, three incomplete
//   reports where 1.3 were expected is ordinary Poisson noise and the sample
//   cannot tell a small improvement from a small regression at all.
//
// So the comparison stops being a glance. This gives each proportion a Wilson
// score interval - the one that behaves at small n and near 0 or 1, where the
// normal approximation famously does not - and says in words whether the
// intervals overlap.
//
// WHAT IT REFUSES TO SAY. It never reports "better" or "worse" from overlapping
// intervals. "No detectable difference" is a real answer and the honest one far
// more often than a dashboard suggests; treating it as a null result to be
// talked around is how a change gets credit for noise.
//
// Usage:
//   node ab.mjs <hitsA> <nA> <hitsB> <nB> [labelA] [labelB]
//   node ab.mjs --verdict-first          # the comparison this was built for

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/ab.mjs')

/**
 * The Wilson score interval for a proportion.
 *
 * Not the normal approximation. At n=22 with 3 failures the normal interval
 * runs past 1 and is meaningless exactly where the question is being asked;
 * Wilson stays inside [0,1] and is the standard answer for small samples.
 *
 * z defaults to 1.96, which is 95%.
 */
export function wilson(hits, n, z = 1.96) {
  if (!n) return { low: 0, high: 1, p: 0 }
  const p = hits / n
  const d = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return { p, low: Math.max(0, (centre - spread) / d), high: Math.min(1, (centre + spread) / d) }
}

/**
 * How many observations the smaller window would need before a difference of
 * this size could be distinguished at all.
 *
 * Printed because "not significant" without it reads as "no effect", and the
 * two are different claims. Usually the answer is "keep measuring", and this
 * says how long.
 */
export function neededFor(pA, pB, z = 1.96) {
  const diff = Math.abs(pA - pB)
  if (diff < 1e-9) return Infinity
  const pbar = (pA + pB) / 2
  return Math.ceil((2 * z * z * pbar * (1 - pbar)) / (diff * diff))
}

export function compare(hitsA, nA, hitsB, nB, labelA = 'A', labelB = 'B') {
  const a = wilson(hitsA, nA)
  const b = wilson(hitsB, nB)
  const overlap = a.low <= b.high && b.low <= a.high
  return {
    a: { ...a, hits: hitsA, n: nA, label: labelA },
    b: { ...b, hits: hitsB, n: nB, label: labelB },
    overlap,
    needed: neededFor(a.p, b.p),
    verdict: overlap
      ? 'no detectable difference - the intervals overlap'
      : b.p > a.p
        ? `${labelB} is higher, and the intervals do not overlap`
        : `${labelB} is LOWER, and the intervals do not overlap`,
  }
}

const pct = (x) => `${(100 * x).toFixed(1)}%`

export function render(r) {
  const out = []
  for (const s of [r.a, r.b]) {
    out.push(`  ${s.label.padEnd(10)} ${String(s.hits).padStart(4)}/${String(s.n).padEnd(4)} ` +
      `${pct(s.p).padStart(7)}   95% ${pct(s.low)} to ${pct(s.high)}`)
  }
  out.push('')
  out.push(`  ${r.verdict}`)
  if (r.overlap) {
    out.push('')
    out.push('  "No detectable difference" is a real answer, and it is the honest one far')
    out.push('  more often than a dashboard suggests. A change does not get credit for noise.')
    if (Number.isFinite(r.needed)) {
      out.push(`  To distinguish a gap this size you would need about ${r.needed} observations in EACH window.`)
    } else {
      out.push('  The two rates are identical, so no sample size would separate them.')
    }
  }
  return out.join('\n')
}

if (isMain) {
  if (process.argv.includes('--verdict-first')) {
    // The comparison this file was written for, kept as a command so the claim
    // can be re-checked rather than remembered.
    const SE = await import(path.join(DIR, 'stale-escalations.mjs'))
    const CUT = process.env.AB_CUT || '2026-09-04T14:55:00Z'
    const js = `const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});` +
      `(async()=>{const r={};` +
      `for (const [k, w] of [['before', "d.dispatched_at < '${CUT}'"], ['after', "d.dispatched_at >= '${CUT}'"]]) {` +
      `const q=await p.query("select count(*)::int n, sum(case when s.lines >= jsonb_array_length(d.criteria) then 1 else 0 end)::int complete " +` +
      `"from queen_dispatch d join lateral (select (select count(*) from regexp_matches(string_agg(t.text,'' order by t.seq), '^[-*] .*: *(met|unmet|could-not-check)', 'gm')) lines from queen_transcript t where t.conversation_id=d.conversation_id and t.kind='say') s on true " +` +
      `"where d.finished_at is not null and jsonb_array_length(d.criteria) > 0 and " + w);` +
      `r[k]=q.rows[0];}` +
      `console.log(JSON.stringify(r)); await p.end()})().catch(e=>{console.log('ERR '+e.message); process.exit(1)})`
    const raw = SE.remote(js)
    const line = String(raw ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'))
    if (!line) {
      console.log('could not reach the service - the comparison is unknown, which is not the same as unchanged')
      process.exit(1)
    }
    const d = JSON.parse(line)
    console.log(`did the verdict-first brief make reports more complete?   cut ${CUT}\n`)
    console.log(render(compare(d.before.complete, d.before.n, d.after.complete, d.after.n, 'before', 'after')))
    process.exit(0)
  }

  const [hA, nA, hB, nB, lA, lB] = process.argv.slice(2)
  if ([hA, nA, hB, nB].some((x) => x === undefined || !Number.isFinite(Number(x)))) {
    console.log('usage: ab.mjs <hitsA> <nA> <hitsB> <nB> [labelA] [labelB]')
    console.log('       ab.mjs --verdict-first')
    process.exit(1)
  }
  console.log(render(compare(Number(hA), Number(nA), Number(hB), Number(nB), lA, lB)))
}
