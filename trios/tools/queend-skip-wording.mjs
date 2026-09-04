// A wording-parity gate for the chooser that runs in the container.
//
// WHY THIS FILE EXISTS. The choose loop in
// queen-core/Sources/queend/main.swift writes one sentence per candidate it
// passes over, and the tick prints those sentences verbatim into the round
// report when a round starts nothing. That loop once composed its own words
// for every state claimOnIssue counts as live - "a worker has it or is
// expected back" - including `queued`. A queued task means a dispatch never
// happened: the issue is claimed and stuck, not busy, and busy and stuck are
// the two readings that call for opposite actions. The corrected wording was
// written in QueenPolicy (`spokenForReport`) for exactly this defect and is
// read by the Mac app; the container must take its sentence from there too,
// and this gate is what keeps that true after this change is forgotten.
//
// WHAT IT CHECKS, reading the policy at run time (never carrying a copy of
// its sentences):
//   1. ROUTING. The skipped.append under `case .live` must take its sentence
//      from QueenDelegationPolicy.spokenForReport(states:).detail, so the
//      container and the Mac app print the same words for the same states.
//   2. VOCABULARY. No skipped.append may hand-write a claim word the policy
//      owns. Claim words are derived on every run from the detail: string
//      literals inside spokenForReport: the words that recur across those
//      sentences, minus ordinary English. Today that yields "worker". If the
//      policy's wording is ever edited, the gate follows the edit instead of
//      still passing against words the policy no longer uses.
//
// WHAT IT NEVER DOES: write, move, or truncate anything. It reads two Swift
// sources and prints.
//
// USAGE
//   node trios/tools/queend-skip-wording.mjs [path-to-a-main.swift]
// No argument gates the shipped main.swift. An argument gates that file
// instead, which is how a copy of the pre-change file is proven to still
// fail after the fix. Exit 0 means in step. Exit 1 means out of step, or a
// check that could not be performed: a file that cannot be read,
// spokenForReport not found in the policy, fewer than three detail:
// literals extracted, no skipped.append sites to scan, or no claim words
// derivable. An empty scan is never reported as success.

import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
// <repo>/trios/tools -> <repo>, the directory that contains trios/.
const REPO_ROOT = resolve(MODULE_DIR, '..', '..')
const DEFAULT_MAIN = join(
  REPO_ROOT,
  'trios',
  'agent-server',
  'queen-core',
  'Sources',
  'queend',
  'main.swift',
)
const DEFAULT_POLICY = join(
  REPO_ROOT,
  'trios',
  'agent-server',
  'queen-core',
  'Sources',
  'QueenPolicy',
  'QueenDelegation.swift',
)

// The policy's skip wording has a sentence per bucket. Fewer than this means
// the extraction lost the function, not that the policy shrank.
const MIN_DETAIL_LITERALS = 3

// Ordinary English, so that a word recurring in the policy's sentences is
// claim vocabulary only when it is not grammar. This list is not a copy of
// the policy's sentences; it is what is subtracted from them.
const STOPWORDS = new Set(
  (
    'a an the it its is are was were be been being no not nor or and but so ' +
    'yet for by with on in at to of as if then than too very own same will ' +
    'can just about into over under again once here there when where why ' +
    'how all any both each few more most other some such only you your ' +
    'this that these those has have had do does did'
  ).split(' '),
)

// One pass over Swift source. Produces:
//   masked  - same length as the source, with string literal and comment
//             contents replaced by spaces, so quotes and parentheses inside
//             quoted text cannot be mistaken for code structure.
//   strings - every string literal as { start, end, content }, content being
//             the text between the quotes, interpolations included verbatim.
// The Swift in the two files this gate reads uses double-quoted single-line
// literals with \(...) interpolation; a literal is treated as opaque from
// its opening quote to the first unescaped closing quote.
function scanSwift(source) {
  const masked = source.split('')
  const strings = []
  let i = 0
  let open = -1
  while (i < source.length) {
    const c = source[i]
    if (open < 0) {
      if (c === '"') {
        open = i
      } else if (c === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') {
          masked[i] = ' '
          i += 1
        }
        continue
      } else if (c === '/' && source[i + 1] === '*') {
        masked[i] = ' '
        masked[i + 1] = ' '
        i += 2
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
          if (masked[i] !== '\n') masked[i] = ' '
          i += 1
        }
        if (i < source.length) {
          masked[i] = ' '
          masked[i + 1] = ' '
          i += 2
        }
        continue
      }
      i += 1
      continue
    }
    // Inside a string literal.
    if (c === '\\' && i + 1 < source.length) {
      i += 2
      continue
    }
    if (c === '"') {
      strings.push({ start: open, end: i, content: source.slice(open + 1, i) })
      for (let k = open; k <= i; k += 1) {
        if (masked[k] !== '\n') masked[k] = ' '
      }
      open = -1
    }
    i += 1
  }
  if (open >= 0) {
    // An unterminated literal: blank the tail rather than let it read as
    // code. Well-formed Swift never reaches this branch.
    for (let k = open; k < source.length; k += 1) {
      if (masked[k] !== '\n') masked[k] = ' '
    }
  }
  return { masked: masked.join(''), strings }
}

function lineOf(source, index) {
  let line = 1
  for (let k = 0; k < index; k += 1) {
    if (source[k] === '\n') line += 1
  }
  return line
}

// The skipped.append sites, found by scanning (never by line number: this
// finding's own line moved between two checkouts of the same repository).
// A site runs from its `skipped.append(` to the parenthesis that closes it,
// counted on the masked source so parentheses inside string literals do not
// end the statement early.
function findAppendSites(source, masked) {
  const list = []
  const pattern = /skipped\.append\s*\(/g
  let match = pattern.exec(masked)
  while (match !== null) {
    let depth = 1
    let i = match.index + match[0].length
    while (i < masked.length && depth > 0) {
      const c = masked[i]
      if (c === '(') depth += 1
      else if (c === ')') depth -= 1
      i += 1
    }
    if (depth !== 0) {
      return {
        error: `the skipped.append statement at line ${lineOf(source, match.index)} never closes (check: the sites cannot be delimited)`,
      }
    }
    list.push({ start: match.index, end: i - 1, line: lineOf(source, match.index) })
    match = pattern.exec(masked)
  }
  return { list }
}

// The canonical sentences: the detail: string literals inside
// spokenForReport, read out of the policy on every run.
function extractSpokenFor(scan) {
  const decl = /func\s+spokenForReport\b/.exec(scan.masked)
  if (decl === null) {
    return {
      error:
        'spokenForReport cannot be located in the policy ' +
        '(check: the canonical skip sentences cannot be extracted)',
    }
  }
  const braceStart = scan.masked.indexOf('{', decl.index)
  if (braceStart < 0) {
    return {
      error:
        'spokenForReport has no body to read ' +
        '(check: the canonical skip sentences cannot be extracted)',
    }
  }
  let depth = 1
  let i = braceStart + 1
  while (i < scan.masked.length && depth > 0) {
    const c = scan.masked[i]
    if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    i += 1
  }
  if (depth !== 0) {
    return {
      error:
        'the body of spokenForReport never closes ' +
        '(check: the canonical skip sentences cannot be extracted)',
    }
  }
  const bodyEnd = i - 1
  const detailLiterals = []
  const label = /detail:\s*/g
  let lm = label.exec(scan.masked)
  while (lm !== null) {
    if (lm.index > braceStart && lm.index < bodyEnd) {
      const lit = scan.strings.find((s) => s.start > lm.index && s.start < bodyEnd)
      if (lit !== undefined) detailLiterals.push(lit.content)
    }
    lm = label.exec(scan.masked)
  }
  return { detailLiterals }
}

function wordsOf(literal) {
  // Interpolations are code, not words the operator reads.
  return (literal.replace(/\\\([^)]*\)/g, ' ').match(/[A-Za-z]+/g) ?? []).map((w) =>
    w.toLowerCase(),
  )
}

// The words the policy owns when it says who holds a task. A word counts as
// owned when the detail sentences repeat it across different sentences: a
// word used once is a fact about one state, a word used throughout is how
// the policy talks about claims. Ordinary English is subtracted so recurring
// grammar does not become vocabulary.
function deriveClaimWords(detailLiterals) {
  const counts = new Map()
  for (const literal of new Set(detailLiterals)) {
    for (const word of new Set(wordsOf(literal))) {
      counts.set(word, (counts.get(word) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .filter(([word, seen]) => seen >= 2 && word.length >= 3 && !STOPWORDS.has(word))
    .map(([word]) => word)
    .sort()
}

// Whether this append is the one that reports the branch's live claim. Walks
// up from the append line through blanks and comments; the first line of
// real code above says which case (or guard, or if) the sentence belongs to.
// Structural scanning only - no line numbers.
function reportsLiveClaim(lines, appendLine) {
  for (let i = appendLine - 2; i >= 0; i -= 1) {
    const text = (lines[i] ?? '').trim()
    if (text === '' || text.startsWith('//')) continue
    return /^case\s+\.live\b/.test(text)
  }
  return false
}

// The parity check. Call with no arguments to gate the shipped files, or
// with mainSource / policySource strings (the negative controls), or with
// mainPath to gate some other file against the shipped policy. Returns
// { ok, mainPath, sites, detailLiterals, claimWords, violations, cannotCheck }.
// cannotCheck is a string whenever a check could not be performed; ok is
// then false, because an unperformed check is not a pass.
export function spokenForWordingParity({
  mainPath,
  mainSource,
  policyPath,
  policySource,
} = {}) {
  const result = {
    ok: false,
    mainPath: mainPath ?? DEFAULT_MAIN,
    sites: 0,
    detailLiterals: 0,
    claimWords: [],
    violations: [],
    cannotCheck: null,
  }

  // The policy, where the canonical sentences live.
  const policyLabel = policyPath ?? (policySource !== undefined ? 'the supplied policy source' : DEFAULT_POLICY)
  let policy = policySource
  if (policy === undefined) {
    try {
      policy = readFileSync(policyPath ?? DEFAULT_POLICY, 'utf8')
    } catch {
      result.cannotCheck = `could not read ${policyLabel} (check: the canonical skip sentences cannot be extracted)`
      return result
    }
  }
  const spokenFor = extractSpokenFor(scanSwift(policy))
  if (spokenFor.error !== undefined) {
    result.cannotCheck = spokenFor.error
    return result
  }
  if (spokenFor.detailLiterals.length < MIN_DETAIL_LITERALS) {
    result.cannotCheck = `only ${spokenFor.detailLiterals.length} detail: literal(s) extracted from spokenForReport in ${policyLabel} (check: the canonical skip sentences cannot be trusted; need at least ${MIN_DETAIL_LITERALS})`
    return result
  }
  const claimWords = deriveClaimWords(spokenFor.detailLiterals)
  if (claimWords.length === 0) {
    result.cannotCheck = `no claim word could be derived from the detail: sentences in ${policyLabel} (check: the vocabulary rule would have nothing to enforce)`
    return result
  }
  result.detailLiterals = spokenFor.detailLiterals.length
  result.claimWords = claimWords

  // The chooser, where one of those sentences is written down.
  const mainLabel = mainPath ?? (mainSource !== undefined ? 'the supplied main source' : DEFAULT_MAIN)
  let main = mainSource
  if (main === undefined) {
    try {
      main = readFileSync(mainPath ?? DEFAULT_MAIN, 'utf8')
    } catch {
      result.cannotCheck = `could not read ${mainLabel} (check: the skipped.append sites cannot be scanned)`
      return result
    }
  }
  const mainScan = scanSwift(main)
  const sites = findAppendSites(main, mainScan.masked)
  if (sites.error !== undefined) {
    result.cannotCheck = sites.error
    return result
  }
  if (sites.list.length === 0) {
    result.cannotCheck = `no skipped.append sites found in ${mainLabel} (check: an empty scan is not success)`
    return result
  }
  result.sites = sites.list.length

  const lines = main.split('\n')
  for (const site of sites.list) {
    const raw = main.slice(site.start, site.end + 1)
    const literals = mainScan.strings
      .filter((s) => s.start >= site.start && s.end <= site.end)
      .map((s) => s.content)
      .join(' ')
    const routesThroughPolicy = /\bspokenForReport\b/.test(raw)
    const reasons = []
    if (reportsLiveClaim(lines, site.line) && !routesThroughPolicy) {
      reasons.push(
        "reports a live claim in this file's own words instead of " +
          'QueenDelegationPolicy.spokenForReport(states:).detail',
      )
    }
    if (!routesThroughPolicy) {
      for (const word of claimWords) {
        if (new RegExp(`\\b${word}\\b`, 'i').test(literals)) {
          reasons.push(`hand-writes the policy's claim word "${word}"`)
        }
      }
    }
    if (reasons.length > 0) result.violations.push({ line: site.line, reasons })
  }
  result.ok = result.violations.length === 0
  return result
}

function runCli() {
  const args = process.argv.slice(2)
  if (args.length > 1) {
    console.error('usage: node queend-skip-wording.mjs [path-to-a-main.swift]')
    process.exit(2)
  }
  const result = spokenForWordingParity(args.length === 1 ? { mainPath: args[0] } : {})
  const display = args.length === 1 ? args[0] : relative(REPO_ROOT, DEFAULT_MAIN)
  if (result.cannotCheck !== null) {
    console.error(`queend-skip-wording: CANNOT CHECK - ${result.cannotCheck}`)
    process.exit(1)
  }
  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(
        `queend-skip-wording: FAIL - ${display}:${violation.line} skipped.append ${violation.reasons.join('; ')}`,
      )
    }
    console.error(
      `queend-skip-wording: ${result.sites} skipped.append site(s) scanned; ${result.violations.length} out of step with QueenPolicy`,
    )
    process.exit(1)
  }
  console.log(
    `queend-skip-wording: ok - scanned ${result.sites} skipped.append site(s) in ${display} (policy claim words: ${result.claimWords.join(', ')})`,
  )
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  } catch {
    return false
  }
})()
if (invokedDirectly) runCli()
