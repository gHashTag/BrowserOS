#!/usr/bin/env node
/**
 * A read-only survey of trios/agent-server/apps/server/src/api/routes/queen-kanban.ts.
 *
 * The file carries the Queen's kanban board route and everything it needs. It is
 * over the repository's own 400-line guidance, and nothing has ever said what is
 * inside it. This tool enumerates it: every top-level declaration with its line
 * range, what else in the file it references, which declarations are therefore
 * independently extractable, and which single extraction would remove the most
 * lines for the least risk.
 *
 * Definitions used by the output, so the numbers can be argued with:
 *
 *   declaration      a top-level import, interface, type, enum, class,
 *                    function or variable statement, found by parsing the
 *                    source text - never from a list written into this tool.
 *   reference        declaration A references declaration B when A's source
 *                    text uses B's name outside a comment, a string or a
 *                    property access. Imports are not references: an import is
 *                    re-declared in a new module, it does not travel.
 *   independently    a declaration whose references are empty. Moving it needs
 *   extractable      nothing else from this file.
 *   group            a connected component of the file's reference graph,
 *                    other than the whole file. Members of a group depend only
 *                    on each other (and on imports), and no declaration left
 *                    behind references them - so moving the group deletes
 *                    lines from this file and adds no import to it.
 *
 * The tool reads and reports. It never writes, never compiles, never builds.
 * It runs under plain node with the Node standard library only. Two runs over
 * the same tree produce identical bytes: no clock, no randomness, stable sorts.
 *
 * Usage: node trios/tools/queen-kanban-split-survey.mjs
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGET_REL = 'trios/agent-server/apps/server/src/api/routes/queen-kanban.ts'
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.cache', 'coverage',
  '.next', 'target', 'Pods', '.venv', '__pycache__', '.worktrees', 'worktrees',
])
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/
const STMT_KEYWORDS = new Set([
  'import', 'export', 'const', 'let', 'var', 'function', 'async', 'class',
  'abstract', 'interface', 'type', 'enum', 'declare', 'namespace', 'module',
])
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
])
const BLOCK_STARTERS = new Set(['if', 'for', 'while', 'switch', 'try', 'do', 'with'])

// ---------------------------------------------------------------------------
// Masking: a same-length copy of the source with comments, string bodies and
// regex bodies blanked. Newlines are preserved so line numbers stay true.
// String and template delimiters are kept so statement boundaries survive.
// ---------------------------------------------------------------------------

function maskSource(text) {
  const n = text.length
  const out = new Array(n)
  // Frame stack. Bottom frame is plain code; strings/templates push frames;
  // a template interpolation ${...} pushes a code frame that ends at its
  // matching brace.
  const frames = [{ kind: 'code', depth: 0 }]
  let lastSig = ''
  let word = ''
  const isId = (c) => /[A-Za-z0-9_$]/.test(c)
  const regexAllowed = () =>
    REGEX_KEYWORDS.has(word) ||
    lastSig === '' ||
    '(,=:[!&|?{};+-*%<>^~'.includes(lastSig)

  const blank = (i) => { out[i] = text[i] === '\n' ? '\n' : ' ' }
  let i = 0
  while (i < n) {
    const f = frames[frames.length - 1]
    const c = text[i]
    const next = i + 1 < n ? text[i + 1] : ''

    if (f.kind === 'sq' || f.kind === 'dq') {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue }
      if (c === '\n') { out[i] = '\n'; frames.pop(); i++; continue } // unterminated: bail out
      if ((f.kind === 'sq' && c === "'") || (f.kind === 'dq' && c === '"')) {
        out[i] = c; frames.pop(); i++; continue
      }
      blank(i); i++; continue
    }

    if (f.kind === 'tpl') {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue }
      if (c === '`') { out[i] = c; frames.pop(); i++; continue }
      if (c === '$' && next === '{') {
        out[i] = '$'; out[i + 1] = '{'
        frames.push({ kind: 'code', depth: 0, tplExpr: true })
        i += 2; continue
      }
      blank(i); i++; continue
    }

    // code frame (top-level or template interpolation)
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') { blank(i); i++ }
      continue
    }
    if (c === '/' && next === '*') {
      blank(i); blank(i + 1); i += 2
      while (i < n) {
        if (text[i] === '*' && i + 1 < n && text[i + 1] === '/') {
          blank(i); blank(i + 1); i += 2; break
        }
        blank(i); i++
      }
      continue
    }
    if (c === '/' && regexAllowed()) {
      // Regex literal: blank the whole literal, delimiters included.
      blank(i); i++
      let inClass = false
      while (i < n) {
        const rc = text[i]
        if (rc === '\\') { blank(i); blank(i + 1); i += 2; continue }
        if (rc === '\n') break // unterminated: stop at the line end
        if (rc === '[') inClass = true
        else if (rc === ']') inClass = false
        blank(i)
        if (rc === '/' && !inClass) { i++; break }
        i++
      }
      lastSig = '/'; word = ''
      continue
    }
    if (c === "'") { out[i] = c; frames.push({ kind: 'sq' }); i++; continue }
    if (c === '"') { out[i] = c; frames.push({ kind: 'dq' }); i++; continue }
    if (c === '`') { out[i] = c; frames.push({ kind: 'tpl' }); i++; continue }

    out[i] = c
    if (/\S/.test(c)) {
      if (f.tplExpr) {
        if (c === '{') f.depth++
        else if (c === '}') {
          if (f.depth === 0) { frames.pop(); lastSig = '}'; word = ''; i++; continue }
          f.depth--
        }
      }
      if (isId(c)) {
        word += c
      } else {
        word = ''
      }
      lastSig = c
    }
    i++
  }
  for (let k = 0; k < n; k++) if (out[k] === undefined) out[k] = ' '
  return out.join('')
}

// ---------------------------------------------------------------------------
// Top-level parsing on the masked text. Original text is only read for the
// contents of string literals (module specifiers).
// ---------------------------------------------------------------------------

function parseTopLevel(masked, original) {
  const n = masked.length
  const isIdStart = (c) => /[A-Za-z_$]/.test(c)
  const isId = (c) => /[A-Za-z0-9_$]/.test(c)

  const skipWs = (p) => { while (p < n && /\s/.test(masked[p])) p++; return p }
  const wordAt = (p) => {
    if (p >= n || !isIdStart(masked[p])) return null
    let q = p
    while (q < n && isId(masked[q])) q++
    return { word: masked.slice(p, q), end: q }
  }
  const completable = (ch) => /[A-Za-z0-9_$)\]}'"`]/.test(ch)
  const nextStartsStatement = (p) => {
    const q = skipWs(p)
    if (q >= n) return true
    if (masked[q] === '@') return true
    const w = wordAt(q)
    return w !== null && STMT_KEYWORDS.has(w.word)
  }
  // Consume a ';' (or ASI) terminated statement body. Returns end offset.
  const consumeToStatementEnd = (p) => {
    let depth = 0
    let lastSig = ''
    let i = p
    while (i < n) {
      const c = masked[i]
      if (c === ';') { if (depth === 0) return i + 1; }
      else if (c === '\n') {
        if (depth === 0 && completable(lastSig) && nextStartsStatement(i + 1)) return i
      } else if ('([{'.includes(c)) { depth++; lastSig = c }
      else if (')]}'.includes(c)) { depth--; lastSig = c }
      else if (/\S/.test(c)) { lastSig = c }
      i++
    }
    return n
  }
  // Consume a balanced {...} block whose '{' is at masked[p]. Returns end offset
  // just past the matching '}'.
  const consumeBlock = (p) => {
    let depth = 0
    let i = p
    while (i < n) {
      const c = masked[i]
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) {
        depth--
        if (depth === 0) return i + 1
      }
      i++
    }
    return n
  }
  const consumeAngle = (p) => {
    let depth = 0
    let i = p
    while (i < n) {
      const c = masked[i]
      if (c === '<') depth++
      else if (c === '>') { depth--; if (depth === 0) return i + 1 }
      else if (c === ';' && depth === 0) return i
      i++
    }
    return n
  }
  // Scan a header (extends/implements/return type) up to a '{' at depth 0.
  const consumeToBodyBrace = (p) => {
    let depth = 0
    let angle = 0
    let i = p
    while (i < n) {
      const c = masked[i]
      if (c === '<') angle++
      else if (c === '>') angle = Math.max(0, angle - 1)
      else if (c === '{' && angle === 0 && depth === 0) return i
      else if (c === ';' && angle === 0 && depth === 0) return i
      else if ('(['.includes(c)) depth++
      else if (')]'.includes(c)) depth--
      i++
    }
    return n
  }
  const optSemi = (p) => {
    const q = skipWs(p)
    if (q < n && masked[q] === ';') return q + 1
    return p
  }
  const stringAt = (p) => {
    const q = skipWs(p)
    if (q < n && (masked[q] === "'" || masked[q] === '"')) {
      const quote = masked[q]
      let r = q + 1
      while (r < n && masked[r] !== quote) r++
      if (r < n) return { start: q, end: r + 1, value: original.slice(q + 1, r) }
    }
    return null
  }

  const items = []
  let pos = 0

  const push = (kind, name, exported, start, end) => {
    items.push({ kind, name, exported, start, end })
  }

  const parseBase = (p, exported) => {
    const w = wordAt(p)
    if (!w) return null
    const start = p
    if (w.word === 'import') return parseImport(p, exported)
    if (w.word === 'const' || w.word === 'let' || w.word === 'var') {
      let q = w.end
      const w2 = wordAt(skipWs(q))
      if (w2 && w2.word === 'enum') {
        const w3 = wordAt(skipWs(w2.end))
        q = consumeBlock(consumeToBodyBrace(skipWs(w3 ? w3.end : w2.end)))
        q = optSemi(q)
        push('enum', w3 ? w3.word : '?', exported, start, q)
        return q
      }
      return parseVariable(p, exported, w.word)
    }
    if (w.word === 'function') return parseFunction(p, exported, false, start)
    if (w.word === 'async') {
      const w2 = wordAt(skipWs(w.end))
      if (w2 && w2.word === 'function') return parseFunction(p, exported, true, start)
      return parseUnparsed(p)
    }
    if (w.word === 'interface') {
      const w2 = wordAt(skipWs(w.end))
      const name = w2 ? w2.word : '?'
      let q = consumeToBodyBrace(skipWs(w2 ? w2.end : w.end))
      if (masked[q] === '{') q = consumeBlock(q)
      q = optSemi(q)
      push('interface', name, exported, start, q)
      return q
    }
    if (w.word === 'type') {
      const w2 = wordAt(skipWs(w.end))
      if (!w2) return parseUnparsed(p)
      let q = w2.end
      const peek = skipWs(q)
      if (masked[peek] === '<') q = consumeAngle(peek)
      const after = skipWs(q)
      if (masked[after] !== '=') return parseUnparsed(p)
      q = consumeToStatementEnd(after + 1)
      push('type', w2.word, exported, start, q)
      return q
    }
    if (w.word === 'enum') {
      const w2 = wordAt(skipWs(w.end))
      let q = consumeToBodyBrace(skipWs(w2 ? w2.end : w.end))
      if (masked[q] === '{') q = consumeBlock(q)
      q = optSemi(q)
      push('enum', w2 ? w2.word : '?', exported, start, q)
      return q
    }
    if (w.word === 'class' || w.word === 'abstract') {
      let q = w.end
      if (w.word === 'abstract') {
        const w2 = wordAt(skipWs(q))
        if (!w2 || w2.word !== 'class') return parseUnparsed(p)
        q = w2.end
      }
      const w2 = wordAt(skipWs(q))
      const name = w2 ? w2.word : '?'
      q = consumeToBodyBrace(skipWs(w2 ? w2.end : q))
      if (masked[q] === '{') q = consumeBlock(q)
      q = optSemi(q)
      push('class', name, exported, start, q)
      return q
    }
    if (w.word === 'namespace' || w.word === 'module') {
      const w2 = wordAt(skipWs(w.end))
      let q = skipWs(w2 ? w2.end : w.end)
      const s = stringAt(q)
      if (s) { q = optSemi(s.end); push('namespace', w2 ? w2.word : original.slice(s.start + 1, s.end - 1), exported, start, q); return q }
      q = consumeToBodyBrace(q)
      if (masked[q] === '{') q = consumeBlock(q)
      q = optSemi(q)
      push('namespace', w2 ? w2.word : '?', exported, start, q)
      return q
    }
    if (w.word === 'declare') {
      const w2 = wordAt(skipWs(w.end))
      if (!w2) return parseUnparsed(p)
      const end = parseFrom(skipWs(w.end), start, exported)
      const item = items[items.length - 1]
      if (item && item.end === end) item.kind = 'declare ' + item.kind
      return end
    }
    return parseUnparsed(p)
  }

  // Parse a declaration whose visible start (an `export` or `declare`
  // prefix) sits before the declaration keyword itself, so the item's span
  // covers the whole statement.
  const parseFrom = (p, itemStart, exported) => {
    const before = items.length
    const end = parseBase(p, exported)
    const item = items[items.length - 1]
    if (items.length > before && item && item.end === end) item.start = itemStart
    return end
  }

  function parseFunction(p, exported, isAsync, start) {
    let q = wordAt(p).end // past 'function' (or 'async' handled by caller offset)
    // re-read: p may point at 'async'
    let head = wordAt(p)
    if (head.word === 'async') q = wordAt(skipWs(head.end)).end
    const nameWord = wordAt(skipWs(q))
    let name = nameWord ? nameWord.word : 'default'
    q = skipWs(nameWord ? nameWord.end : q)
    if (masked[q] === '<') q = consumeAngle(q)
    q = skipWs(q)
    if (masked[q] === '(') q = consumeBlock(q) // parameter list, balanced
    q = skipWs(q)
    if (masked[q] === ':') q = consumeToBodyBrace(skipWs(q + 1)) // return type
    if (masked[q] === '{') q = consumeBlock(q)
    q = optSemi(q)
    push(isAsync ? 'async function' : 'function', name, exported, start, q)
    return q
  }

  function parseVariable(p, exported, kw) {
    let q = wordAt(p).end
    const names = []
    const w = wordAt(skipWs(q))
    if (w) {
      names.push(w.word)
      q = w.end
    } else if (masked[skipWs(q)] === '{' || masked[skipWs(q)] === '[') {
      const open = skipWs(q)
      const close = consumeBlock(open)
      const seg = masked.slice(open, close)
      const ids = (seg.match(/[A-Za-z_$][\w$]*/g) || []).filter(
        (id, idx, arr) => id !== 'as' && arr[idx - 1] !== 'as',
      )
      names.push(...ids)
      q = close
    }
    // optional type annotation, then '=' initializer
    q = skipWs(q)
    if (masked[q] === ':') {
      let i = q + 1
      let depth = 0
      while (i < n) {
        const c = masked[i]
        if (c === '=' && depth === 0 && masked[i + 1] !== '=') break
        if ('([{'.includes(c)) depth++
        else if (')]}'.includes(c)) depth--
        else if (c === '\n' && depth === 0 && completableTail(i)) break
        i++
      }
      q = i
    }
    q = skipWs(q)
    if (masked[q] === '=' && masked[q + 1] !== '=') {
      q = consumeToStatementEnd(q + 1)
    } else {
      q = consumeToStatementEnd(q) // declaration without initializer
    }
    const name = names.length === 1 ? names[0] : '{ ' + names.join(', ') + ' }'
    push('variable (' + kw + ')', name, exported, p, q)
    return q

    function completableTail(at) {
      let j = at - 1
      while (j >= 0 && /\s/.test(masked[j])) j--
      return j >= 0 && completable(masked[j]) && nextStartsStatement(at + 1)
    }
  }

  function parseImport(p, exported) {
    let q = wordAt(p).end
    let specifier = null
    const names = []
    let defaultName = null
    let sawFrom = false
    let lastSig = ''
    while (q < n) {
      const c = masked[q]
      if (c === '\n') {
        if (sawFrom && specifier !== null && completable(lastSig) && nextStartsStatement(q + 1)) break
        lastSig = ''; q++; continue
      }
      if (c === ';') { q++; break }
      if (c === "'" || c === '"') {
        let r = q + 1
        while (r < n && masked[r] !== c) r++
        specifier = original.slice(q + 1, r)
        lastSig = c
        q = r + 1
        continue
      }
      if (c === '{') {
        const close = consumeBlock(q)
        const seg = masked.slice(q + 1, close - 1)
        for (const part of seg.split(',')) {
          const ids = part.match(/[A-Za-z_$][\w$]*/g) || []
          const cleaned = ids.filter((id) => id !== 'as' && id !== 'type')
          if (cleaned.length > 0) names.push(cleaned[cleaned.length - 1])
        }
        lastSig = '}'
        q = close
        continue
      }
      if (c === '*') { lastSig = c; q++; continue }
      if (isIdStart(c)) {
        const w = wordAt(q)
        if (w.word === 'from') sawFrom = true
        else if (!sawFrom && defaultName === null && names.length === 0) defaultName = w.word
        else if (names.length > 0 && names[names.length - 1] === '*' + w.word) { /* skip */ }
        lastSig = w.word[w.word.length - 1]
        q = w.end
        continue
      }
      if (/\S/.test(c)) lastSig = c
      q++
    }
    // '*' as X: the namespace name arrives as the word after '*'
    const bound = [...names]
    if (defaultName) bound.unshift(defaultName)
    push('import', specifier ?? '?', exported, p, q)
    const item = items[items.length - 1]
    item.names = bound
    return q
  }

  function parseUnparsed(p) {
    const w = wordAt(p)
    let q
    if (w && BLOCK_STARTERS.has(w.word)) {
      q = consumeToBodyBrace(w.end)
      if (masked[q] === '{') q = consumeBlock(q)
      q = optSemi(q)
    } else {
      q = consumeToStatementEnd(p)
    }
    push('unparsed', w ? w.word : masked.slice(p, p + 12), false, p, q)
    return q
  }

  while (true) {
    pos = skipWs(pos)
    if (pos >= n) break
    const w = wordAt(pos)
    if (w && w.word === 'export') {
      const after = skipWs(w.end)
      const c = masked[after]
      if (c === '{') {
        const close = consumeBlock(after)
        const s = stringAt(close)
        let q = s ? optSemi(s.end) : optSemi(close)
        push(s ? 're-export' : 'export list', s ? s.value : '(names)', true, pos, q)
        pos = q
        continue
      }
      if (c === '*') {
        let q = consumeToStatementEnd(after)
        push('re-export', '(star)', true, pos, q)
        pos = q
        continue
      }
      const w2 = wordAt(after)
      if (w2 && w2.word === 'default') {
        const after2 = skipWs(w2.end)
        const w3 = wordAt(after2)
        if (w3 && (w3.word === 'function' || w3.word === 'class' || w3.word === 'async')) {
          pos = parseFrom(after2, pos, true)
          const item = items[items.length - 1]
          if (item && item.end === pos) item.name = item.name === '?' ? 'default' : item.name
          continue
        }
        const q = consumeToStatementEnd(after2)
        push('export default', '(expression)', true, pos, q)
        pos = q
        continue
      }
      pos = parseFrom(after, pos, true)
      continue
    }
    if (w) {
      const before = pos
      pos = parseBase(pos, false)
      if (pos <= before) pos = n // safety: always advance
      continue
    }
    pos = n
  }

  // Safety: any non-space, non-newline gap left uncovered becomes unparsed.
  const covered = new Array(n).fill(false)
  for (const it of items) for (let k = it.start; k < it.end; k++) covered[k] = true
  let run = -1
  const flushRun = (end) => {
    if (run >= 0) {
      const seg = masked.slice(run, end)
      if (/\S/.test(seg)) push('unparsed', '(gap)', false, run, end)
    }
    run = -1
  }
  for (let k = 0; k < n; k++) {
    if (!covered[k] && /\S/.test(masked[k])) { if (run < 0) run = k }
    else flushRun(k)
  }
  flushRun(n)

  return items
}

// ---------------------------------------------------------------------------
// References, imports used, groups.
// ---------------------------------------------------------------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function refRegexFor(name) {
  return new RegExp(
    '(?<![\\w$.])' + escapeRegExp(name) + '(?![\\w$])(?!\\s*:)',
    'g',
  )
}

function analyzeReferences(masked, items) {
  const code = items.filter((it) => it.kind !== 'import' && it.kind !== 'unparsed')
  const byName = new Map()
  for (const it of code) if (!byName.has(it.name)) byName.set(it.name, it)
  const refs = new Map()
  const importsUsed = new Map()
  const importItems = items.filter((it) => it.kind === 'import')
  for (const it of code) {
    const seg = masked.slice(it.start, it.end)
    const found = []
    for (const other of code) {
      if (other.name === it.name) continue
      const re = refRegexFor(other.name)
      re.lastIndex = 0
      if (re.test(seg)) found.push(other.name)
    }
    found.sort()
    refs.set(it.name, found)
    const used = []
    for (const imp of importItems) {
      for (const local of imp.names || []) {
        const re = refRegexFor(local)
        re.lastIndex = 0
        if (re.test(seg)) {
          used.push({ local, module: imp.name })
          break
        }
      }
    }
    importsUsed.set(it.name, used)
  }
  return { refs, importsUsed }
}

function componentsOf(items, refs) {
  const code = items.filter((it) => it.kind !== 'import' && it.kind !== 'unparsed')
  const index = new Map(code.map((it, i) => [it.name, i]))
  const parent = code.map((_, i) => i)
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  for (const it of code) {
    for (const ref of refs.get(it.name) || []) {
      if (index.has(ref)) union(index.get(it.name), index.get(ref))
    }
  }
  const groups = new Map()
  for (let i = 0; i < code.length; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(code[i])
  }
  return [...groups.values()].map((members) => ({
    members,
    names: members.map((m) => m.name),
    declLines: members.reduce((s, m) => s + m.len, 0),
    proper: members.length < code.length,
  }))
}

// ---------------------------------------------------------------------------
// External call sites: files outside the target that import it, and which of
// the moved names they use.
// ---------------------------------------------------------------------------

function findCallSites(files, targetRel, movedNames, targetAbs, selfAbs) {
  const specRe = /(?:^|[;\n])[ \t]*(?:import|export)\b[\s\S]{0,800}?from[ \t]*['"]([^'"]+)['"]/g
  const sideEffectRe = /(?:^|[;\n])[ \t]*import[ \t]*['"]([^'"]+)['"]/g
  const pathRe = /queen-kanban(?:\.ts)?/g
  const movedSet = new Set(movedNames)
  const skip = new Set([resolve(targetAbs), resolve(selfAbs ?? '')].filter(Boolean))
  const sites = []
  const untouched = []
  const pathRefs = []
  for (const file of files) {
    if (skip.has(resolve(file.abs ?? file.path))) continue
    const { path, text } = file
    const matches = []
    let m
    specRe.lastIndex = 0
    while ((m = specRe.exec(text)) !== null) {
      if (/(^|\/)queen-kanban(\.ts)?$/.test(m[1])) {
        let s = m.index
        if (text[s] === ';' || text[s] === '\n') s++
        while (s < text.length && /[ \t]/.test(text[s])) s++
        matches.push({ start: s, end: m.index + m[0].length, spec: m[1] })
      }
    }
    sideEffectRe.lastIndex = 0
    while ((m = sideEffectRe.exec(text)) !== null) {
      if (/(^|\/)queen-kanban(\.ts)?$/.test(m[1])) {
        let s = m.index
        if (text[s] === ';' || text[s] === '\n') s++
        while (s < text.length && /[ \t]/.test(text[s])) s++
        matches.push({ start: s, end: m.index + m[0].length, spec: m[1] })
      }
    }
    if (matches.length === 0) {
      pathRe.lastIndex = 0
      while ((m = pathRe.exec(text)) !== null) pathRefs.push({ path, offset: m.index })
      continue
    }
    // Usage lines for moved names, outside the import statements themselves.
    let masked = text
    try { masked = maskSource(text) } catch { /* fall back to raw text */ }
    for (const match of matches) {
      const clause = text.slice(match.start, match.end).replace(/'[^']*'|"[^"]*"/g, ' ')
      const ids = new Set(clause.match(/[A-Za-z_$][\w$]*/g) || [])
      const importedMoved = [...ids].filter((id) => movedSet.has(id)).sort()
      const importedStays = [...ids].filter(
        (id) => !movedSet.has(id) && id !== 'import' && id !== 'export' && id !== 'from' && id !== 'type' && id !== 'as',
      ).sort()
      const importLine = text.slice(0, match.start).split('\n').length
      const importEndLine = importLine + clause.split('\n').length - 1
      const usageLines = []
      for (const name of importedMoved) {
        const re = new RegExp('(?<![\\w$.])' + escapeRegExp(name) + '(?![\\w$])', 'g')
        let um
        while ((um = re.exec(masked)) !== null) {
          const line = masked.slice(0, um.index).split('\n').length
          if (line < importLine || line > importEndLine) usageLines.push(line)
        }
      }
      const entry = {
        path,
        spec: match.spec,
        importLine,
        importEndLine,
        importedMoved,
        importedStays,
        usageLines: [...new Set(usageLines)].sort((a, b) => a - b),
      }
      if (importedMoved.length > 0) sites.push(entry)
      else untouched.push(entry)
    }
    pathRe.lastIndex = 0
    while ((m = pathRe.exec(text)) !== null) {
      const line = text.slice(0, m.index).split('\n').length
      const inImport = matches.some((k) => {
        const s = text.slice(0, k.start).split('\n').length
        return line >= s && line <= s + text.slice(k.start, k.end).split('\n').length - 1
      })
      if (!inImport) pathRefs.push({ path, offset: m.index })
    }
  }
  const withLines = (r) => ({ path: r.path, line: text2Line(files, r) })
  function text2Line(all, r) {
    const f = all.find((x) => x.path === r.path)
    return f.text.slice(0, r.offset).split('\n').length
  }
  sites.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.importLine - b.importLine))
  untouched.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.importLine - b.importLine))
  const seen = new Set()
  const pathRefsDedup = []
  for (const r of pathRefs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.offset - b.offset))) {
    const key = r.path + ':' + r.offset
    if (seen.has(key)) continue
    seen.add(key)
    pathRefsDedup.push(withLines(r))
  }
  return { sites, untouched, pathRefs: pathRefsDedup }
}

// ---------------------------------------------------------------------------
// The survey itself. Pure: source text in, survey object out. Call-site
// analysis needs other files; pass them in options.externalFiles as
// [{ path, text }] (the CLI walks the tree; tests may pass a fixed list).
// ---------------------------------------------------------------------------

export function splitQueenKanban(sourceText, options = {}) {
  const fileName = options.fileName ?? TARGET_REL
  const externalFiles = options.externalFiles ?? null
  const lines = sourceText.split('\n')
  const fileLines = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length

  const masked = maskSource(sourceText)
  const rawItems = parseTopLevel(masked, sourceText)

  const lineStarts = [0]
  for (let i = 0; i < sourceText.length; i++) {
    if (sourceText[i] === '\n') lineStarts.push(i + 1)
  }
  const lineAt = (offset) => {
    let lo = 0, hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  const items = rawItems.map((it) => ({
    ...it,
    startLine: lineAt(it.start),
    endLine: lineAt(it.end - 1 >= it.start ? it.end - 1 : it.start),
  }))
  for (const it of items) it.len = it.endLine - it.startLine + 1

  // Attached comments: contiguous comment-only lines directly above, no blank
  // line in between. They travel with an extraction in practice.
  const lineText = (ln) => (ln >= 1 && ln <= fileLines ? sourceText.slice(lineStarts[ln - 1], ln < lineStarts.length ? lineStarts[ln] - 1 : sourceText.length).replace(/\n$/, '') : '')
  const isCommentLine = (ln) => {
    const t = lineText(ln).trim()
    return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')
  }
  for (const it of items) {
    let attached = 0
    let above = it.startLine - 1
    while (above >= 1 && isCommentLine(above)) { attached++; above-- }
    it.attached = attached
  }

  const declarations = items.filter((it) => it.kind !== 'import' && it.kind !== 'unparsed')
  const imports = items.filter((it) => it.kind === 'import')
  const unparsed = items.filter((it) => it.kind === 'unparsed')

  const { refs, importsUsed } = analyzeReferences(masked, items)
  for (const it of declarations) {
    it.refs = refs.get(it.name) || []
    it.importsUsed = importsUsed.get(it.name) || []
  }

  // Line accounting: every line of the file lands in exactly one bucket.
  const covered = new Array(fileLines + 1).fill(false)
  const bucket = new Array(fileLines + 1).fill(null)
  for (const it of items) {
    for (let ln = it.startLine; ln <= it.endLine; ln++) { bucket[ln] = it.kind; covered[ln] = true }
  }
  let commentLines = 0
  let blankLines = 0
  const leftoverLines = []
  for (let ln = 1; ln <= fileLines; ln++) {
    if (bucket[ln] !== null) continue
    const t = lineText(ln).trim()
    if (t === '') { blankLines++; bucket[ln] = 'blank' }
    else if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) { commentLines++; bucket[ln] = 'comment' }
    else { leftoverLines.push(ln); bucket[ln] = 'leftover' }
  }
  const declLines = declarations.reduce((s, it) => s + it.len, 0)
  const importLines = imports.reduce((s, it) => s + it.len, 0)
  const unparsedLines = unparsed.reduce((s, it) => s + it.len, 0) + leftoverLines.length
  const accounted = declLines + importLines + unparsedLines + commentLines + blankLines

  // Story 1.3: declarations referencing nothing else in this file.
  const extractable = declarations
    .filter((it) => it.refs.length === 0)
    .sort((a, b) => b.len - a.len || a.startLine - b.startLine || (a.name < b.name ? -1 : 1))
  const extractableLines = extractable.reduce((s, it) => s + it.len, 0)

  // Story 2: the largest independently extractable group.
  const groups = componentsOf(items, refs).sort(
    (a, b) => b.declLines - a.declLines || b.members.length - a.members.length || a.members[0].startLine - b.members[0].startLine,
  )
  const properGroups = groups.filter((g) => g.proper)

  let recommendation = null
  if (properGroups.length === 0) {
    recommendation = { none: true }
  } else {
    const g = properGroups[0]
    const movedNames = [...g.names].sort()
    const attached = g.members.reduce((s, m) => s + (m.attached || 0), 0)
    const memberSet = new Set(g.names)
    const remainingRefs = []
    for (const it of declarations) {
      if (memberSet.has(it.name)) continue
      for (const r of it.refs) if (memberSet.has(r)) remainingRefs.push({ from: it.name, to: r })
    }
    const importsNeeded = new Map()
    for (const m of g.members) {
      for (const u of m.importsUsed || []) {
        if (!importsNeeded.has(u.module)) importsNeeded.set(u.module, new Set())
        importsNeeded.get(u.module).add(u.local)
      }
    }
    let callSites = null
    let scan = null
    if (externalFiles) {
      const found = findCallSites(externalFiles, fileName, movedNames, options.targetAbs ?? fileName, options.selfAbs)
      callSites = found
      scan = { filesScanned: externalFiles.length }
    }
    recommendation = {
      none: false,
      names: movedNames,
      members: g.members.map((m) => ({
        kind: m.kind, name: m.name, exported: m.exported,
        startLine: m.startLine, endLine: m.endLine, len: m.len, attached: m.attached || 0,
      })),
      declLines: g.declLines,
      attachedLines: attached,
      totalWithAttached: g.declLines + attached,
      importsNeeded: [...importsNeeded.entries()].map(([module, names]) => ({ module, names: [...names].sort() })).sort((a, b) => (a.module < b.module ? -1 : 1)),
      remainingRefs,
      callSites,
      scan,
    }
  }

  return {
    target: fileName,
    fileLines,
    bytes: Buffer.byteLength(sourceText, 'utf8'),
    sha256: createHash('sha256').update(sourceText).digest('hex'),
    declarations: declarations.map(({ kind, name, exported, startLine, endLine, len, refs, importsUsed, attached }) => ({ kind, name, exported, startLine, endLine, len, refs, importsUsed, attached })),
    imports: imports.map(({ name, startLine, endLine, len, names }) => ({ name, startLine, endLine, len, names })),
    unparsed: unparsed.map(({ name, startLine, endLine, len }) => ({ name, startLine, endLine, len })).concat(
      leftoverLines.map((ln) => ({ name: '(uncovered line)', startLine: ln, endLine: ln, len: 1 })),
    ),
    counts: {
      declarations: declarations.length,
      imports: imports.length,
      unparsed: unparsed.length + leftoverLines.length,
    },
    accounting: {
      declLines, importLines, unparsedLines, commentLines, blankLines,
      leftoverLines, accounted, fileLines,
      agrees: accounted === fileLines,
      declPlusUnparsed: declLines + unparsedLines,
    },
    extractable: {
      count: extractable.length,
      lines: extractableLines,
      pct: fileLines > 0 ? Math.round((extractableLines / fileLines) * 1000) / 10 : 0,
      names: extractable.map((it) => it.name),
      items: extractable.map((it) => ({ name: it.name, len: it.len })),
    },
    groups: groups.map((g) => ({
      proper: g.proper, declLines: g.declLines, count: g.members.length,
      names: [...g.names].sort(),
    })),
    recommendation,
  }
}

// ---------------------------------------------------------------------------
// Rendering. Plain ASCII, fixed order, no clock - byte-identical across runs.
// ---------------------------------------------------------------------------

export function renderSurvey(s) {
  const L = []
  const rule = (t) => L.push('----------------------------------------------------------------', t)
  L.push('================================================================')
  L.push('queen-kanban split survey')
  L.push('================================================================')
  L.push('target     : ' + s.target)
  L.push('file lines : ' + s.fileLines + ' (measured this run)')
  L.push('bytes      : ' + s.bytes)
  L.push('sha256     : ' + s.sha256)
  L.push('')
  L.push('a declaration is a top-level import, interface, type, enum, class,')
  L.push('function or variable statement, parsed from the source text. Doc')
  L.push('comments above a declaration are not part of its span. A reference')
  L.push('to an import is not a dependency: an import is re-declared in a new')
  L.push('module, it does not travel with the code.')
  L.push('')

  rule('1. top-level declarations, longest first')
  L.push('  lines        len  kind                 exp   name                          references (other declarations in this file)')
  L.push('  ----------  ----  ------------------  ----  ----------------------------  -------------------------------------------')
  const sorted = [...s.declarations].sort(
    (a, b) => b.len - a.len || a.startLine - b.startLine || (a.name < b.name ? -1 : 1),
  )
  for (const d of sorted) {
    const range = String(d.startLine) + '-' + String(d.endLine)
    L.push(
      '  ' + range.padEnd(11) + String(d.len).padStart(4) + '  ' +
      d.kind.padEnd(18) + (d.exported ? 'yes' : '-').padEnd(4) + '  ' +
      d.name.padEnd(28) + '  ' + (d.refs.length > 0 ? d.refs.join(', ') : '(none)'),
    )
  }
  L.push('')
  L.push('imports (top-level, in file order):')
  for (const im of s.imports) {
    L.push('  ' + String(im.startLine).padStart(4) + '  from ' + ('' + im.name).padEnd(34) + ' binds: ' + (im.names || []).join(', '))
  }
  L.push('')
  if (s.unparsed.length === 0) {
    L.push('unparsed top-level statements: 0')
  } else {
    L.push('unparsed top-level statements: ' + s.unparsed.length)
    for (const u of s.unparsed) {
      L.push('  line ' + u.startLine + (u.endLine !== u.startLine ? '-' + u.endLine : '') + ': kind "' + u.name + '" (' + u.len + ' lines) - not classified by the parser')
    }
  }
  L.push('')
  L.push('declaration count: ' + s.counts.declarations + ' declarations, ' + s.counts.imports + ' imports, ' + s.counts.unparsed + ' unparsed')
  L.push('')

  rule('2. accounting (measured this run)')
  L.push('  declaration lines (' + s.counts.declarations + ' declarations)      : ' + s.accounting.declLines)
  L.push('  import lines (' + s.counts.imports + ' imports)                    : ' + s.accounting.importLines)
  L.push('  unparsed lines (' + s.counts.unparsed + ' statements)                : ' + s.accounting.unparsedLines)
  L.push('  comment lines (attached and standalone)   : ' + s.accounting.commentLines)
  L.push('  blank lines                               : ' + s.accounting.blankLines)
  L.push('  ------------------------------------------------------------')
  L.push('  declaration lines + unparsed lines         : ' + s.accounting.declLines + ' + ' + s.accounting.unparsedLines + ' = ' + s.accounting.declPlusUnparsed)
  L.push('  accounted total (all five buckets)         : ' + s.accounting.accounted)
  L.push('  file line count (measured)                 : ' + s.accounting.fileLines)
  L.push('  they agree                                 : ' + (s.accounting.agrees ? 'yes' : 'NO'))
  L.push('')

  rule('3. independently extractable declarations')
  L.push('  a declaration is independently extractable when it references no')
  L.push('  other declaration in this file.')
  L.push('  count: ' + s.extractable.count + ' declarations, ' + s.extractable.lines + ' lines (' + s.extractable.pct + '% of ' + s.fileLines + ')')
  L.push('  list (longest first): ' + s.extractable.items.map((it) => it.name + ' (' + it.len + ')').join(', '))
  L.push('')

  rule('4. recommended single extraction')
  const r = s.recommendation
  L.push('  reference-graph components (the file partitions into these):')
  s.groups.forEach((g, i) => {
    const label = g.proper ? 'independently extractable group' : 'the whole file - not a group'
    const names = g.names.length <= 4 ? g.names.join(', ') : g.names.slice(0, 4).join(', ') + ', ... (' + g.names.length + ' declarations)'
    L.push('    ' + (i + 1) + '. ' + String(g.declLines).padStart(3) + ' declaration lines, ' + String(g.count).padStart(2) + ' members: ' + names + '  [' + label + ']')
  })
  L.push('')
  if (r.none) {
    L.push('  NO group in this file is independently extractable.')
    L.push('  The reference graph is one connected component: any extraction')
    L.push('  would drag the rest of the file behind it, so no split is')
    L.push('  proposed here. The table above is the map for arguing about one.')
  } else {
    L.push('  a group is independently extractable when it is a connected')
    L.push('  component of this file\'s reference graph and not the whole file:')
    L.push('  members depend only on each other and on imports, and nothing')
    L.push('  left behind references them, so this file loses lines and gains')
    L.push('  no import. This is the largest such group.')
    L.push('')
    L.push('  group         : ' + r.names.join(' + '))
    L.push('  lines removed : ' + r.declLines + ' declaration lines (' + r.totalWithAttached + ' with the doc comments that travel with them)')
    L.push('  declarations that move:')
    for (const m of r.members) {
      L.push('    ' + m.kind.padEnd(18) + m.name.padEnd(28) + (String(m.startLine) + '-' + String(m.endLine)).padEnd(10) + String(m.len).padStart(3) + ' lines  ' + (m.exported ? 'exported' : 'not exported') + (m.attached > 0 ? '  (+' + m.attached + ' comment lines)' : ''))
    }
    L.push('')
    if (r.importsNeeded.length === 0) {
      L.push('  imports the moved code needs: none')
    } else {
      L.push('  imports the moved code needs (re-declared in the new module):')
      for (const im of r.importsNeeded) L.push('    ' + im.names.join(', ') + ' (from ' + im.module + ')')
    }
    L.push('  references left behind in this file: ' + (r.remainingRefs.length === 0 ? 'none' : r.remainingRefs.map((x) => x.from + ' -> ' + x.to).join(', ')))
    L.push('')
    if (!r.callSites) {
      L.push('  call sites outside this file: not scanned (no external files given)')
    } else {
      L.push('  call sites outside this file that need their import changed:')
      if (r.callSites.sites.length === 0) L.push('    (none found)')
      for (const c of r.callSites.sites) {
        const where = c.path + ':' + c.importLine + (c.importEndLine !== c.importLine ? '-' + c.importEndLine : '')
        L.push('    ' + where)
        L.push('      imports ' + c.importedMoved.join(', ') + ' from ' + JSON.stringify(c.spec))
        if (c.importedStays.length > 0) {
          L.push('      (the same import also brings ' + c.importedStays.join(', ') + ', which remain in this file)')
        }
        if (c.usageLines.length > 0) {
          const shown = c.usageLines.slice(0, 6).map((x) => 'line ' + x).join(', ')
          L.push('      used at ' + shown + (c.usageLines.length > 6 ? ' (+ ' + (c.usageLines.length - 6) + ' more)' : ''))
        }
      }
      if (r.callSites.untouched.length > 0) {
        L.push('  files importing this module but using no moved name (no change needed):')
        for (const c of r.callSites.untouched) L.push('    ' + c.path + ':' + c.importLine + ' from ' + JSON.stringify(c.spec))
      } else {
        L.push('  files importing this module but using no moved name: none')
      }
      if (r.callSites.pathRefs.length > 0) {
        L.push('  other references to this file\'s path (not imports, listed for completeness):')
        for (const p of r.callSites.pathRefs.slice(0, 8)) L.push('    ' + p.path + ':' + p.line)
        if (r.callSites.pathRefs.length > 8) L.push('    (+ ' + (r.callSites.pathRefs.length - 8) + ' more)')
      }
      L.push('  call-site scan: ' + r.scan.filesScanned + ' source files under the repository root')
    }
  }
  L.push('')
  L.push('this survey reads and reports. it changed nothing.')
  return L.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function findRepoRoot(fromDir) {
  let dir = fromDir
  for (;;) {
    if (statSyncSafe(join(dir, TARGET_REL))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function statSyncSafe(p) {
  try { return statSync(p).isFile() } catch { return false }
}

function collectSourceFiles(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p)
      } else if (e.isFile() && SOURCE_EXT.test(e.name)) {
        try {
          const st = statSync(p)
          if (st.size <= 2_000_000) out.push({ path: relative(root, p) || p, abs: p, text: readFileSync(p, 'utf8') })
        } catch { /* unreadable: skip */ }
      }
    }
  }
  return out
}

function main() {
  const toolDir = dirname(fileURLToPath(import.meta.url))
  const root = findRepoRoot(toolDir)
  if (!root) {
    process.stderr.write('cannot locate ' + TARGET_REL + ' above ' + toolDir + '\n')
    process.exitCode = 1
    return
  }
  const targetAbs = join(root, TARGET_REL)
  const source = readFileSync(targetAbs, 'utf8')
  const files = collectSourceFiles(root).map((f) => ({ path: f.path, text: f.text, abs: f.abs }))
  const survey = splitQueenKanban(source, {
    fileName: TARGET_REL,
    externalFiles: files,
    targetAbs,
    selfAbs: fileURLToPath(import.meta.url),
  })
  process.stdout.write(renderSurvey(survey) + '\n')
}

const invokedAs = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedAs && invokedAs === fileURLToPath(import.meta.url)) main()
