#!/usr/bin/env node
// Fields a decision reads that its query may never have selected.
//
// THE DEFECT THIS GENERALISES. Wiring a retry ceiling to `row.send_backs` while
// the in-flight query selected neither `send_backs` nor `reviewed_at` meant the
// ceiling read 0 for every row, `0 < 2` always held, and the bound did nothing -
// while reporting success. It was caught by reading the SELECT, not by any test,
// because `undefined ?? 0` is a perfectly good number and every assertion about
// it passes.
//
// THE WIDENING THIS FILE IS. The guard read one file - the deployed
// queen-tick.ts - and reported `2 query regions, 2 complete` every round while
// sixteen files under apps/server/src wrote SQL. Widening it was tried once and
// reverted the same hour, because the method was LINE MATCHING and on the wider
// corpus it accused working code four separate ways:
//
//   1. SQL declared as a named constant at the top of a file and consumed a
//      hundred lines below - the reads landed in whichever region they fell in.
//   2. Quoted identifiers: `) as "messageCount"` yielded no column at all.
//   3. A subquery in the select list, whose own SELECT read as a region start
//      and truncated the outer column list.
//   4. Paren depth tracked across the surrounding JavaScript, not inside the SQL.
//
// The boundary now comes from the literal, not the line. `sqlLiteralRegions`
// finds every string literal in the source that carries a SQL SELECT; the SQL is
// parsed inside the literal only (4), a subquery stays inside the outer
// statement's parens (3), aliases are read quoted or bare (2), and reads are
// attributed through the variable the query call's result was bound to - so a
// named constant is followed to its consumption rather than to whichever line
// follows it (1).
//
// WHAT IT JUDGES, AND WHAT IT REFUSES. A region is a query whose rows reach an
// iteration or a single-row binding spelled `row` - the shape the original guard
// judged and the shape the defect shipped in. Everything else a query's rows can
// do - read as `r`, read by index, handed to a mapper, aliased - is reported as
// a read outside the judgement, with the reason, NEVER as a missing field: an
// audit that quietly passes what it cannot resolve wastes an opportunity, and an
// audit that ACCUSES what it cannot resolve spends somebody's afternoon, and the
// second is worse.
//
// Usage:
//   node fields.mjs                 # every SQL-bearing file under apps/server/src
//   node fields.mjs <file.ts>       # one file
//
// This tool reads. It does not write, to anything, ever.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(DIR, '..', '..', '..')
const SERVER_SRC = path.join(REPO_ROOT, 'trios', 'agent-server', 'apps', 'server', 'src')
const isMain = process.argv[1] && process.argv[1].endsWith('/fields.mjs')

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ------------------------------------------------------------- the JS scanner
// One pass over the source that knows where the code is: which characters are
// JavaScript and which are carried payload - string literals, comments, regexes.
// Every later step asks this mask rather than re-guessing, because a
// `row.finished_at` inside a doc comment and a `.query(` inside a prose string
// are the two ways a text tool accuses code that is fine. Inside a template
// literal the `${...}` expressions ARE code, and are marked so: a read buried in
// a log line (`#${row.issue}`) is still a read.
function scanSource(text) {
  const n = text.length
  const literals = [] // { start, end, quote, interpolated, holes, unterminated }
  const skips = [] // comments and regexes - never code
  const code = new Array(n).fill(true)
  let lastCode = null
  let i = 0

  const isWord = (c) => /[A-Za-z0-9_$]/.test(c)

  while (i < n) {
    const c = text[i]
    // Comments are checked first: `//` is a comment wherever it appears, and a
    // lone `/` is only ever division when an operand precedes it.
    if (c === '/' && text[i + 1] === '/') {
      const s = i
      while (i < n && text[i] !== '\n') i++
      skips.push([s, i])
      lastCode = null // a new line starts fresh; `1 // c` then `/re/` is a regex
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const s = i
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      skips.push([s, i])
      continue
    }
    if (c === "'" || c === '"') {
      const r = readQuoted(text, i, c)
      literals.push(r)
      i = r.end
      lastCode = c
      continue
    }
    if (c === '`') {
      const r = readTemplate(text, i)
      literals.push(r)
      i = r.end
      lastCode = c
      continue
    }
    if (c === '/') {
      // A lone slash: a regex when nothing precedes it that an operator could
      // follow - the classic lexer rule, written out because a regex containing
      // `//` reads as a comment to anything simpler.
      const operandBefore = lastCode !== null && (isWord(lastCode) || ')]}\'"`'.includes(lastCode))
      if (operandBefore) { lastCode = c; i++; continue }
      const s = i
      i = readRegex(text, i)
      skips.push([s, i])
      continue
    }
    if (!/\s/.test(c)) lastCode = c
    i++
  }

  for (const [s, e] of skips) for (let k = s; k < e && k < n; k++) code[k] = false
  for (const lit of literals) {
    for (let k = lit.start; k < lit.end && k < n; k++) code[k] = false
    for (const [hs, he] of lit.holes) {
      for (let k = lit.start + hs; k < lit.start + he && k < n; k++) code[k] = true
    }
  }
  return { literals, code }
}

function readQuoted(text, i, q) {
  let j = i + 1
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue }
    if (text[j] === q) return { start: i, end: j + 1, quote: q, interpolated: false, holes: [] }
    // A plain quote cannot cross a newline. Treat that as unterminated rather
    // than swallow the rest of the file looking for a close that never comes.
    if (text[j] === '\n') return { start: i, end: j, quote: q, interpolated: false, holes: [], unterminated: true }
    j++
  }
  return { start: i, end: text.length, quote: q, interpolated: false, holes: [], unterminated: true }
}

function readTemplate(text, i) {
  const holes = [] // ${...} spans, relative to the literal's start
  let j = i + 1
  while (j < text.length) {
    const c = text[j]
    if (c === '\\') { j += 2; continue }
    if (c === '`') return { start: i, end: j + 1, quote: '`', interpolated: holes.length > 0, holes }
    if (c === '$' && text[j + 1] === '{') {
      const close = skipBraced(text, j + 2) // index of the matching `}`
      holes.push([j + 2 - i, close - i])
      j = close + 1
      continue
    }
    j++
  }
  return { start: i, end: text.length, quote: '`', interpolated: holes.length > 0, holes, unterminated: true }
}

/** Index of the `}` that closes a braced expression starting at `k` at depth 1. */
function skipBraced(text, k) {
  let depth = 1
  let j = k
  while (j < text.length && depth > 0) {
    const c = text[j]
    if (c === "'" || c === '"' || c === '`') { j = skipStringAny(text, j, c); continue }
    if (c === '/' && text[j + 1] === '/') { while (j < text.length && text[j] !== '\n') j++; continue }
    if (c === '/' && text[j + 1] === '*') {
      j += 2
      while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++
      j += 2
      continue
    }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return j }
    j++
  }
  return text.length
}

function skipStringAny(text, j, q) {
  j++
  while (j < text.length) {
    if (q === '`' && text[j] === '$' && text[j + 1] === '{') { j = skipBraced(text, j + 2) + 1; continue }
    if (text[j] === '\\') { j += 2; continue }
    if (text[j] === q) return j + 1
    j++
  }
  return text.length
}

function readRegex(text, i) {
  let j = i + 1
  let inClass = false
  while (j < text.length) {
    const c = text[j]
    if (c === '\\') { j += 2; continue }
    if (c === '\n') return j // a regex never spans lines; bail conservatively
    if (inClass) { if (c === ']') inClass = false; j++; continue }
    if (c === '[') { inClass = true; j++; continue }
    if (c === '/') { j++; break }
    j++
  }
  while (j < text.length && /[a-z]/i.test(text[j])) j++ // flags
  return j
}

/** The index just past the bracket that closes the one at `openIdx`, or null. */
function matchEnclosed(text, code, openIdx) {
  const open = text[openIdx]
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : null
  if (!close) return null
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (!code[i]) continue
    if (text[i] === open) depth++
    else if (text[i] === close) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return null
}

// --------------------------------------------------------------- SQL literals

/**
 * Every string literal in `text` that carries a SQL SELECT, with its exact span.
 *
 * A SELECT counts where SQL puts one - at the literal's start, at a line start,
 * or directly inside an opening paren - and never mid-sentence, which is where
 * prose puts the word: `select a working directory from the chat UI` has both a
 * select and a from and is not a query. A FROM is required as well; the one
 * real SELECT in this tree without one (`SELECT changes()`) is a probe in a file
 * that carries other SQL.
 *
 * The span is the boundary everything else uses: the SQL is parsed inside it and
 * the JavaScript around it never enters the parse. That is what fixes the two
 * breakages a line matcher could not - a subquery's SELECT no longer starts a
 * region of its own, and paren depth is counted on SQL alone.
 */
export function sqlLiteralRegions(text) {
  const { literals } = scanSource(text)
  const out = []
  for (const lit of literals) {
    if (lit.unterminated) continue
    const sql = text.slice(lit.start + 1, lit.end - 1)
    if (!/(^|[\n(;])[ \t]*select\b/i.test(sql)) continue
    if (!/\bfrom\b/i.test(sql)) continue
    out.push({
      start: lit.start,
      end: lit.end,
      line: lineOf(text, lit.start),
      sql,
      quote: lit.quote,
      holes: lit.holes,
    })
  }
  return out
}

// --------------------------------------------------------------- the SQL parse
// The same discipline one layer in: inside a SQL literal the non-code is `--`
// comments, block comments, `'...'` strings - and the ${} holes a template
// literal punches in. Depth, clause keywords and commas are counted on SQL code
// only.
function sqlMask(sql, holes) {
  const n = sql.length
  const code = new Array(n).fill(true)
  let i = 0
  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      const s = i
      while (i < n && sql[i] !== '\n') i++
      for (let k = s; k < i; k++) code[k] = false
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const s = i
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      for (let k = s; k < i; k++) code[k] = false
      continue
    }
    if (c === "'") {
      const s = i
      i++
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue } // '' is an escaped quote
          break
        }
        i++
      }
      i = Math.min(n, i + 1)
      for (let k = s; k < i; k++) code[k] = false
      continue
    }
    i++
  }
  for (const [hs, he] of holes || []) for (let k = hs; k < he && k < n; k++) code[k] = false
  return code
}

/** Paren depth before each character, counted on SQL code only. */
function sqlDepths(sql, code) {
  const d = new Array(sql.length + 1).fill(0)
  let cur = 0
  for (let i = 0; i < sql.length; i++) {
    d[i] = cur
    if (!code[i]) continue
    if (sql[i] === '(') cur++
    else if (sql[i] === ')') cur = Math.max(0, cur - 1)
  }
  d[sql.length] = cur
  return d
}

/**
 * Column names a statement hands back, lowercased - or `{ why }` when it cannot
 * be attributed. Write statements (INSERT/UPDATE/DELETE, with or without a WITH
 * in front) are attributed through their RETURNING list, because that is what
 * the reader actually receives; a write with no RETURNING names no rows at all.
 */
function resolveStatement(sql, holes) {
  const code = sqlMask(sql, holes)
  const d = sqlDepths(sql, code)
  const kw = (re) => {
    const out = []
    for (const m of sql.matchAll(re)) {
      if (code[m.index] && d[m.index] === 0) out.push({ word: m[1].toLowerCase(), i: m.index, j: m.index + m[0].length })
    }
    return out
  }

  const verbs = kw(/\b(insert|update|delete|select|returning)\b/gi)
  if (!verbs.length) return { cols: null, why: 'no SQL statement this parser recognises' }

  const writes = verbs.filter((v) => ['insert', 'update', 'delete'].includes(v.word))
  if (writes.length) {
    const ret = verbs.find((v) => v.word === 'returning')
    if (!ret) return { cols: null, why: 'a write statement; it names no returned rows' }
    return listColumns(sql, code, d, ret.j, sql.length, holes, 'RETURNING')
  }

  // The LAST select at depth zero is the one that shapes the result: a WITH
  // query's final SELECT, never the ones inside its parens.
  const selects = verbs.filter((v) => v.word === 'select')
  const sel = selects[selects.length - 1]
  const clauses = kw(/\b(from|where|group\s+by|having|order\s+by|limit|offset|fetch|union|intersect|except|into|window)\b/gi)
  const stop = clauses.find((c) => c.i >= sel.j)
  return listColumns(sql, code, d, sel.j, stop ? stop.i : sql.length, holes, 'select list')
}

function listColumns(sql, code, d, listStart, listEnd, holes, what) {
  // An interpolation inside the list itself makes the columns unknowable; one
  // later in the statement (a WHERE or FROM built by template) does not.
  for (const [hs, he] of holes || []) {
    if (hs < listEnd && he > listStart) return { cols: null, why: `the ${what} is built by interpolation` }
  }
  // A star names everything and therefore nothing: `count(*)` is fine (its star
  // sits inside parens), `SELECT *` and `RETURNING t.*` are not attributable.
  let prevCode = null
  for (let k = listStart; k < listEnd; k++) {
    if (!code[k]) continue
    if (sql[k] === '*' && (prevCode === null || prevCode === ',' || prevCode === '.')) {
      return { cols: null, why: `the ${what} selects *` }
    }
    prevCode = sql[k]
  }
  // Commas at depth zero, on code, split the list.
  const pieces = []
  let pieceStart = listStart
  for (let k = listStart; k <= listEnd; k++) {
    const atEnd = k === listEnd
    const isSplit = !atEnd && code[k] && sql[k] === ',' && d[k] === 0
    if (atEnd || isSplit) {
      pieces.push(sql.slice(pieceStart, k))
      pieceStart = k + 1
    }
  }

  const cols = new Set()
  for (const piece of pieces) {
    const t = piece.trim()
    if (!t) continue
    // QUOTED IDENTIFIERS ARE IDENTIFIERS: Postgres spells a camelCase column
    // `"messageCount"`, and matching only the bare form made `... as
    // "messageCount"` yield no column at all - one of the four false
    // accusations that got the first widening reverted.
    const alias = t.match(/\bas\s+"?([A-Za-z_][\w$]*)"?\s*$/i)
    if (alias) { cols.add(alias[1].toLowerCase()); continue }
    const plain = t.match(/(?<!::)"?([A-Za-z_][\w$]*)"?\s*$/)
    if (plain) cols.add(plain[1].toLowerCase())
  }
  return { cols, why: null }
}

/**
 * Column names the OUTER select names, lowercased - kept as an export because
 * it is the auditable unit the first version of this tool was built around.
 * Null means the statement cannot be attributed, which is never clean.
 */
export function selectedColumns(sql) {
  return resolveStatement(sql, []).cols
}

// --------------------------------------------------------- reads and bindings

/** Every `row.X` (and `row?.X`) read in code, comments and strings excluded. */
function rowReads(text, code) {
  const out = []
  for (const m of text.matchAll(/\brow\s*(?:\?\.|\.)\s*([A-Za-z_]\w*)/g)) {
    if (code[m.index]) out.push({ i: m.index, field: m[1].toLowerCase(), line: lineOf(text, m.index) })
  }
  return out
}

function countElemReads(text, code, elem, start, end) {
  let n = 0
  const re = new RegExp('\\b' + esc(elem) + '\\s*(?:\\?\\.|\\.)\\s*([A-Za-z_]\\w*)', 'g')
  for (const m of text.matchAll(re)) {
    if (m.index >= start && m.index < end && code[m.index]) n++
  }
  return n
}

/** The name a callback's first parameter binds, or null when there is none. */
function firstParam(text, code, openIdx) {
  let j = openIdx + 1
  const ws = () => { while (j < text.length && /\s/.test(text[j])) j++ }
  ws()
  if (/^async\b/.test(text.slice(j))) j += 5
  ws()
  if (text[j] === '(') { j++; ws() }
  const m = /^([A-Za-z_$][\w$]*)/.exec(text.slice(j))
  if (!m) return null
  const after = j + m[1].length
  const rest = text.slice(after).match(/^\s*(?:=>|[,)])/)
  if (!rest) return null
  return m[1]
}

/**
 * The whole audit for one file: regions (query + bound `row.X` reads, judged),
 * notes (every other read shape, refused with a reason - never accused), and the
 * count of SELECT literals found.
 */
export function auditFile(text) {
  const { literals, code } = scanSource(text)
  const sqlLits = sqlLiteralRegions(text)

  // Named SQL constants: `const ESCALATIONS_SQL = `...`` - the literal is
  // declared far from where it is consumed, which is breakage 1.
  const constOf = new Map()
  for (const lit of literals) {
    const before = text.slice(Math.max(0, lit.start - 300), lit.start)
    let head = null
    for (const m of before.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=]{0,80})?\s*=\s*$/g)) head = m
    if (head) constOf.set(head[1], lit)
  }

  // Query calls. `c.req.query('x')` reads a URL parameter, not a table, and is
  // excluded by receiver name; `.query<Row>(` carries a type argument.
  const litAt = new Map()
  for (const lit of literals) if (!litAt.has(lit.start)) litAt.set(lit.start, lit)
  const calls = []
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*(query|prepare)\s*(?:<[^()<]*>)?\s*\(/g)) {
    if (!code[m.index]) continue
    if (m[1] === 'req' || m[1] === 'request') continue
    let p = m.index + m[0].length
    // The literal may sit behind a comment block - the in-flight query carries
    // six lines of them between the call and its SQL, and those comments quote
    // field names in backticks. A quote OPENS the argument only when it is not
    // already inside a comment, so whole comment runs are skipped at once.
    while (p < text.length) {
      if (/\s/.test(text[p])) { p++; continue }
      if (/['"`]/.test(text[p])) break // the argument is a literal, starting here
      if (!code[p]) { while (p < text.length && !code[p]) p++; continue }
      break // real code: an identifier or an expression
    }
    const lit = litAt.get(p)
    let arg = { kind: 'expr' }
    if (lit) arg = { kind: 'literal', lit }
    else {
      const id = /^([A-Za-z_$][\w$]*)/.exec(text.slice(p, p + 80))
      if (id) arg = constOf.has(id[1]) ? { kind: 'const', name: id[1], lit: constOf.get(id[1]) } : { kind: 'unresolved', name: id[1] }
    }
    calls.push({ i: m.index, line: lineOf(text, m.index), arg })
  }

  // Bind query results to the variables that hold them. A binding accepts an
  // empty gap or a single wrapper call - `withDbRetry(() =>` - the house shape
  // for retries; a ternary or a concatenation binds nothing, and its reads fall
  // to the notes where they are refused rather than guessed at.
  const bindings = new Map() // var -> [{ at, lit, constName, line }]
  const bind = (name, call, at) => {
    const entry = {
      at,
      lit: call.arg.kind === 'unresolved' ? null : call.arg.lit || null,
      constName: call.arg.kind === 'const' ? call.arg.name : null,
      line: call.line,
    }
    if (!bindings.has(name)) bindings.set(name, [])
    bindings.get(name).push(entry)
  }
  const heads = [...text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?/g)]
  for (const call of calls) {
    let best = null
    for (const h of heads) {
      const hEnd = h.index + h[0].length
      if (hEnd > call.i || call.i - hEnd > 120) continue
      if (!/^(?:[A-Za-z_$][\w$.]*\s*\(\s*(?:async\s+)?\(\s*\)\s*=>\s*)?(?:[A-Za-z_$][\w$]*\s*\.\s*)*$/.test(text.slice(hEnd, call.i))) continue
      if (!best || h.index > best.index) best = h
    }
    if (best) bind(best[1], call, best.index)
  }
  // `const [a, b] = await Promise.all([ ...query..., ...query... ])` binds
  // positionally: the reads land on the variable, so the variable must land on
  // the query. Comments between elements are skipped by the depth-aware split,
  // which runs inside the array's own brackets.
  for (const m of text.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=\s*(?:await\s+)?Promise\.all\s*\(/g)) {
    if (!code[m.index]) continue
    const open = m.index + m[0].length - 1
    const close = matchEnclosed(text, code, open)
    if (!close) continue
    const names = m[1].split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s))
    // the array literal the promise was given: from its `[` to its `]`
    let arrOpen = -1
    for (let k = open + 1; k < close - 1; k++) {
      if (code[k] && text[k] === '[') { arrOpen = k; break }
      if (code[k] && !/\s/.test(text[k])) break
    }
    if (arrOpen < 0) continue
    const arrClose = matchEnclosed(text, code, arrOpen)
    if (!arrClose) continue
    const elements = []
    let segStart = arrOpen + 1
    let depth = 0
    for (let k = arrOpen + 1; k < arrClose - 1; k++) {
      if (!code[k]) continue
      if (text[k] === '(' || text[k] === '[' || text[k] === '{') depth++
      else if (text[k] === ')' || text[k] === ']' || text[k] === '}') depth--
      else if (text[k] === ',' && depth === 0) { elements.push([segStart, k]); segStart = k + 1 }
    }
    elements.push([segStart, arrClose - 1])
    elements.forEach((el, k) => {
      const inside = calls.find((c) => c.i >= el[0] && c.i < el[1])
      if (inside && names[k]) bind(names[k], inside, m.index)
    })
  }
  // The binding in force at a position: variables named `result` are reused
  // across functions, and the latest binding before the read is the right one.
  const bindingFor = (name, at) => {
    const list = bindings.get(name)
    if (!list) return null
    let best = null
    for (const b of list) if (b.at <= at && (!best || b.at > best.at)) best = b
    return best
  }

  // Constructs: the shapes through which rows are read.
  const constructs = []
  const coveredRowsStarts = new Set() // where a `V.rows` is already accounted for
  const METHOD = 'map|forEach|filter|flatMap|some|every|find|findLast|reduce|sort'
  // `V.rows.map((row) => ...)`
  for (const m of text.matchAll(new RegExp('\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*rows\\s*\\.\\s*(' + METHOD + ')\\s*\\(', 'g'))) {
    if (!code[m.index]) continue
    const open = m.index + m[0].length - 1
    constructs.push({
      kind: 'iterate', varName: m[1], elem: firstParam(text, code, open),
      start: m.index, end: matchEnclosed(text, code, open) || open + 400, line: lineOf(text, m.index),
    })
    coveredRowsStarts.add(m.index)
  }
  // `V.map((row) => ...)` and `for (const row of V)` - no `.rows` hop, so the
  // variable would have to BE the rows array, which only a helper that returns
  // rows directly produces. A bare name can also be shadowed by a function
  // parameter - kanban's helper takes a `dispatches` of its own - so these are
  // noted, never judged: a wrong attribution is worse than none, whichever
  // direction it errs.
  for (const m of text.matchAll(new RegExp('\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(' + METHOD + ')\\s*\\(', 'g'))) {
    if (!code[m.index]) continue
    if (!bindings.has(m[1])) continue
    const open = m.index + m[0].length - 1
    constructs.push({
      kind: 'iterate', varName: m[1], elem: firstParam(text, code, open), bare: true,
      start: m.index, end: matchEnclosed(text, code, open) || open + 400, line: lineOf(text, m.index),
    })
  }
  // `for (const row of V.rows) { ... }`
  for (const m of text.matchAll(/for\s+(?:await\s+)?\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\.\s*rows\s*\)/g)) {
    if (!code[m.index]) continue
    let j = m.index + m[0].length
    while (j < text.length && /\s/.test(text[j])) j++
    let end
    if (text[j] === '{') end = matchEnclosed(text, code, j) || j + 400
    else {
      end = j
      while (end < text.length && text[end] !== ';') end++
      end = Math.min(text.length, end + 1)
    }
    constructs.push({ kind: 'iterate', varName: m[2], elem: m[1], start: m.index, end, line: lineOf(text, m.index) })
    coveredRowsStarts.add(m.index + m[0].indexOf(m[2]))
  }
  // `for (const row of V)` - bare, same reasoning as the bare map above.
  for (const m of text.matchAll(/for\s+(?:await\s+)?\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g)) {
    if (!code[m.index]) continue
    if (!bindings.has(m[2])) continue
    let j = m.index + m[0].length
    while (j < text.length && /\s/.test(text[j])) j++
    let end
    if (text[j] === '{') end = matchEnclosed(text, code, j) || j + 400
    else {
      end = j
      while (end < text.length && text[end] !== ';') end++
      end = Math.min(text.length, end + 1)
    }
    constructs.push({ kind: 'iterate', varName: m[2], elem: m[1], bare: true, start: m.index, end, line: lineOf(text, m.index) })
  }
  // `const row = V.rows[0]` - a single row bound by name, governing until the
  // name is rebound or the block it was declared in closes. The extent is
  // deliberately small: stopping early leaves a read unjudged, stopping late
  // would put one query's reads under another query's columns - and only one of
  // those mistakes accuses.
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*rows\s*\[/g)) {
    if (!code[m.index]) continue
    const line = lineOf(text, m.index)
    const indent = /^ */.exec(text.slice(text.lastIndexOf('\n', m.index) + 1, m.index + 1))[0].length
    let end = text.length
    const rebind = /(?:const|let|var)\s+row\s*=/.exec(text.slice(m.index + m[0].length))
    if (rebind) end = Math.min(end, m.index + m[0].length + rebind.index)
    // the closing brace of the declaring block: a line at the same indent that
    // is only a brace (and perhaps a comma)
    for (const lm of text.slice(m.index).matchAll(/^.*$/gm)) {
      if (lm.index + m.index <= m.index) continue
      const l = lm[0]
      if (new RegExp('^ {' + indent + '}\\}\\s*[;,)]?\\s*$').test(l) || /^ \}/.test(l)) {
        end = Math.min(end, m.index + lm.index)
        break
      }
      if (lm.index > end) break
    }
    constructs.push({ kind: 'single', varName: m[2], elem: m[1], start: m.index, end, line })
    coveredRowsStarts.add(m.index + m[0].indexOf(m[2]))
  }

  // Attribute every `row.X` read to the innermost construct that carries it.
  // Only constructs whose element is spelled `row` can own a read; one iterated
  // as `r` never shadows a `row` from an outer scope, and a bare-receiver
  // construct owns nothing at all - its reads fall to the unbound notes.
  const reads = rowReads(text, code)
  const unboundReads = []
  for (const r of reads) {
    let owner = null
    for (const c of constructs) {
      if (c.elem !== 'row' || c.bare) continue
      if (r.i < c.start || r.i >= c.end) continue
      if (!owner || c.start > owner.start) owner = c
    }
    if (owner) {
      owner.readSet = owner.readSet || new Set()
      owner.readSet.add(r.field)
    } else {
      unboundReads.push(r)
    }
  }

  // Regions: a bound construct with at least one read. A query whose rows are
  // never read through `row` is not a region - the same rule that kept the
  // registry probe out of the original two.
  const regions = []
  for (const c of constructs) {
    if (c.elem !== 'row') continue
    if (!c.readSet || !c.readSet.size) continue
    const b = bindingFor(c.varName, c.start)
    if (!b) continue
    const region = {
      line: b.line,
      constName: b.constName,
      reads: [...c.readSet],
      state: 'complete',
      cols: undefined,
      missing: [],
      why: null,
    }
    if (!b.lit) {
      region.state = 'undetermined'
      region.why = 'the SQL reaches the query as a variable this audit cannot read'
    } else {
      const sql = text.slice(b.lit.start + 1, b.lit.end - 1)
      const holes = (b.lit.holes || []).map(([s, e]) => [s - 1, e - 1])
      const res = resolveStatement(sql, holes)
      if (!res.cols) {
        region.state = 'undetermined'
        region.why = res.why
      } else {
        region.cols = res.cols.size
        const missing = region.reads.filter((f) => !res.cols.has(f))
        if (missing.length) {
          region.state = 'MISSING'
          region.missing = missing
        }
      }
    }
    regions.push(region)
  }
  regions.sort((a, b) => a.line - b.line)

  // Notes: everything seen and refused. An unjudged read is scope, never a
  // finding - the difference between this and the reverted widening.
  const notes = []
  for (const c of constructs) {
    if (c.elem === 'row' || !c.elem) continue
    const b = bindingFor(c.varName, c.start)
    const n = countElemReads(text, code, c.elem, c.start, c.end)
    if (b) notes.push({ line: c.line, why: `rows of the query at line ${b.line} read as \`${c.elem}\` - ${n} field read(s) outside the row.X model` })
    else notes.push({ line: c.line, why: `rows read as \`${c.elem}\` from a variable no query call produced - ${n} field read(s) unjudged` })
  }
  // `row.X` reads with no construct: parameters of helpers, mostly - the
  // producing query is not visible where the read happens.
  unboundReads.sort((a, b) => a.i - b.i)
  let cluster = []
  const flushCluster = () => {
    if (!cluster.length) return
    notes.push({
      line: cluster[0].line,
      why: `${cluster.length} row read(s) not tied to any query - row is a parameter or a value this audit cannot follow (first: row.${cluster[0].field})`,
    })
    cluster = []
  }
  for (const r of unboundReads) {
    if (cluster.length && r.line - cluster[cluster.length - 1].line > 3) flushCluster()
    cluster.push(r)
  }
  flushCluster()
  // Rows taken by index. `const counts = day.rows[0]` and its kin read a row
  // under another name; a bare `V.rows[0].x` reads one field straight off it.
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*rows\s*\[[^\]\n]*\]/g)) {
    if (!code[m.index]) continue
    const varStart = m.index + m[0].indexOf(m[1])
    if (coveredRowsStarts.has(varStart)) continue
    coveredRowsStarts.add(varStart)
    const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(text.slice(Math.max(0, m.index - 120), m.index))
    const field = /^\s*(\?)?\.\s*([A-Za-z_]\w*)/.exec(text.slice(m.index + m[0].length))
    const b = bindingFor(m[1], m.index)
    const source = b ? `row of the query at line ${b.line}` : 'row'
    if (decl && decl[1] !== 'row') {
      notes.push({ line: lineOf(text, m.index), why: `${source} taken by index and read as \`${decl[1]}\` - outside the row.X model` })
    } else if (field) {
      notes.push({ line: lineOf(text, m.index), why: `${source} read by index: ${m[0]}${field[1] ? '?' : ''}.${field[2]}` })
    } else {
      notes.push({ line: lineOf(text, m.index), why: `${source} taken by index: ${m[0]}` })
    }
  }
  // `V.rows` handed on whole - into a composer, a cast, a return. Not `.length`,
  // which counts rows and reads no field.
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*rows\b/g)) {
    if (!code[m.index]) continue
    if (coveredRowsStarts.has(m.index)) continue
    if (/^\s*\.\s*length\b/.test(text.slice(m.index + m[0].length))) continue
    const b = bindingFor(m[1], m.index)
    if (b) notes.push({ line: lineOf(text, m.index), why: `${m[0]} handed on beyond the query at line ${b.line} - a shape this audit does not model` })
    else notes.push({ line: lineOf(text, m.index), why: `${m[0]} used where no query call produced it - not judged` })
  }
  // A SELECT literal that no query call consumes.
  const consumed = new Set(calls.filter((c) => c.arg.lit).map((c) => c.arg.lit.start))
  const unconsumed = sqlLits.filter((l) => !consumed.has(l.start))
  if (unconsumed.length) {
    notes.push({ line: unconsumed[0].line, why: `${unconsumed.length} SELECT literal(s) not consumed at a query call - their rows, if any, are not judged` })
  }
  notes.sort((a, b) => a.line - b.line)

  return { regions, notes, literals: sqlLits.length }
}

/**
 * The judged regions of a file: each a query and the `row.X` reads bound to it,
 * `complete`, `MISSING` (with the fields), or `undetermined` (with the reason).
 * Reads this audit refuses are NOT here - they are notes in `auditFile`, and a
 * refusal is not a finding.
 */
export function audit(text) {
  return auditFile(text).regions
}

// ------------------------------------------------------------------- the CLI

function printFile(label, text) {
  const r = auditFile(text)
  console.log(`${label}  (${r.literals} SELECT literal(s))`)
  for (const reg of r.regions) {
    const mark = { complete: 'ok  ', MISSING: '!!  ', undetermined: '??  ' }[reg.state]
    console.log(
      `  ${mark}SELECT at line ${String(reg.line).padStart(4)}${reg.constName ? `  (${reg.constName})` : ''}` +
        `  ${String(reg.reads.length).padStart(2)} field(s) read` +
        (reg.cols !== undefined ? `, ${reg.cols} selected` : '') +
        (reg.state === 'MISSING' ? `  -  NOT SELECTED: ${reg.missing.join(', ')}` : '') +
        (reg.why ? `  -  ${reg.why}` : ''),
    )
  }
  if (r.notes.length) {
    console.log(`  ..  ${r.notes.length} read(s) outside this audit's judgement - scope, never findings:`)
    for (const nt of r.notes) console.log(`        line ${String(nt.line).padStart(4)}  ${nt.why}`)
  }
  const bad = r.regions.filter((x) => x.state !== 'complete').length
  if (!r.regions.length && !r.notes.length) {
    console.log('  -> 0 region(s): the SQL here is written, not read back through rows this audit can bind')
  } else {
    console.log(`  -> ${r.regions.length} region(s): ${r.regions.length - bad} complete, ${bad} to look at`)
  }
  return { regions: r.regions.length, bad, notes: r.notes.length }
}

if (isMain) {
  const arg = process.argv[2]
  if (arg) {
    const text = fs.readFileSync(arg, 'utf8')
    console.log(`fields read against fields selected - ${arg}\n`)
    const { regions, bad } = printFile(arg, text)
    console.log(`\n${regions} query region(s): ${regions - bad} complete, ${bad} to look at`)
    if (bad.length) {
      console.log('\nA field the query never selected arrives as undefined, and `undefined ?? 0`')
      console.log('is a perfectly good number that every assertion about it will pass.')
    }
    process.exit(bad ? 1 : 0)
  }

  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mts)$/.test(e.name)) files.push(p)
    }
  }
  walk(SERVER_SRC)

  const pairs = []
  for (const f of files) {
    try {
      pairs.push([path.relative(REPO_ROOT, f), fs.readFileSync(f, 'utf8')])
    } catch {
      pairs.push([path.relative(REPO_ROOT, f), null]) // unreadable is not clean
    }
  }

  console.log(`fields read against fields selected - every SQL-bearing file under ${path.relative(REPO_ROOT, SERVER_SRC)}\n`)
  let totalRegions = 0
  let totalBad = 0
  let totalNotes = 0
  let withSql = 0
  let unreadable = 0
  for (const [rel, text] of pairs) {
    if (text === null) {
      console.log(`${rel}`)
      console.log('  ??  could not be read - unreadable is not clean')
      console.log('  -> 0 region(s): 0 complete, 1 to look at')
      unreadable++
      totalBad++
      continue
    }
    const r = auditFile(text)
    if (!r.literals) continue // prose files mention "select"; they write no SQL
    withSql++
    const counts = printFile(rel, text)
    totalRegions += counts.regions
    totalBad += counts.bad
    totalNotes += counts.notes
    console.log('')
  }
  console.log(`${withSql + unreadable} file(s) bearing SQL, ${totalRegions} query region(s): ${totalRegions - totalBad} complete, ${totalBad} to look at`)
  console.log(`${totalNotes} read(s) outside this audit's judgement, listed per file above - scope, never findings`)
  if (totalBad) {
    console.log('\nA field the query never selected arrives as undefined, and `undefined ?? 0`')
    console.log('is a perfectly good number that every assertion about it will pass.')
  }
  process.exit(totalBad ? 1 : 0)
}
