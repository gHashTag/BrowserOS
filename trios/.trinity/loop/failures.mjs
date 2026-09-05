#!/usr/bin/env node
// Which chain steps have been failing, how often, and with what evidence.
//
// WHY THIS EXISTS. The ledger has recorded every chain run for weeks and nobody
// ever read it backwards. Asked on 2026-09-05 for the first time, it said
// push-work - the ONE step that gets a bee's work out of the container - had run
// 66 times and 47 were not ok. A 71% failure rate on the step everything else
// depends on, invisible because each run only ever reported itself.
//
// A single failure is noise. The same failure forty-six times is the system, and
// the difference is only visible by reading the record rather than the screen.
//
// Usage:
//   node failures.mjs            # every step, worst first
//   node failures.mjs --since 2  # only the last N days
//   node failures.mjs <step>     # the evidence for one step

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const LEDGER = path.join(DIR, 'ledger.jsonl')
const isMain = process.argv[1] && process.argv[1].endsWith('/failures.mjs')

export function readLedger(file = LEDGER) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

/**
 * Per step: how many times it ran, how many were not ok, and what it said.
 *
 * A step that has never run is not counted as healthy. `runs` is printed beside
 * `failed` for exactly that reason - 0 of 0 and 0 of 66 are different states and
 * a bare failure count cannot tell them apart.
 */
export function tally(rows, sinceDays = null) {
  const cutoff = sinceDays ? Date.now() - sinceDays * 86400000 : null
  const out = new Map()
  for (const r of rows) {
    if (!Array.isArray(r.results)) continue
    if (cutoff && r.at && new Date(r.at).getTime() < cutoff) continue
    for (const s of r.results) {
      if (!s || !s.step) continue
      if (!out.has(s.step)) out.set(s.step, { step: s.step, runs: 0, failed: 0, skipped: 0, findings: 0, evidence: [] })
      const e = out.get(s.step)
      e.runs++
      if (s.status === 'FAILED') {
        e.failed++
        // The evidence field arrived on 2026-09-05. Everything before that has
        // a failure with no reason attached, and saying so is better than
        // silently showing fewer examples than there were failures.
        if (s.evidence) e.evidence.push({ at: r.at, text: s.evidence })
      } else if (s.status === 'skipped') e.skipped++
      else if (s.status === 'FINDING') e.findings++
    }
  }
  return [...out.values()].sort((a, b) => (b.failed / Math.max(1, b.runs)) - (a.failed / Math.max(1, a.runs)))
}

export function render(rows) {
  const out = []
  out.push('  step              runs  failed   rate   skipped  findings')
  for (const r of rows) {
    const rate = r.runs ? `${Math.round((100 * r.failed) / r.runs)}%` : '-'
    const mark = r.runs && r.failed / r.runs >= 0.25 ? '!!' : r.failed ? '..' : 'ok'
    out.push(`  ${mark} ${r.step.padEnd(16)} ${String(r.runs).padStart(4)} ${String(r.failed).padStart(6)} ${rate.padStart(6)} ${String(r.skipped).padStart(8)} ${String(r.findings).padStart(9)}`)
  }
  const blind = rows.filter((r) => r.failed && !r.evidence.length)
  if (blind.length) {
    out.push('')
    out.push(`  ${blind.length} step(s) have failures with NO recorded reason: ${blind.map((r) => r.step).join(', ')}`)
    out.push('  The evidence field arrived on 2026-09-05; failures before it printed their')
    out.push('  reason to a terminal and kept nothing. Those cannot now be diagnosed.')
  }
  return out.join('\n')
}

if (isMain) {
  const rows = readLedger()
  const sinceIdx = process.argv.indexOf('--since')
  const since = sinceIdx > -1 ? Number(process.argv[sinceIdx + 1]) : null
  const only = process.argv.slice(2).find((a) => !a.startsWith('--') && !/^\d+$/.test(a))

  const t = tally(rows, since)
  if (only) {
    const one = t.find((r) => r.step === only)
    if (!one) {
      console.log(`no step named ${only} in the ledger - it has never run, which is not the same as never failing`)
      process.exit(1)
    }
    console.log(`${one.step}: ${one.failed} failure(s) in ${one.runs} run(s)\n`)
    if (!one.evidence.length) {
      console.log('  no evidence recorded for any of them.')
      process.exit(0)
    }
    for (const e of one.evidence.slice(-8)) console.log(`  ${String(e.at).slice(0, 19)}  ${e.text.slice(0, 200)}`)
    process.exit(0)
  }

  console.log(`chain step failures${since ? ` over the last ${since} day(s)` : ' over the whole ledger'}\n`)
  console.log(render(t))
  const worst = t.find((r) => r.runs && r.failed / r.runs >= 0.25)
  process.exit(worst ? 2 : 0)
}
