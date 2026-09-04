#!/usr/bin/env node
/**
 * Stray test audit.
 *
 * `apps/server/tests/__helpers__/run-test-group.ts` only enumerates `tests/`:
 * the directory groups under it and the root files inside it. Any `*.test.ts`
 * that lives beside its subject under `apps/server/src/` is therefore executed
 * by no test group at all - and a guard that CI does not run is a guard that
 * will be true only until the day it is not. This script lists every such
 * stray so the whole class stays visible instead of re-accumulating one quiet
 * file at a time. Each listed file is a suite that `bun run test` never runs.
 *
 * Usage: node tools/stray-test-audit.mjs
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverSrcPath = join('agent-server', 'apps', 'server', 'src')
const testFilePattern = /\.test\.tsx?$/

function walkTestFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...walkTestFiles(path))
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      found.push(path)
    }
  }
  return found
}

/**
 * Every `*.test.ts` under `root` - i.e. every test file the runner cannot
 * reach. Sorted so the output is stable from run to run.
 */
export function strayTests(root) {
  return walkTestFiles(root).sort()
}

/**
 * Locate `agent-server/apps/server/src` by walking up from `startDir`, so the
 * audit works from any cwd and is not hard-coded to a checkout layout.
 */
function findServerSrc(startDir) {
  let dir = resolve(startDir)
  for (;;) {
    const srcRoot = join(dir, serverSrcPath)
    if (existsSync(srcRoot)) {
      return { repoRoot: dir, srcRoot }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(
        `could not locate ${serverSrcPath} in or above ${startDir}`,
      )
    }
    dir = parent
  }
}

function main() {
  const { repoRoot, srcRoot } = findServerSrc(
    dirname(fileURLToPath(import.meta.url)),
  )
  const strays = strayTests(srcRoot)

  if (strays.length === 0) {
    console.log(`No stray test files under ${relative(repoRoot, srcRoot)}/.`)
    return
  }

  for (const file of strays) {
    console.log(relative(repoRoot, file))
  }
  console.log(
    `Total: ${strays.length} stray test file(s) under ${relative(repoRoot, srcRoot)}/` +
      ` - none of them is run by any test group.`,
  )
}

main()
