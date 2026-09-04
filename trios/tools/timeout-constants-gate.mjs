/**
 * timeout-constants-gate.mjs
 *
 * Keeps trios/agent-server/packages/shared/src/constants/timeouts.ts honest.
 *
 *  1. Every key defined in the TIMEOUTS object must have at least one consumer
 *     of the form `TIMEOUTS.<KEY>` somewhere under trios/agent-server/apps or
 *     trios/agent-server/packages. A key that names a budget nothing reads is
 *     the defect this gate exists to catch.
 *  2. No `AbortSignal.timeout(` call under trios/agent-server/apps/server/src
 *     may pass a bare numeric literal. Test fixtures and dev tooling elsewhere
 *     in the workspace intentionally keep numeric literals, so the literal
 *     check is scoped to the server source tree only.
 *  3. No bracket access (`TIMEOUTS[...]`) may appear anywhere in the walked
 *     set. Bracket access would make the textual census unsound and silently
 *     turn a live key into a reported orphan, so it is a hard failure.
 *
 * The key names are parsed from timeouts.ts at run time; nothing about the
 * keys is baked into this file, so a key added tomorrow is covered without
 * editing the gate. Consumer counts come from a filesystem walk, never from a
 * number written here. Uses only the Node standard library.
 *
 * Run from anywhere: node trios/tools/timeout-constants-gate.mjs
 * Exits 0 when the tree is consistent, 1 otherwise.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(dirname(TOOLS_DIR))

const TIMEOUTS_FILE = join(
  REPO_ROOT,
  'trios/agent-server/packages/shared/src/constants/timeouts.ts',
)
const CONSUMER_ROOTS = [
  join(REPO_ROOT, 'trios/agent-server/apps'),
  join(REPO_ROOT, 'trios/agent-server/packages'),
]
const LITERAL_ROOT = join(REPO_ROOT, 'trios/agent-server/apps/server/src')

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])
const SKIPPED_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
])

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIR_NAMES.has(entry.name)) {
        walk(join(dir, entry.name), files)
      }
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(extname(entry.name))
    ) {
      files.push(join(dir, entry.name))
    }
  }
  return files
}

function rel(path) {
  return relative(REPO_ROOT, path)
}

function lineNumbersOf(text, pattern) {
  const hits = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) hits.push(i + 1)
  }
  return hits
}

// --- Parse the key names out of timeouts.ts at run time --------------------

const timeoutsSource = readFileSync(TIMEOUTS_FILE, 'utf8')
const objectStart = timeoutsSource.indexOf('TIMEOUTS = {')
const objectEnd = timeoutsSource.indexOf('} as const', objectStart)
if (objectStart === -1 || objectEnd === -1) {
  console.error(
    `gate: could not locate the TIMEOUTS object in ${rel(TIMEOUTS_FILE)}`,
  )
  process.exit(1)
}
const objectBody = timeoutsSource.slice(objectStart, objectEnd)
const keys = [...objectBody.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map(
  (match) => match[1],
)
if (keys.length === 0) {
  console.error(
    `gate: found no keys in the TIMEOUTS object in ${rel(TIMEOUTS_FILE)}`,
  )
  process.exit(1)
}

// --- Walk the consumer scope ------------------------------------------------

const walkedFiles = CONSUMER_ROOTS.flatMap((root) => walk(root))
const censusFiles = walkedFiles.filter((file) => file !== TIMEOUTS_FILE)

const bracketAccess = []
const literalCallSites = []
const consumersByKey = new Map(keys.map((key) => [key, 0]))

for (const file of censusFiles) {
  const text = readFileSync(file, 'utf8')

  if (/TIMEOUTS\s*\[/.test(text)) {
    for (const line of lineNumbersOf(text, /TIMEOUTS\s*\[/)) {
      bracketAccess.push(`${rel(file)}:${line}`)
    }
  }

  const underLiteralRoot = file.startsWith(LITERAL_ROOT + '/')
  if (underLiteralRoot) {
    for (const line of lineNumbersOf(text, /AbortSignal\.timeout\(\s*[0-9]/)) {
      literalCallSites.push(`${rel(file)}:${line}`)
    }
  }

  for (const [key, count] of consumersByKey) {
    const pattern = new RegExp(`TIMEOUTS\\.${key}\\b`, 'g')
    consumersByKey.set(key, count + (text.match(pattern)?.length ?? 0))
  }
}

// --- Report -----------------------------------------------------------------

console.log(`timeout-constants-gate: ${keys.length} keys parsed from ${rel(TIMEOUTS_FILE)}`)
console.log(
  `consumer scope: ${CONSUMER_ROOTS.map(rel).join(', ')} (${censusFiles.length} files walked)`,
)
console.log('key census:')
for (const [key, count] of [...consumersByKey].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  console.log(`  ${key} ${count}`)
}

let failed = false

if (bracketAccess.length > 0) {
  failed = true
  console.error(
    '\nFAIL: bracket access on the TIMEOUTS object found; the textual census only works for `TIMEOUTS.<KEY>` access:',
  )
  for (const site of bracketAccess) {
    console.error(`  ${site}`)
  }
}

const orphanKeys = [...consumersByKey]
  .filter(([, count]) => count === 0)
  .map(([key]) => key)
if (orphanKeys.length > 0) {
  failed = true
  console.error(
    '\nFAIL: keys defined in timeouts.ts with zero consumers under the census scope. ' +
      'Either wire the key or delete it - a constant that documents a budget nothing reads is the defect this gate prevents:',
  )
  for (const key of orphanKeys.sort((a, b) => a.localeCompare(b))) {
    console.error(`  ${key}`)
  }
}

if (literalCallSites.length > 0) {
  failed = true
  console.error(
    '\nFAIL: AbortSignal.timeout call sites with a bare numeric literal under ' +
      `${rel(LITERAL_ROOT)}. Use a TIMEOUTS member instead:`,
  )
  for (const site of literalCallSites) {
    console.error(`  ${site}`)
  }
}

if (failed) {
  console.error('\ntimeout-constants-gate: FAIL')
  process.exit(1)
}

console.log('\ntimeout-constants-gate: PASS')
