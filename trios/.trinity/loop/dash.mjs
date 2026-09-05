#!/usr/bin/env node
// The dashboard's numbers, measured rather than typed.
//
// WHY THIS EXISTS. Every instrument in this directory measures something and
// refuses to guess. The dashboard did not: `renderDashboard` takes whatever
// numbers its caller hands it, and its caller was me, at three in the morning,
// typing from memory.
//
// On 2026-09-05 I wrote "dispatches finished 258" into iteration #46. The last
// measurement had said 255. Nothing was wrong with the swarm; the number was
// simply invented, in the one artifact whose whole job is to say what is true.
// It went out in a report.
//
// So the facts are gathered here, by asking the same tools everything else asks.
// A fact that cannot be measured comes back null and renders as `-`. It is never
// filled in from memory, and there is no argument by which it could be.
//
// THE PROSE STAYS HAND-WRITTEN. What was done this round, what went wrong, what
// to do next - those are judgements and belong to whoever writes them. The rule
// is narrower and absolute: **numbers are measured, prose is written.**
//
// Usage:
//   node dash.mjs --facts      # what it can measure right now, as JSON
//   node dash.mjs              # the same, as the lines the dashboard shows

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/dash.mjs')

/**
 * Run a measurement, and return null if it could not be taken.
 *
 * null is a real answer here and the important one: the renderer prints `-` for
 * it. An unmeasurable fact that silently became 0 would be worse than the typed
 * number this file exists to replace.
 */
export function measure(fn) {
  try {
    const v = fn()
    return v === undefined ? null : v
  } catch { return null }
}

/**
 * A NON-ZERO EXIT IS OFTEN THE ANSWER, NOT A FAILURE.
 *
 * `failures.mjs` exits 2 when a step is failing more than a quarter of the time
 * - that is the tool working - and `reap-local` exits 1 to mean "would act".
 * Reading either as an error made the dashboard print `-` for two facts it had
 * just successfully measured, which is the same defect as inventing a number,
 * only quieter.
 *
 * So the output is taken whatever the exit code, and only a signal or a timeout
 * counts as not having measured.
 */
const sh = (cmd, timeout = 120000) => {
  try {
    return execSync(cmd, { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }).trim()
  } catch (e) {
    if (e.killed || e.signal || e.code === 'ETIMEDOUT') throw e
    const out = String(e.stdout || '').trim()
    if (!out) throw e
    return out
  }
}

/** running / finished, from the swarm's own board. */
export function swarmCounts(run = sh) {
  const out = run(`${JSON.stringify(path.join(process.env.HOME || '', '.local/bin/tri'))} swarm`, 200000)
  const m = out.match(/running\s+(\d+)\s+finished\s+(\d+)/)
  return m ? { running: Number(m[1]), finished: Number(m[2]) } : null
}

/** The worst-failing chain step, and its rate. */
export function worstStep(run = sh) {
  const out = run(`node ${path.join(DIR, 'failures.mjs')}`, 120000)
  const rows = out.split('\n')
    .map((l) => l.match(/^\s*(?:!!|\.\.|ok)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)%/))
    .filter(Boolean)
    .map((m) => ({ step: m[1], runs: Number(m[2]), failed: Number(m[3]), rate: Number(m[4]) }))
  if (!rows.length) return null
  return rows.sort((a, b) => b.rate - a.rate)[0]
}

/** proven / checkable across every accepted verdict, from the warm cache. */
export function provenCounts(run = sh) {
  const out = run(`node ${path.join(DIR, 'proven.mjs')}`, 400000)
  const m = out.match(/overall (\d+)\/(\d+) judged verdicts prove something; (\d+) carry nothing/)
  return m ? { proven: Number(m[1]), judged: Number(m[2]), unjudgeable: Number(m[3]) } : null
}

/** How many cases the gate actually contains. */
export function selftestCases(read = (f) => fs.readFileSync(f, 'utf8')) {
  const src = read(path.join(DIR, 'selftest.mjs'))
  const n = (src.match(/^check\(/gm) || []).length
  return n || null
}

/**
 * How often the one gateway every critical path shares actually answers.
 *
 * Read from the paired record rather than probed here: probing would add a
 * sample to the thing being measured, and a dashboard that changes its own
 * number by looking at it is not a dashboard.
 *
 * Eighteen samples on 2026-09-05 said 39% - HTTP answered every time and the
 * ssh gateway refused eleven. Every operation that frees the swarm goes through
 * it, so this belongs beside the swarm counts and not in a file nobody opens.
 */
export function gatewayPercent(read = (f) => fs.readFileSync(f, 'utf8')) {
  const rows = read(path.join(DIR, 'state', 'two-views.jsonl'))
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
  if (!rows.length) return null
  const up = rows.filter((r) => r.ssh && r.ssh.attached).length
  return Math.round((100 * up) / rows.length)
}

/** Percent in use of the disk this loop runs on. */
export function diskPercent(run = sh) {
  const out = run(`node ${path.join(DIR, 'reap-local.mjs')} 2>/dev/null | head -3`, 200000)
  const m = out.match(/disk (\d+)% used|(\d+)% used/)
  return m ? Number(m[1] || m[2]) : null
}

export function facts(deps = {}) {
  const { run = sh, read } = deps
  return {
    swarm: measure(() => swarmCounts(run)),
    worstStep: measure(() => worstStep(run)),
    proven: measure(() => provenCounts(run)),
    selftest: measure(() => (read ? selftestCases(read) : selftestCases())),
    disk: measure(() => diskPercent(run)),
    gateway: measure(() => (read ? gatewayPercent(read) : gatewayPercent())),
    at: new Date().toISOString(),
  }
}

/**
 * The measured facts as dashboard rows.
 *
 * `prev` is read from the last recorded reading rather than remembered, so the
 * delta column is a measurement too. A row whose value could not be taken is
 * `null` and the renderer shows `-`.
 */
const READINGS = path.join(DIR, 'state', 'dash-readings.jsonl')

export function lastReading(file = READINGS) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return JSON.parse(lines[lines.length - 1])
  } catch { return null }
}

export function recordReading(f, file = READINGS) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(f) + '\n')
  } catch { /* a reading that cannot be stored is still a reading */ }
}

export function rows(f, prev) {
  const p = prev || {}
  return [
    { k: 'bees running (of 4)', v: f.swarm?.running ?? null, prev: p.swarm?.running ?? null, goodDown: false },
    { k: 'dispatches finished', v: f.swarm?.finished ?? null, prev: p.swarm?.finished ?? null, goodDown: false },
    { k: 'judged verdicts that prove', v: f.proven?.proven ?? null, prev: p.proven?.proven ?? null, goodDown: false },
    { k: 'briefs with nothing checkable', v: f.proven?.unjudgeable ?? null, prev: p.proven?.unjudgeable ?? null },
    { k: `worst step: ${f.worstStep?.step ?? '-'}, percent`, v: f.worstStep?.rate ?? null, prev: p.worstStep?.rate ?? null },
    { k: 'selftest cases', v: f.selftest ?? null, prev: p.selftest ?? null, goodDown: false },
    { k: 'disk this loop runs on, percent', v: f.disk ?? null, prev: p.disk ?? null },
    { k: 'ssh gateway answers, percent', v: f.gateway ?? null, prev: p.gateway ?? null, goodDown: false },
  ]
}

if (isMain) {
  const f = facts()
  if (process.argv.includes('--facts')) {
    console.log(JSON.stringify(f, null, 2))
    process.exit(0)
  }
  const prev = lastReading()
  console.log('measured now, nothing typed:\n')
  for (const r of rows(f, prev)) {
    const d = r.v !== null && r.prev !== null ? (r.v - r.prev >= 0 ? `+${r.v - r.prev}` : String(r.v - r.prev)) : ''
    console.log(`  ${String(r.k).padEnd(38)} ${String(r.v ?? '-').padStart(6)}  ${d.padStart(5)}`)
  }
  const missing = rows(f, prev).filter((r) => r.v === null).map((r) => r.k)
  if (missing.length) {
    console.log(`\n  ${missing.length} fact(s) could not be measured and are shown as '-': ${missing.join(', ')}`)
    console.log('  They are not filled in from memory. That is the whole point of this file.')
  }
  if (process.argv.includes('--record')) recordReading(f)
}
