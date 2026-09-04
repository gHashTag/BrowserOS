#!/usr/bin/env node
// Continuous improvement loop - bookkeeping, idempotency and the dashboard.
//
// The contract this file exists to keep: a new cron fire must never break or
// repeat what a previous fire did. Three mechanisms, in the order they have
// mattered elsewhere in this project:
//
//   1. A LOCK carrying a pid and a start time. A fire that finds a live lock
//      exits and writes nothing. A lock whose pid is gone is a corpse and is
//      taken, with a line in the ledger recording that it was taken.
//   2. An append-only LEDGER. Nothing is ever rewritten, so a crashed fire
//      leaves evidence rather than a hole.
//   3. A DONE SET keyed by a stable hash of the unit of work, so re-running a
//      unit is a no-op and the loop advances instead of spinning.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const STATE = path.join(DIR, 'state.json')
const LEDGER = path.join(DIR, 'ledger.jsonl')
const LOCK = path.join(DIR, 'loop.lock')
const DASH = path.join(DIR, 'DASHBOARD.txt')
const DASH_ANSI = path.join(DIR, 'DASHBOARD.ansi')
const LOCK_STALE_MS = 45 * 60 * 1000

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1) + '\n')

export function loadState() {
  return readJSON(STATE, {
    iteration: 0,
    startedAt: null,
    lastFinishedAt: null,
    title: '',
    done: {},     // unitHash -> {unit, iteration, at}
    anchors: {},  // name -> {value, at, prev}  what a later fire compares against
    lessons: [],
  })
}

export const unitHash = (unit) =>
  crypto.createHash('sha256').update(String(unit)).digest('hex').slice(0, 12)

export const isDone = (unit) => Boolean(loadState().done[unitHash(unit)])

export function markDone(unit, note) {
  const s = loadState()
  s.done[unitHash(unit)] = {
    unit: String(unit).slice(0, 200),
    iteration: s.iteration,
    at: new Date().toISOString(),
    note: note || '',
  }
  writeJSON(STATE, s)
  append({ kind: 'done', unit: String(unit).slice(0, 200), note: note || '' })
}

// Record a measurement and return what it was last time, so a later fire can
// say whether it moved rather than restating it.
export function anchor(name, value) {
  const s = loadState()
  const prev = s.anchors[name]
  s.anchors[name] = { value, at: new Date().toISOString(), prev: prev ? prev.value : null }
  writeJSON(STATE, s)
  return prev ? prev.value : null
}

export const anchorOf = (name) => (loadState().anchors[name] || {}).value

export function lesson(text) {
  const s = loadState()
  s.lessons.push({ at: new Date().toISOString(), iteration: s.iteration, text })
  writeJSON(STATE, s)
  append({ kind: 'lesson', note: text })
}

export function append(row) {
  fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n')
}

/**
 * Quote a script so the LOCAL shell passes it through untouched.
 *
 * This cost two wrong diagnoses before it was understood. `execSync` runs its
 * argument through /bin/sh. If a remote script is wrapped with
 * `JSON.stringify`, it arrives in DOUBLE quotes, and inside double quotes the
 * local shell expands `$base`, `$b`, `$1` and `$(...)` before `railway ssh`
 * ever sees them. The symptoms looked like remote problems and were not:
 *
 *   - `any($1)` reached Postgres as `any()` and failed with "syntax error at
 *     or near )". Diagnosed at the time as the REMOTE shell eating it; it was
 *     the local one.
 *   - A branch survey reported "0 branches with work" against a container that
 *     had 118, because `$base..$b` had already collapsed to `..` locally.
 *
 * Single quotes stop all of it. An embedded single quote is closed, escaped and
 * reopened, which is the only way to get one inside a single-quoted string.
 *
 * A separate trap, unrelated to quoting: a real newline survives this fine, but
 * `JSON.stringify` turns it into a literal backslash-n, so anything still using
 * that path must be one line. With `shq` newlines are safe.
 */
export const shq = (s) => `'` + String(s).replace(/'/g, `'\\''`) + `'`

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

// The lock is held for the duration of an ITERATION, and an iteration is a
// Claude turn made of many short-lived processes. So pid liveness is useless
// here: the process that took the lock has always exited by the time the next
// call looks at it, and a pid-liveness check would hand the lock straight to a
// concurrent cron fire. Age is the only sound test. The window is deliberately
// longer than the 15-minute cadence: after a crash it is better to skip two
// fires than to let two of them write at once.
export function acquire(holder) {
  if (fs.existsSync(LOCK)) {
    const l = readJSON(LOCK, null)
    const age = l ? Date.now() - Date.parse(l.at) : Infinity
    if (l && age < LOCK_STALE_MS) return { ok: false, held: l, ageMs: age }
    append({ kind: 'lock-reclaimed', note: l ? `held since ${l.at}, past the ${LOCK_STALE_MS / 60000}m window` : 'unreadable lock' })
  }
  writeJSON(LOCK, { holder: holder || 'unnamed', pid: process.pid, at: new Date().toISOString() })
  return { ok: true }
}

export const release = () => { try { fs.unlinkSync(LOCK) } catch { /* already gone */ } }

/** The lock file as written, whatever its age. For a reader that wants details. */
export function lockRecord() {
  if (!fs.existsSync(LOCK)) return null
  const l = readJSON(LOCK, null)
  if (!l) return null
  const ageMs = Date.now() - Date.parse(l.at)
  return { ...l, ageMs, expired: !(ageMs < LOCK_STALE_MS) }
}

/**
 * Who holds the lock right now, or null. Read-only; takes nothing.
 *
 * An EXPIRED lock is not a holder. This returned the record whatever its age,
 * so it and `acquire` answered the same question differently: `lockHolder`
 * said iteration-28 still held the lock while `acquire` was already entitled to
 * reclaim it. The selftest caught the pair disagreeing - it read a holder, took
 * the lock anyway, and reported "took a lock already held by iteration-28".
 *
 * That is worse than cosmetic. `heal.mjs` prints this holder when it stands
 * down, so the chain could name a corpse as the reason it did nothing, and the
 * operator reading that line would go looking for a run that had finished
 * forty-five minutes earlier.
 */
export function lockHolder() {
  const l = lockRecord()
  if (!l || l.expired) return null
  return l
}

export function beginIteration(title) {
  const s = loadState()
  s.iteration += 1
  s.startedAt = new Date().toISOString()
  s.title = title || ''
  writeJSON(STATE, s)
  append({ kind: 'begin', iteration: s.iteration, title: title || '' })
  return s.iteration
}

export function endIteration(summary) {
  const s = loadState()
  s.lastFinishedAt = new Date().toISOString()
  writeJSON(STATE, s)
  append({ kind: 'end', iteration: s.iteration, ...(summary || {}) })
  return s.iteration
}

// -------------------------------------------------------------- the dashboard

const ESC = String.fromCharCode(27)
const sgr = (code) => (t) => `${ESC}[${code}m${t}${ESC}[0m`
const dim = sgr(2), bold = sgr(1), green = sgr(32), red = sgr(31)
const yellow = sgr(33), cyan = sgr(36)

const W = 76
const strip = (t) => t.replace(new RegExp(ESC + '\\[[0-9;]*m', 'g'), '')
const pad = (t, w) => t + ' '.repeat(Math.max(0, w - strip(t).length))
const row = (t = '') => `│ ${pad(t, W - 3)}│`
const rule = () => `├${'─'.repeat(W - 1)}┤`
const top = (t) => `╭─ ${t} ${'─'.repeat(Math.max(0, W - 4 - strip(t).length))}╮`
const bottom = () => `╰${'─'.repeat(W - 1)}╯`

function delta(now, prev, goodDown) {
  if (prev === null || prev === undefined || Number.isNaN(Number(prev))) return dim(' new')
  const d = Number(now) - Number(prev)
  if (d === 0) return dim('   =')
  const s = (d > 0 ? '+' : '') + d
  const good = goodDown ? d < 0 : d > 0
  return (good ? green : red)(pad(s, 4))
}

export function renderDashboard(facts) {
  const s = loadState()
  const out = []
  out.push(top(bold('TRIOS CONTINUOUS LOOP') + dim('   cron */15   job 23d6fe89')))
  out.push(row(`${dim('iteration')}  ${bold('#' + s.iteration)}    ${dim('started')} ${(s.startedAt || '-').slice(0, 19)}Z`))
  // Truncate rather than overflow: a row wider than the box breaks every border
  // below it, and the first iteration's subject did exactly that.
  out.push(row(`${dim('subject')}    ${(s.title || '-').slice(0, W - 15)}`))
  out.push(rule())
  out.push(row(bold('SWARM') + dim('   value, and how it moved since the last iteration')))
  for (const m of facts.swarm || []) {
    out.push(row(`  ${pad(dim(m.k), 34)} ${pad(bold(String(m.v)), 10)} ${delta(m.v, m.prev, m.goodDown !== false)}`))
  }
  out.push(rule())
  out.push(row(bold('WORK THIS ITERATION')))
  for (const t of facts.work || []) {
    const mark = { done: green('●'), blocked: red('●'), running: yellow('●') }[t.state] || dim('○')
    out.push(row(`  ${mark} ${pad(t.title, 48)} ${dim((t.note || '').slice(0, 20))}`))
  }
  if ((facts.anomalies || []).length) {
    out.push(rule())
    out.push(row(bold(red('ANOMALIES')) + dim('   found by this iteration, against its own work')))
    for (const a of facts.anomalies) out.push(row(`  ${red('!')} ${a.slice(0, 68)}`))
  }
  if ((facts.next || []).length) {
    out.push(rule())
    out.push(row(bold('THREE WAYS TO CONTINUE')))
    facts.next.forEach((n, i) => out.push(row(`  ${cyan(i + 1 + '.')} ${n.slice(0, 68)}`)))
  }
  out.push(bottom())
  const text = out.join('\n')
  fs.writeFileSync(DASH_ANSI, text + '\n')
  fs.writeFileSync(DASH, strip(text) + '\n')
  return text
}

// ------------------------------------------------------------------------ cli

// GATED ON isMain, and this one was dangerous.
//
// Every other tool imports this file. It read `process.argv[2]` at module
// scope and dispatched on it, so ANY tool invoked with `unlock` as its first
// argument released the loop lock - the exact protection the lock exists to
// provide, removed by an argument meant for something else. Proven, not
// supposed: an importer run as `probe.mjs unlock` printed "lock released" and
// the lock went free.
//
// Found by a guard written minutes earlier for this same class, after
// brief-gate was caught doing a milder version of it.
const isMain = process.argv[1] && process.argv[1].endsWith('/loop.mjs')
const cmd = isMain ? process.argv[2] : undefined
if (cmd === 'status') {
  const s = loadState()
  console.log(`iteration ${s.iteration} | started ${s.startedAt || '-'} | finished ${s.lastFinishedAt || '-'}`)
  console.log(`done units ${Object.keys(s.done).length} | anchors ${Object.keys(s.anchors).length} | lessons ${s.lessons.length}`)
  if (fs.existsSync(LOCK)) {
    const l = readJSON(LOCK, {})
    const mins = Math.round((Date.now() - Date.parse(l.at)) / 60000)
    const held = mins < LOCK_STALE_MS / 60000
    console.log(`LOCK ${l.holder || '?'} since ${l.at} (${mins}m) - ${held ? 'HELD' : 'stale, reclaimable'}`)
    console.log(`  (the pid ${l.pid} is ${alive(l.pid) ? 'alive' : 'gone'}, which is expected and not what decides the lock)`)
  } else console.log('LOCK free')
} else if (cmd === 'dash') {
  process.stdout.write(fs.existsSync(DASH_ANSI) ? fs.readFileSync(DASH_ANSI, 'utf8') : 'no dashboard yet\n')
} else if (cmd === 'ledger') {
  const n = Number(process.argv[3] || 20)
  const rows = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).slice(-n) : []
  for (const r of rows) {
    const j = JSON.parse(r)
    console.log(`${j.at.slice(5, 16)}  ${pad(j.kind, 16)} ${(j.title || j.unit || j.note || '').slice(0, 70)}`)
  }
} else if (cmd === 'unlock') {
  release()
  console.log('lock released')
} else if (cmd === 'anchors') {
  const a = loadState().anchors
  for (const [k, v] of Object.entries(a)) console.log(`${pad(k, 34)} ${pad(String(v.value), 10)} prev ${v.prev} @ ${v.at.slice(5, 16)}`)
}
