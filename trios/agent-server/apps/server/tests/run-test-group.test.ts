/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  buildTestCommand,
  getAtomicGroupTargets,
  listAllGroups,
  reservedGroupNames,
  withTestEnv,
} from './__helpers__/run-test-group'

const directoryNames = new Set(
  readdirSync(import.meta.dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
)

describe('withTestEnv', () => {
  it('defaults NODE_ENV to test when absent', () => {
    expect(withTestEnv({ PATH: '/usr/bin' }).NODE_ENV).toBe('test')
  })

  it('preserves an explicit NODE_ENV', () => {
    expect(withTestEnv({ NODE_ENV: 'production' }).NODE_ENV).toBe('production')
  })
})

describe('buildTestCommand', () => {
  it('preloads the test env bootstrap before running targets', () => {
    expect(buildTestCommand(['./tests/api'])).toEqual([
      process.execPath,
      '--env-file=.env.development',
      'test',
      '--preload=./tests/__helpers__/test-env.ts',
      './tests/api',
    ])
  })
})

describe('test groups', () => {
  it('includes the lib tests in the group list', () => {
    expect(listAllGroups()).toContain('lib')
  })

  it('runs root and directory integration tests in the integration group', () => {
    expect(getAtomicGroupTargets('integration')).toEqual([
      './tests/integration',
      './tests/server.integration.test.ts',
    ])
  })

  it('resolves every enumerated group that names a directory into that directory', () => {
    // listAllGroups() returns a spread of a Set, so asserting it has no
    // duplicates can never fail. What can fail is shadowing: a directory
    // under tests/ whose name is reserved (all, core, cdp, root) is
    // enumerated as a group, but that name resolves elsewhere and the
    // directory's tests are never run. Assert the real property instead.
    const shadowed = listAllGroups()
      .filter((group) => directoryNames.has(group))
      .map((group) => ({
        group,
        reserved: reservedGroupNames.includes(group),
        resolvesTo: getAtomicGroupTargets(group),
      }))
      .filter(
        ({ group, resolvesTo }) => !resolvesTo.includes(`./tests/${group}`),
      )

    expect(shadowed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A GROUP NOBODY RUNS IS A GROUP THAT PASSES BY DEFAULT.
//
// The runner discovers groups from the directories under tests/, and CI runs
// them from a hand-written matrix in .github/workflows/test.yml. Nothing
// compared the two, so adding a directory created a group whose tests NEVER
// RAN and whose absence appeared nowhere - the same silent-skip shape this
// repository has already found in a gate that could not locate its compiler
// and in a route audit that reported a clean bill of health.
//
// Both sides are READ. A list typed here would be a third copy of the same
// names and would go stale the same way.
// ---------------------------------------------------------------------------
describe('every test group has somewhere to run', () => {
  const workflow = readFileSync(
    resolve(import.meta.dir, '../../../../../.github/workflows/test.yml'),
    'utf8',
  )
  const packageJson = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../package.json'), 'utf8'),
  ) as { scripts: Record<string, string> }

  const suites = new Set(
    [...workflow.matchAll(/suite:\s*server-([a-z0-9-]+)/g)].map(
      (match) => match[1],
    ),
  )

  it('parsed suites out of the workflow at all', () => {
    // A regex that matches nothing would make every assertion below vacuous:
    // an empty set is a subset of everything.
    expect(suites.size).toBeGreaterThan(3)
  })

  it('runs every group the runner can discover', () => {
    const missing = listAllGroups().filter((group) => !suites.has(group))
    expect(
      missing,
      'test groups with no server-<group> entry in .github/workflows/test.yml - their tests never run in CI',
    ).toEqual([])
  })

  it('names no suite the runner cannot discover', () => {
    const groups = new Set(listAllGroups())
    const orphans = [...suites].filter((suite) => !groups.has(suite))
    expect(
      orphans,
      'server-<suite> entries in the workflow with no matching test group - CI is running a name that resolves to nothing',
    ).toEqual([])
  })

  it('gives every group a package script to run it', () => {
    const withoutScript = listAllGroups().filter(
      (group) => !packageJson.scripts[`test:${group}`],
    )
    expect(
      withoutScript,
      'groups with no test:<group> script - the workflow entry would fail at the shell',
    ).toEqual([])
  })
})
