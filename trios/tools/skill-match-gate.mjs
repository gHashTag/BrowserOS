#!/usr/bin/env node
// skill-match-gate.mjs — a text model of the skill routing in
// rings/SR-00/QueenSkillMatch.swift, checked against the filesystem.
//
// Why this exists (gHashTag/trios#1354): the routing folded every boundary
// path to lowercase before applying rules whose literals carry capital
// letters (`Tests.swift`, `Makefile`, `rings/RUST-`). Three literals in four
// rules could never match, so boundaries like `rings/RUST-13/...` fell
// through to "no skill at all". The worker image has no Swift compiler, so
// the fix ships with its own textual proof: this gate models the rules by
// parsing them out of the Swift source and reports which literals are
// reachable and which are dead.
//
// Constraints it honours:
//   - The rule literals are PARSED from the Swift source, never restated
//     here (FR-002). A copied list would go stale the way the doc comment's
//     skill count did.
//   - It invokes no Swift compiler and no make (FR-003); it only reads
//     files. There is no child process anywhere in this script.
//   - The skill count is taken from the directory listing, never a literal
//     (FR-004).
//   - Node standard library only (FR-005).
//
// Exit status: 0 when every rule literal is reachable, the doc comment's
// skill count equals the directories on disk, and each sample boundary
// resolves to a named skill; 1 otherwise; 2 when the source cannot be
// modelled (the gate refuses to guess).

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(TOOLS_DIR)
const SWIFT_PATH = join(REPO_ROOT, 'rings', 'SR-00', 'QueenSkillMatch.swift')
const SKILLS_ROOT = join(REPO_ROOT, '.claude', 'skills')

// The sample boundaries named by the issue. These are INPUTS to the model,
// not rules: the rules themselves are parsed out of the Swift file below.
const SAMPLE_BOUNDARIES = [
  'tests/api/x.test.ts',
  'Makefile',
  'rings/RUST-13/trios-mesh/src/lib.rs',
  'main.swift',
]

class GateError extends Error {}

// ---------------------------------------------------------------------------
// Parsing the Swift source
// ---------------------------------------------------------------------------

/**
 * Extract every rule literal from the Swift source's `rules` array.
 *
 * Each entry of the array is a `(predicate, skill)` pair where the predicate
 * is a disjunction of `$0.contains("...")` / `$0.hasSuffix("...")` tests.
 * The result preserves source order (rule order decides which skill wins)
 * and records, per literal, the operator and the skill its rule names.
 *
 * Throws GateError on any predicate shape it cannot model exactly — the
 * gate would rather refuse than guess at semantics it has not read.
 *
 * @param {string} source — the full text of QueenSkillMatch.swift
 * @returns {Array<{ruleIndex: number, op: 'contains'|'hasSuffix',
 *                  literal: string, skill: string}>}
 */
export function ruleLiterals(source) {
  const decl = source.indexOf('static let rules')
  if (decl === -1) throw new GateError('no `static let rules` declaration found')
  const open = source.indexOf('= [', decl)
  if (open === -1) throw new GateError('rules array initializer not found')
  const bracket = source.indexOf('[', open)
  // The array body contains no brackets of its own (the closures are flat
  // boolean expressions), so the first `]` after the opening `[` closes it.
  const close = source.indexOf(']', bracket)
  if (close === -1) throw new GateError('rules array is never closed')
  const body = source.slice(bracket + 1, close)

  const entry = /^\s*\(\s*\{(.+)\}\s*,\s*"([^"]+)"\s*\)\s*,?\s*$/
  const test = /[$]0\.(contains|hasSuffix)\("((?:[^"\\]|\\.)*)"\)/g
  const literals = []
  let ruleIndex = 0

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('//')) continue
    const pair = line.match(entry)
    if (!pair) throw new GateError(`cannot read rule entry: ${JSON.stringify(rawLine.trim())}`)
    const [, predicate, skill] = pair

    // Every `$0.` test in the predicate must be one we model, and the only
    // glue allowed between them is `||` (this source uses nothing else;
    // `&&` or anything stranger means the gate must be taught first).
    const residue = predicate.replace(test, '').replace(/[()|\s&]/g, '')
    if (residue !== '') {
      throw new GateError(
        `rule ${ruleIndex + 1} uses a predicate shape the gate cannot model ` +
          `(${JSON.stringify(predicate.trim())})`,
      )
    }
    if (predicate.includes('&&')) {
      throw new GateError(`rule ${ruleIndex + 1} uses &&, which the gate does not model`)
    }

    for (const m of predicate.matchAll(test)) {
      literals.push({
        ruleIndex: ruleIndex + 1,
        op: m[1],
        literal: JSON.parse(`"${m[2]}"`),
        skill,
      })
    }
    ruleIndex += 1
  }
  if (literals.length === 0) throw new GateError('the rules array contains no literals')
  return literals
}

/**
 * Determine how a boundary path is transformed before the rules see it, by
 * reading the call site: `rules.first(where: { $0.matches(EXPR) })`.
 * `path` means compared as written; an identifier bound by
 * `let EXPR = path.lowercased()` means folded to lowercase first. The
 * distinction is the whole bug: a folded path can never contain a literal
 * with a capital letter in it.
 *
 * @param {string} source
 * @returns {{kind: 'as-written'|'lowercased', evidence: string}}
 */
export function pathTransform(source) {
  const call = source.match(/rules\.first\(where:\s*\{\s*[$]0\.matches\(([^)]+)\)/)
  if (!call) throw new GateError('no `rules.first(where: { $0.matches(...) })` call found')
  const arg = call[1].trim()
  if (arg === 'path') {
    return { kind: 'as-written', evidence: '$0.matches(path)' }
  }
  const fold = source.match(new RegExp(`let\\s+${arg}\\s*=\\s*path\\.lowercased\\(\\)`))
  if (fold) {
    return { kind: 'lowercased', evidence: `let ${arg} = path.lowercased() → $0.matches(${arg})` }
  }
  throw new GateError(`cannot tell how the matched path "${arg}" is derived from "path"`)
}

/**
 * The skill count the file's own doc comment claims, parsed out of the
 * sentence "N of them sit in `.claude/skills/`" — digits or spelled-out
 * English ("Twenty-six", "Thirty-one"), because the sentence today is prose.
 *
 * @param {string} source
 * @returns {{stated: number, quote: string}}
 */
export function docCommentSkillCount(source) {
  // The sentence names the directory it is counting a line-break away from
  // its verb ("... of them sit in\n`.claude/skills/`"), so the skills
  // reference is a lookahead that may span a newline.
  const digits = source.match(/(\d+)\s+of them\s+sit in(?=[\s\S]{0,160}?\.claude\/skills)/)
  if (digits) return { stated: Number(digits[1]), quote: docSentence(source, digits) }

  const words = source.match(/([A-Za-z]+(?:-[a-z]+)?)\s+of them\s+sit in(?=[\s\S]{0,160}?\.claude\/skills)/)
  if (words) {
    const stated = parseEnglishNumber(words[1])
    if (stated !== null) return { stated, quote: docSentence(source, words) }
    throw new GateError(`cannot read the number "${words[1]}" in the doc comment`)
  }
  throw new GateError('the doc comment no longer states how many skills sit in .claude/skills/')
}

/** The counted sentence, flattened to one line for the report. */
function docSentence(source, match) {
  const tail = source.slice(match.index, match.index + 200)
  const skillsAt = tail.indexOf('.claude/skills/')
  const quoteEnd = tail.indexOf('`', skillsAt)
  // A sentence-wrapped comment carries its own `///` markers; drop them.
  return tail.slice(0, quoteEnd + 1).replace(/\/\/+/g, '').replace(/\s+/g, ' ').trim()
}

const SMALL_NUMBERS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
}
const TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
}

/** "Twenty-six" -> 26, "Thirty-one" -> 31; null when not a plain English count. */
function parseEnglishNumber(word) {
  const parts = word.toLowerCase().split('-')
  if (parts.length === 1) return SMALL_NUMBERS[parts[0]] ?? TENS[parts[0]] ?? null
  if (parts.length === 2 && TENS[parts[0]] !== undefined && SMALL_NUMBERS[parts[1]] !== undefined) {
    return TENS[parts[0]] + SMALL_NUMBERS[parts[1]]
  }
  return null
}

/** Count the skill directories actually installed under .claude/skills/. */
export function countSkillDirectories(root) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (err) {
    throw new GateError(`cannot read the skills directory ${root}: ${err.message}`)
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}

// ---------------------------------------------------------------------------
// The model: applying the parsed rules the way the Swift code applies them
// ---------------------------------------------------------------------------

/** Swift's `contains` / `hasSuffix` are exact, case-sensitive string tests. */
function testHolds(op, literal, candidate) {
  return op === 'contains' ? candidate.includes(literal) : candidate.endsWith(literal)
}

/**
 * Resolve one boundary path through the parsed rules, first match wins,
 * honouring the path transform the source applies. Returns the winning
 * rule, the literal of that rule that fired, and the skill it names —
 * or null when nothing matches (which is what "dispatched with no skill
 * at all" looks like from the outside).
 */
export function modelResolve(path, literals, transform) {
  const candidate = transform.kind === 'lowercased' ? path.toLowerCase() : path
  const rules = [...new Set(literals.map((l) => l.ruleIndex))]
  for (const ruleIndex of rules) {
    const own = literals.filter((l) => l.ruleIndex === ruleIndex)
    const fired = own.find((l) => testHolds(l.op, l.literal, candidate))
    if (fired) {
      return { ruleIndex, literal: fired.literal, op: fired.op, skill: fired.skill }
    }
  }
  return null
}

/**
 * Prove a literal reachable by exhibiting a boundary path that routes
 * through it, or prove it dead by showing no path ever can.
 *
 * Reachability is checked mechanically: the witness is run through the same
 * modelResolve the samples go through, and must come back through THIS
 * literal. Deadness under a lowercasing transform is an argument about
 * alphabets: a folded string is all lowercase, so a literal holding any
 * capital letter can never appear in it.
 */
function judgeLiteral(l, literals, transform) {
  if (transform.kind === 'lowercased' && l.literal !== l.literal.toLowerCase()) {
    return {
      ...l,
      reachable: false,
      detail:
        'the path is folded to lowercase before the rules run, so this ' +
        `literal's capital letters ("${[...l.literal].find((c) => c !== c.toLowerCase())}") can never appear in it`,
    }
  }
  // Candidates are built in the pre-fold domain; modelResolve applies the
  // transform itself.
  const candidates =
    l.op === 'hasSuffix'
      ? [`Sample${l.literal}`, `x${l.literal}`]
      : [`${l.literal}note.md`, `dir/${l.literal}entry`, l.literal]
  for (const witness of candidates) {
    const hit = modelResolve(witness, literals, transform)
    if (hit && hit.ruleIndex === l.ruleIndex && hit.literal === l.literal) {
      return { ...l, reachable: true, detail: `witness "${witness}" routes through this literal` }
    }
  }
  return {
    ...l,
    reachable: false,
    detail: 'no boundary path could be found that routes through this literal',
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function pad(text, width) {
  const s = String(text)
  return s + ' '.repeat(Math.max(0, width - s.length))
}

function main() {
  const source = readFileSync(SWIFT_PATH, 'utf8')
  const literals = ruleLiterals(source)
  const transform = pathTransform(source)
  const skillDirs = countSkillDirectories(SKILLS_ROOT)
  const doc = docCommentSkillCount(source)

  const failures = []

  console.log(`skill-match-gate: modelling ${SWIFT_PATH}`)
  console.log(`path transform applied before the rules: ${transform.evidence}`)
  console.log('')

  console.log(`rule literals parsed from source (${literals.length}):`)
  const judged = literals.map((l) => judgeLiteral(l, literals, transform))
  for (const j of judged) {
    console.log(
      `  rule ${j.ruleIndex}  ${pad(j.op, 10)} ${pad(JSON.stringify(j.literal), 16)} -> ${pad(j.skill, 18)} ${j.reachable ? 'reachable' : 'DEAD'}   (${j.detail})`,
    )
  }
  const dead = judged.filter((j) => !j.reachable)
  if (dead.length > 0) {
    console.log(`  dead literals (${dead.length}): ${dead.map((d) => `"${d.literal}"`).join(', ')}`)
    failures.push(`${dead.length} rule literal(s) can never match: ${dead.map((d) => `"${d.literal}"`).join(', ')}`)
  } else {
    console.log('  dead literals (0): every declared rule can match something')
  }
  console.log('')

  console.log(`skill directories counted in .claude/skills: ${skillDirs.length}`)
  console.log(`doc comment states: ${doc.stated}   ("${doc.quote}")`)
  if (doc.stated !== skillDirs.length) {
    console.log(`  counts diverge: ${doc.stated} stated vs ${skillDirs.length} installed`)
    failures.push(`the doc comment states ${doc.stated} skills but ${skillDirs.length} directories are installed`)
  } else {
    console.log('  counts agree')
  }
  console.log('')

  console.log('sample boundaries through the model (first matching rule wins):')
  let unresolved = 0
  for (const sample of SAMPLE_BOUNDARIES) {
    const hit = modelResolve(sample, literals, transform)
    if (hit) {
      console.log(
        `  ${pad(JSON.stringify(sample), 38)} -> ${hit.skill}  (rule ${hit.ruleIndex}, ${hit.op} ${JSON.stringify(hit.literal)})`,
      )
    } else {
      console.log(`  ${pad(JSON.stringify(sample), 38)} -> NONE  (no rule matches; dispatched with no skill)`)
      unresolved += 1
    }
  }
  if (unresolved > 0) {
    failures.push(`${unresolved} of ${SAMPLE_BOUNDARIES.length} sample boundaries resolve to no skill`)
  }
  console.log('')

  if (failures.length > 0) {
    console.log(`FAIL (${failures.length}):`)
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  } else {
    console.log('PASS: no dead literals, doc count matches the disk, every sample resolves.')
    process.exitCode = 0
  }
}

try {
  main()
} catch (err) {
  if (err instanceof GateError) {
    console.error(`skill-match-gate: cannot model the source — ${err.message}`)
    process.exitCode = 2
  } else {
    throw err
  }
}
