#!/usr/bin/env node
// Every clock a decision is keyed on, and whether anything rewrites it.
//
// THE DEFECT THIS GENERALISES. A valve shipped in BrowserOS#108 measured idle
// from `reviewed_at`, and the review sweep UPDATEs every `wait` row in place
// each round. The clock reset every five minutes against a six-hour floor, so
// the valve could never fire; two dispatches held their boundaries for
// eighteen hours while reading as fresh, and the swarm sat at zero bees for six
// of them. Fixed in #109 by reading `finished_at`.
//
// Asking where else that class lived found it twice more, in `lease.mjs` where
// it was live and in `needs-you.mjs` where it was harmless only because
// `escalate` rows are never re-swept. So the question is worth a command rather
// than a memory.
//
// WHAT IT CANNOT DO. It reads source text; it cannot know whether a field is
// rewritten in a table it has never seen. It classifies against a list of
// fields whose write behaviour has been MEASURED, and reports anything else as
// `unknown` rather than clean - because a clock audit that quietly passes what
// it does not recognise is the same shape as the defect it hunts.
//
// Usage:
//   node clocks.mjs

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const BASE = process.env.CLOCKS_BASE || 'origin/feat/queen-supervisor'
const isMain = process.argv[1] && process.argv[1].endsWith('/clocks.mjs')

// Measured 2026-09-04 against production, not assumed:
//   wait      reviewed_at as recent as 0.03 h   oldest finish 4.7 h   <- reset
//   accept    87.52 h                           87.7 h
//   escalate  89.37 h                           90.1 h
//   sendBack  39.57 h                           50.0 h
const FIELDS = {
  reviewed_at: { safe: false, why: 'the review sweep UPDATEs every wait row in place each round' },
  seen_at: { safe: false, why: 'rewritten by the issue upsert on every tick' },
  // TRACED BY HAND 2026-09-04 and found clean, which a text scanner cannot see
  // across the language boundary. `stillHoldsBoundary` reads `task.updatedAt`;
  // the tick fills it in `boardTask` as `finished ? row.finished_at :
  // row.dispatched_at`, and both are written once. The name still deserves the
  // flag - it MEANS "last touched" - so it stays listed, with the answer
  // attached rather than the question asked again.
  updatedAt: { safe: true, why: 'traced: boardTask fills it from finished_at or dispatched_at, both written once' },
  finished_at: { safe: true, why: 'written once when the bee stops' },
  dispatched_at: { safe: true, why: 'written once at dispatch' },
  created_at: { safe: true, why: 'written once' },
  createdAt: { safe: true, why: 'written once' },
  at: { safe: true, why: 'append-only ledger and report rows' },
}

const SOURCES = [
  { label: 'loop tools', files: () => fs.readdirSync(DIR).filter((f) => f.endsWith('.mjs') && f !== 'clocks.mjs' && f !== 'selftest.mjs').map((f) => ({ name: f, text: fs.readFileSync(path.join(DIR, f), 'utf8') })) },
  {
    label: 'deployed supervisor',
    files: () => {
      // EVERY FILE THAT TOUCHES A CLOCK, not two named ones.
      //
      // This listed queen-tick.ts and QueenDelegation.swift by hand. Measured
      // 2026-09-05: NINETEEN files under apps/server/src mention reviewed_at,
      // finished_at, dispatched_at or updated_at. Seventeen of them were never
      // read, and the guard reported "8 clocks, 8 on fields nothing rewrites"
      // every single round - a clean answer about 11% of the question.
      //
      // Third guard found narrowed after three detectors, and hidden the same
      // way: the number it produced was never zero.
      const out = []
      const listed = (() => {
        try {
          return execSync(
            `git grep -lE "reviewed_at|finished_at|dispatched_at|updated_at|created_at" ${BASE} -- ` +
            `trios/agent-server/apps/server/src trios/agent-server/queen-core/Sources trios/rings/SR-00`,
            { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
          ).trim().split('\n').map((l) => l.replace(/^[^:]*:/, '')).filter(Boolean)
        } catch { return [] }
      })()
      // UNION, NOT REPLACEMENT - and this was a real regression before it was a
      // comment. The widened grep looks for SQL column names, and
      // QueenDelegation.swift carries the same decisions under Swift property
      // names, so switching to the grep silently DROPPED a source that had been
      // read since the guard was written: 8 measurements became 7.
      //
      // Widening a scope must never narrow it somewhere else. The named files
      // stay named, and the search adds to them.
      const NAMED = [
        'trios/agent-server/apps/server/src/api/services/queen-tick.ts',
        'trios/agent-server/queen-core/Sources/QueenPolicy/QueenDelegation.swift',
      ]
      // Dedupe: overlapping pathspecs list the same file twice, and a guard that
      // reports one finding as two is a guard nobody can count with.
      const rels = [...new Set([...NAMED, ...listed])]
      for (const rel of rels) {
        try {
          out.push({ name: rel.split('/').pop(), text: execSync(`git show ${BASE}:${rel}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) })
        } catch { out.push({ name: rel.split('/').pop(), text: null }) }
      }
      return out
    },
  },
]

// A MEASUREMENT, not a mention. `select reviewed_at` is fine; subtracting it
// from now() is the defect.
const MEASURES = [
  /now\(\)\s*-[^;]{0,80}?\b([a-zA-Z_]+_at|updatedAt|createdAt)\b/g,
  /Date\.now\(\)\s*-[^;]{0,80}?\b([a-zA-Z_]+_at|updatedAt|createdAt)\b/g,
  /timeIntervalSince\(\s*[a-zA-Z.]*\.?\b(updatedAt|createdAt|[a-zA-Z_]+_at)\b/g,
]

export function clocks() {
  const found = []
  for (const src of SOURCES) {
    for (const f of src.files()) {
      if (f.text === null) { found.push({ group: src.label, file: f.name, state: 'UNREADABLE', why: 'could not be read - not the same as clean' }); continue }
      f.text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|--|#)/.test(line)) return
        for (const re of MEASURES) {
          re.lastIndex = 0
          let m
          while ((m = re.exec(line))) {
            const field = m[1]
            const spec = FIELDS[field]
            found.push({
              group: src.label,
              file: f.name,
              line: i + 1,
              field,
              state: !spec ? 'unknown' : spec.safe ? 'immutable' : 'REWRITTEN',
              why: spec ? spec.why : 'not in the measured list - classify it before trusting it',
              text: line.trim().slice(0, 70),
            })
          }
        }
      })
    }
  }
  return found
}

if (isMain) {
  const rows = clocks()
  const bad = rows.filter((r) => r.state === 'REWRITTEN' || r.state === 'unknown' || r.state === 'UNREADABLE')

  console.log('clocks a decision is keyed on, and whether anything rewrites them\n')
  let group = ''
  for (const r of rows) {
    if (r.group !== group) { group = r.group; console.log(`  ${group}`) }
    const mark = { immutable: 'ok  ', REWRITTEN: '!!  ', unknown: '??  ', UNREADABLE: '??  ' }[r.state]
    console.log(`    ${mark}${String(r.file).padEnd(24)} ${r.line ? String(r.line).padStart(4) : '   -'}  ${String(r.field || '').padEnd(14)} ${r.why}`)
    if (r.text) console.log(`         ${r.text}`)
  }
  console.log(`\n${rows.length} measurement(s): ${rows.filter((r) => r.state === 'immutable').length} on immutable fields, ${bad.length} to look at`)
  if (bad.length) console.log('\nA clock a decision depends on must be one nothing else touches.')
  process.exit(bad.length ? 1 : 0)
}
