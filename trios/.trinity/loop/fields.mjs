#!/usr/bin/env node
// Fields a decision reads that its query may never have selected.
//
// THE DEFECT THIS GENERALISES. Wiring a retry ceiling to `row.send_backs` while
// the in-flight query selected neither `send_backs` nor `reviewed_at` meant the
// ceiling read 0 for every row, `0 < 2` always held, and the bound did nothing -
// while reporting success. It was caught by reading the SELECT, not by any
// test, because `undefined ?? 0` is a perfectly good number and every assertion
// about it passes.
//
// This is a different class from the clock defect. There the field existed and
// was rewritten; here the field never arrives at all, and the language hands
// you a plausible default instead of an error.
//
// THE METHOD, AND ITS LIMIT. For each SELECT, take the columns it names; for the
// code between that SELECT and the next one, take every `row.X`. A read whose
// column is not in the SELECT is reported. This is a heuristic over text: a
// query built by concatenation, a row passed to another function, or a `*`
// select cannot be resolved, and each is reported as `undetermined` rather than
// clean - because an audit that quietly passes what it cannot resolve is the
// shape of the defect it hunts.
//
// Usage:
//   node fields.mjs                 # the deployed tick
//   node fields.mjs <file.ts>       # any file

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const BASE = process.env.FIELDS_BASE || 'origin/feat/queen-supervisor'
const DEFAULT = 'trios/agent-server/apps/server/src/api/services/queen-tick.ts'
const isMain = process.argv[1] && process.argv[1].endsWith('/fields.mjs')

/**
 * Column names the OUTER select names, lowercased.
 *
 * Comma-splitting and a non-greedy `SELECT ... FROM` both break on a subquery:
 * the inner `FROM` ends the match early and the inner commas split the pieces
 * wrongly, so `(SELECT ...) AS said` was reported as an unselected field the
 * query in fact provides. Depth tracking is the only honest reading - the outer
 * FROM is the one at paren depth zero.
 */
export function selectedColumns(sql) {
  const i = sql.search(/\bSELECT\b/i)
  if (i < 0) return null
  let depth = 0
  let end = -1
  for (let k = i + 6; k < sql.length; k++) {
    const c = sql[k]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && /\s/.test(c) && /^\s*FROM\b/i.test(sql.slice(k))) { end = k; break }
  }
  if (end < 0) return null
  const body = sql.slice(i + 6, end)
  if (/(^|[\s,])\*/.test(body)) return null // cannot resolve, and must not read as clean

  // Split on commas at depth zero only.
  const pieces = []
  let cur = ''
  let d = 0
  for (const c of body) {
    if (c === '(') d++
    else if (c === ')') d--
    if (c === ',' && d === 0) { pieces.push(cur); cur = '' } else cur += c
  }
  pieces.push(cur)

  const cols = new Set()
  for (const piece of pieces) {
    const alias = piece.match(/\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*$/i)
    if (alias) { cols.add(alias[1].toLowerCase()); continue }
    const plain = piece.trim().match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/)
    if (plain) cols.add(plain[1].toLowerCase())
  }
  return cols
}

export function audit(text) {
  const lines = text.split('\n')
  // Find each SELECT and the region it governs: up to the next SELECT.
  const marks = []
  // A SELECT inside parentheses is a SUBQUERY, not a new region. Treating one
  // as a region start made the tool read the OUTER query's `row.X` uses against
  // the INNER query's columns, and it duly accused the review sweep of failing
  // to select six fields it selects perfectly well. Caught before it was
  // reported, which is the whole difference between this and the four false
  // accusations that were not.
  lines.forEach((l, i) => {
    if (!/\bSELECT\b/i.test(l)) return
    if (/^\s*(\/\/|\*)/.test(l)) return
    if (/^\s*\(\s*SELECT\b/i.test(l)) return
    marks.push(i)
  })

  const out = []
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k]
    const end = k + 1 < marks.length ? marks[k + 1] : lines.length
    const region = lines.slice(start, end).join('\n')
    const cols = selectedColumns(region)
    const reads = new Set()
    for (const m of region.matchAll(/\brow\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) reads.add(m[1].toLowerCase())
    if (!reads.size) continue
    if (cols === null) {
      out.push({ line: start + 1, state: 'undetermined', why: 'the SELECT uses * or could not be parsed', reads: [...reads] })
      continue
    }
    const missing = [...reads].filter((r) => !cols.has(r))
    out.push({
      line: start + 1,
      state: missing.length ? 'MISSING' : 'complete',
      cols: cols.size,
      reads: [...reads],
      missing,
    })
  }
  return out
}

if (isMain) {
  const arg = process.argv[2]
  let text
  let label
  if (arg) { text = fs.readFileSync(arg, 'utf8'); label = arg }
  else {
    text = execSync(`git show ${BASE}:${DEFAULT}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    label = `${BASE}:${DEFAULT}`
  }

  const rows = audit(text)
  console.log(`fields read against fields selected - ${label}\n`)
  for (const r of rows) {
    const mark = { complete: 'ok  ', MISSING: '!!  ', undetermined: '??  ' }[r.state]
    console.log(`  ${mark}SELECT at line ${String(r.line).padStart(4)}  ${String(r.reads.length).padStart(2)} field(s) read` +
      (r.cols !== undefined ? `, ${r.cols} selected` : '') +
      (r.state === 'MISSING' ? `  -  NOT SELECTED: ${r.missing.join(', ')}` : '') +
      (r.why ? `  -  ${r.why}` : ''))
  }
  const bad = rows.filter((r) => r.state !== 'complete')
  console.log(`\n${rows.length} query region(s): ${rows.length - bad.length} complete, ${bad.length} to look at`)
  if (bad.length) {
    console.log('\nA field the query never selected arrives as undefined, and `undefined ?? 0`')
    console.log('is a perfectly good number that every assertion about it will pass.')
  }
  process.exit(bad.length ? 1 : 0)
}
