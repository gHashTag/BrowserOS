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


/**
 * The z for a family of k comparisons, so k tests at once do not manufacture a
 * finding out of nothing.
 *
 * Testing five subgroups at 95% each gives a 1 - 0.95^5 = 23% chance that at
 * least one comes back "significant" with nothing wrong anywhere. A dashboard
 * that splits a rate by category and tests each at the single-comparison
 * threshold will therefore raise a false alarm roughly every fourth time it is
 * looked at, and it will be muted, and then the real one will be missed too.
 *
 * Bonferroni: divide the family error rate by the number of comparisons. It is
 * the conservative choice and the right one here - a false alarm costs the
 * tool's credibility, while a missed small effect costs one round's attention.
 */
export function zForFamily(k, familyAlpha = 0.05) {
  const alpha = familyAlpha / Math.max(1, k)
  return probit(1 - alpha / 2)
}

/**
 * The inverse of the standard normal CDF - Acklam's rational approximation,
 * accurate to about 1.15e-9 across the open interval, which is far more than a
 * proportion over a few hundred samples can justify.
 */
export function probit(p) {
  if (!(p > 0 && p < 1)) return NaN
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00]
  const pLow = 0.02425
  const pHigh = 1 - pLow
  let q
  let r
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  q = p - 0.5
  r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

export function compare(hitsA, nA, hitsB, nB, labelA = 'A', labelB = 'B', z = 1.96) {
  const a = wilson(hitsA, nA, z)
  const b = wilson(hitsB, nB, z)
  const overlap = a.low <= b.high && b.low <= a.high
  return {
    a: { ...a, hits: hitsA, n: nA, label: labelA },
    b: { ...b, hits: hitsB, n: nB, label: labelB },
    overlap,
    needed: neededFor(a.p, b.p, z),
    z,
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
