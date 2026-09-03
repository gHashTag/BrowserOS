/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { readdirSync } from 'node:fs'
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
