#!/usr/bin/env node
/**
 * browseros-info-claim-gate.mjs — gate for gHashTag/trios#1369.
 *
 * The browseros_info tool exists to tell a caller what the server can do,
 * and its prose claims "Built-in MCP server exposes N browser automation
 * tools to Claude Code, Gemini CLI, OpenAI Codex CLI, and Claude Desktop."
 * That N is a hand-written number sitting next to a registry that grows,
 * so it goes stale — it said 31 while the registry registered 73.
 *
 * This gate re-derives both numbers from their sources on every run and
 * exits zero only when they are equal:
 *
 *   - the registered count is parsed out of the registry source (the
 *     createRegistry([...]) array), never from a second hand-written list;
 *   - the stated count is parsed out of the info text sentence.
 *
 * Node standard library only — no installed dependencies — so it runs
 * anywhere the repository is checked out:
 *
 *   node trios/tools/browseros-info-claim-gate.mjs
 *
 * Exit codes:
 *   0  the stated count equals the registered count
 *   1  mismatch (both numbers found, they differ)
 *   2  a number could not be located (the message says which one)
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The gate sits at <repo>/tools/, so the repo root is its parent directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY_PATH = join(
  REPO_ROOT,
  'agent-server/apps/server/src/tools/registry.ts',
)
const INFO_PATH = join(
  REPO_ROOT,
  'agent-server/apps/server/src/tools/browseros-info.ts',
)

// The anchor for the registry array literal in registry.ts.
const REGISTRY_OPEN = 'export const registry = createRegistry(['

// A registered tool is referenced in the array as a bare identifier.
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// The claim sentence in browseros-info.ts, e.g. "... exposes 31 browser
// automation tools to Claude Code, ...". The capture group is the claim.
const STATED_COUNT_RE = /exposes\s+(\d+)\s+browser automation tools/

// The parsing rules are printed on every run so a disagreement can be
// judged from the gate output alone, without reading the gate.
const REGISTRY_RULE =
  'registered side — read agent-server/apps/server/src/tools/registry.ts, ' +
  'locate "' + REGISTRY_OPEN + '" and take the text up to the matching "])"; ' +
  'strip // line comments and /* */ block comments; split what remains on ' +
  'commas; every non-empty entry must be a bare identifier, and each such ' +
  'identifier is one registered tool. (A commented-out entry such as ' +
  '"// wait_for" is removed with its comment and does not count.)'

const STATED_RULE =
  'stated side — read agent-server/apps/server/src/tools/browseros-info.ts; ' +
  'the stated count is the integer captured by the pattern ' +
  '/exposes\\s+(\\d+)\\s+browser automation tools/ in the "MCP Server for ' +
  'Developer Tools" prose that the browseros_info tool hands to callers.'

/** Remove line comments and block comments from TypeScript source. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

/**
 * Parse the registered tool names out of the registry source.
 *
 * Returns the array of names (whose length is the registered count), or
 * null if the createRegistry([...]) array cannot be located or any entry
 * in it is not a bare identifier — a gate that cannot read its input must
 * not report agreement.
 */
function registeredToolNames(source) {
  const stripped = stripComments(source)
  const open = stripped.indexOf(REGISTRY_OPEN)
  if (open === -1) return null
  const bodyStart = open + REGISTRY_OPEN.length

  // Comments are already stripped, so brackets inside them (for example
  // "// Navigation (8)") cannot unbalance this scan. Track only square
  // brackets: the array opens with '[' and closes with '])'.
  let depth = 1
  let i = bodyStart
  while (i < stripped.length) {
    const ch = stripped[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) break
    }
    i += 1
  }
  if (depth !== 0) return null

  const names = []
  for (const rawEntry of stripped.slice(bodyStart, i).split(',')) {
    const entry = rawEntry.trim()
    if (entry === '') continue // whitespace between entries
    if (!IDENTIFIER.test(entry)) return null // unrecognized entry shape
    names.push(entry)
  }
  return names
}

/**
 * Count the tools registered in the agent-server tool registry source.
 * Returns the count as a number, or null when it cannot be located.
 */
function countRegisteredTools(source) {
  const names = registeredToolNames(source)
  return names === null ? null : names.length
}

/**
 * Extract the tool count stated in the browseros_info prose.
 * Returns the count as a number, or null when it cannot be located.
 */
function statedToolCount(source) {
  const match = source.match(STATED_COUNT_RE)
  return match === null ? null : Number(match[1])
}

function readSource(absolutePath, label) {
  try {
    return readFileSync(absolutePath, 'utf8')
  } catch (err) {
    console.error(
      'ERROR: could not locate the ' + label + ' — cannot read ' + absolutePath +
        ' (' + err.message + ')',
    )
    process.exit(2)
  }
}

console.log('browseros-info claim gate (gHashTag/trios#1369)')
console.log('repo root: ' + REPO_ROOT)
console.log()
console.log('Parsing rules:')
console.log('  ' + REGISTRY_RULE)
console.log('  ' + STATED_RULE)
console.log()

const registrySource = readSource(REGISTRY_PATH, 'registry source')
const infoSource = readSource(INFO_PATH, 'info text')

const registeredCount = countRegisteredTools(registrySource)
if (registeredCount === null) {
  console.error(
    'ERROR: could not locate the registered tool count — no ' +
      '"' + REGISTRY_OPEN + '" array of bare tool identifiers found in ' +
      'agent-server/apps/server/src/tools/registry.ts',
  )
  process.exit(2)
}

const toolNames = registeredToolNames(registrySource)

const statedCount = statedToolCount(infoSource)
if (statedCount === null) {
  console.error(
    'ERROR: could not locate the stated tool count — no text matching ' +
      '/exposes\\s+(\\d+)\\s+browser automation tools/ found in ' +
      'agent-server/apps/server/src/tools/browseros-info.ts',
  )
  process.exit(2)
}

console.log('registered tool count = ' + registeredCount)
console.log('stated tool count     = ' + statedCount)
console.log()
console.log('registered tools (' + registeredCount + '):')
console.log('  ' + toolNames.join(', '))
console.log()

if (registeredCount !== statedCount) {
  console.error(
    'MISMATCH: the info text states ' + statedCount +
      ' browser automation tools but the registry registers ' +
      registeredCount + '.',
  )
  console.error(
    'Update the "Built-in MCP server exposes N browser automation tools" ' +
      'sentence in agent-server/apps/server/src/tools/browseros-info.ts, ' +
      'or the registry in agent-server/apps/server/src/tools/registry.ts.',
  )
  process.exit(1)
}

console.log(
  'OK: the info text states ' + statedCount +
    ' browser automation tools and the registry registers ' +
    registeredCount + '.',
)
