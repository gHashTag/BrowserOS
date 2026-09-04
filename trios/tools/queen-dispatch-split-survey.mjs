#!/usr/bin/env node
/**
 * Structural survey of the queen-dispatch service module.
 *
 * trios/agent-server/apps/server/src/api/services/queen-dispatch.ts has grown
 * far past the repository's own 400-line pre-commit warning, and nothing has
 * ever recorded what is inside it. This tool produces that record: it parses
 * the source text, lists every top-level declaration with its measured line
 * range, maps which declarations reference which, marks the ones that could
 * move to a new module on their own, and names the single largest extraction
 * that would not drag the rest of the file behind it. The judgement of
 * whether to split, and when, stays with a person; this survey only makes
 * that judgement possible.
 *
 * Rules it obeys:
 *   - FR-001: it reads and reports. It never writes or modifies anything.
 *   - FR-002: declarations are found by parsing the source text, never from
 *             a list written into this tool, so it does not go stale.
 *   - FR-003: lines the parser cannot classify are reported as unparsed with
 *             their line numbers, and counted separately.
 *   - FR-004: every number in the output is measured during the run.
 *   - FR-005: runs under node with the Node standard library only. No
 *             TypeScript compiler, no make, no build of any kind.
 *
 * Output is deterministic: two runs over an unchanged file print identical
 * bytes. No timestamps, no environment data, and every listing is sorted.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL_PATH = fileURLToPath(import.meta.url)
const TOOL_DIR = dirname(TOOL_PATH)
const REPO_ROOT = resolve(TOOL_DIR, '..', '..')
const TARGET_REL = 'trios/agent-server/apps/server/src/api/services/queen-dispatch.ts'
const TARGET_ABS = join(REPO_ROOT, ...TARGET_REL.split('/'))

/* ------------------------------------------------------------------------ */
/* Source scanner                                                            */
/* ------------------------------------------------------------------------ */

/**
 * One pass over the source text that produces, per line:
 *   - `stripped`:    the line with comment interiors and regex literals
 *                    blanked out. String and template-literal contents are
 *                    kept (template `${...}` interpolations hold real code),
 *                    so that identifier references can be matched on this
 *                    text without doc comments producing false references.
 *   - `depthStart` / `depthEnd`: the bracket-nesting depth at the start and
 *                    end of the line, counting {} () [] only in code mode
 *                    (never inside comments, strings, templates or regexes).
 *   - `commentOnly`: the line holds no code once comments are removed, but
 *                    is not blank. Used to attach leading doc comments to
 *                    the declaration they describe.
 */
function scanSource(source) {
  const raw = source.split('\n')
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const n = raw.length
  const lines = raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  const stripped = new Array(n)
  const depthStart = new Array(n)
  const depthEnd = new Array(n)
  const commentOnly = new Array(n)

  // Keywords after which a `/` opens a regex literal rather than division.
  const KEYWORDS_BEFORE_REGEX = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'case', 'do', 'else', 'yield', 'await',
  ])

  let mode = 'code' // 'code' | 'sq' | 'dq' | 'tpl' | 'regex' | 'block'
  let inRegexClass = false
  const interp = [] // nesting depths of open ${ } interpolations inside templates
  let depth = 0
  let prevKind = 'none' // 'operand' | 'operator' | 'none' (last significant token)
  let word = ''
  let prevWord = ''

  for (let i = 0; i < n; i++) {
    const line = lines[i]
    depthStart[i] = depth
    let out = ''
    let lineComment = false
    for (let j = 0; j < line.length; j++) {
      const c = line[j]
      const nxt = j + 1 < line.length ? line[j + 1] : ''
      if (lineComment) {
        out += ' '
        continue
      }
      if (mode === 'block') {
        if (c === '*' && nxt === '/') {
          out += '  '
          j++
          mode = 'code'
          prevKind = 'operator'
        } else {
          out += ' '
        }
        continue
      }
      if (mode === 'regex') {
        if (c === '\\') {
          out += '  '
          j++
        } else if (c === '[') {
          inRegexClass = true
          out += ' '
        } else if (c === ']') {
          inRegexClass = false
          out += ' '
        } else if (c === '/' && !inRegexClass) {
          out += ' '
          mode = 'code'
          prevKind = 'operand'
          prevWord = ''
          // Regex flags are part of the literal; blank them too.
          while (j + 1 < line.length && /[a-z]/.test(line[j + 1])) {
            out += ' '
            j++
          }
        } else {
          out += ' '
        }
        continue
      }
      if (mode === 'sq' || mode === 'dq') {
        if (c === '\\') {
          out += '  '
          j++
        } else if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) {
          out += c
          mode = 'code'
          prevKind = 'operand'
          prevWord = ''
          word = ''
        } else {
          out += c
        }
        continue
      }
      if (mode === 'tpl') {
        if (c === '\\') {
          out += '  '
          j++
        } else if (c === '`') {
          out += '`'
          mode = 'code'
          prevKind = 'operand'
          prevWord = ''
          word = ''
        } else if (c === '$' && nxt === '{') {
          out += '  '
          j++
          interp.push(depth)
          mode = 'code'
          prevKind = 'operator'
          word = ''
        } else {
          out += c
        }
        continue
      }
      // mode === 'code'
      if (c === ' ' || c === '\t') {
        out += c
        continue
      }
      if (/[A-Za-z0-9_$]/.test(c)) {
        word += c
        prevKind = 'operand'
        out += c
        continue
      }
      if (c === '/') {
        if (nxt === '/') {
          lineComment = true
          out += '  '
          j++
          continue
        }
        if (nxt === '*') {
          mode = 'block'
          out += '  '
          j++
          continue
        }
        // Regex or division: a regex can follow an operator or a keyword;
        // after any other operand (identifier, literal, closing bracket)
        // the slash divides.
        const afterKeyword = KEYWORDS_BEFORE_REGEX.has(word || prevWord)
        if (prevKind !== 'operand' || afterKeyword) {
          mode = 'regex'
          inRegexClass = false
          out += ' '
          if (word) {
            prevWord = word
            word = ''
          }
          continue
        }
        out += c
      } else if (c === '{') {
        depth++
        out += c
      } else if (c === '}') {
        if (interp.length > 0 && interp[interp.length - 1] === depth) {
          // This brace closes a ${ } interpolation: return to the template.
          interp.pop()
          mode = 'tpl'
          out += ' '
        } else {
          depth--
          out += c
        }
      } else if (c === '(' || c === '[') {
        depth++
        out += c
      } else if (c === ')' || c === ']') {
        depth--
        out += c
      } else if (c === "'" || c === '"' || c === '`') {
        mode = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl'
        out += c
      } else {
        out += c
      }
      if (word) {
        prevWord = word
        word = ''
      }
      prevKind = c === ')' || c === ']' ? 'operand' : 'operator'
    }
    // A line comment ends with its line; so does (in valid JS) a regex.
    if (mode === 'regex') mode = 'code'
    stripped[i] = out
    depthEnd[i] = depth
    commentOnly[i] = out.trim() === '' && line.trim() !== ''
  }
  return { lines, stripped, depthStart, depthEnd, commentOnly, lineCount: n }
}

/* ------------------------------------------------------------------------ */
/* Top-level declaration parsing                                             */
/* ------------------------------------------------------------------------ */

const DECL_SHAPES = [
  { kind: 'function', re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: 'enum', re: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: 'class', re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: 'interface', re: /^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: 'type', re: /^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/ },
  { kind: 'const', re: /^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: 'let', re: /^(?:export\s+)?let\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: 'var', re: /^(?:export\s+)?var\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
]

/** A trimmed, comment-stripped line ends mid-expression and so continues. */
function lineContinues(trimmed) {
  if (trimmed === '') return true
  return (
    /[=|&,:?+.]$/.test(trimmed) ||
    trimmed.endsWith('=>') ||
    trimmed.endsWith('`')
  )
}

/** The last line of the declaration that starts at `start`. */
function findDeclarationEnd(scan, start) {
  const { stripped, depthStart, depthEnd } = scan
  const d0 = depthStart[start]
  for (let k = start; k < scan.lineCount; k++) {
    if (depthEnd[k] > d0) continue // still inside brackets
    if (k === start && lineContinues(stripped[k].trim())) continue
    // Depth is back to the base level. Guard against a member-access chain
    // that continues on the next line (`.foo()`, `?.foo()`, `: type`).
    const next = k + 1 < scan.lineCount ? stripped[k + 1].trimStart() : ''
    if (k > start && (next.startsWith('.') || next.startsWith('?.'))) continue
    return k
  }
  return scan.lineCount - 1
}

/** Leading comment lines that sit directly above a declaration travel with it. */
function attachLeadingComments(scan, codeStart) {
  let s = codeStart
  while (s - 1 >= 0 && scan.commentOnly[s - 1]) s--
  return s
}

function parseDeclarations(scan) {
  const decls = []
  const n = scan.lineCount
  let i = 0
  while (i < n) {
    if (scan.depthStart[i] !== 0 || scan.stripped[i].trim() === '') {
      i++
      continue
    }
    const t = scan.stripped[i].trim()
    // Imports and bare re-exports are not declarations; they stay unparsed.
    if (/^import\b/.test(t) || /^export\s*[{*]/.test(t)) {
      i++
      continue
    }
    const shape = DECL_SHAPES.find((s) => s.re.test(t))
    if (!shape) {
      i++
      continue
    }
    const m = shape.re.exec(t)
    const codeStart = i
    const end = findDeclarationEnd(scan, codeStart)
    decls.push({
      name: m[1],
      kind: shape.kind,
      exported: /^export\s/.test(t),
      start: attachLeadingComments(scan, codeStart),
      codeStart,
      end,
      lines: end - attachLeadingComments(scan, codeStart) + 1,
    })
    i = end + 1
  }
  return decls
}

/* ------------------------------------------------------------------------ */
/* Cross-references, independent extractability, closures                    */
/* ------------------------------------------------------------------------ */

function identifierRegex(name) {
  return new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`)
}

/** Which other top-level declarations does each declaration reference? */
function computeReferences(scan, decls) {
  const texts = new Map(decls.map((d) => [d.name, scan.stripped.slice(d.codeStart, d.end + 1).join('\n')]))
  for (const d of decls) {
    const text = texts.get(d.name)
    d.refs = decls
      .filter((e) => e.name !== d.name && identifierRegex(e.name).test(text))
      .map((e) => e.name)
      .sort()
    d.independent = d.refs.length === 0
  }
  return decls
}

/** A declaration plus everything it transitively references: what travels with it. */
function closureOf(name, refMap) {
  const seen = new Set([name])
  const queue = [name]
  while (queue.length > 0) {
    const cur = queue.shift()
    for (const r of refMap.get(cur) || []) {
      if (!seen.has(r)) {
        seen.add(r)
        queue.push(r)
      }
    }
  }
  return seen
}

/* ------------------------------------------------------------------------ */
/* External call sites                                                       */
/* ------------------------------------------------------------------------ */

const WALK_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.worktrees', 'dist', 'build', 'out', 'coverage',
  '.next', '.turbo', '.cache', 'vendor',
])
const WALK_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

function walkCodeFiles(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!WALK_SKIP_DIRS.has(entry.name)) walkCodeFiles(full, out)
    } else if (entry.isFile() && WALK_EXTS.has(extOf(entry.name))) {
      out.push(full)
    }
  }
}

function extOf(name) {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot)
}

/** Every file outside the target that imports it, with the names it imports. */
function findExternalImporters() {
  const files = []
  walkCodeFiles(REPO_ROOT, files)
  const importers = []
  const namedImport =
    /import\s+(?:type\s+)?(?:[A-Za-z0-9_$]+\s*,\s*)?(?:\{([^}]*)\}|[A-Za-z0-9_$]+\s+as\s+[A-Za-z0-9_$]+|[A-Za-z0-9_$]+|\*\s+as\s+[A-Za-z0-9_$]+)\s*from\s*['"][^'"]*queen-dispatch['"]/g
  const sideEffectImport = /import\s*['"][^'"]*queen-dispatch['"]/
  for (const file of files) {
    if (resolve(file) === resolve(TARGET_ABS)) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const names = new Set()
    let any = sideEffectImport.test(text)
    namedImport.lastIndex = 0
    let m
    while ((m = namedImport.exec(text)) !== null) {
      any = true
      if (m[1]) {
        for (const part of m[1].split(',')) {
          const cleaned = part.replace(/\btype\s+/, '').trim().split(/\s+as\s+/)[0].trim()
          if (cleaned) names.add(cleaned)
        }
      }
    }
    if (any) importers.push({ path: relative(REPO_ROOT, file), names: [...names].sort() })
  }
  importers.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return importers
}

function countUsages(text, name) {
  const re = identifierRegex(name)
  const matches = text.match(new RegExp(re.source, 'g'))
  return matches ? matches.length : 0
}

/* ------------------------------------------------------------------------ */
/* The survey itself                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Run the survey and return the full report as an object, including the
 * rendered text. Pure: it reads files and computes; it writes nothing.
 */
export function splitQueenDispatch() {
  const source = readFileSync(TARGET_ABS, 'utf8')
  const scan = scanSource(source)
  const decls = computeReferences(scan, parseDeclarations(scan))

  // Which lines belong to no declaration (FR-003): file header, imports,
  // blank separators, unattached comments, anything unclassified.
  const owned = new Array(scan.lineCount).fill(false)
  for (const d of decls) {
    for (let i = d.start; i <= d.end; i++) owned[i] = true
  }
  const unparsedRuns = []
  let i = 0
  while (i < scan.lineCount) {
    if (owned[i]) {
      i++
      continue
    }
    let j = i
    while (j + 1 < scan.lineCount && !owned[j + 1]) j++
    let label
    const slice = scan.lines.slice(i, j + 1)
    const allBlank = slice.every((l) => l.trim() === '')
    const nonBlank = slice.filter((l) => l.trim() !== '')
    const allImports = nonBlank.every((l) => l.trim().startsWith('import '))
    const hasImport = nonBlank.some((l) => l.trim().startsWith('import '))
    const allComment = nonBlank.every((l) => /^\s*(\/\/|\/\*|\*)/.test(l))
    if (allBlank) label = 'blank'
    else if (allImports) label = 'import statements'
    else if (hasImport) label = 'comment block and import statements'
    else if (allComment) label = 'comment block with no declaration directly below it'
    else label = 'unclassified'
    unparsedRuns.push({ from: i + 1, to: j + 1, label })
    i = j + 1
  }
  const unparsedCount = scan.lineCount - decls.reduce((sum, d) => sum + d.lines, 0)
  const declarationLines = decls.reduce((sum, d) => sum + d.lines, 0)
  const independents = decls.filter((d) => d.independent)
  const independentLines = independents.reduce((sum, d) => sum + d.lines, 0)

  // Extraction groups. A declaration cannot move alone if it references
  // others: they are what travels with it. The closure of a declaration is
  // itself plus everything it transitively references. An extraction of that
  // declaration moves exactly its closure. A closure equal to the whole file
  // is not an extraction - it would drag the entire file along - so such
  // seeds are not candidates at all.
  const refMap = new Map(decls.map((d) => [d.name, d.refs]))
  const closureByKey = new Map()
  for (const d of decls) {
    const closure = closureOf(d.name, refMap)
    const key = [...closure].sort().join(',')
    if (!closureByKey.has(key)) closureByKey.set(key, { names: closure, seeds: [] })
    closureByKey.get(key).seeds.push(d.name)
  }
  const allNames = new Set(decls.map((d) => d.name))
  const candidates = []
  for (const group of closureByKey.values()) {
    if (group.names.size === allNames.size) continue // drags the whole file
    const lines = decls.filter((d) => group.names.has(d.name)).reduce((s, d) => s + d.lines, 0)
    candidates.push({
      seeds: group.seeds.sort(),
      names: [...group.names].sort(),
      lines,
      declarationCount: group.names.size,
    })
  }
  candidates.sort((a, b) =>
    b.lines - a.lines ||
    (a.names.join(',') < b.names.join(',') ? -1 : a.names.join(',') > b.names.join(',') ? 1 : 0),
  )
  const recommendation = candidates.length > 0 ? candidates[0] : null

  // Call sites outside this file: who imports what from here.
  const externalImporters = findExternalImporters()
  const byName = new Map(decls.map((d) => [d.name, d]))
  let callSites = []
  let unaffectedImporters = []
  if (recommendation) {
    const movedSet = new Set(recommendation.names)
    const movedExported = recommendation.names.filter((nm) => byName.get(nm).exported)
    const movedExportedSet = new Set(movedExported)
    callSites = []
    unaffectedImporters = []
    for (const imp of externalImporters) {
      const moved = imp.names.filter((nm) => movedExportedSet.has(nm))
      if (moved.length > 0) callSites.push({ path: imp.path, names: moved })
      else unaffectedImporters.push(imp)
    }
    // Declarations left behind that reference moved ones: the remaining file
    // would import those names from the new module.
    const rewires = []
    for (const d of decls) {
      if (movedSet.has(d.name)) continue
      const to = d.refs.filter((r) => movedSet.has(r))
      if (to.length > 0) rewires.push({ name: d.name, to })
    }
    recommendation.inFileRewires = rewires.sort((a, b) => (a.name < b.name ? -1 : 1))
    recommendation.movedExported = movedExported
    recommendation.linesLeftBehind =
      declarationLines - recommendation.lines
  }

  const text = render({
    scan,
    decls,
    unparsedRuns,
    unparsedCount,
    declarationLines,
    independents,
    independentLines,
    candidates,
    recommendation,
    externalImporters,
    callSites,
    unaffectedImporters,
  })

  return {
    target: TARGET_REL,
    lineCount: scan.lineCount,
    declarationCount: decls.length,
    declarationLines,
    unparsedCount,
    accounted: declarationLines + unparsedCount === scan.lineCount,
    declarations: decls.map((d) => ({
      name: d.name, kind: d.kind, exported: d.exported, start: d.start + 1,
      end: d.end + 1, lines: d.lines, refs: d.refs, independent: d.independent,
    })),
    unparsedRuns,
    independents: independents.map((d) => d.name),
    candidates,
    recommendation,
    text,
  }
}

/* ------------------------------------------------------------------------ */
/* Rendering                                                                 */
/* ------------------------------------------------------------------------ */

function render(r) {
  const W = 78
  const rule = '='.repeat(W)
  const thin = '-'.repeat(W)
  const out = []

  out.push(rule)
  out.push(`Survey of ${TARGET_REL}`)
  out.push(rule)
  out.push('')
  out.push('Read-only structural survey, measured during this run (FR-004).')
  out.push('The source file is parsed, never listed by hand (FR-002), and is')
  out.push('not modified (FR-001). Node standard library only (FR-005).')
  out.push('')
  out.push(`File line count (measured):        ${r.scan.lineCount}`)
  out.push(`Top-level declarations found:      ${r.decls.length}`)
  out.push(`Unparsed lines (see below):        ${r.unparsedCount}`)
  out.push('')

  out.push(thin)
  out.push('Declarations, longest first')
  out.push(thin)
  out.push('')
  out.push('EXPORTED   yes = reachable outside this file.  EXTRACTABLE = references')
  out.push('no other declaration in this file, so it can move to a new module on')
  out.push('its own. REFERENCES = the other top-level declarations here that its')
  out.push('code names; those are what would travel with it if it moved.')
  out.push('')
  const nameW = Math.max(...r.decls.map((d) => d.name.length), 'name'.length)
  out.push(
    pad('lines', 7) + pad('range', 12) + pad('kind', 11) + pad('exported', 10) +
    pad('extractable', 13) + pad('name', nameW + 2) + 'references',
  )
  for (const d of [...r.decls].sort((a, b) => b.lines - a.lines || (a.name < b.name ? -1 : 1))) {
    out.push(
      pad(String(d.lines), 7) +
      pad(`${d.start + 1}-${d.end + 1}`, 12) +
      pad(d.kind, 11) +
      pad(d.exported ? 'yes' : 'no', 10) +
      pad(d.independent ? 'yes' : 'no', 13) +
      pad(d.name, nameW + 2) +
      (d.refs.length ? d.refs.join(', ') : '(none)'),
    )
  }
  out.push('')

  out.push(thin)
  out.push('Accounting: every line belongs to a declaration or is unparsed')
  out.push(thin)
  out.push('')
  out.push(`Sum of all declaration line ranges: ${r.declarationLines}`)
  out.push(`Unparsed lines:                     ${r.unparsedCount}`)
  out.push(`Total:                              ${r.declarationLines + r.unparsedCount}`)
  out.push(`File line count (measured):         ${r.scan.lineCount}`)
  out.push(
    r.declarationLines + r.unparsedCount === r.scan.lineCount
      ? 'They agree: declaration lines + unparsed lines = the whole file.'
      : 'THEY DO NOT AGREE - this output is not trustworthy.',
  )
  out.push('')

  out.push(thin)
  out.push('Independently extractable declarations')
  out.push(thin)
  out.push('')
  out.push('A declaration that references no other top-level declaration in this')
  out.push('file can move to a new module on its own; only its own imports travel')
  out.push('with it. They can also move together as one new module, because')
  out.push('none of them needs any of the others.')
  out.push('')
  out.push(`Count: ${r.independents.length} of ${r.decls.length} declarations`)
  out.push(`Lines they account for: ${r.independentLines} of ${r.declarationLines} declaration lines`)
  out.push('')
  for (const d of [...r.independents].sort((a, b) => b.lines - a.lines || (a.name < b.name ? -1 : 1))) {
    out.push(`  ${pad(String(d.lines), 6)} ${d.name}${d.exported ? '' : '  (not exported)'}`)
  }
  out.push('')

  out.push(thin)
  out.push('Unparsed lines')
  out.push(thin)
  out.push('')
  out.push(`Count: ${r.unparsedCount}. A line is unparsed when it belongs to no`)
  out.push('declaration: the licence header, import statements, blank separators,')
  out.push('or a comment block with no declaration directly below it (FR-003).')
  out.push('')
  for (const run of r.unparsedRuns) {
    out.push(`  ${pad(`${run.from}-${run.to}`, 12)} ${run.label}`)
  }
  out.push('')

  out.push(thin)
  out.push('Recommended extraction')
  out.push(thin)
  out.push('')
  out.push('Definition used, so the reader can judge it: a declaration cannot move')
  out.push('alone if it references others - those references are what travels with')
  out.push('it. The closure of a declaration is itself plus every declaration it')
  out.push('transitively references; extracting that declaration moves exactly its')
  out.push('closure. A closure equal to the whole file drags the file behind it and')
  out.push('is no extraction at all, so it is not a candidate. Among the remaining')
  out.push('candidates the largest by lines is the one named below.')
  out.push('')
  if (!r.recommendation) {
    out.push('No independently extractable group exists: every declaration')
    out.push('transitively references every other, so any single extraction would')
    out.push('drag the whole file behind it. A split cannot be proposed from this')
    out.push('file alone; it would have to untangle the references first.')
  } else {
    const rec = r.recommendation
    const byName = new Map(r.decls.map((d) => [d.name, d]))
    out.push(`Seed (the declaration whose closure this is): ${rec.seeds.join(', ')}`)
    out.push(`Declarations that move: ${rec.declarationCount} of ${r.decls.length} (${rec.lines} of ${r.declarationLines} declaration lines)`)
    out.push('')
    for (const nm of [...rec.names].sort((a, b) => byName.get(b).lines - byName.get(a).lines || (a < b ? -1 : 1))) {
      const d = byName.get(nm)
      out.push(`  ${pad(String(d.lines), 6)} ${pad(`${d.start + 1}-${d.end + 1}`, 12)} ${nm}${d.exported ? '' : '  (not exported)'}`)
    }
    out.push('')
    out.push(`Lines removed from this file: ${rec.lines}`)
    out.push(`Declaration lines left behind: ${rec.linesLeftBehind} plus ${r.unparsedCount} unparsed lines`)
    out.push('')
    out.push('Call sites outside this file whose imports must change (files that')
    out.push('import a moved declaration):')
    if (r.callSites.length === 0) {
      out.push('  (none - no file outside imports any declaration that moves)')
    }
    for (const cs of r.callSites) {
      out.push(`  ${cs.path}`)
      for (const nm of cs.names) out.push(`      imports ${nm}`)
    }
    out.push('')
    out.push('Files that import from this module but keep working unchanged')
    out.push('(they import only declarations that stay):')
    if (r.unaffectedImporters.length === 0) {
      out.push('  (none)')
    }
    for (const imp of r.unaffectedImporters) {
      out.push(`  ${imp.path}  imports ${imp.names.join(', ')}`)
    }
    out.push('')
    out.push('Declarations left behind that reference moved ones - the remaining')
    out.push('file would import these names from the new module:')
    if (rec.inFileRewires.length === 0) {
      out.push('  (none)')
    }
    for (const rw of rec.inFileRewires) {
      out.push(`  ${rw.name} -> ${rw.to.join(', ')}`)
    }
    out.push('')
    out.push('A group and its complement describe the same cut; which side keeps')
    out.push('the module name is a choice this survey leaves to a person.')
    out.push('')
    out.push('Runner-up candidates (every distinct proper closure, largest first):')
    for (const cand of r.candidates.slice(1, 11)) {
      out.push(`  ${pad(String(cand.lines), 6)} lines  ${pad(`${cand.declarationCount} decls`, 9)} seed: ${cand.seeds.join(', ')}`)
    }
  }
  out.push('')
  out.push(rule)
  out.push('End of survey. Judgement of whether and when to split stays with a person.')
  out.push(rule)
  return out.join('\n') + '\n'
}

function pad(s, width) {
  return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length)
}

/* ------------------------------------------------------------------------ */
/* CLI                                                                       */
/* ------------------------------------------------------------------------ */

const isEntry = process.argv[1] && resolve(process.argv[1]) === TOOL_PATH
if (isEntry) {
  try {
    process.stdout.write(splitQueenDispatch().text)
  } catch (error) {
    process.stderr.write(`survey failed: ${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  }
}
