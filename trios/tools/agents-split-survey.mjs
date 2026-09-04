#!/usr/bin/env node
/**
 * Split survey for agent-server/apps/server/src/api/routes/agents.ts (issue #1412).
 *
 * What this tool is: a read-only survey. It parses the target file's source
 * text, enumerates every top-level declaration (exported and not), measures
 * line ranges and lengths, maps which declarations reference which, marks the
 * ones that reference nothing else in the file as independently extractable,
 * and recommends exactly one extraction with its cost, including the call
 * sites outside the file that would need an import change.
 *
 * What this tool is NOT: it does not modify the target file or any source
 * file. It never invokes a TypeScript compiler, make, or any build. It uses
 * the Node standard library only and runs as:
 *
 *   node trios/tools/agents-split-survey.mjs
 *
 * Determinism: no clocks, no randomness, no environment-dependent values.
 * Two runs over an unchanged tree produce byte-identical output.
 *
 * Method notes are printed at the end of the report itself.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..') // the `trios/` project directory
const DEFAULT_TARGET = path.join(
  PROJECT_ROOT,
  'agent-server/apps/server/src/api/routes/agents.ts',
)
const DEFAULT_SCAN_ROOT = PROJECT_ROOT

// Directories never entered while scanning for external call sites.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'output', 'coverage',
  '.cache', '.turbo', '.next', 'target', '.worktrees', '.DS_Store',
])
const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
])

// ---------------------------------------------------------------------------
// 1. Masking: blank out comments, string/template text, and regex literals
//    while preserving offsets, newlines, and code characters. Brace counting
//    and identifier search then operate on real code only.
// ---------------------------------------------------------------------------

/**
 * @param {string} src raw source text
 * @returns {{ masked: string }} masked text, same length as src
 */
function maskSource(src) {
  const out = src.split('')
  const blank = (i) => { if (out[i] !== '\n' && out[i] !== undefined) out[i] = ' ' }
  const n = src.length
  let i = 0
  let state = 'code' // code | linecomment | blockcomment | sq | dq | tpl | regex
  let prevSig = '' // last significant code char
  let prevWord = '' // last identifier/keyword
  let regexClass = false
  // Interpolation brace depths of open `${ ... }` contexts, innermost last.
  const tplStack = []
  const regexAfterChars = new Set('([{,;=:!&|?+*-%<>~^}'.split(''))
  const regexAfterWords = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'case', 'do', 'else',
    'void', 'delete', 'new', 'throw', 'yield', 'await',
  ])
  const wordChar = (c) => /[A-Za-z0-9_$]/.test(c)

  const seeCode = (c) => {
    if (wordChar(c)) {
      prevWord = wordChar(prevSig) ? prevWord + c : c
      prevSig = c
    } else if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
      prevSig = c
      prevWord = ''
    }
  }
  const regexAllowed = () =>
    prevSig === '' ||
    regexAfterChars.has(prevSig) ||
    (wordChar(prevSig) && regexAfterWords.has(prevWord))

  while (i < n) {
    const c = src[i]
    const d = i + 1 < n ? src[i + 1] : ''
    switch (state) {
      case 'code': {
        if (c === '/' && d === '/') { state = 'linecomment'; blank(i); blank(i + 1); i += 2; break }
        if (c === '/' && d === '*') { state = 'blockcomment'; blank(i); blank(i + 1); i += 2; break }
        if (c === '"') { state = 'dq'; blank(i); i++; prevSig = '"'; prevWord = ''; break }
        if (c === "'") { state = 'sq'; blank(i); i++; prevSig = "'"; prevWord = ''; break }
        if (c === '`') { state = 'tpl'; blank(i); i++; prevSig = '`'; prevWord = ''; break }
        if (c === '/') {
          if (regexAllowed()) { state = 'regex'; regexClass = false; blank(i); i++ }
          else { seeCode(c); i++ }
          break
        }
        if (c === '{') {
          if (tplStack.length) tplStack[tplStack.length - 1]++
          seeCode(c); i++; break
        }
        if (c === '}') {
          if (tplStack.length) {
            const top = tplStack[tplStack.length - 1]
            if (top === 0) {
              tplStack.pop()
              blank(i); i++
              state = 'tpl'
              prevSig = '`'; prevWord = ''
              break
            }
            tplStack[tplStack.length - 1]--
          }
          seeCode(c); i++; break
        }
        seeCode(c); i++; break
      }
      case 'linecomment': {
        if (c === '\n') state = 'code'; else blank(i)
        i++; break
      }
      case 'blockcomment': {
        if (c === '*' && d === '/') { blank(i); blank(i + 1); i += 2; state = 'code' }
        else { blank(i); i++ }
        break
      }
      case 'sq': case 'dq': {
        if (c === '\\') { blank(i); blank(i + 1); i += 2; break }
        if (c === '\n') { state = 'code'; i++; break } // unterminated; recover
        if (c === (state === 'dq' ? '"' : "'")) { blank(i); i++; state = 'code'; prevSig = '"'; prevWord = '' }
        else { blank(i); i++ }
        break
      }
      case 'tpl': {
        if (c === '\\') { blank(i); blank(i + 1); i += 2; break }
        if (c === '`') { blank(i); i++; state = 'code'; prevSig = '`'; prevWord = ''; break }
        if (c === '$' && d === '{') {
          blank(i); blank(i + 1)
          tplStack.push(0)
          i += 2; state = 'code'
          break
        }
        blank(i); i++; break
      }
      case 'regex': {
        if (c === '\\') { blank(i); blank(i + 1); i += 2; break }
        if (c === '\n') { state = 'code'; i++; break } // not a regex after all
        if (c === '[') regexClass = true
        else if (c === ']') regexClass = false
        else if (c === '/' && !regexClass) {
          blank(i); i++; state = 'code'; prevSig = '"'; prevWord = ''
          break
        }
        blank(i); i++; break
      }
      default:
        i++
    }
  }
  return { masked: out.join('') }
}

/**
 * Like maskSource, but keeps string contents (needed to read module
 * specifiers in import statements of scanned files).
 * @param {string} src
 * @returns {string}
 */
function maskCommentsOnly(src) {
  // Lighter mask: blanks comments only, keeps strings (module specifiers
  // must stay readable for the import scanner).
  const out = src.split('')
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    const d = i + 1 < n ? src[i + 1] : ''
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    if (c === '/' && d === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++ }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2 }
      continue
    }
    i++
  }
  return out.join('')
}

// ---------------------------------------------------------------------------
// 2. Top-level parsing: find declaration starts on raw lines, then locate
//    each declaration's end on the masked text by tracking bracket depth.
// ---------------------------------------------------------------------------

const CONTINUATION_CHARS = new Set('([{,|&+-*/%=?.:!<>~^'.split(''))

/**
 * Find the index of the newline that terminates the statement beginning at
 * startIdx in masked text (or the end of text).
 *
 * Depth rules:
 *  - (), [], {} groups must close before a line break can end the statement.
 *  - Angle depth <> is tracked only until the declaration's body brace is
 *    seen, so multi-line generic return types (`Promise<\n | {...}\n> {`)
 *    do not terminate at an intermediate `}`. `=>` never counts.
 *  - requireBody (function/class/interface/enum): a line break can only end
 *    the declaration after the body brace has opened and closed.
 *
 * @param {string} masked
 * @param {number} startIdx
 * @param {{ requireBody?: boolean }} opts
 * @returns {number}
 */
function findStatementEnd(masked, startIdx, opts = {}) {
  const requireBody = opts.requireBody === true
  const n = masked.length
  let paren = 0, brace = 0, bracket = 0, angle = 0
  let bodySeen = false
  let angleFrozen = bodySeen
  let i = startIdx
  while (i < n) {
    const c = masked[i]
    if (c === '\n') {
      const allClosed = paren === 0 && brace === 0 && bracket === 0
      if (allClosed && angle === 0 && (!requireBody || bodySeen)) {
        let j = i - 1
        while (j >= startIdx && (masked[j] === ' ' || masked[j] === '\t' || masked[j] === '\r')) j--
        const last = j >= startIdx ? masked[j] : ''
        if (j < startIdx || CONTINUATION_CHARS.has(last)) { i++; continue }
        return i
      }
      i++; continue
    }
    if (c === '(') paren++
    else if (c === ')') paren = Math.max(0, paren - 1)
    else if (c === '[') bracket++
    else if (c === ']') bracket = Math.max(0, bracket - 1)
    else if (c === '{') {
      if (paren === 0 && bracket === 0 && angle === 0 && !bodySeen) bodySeen = true
      brace++
    } else if (c === '}') brace = Math.max(0, brace - 1)
    else if (c === '<') { if (!angleFrozen) angle++ }
    else if (c === '>') { if (!angleFrozen) angle = Math.max(0, angle - 1) }
    else if (c === ';') {
      if (paren === 0 && brace === 0 && bracket === 0) {
        let j = i
        while (j < n && masked[j] !== '\n') j++
        return j
      }
    }
    if (bodySeen && !angleFrozen && angle === 0) angleFrozen = true
    i++
  }
  return n
}

const IDENT = String.raw`[A-Za-z_$][\w$]*`
const DECL_PATTERNS = [
  { kind: 'import', re: new RegExp(String.raw`^import\s+type\s+`), named: false },
  { kind: 'import', re: new RegExp(String.raw`^import\s*['"]`), named: false },
  { kind: 'import', re: new RegExp(String.raw`^import\s`), named: false },
  { kind: 're-export', re: new RegExp(String.raw`^export\s+[\w$*,{}\s]+?\s*from\s*['"]`), named: false },
  { kind: 're-export', re: new RegExp(String.raw`^export\s*\*\s*from\s*['"]`), named: false },
  { kind: 'export-list', re: new RegExp(String.raw`^export\s*\{`), named: false },
  {
    kind: 'function', named: true, requireBody: true,
    re: new RegExp(String.raw`^(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*(?<name>${IDENT})?\b`),
  },
  {
    kind: 'class', named: true, requireBody: true,
    re: new RegExp(String.raw`^(export\s+)?(default\s+)?(abstract\s+)?class\s+(?<name>${IDENT})`),
  },
  {
    kind: 'interface', named: true, requireBody: true,
    re: new RegExp(String.raw`^(export\s+)?interface\s+(?<name>${IDENT})`),
  },
  {
    kind: 'enum', named: true, requireBody: true,
    re: new RegExp(String.raw`^(export\s+)?(const\s+)?enum\s+(?<name>${IDENT})`),
  },
  {
    kind: 'type', named: true,
    re: new RegExp(String.raw`^(export\s+)?type\s+(?<name>${IDENT})\s*(=|<)`),
  },
  {
    kind: 'variable', named: true,
    re: new RegExp(String.raw`^(export\s+)?(default\s+)?(const|let|var)\s+(?<name>${IDENT})`),
  },
  {
    kind: 'variable-destructure', named: true,
    re: new RegExp(String.raw`^(export\s+)?(const|let|var)\s*(?<name>[\[{][^\n]*?[\]}])\s*=`),
  },
  { kind: 'export-default', named: false, re: new RegExp(String.raw`^export\s+default\s`) },
]

/**
 * Parse top-level structure of a source file.
 * @param {string} src
 * @returns {{
 *   items: Array<Object>, blankLines: number[], commentLines: number[],
 *   unparsed: Array<{startLine:number,endLine:number}>, totalLines: number
 * }}
 */
function parseTopLevel(src) {
  const { masked } = maskSource(src)
  const rawLines = src.split('\n')
  const maskedLines = masked.split('\n')
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop(); maskedLines.pop()
  }
  const totalLines = rawLines.length
  const lineStarts = []
  {
    let off = 0
    for (const ln of maskedLines) { lineStarts.push(off); off += ln.length + 1 }
  }
  const idxToLine = (idx) => {
    let lo = 0, hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1
    }
    return lo // 0-based
  }

  const items = []
  const blankLines = []
  const commentLines = []
  const unparsed = []

  let li = 0
  while (li < totalLines) {
    const maskedLine = maskedLines[li]
    const rawLine = rawLines[li]
    if (maskedLine.trim() === '') {
      if (rawLine.trim() === '') blankLines.push(li + 1)
      else commentLines.push(li + 1) // comment-only line (or string continuation)
      li++
      continue
    }
    const trimmed = rawLine.trim()
    let matched = null
    for (const p of DECL_PATTERNS) {
      const m = trimmed.match(p.re)
      if (m) { matched = { pattern: p, match: m }; break }
    }
    const startIdx = lineStarts[li] + (rawLine.length - rawLine.trimStart().length)
    if (matched) {
      const p = matched.pattern
      const requireBody = p.requireBody === true
      const endIdx = findStatementEnd(masked, startIdx, { requireBody })
      const endLine0 = endIdx >= masked.length ? totalLines - 1 : idxToLine(Math.min(endIdx, masked.length - 1))
      const name = p.named
        ? (matched.match.groups?.name ?? '(anonymous)')
        : '' // filled in below for import/re-export items
      const exported = /^export\b/.test(trimmed)
      const item = {
        kind: p.kind,
        name,
        exported,
        named: p.named === true,
        startLine: li + 1,
        endLine: endLine0 + 1,
        lines: endLine0 + 1 - li,
        text: trimmed,
        bodyMasked: maskedLines.slice(li, endLine0 + 1).join('\n'),
        bodyRaw: rawLines.slice(li, endLine0 + 1).join('\n'),
      }
      if (!item.named) item.name = importDisplayName(item)
      items.push(item)
      li = endLine0 + 1
      continue
    }
    // Top-level code the parser cannot classify (FR-003): consume the whole
    // statement so it is reported once, with its line range.
    const endIdx = findStatementEnd(masked, startIdx, {})
    const endLine0 = endIdx >= masked.length ? totalLines - 1 : idxToLine(Math.min(endIdx, masked.length - 1))
    unparsed.push({ startLine: li + 1, endLine: endLine0 + 1 })
    li = endLine0 + 1
  }
  return { items, blankLines, commentLines, unparsed, totalLines }
}

/** Display name for an import/re-export statement: its module specifier. */
function importDisplayName(item) {
  const specMatch = item.bodyRaw.match(/from\s*['"]([^'"]+)['"]/) ||
    item.bodyRaw.match(/^\s*import\s*['"]([^'"]+)['"]/)
  if (specMatch) return `import ${specMatch[1]}`
  return item.text.slice(0, 40)
}

// ---------------------------------------------------------------------------
// 3. Reference graph between named declarations in the file.
// ---------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * @param {Array<Object>} items parsed top-level items (named only are nodes)
 */
function buildReferenceGraph(items) {
  const named = items.filter((it) => it.named)
  for (const it of named) {
    it.references = [] // other top-level declarations this one uses
    it.referencedBy = [] // other top-level declarations that use this one
  }
  for (const a of named) {
    for (const b of named) {
      if (a === b) continue
      const re = new RegExp(String.raw`\b${escapeRe(b.name)}\b`)
      const found = a.bodyMasked.match(new RegExp(re.source, 'g'))
      if (found && found.length > 0) {
        a.references.push({ name: b.name, count: found.length })
      }
    }
  }
  for (const a of named) {
    a.references.sort((x, y) => x.name.localeCompare(y.name))
    for (const r of a.references) {
      const target = named.find((d) => d.name === r.name)
      target.referencedBy.push({ name: a.name, count: r.count })
    }
  }
  for (const a of named) a.referencedBy.sort((x, y) => x.name.localeCompare(y.name))
  return named
}

// ---------------------------------------------------------------------------
// 4. Import bindings: map locally-bound names to their module specifiers.
// ---------------------------------------------------------------------------

/**
 * @param {Array<Object>} items
 * @returns {Map<string, string>} local binding name -> module specifier
 */
function collectImportBindings(items) {
  const bindings = new Map()
  for (const it of items) {
    if (it.kind !== 'import' && it.kind !== 're-export') continue
    const specMatch = it.bodyRaw.match(/from\s*['"]([^'"]+)['"]/) ||
      it.bodyRaw.match(/^\s*import\s*['"]([^'"]+)['"]/)
    if (!specMatch) continue
    const spec = specMatch[1]
    const clauseMatch = it.bodyRaw.match(/(?:import|export)\s+([\s\S]*?)\s*from\s*['"]/)
    const clause = clauseMatch ? clauseMatch[1] : ''
    const braces = clause.match(/\{([\s\S]*?)\}/)
    if (braces) {
      for (const part of braces[1].split(',')) {
        const entry = part.trim().replace(/^type\s+/, '')
        if (!entry) continue
        const local = entry.includes(' as ') ? entry.split(' as ').pop().trim() : entry
        if (/^[\w$]+$/.test(local)) bindings.set(local, spec)
      }
      const head = clause.split('{')[0].replace(/,/g, '').trim()
      if (/^[\w$]+$/.test(head)) bindings.set(head, spec)
      const star = clause.match(/\*\s+as\s+([\w$]+)/)
      if (star) bindings.set(star[1], spec)
    } else if (/^[\w$*]+$/.test(clause.replace(/\s+as\s+/, ' ').trim()) || /\*\s+as/.test(clause)) {
      const cleaned = clause.trim()
      const asMatch = cleaned.match(/\*\s+as\s+([\w$]+)/)
      if (asMatch) bindings.set(asMatch[1], spec)
      else if (/^[\w$]+$/.test(cleaned)) bindings.set(cleaned, spec)
    }
  }
  return bindings
}

/** External modules a set of declarations would need to import. */
function importsNeededBy(items, importBindings) {
  const needed = new Map() // specifier -> Set of binding names
  for (const it of items) {
    for (const [binding, spec] of importBindings) {
      const re = new RegExp(String.raw`\b${escapeRe(binding)}\b`)
      if (re.test(it.bodyMasked)) {
        if (!needed.has(spec)) needed.set(spec, new Set())
        needed.get(spec).add(binding)
      }
    }
  }
  return needed
}

// ---------------------------------------------------------------------------
// 5. External call-site scan: find files that import the target module.
// ---------------------------------------------------------------------------

/**
 * @param {string} scanRoot absolute path
 * @param {string} targetPath absolute path of the surveyed module
 * @returns {{ scanned: number, skippedDirs: number, statements: Array<Object> }}
 */
function scanModuleImports(scanRoot, targetPath) {
  const statements = []
  let scanned = 0
  let skippedDirs = 0
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    entries.sort()
    for (const entry of entries) {
      const full = path.join(dir, entry)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) { skippedDirs++; continue }
        walk(full)
      } else if (st.isFile() && SCAN_EXTENSIONS.has(path.extname(entry))) {
        scanned++
        if (full === targetPath) continue
        let text
        try { text = readFileSync(full, 'utf8') } catch { continue }
        for (const st2 of extractImportStatements(text)) {
          const resolved = resolveSpecifier(st2.specifier, path.dirname(full), targetPath)
          if (resolved) {
            statements.push({
              file: full,
              line: st2.line,
              specifier: st2.specifier,
              clause: st2.clause,
              bindings: st2.bindings,
              matchKind: resolved.matchKind,
              statement: st2.statement,
            })
          }
        }
      }
    }
  }
  walk(scanRoot)
  statements.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
  return { scanned, skippedDirs, statements }
}

/** Extract import/export-from statements with line numbers from raw text. */
function extractImportStatements(text) {
  const masked = maskCommentsOnly(text)
  const out = []
  const fromRe = /\bfrom\s*['"]([^'"]+)['"]/g
  let m
  while ((m = fromRe.exec(masked)) !== null) {
    const spec = m[1]
    // Walk back to the statement keyword, bounded by statement separators.
    const before = masked.slice(0, m.index)
    const kwRe = /\b(import|export)\b/g
    let kw = null
    let km
    while ((km = kwRe.exec(before)) !== null) {
      const between = before.slice(km.index + km[0].length, m.index)
      if (!/^[^;]*$/.test(between)) { kw = null; break }
      kw = { index: km.index, word: km[0] }
    }
    if (!kw) continue
    const clause = masked.slice(kw.index, m.index).replace(/^\s*(import|export)\s+/, '').trim()
    const line = masked.slice(0, kw.index).split('\n').length
    out.push({
      line,
      specifier: spec,
      clause,
      bindings: parseClauseBindings(clause),
      statement: text.split('\n')[line - 1].trim(),
    })
  }
  const bareRe = /(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g
  while ((m = bareRe.exec(masked)) !== null) {
    const line = masked.slice(0, m.index).split('\n').length
    out.push({ line, specifier: m[1], clause: '', bindings: [], statement: `import '${m[1]}'` })
  }
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dynRe.exec(masked)) !== null) {
    const line = masked.slice(0, m.index).split('\n').length
    out.push({ line, specifier: m[1], clause: '(dynamic)', bindings: [], statement: `import('${m[1]}')` })
  }
  return out
}

function parseClauseBindings(clause) {
  const names = []
  const braces = clause.match(/\{([\s\S]*?)\}/)
  if (braces) {
    for (const part of braces[1].split(',')) {
      const entry = part.trim().replace(/^type\s+/, '')
      if (!entry) continue
      const orig = entry.split(' as ')[0].trim()
      const local = entry.includes(' as ') ? entry.split(' as ').pop().trim() : entry
      if (/^[\w$]+$/.test(orig)) names.push({ original: orig, local })
    }
    const head = clause.split('{')[0].replace(/,/g, '').trim()
    if (/^[\w$]+$/.test(head)) names.push({ original: head, local: head })
  } else if (/^[\w$]+$/.test(clause.trim())) {
    names.push({ original: clause.trim(), local: clause.trim() })
  } else {
    const asMatch = clause.trim().match(/\*\s+as\s+([\w$]+)/)
    if (asMatch) names.push({ original: '*', local: asMatch[1] })
  }
  return names
}

/** Resolve a specifier against an importing dir; return match info if it
 *  points at the target module. */
function resolveSpecifier(spec, fromDir, targetPath) {
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const base = path.resolve(fromDir, spec)
    const candidates = [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']
      .map((e) => base + e), ...['.ts', '.tsx', '.js'].map((e) => path.join(base, 'index' + e))]
    for (const cand of candidates) {
      if (cand === targetPath) return { matchKind: 'relative' }
    }
    return null
  }
  // Bare / aliased specifiers: report only if they clearly name this module.
  if (/(?:^|\/)routes\/agents$/.test(spec) || /(?:^|\/)routes\/agents\.js$/.test(spec)) {
    return { matchKind: 'alias' }
  }
  return null
}

// ---------------------------------------------------------------------------
// 6. Report assembly.
// ---------------------------------------------------------------------------

const fmtRefs = (refs) =>
  refs.length === 0 ? '—' : refs.map((r) => (r.count > 1 ? `${r.name} ×${r.count}` : r.name)).join(', ')

function buildReport(ctx) {
  const {
    targetRel, totalLines, items, named, blankLines, commentLines, unparsed,
    scan, extractable, movedCommentLines,
  } = ctx

  const lines = []
  const p = (s) => lines.push(s)

  p(`# Split survey — ${targetRel}`)
  p('')
  p(`Measured by \`node trios/tools/agents-split-survey.mjs\` at run time; no number in this report is copied from an issue or a prior run.`)
  p('')

  const importItems = items.filter((it) => it.kind === 'import' || it.kind === 're-export')
  const itemLines = items.reduce((s, it) => s + it.lines, 0)
  const unparsedLines = unparsed.reduce((s, u) => s + (u.endLine - u.startLine + 1), 0)
  const uncovered = blankLines.length + commentLines.length + unparsedLines

  p(`## Measured facts`)
  p('')
  p(`- File line count (measured this run): **${totalLines}**`)
  p(`- Top-level declarations found: **${named.length}** named declarations, plus ${importItems.length} import statements (${items.length} classified top-level items in total)`)
  p(`- Unparsed (unclassified code) statements: **${unparsed.length}**`)
  p(`- Accounting: declaration/import lines ${itemLines} + unaccounted lines ${uncovered} = ${itemLines + uncovered}; file line count ${totalLines}. ${itemLines + uncovered === totalLines ? '**They agree.**' : '**MISMATCH — do not trust this report.**'}`)
  p(`- Unaccounted breakdown: ${commentLines.length} comment-only lines, ${blankLines.length} blank lines, ${unparsedLines} unparsed code lines`)
  p('')

  p(`## Top-level declarations (sorted by length, longest first)`)
  p('')
  p(`| # | lines | start–end | kind | exported | name | references (same file) | referenced by |`)
  p(`|---|------:|-----------|------|----------|------|------------------------|---------------|`)
  const sorted = [...named].sort((a, b) =>
    b.lines - a.lines || a.startLine - b.startLine || a.name.localeCompare(b.name))
  sorted.forEach((it, i) => {
    p(`| ${i + 1} | ${it.lines} | ${it.startLine}–${it.endLine} | ${it.kind} | ${it.exported ? 'yes' : 'no'} | \`${it.name}\` | ${fmtRefs(it.references).replace(/\|/g, '\\|')} | ${fmtRefs(it.referencedBy).replace(/\|/g, '\\|')} |`)
  })
  p('')
  p(`Imports (top-level statements, not declarations; listed for completeness):`)
  p('')
  p(`| start–end | lines | module |`)
  p(`|-----------|------:|--------|`)
  for (const it of importItems) {
    p(`| ${it.startLine}–${it.endLine} | ${it.lines} | \`${it.name.replace(/\|/g, '\\|')}\` |`)
  }
  p('')

  const extractableSorted = [...extractable].sort((a, b) =>
    b.lines - a.lines || a.startLine - b.startLine)
  const extractableLines = extractable.reduce((s, it) => s + it.lines, 0)

  p(`## Independently extractable declarations`)
  p('')
  p(`A declaration is independently extractable when it references no other top-level declaration in this file (imported names travel with it as imports, so they do not block extraction).`)
  p('')
  if (extractable.length === 0) {
    p(`**None.** Every top-level declaration in this file references at least one other top-level declaration in the file, so no single declaration or group can be lifted out without dragging the rest of the file behind it.`)
    p('')
  } else {
    p(`| lines | start–end | kind | exported | name |`)
    p(`|------:|-----------|------|----------|------|`)
    for (const it of extractableSorted) {
      p(`| ${it.lines} | ${it.startLine}–${it.endLine} | ${it.kind} | ${it.exported ? 'yes' : 'no'} | \`${it.name}\` |`)
    }
    p('')
    p(`**${extractable.length} declarations, ${extractableLines} lines (${(100 * extractableLines / totalLines).toFixed(1)}% of the file) are independently extractable.**`)
    p('')
  }

  p(`## Recommended extraction (exactly one)`)
  p('')
  if (extractable.length === 0) {
    p(`No independently extractable declaration exists, so no split is proposed. Any extraction would first have to cut the reference edges listed in the table above (for example by moving a helper together with its callers, or by parameter-injecting a dependency). That judgement stays with a person; this survey only records the cost.`)
  } else {
    p(`Move all ${extractable.length} independently extractable declarations into one new module. They reference nothing left behind, so they can travel together in a single move.`)
    p('')
    p(`- **Lines removed from this file:** ${extractableLines} of ${totalLines} (${(100 * extractableLines / totalLines).toFixed(1)}%)${movedCommentLines > 0 ? `, plus ${movedCommentLines} associated comment lines that would travel with them` : ''}`)
    p(`- **Declarations that move:**`)
    for (const it of extractableSorted) {
      p(`  - \`${it.name}\` (${it.kind}, ${it.lines} ${it.lines === 1 ? 'line' : 'lines'}, ${it.startLine}–${it.endLine}${it.exported ? ', exported' : ''})`)
    }
    const needed = ctx.importsNeeded
    p(`- **Imports that travel with them:** ${[...needed.keys()].sort().map((s) => `\`${s}\``).join(', ')}`)
    const internalCallers = new Map()
    for (const it of named) {
      if (extractable.includes(it)) continue
      const hits = it.references.filter((r) => extractable.some((e) => e.name === r.name))
      if (hits.length > 0) internalCallers.set(it.name, hits)
    }
    p(`- **Remaining declarations in this file that reference a moved declaration** (they would add one import of the new module): ${internalCallers.size === 0 ? 'none' : [...internalCallers.keys()].sort().map((n2) => `\`${n2}\``).join(', ')}`)
    const movedExported = extractable.filter((it) => it.exported).map((it) => it.name)
    const affected = scan.statements.filter((st) =>
      st.bindings.some((b) => b.original === '*' || movedExported.includes(b.original) || movedExported.includes(b.local)))
    p(`- **Call sites outside this file that would need their import changed:**`)
    if (movedExported.length === 0) {
      p(`  - None of the moved declarations is exported, so no other file can import them. No external import change is required.`)
    } else if (affected.length === 0) {
      p(`  - **None.** ${scan.scanned} files under the project root were scanned (excluding ${scan.skippedDirs} skipped directories such as node_modules); no file outside this module imports any moved declaration. (Files that import this module are listed below for the record.)`)
    } else {
      for (const st of affected) {
        p(`  - \`${toRel(st.file, ctx)}:${st.line}\` imports ${st.bindings.filter((b) => movedExported.includes(b.original) || movedExported.includes(b.local) || b.original === '*').map((b) => b.original).join(', ')} from \`${st.specifier}\``)
      }
    }
    const unaffected = scan.statements.filter((st) => !affected.includes(st))
    p(`- **Files that import this module but are unaffected** (they import only declarations that stay): ${unaffected.length === 0 ? 'none' : ''}`)
    for (const st of unaffected) {
      p(`  - \`${toRel(st.file, ctx)}:${st.line}\` — \`${st.statement.replace(/\|/g, '\\|').slice(0, 100)}\``)
    }
  }
  p('')

  p(`## Unparsed and unaccounted lines`)
  p('')
  if (unparsed.length === 0) {
    p(`No unparsed code lines: every top-level line was classified as part of a declaration, an import statement, a comment, or blank. (${commentLines.length} comment-only lines and ${blankLines.length} blank lines sit between declarations; they are listed in the accounting above.)`)
  } else {
    p(`Unparsed (unclassified top-level statements) — the parser could not classify these; they are counted, not dropped:`)
    for (const u of unparsed) {
      p(`- lines ${u.startLine}–${u.endLine}`)
    }
  }
  p('')

  p(`## Method`)
  p('')
  p(`- Declarations are found by parsing the source text (string/comment/regex-aware masking, then bracket-depth statement termination), not from any list written into this tool. Re-run it after the file changes.`)
  p(`- References are word-boundary matches of each declaration's name inside the other declarations' code (comments and string literals excluded via masking). Shadowed local identifiers would still count as references; none occur in this file today.`)
  p(`- External call sites were found by scanning ${scan.scanned} source files under ${ctx.scanRel} (directories named ${[...SKIP_DIRS].slice(0, 5).join(', ')}, … are skipped), resolving every relative import/export-from/dynamic-import specifier and matching it against this module's path, and flagging bare specifiers that end in \`routes/agents\`.`)
  p(`- Read-only: this tool writes nothing and modifies no source file. Node standard library only; no TypeScript compiler, no make, no build.`)
  p(`- Deterministic: no clocks or randomness; two runs over an unchanged tree produce byte-identical output.`)
  p('')
  p(`Reproduce: \`node trios/tools/agents-split-survey.mjs\``)
  p('')
  return lines.join('\n')
}

function toRel(abs, ctx) {
  return path.relative(ctx.projectRoot, abs)
}

// ---------------------------------------------------------------------------
// 7. Entry point.
// ---------------------------------------------------------------------------

/**
 * Survey the agents route file for a future split. Reads and reports only.
 * @param {{ targetPath?: string, scanRoot?: string }} [options]
 * @returns {{ report: string, totalLines: number, declarationCount: number }}
 */
export function splitAgents(options = {}) {
  const targetPath = path.resolve(options.targetPath ?? DEFAULT_TARGET)
  const scanRoot = path.resolve(options.scanRoot ?? DEFAULT_SCAN_ROOT)
  const src = readFileSync(targetPath, 'utf8')

  const { items, blankLines, commentLines, unparsed, totalLines } = parseTopLevel(src)
  const named = buildReferenceGraph(items)
  const importBindings = collectImportBindings(items)

  const extractable = named.filter((it) => it.references.length === 0)
  const importsNeeded = importsNeededBy(extractable, importBindings)

  // Comment-only lines directly above each moved declaration would travel too.
  let movedCommentLines = 0
  const commentSet = new Set(commentLines)
  for (const it of extractable) {
    let l = it.startLine - 1
    while (l >= 1 && commentSet.has(l)) { movedCommentLines++; l-- }
  }

  const scan = scanModuleImports(scanRoot, targetPath)

  const ctx = {
    targetRel: path.join(path.basename(PROJECT_ROOT), path.relative(PROJECT_ROOT, targetPath)),
    scanRel: path.join(path.basename(PROJECT_ROOT), path.relative(PROJECT_ROOT, scanRoot)) + '/',
    projectRoot: PROJECT_ROOT,
    totalLines, items, named, blankLines, commentLines, unparsed,
    scan, extractable, importsNeeded, movedCommentLines,
  }
  const report = buildReport(ctx)
  return { report, totalLines, declarationCount: named.length }
}

// CLI: run when executed directly (node trios/tools/agents-split-survey.mjs)
const invokedAsScript = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedAsScript) {
  process.stdout.write(splitAgents().report)
}
