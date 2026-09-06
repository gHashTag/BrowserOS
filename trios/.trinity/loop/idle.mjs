#!/usr/bin/env node
// How much of the day the swarm spent doing nothing, and what stopped it.
//
// THE GOLDEN RULE, in the operator's words: the bees work, and they start again
// the moment they finish. Nothing in this directory measured whether they do.
// Twenty instruments count issues, verdicts, briefs, branches and disagreements
// - and the one number that says whether the swarm is WORKING was missing.
//
// It had been false for a long time. Measured 2026-09-06 over twelve hours:
//
//   minutes with ZERO bees running : 357 of 721  (50%)
//   minutes with all four running  : 258         (36%)
//   median gap between bursts      : 22 min, against a five-minute tick
//
// Bimodal - four bees or none - because a round either gets its issue list or
// dies whole, and 144 rounds in one log window died on `GitHub returned 403`.
// Every GitHub read went out unauthenticated against a sixty-an-hour limit
// while the service held a token good for fifteen thousand.
//
// WHY A DASHBOARD ROW WAS NOT ENOUGH. `bees running (of 4)` has been on the
// dashboard for weeks, and it read 4 as often as 0 - a sample of an instant,
// taken once an iteration, of a quantity that is bimodal. It could not have
// shown this and it never did. A rate needs a WINDOW; an instant needs none,
// which is exactly why the instant is the one that gets measured.
//
// WHAT IT DOES NOT DO. It does not restart anything. Idleness has causes -
// a failing round, an empty backlog, a full disk, a refused key - and the cure
// differs for each. It names the cause and stops.
//
// Usage:
//   node idle.mjs                # the last 12 hours
//   node idle.mjs --hours 3      # a shorter window
//   node idle.mjs --json         # the same, as data

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/idle.mjs')

/**
 * Minutes at each concurrency level, by sampling the spans once a minute.
 *
 * SAMPLED, not integrated, because the question is "how much of the time were
 * the bees working" and a sample answers it in the same units the operator
 * asks it in. `capacity` is passed rather than assumed: a hard-coded 4 here
 * would be the second place that number lives.
 */
export function utilisation(spans, from, to, capacity = 4) {
  const level = {}
  let samples = 0
  let idle = 0
  let full = 0
  // `t < to`, not `t <= to`. A twenty-minute window holds twenty one-minute
  // buckets, and the inclusive form samples the closing boundary as a
  // twenty-first - which made a half-idle window measure 52%. Caught by this
  // file's own calibration case, which is what those cases are for.
  for (let t = from; t < to; t += 60000) {
    const n = spans.filter(([s, e]) => s <= t && t < e).length
    level[n] = (level[n] || 0) + 1
    samples++
    if (n === 0) idle++
    if (n >= capacity) full++
  }
  if (!samples) return null
  return { samples, idle, full, level, idlePercent: Math.round((100 * idle) / samples), fullPercent: Math.round((100 * full) / samples) }
}

/**
 * The gaps between bursts of work, in minutes.
 *
 * Overlapping spans are merged first: two bees running at once is one busy
 * period, and counting the space between them as idleness would invent gaps
 * that never existed.
 */
export function gapsOf(spans) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  const merged = []
  for (const s of sorted) {
    const last = merged[merged.length - 1]
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
    else merged.push([...s])
  }
  const gaps = []
  for (let i = 1; i < merged.length; i++) gaps.push((merged[i][0] - merged[i - 1][1]) / 60000)
  gaps.sort((a, b) => a - b)
  return { bursts: merged.length, gaps }
}

/** The tick's own cadence, so a gap can be called long or not. */
export function verdictOnGaps(gaps, tickSeconds) {
  if (!gaps.length) return { kind: 'no-gaps', why: 'the swarm never stopped in this window, or it never started' }
  const tickMin = tickSeconds / 60
  const median = gaps[Math.floor(gaps.length / 2)]
  const overTick = gaps.filter((g) => g > tickMin * 1.5).length
  const instant = gaps.filter((g) => g < 1).length
  return {
    kind: overTick > gaps.length / 2 ? 'ROUNDS-ARE-NOT-DISPATCHING' : 'within-cadence',
    median,
    overTick,
    instant,
    why:
      overTick > gaps.length / 2
        ? `${overTick} of ${gaps.length} gaps are longer than the ${tickMin}-minute tick, so rounds are running and starting nothing`
        : 'gaps are within the tick cadence, so the limit is how often a round happens',
  }
}

export function render(u, g, v, hours, failures) {
  const out = [`the last ${hours} hour(s) of the swarm`, '']
  if (!u) return 'nothing was sampled - an unreadable board is not an idle one'
  out.push(`  minutes with ZERO bees working : ${String(u.idle).padStart(4)} of ${u.samples}  (${u.idlePercent}%)`)
  out.push(`  minutes with every bee working : ${String(u.full).padStart(4)}          (${u.fullPercent}%)`)
  out.push('')
  out.push('  concurrent bees, by minute:')
  for (const k of Object.keys(u.level).sort((a, b) => Number(a) - Number(b))) {
    out.push(`    ${k} bees: ${String(u.level[k]).padStart(4)} min`)
  }
  out.push('')
  out.push(`  bursts of work: ${g.bursts}, with ${g.gaps.length} gap(s) between them`)
  if (g.gaps.length) {
    out.push(`    median ${g.gaps[Math.floor(g.gaps.length / 2)].toFixed(1)} min, longest ${g.gaps[g.gaps.length - 1].toFixed(1)} min`)
    out.push(`    gaps under a minute: ${v.instant}   <- the golden rule lives here`)
  }
  out.push('')
  out.push(`  ${v.why}`)
  if (failures && failures.total > 0) {
    out.push('')
    out.push(`  ${failures.total} round(s) FAILED in the log window. The reasons they gave:`)
    for (const [reason, n] of failures.byReason.slice(0, 5)) out.push(`    ${String(n).padStart(4)}  ${reason}`)
  } else if (failures) {
    out.push('')
    out.push('  no round reported a failure in the log window.')
  }
  out.push('')
  out.push('This names the cause and stops. Idleness has several - a failing round, an')
  out.push('empty backlog, a full volume, a refused key - and the cure differs for each,')
  out.push('so nothing here restarts anything.')
  return out.join('\n')
}

if (isMain) {
  const CH = await import(path.join(DIR, 'channel.mjs'))
  const L = await import(path.join(DIR, 'loop.mjs'))

  const at = process.argv.indexOf('--hours')
  const hours = at >= 0 ? Number(process.argv[at + 1]) || 12 : 12
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    console.log('--hours takes a number of hours between 1 and 168')
    process.exit(2)
  }

  const prog = `
    const {Pool} = require('pg')
    const fs = require('fs')
    const p = new Pool({connectionString: process.env.DATABASE_URL})
    const q = await p.query(
      "select (snapshot->>'dispatched_at')::timestamptz as a, (snapshot->>'finished_at')::timestamptz as b " +
      "  from queen_dispatch_history where (snapshot->>'dispatched_at')::timestamptz > now() - interval '${hours} hours' " +
      "union all select dispatched_at as a, finished_at as b from queen_dispatch " +
      " where dispatched_at > now() - interval '${hours} hours'")
    const spans = q.rows.filter(r => r.a).map(r => [new Date(r.a).getTime(), r.b ? new Date(r.b).getTime() : Date.now()])
    // The round's own failures, from the service log. Absent log, absent answer -
    // never a zero, which would read as "no round has ever failed".
    let failures = null
    try {
      const lines = fs.readFileSync('/app/browseros-server.log','utf8').split('\\n').slice(-8000)
      const byReason = {}
      let total = 0
      for (const l of lines) {
        if (!l.startsWith('{')) continue
        try {
          const j = JSON.parse(l)
          if (!/round failed/i.test(String(j.msg||''))) continue
          total++
          const r = String(j.error || 'no reason recorded').slice(0,80)
          byReason[r] = (byReason[r]||0)+1
        } catch {}
      }
      failures = { total, byReason: Object.entries(byReason).sort((x,y)=>y[1]-x[1]) }
    } catch { failures = null }
    console.log('@@' + JSON.stringify({ spans, failures, now: Date.now() }))
    process.exit(0)
  `

  let got = null
  try {
    const out = String(CH.remote(`cd /app/apps/server && bun -e ${L.shq(prog)}`, { attempts: 2 }))
    const i = out.indexOf('@@{')
    if (i >= 0) got = JSON.parse(out.slice(i + 2))
  } catch { got = null }
  if (!got) {
    console.log('the swarm could not be read - NOTHING was measured. An unreadable board is not an idle one.')
    process.exit(3)
  }
  if (!got.spans.length) {
    console.log(`no dispatch at all in the last ${hours} hour(s). That is not idleness measured, it is a swarm that never started.`)
    process.exit(2)
  }

  const to = got.now
  const from = to - hours * 3600 * 1000
  const T27 = await import(path.join(DIR, 't27-parity.mjs'))
  const capacity = T27.ringConst('MAX_CONCURRENT_WORKERS') || 4
  const u = utilisation(got.spans, from, to, capacity)
  const g = gapsOf(got.spans)
  const v = verdictOnGaps(g.gaps, Number(process.env.TRIOS_TICK_SECONDS || 300))
  console.log(render(u, g, v, hours, got.failures))
  if (process.argv.includes('--json')) console.log(JSON.stringify({ u, g, v, failures: got.failures }, null, 1))
  console.log(`\n${u.idlePercent}% of the window had no bee working`)
  process.exit(u.idlePercent >= 25 ? 2 : 0)
}
