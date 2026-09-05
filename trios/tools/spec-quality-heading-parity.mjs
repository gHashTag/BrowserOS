#!/usr/bin/env node
//
// spec-quality-heading-parity.mjs
//
// QueenSpecQuality.swift states the headings under which an issue says what
// "done" looks like twice, inside one file:
//
//   1. `static let criteriaHeadings` - the EXTRACTOR's list. `bullets(in:
//      under:)` collects criteria from any section whose title CONTAINS one
//      of these, so this list is matched loosely.
//   2. the `success criteria` Check's `met:` expression - the names passed
//      to `hasSection(body, ...)`, which tests `body.lowercased().contains(
//      "## " + name.lowercased())`, so this list only sees a heading it
//      names itself, or a prefix of one it names.
//
// When the extractor knows a heading the check cannot see, an issue written
// under that heading has its criteria extracted AND is told the section
// does not exist - held to a contract the same verdict says is missing.
// That contradiction is gHashTag/trios#1387; this gate re-lands its intent
// on the base as it stands today (gHashTag/trios#1539), where the check
// reads the bare identifier `criteriaHeadings` and the two lists are one
// list. Nothing on the base pins that: an edit that restores an inline
// array, or drops a heading from the check alone, would reintroduce the
// defect with every suite still green.
//
// This module holds no copy of either list. It reads both out of the Swift
// source text at run time and reports any extractor heading ("orphan") no
// check name can see. Widening the check is the only permitted fix: an
// orphan resolved by deleting an extractor heading breaks the issues that
// use it, so the extractor count is reported too, for a human to notice a
// shrink.
//
// The sibling CLI `spec-heading-parity.mjs` performs one such comparison
// from a shell; this module exists so the property can also be imported
// and pinned by a bun test (`queen-spec-heading-parity.test.ts`), which is
// a suite the repository actually runs.
//
// Usage:
//   node trios/tools/spec-quality-heading-parity.mjs [swift-file ...]
//
// With no arguments it checks both compiled copies of the rule:
//   trios/rings/SR-00/QueenSpecQuality.swift
//   trios/agent-server/queen-core/Sources/QueenCore/QueenSpecQuality.swift
//
// Exit codes: 0 = parity, 1 = orphan heading(s), 2 = a file could not be
// parsed. Output is masked to printable ASCII so it can be pasted into an
// issue, a log or a CI transcript: the headings themselves are not ASCII.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SWIFT_FILES = [
  path.resolve(HERE, '..', 'rings', 'SR-00', 'QueenSpecQuality.swift'),
  path.resolve(
    HERE,
    '..',
    'agent-server',
    'queen-core',
    'Sources',
    'QueenCore',
    'QueenSpecQuality.swift',
  ),
]

// Every character outside printable ASCII becomes one `.`, so Cyrillic
// headings survive any transcript. The headings are not ASCII; this gate's
// output must be.
export function maskNonAscii(text) {
  return text.replace(/[^\x20-\x7E]/g, '.')
}

// Index of the bracket or paren in `text` at `openIndex` that closes the
// one opened there, counting `(`/`[` up and `)`/`]` down and skipping
// string literals. -1 when unterminated.
function scanMatchingClose(text, openIndex) {
  const openers = { '(': 1, '[': 1 }
  const closers = { ')': '(', ']': '[' }
  const stack = []
  let inString = false
  for (let i = openIndex; i < text.length; i += 1) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i += 1
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (openers[c]) stack.push(c)
    else if (closers[c]) {
      stack.pop()
      if (stack.length === 0) return i
    }
  }
  return -1
}

// The string literals inside a span of Swift source, in order, with the
// usual escapes decoded. Raw `#"..."#` literals are not expected inside the
// two lists this gate reads; they never appear there today.
function swiftStrings(span) {
  const out = []
  let i = 0
  while (i < span.length) {
    if (span[i] !== '"') {
      i += 1
      continue
    }
    let raw = ''
    let j = i + 1
    while (j < span.length && span[j] !== '"') {
      if (span[j] === '\\' && j + 1 < span.length) {
        raw += span.slice(j, j + 2)
        j += 2
        continue
      }
      raw += span[j]
      j += 1
    }
    out.push(
      raw.replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c),
    )
    i = j + 1
  }
  return out
}

// The extractor's list: the string literals assigned to
// `static let criteriaHeadings`.
function extractCriteriaHeadings(source) {
  const decl = /static\s+let\s+criteriaHeadings\s*=\s*\[/.exec(source)
  if (!decl) {
    throw new Error('cannot find `static let criteriaHeadings = [`')
  }
  const open = source.indexOf('[', decl.index)
  const close = scanMatchingClose(source, open)
  if (close < 0) throw new Error('criteriaHeadings array is unterminated')
  const inner = source.slice(open + 1, close)
  const headings = swiftStrings(inner)
  if (headings.length === 0) {
    throw new Error('criteriaHeadings array holds no string literals')
  }
  return headings
}

// Index of the last comma at depth 0 of `span`, skipping string literals.
function lastTopLevelComma(span) {
  let depth = 0
  let inString = false
  let last = -1
  for (let i = 0; i < span.length; i += 1) {
    const c = span[i]
    if (inString) {
      if (c === '\\') i += 1
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '(' || c === '[') depth += 1
    else if (c === ')' || c === ']') depth -= 1
    else if (c === ',' && depth === 0) last = i
  }
  return last
}

// The names the `success criteria` check can see: every `hasSection(body,
// ...)` argument in that check's `met:` expression, which is read between
// the check's `name:` and its `remedy:`. An array literal contributes its
// own strings; a bare `criteriaHeadings` reference contributes the
// extractor's list, read from the same file at run time. Anything else is
// an error, never a silent empty list.
function extractCheckNames(source, extractorHeadings) {
  const nameMatch = /name:\s*"success criteria"/.exec(source)
  if (!nameMatch) {
    throw new Error('cannot find Check(name: "success criteria")')
  }
  const remedyAt = source.indexOf('remedy:', nameMatch.index)
  if (remedyAt < 0) {
    throw new Error('success criteria check has no remedy to bound its met:')
  }
  const metSpan = source.slice(nameMatch.index + nameMatch[0].length, remedyAt)
  const names = []
  const call = /\bhasSection\s*\(\s*body\s*,/g
  let m = call.exec(metSpan)
  if (!m) {
    throw new Error('success criteria check never calls hasSection(body, ...)')
  }
  for (; m; m = call.exec(metSpan)) {
    const openParen = m.index + m[0].indexOf('(')
    const closeParen = scanMatchingClose(metSpan, openParen)
    if (closeParen < 0) {
      throw new Error('unterminated hasSection(...) in success criteria check')
    }
    const args = metSpan.slice(openParen + 1, closeParen)
    const comma = lastTopLevelComma(args)
    const arg = args.slice(comma + 1).trim()
    if (arg.startsWith('[') && arg.endsWith(']')) {
      names.push(...swiftStrings(arg.slice(1, -1)))
    } else if (arg === 'criteriaHeadings') {
      names.push(...extractorHeadings)
    } else {
      throw new Error(`unrecognised hasSection argument: ${maskNonAscii(arg)}`)
    }
  }
  return names
}

// An extractor heading is an orphan when no check name would let
// `hasSection` see a body headed exactly that way. `hasSection` tests
// `body.lowercased().contains("## " + name.lowercased())`, so against the
// representative body `## <heading>` the check name must occur, after the
// `## ` anchor, inside the heading - the same test, in the same direction,
// as the Swift.
export function findOrphans(extractorHeadings, checkNames) {
  const orphans = []
  extractorHeadings.forEach((heading, index) => {
    const body = '## ' + heading.toLowerCase()
    const seen = checkNames.some((name) =>
      body.includes('## ' + name.toLowerCase()),
    )
    if (!seen) orphans.push({ index, heading })
  })
  return orphans
}

// Analyse one copy of QueenSpecQuality.swift.
// Returns { file, extractorHeadings, checkNames, orphans }.
export function specQualityHeadingParity(swiftPath) {
  const source = readFileSync(swiftPath, 'utf8')
  const extractorHeadings = extractCriteriaHeadings(source)
  const checkNames = extractCheckNames(source, extractorHeadings)
  return {
    file: swiftPath,
    extractorHeadings,
    checkNames,
    orphans: findOrphans(extractorHeadings, checkNames),
  }
}

function runCli(argv) {
  const targets =
    argv.length > 0
      ? argv.map((p) => ({ display: p, read: path.resolve(p) }))
      : DEFAULT_SWIFT_FILES.map((p) => ({
          display: path.relative(process.cwd(), p) || p,
          read: p,
        }))
  let exit = 0
  for (const { display, read } of targets) {
    let result
    try {
      result = specQualityHeadingParity(read)
    } catch (err) {
      console.log(`ERROR  ${display}  ${maskNonAscii(String(err.message))}`)
      exit = 2
      continue
    }
    for (const orphan of result.orphans) {
      console.log(
        `ORPHAN  ${display}  criteriaHeadings[${orphan.index}]  ` +
          `"${maskNonAscii(orphan.heading)}"`,
      )
    }
    console.log(
      `checked ${display}: extractor=${result.extractorHeadings.length} ` +
        `check=${result.checkNames.length} orphans=${result.orphans.length}`,
    )
    if (result.orphans.length > 0 && exit === 0) exit = 1
  }
  process.exit(exit)
}

// Imported by queen-spec-heading-parity.test.ts: the CLI must not fire on
// import, and the test must not fire when the CLI runs.
const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedAsScript) {
  runCli(process.argv.slice(2))
}
