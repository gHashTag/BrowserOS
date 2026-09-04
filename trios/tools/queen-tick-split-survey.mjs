#!/usr/bin/env node
/**
 * Split survey for trios/agent-server/apps/server/src/api/services/queen-tick.ts
 * (gHashTag/trios#1402).
 *
 * What this tool does:
 *   - Parses the target file with a small TypeScript-aware scanner (strings,
 *     template literals with ${...} interpolation, line/block comments, regex
 *     literals, and brace/paren/bracket depth are all tracked) and lists EVERY
 *     top-level declaration, exported or not, with its line range and length,
 *     sorted by length descending.
 *   - For each declaration, names the other top-level declarations of this
 *     file that it references, so a reader can see what would travel with it.
 *   - Marks declarations that reference nothing else in the file as
 *     independently extractable, and totals the lines those account for.
 *   - Names exactly ONE extraction: the largest independently extractable
 *     group, with the lines it would remove, the declarations that move, and
 *     every call site outside this file that would need its import changed.
 *     If no such group exists it says so plainly instead of proposing a split
 *     that would drag the whole file behind it.
 *   - Accounts for every line of the file: declaration bodies, attached doc
 *     comments, imports, blanks, standalone comments, and anything it could
 *     not classify (reported as `unparsed` with its line).
 *
 * Guarantees (from the issue's requirements):
 *   - FR-001: it reads and reports. It never writes or modifies any file.
 *   - FR-002: declarations are found by parsing the source text, never from a
 *     list written into this tool.
 *   - FR-003: a top-level construct the parser cannot classify is reported as
 *     `unparsed` with its line and counted separately.
 *   - FR-004: every number in the output is measured during the run.
 *   - FR-005: Node standard library only. No TypeScript compiler, no make,
 *     no build of any kind is invoked.
 *   - Deterministic: no clock, no randomness, all iteration is sorted. Two
 *     runs over an unedited tree print identical bytes.
 *
 * Usage:
 *   node trios/tools/queen-tick-split-survey.mjs             plain report
 *   node trios/tools/queen-tick-split-survey.mjs --markdown  markdown, for
 *                                                            docs/split/queen-tick-survey.md
 *
 * The survey entry point is the exported function splitQueenTick(); the CLI
 * only renders what it returns.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const DEFAULT_TARGET = join(
  REPO_ROOT,
  'trios',
  'agent-server',
  'apps',
  'server',
  'src',
  'api',
  'services',
  'queen-tick.ts',
)

/* ------------------------------------------------------------------ *
 * Scanner
 *
 * One linear pass over the text. A frame stack tracks lexical context:
 *   code    plain code (top level or nested)
 *   interp  an expression inside a template ${ ... }
 *   sq/dq   single/double quoted string
 *   tmpl    template literal text
 *   regex   regular expression literal (its braces never count as depth)
 *   lc/bc   line comment / block comment
 *
 * For every line it records whether it is blank / comment-only / literal-only,
 * the offset, mode and brace depth of its first code character, its last code
 * character, the brace depth at end of line, and a compact code prefix with
 * comments and string bodies removed (declaration detection reads the prefix).
 * It also records the line's analysis text - code and string characters with
 * comments and template literal text stripped - for reference analysis.
 * ------------------------------------------------------------------ */

function regexAllowedAfter(ch) {
  if (ch === '') return true
  return '=([{,;:!&|?+-*%^~<>'.includes(ch)
}

function scan(text) {
  const split = text.split('\n')
  const fileLines = text.endsWith('\n') ? split.length - 1 : split.length
  const meta = []
  for (let i = 0; i < split.length; i++) {
    meta.push({
      blank: false,
      comment: false, // a comment character appeared on this line
      literal: false, // template literal text appeared on this line
      hasCode: false,
      firstCodeOffset: -1,
      firstCodeMode: '',
      firstCodeDepth: 0,
      lastCodeChar: '',
      endDepth: 0,
      prefix: '',
      analysis: '',
    })
  }

  const stack = [{ t: 'code' }]
  let depth = 0
  let line = 1
  let esc = false
  let regexCls = false
  let lastSig = ''

  const n = text.length
  for (let i = 0; i < n; i++) {
    const c = text[i]
    if (c === '\n') {
      const m = meta[line - 1]
      m.endDepth = depth
      if (stack[stack.length - 1].t === 'lc') stack.pop()
      line++
      continue
    }
    const m = meta[line - 1]
    const top = stack[stack.length - 1]
    const t2 = i + 1 < n ? text[i + 1] : ''
    const isWs = c === ' ' || c === '\t' || c === '\r'

    const mark = (ch) => {
      lastSig = ch
      m.hasCode = true
      m.lastCodeChar = ch
      if (m.firstCodeOffset < 0) {
        m.firstCodeOffset = i
        m.firstCodeMode = top.t
        m.firstCodeDepth = depth
      }
      if (m.prefix.length < 120) m.prefix += ch
      m.analysis += ch
    }

    switch (top.t) {
      case 'lc':
        m.comment = true
        break
      case 'bc':
        m.comment = true
        if (c === '*' && t2 === '/') {
          stack.pop()
          i++
        }
        break
      case 'sq':
      case 'dq': {
        const q = top.t === 'sq' ? "'" : '"'
        if (esc) {
          esc = false
          m.analysis += c
        } else if (c === '\\') {
          esc = true
          m.analysis += c
        } else if (c === q) {
          stack.pop()
          lastSig = q
          m.hasCode = true
          m.lastCodeChar = q
          m.analysis += c
        } else {
          m.analysis += c
        }
        break
      }
      case 'tmpl':
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '`') {
          stack.pop()
          lastSig = '`'
          m.hasCode = true
          m.lastCodeChar = '`'
        } else if (c === '$' && t2 === '{') {
          stack.push({ t: 'interp', d: 0 })
          i++
        } else {
          m.literal = true
        }
        break
      case 'regex':
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (regexCls) {
          if (c === ']') regexCls = false
        } else if (c === '[') regexCls = true
        else if (c === '/') {
          stack.pop()
          lastSig = '/'
          m.hasCode = true
          m.lastCodeChar = '/'
        }
        break
      case 'code':
      case 'interp': {
        if (esc) {
          esc = false
          mark(c)
          break
        }
        if (isWs) {
          if (m.prefix.length > 0 && m.prefix.length < 120 && !m.prefix.endsWith(' ')) {
            m.prefix += ' '
          }
          m.analysis += c
          break
        }
        if (c === '\\') {
          esc = true
          break
        }
        if (c === "'" || c === '"') {
          stack.push({ t: c === "'" ? 'sq' : 'dq' })
          m.analysis += c
          break
        }
        if (c === '`') {
          stack.push({ t: 'tmpl' })
          break
        }
        if (c === '/' && t2 === '/') {
          stack.push({ t: 'lc' })
          i++
          break
        }
        if (c === '/' && t2 === '*') {
          stack.push({ t: 'bc' })
          i++
          break
        }
        if (top.t === 'code' && c === '/' && regexAllowedAfter(lastSig)) {
          stack.push({ t: 'regex' })
          break
        }
        if (c === '{') {
          if (top.t === 'code') depth++
          else top.d++
          mark(c)
          break
        }
        if (c === '}') {
          if (top.t === 'code') {
            depth--
            mark(c)
          } else if (top.d > 0) {
            top.d--
            mark(c)
          } else {
            // closes a ${ ... } interpolation; return to template text
            stack.pop()
            lastSig = '}'
            m.hasCode = true
            m.lastCodeChar = '}'
            m.analysis += c
          }
          break
        }
        if (top.t === 'code' && (c === '(' || c === '[')) depth++
        if (top.t === 'code' && (c === ')' || c === ']')) depth--
        mark(c)
        break
      }
      default:
        break
    }
  }
  if (line <= meta.length) meta[line - 1].endDepth = depth

  for (let i = 0; i < fileLines; i++) {
    const m = meta[i]
    m.blank = !m.comment && !m.literal && !m.hasCode
    m.commentOnly = m.comment && !m.hasCode && !m.literal
    m.literalOnly = m.literal && !m.hasCode && !m.comment
  }
  return { meta, fileLines }
}

/* ------------------------------------------------------------------ *
 * Top-level statement parsing
 * ------------------------------------------------------------------ */

const DECL_RE =
  /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\s*\*?|class|interface|enum|const|let|var|type)\s+(?:\*\s*)?([A-Za-z_$][A-Za-z0-9_$]*)/
const IMPORT_RE = /^import\b/
const EXPORT_LIST_RE = /^export\s*[{*]/
const EXPORT_DEFAULT_RE = /^export\s+default\b/

// A line whose last code character is one of these cannot end a statement:
// the next line continues it. The file uses no semicolons, so statement ends
// are found structurally, the way JavaScript itself inserts them.
const CONTINUATION_END_CHARS = new Set([
  '=', '(', '[', '{', ',', '|', '&', '+', '?', ':', '.', '>', '-', '*',
])

function statementContinues(meta, fromLine, nextLine, fileLines) {
  if (nextLine > fileLines) return false
  const prev = meta[fromLine - 1]
  const next = meta[nextLine - 1]
  if (prev.endDepth > 0) return true
  if (next.literalOnly) return true
  if (CONTINUATION_END_CHARS.has(prev.lastCodeChar)) return true
  return false
}

function statementEnd(meta, start, fileLines) {
  let end = start
  while (statementContinues(meta, end, end + 1, fileLines)) end++
  return end
}

function kindOf(keyword) {
  if (keyword.startsWith('function')) return 'function'
  return keyword
}

function parseTopLevel(meta, fileLines) {
  const declarations = []
  const imports = []
  const exportLists = []
  const unparsed = []
  let i = 1
  while (i <= fileLines) {
    const m = meta[i - 1]
    if (!m.hasCode || m.firstCodeDepth !== 0 || m.firstCodeMode !== 'code') {
      i++
      continue
    }
    const end = statementEnd(meta, i, fileLines)
    const trimmed = m.prefix.replace(/\s+$/, '')
    if (IMPORT_RE.test(trimmed)) {
      imports.push({ start: i, end })
    } else if (EXPORT_LIST_RE.test(trimmed) || EXPORT_DEFAULT_RE.test(trimmed)) {
      exportLists.push({ start: i, end })
    } else {
      const match = DECL_RE.exec(trimmed)
      const notATypeAlias =
        match &&
        match[1] === 'type' &&
        !/^\s*[=<]/.test(trimmed.slice(match.index + match[0].length))
      if (match && !notATypeAlias) {
        declarations.push({
          name: match[2],
          kind: kindOf(match[1].trim()),
          exported: /^export\b/.test(trimmed),
          codeStart: i,
          codeEnd: end,
        })
      } else {
        unparsed.push({ start: i, end })
      }
    }
    i = end + 1
  }

  // Attach contiguous comment lines immediately above a statement to it as
  // its doc comment. A blank line between the comment and the statement
  // breaks the attachment, so the file's header comment stays standalone.
  const spans = [
    ...declarations.map((d) => ({ start: d.codeStart, end: d.codeEnd, decl: d })),
    ...imports,
    ...exportLists,
    ...unparsed,
  ]
  spans.sort((a, b) => a.start - b.start)
  for (const s of spans) {
    let d = s.start - 1
    while (d >= 1 && meta[d - 1].commentOnly) d--
    s.docStart = d + 1
  }
  return { declarations, imports, exportLists, unparsed, spans }
}

/* ------------------------------------------------------------------ *
 * Reference analysis
 * ------------------------------------------------------------------ */

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function referenceRegexSource(name) {
  // A reference is an identifier occurrence that is not a property access
  // (`.name` / `?.name`) and not part of a longer identifier. `...name` IS a
  // reference (spread call), so it is allowed explicitly. Comments and
  // template literal text were already stripped by the scanner; string
  // contents are kept (in this file no string body names a declaration).
  return `(?:(?<=\\.\\.\\.)|(?<![\\w$.]))${escapeRegExp(name)}\\b`
}

function referenceRegex(name) {
  return new RegExp(referenceRegexSource(name))
}

function assignsTo(analysis, name) {
  // An assignment to the binding itself: `name =` that is not `==`, `=>`,
  // `<=`, `>=`, `!=`, and not a type annotation (`const x: Type = ...`).
  // This matters because an imported ESM binding is read-only, so a
  // declaration assigned elsewhere cannot move alone.
  const re = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*=(?![=>])`, 'g')
  let match
  while ((match = re.exec(analysis))) {
    const before = analysis.slice(Math.max(0, match.index - 8), match.index)
    if (/:\s*$/.test(before)) continue // `x: Name = ...` is an annotation
    return true
  }
  return false
}

function analysisText(meta, start, end) {
  let out = ''
  for (let l = start; l <= end; l++) out += meta[l - 1].analysis + '\n'
  return out
}

function analyzeReferences(meta, declarations) {
  const byName = new Map(declarations.map((d) => [d.name, d]))
  for (const d of declarations) {
    d.analysis = analysisText(meta, d.codeStart, d.codeEnd)
    d.refs = []
  }
  for (const d of declarations) {
    for (const other of declarations) {
      if (other.name !== d.name && referenceRegex(other.name).test(d.analysis)) {
        d.refs.push(other.name)
      }
    }
  }
  for (const d of declarations) {
    d.assignedBy = declarations
      .filter((o) => o.name !== d.name && assignsTo(o.analysis, d.name))
      .map((o) => o.name)
    d.refBy = declarations
      .filter((o) => o.name !== d.name && o.refs.includes(d.name))
      .map((o) => o.name)
  }
  return byName
}

function closureOf(startName, byName) {
  const seen = new Set()
  const stack = [startName]
  while (stack.length > 0) {
    const name = stack.pop()
    if (seen.has(name)) continue
    seen.add(name)
    const d = byName.get(name)
    if (d) for (const r of d.refs) if (!seen.has(r)) stack.push(r)
  }
  return seen
}

/* ------------------------------------------------------------------ *
 * Call sites outside the file
 * ------------------------------------------------------------------ */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.cache', '.turbo', '.worktrees', '.venv',
])
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])

function walkSources(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkSources(full, out)
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf('.')
      const ext = dot >= 0 ? e.name.slice(dot) : ''
      if (SOURCE_EXTS.has(ext)) out.push(full)
    }
  }
}

// A module specifier is a quoted string whose last path segment is exactly
// "queen-tick", preceded by a path separator. This covers `from
// './queen-tick'`, dynamic `import('...queen-tick')`, and path constants
// later handed to a dynamic import. The bare string 'queen-tick' used as a
// lease NAME or a PM2 process id does not match, because it has no slash.
const SPECIFIER_RE = /['"]([^'"\n]*\/queen-tick)['"]/

function findCallSites(root, targetAbs, movedNames) {
  const files = []
  walkSources(root, files)
  const results = []
  const untouched = []
  for (const file of files) {
    if (resolve(file) === resolve(targetAbs)) continue
    // This survey quotes the module specifier in its own documentation;
    // it is not a call site of the module it surveys.
    if (resolve(file) === resolve(SCRIPT_DIR, 'queen-tick-split-survey.mjs')) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!text.includes('queen-tick')) continue
    const lines = text.split('\n')
    const specifierLines = []
    for (let i = 0; i < lines.length; i++) {
      const match = SPECIFIER_RE.exec(lines[i])
      if (match) specifierLines.push(i + 1)
    }
    if (specifierLines.length === 0) continue
    // Match usage against comment-stripped text: a name mentioned only in a
    // comment is not a call site.
    const stripped = scan(text).meta.map((m) => m.analysis).join('\n')
    const used = movedNames.filter((name) => referenceRegex(name).test(stripped))
    const entry = {
      file: relative(root, file).split(sep).join('/'),
      importLines: specifierLines,
      usedMovedNames: used,
    }
    if (used.length > 0) results.push(entry)
    else untouched.push(entry.file)
  }
  results.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  untouched.sort()
  return { importing: results, noChangeNeeded: untouched }
}

/* ------------------------------------------------------------------ *
 * The survey
 * ------------------------------------------------------------------ */

export function splitQueenTick(options = {}) {
  const targetPath = options.targetPath || DEFAULT_TARGET
  const root = options.root || REPO_ROOT
  const text = readFileSync(targetPath, 'utf8')
  const targetRel = relative(root, targetPath).split(sep).join('/')

  const { meta, fileLines } = scan(text)
  const { declarations, imports, exportLists, unparsed, spans } = parseTopLevel(meta, fileLines)
  const byName = analyzeReferences(meta, declarations)

  // Line accounting: every line of the file lands in exactly one bucket.
  const buckets = {
    declCode: 0,
    declDoc: 0,
    import: 0,
    blank: 0,
    comment: 0,
    exportList: 0,
    unparsed: 0,
  }
  const strayUnparsedLines = []
  const lineBucket = new Array(fileLines + 1).fill(null)
  for (const s of spans) {
    if (!s.decl) continue
    for (let l = s.start; l <= s.end; l++) {
      lineBucket[l] = 'declCode'
      buckets.declCode++
    }
    for (let l = s.docStart; l < s.start; l++) {
      lineBucket[l] = 'declDoc'
      buckets.declDoc++
    }
  }
  for (const s of imports) {
    for (let l = s.start; l <= s.end; l++) {
      lineBucket[l] = 'import'
      buckets.import++
    }
  }
  for (const s of exportLists) {
    for (let l = s.start; l <= s.end; l++) {
      lineBucket[l] = 'exportList'
      buckets.exportList++
    }
  }
  for (const s of unparsed) {
    for (let l = s.start; l <= s.end; l++) {
      lineBucket[l] = 'unparsed'
      buckets.unparsed++
    }
  }
  for (let l = 1; l <= fileLines; l++) {
    if (lineBucket[l] !== null) continue
    const m = meta[l - 1]
    if (m.blank) {
      lineBucket[l] = 'blank'
      buckets.blank++
    } else if (m.commentOnly) {
      lineBucket[l] = 'comment'
      buckets.comment++
    } else {
      // A code or literal line the statement parser never claimed.
      lineBucket[l] = 'unparsed'
      buckets.unparsed++
      strayUnparsedLines.push(l)
    }
  }

  // Declaration lengths.
  for (const d of declarations) {
    const span = spans.find((s) => s.decl === d)
    d.docStart = span.docStart
    d.docLines = d.codeStart - d.docStart
    d.codeLines = d.codeEnd - d.codeStart + 1
    d.lines = d.codeLines + d.docLines
    d.spanText =
      d.docStart < d.codeStart ? `${d.docStart}-${d.codeEnd}` : `${d.codeStart}-${d.codeEnd}`
  }
  const sorted = [...declarations].sort(
    (a, b) => b.lines - a.lines || a.codeStart - b.codeStart,
  )

  const declLineTotal = buckets.declCode + buckets.declDoc
  const accountedTotal =
    buckets.declCode + buckets.declDoc + buckets.import + buckets.blank +
    buckets.comment + buckets.exportList + buckets.unparsed

  // Independently extractable: references no other declaration in this file.
  const extractable = declarations.filter((d) => d.refs.length === 0)
  const extractableLines = extractable.reduce((sum, d) => sum + d.lines, 0)
  const blockedByAssignment = extractable
    .filter((d) => d.assignedBy.length > 0)
    .map((d) => ({
      name: d.name,
      assignedBy: [...d.assignedBy].sort(),
      reason:
        'references nothing else in this file, but another declaration ' +
        'assigns it, and an imported ESM binding is read-only - it can move ' +
        'only together with its assigner',
    }))

  // Closed groups: a declaration plus everything it references, transitively.
  const groupMap = new Map()
  for (const d of declarations) {
    const closure = closureOf(d.name, byName)
    const key = [...closure].sort().join(',')
    if (!groupMap.has(key)) groupMap.set(key, { names: closure, anchors: [] })
    groupMap.get(key).anchors.push(d.name)
  }
  const groups = [...groupMap.values()]
    .map((g) => {
      const members = [...g.names]
        .map((n) => byName.get(n))
        .sort((a, b) => b.lines - a.lines || a.codeStart - b.codeStart)
      return {
        names: members.map((m) => m.name),
        anchors: [...g.anchors].sort(),
        lines: members.reduce((sum, m) => sum + m.lines, 0),
        isWholeFile: members.length === declarations.length,
      }
    })
    .sort(
      (a, b) =>
        b.lines - a.lines || (a.names.join(',') < b.names.join(',') ? -1 : 1),
    )

  // The recommendation: the largest independently extractable group. Every
  // declaration that references nothing else in the file can move together
  // with no severed dependencies, so that set is the group - except any
  // declaration another declaration assigns (an imported binding is
  // read-only; those can move only with their assigner).
  const movable = extractable
    .filter((d) => d.assignedBy.length === 0)
    .sort((a, b) => b.lines - a.lines || a.codeStart - b.codeStart)
  const recommendation = {
    kind: movable.length > 0 ? 'group' : 'none',
    names: movable.map((d) => d.name),
    lines: movable.reduce((sum, d) => sum + d.lines, 0),
    codeLines: movable.reduce((sum, d) => sum + d.codeLines, 0),
    excluded: blockedByAssignment,
  }
  if (movable.length > 0) {
    const movedSet = new Set(movable.map((d) => d.name))
    recommendation.internalImporters = movable
      .filter((d) => d.refBy.some((n) => !movedSet.has(n)))
      .map((d) => ({
        name: d.name,
        importedBy: d.refBy.filter((n) => !movedSet.has(n)).sort(),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
    const movedExported = movable.filter((d) => d.exported).map((d) => d.name)
    recommendation.exportedNames = movedExported
    const sites = findCallSites(root, targetPath, movedExported)
    recommendation.callSites = sites.importing
    recommendation.callSitesNoChangeNeeded = sites.noChangeNeeded
  }

  return {
    target: targetRel,
    fileLines,
    declarations: sorted.map((d) => ({
      name: d.name,
      kind: d.kind,
      exported: d.exported,
      lines: d.lines,
      codeLines: d.codeLines,
      docLines: d.docLines,
      span: d.spanText,
      refs: [...d.refs].sort(),
      refBy: [...d.refBy].sort(),
      assignedBy: [...d.assignedBy].sort(),
    })),
    counts: {
      declarations: declarations.length,
      exported: declarations.filter((d) => d.exported).length,
      unparsedSpans: unparsed.length,
      unparsedStrayLines: strayUnparsedLines.length,
      unparsedLines: buckets.unparsed,
    },
    unparsed: [
      ...unparsed.map((u) => ({ start: u.start, end: u.end })),
      ...strayUnparsedLines.map((l) => ({ start: l, end: l })),
    ],
    extractable: {
      names: extractable.map((d) => d.name).sort(),
      count: extractable.length,
      lines: extractableLines,
    },
    blockedByAssignment,
    groups,
    recommendation,
    accounting: {
      ...buckets,
      declLineTotal,
      accountedTotal,
      agreesWithFileLines: accountedTotal === fileLines,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderPlain(s) {
  const out = []
  const push = (...xs) => out.push(...xs)
  push('queen-tick split survey')
  push('=======================')
  push(`target: ${s.target}`)
  push(`file lines (measured this run): ${s.fileLines}`)
  push(
    `declarations found: ${s.counts.declarations} ` +
    `(exported: ${s.counts.exported}, not exported: ${s.counts.declarations - s.counts.exported})`,
  )
  push(
    `unparsed: ${s.counts.unparsedSpans + s.counts.unparsedStrayLines} constructs, ` +
    `${s.counts.unparsedLines} lines`,
  )
  push('')
  push('Every top-level declaration, sorted by length descending')
  push('(lines = code + attached doc comments; refs = other declarations in this file it references)')
  push('')
  const nameWidth = Math.max(...s.declarations.map((d) => d.name.length), 4)
  push(
    '  lines  code  doc  kind        exp   name' +
      ' '.repeat(Math.max(1, nameWidth - 4)) +
      'span        refs in this file',
  )
  for (const d of s.declarations) {
    const refs = d.refs.length > 0 ? d.refs.join(', ') : '(none)'
    const pad = ' '.repeat(Math.max(1, nameWidth - d.name.length))
    push(
      `  ${String(d.lines).padStart(5)}  ${String(d.codeLines).padStart(4)}  ${String(d.docLines).padStart(3)}  ` +
        `${d.kind.padEnd(11)}  ${(d.exported ? 'yes' : 'no ').padEnd(5)}  ${d.name}${pad}` +
        `${d.span.padEnd(10)}  ${refs}`,
    )
  }
  push('')
  const a = s.accounting
  push('Independently extractable (references nothing else in this file)')
  push(
    `  ${s.extractable.count} declarations, ${s.extractable.lines} lines ` +
      `of ${a.declLineTotal} declaration lines ` +
      `(${((100 * s.extractable.lines) / a.declLineTotal).toFixed(1)}%)`,
  )
  push(`  ${s.extractable.names.join(', ')}`)
  for (const b of s.blockedByAssignment) {
    push(
      `  note: ${b.name} is independently extractable but ${b.assignedBy.join(', ')} ` +
        `assigns it - it cannot move alone (an imported binding is read-only)`,
    )
  }
  push('')
  push('Unparsed (top-level constructs this parser could not classify)')
  if (s.unparsed.length === 0) {
    push('  none - every top-level code line was classified')
  } else {
    for (const u of s.unparsed) {
      push(`  lines ${u.start}${u.end !== u.start ? `-${u.end}` : ''}`)
    }
  }
  push('')
  push('Closed groups: a declaration plus everything it references, transitively (data, not recommendations)')
  push('  lines  members  whole-file?  group ([anchors] -> members)')
  for (const g of s.groups) {
    push(
      `  ${String(g.lines).padStart(5)}  ${String(g.names.length).padStart(7)}  ` +
        `${(g.isWholeFile ? 'yes' : 'no ').padEnd(11)}  ` +
        `[${g.anchors.join(', ')}] -> ${g.names.join(', ')}`,
    )
  }
  push('')
  push('RECOMMENDED EXTRACTION - one move')
  const r = s.recommendation
  if (r.kind === 'none') {
    push('  No group is independently extractable: every declaration references')
    push('  another declaration in this file, and the closed groups above show')
    push('  that moving any one of them drags the rest of the file behind it.')
    push('  No split is proposed.')
  } else {
    const share = ((100 * r.lines) / s.fileLines).toFixed(1)
    push(
      '  The largest independently extractable group: every declaration that',
      '  references nothing else in this file, moved together into one new module.',
    )
    push(
      `  lines it would remove from queen-tick.ts: ${r.lines} ` +
        `(${share}% of the file's ${s.fileLines} lines; ${r.codeLines} of them code)`,
    )
    push(`  declarations that move (${r.names.length}):`)
    for (const d of s.declarations.filter((x) => r.names.includes(x.name))) {
      push(
        `    ${d.name} (${d.kind}, ${d.lines} lines, ${d.span}${d.exported ? ', exported' : ''})`,
      )
    }
    for (const x of r.excluded) {
      push(`  stays behind although independently extractable: ${x.name} - ${x.reason}`)
    }
    if (r.internalImporters && r.internalImporters.length > 0) {
      push('  references inside queen-tick.ts that become imports of the new module:')
      for (const im of r.internalImporters) {
        push(`    ${im.name} <- ${im.importedBy.join(', ')}`)
      }
    }
    push('  call sites outside this file that would need an import change:')
    if (r.callSites.length === 0) {
      push('    none - no file outside queen-tick.ts imports any moved exported name')
    } else {
      for (const cs of r.callSites) {
        push(
          `    ${cs.file}:${cs.importLines.join(',')} - imports ${cs.usedMovedNames.join(', ')}`,
        )
      }
      if (r.callSitesNoChangeNeeded.length > 0) {
        push('    files importing queen-tick but no moved name - no change needed:')
        push(`      ${r.callSitesNoChangeNeeded.join(', ')}`)
      }
    }
  }
  push('')
  push('Line accounting - every line of the file is in exactly one bucket')
  push(`  declaration code lines:      ${String(a.declCode).padStart(5)}`)
  push(`  attached doc comment lines:  ${String(a.declDoc).padStart(5)}`)
  push(`  import statement lines:      ${String(a.import).padStart(5)}`)
  push(`  blank lines:                 ${String(a.blank).padStart(5)}`)
  push(`  standalone comment lines:    ${String(a.comment).padStart(5)}`)
  push(`  export-list lines:           ${String(a.exportList).padStart(5)}`)
  push(`  unparsed lines:              ${String(a.unparsed).padStart(5)}`)
  push(`  total:                       ${String(a.accountedTotal).padStart(5)}`)
  push(`  file lines (measured):       ${String(s.fileLines).padStart(5)}`)
  push(
    `  declaration lines + unparsed = ${a.declLineTotal} + ${a.unparsed} = ${a.declLineTotal + a.unparsed} of ${s.fileLines};`,
  )
  push(
    `  the remaining ${s.fileLines - a.declLineTotal - a.unparsed} are imports (${a.import}), blanks (${a.blank}), standalone comments (${a.comment}) and export lists (${a.exportList})`,
  )
  push(`  accounting agrees with the file line count: ${a.agreesWithFileLines ? 'yes' : 'NO'}`)
  push('')
  push('Determinism: no clocks, no randomness, sorted iteration everywhere.')
  push('Two runs over an unedited tree print identical bytes.')
  return out.join('\n') + '\n'
}

function renderMarkdown(s) {
  const out = []
  const push = (x) => out.push(x)
  const a = s.accounting
  push(`Target: \`${s.target}\` - ${s.fileLines} lines, measured this run.`)
  push('')
  push(
    `Declarations found: **${s.counts.declarations}** ` +
      `(${s.counts.exported} exported, ${s.counts.declarations - s.counts.exported} not; ` +
      `unparsed: ${s.counts.unparsedSpans + s.counts.unparsedStrayLines}).`,
  )
  push('')
  push('## What the file contains')
  push('')
  push(
    'Every top-level declaration, sorted by length descending. `lines` is code plus ' +
      'attached doc comments; `refs` names the other top-level declarations of this ' +
      'file it references - what would travel with it.',
  )
  push('')
  push('| lines | code | doc | kind | exported | name | span | refs in this file |')
  push('|---:|---:|---:|---|---|---|---|---|')
  for (const d of s.declarations) {
    push(
      `| ${d.lines} | ${d.codeLines} | ${d.docLines} | ${d.kind} | ${d.exported ? 'yes' : 'no'} | \`${d.name}\` | ${d.span} | ` +
        (d.refs.length > 0 ? d.refs.map((r) => `\`${r}\``).join(', ') : '(none)') +
        ' |',
    )
  }
  push('')
  push('## Independently extractable')
  push('')
  push(
    `**${s.extractable.count}** declarations reference nothing else in this file and account for ` +
      `**${s.extractable.lines}** of ${a.declLineTotal} declaration lines ` +
      `(${((100 * s.extractable.lines) / a.declLineTotal).toFixed(1)}%):`,
  )
  push('')
  for (const name of s.extractable.names) {
    const d = s.declarations.find((x) => x.name === name)
    push(`- \`${name}\` (${d.kind}, ${d.lines} lines, ${d.span}${d.exported ? ', exported' : ''})`)
  }
  for (const b of s.blockedByAssignment) {
    push('')
    push(
      `\`${b.name}\` counts as independently extractable above, but ${b.assignedBy.join(', ')} ` +
        'assigns it, and an imported ESM binding is read-only - it can move only together ' +
        'with its assigner.',
    )
  }
  push('')
  push('## Unparsed')
  push('')
  if (s.unparsed.length === 0) {
    push('None. Every top-level code line was classified.')
  } else {
    for (const u of s.unparsed) {
      push(`- lines ${u.start}${u.end !== u.start ? `-${u.end}` : ''}`)
    }
  }
  push('')
  push('## Closed groups (data, not recommendations)')
  push('')
  push(
    'A closed group is a declaration plus everything it references, transitively - ' +
      'the smallest set that could move to one new module together. Groups covering the ' +
      'whole file are marked: they are not extractions, they are the file.',
  )
  push('')
  push('| lines | members | whole file | group ([anchors] -> members) |')
  push('|---:|---:|---|---|')
  for (const g of s.groups) {
    push(
      `| ${g.lines} | ${g.names.length} | ${g.isWholeFile ? 'yes' : 'no'} | [${g.anchors.join(', ')}] ${g.names.map((n) => `\`${n}\``).join(', ')} |`,
    )
  }
  push('')
  push('## The one recommended extraction')
  push('')
  const r = s.recommendation
  if (r.kind === 'none') {
    push(
      '**No group is independently extractable.** Every declaration references another ' +
        'declaration in this file, and the closed groups above show that moving any one ' +
        'of them drags the rest of the file behind it. No split is proposed.',
    )
  } else {
    const share = ((100 * r.lines) / s.fileLines).toFixed(1)
    push(
      `**The largest independently extractable group**: every declaration that references ` +
        `nothing else in this file, moved together into one new module. It removes ` +
        `**${r.lines} lines** (${share}% of the file's ${s.fileLines}; ${r.codeLines} of them ` +
        `code) and severs no internal dependency.`,
    )
    push('')
    push(`Declarations that move (${r.names.length}):`)
    push('')
    for (const d of s.declarations.filter((x) => r.names.includes(x.name))) {
      push(`- \`${d.name}\` (${d.kind}, ${d.lines} lines, ${d.span}${d.exported ? ', exported' : ''})`)
    }
    for (const x of r.excluded) {
      push('')
      push(`\`${x.name}\` stays behind: ${x.reason}.`)
    }
    if (r.internalImporters && r.internalImporters.length > 0) {
      push('')
      push('References inside `queen-tick.ts` that become imports of the new module:')
      push('')
      for (const im of r.internalImporters) {
        push(`- \`${im.name}\` <- ${im.importedBy.map((n) => `\`${n}\``).join(', ')}`)
      }
    }
    push('')
    push('Call sites outside this file that would need an import change:')
    push('')
    if (r.callSites.length === 0) {
      push('- none - no file outside `queen-tick.ts` imports any moved exported name')
    } else {
      for (const cs of r.callSites) {
        push(
          `- \`${cs.file}\` (import lines ${cs.importLines.join(', ')}) imports ` +
            `${cs.usedMovedNames.map((n) => `\`${n}\``).join(', ')}`,
        )
      }
      if (r.callSitesNoChangeNeeded.length > 0) {
        push('')
        push(
          'Files that import `queen-tick` but use no moved name need no change: ' +
            r.callSitesNoChangeNeeded.map((f) => `\`${f}\``).join(', ') +
            '.',
        )
      }
    }
  }
  push('')
  push('## Line accounting')
  push('')
  push('| bucket | lines |')
  push('|---|---:|')
  push(`| declaration code | ${a.declCode} |`)
  push(`| attached doc comments | ${a.declDoc} |`)
  push(`| import statements | ${a.import} |`)
  push(`| blank | ${a.blank} |`)
  push(`| standalone comments | ${a.comment} |`)
  push(`| export lists | ${a.exportList} |`)
  push(`| unparsed | ${a.unparsed} |`)
  push(`| **total** | **${a.accountedTotal}** |`)
  push(`| file lines (measured) | ${s.fileLines} |`)
  push('')
  push(
    `Declaration lines plus unparsed = ${a.declLineTotal} + ${a.unparsed} = ${a.declLineTotal + a.unparsed} ` +
      `of ${s.fileLines}; the remaining ${s.fileLines - a.declLineTotal - a.unparsed} are imports ` +
      `(${a.import}), blanks (${a.blank}), standalone comments (${a.comment}) and export lists ` +
      `(${a.exportList}). The accounting ${a.agreesWithFileLines ? 'agrees' : 'DOES NOT agree'} with ` +
      `the file's own line count.`,
  )
  push('')
  return out.join('\n') + '\n'
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  const markdown = process.argv.includes('--markdown')
  let survey
  try {
    survey = splitQueenTick()
  } catch (error) {
    process.stderr.write(
      `queen-tick-split-survey: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
  if (survey) {
    process.stdout.write(markdown ? renderMarkdown(survey) : renderPlain(survey))
  }
}
