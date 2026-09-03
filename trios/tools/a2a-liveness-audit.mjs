#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A2A liveness audit - gHashTag/trios#1388.
 *
 * RING-01 (trios/rings/T27-01/a2a.t27) states the liveness rule once and
 * derives it: HEARTBEAT_INTERVAL_SECONDS * MISSED_BEATS_BEFORE_OFFLINE.
 * This tool reads those two constants out of the spec by text, computes
 * their product, and checks every liveness site it can find in the A2A
 * registry service against that one number. A threshold written by hand
 * in the service can then no longer drift from the spec unnoticed.
 *
 * It prints one line per liveness site - the agreements too - plus the
 * total site count, and exits non-zero when any site disagrees, when a
 * site count below the expected floor means the patterns stopped matching
 * the file, or when the spec constants cannot be parsed (no default is
 * ever substituted). The watchdog's setInterval argument is printed and
 * labelled as a poll cadence; it is never compared and never counted.
 *
 * Usage, from the repository root:
 *
 *   node trios/tools/a2a-liveness-audit.mjs
 *
 * Optional, to audit copies of either file (planted-literal and
 * missing-constant checks):
 *
 *   node trios/tools/a2a-liveness-audit.mjs --service <path> [--spec <path>]
 *
 * Node standard library only. Installs nothing.
 */

import { readFileSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SPEC_DEFAULT = 'trios/rings/T27-01/a2a.t27'
const SERVICE_DEFAULT =
  'trios/agent-server/apps/server/src/api/services/a2a/a2a-registry-service.ts'

const SPEC_INTERVAL_NAME = 'HEARTBEAT_INTERVAL_SECONDS'
const SPEC_MISSED_BEATS_NAME = 'MISSED_BEATS_BEFORE_OFFLINE'

const MS_PER_SECOND = 1000
// FR-002: a run that finds fewer liveness sites than this is a gate whose
// patterns have stopped matching the file, and must fail rather than pass
// by finding nothing.
const MIN_LIVENESS_SITES = 3

// A numeric literal with optional underscore digit separators.
const NUMERIC_LITERAL = /^\d[\d_]*$/
// The shared helper called with an explicit unit (FR-008).
const DERIVED_CALL = /^a2aLivenessThreshold\(\s*['"](\w+)['"]\s*\)$/

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--spec' || arg === '--service') {
      const value = argv[i + 1]
      if (value === undefined) {
        fail(`${arg} requires a path`)
      }
      args[arg.slice(2)] = value
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node trios/tools/a2a-liveness-audit.mjs [--spec <path>] [--service <path>]',
      )
      process.exit(0)
    } else {
      fail(`unknown argument: ${arg}`)
    }
  }
  return args
}

function parseNumericLiteral(text) {
  return Number.parseInt(text.replace(/_/g, ''), 10)
}

/**
 * Read one named i32 constant out of the spec text. Returns null when the
 * constant is absent; the caller decides how to report that, and no default
 * value is ever substituted here.
 */
function parseSpecConstant(specText, name) {
  const pattern = new RegExp(`pub\\s+const\\s+${name}\\s*:[^=]*=\\s*(-?\\d+)`)
  const match = specText.match(pattern)
  return match === null ? null : parseNumericLiteral(match[1])
}

/**
 * Turn the value written at one site into a verdict. Sites have a known
 * unit: the memory-path threshold assignments are milliseconds, and
 * pruneOffline's argument is seconds (pg-agent-store.ts declares it as
 * thresholdSeconds). A numeric literal is compared against the spec value
 * in that unit; a call to the shared helper must name the site's own unit;
 * anything else cannot be resolved and counts as a disagreement.
 */
function judgeSite({ lineNumber, kind, unit, written }) {
  const specValue =
    unit === 's' ? spec.offlineAfterSeconds : spec.offlineAfterMilliseconds

  if (NUMERIC_LITERAL.test(written)) {
    const value = parseNumericLiteral(written)
    return {
      lineNumber,
      kind,
      unit,
      classification: 'literal',
      description: `${kind} ${value} ${unit} vs spec ${specValue} ${unit}`,
      agrees: value === specValue,
    }
  }

  const derived = written.match(DERIVED_CALL)
  if (derived !== null) {
    const unitArg = derived[1]
    const unitMatches =
      (unit === 's' && unitArg === 'seconds') ||
      (unit === 'ms' && unitArg === 'milliseconds')
    return {
      lineNumber,
      kind,
      unit,
      classification: 'derived',
      description: unitMatches
        ? `${kind} in ${unit} via a2aLivenessThreshold vs spec ${specValue} ${unit}`
        : `${kind} calls a2aLivenessThreshold('${unitArg}') but this site is in ${unit}`,
      agrees: unitMatches,
    }
  }

  return {
    lineNumber,
    kind,
    unit,
    classification: 'literal',
    description: `${kind} ${written} is neither a number nor a2aLivenessThreshold(...)`,
    agrees: false,
  }
}

const args = parseArgs(process.argv.slice(2))

// Defaults are anchored to this tool's own location, so the command works
// from the repository root as documented and from anywhere else besides.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const specPath = resolve(repoRoot, args.spec ?? SPEC_DEFAULT)
const servicePath = resolve(repoRoot, args.service ?? SERVICE_DEFAULT)

const displayPath = (p) => {
  const rel = relative(repoRoot, p)
  return rel.startsWith('..') ? p : rel
}

let specText
let serviceText
try {
  specText = readFileSync(specPath, 'utf8')
} catch (err) {
  fail(`cannot read spec ${displayPath(specPath)}: ${err.message}`)
}
try {
  serviceText = readFileSync(servicePath, 'utf8')
} catch (err) {
  fail(`cannot read service ${displayPath(servicePath)}: ${err.message}`)
}

const intervalSeconds = parseSpecConstant(specText, SPEC_INTERVAL_NAME)
const missedBeats = parseSpecConstant(specText, SPEC_MISSED_BEATS_NAME)

const missing = []
if (intervalSeconds === null) {
  missing.push(SPEC_INTERVAL_NAME)
}
if (missedBeats === null) {
  missing.push(SPEC_MISSED_BEATS_NAME)
}
if (missing.length > 0) {
  fail(
    `cannot parse ${missing.join(' and ')} from ${displayPath(specPath)}; refusing to substitute a default`,
  )
}

const spec = {
  intervalSeconds,
  missedBeats,
  offlineAfterSeconds: intervalSeconds * missedBeats,
  offlineAfterMilliseconds: intervalSeconds * missedBeats * MS_PER_SECOND,
}

const sites = []
const cadences = []
const serviceLines = serviceText.split('\n')

function countParens(text) {
  let depth = 0
  for (const ch of text) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
  }
  return depth
}

/**
 * The argument of a call whose opening '(' ends `opener` on
 * startLineIndex. Formatters may wrap the call across lines, so following
 * lines are joined until the parentheses balance; the call's own closing
 * paren and a trailing comma are stripped from the result.
 */
function collectCallArgument(lines, startLineIndex, opener) {
  let depth = 1 + countParens(opener)
  let text = opener
  let idx = startLineIndex
  while (depth > 0 && idx + 1 < lines.length) {
    idx += 1
    const next = lines[idx].trim()
    text += ` ${next}`
    depth += countParens(next)
  }
  return {
    argument: text.replace(/\)\s*$/, '').replace(/,\s*$/, '').trim(),
    endLineIndex: idx,
  }
}

/**
 * The right-hand side of an assignment starting on startLineIndex, joined
 * across lines the same way when the value is a wrapped call.
 */
function collectAssignedValue(lines, startLineIndex, opener) {
  let depth = countParens(opener)
  let text = opener
  let idx = startLineIndex
  while (depth > 0 && idx + 1 < lines.length) {
    idx += 1
    const next = lines[idx].trim()
    text += ` ${next}`
    depth += countParens(next)
  }
  return {
    value: text.replace(/;\s*$/, '').trim(),
    endLineIndex: idx,
  }
}

let i = 0
while (i < serviceLines.length) {
  const lineNumber = i + 1
  const line = serviceLines[i]

  // The numeric close of a setInterval call: a poll cadence, not a
  // liveness threshold. Printed and labelled, never compared (FR-004).
  const cadence = line.match(/^\s*\}\s*,\s*(\d[\d_]*)\s*\)\s*$/)
  if (cadence !== null) {
    cadences.push({
      lineNumber,
      milliseconds: parseNumericLiteral(cadence[1]),
    })
    i += 1
    continue
  }

  // pruneOffline(...) takes its argument in seconds.
  const prune = line.match(/pruneOffline\((.*)$/)
  if (prune !== null) {
    const collected = collectCallArgument(serviceLines, i, prune[1])
    sites.push(
      judgeSite({
        lineNumber,
        kind: 'pruneOffline',
        unit: 's',
        written: collected.argument,
      }),
    )
    i = collected.endLineIndex + 1
    continue
  }

  // A threshold assignment on the memory path is in milliseconds.
  const threshold = line.match(/^\s*(?:const|let|var)\s+threshold\s*=\s*(.*)$/)
  if (threshold !== null) {
    const collected = collectAssignedValue(serviceLines, i, threshold[1])
    sites.push(
      judgeSite({
        lineNumber,
        kind: 'threshold',
        unit: 'ms',
        written: collected.value,
      }),
    )
    i = collected.endLineIndex + 1
    continue
  }

  i += 1
}

console.log(
  `spec ${displayPath(specPath)}: ${spec.intervalSeconds} s x ${spec.missedBeats} beats = ` +
    `${spec.offlineAfterSeconds} s (${spec.offlineAfterMilliseconds} ms)`,
)
console.log(`service ${displayPath(servicePath)}`)

const fileName = basename(servicePath)
for (const site of sites) {
  const verdict = site.agrees ? 'AGREES' : 'DISAGREES'
  console.log(
    `  ${fileName}:${site.lineNumber}  ${site.classification}  ${site.description}  ${verdict}`,
  )
}
for (const cadence of cadences) {
  console.log(
    `  ${fileName}:${cadence.lineNumber}  cadence  setInterval ${cadence.milliseconds} ms` +
      ' - poll interval, not a liveness threshold, not compared',
  )
}

const disagreements = sites.filter((site) => !site.agrees).length

console.log(`liveness sites: ${sites.length}`)
console.log(`disagreements: ${disagreements}`)

if (sites.length < MIN_LIVENESS_SITES) {
  console.error(
    `error: found ${sites.length} liveness sites, expected at least ${MIN_LIVENESS_SITES}; ` +
      'the file has likely changed shape',
  )
  process.exit(1)
}

process.exit(disagreements === 0 ? 0 : 1)
