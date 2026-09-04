#!/usr/bin/env node
// browser-split-survey.mjs
//
// A read-only survey of one TypeScript module: trios/agent-server/apps/server/src/browser/browser.ts
//
// What it does (and deliberately nothing more):
//   1. Parses the source text and lists EVERY top-level declaration (imports,
//      interfaces, types, consts, classes, functions, enums - exported or not)
//      with its line range and length, sorted by length, longest first.
//   2. For each declaration, names the other top-level declarations of the same
//      file that it references (code references only - comments and string
//      contents are excluded), so a reader can see what would travel with it.
//   3. Marks declarations that reference nothing else in the file as
//      independently extractable and totals the lines they account for.
//   4. Recommends exactly ONE extraction: the largest set of declarations that
//      can move to another module without dragging any other declaration of
//      this file along, together with every call site outside this file that
//      imports a moved name. If no such set exists, it says so plainly.
//   5. Accounts for every line of the file: declaration lines + unparsed lines
//      must equal the file's own line count.
//
// Constraints it obeys:
//   - It never writes anything. It reads files and prints a report (FR-001).
//   - Declarations are found by parsing the source text on every run, never
//     from a list written into this tool (FR-002).
//   - Top-level lines it cannot classify are reported as `unparsed` with their
//     line numbers and counted separately (FR-003).
//   - Every number in the output is measured during the run (FR-004).
//   - Runs under `node` with the Node standard library only: no TypeScript
//     compiler, no `make`, no build step, no third-party packages (FR-005).
//   - Output is byte-identical across runs on an unchanged tree: no
//     timestamps, no absolute paths, every list sorted deterministically.
//
// Usage:
//   node trios/tools/browser-split-survey.mjs            # survey browser.ts
//   node trios/tools/browser-split-survey.mjs <file.ts>  # survey another file

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// --------------------------------------------------------------------------
// Source scanner: brace depth + a sanitized copy of each line in which
// comments, string contents and template-literal contents are blanked out.
// Braces inside strings/templates do not affect depth; braces inside template
// literals are ignored entirely (their `${...}` pairs are self-balancing, and
// template TEXT may legally contain unbalanced braces).
// --------------------------------------------------------------------------

function scanSource(text) {
  const lines = text.split('\n')
  const code = []
  const depthAtStart = new Array(lines.length).fill(0)
  let state = 'normal' // normal | sq | dq | tpl | block
  let depth = 0

  for (let i = 0; i < lines.length; i++) {
    depthAtStart[i] = depth
    const src = lines[i]
    const out = src.split('')
    let j = 0
    while (j < src.length) {
      const c = src[j]
      const n = j + 1 < src.length ? src[j + 1] : ''
      if (state === 'block') {
        out[j] = ' '
        if (c === '*' && n === '/') {
          out[j + 1] = ' '
          state = 'normal'
          j += 2
          continue
        }
        j++
        continue
      }
      if (state === 'sq' || state === 'dq') {
        out[j] = ' '
        if (c === '\\') {
          if (j + 1 < src.length) out[j + 1] = ' '
          j += 2
          continue
        }
        if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) {
          state = 'normal'
        }
        j++
        continue
      }
      if (state === 'tpl') {
        out[j] = ' '
        if (c === '\\') {
          if (j + 1 < src.length) out[j + 1] = ' '
          j += 2
          continue
        }
        if (c === '`') state = 'normal'
        j++
        continue
      }
      // normal state
      if (c === '/' && n === '/') {
        for (let k = j; k < src.length; k++) out[k] = ' '
        break
      }
      if (c === '/' && n === '*') {
        out[j] = ' '
        out[j + 1] = ' '
        state = 'block'
        j += 2
        continue
      }
      if (c === "'") {
        out[j] = ' '
        state = 'sq'
        j++
        continue
      }
      if (c === '"') {
        out[j] = ' '
        state = 'dq'
        j++
        continue
      }
      if (c === '`') {
        out[j] = ' '
        state = 'tpl'
        j++
        continue
      }
      if (c === '{') depth++
      else if (c === '}') depth--
      j++
    }
    code.push(out.join(''))
  }
  return { lines, code, depthAtStart }
}

// --------------------------------------------------------------------------
// Top-level declaration discovery. Top-level TypeScript declarations start in
// column 0, so detection runs on raw lines whose brace depth is 0.
// --------------------------------------------------------------------------

const DECL_RE =
  /^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|enum|type|const|let|var)[\s]*([\s\S]*)$/
const IMPORT_RE = /^(import)\b/
const EXPORT_FROM_RE = /^export\s+([{*])/
const FROM_SPEC_RE = /from\s+['"]([^'"]+)['"]/
const SIDE_EFFECT_IMPORT_RE = /^import\s*['"]([^'"]+)['"]/

function isIdentifier(s) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)
}

// Does this raw line start a new top-level declaration (column 0)?
function declKindOf(rawLine) {
  if (IMPORT_RE.test(rawLine)) return 'import'
  if (EXPORT_FROM_RE.test(rawLine)) return 'export-from'
  const m = DECL_RE.exec(rawLine)
  if (m) {
    const kw = m[6]
    const rest = m[7] || ''
    let name = ''
    if (kw === 'function') name = (/^([\w$]+)/.exec(rest) || [''])[0]
    else if (kw === 'function*') name = (/^\*?\s*([\w$]+)/.exec(rest) || ['', ''])[1] || ''
    else name = (/^([\w$]+)/.exec(rest) || [''])[0]
    return { keyword: kw, name, exported: Boolean(m[1]) }
  }
  return null
}

function findDeclarations({ lines, code, depthAtStart }) {
  const n = lines.length
  const decls = []
  const unclassified = [] // FR-003: top-level lines the parser cannot classify
  let i = 0

  const isDeclStartLine = (idx) =>
    depthAtStart[idx] === 0 && declKindOf(lines[idx]) !== null

  while (i < n) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (depthAtStart[i] !== 0 || trimmed === '' || raw.startsWith('//')) {
      i++
      continue
    }
    // A top-level block comment of its own is not a declaration; skip it.
    if (raw.startsWith('/*')) {
      i++
      continue
    }
    const kind = declKindOf(raw)
    if (!kind) {
      // FR-003: report and count separately, then move on line by line.
      if (code[i].trim() !== '') {
        unclassified.push({ line: i + 1, preview: trimmed.slice(0, 60) })
      }
      i++
      continue
    }

    let startIdx = i
    let endIdx = i
    let name = ''
    let exported = false
    let keyword = kind

    if (kind === 'import' || kind === 'export-from') {
      // The statement ends on the line that carries the module specifier.
      exported = true
      let spec = ''
      for (let j = i; j < n; j++) {
        const side = SIDE_EFFECT_IMPORT_RE.exec(lines[j])
        const from = FROM_SPEC_RE.exec(lines[j])
        if (side) {
          spec = side[1]
          endIdx = j
          break
        }
        if (from) {
          spec = from[1]
          endIdx = j
          break
        }
        endIdx = j
      }
      name = spec
    } else {
      keyword = kind.keyword
      name = kind.name
      exported = kind.exported
      if (name === '' || !isIdentifier(name)) {
        // Destructuring or otherwise not a plain identifier - keep it, but
        // flag it so it never takes part in reference analysis.
        name = kind.name === '' ? '(unnamed)' : kind.name
      }
      // Find the end: either the brace that opened closes again, or (for
      // brace-less declarations) the line before the next declaration start.
      // The next-declaration check must run BEFORE counting that line's
      // braces, or a brace-less declaration swallows the next one's opening.
      let d = 0
      let sawBrace = false
      for (let j = i; j < n; j++) {
        if (j > i && !sawBrace && isDeclStartLine(j)) {
          endIdx = j - 1
          break
        }
        for (const ch of code[j]) {
          if (ch === '{') {
            d++
            sawBrace = true
          } else if (ch === '}') {
            d--
          }
        }
        if (sawBrace && d <= 0) {
          endIdx = j
          break
        }
        endIdx = j
      }
      // Give back trailing blank lines; they are separators, not declaration.
      while (endIdx > startIdx && lines[endIdx].trim() === '') endIdx--
    }

    const text = lines.slice(startIdx, endIdx + 1).join('\n')
    const codeText = code.slice(startIdx, endIdx + 1).join('\n')
    decls.push({
      kind: keyword,
      name,
      exported,
      startLine: startIdx + 1, // 1-based, inclusive
      endLine: endIdx + 1, // 1-based, inclusive
      length: endIdx - startIdx + 1,
      text,
      codeText,
      isImportLike: kind === 'import' || kind === 'export-from',
      hasIdentifierName: isIdentifier(name) && kind !== 'import' && kind !== 'export-from',
    })
    i = endIdx + 1
  }
  return { decls, unclassified }
}

// --------------------------------------------------------------------------
// Reference analysis: which top-level declarations does each declaration name
// in its CODE (comments and string contents excluded)?
// --------------------------------------------------------------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function analyzeReferences(decls) {
  const named = decls.filter((d) => d.hasIdentifierName)
  for (const d of decls) d.refs = []
  for (const d of named) {
    d.refs = named
      .filter((e) => e !== d && new RegExp(`\\b${escapeRegExp(e.name)}\\b`).test(d.codeText))
      .map((e) => e.name)
  }
  return named
}

// --------------------------------------------------------------------------
// Extraction analysis.
//
// A single declaration is "independently extractable" when it references no
// other top-level declaration of this file: it can move without company.
//
// A GROUP is a set of declarations that can move together without dragging
// anything else: no member may reference a declaration that stays behind.
// The recommended extraction is the largest such group smaller than the whole
// file (moving everything is not a split). It is found by keeping a minimal
// "stays" set and checking closure - enumerated exhaustively for small files.
// --------------------------------------------------------------------------

const MAX_ENUMERATE = 16

function largestExtractableGroup(named) {
  const n = named.length
  if (n < 2) return null
  const lines = (list) => list.reduce((acc, d) => acc + d.length, 0)
  if (n > MAX_ENUMERATE) return { skipped: true, reason: `more than ${MAX_ENUMERATE} declarations; exhaustive search skipped` }

  let best = null
  for (let keptMask = 1; keptMask < (1 << n) - 1; keptMask++) {
    const kept = []
    const moved = []
    for (let b = 0; b < n; b++) ((keptMask >> b) & 1 ? kept : moved).push(named[b])
    const keptNames = new Set(kept.map((d) => d.name))
    const closed = moved.every((d) => d.refs.every((r) => !keptNames.has(r)))
    if (!closed) continue
    const movedLines = lines(moved)
    const better =
      best === null ||
      movedLines > best.movedLines ||
      (movedLines === best.movedLines &&
        (moved.length < best.moved.length ||
          (moved.length === best.moved.length &&
            moved.map((d) => d.name).join(',') < best.moved.map((d) => d.name).join(','))))
    if (better) {
      best = { kept, moved, movedLines, keptLines: lines(kept) }
    }
  }
  return best
}

// --------------------------------------------------------------------------
// Call-site scan: every file outside the surveyed one that imports the module
// and names one of the moved declarations would need its import changed.
// Node standard library only - a plain recursive walk, sorted for determinism.
// --------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.turbo', '.next', '.cache',
])
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])
const STATIC_FROM_RE =
  /(?:^|[;\n])(?:import|export)\s+(?:type\s+)?[\w$*{}\s,]*?from\s*['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function walkFiles(root, acc) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  // Sort for deterministic output regardless of filesystem order.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.' && e.name !== '..' && SKIP_DIRS.has(e.name)) continue
    const p = join(root, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walkFiles(p, acc)
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf('.')
      if (dot !== -1 && SCAN_EXTS.has(e.name.slice(dot))) acc.push(p)
    }
  }
  return acc
}

function resolvesTo(spec, importerFile, targetReal) {
  if (!spec.startsWith('.')) return false
  let base = resolve(dirname(importerFile), spec)
  const candidates = [
    base,
    base + '.ts',
    base + '.tsx',
    base + '.mts',
    base + '.cts',
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]
  for (const cand of candidates) {
    if (!existsSync(cand)) continue
    try {
      if (statSync(cand).isFile() && realpathSync(cand) === targetReal) return true
    } catch {
      /* unreadable entry - treat as no match */
    }
  }
  return false
}

function importedNames(clause) {
  const br = /\{([^}]*)\}/.exec(clause)
  if (!br) return []
  return br[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => s.replace(/^type\s+/, ''))
    .map((s) => s.split(/\s+as\s+/)[0].trim())
    .filter((s) => isIdentifier(s))
}

function scanCallSites({ repoRoot, targetAbs, movedExportedNames }) {
  const targetReal = realpathSync(targetAbs)
  const files = walkFiles(repoRoot, []).filter((f) => {
    try {
      return realpathSync(f) !== targetReal
    } catch {
      return true
    }
  })
  const sites = [] // imports that name a moved export -> must change
  const moduleImporters = [] // any static import of the surveyed module
  const dynamicImporters = [] // dynamic imports of the surveyed module

  for (const f of files) {
    let text
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    let m
    STATIC_FROM_RE.lastIndex = 0
    while ((m = STATIC_FROM_RE.exec(text)) !== null) {
      const spec = m[1]
      if (!resolvesTo(spec, f, targetReal)) continue
      // The match may start at the separator before the keyword; report the
      // line the keyword itself sits on.
      const kwOffset = m[0].search(/import|export/)
      const line = text.slice(0, m.index + kwOffset).split('\n').length
      const clause = m[0]
      moduleImporters.push({ file: f, line, spec })
      const names = importedNames(clause)
      const hit = movedExportedNames.filter((n) => names.includes(n))
      if (hit.length > 0) sites.push({ file: f, line, spec, names: hit })
    }
    DYNAMIC_IMPORT_RE.lastIndex = 0
    while ((m = DYNAMIC_IMPORT_RE.exec(text)) !== null) {
      const spec = m[1]
      if (!resolvesTo(spec, f, targetReal)) continue
      const line = text.slice(0, m.index).split('\n').length
      const hit = movedExportedNames.filter((n) =>
        new RegExp(`\\.${escapeRegExp(n)}\\b`).test(text),
      )
      dynamicImporters.push({ file: f, line, spec, usesMoved: hit })
    }
  }
  return { sites, moduleImporters, dynamicImporters }
}

// --------------------------------------------------------------------------
// splitBrowser: run the whole survey and return a structured result.
// --------------------------------------------------------------------------

export function splitBrowser(options = {}) {
  const toolDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : resolve(toolDir, '..')
  const targetAbs = options.target
    ? resolve(options.target)
    : resolve(repoRoot, 'agent-server/apps/server/src/browser/browser.ts')

  const text = readFileSync(targetAbs, 'utf8')
  const endsWithNewline = text.endsWith('\n')
  const splitLines = text.split('\n')
  if (endsWithNewline) splitLines.pop() // the virtual empty line after the final \n
  const fileLineCount = splitLines.length

  const scanned = scanSource(text)
  const { decls, unclassified } = findDeclarations({
    lines: splitLines,
    code: scanned.code.slice(0, fileLineCount),
    depthAtStart: scanned.depthAtStart.slice(0, fileLineCount),
  })

  // --- coverage accounting -------------------------------------------------
  const covered = new Array(fileLineCount).fill(false)
  for (const d of decls) {
    for (let ln = d.startLine; ln <= d.endLine; ln++) covered[ln - 1] = true
  }
  const unparsed = []
  for (let ln = 1; ln <= fileLineCount; ln++) {
    if (!covered[ln - 1]) {
      const raw = splitLines[ln - 1]
      const codeLine = scanned.code[ln - 1] || ''
      const isBlank = raw.trim() === ''
      const isComment = !isBlank && codeLine.trim() === ''
      unparsed.push({
        line: ln,
        kind: isBlank ? 'blank' : isComment ? 'comment' : 'code',
        preview: raw.trim().slice(0, 60),
      })
    }
  }
  const declLineTotal = decls.reduce((acc, d) => acc + d.length, 0)
  const accounted = declLineTotal + unparsed.length

  // --- references and extraction -------------------------------------------
  const named = analyzeReferences(decls)
  const independentlyExtractable = named.filter((d) => d.refs.length === 0)
  const group = largestExtractableGroup(named)

  let callSites = null
  let movedExportedNames = []
  let separatorsInsideGroup = 0
  let projectedLength = null
  if (group && group.moved) {
    movedExportedNames = group.moved.filter((d) => d.exported).map((d) => d.name).sort()
    const lo = Math.min(...group.moved.map((d) => d.startLine))
    const hi = Math.max(...group.moved.map((d) => d.endLine))
    separatorsInsideGroup = unparsed.filter(
      (u) => u.kind === 'blank' && u.line > lo && u.line < hi,
    ).length
    projectedLength = fileLineCount - group.movedLines - separatorsInsideGroup
    callSites = scanCallSites({ repoRoot, targetAbs, movedExportedNames })
  }

  return {
    repoRoot,
    targetAbs,
    targetRel: relative(repoRoot, targetAbs),
    fileLineCount,
    decls,
    unclassified,
    unparsed,
    declLineTotal,
    accounted,
    named,
    independentlyExtractable,
    group,
    movedExportedNames,
    separatorsInsideGroup,
    projectedLength,
    callSites,
  }
}

// --------------------------------------------------------------------------
// Report rendering (deterministic: fixed section order, sorted lists).
// --------------------------------------------------------------------------

function pad(s, w, right = true) {
  s = String(s)
  return s.length >= w ? s : right ? s + ' '.repeat(w - s.length) : ' '.repeat(w - s.length) + s
}

function displayPath(repoRoot, absPath) {
  // Shown relative to the checkout's parent so paths read like the issue's
  // own "trios/agent-server/..." convention, with no absolute paths in output.
  return relative(dirname(repoRoot), absPath).split('\\').join('/')
}

function renderReport(r) {
  const out = []
  const W = 100
  const rule = '='.repeat(W)
  const thin = '-'.repeat(W)
  out.push(rule)
  out.push('browser.ts split survey')
  out.push(`file:   ${displayPath(r.repoRoot, r.targetAbs)}`)
  out.push(`lines:  ${r.fileLineCount} (measured during this run)`)
  out.push('note:   read-only survey; nothing was written and no source file was modified')
  out.push(rule)
  out.push('')

  // [1] declaration table
  const codeDecls = r.decls.filter((d) => !d.isImportLike)
  const importDecls = r.decls.filter((d) => d.isImportLike)
  out.push(`[1] Top-level declarations: ${r.decls.length} found`)
  out.push(`    (${codeDecls.length} declarations, ${importDecls.length} import statements)`)
  out.push(`    sorted by length, longest first`)
  out.push('')
  const rows = [...r.decls].sort((a, b) => b.length - a.length || a.startLine - b.startLine)
  const cols = [
    'lines',
    'len',
    'kind',
    'exported',
    'name',
    'references in this file',
    'extractable',
  ]
  const table = rows.map((d) => {
    const refs = d.isImportLike ? '-' : d.refs.length > 0 ? d.refs.join(', ') : '(none)'
    const extract = d.isImportLike ? 'n/a (import)' : d.refs.length === 0 ? 'yes' : 'no'
    return {
      lines: `${d.startLine}-${d.endLine}`,
      len: d.length,
      kind: d.kind,
      exported: d.exported ? 'yes' : 'no',
      name: d.name,
      refs,
      extract,
    }
  })
  const w = cols.map((c, i) => Math.max(c.length, ...table.map((t) => String(t[Object.keys(t)[i]]).length)))
  out.push('  ' + cols.map((c, i) => pad(c, w[i] + 2)).join('').trimEnd())
  out.push('  ' + w.map((x) => '-'.repeat(x + 2)).join('').trimEnd())
  for (const t of table) {
    const vals = Object.values(t)
    out.push('  ' + vals.map((v, i) => pad(String(v), w[i] + 2)).join('').trimEnd())
  }
  out.push('')

  // [2] reference graph
  out.push('[2] Intra-file reference graph (code references only; comments and')
  out.push('    string contents excluded)')
  out.push('')
  const withRefs = r.named.filter((d) => d.refs.length > 0)
  if (withRefs.length === 0) {
    out.push('    (no declaration references another declaration in this file)')
  } else {
    for (const d of withRefs.sort((a, b) => a.startLine - b.startLine)) {
      out.push(`    ${pad(d.name, 30)} -> ${d.refs.join(', ')}`)
    }
  }
  out.push('')

  // [3] independently extractable declarations
  out.push('[3] Independently extractable declarations (reference nothing else in')
  out.push('    this file; could each move alone)')
  out.push('')
  if (r.independentlyExtractable.length === 0) {
    out.push('    none - every declaration depends on another declaration here')
  } else {
    const total = r.independentlyExtractable.reduce((a, d) => a + d.length, 0)
    out.push(
      `    ${r.independentlyExtractable.length} declarations, ${total} lines total:`,
    )
    for (const d of [...r.independentlyExtractable].sort((a, b) => b.length - a.length || a.startLine - b.startLine)) {
      out.push(`      ${pad(`${d.length}`, 6)} lines  ${pad(`${d.startLine}-${d.endLine}`, 12)} ${d.name}`)
    }
  }
  out.push('')

  // [4] coverage accounting
  out.push('[4] Coverage accounting (every line must be accounted for)')
  out.push('')
  out.push(`    declaration lines: ${r.decls.length} declarations, ${r.declLineTotal} lines`)
  const blankU = r.unparsed.filter((u) => u.kind === 'blank').length
  const commentU = r.unparsed.filter((u) => u.kind === 'comment').length
  const codeU = r.unparsed.filter((u) => u.kind === 'code').length
  out.push(`    unparsed lines:    ${r.unparsed.length} (${blankU} blank, ${commentU} comment-only, ${codeU} code)`)
  out.push(`    unparsed line numbers: ${r.unparsed.map((u) => u.line).join(', ') || '(none)'}`)
  if (r.unclassified.length > 0) {
    out.push(`    UNPARSED DECLARATIONS (parser could not classify; FR-003): ${r.unclassified.length}`)
    for (const u of r.unclassified) out.push(`      line ${u.line}: ${u.preview}`)
  } else {
    out.push('    unparseable declarations (FR-003): 0 - every top-level line was classified')
  }
  out.push(`    accounted total:   ${r.declLineTotal} + ${r.unparsed.length} = ${r.accounted}`)
  out.push(`    file line count:   ${r.fileLineCount}`)
  out.push(
    r.accounted === r.fileLineCount
      ? '    agreement: EXACT - declaration lines plus unparsed lines equal the file'
      : `    agreement: MISMATCH - off by ${Math.abs(r.accounted - r.fileLineCount)} line(s)`,
  )
  out.push('')

  // [5] recommendation
  out.push('[5] Recommended single extraction (largest independently extractable')
  out.push('    group; judgement of whether and when to split stays with a person)')
  out.push('')
  if (r.group === null || !r.group.moved) {
    out.push('    No group of declarations can be extracted independently: every')
    out.push('    candidate set would drag the rest of the file behind it.')
    out.push('    Recommendation: none. Do not split this file on dependency')
    out.push('    grounds alone.')
  } else if (r.group.skipped) {
    out.push(`    ${r.group.reason}`)
    out.push('    Recommendation: not computed.')
  } else {
    const movedSorted = [...r.group.moved].sort((a, b) => b.length - a.length || a.startLine - b.startLine)
    out.push(`    Move ${r.group.moved.length} declarations (${r.group.movedLines} lines) out of this file:`)
    for (const d of movedSorted) {
      out.push(
        `      ${pad(`${d.length}`, 6)} lines  ${pad(`${d.startLine}-${d.endLine}`, 12)} ${pad(d.kind, 10)} ${d.name}${d.exported ? '' : '  (not exported)'}`,
      )
    }
    out.push(`    These reference nothing that stays behind. What stays: ${r.group.kept.map((d) => d.name).join(', ')}.`)
    out.push(
      `    Lines removed: ${r.group.movedLines} declaration lines (+${r.separatorsInsideGroup} blank separator lines inside the moved span).`,
    )
    out.push(`    This file would go from ${r.fileLineCount} to about ${r.projectedLength} lines.`)
    out.push('')
    out.push('    Call sites outside this file that would need their import changed')
    out.push('    (files importing a moved name from this module):')
    if (r.callSites.sites.length === 0) {
      out.push('      NONE - measured by scanning the repository for every import that')
      out.push('      resolves to this file. No external file imports any moved name.')
    } else {
      for (const s of r.callSites.sites) {
        out.push(`      ${displayPath(r.repoRoot, s.file)}:${s.line}  imports ${s.names.join(', ')} from '${s.spec}'`)
      }
    }
    const dyn = r.callSites.dynamicImporters.filter((d) => d.usesMoved.length > 0)
    out.push(`    Dynamic imports of this module: ${r.callSites.dynamicImporters.length}` +
      (dyn.length > 0
        ? ` (of which ${dyn.length} touch a moved name: ${dyn.map((d) => `${displayPath(r.repoRoot, d.file)}:${d.line} (${d.usesMoved.join(', ')})`).join('; ')})`
        : ' (none touch a moved name)'))
    out.push(`    Files importing this module in any form: ${r.callSites.moduleImporters.length + r.callSites.dynamicImporters.length}`)
    const stayOnly = r.callSites.moduleImporters.filter(
      (s) => !r.callSites.sites.some((x) => x.file === s.file && x.line === s.line),
    )
    if (stayOnly.length > 0) {
      out.push('    They import only names that stay in this file, so they change nothing:')
      for (const s of stayOnly) {
        out.push(`      ${displayPath(r.repoRoot, s.file)}:${s.line}`)
      }
    }
    out.push('')
    out.push('    Internal wiring note: the class that stays references the moved')
    out.push('    declarations, so this file would add one import of the new module.')
    out.push('    Moved names that are exported today: ' + (r.movedExportedNames.join(', ') || '(none)') + '.')
    out.push('    Moved names that are file-private today: ' +
      r.group.moved.filter((d) => !d.exported).map((d) => d.name).sort().join(', ') + '.')
  }
  out.push('')
  out.push(rule)
  out.push('end of survey')
  out.push(rule)
  return out.join('\n') + '\n'
}

// --------------------------------------------------------------------------
// CLI entry
// --------------------------------------------------------------------------

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  const targetArg = process.argv[2]
  try {
    const result = splitBrowser(targetArg ? { target: targetArg } : {})
    process.stdout.write(renderReport(result))
  } catch (err) {
    process.stderr.write(`browser-split-survey: ${err && err.message ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
}
