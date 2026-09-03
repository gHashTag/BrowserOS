#!/usr/bin/env node
/**
 * test-group-shadow-audit
 *
 * Audits the server test-group runner
 * (agent-server/apps/server/tests/__helpers__/run-test-group.ts) for
 * reserved-name shadowing: a directory under tests/ whose name is one of the
 * runner's reserved group names ("all", "core", "cdp", "root", ...) is still
 * enumerated as a group, but the runner resolves that name elsewhere, so the
 * directory's tests are never executed by any group.
 *
 * The reserved-name list is NOT copied into this audit. It is read from the
 * runner's own source (the exported `reservedGroupNames`), so a name that is
 * reserved in the runner later is covered by this audit automatically. A copy
 * here would reproduce the original defect one level up: it would go stale
 * the moment the runner's list changed.
 *
 * Usage:
 *   node tools/test-group-shadow-audit.mjs [tests-directory]
 *
 * With no argument, the real tree at ../agent-server/apps/server/tests is
 * audited. Pass a path to audit a scratch tree instead; the reserved names
 * are still read from that tree's own copy of the runner.
 *
 * Runs under plain node with the Node standard library only. Exit codes:
 *   0 - no test directory is shadowed by a reserved group name
 *   1 - FINDING: at least one test directory is shadowed (named below)
 *   2 - the audit could not run (missing tree or runner, unreadable list)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultTestsRoot = resolve(
  scriptDir,
  '..',
  'agent-server',
  'apps',
  'server',
  'tests',
)
const testsRoot = resolve(process.argv[2] ?? defaultTestsRoot)
const runnerSourcePath = join(testsRoot, '__helpers__', 'run-test-group.ts')

function fail(message) {
  console.error(`test-group-shadow-audit: ${message}`)
  process.exit(2)
}

if (!existsSync(testsRoot)) {
  fail(`tests directory not found: ${testsRoot}`)
}
if (!existsSync(runnerSourcePath)) {
  fail(`runner source not found: ${runnerSourcePath}`)
}

// --- reserved names: read from the runner, never copied ---------------------

function readReservedGroupNames(source) {
  const match = source.match(
    /export\s+const\s+reservedGroupNames[^=]*=\s*\[([^\]]*)\]/,
  )
  if (!match) {
    fail(
      `${runnerSourcePath} does not export reservedGroupNames as an array ` +
        'literal; this audit refuses to guess the reserved names',
    )
  }
  const names = match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter((entry) => entry.length > 0)
  if (names.length === 0) {
    fail(`reservedGroupNames in ${runnerSourcePath} parsed as an empty list`)
  }
  return names
}

const reservedGroupNames = readReservedGroupNames(
  readFileSync(runnerSourcePath, 'utf8'),
)

// --- enumeration and resolution mirror ---------------------------------------
// The functions below mirror the runner's listAllGroups(),
// getAtomicGroupTargets() and getCompositeGroupMembers() so this audit
// reports what the runner would actually do. The runner is TypeScript run
// under bun; this audit must run under plain node with the standard library
// only, so it cannot import the runner and mirrors it instead.

const ignoredDirectories = new Set(['__fixtures__', '__helpers__'])
const rootGroupExclusions = new Set(['server.integration.test.ts'])
const testFilePattern = /\.(test|spec)\.[cm]?[jt]sx?$/
const preferredDirectoryGroups = ['agent', 'api', 'skills', 'tools', 'browser']

function compareGroupNames(left, right) {
  const leftIndex = preferredDirectoryGroups.indexOf(left)
  const rightIndex = preferredDirectoryGroups.indexOf(right)
  const leftRank =
    leftIndex === -1 ? preferredDirectoryGroups.length : leftIndex
  const rightRank =
    rightIndex === -1 ? preferredDirectoryGroups.length : rightIndex
  if (leftRank !== rightRank) {
    return leftRank - rightRank
  }
  return left.localeCompare(right)
}

function listDirectoryGroups() {
  return readdirSync(testsRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !ignoredDirectories.has(entry.name),
    )
    .map((entry) => entry.name)
    .sort(compareGroupNames)
}

function listRootTestTargets() {
  return readdirSync(testsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && testFilePattern.test(entry.name))
    .filter((entry) => !rootGroupExclusions.has(entry.name))
    .map((entry) => `./tests/${entry.name}`)
    .sort((left, right) => left.localeCompare(right))
}

function listAllGroups() {
  const groups = new Set(listDirectoryGroups())
  if (existsSync(join(testsRoot, 'server.integration.test.ts'))) {
    groups.add('integration')
  }
  if (listRootTestTargets().length > 0) {
    groups.add('root')
  }
  return [...groups]
}

function getAtomicGroupTargets(group) {
  if (group === 'cdp') {
    return getAtomicGroupTargets('browser')
  }
  if (group === 'integration') {
    const targets = []
    if (existsSync(join(testsRoot, 'integration'))) {
      targets.push('./tests/integration')
    }
    if (existsSync(join(testsRoot, 'server.integration.test.ts'))) {
      targets.push('./tests/server.integration.test.ts')
    }
    return targets
  }
  if (group === 'root') {
    return listRootTestTargets()
  }
  if (existsSync(join(testsRoot, group))) {
    return [`./tests/${group}`]
  }
  return []
}

function describeGroup(group) {
  if (group === 'all') {
    return { composite: true, resolution: listAllGroups() }
  }
  if (group === 'core') {
    return { composite: true, resolution: ['agent', 'api', 'skills', 'root'] }
  }
  return { composite: false, resolution: getAtomicGroupTargets(group) }
}

// --- audit --------------------------------------------------------------------

const directoryNames = new Set(
  readdirSync(testsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
)

const groups = listAllGroups()
const shadowed = groups
  .filter((group) => directoryNames.has(group))
  .filter((group) => reservedGroupNames.includes(group))
  .map((group) => ({ group, ...describeGroup(group) }))

const width = Math.max(...groups.map((group) => group.length))

console.log('test-group-shadow-audit')
console.log(`tests directory: ${testsRoot}`)
console.log(`runner source:   ${runnerSourcePath}`)
console.log(
  `reserved group names (read from the runner source): ${reservedGroupNames.join(', ')}`,
)
console.log('')
console.log('enumerated groups and their resolved targets:')
for (const group of groups) {
  const { composite, resolution } = describeGroup(group)
  const rendered = composite
    ? `composite -> ${resolution.join(', ')}`
    : resolution.length > 0
      ? resolution.join(', ')
      : '(no targets)'
  console.log(`  ${group.padEnd(width)} -> ${rendered}`)
}
console.log('')

if (shadowed.length === 0) {
  console.log(
    'no test directory is shadowed by a reserved group name (exit 0)',
  )
  process.exit(0)
}

console.log(
  `FINDING: ${shadowed.length} test ${
    shadowed.length === 1 ? 'directory shares' : 'directories share'
  } a name with a reserved group and ${
    shadowed.length === 1 ? 'is' : 'are'
  } therefore at risk of never being executed (exit 1):`,
)
for (const { group, composite, resolution } of shadowed) {
  const selfTarget = `./tests/${group}`
  if (!composite && resolution.includes(selfTarget)) {
    // The runner reserves this name but this audit's mirror has no special
    // case for it, so the mirror still resolves it generically. A reserved
    // name is not guaranteed to keep resolving into a same-named directory,
    // so the collision is reported rather than waved through.
    console.log(
      `  tests/${group}/ is enumerated as group "${group}"; that name is reserved by the runner ` +
        `(this audit's mirror still resolves it to ${resolution.join(', ')}). ` +
        'A reserved name may be re-pointed at any time, so this collision is reported.',
    )
    continue
  }
  const rendered = composite
    ? `the composite group [${resolution.join(', ')}]`
    : resolution.length > 0
      ? resolution.join(', ')
      : '(nothing)'
  console.log(
    `  tests/${group}/ is enumerated as group "${group}", but that reserved name resolves to: ${rendered}`,
  )
}
process.exit(1)
