#!/usr/bin/env node
// One command that measures the swarm, updates the anchors in the right order,
// and renders the dashboard.
//
// The ordering matters and got it wrong once. `anchor(name, value)` writes the
// new value and RETURNS the old one. If an iteration calls anchor() for every
// metric first and renders afterwards, every delta reads "=" because the stored
// value is already the new one. So the delta must come from anchor()'s return
// value, in the same pass. That is what this file guarantees, so no future
// iteration has to remember it.
//
// Usage:
//   node snapshot.mjs                       # measure, anchor, render
//   node snapshot.mjs --work work.json      # ...with this iteration's work list

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const L = await import(path.join(DIR, 'loop.mjs'))
const D = await import(path.join(DIR, 'dash.mjs'))
const T27 = await import(path.join(DIR, 't27-parity.mjs'))
const QUEEN = 'https://trios-agent-server-production.up.railway.app/queen/status'

async function live() {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 20000)
  try {
    const r = await fetch(QUEEN, { signal: ctl.signal })
    if (!r.ok) return { error: `queen answered ${r.status}` }
    return await r.json()
  } catch (e) {
    // An unreachable Queen is a finding, not a reason to render stale numbers as
    // if they were fresh. Say so on the dashboard.
    return { error: String(e.message || e) }
  } finally { clearTimeout(timer) }
}

const j = await live()
const t = j.lastTick || {}
const d = j.dispatches || {}
const s = t.skipSummary || {}

// The anchor KEY is a stable identifier and the label is what the dashboard
// prints. They were the same string once, which meant that rewording a label
// silently reset that metric's history to "new" - the delta column lied by
// omission rather than by a wrong number, which is harder to notice.
const metric = (key, label, v, goodDown = true) => ({ k: label, v, prev: L.anchor(key, v), goodDown })

// THE SKIP COUNTERS ARE NOT ALWAYS MEASURED, AND ZERO IS NOT ALWAYS PROGRESS.
//
// When every worker slot is full the round refuses on capacity and returns
// BEFORE the per-issue skip loop runs. `skippedCount` is then 0 and
// `skipSummary` is `{}` - not because the fences cleared, but because nobody
// looked. Rendering that as a fall from 31 to 0 in green is the dashboard
// telling a comforting lie, which is the defect this whole loop exists to hunt.
//
// So: when the tick short-circuited, the skip metrics are reported as not
// measured, and - just as important - the anchors are NOT updated with the
// fake zeroes, or the next iteration would compare against them and show an
// equally fake regression.
const measuredSkips = !(j.error || (!t.allowed && /workers already running/.test(String(t.refusal || ''))))

const skipMetric = (key, label, v) =>
  measuredSkips
    ? metric(key, label, v)
    : { k: label, v: 'not measured', prev: null, goodDown: true }

const swarm = j.error
  ? [{ k: 'QUEEN UNREACHABLE', v: j.error.slice(0, 20), prev: null, goodDown: true }]
  : [
      metric('swarm.running', D.capacityLabel(() => T27.ringConst('MAX_CONCURRENT_WORKERS')), d.running ?? 0, false),
      metric('swarm.finished', 'dispatches finished', d.finished ?? 0, false),
      skipMetric('skip.total', 'candidates skipped', t.skippedCount ?? 0),
      skipMetric('skip.fileConflict', '  fenced by parked paths', s.fileConflict ?? 0),
      skipMetric('skip.claimed', '  claimed by parked dispatch', s.claimed ?? 0),
      skipMetric('skip.completed', '  done but never closed', s.completed ?? 0),
    ]

// argv only when this file IS the program. See loop.mjs: an importer's own
// arguments reaching an imported module's dispatch released the loop lock.
const isMain = process.argv[1] && process.argv[1].endsWith('/snapshot.mjs')
const argWork = isMain ? process.argv.indexOf('--work') : -1
// Explicitly guarded, not implicitly. These lines were safe only because
// `argWork` is -1 off the main path, and safety nobody can see is safety the
// next edit removes. The guard that flagged them was right to.
const workFile = isMain && argWork > 0 ? process.argv[argWork + 1] : null
const extra = workFile ? JSON.parse(fs.readFileSync(workFile, 'utf8')) : {}

const facts = {
  swarm,
  work: extra.work || [],
  anomalies: extra.anomalies || [],
  next: extra.next || [],
}

L.append({
  kind: 'snapshot',
  running: d.running ?? null,
  finished: d.finished ?? null,
  refusal: j.error ? 'unreachable' : (t.allowed ? 'dispatched' : t.refusal),
  skips: s,
})

console.log(L.renderDashboard(facts))
if (!j.error) {
  console.log(`\n${t.allowed ? 'DISPATCHED' : 'refused: ' + t.refusal}   tick ${(t.decidedAt || '').slice(11, 19)}Z`)
}
