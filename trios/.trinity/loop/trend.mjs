#!/usr/bin/env node
// A level is not a rate - for the review queue as much as for the disk.
//
// The reaper learned this the expensive way: a threshold of 80% looked like
// margin until the volume was measured climbing fifteen points an hour, which
// made it fifty-five minutes of warning. The same blindness applies to every
// counter on the dashboard. `claimed` at 15 and falling is a fence coming down;
// `claimed` at 15 and climbing is a fence being rebuilt, and the number alone
// cannot tell them apart.
//
// Everything here comes from `snapshot` lines the loop already appends on every
// render. Nothing new is measured; what was already recorded is finally read.
//
// Usage:
//   node trend.mjs            # the last 6 hours
//   node trend.mjs 2          # the last 2 hours

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const LEDGER = path.join(DIR, 'ledger.jsonl')
const isMain = process.argv[1] && process.argv[1].endsWith('/trend.mjs')

const SERIES = [
  { key: 'running', label: 'bees running', get: (r) => r.running, goodUp: true },
  { key: 'finished', label: 'dispatches finished', get: (r) => r.finished, goodUp: true },
  { key: 'claimed', label: 'claimed by parked', get: (r) => (r.skips || {}).claimed, goodUp: false },
  { key: 'completed', label: 'done but not closed', get: (r) => (r.skips || {}).completed, goodUp: false },
  { key: 'fileConflict', label: 'fenced by paths', get: (r) => (r.skips || {}).fileConflict, goodUp: false },
]

export function trend(hours) {
  const since = Date.now() - hours * 3600000
  const rows = (fs.existsSync(LEDGER)
    ? fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean)
    : [])
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((r) => r && r.kind === 'snapshot' && Date.parse(r.at) >= since)

  const out = []
  for (const s of SERIES) {
    // A counter that was not measured on a tick is absent, not zero. The
    // dashboard already learned that lesson: a capacity refusal short-circuits
    // before the skip loop, so `skips` is `{}` and every skip counter is
    // MISSING, not 0. Including those as zeroes would invent a crash and then
    // a recovery, twice per hour.
    const points = rows
      .map((r) => ({ at: Date.parse(r.at), v: s.get(r) }))
      .filter((p) => typeof p.v === 'number')
    if (points.length < 2) { out.push({ ...s, state: 'too few points', n: points.length }); continue }
    const first = points[0]
    const last = points[points.length - 1]
    const span = (last.at - first.at) / 3600000
    if (span < 0.2) { out.push({ ...s, state: 'span too short', n: points.length }); continue }
    const rate = (last.v - first.v) / span
    out.push({ ...s, state: 'measured', n: points.length, first: first.v, last: last.v, span, rate })
  }
  return out
}

if (isMain) {
  const hours = Number(process.argv[2] || 6)
  const rows = trend(hours)
  console.log(`trend over the last ${hours} h, from the snapshot lines already in the ledger\n`)

  for (const r of rows) {
    if (r.state !== 'measured') {
      console.log(`  ${r.label.padEnd(22)} ${r.state} (${r.n} usable point${r.n === 1 ? '' : 's'})`)
      continue
    }
    const dir = r.rate > 0.05 ? 'rising' : r.rate < -0.05 ? 'falling' : 'flat'
    const good = dir === 'flat' ? '' : ((r.rate > 0) === r.goodUp ? '  good' : '  BAD')
    console.log(
      `  ${r.label.padEnd(22)} ${String(r.last).padStart(4)}  ` +
      `${(r.rate >= 0 ? '+' : '') + r.rate.toFixed(1)}/h  ${dir}${good}` +
      `   (${r.first} -> ${r.last} over ${r.span.toFixed(1)} h, ${r.n} points)`,
    )
  }

  const bad = rows.filter((r) => r.state === 'measured' && Math.abs(r.rate) > 0.05 && (r.rate > 0) !== r.goodUp)
  console.log(
    bad.length
      ? `\n${bad.length} counter(s) moving the wrong way. A level says where you are; ` +
        `a rate says whether the chain is winning.`
      : '\nnothing is moving the wrong way.',
  )
}
