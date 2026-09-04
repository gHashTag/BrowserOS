#!/usr/bin/env node
/**
 * queend-path-audit — fail when a test file names a queend path on its own.
 *
 * WHY THIS EXISTS. The api suite once resolved the policy binary in three
 * different hard-coded ways while production read one environment variable
 * with a container fallback. Every parity case was skipped on every machine
 * that mattered, and the sentinel meant to catch the drift compared a string
 * against a substring of itself. This tool walks the test tree on the
 * filesystem — no hard-coded file list — and goes red the moment a test file
 * names a queend path without going through the shared resolver in
 * `tests/__helpers__/queend-path.ts`.
 *
 * HOW IT DECIDES. The environment variable name and the container fallback
 * are not written down here. They are parsed out of the production resolver
 * (`queen-tick.ts`) at run time, so the audit can never disagree with
 * production about what it is looking for. If that parse fails, the tool
 * exits non-zero rather than guessing.
 *
 * A test file is in violation when it contains any of:
 *
 *   - the environment variable name `queendPath()` reads,
 *   - the container fallback literal `queendPath()` returns,
 *   - the repository-local release build path, or
 *   - any other string literal that ends in a `/queend` path segment,
 *
 * and, for the last kind only, the file does not import the shared resolver.
 * The first three are never allowed in a test file at all; the shared helper
 * is their only home. The fourth is allowed in files that import the helper,
 * because the parser tests legitimately quote fixture paths.
 *
 * Usage: node trios/tools/queend-path-audit.mjs [--root <dir>]
 * Exit:  0 clean, 1 violations found, 2 the tool could not run.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER_IMPORT = '__helpers__/queend-path'
const BUILD_PATH = 'queen-core/.build/release/queend'
// A string literal that ends in a `/queend` segment, e.g. '/opt/queend'. The
// quote character is required so a source path such as
// `queen-core/Sources/queend/main.swift` — a file, not the binary — is not a
// finding, and `queend-path` (the helper's own name) is not either.
const QUEEND_LITERAL = /\/queend(?=['"`])/

function die(message) {
  console.error(`queend path audit: ${message}`)
  process.exit(2)
}

const argv = process.argv.slice(2)
const scriptRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let root = scriptRoot
if (argv.length > 0) {
  if (argv.length !== 2 || argv[0] !== '--root') {
    die('usage: node trios/tools/queend-path-audit.mjs [--root <dir>]')
  }
  root = argv[1]
}

const queenTickPath = join(
  root,
  'trios/agent-server/apps/server/src/api/services/queen-tick.ts',
)
const testsDir = join(root, 'trios/agent-server/apps/server/tests')

if (!existsSync(queenTickPath)) {
  die(
    `cannot read ${relative(root, queenTickPath)} — the environment variable ` +
      'name and container fallback are derived from it and must not be guessed',
  )
}
if (!existsSync(testsDir)) {
  die(`cannot walk ${relative(root, testsDir)} — no such directory`)
}

/**
 * Extract `process.env.<VAR> || '<literal>'` from the body of `queendPath()`.
 * Throws when the function, the variable or the literal cannot be found — a
 * silent default here is exactly the defect this tool exists to catch.
 */
function parseQueenTick(source) {
  const fn = /(?:export\s+)?function\s+queendPath\s*\([^)]*\)[^{]*\{/.exec(source)
  if (!fn) throw new Error('queendPath() not found')
  const open = fn.index + fn[0].length - 1
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        const body = source.slice(open + 1, i)
        const ret =
          /process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*\|\|\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/.exec(
            body,
          )
        if (!ret) {
          throw new Error(
            'no `process.env.<VAR> || "<literal>"` inside queendPath()',
          )
        }
        return { envVar: ret[1], fallback: ret[3] }
      }
    }
  }
  throw new Error('queendPath() body is unterminated')
}

let parsed
try {
  parsed = parseQueenTick(readFileSync(queenTickPath, 'utf8'))
} catch (error) {
  die(`cannot parse ${relative(root, queenTickPath)}: ${error.message}`)
}
const { envVar, fallback } = parsed

/** Files that name a queend path are never allowed to hold these literals. */
const forbiddenLiterals = [
  {
    needle: envVar,
    what: `the environment variable ${envVar} that queendPath() reads`,
  },
  {
    needle: fallback,
    what: `the container fallback ${fallback} that queendPath() returns`,
  },
  { needle: BUILD_PATH, what: 'the repository-local queend build path' },
]

function walk(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(path))
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(path)
  }
  return found
}

const testFiles = walk(testsDir).sort()
const violations = []
for (const file of testFiles) {
  const rel = relative(root, file)
  const text = readFileSync(file, 'utf8')
  const usesSharedResolver = text.includes(HELPER_IMPORT)
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const at = `${rel}:${index + 1}`
    for (const { needle, what } of forbiddenLiterals) {
      if (line.includes(needle)) {
        violations.push(`${at}: names ${what} instead of the shared resolver`)
      }
    }
    if (!usesSharedResolver && QUEEND_LITERAL.test(line)) {
      violations.push(
        `${at}: names a queend path without importing ${HELPER_IMPORT}`,
      )
    }
  }
}

for (const violation of violations) console.log(violation)
console.log(
  `queend path audit: ${violations.length} violations across ${testFiles.length} test files`,
)
process.exit(violations.length > 0 ? 1 : 0)
