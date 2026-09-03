#!/usr/bin/env node
/**
 * Error-flag gate for the filesystem tools (gHashTag/trios#1367).
 *
 * Every filesystem tool in
 * agent-server/apps/server/src/tools/filesystem-registry.ts wraps a
 * FilesystemToolResult from ./filesystem/utils.ts, where every rejection
 * becomes { text, isError: true }. A handler that sends that result with a
 * bare response.text(...) strips the flag, and a failed call reaches the
 * model as a success whose text happens to be an error message.
 *
 * This file is two things at once:
 *
 *   1. A static gate, run with plain Node and no installed dependencies:
 *
 *        node trios/tools/fs-tool-error-flag-gate.mjs
 *
 *      It reads the registry source, finds every exported tool definition,
 *      and requires each handler to keep the isError indication. The tool
 *      list is derived from the source, so a thirteenth tool is covered
 *      without editing this gate.
 *
 *   2. A functional test file, run through the real registry and the real
 *      executeTool:
 *
 *        bun test trios/tools/fs-tool-error-flag-gate.mjs
 *
 *      The tests pin both halves of the fix: a failing call must come back
 *      as an error response, and a succeeding call must return exactly the
 *      text the handlers produced before the fix.
 *
 * The two modes share one file: bun:test's test() throws "Cannot use test
 * outside of the test runner" when the file is run as a script, which is
 * how the script path is detected. Plain node (no Bun global) never tries
 * to import bun:test at all.
 */

import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const REGISTRY_PATH = join(
  HERE,
  '..',
  'agent-server',
  'apps',
  'server',
  'src',
  'tools',
  'filesystem-registry.ts',
)
const FRAMEWORK_PATH = join(dirname(REGISTRY_PATH), 'framework.ts')
const HELPER_ID = 'respondFilesystemResult'

/* ------------------------------------------------------------------ *
 * Static analysis of the registry source
 * ------------------------------------------------------------------ */

/**
 * Skips a string literal starting at `start` (src[start] is the opening
 * quote) and returns the index just past the closing quote. Braces inside
 * string literals must not confuse the brace matcher.
 */
function skipStringLiteral(src, start) {
  const quote = src[start]
  let i = start + 1
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2
      continue
    }
    if (src[i] === quote) return i + 1
    i++
  }
  throw new Error('unterminated string literal in registry source')
}

/**
 * Given the index of an opening '{', returns the index of its matching '}',
 * ignoring braces inside strings and comments.
 */
function matchBrace(src, open) {
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipStringLiteral(src, i)
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) throw new Error('unterminated comment in registry source')
      i = end + 2
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  throw new Error('unbalanced braces in registry source')
}

/**
 * Extracts every `export const <id> = defineFilesystemTool({ ... })` block
 * from the registry source, returning the tool name and the handler source
 * for each. New tools added to the registry appear here automatically.
 */
function extractToolDefinitions(source) {
  const definitions = []
  const header =
    /export\s+const\s+(\w+)\s*=\s*defineFilesystemTool\s*\(\s*\{/g
  let match
  while ((match = header.exec(source)) !== null) {
    const openBrace = match.index + match[0].length - 1
    const closeBrace = matchBrace(source, openBrace)
    header.lastIndex = closeBrace
    const configBody = source.slice(openBrace + 1, closeBrace)

    const nameMatch = configBody.match(/^\s*name:\s*['"]([^'"]+)['"]/m)
    if (!nameMatch) {
      throw new Error(
        `tool definition "${match[1]}" has no name property; cannot gate it`,
      )
    }

    const handlerMatch = configBody.match(
      /handler:\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/,
    )
    let handlerBody = null
    if (handlerMatch) {
      const handlerOpen = configBody.indexOf('{', handlerMatch.index)
      const handlerClose = matchBrace(configBody, handlerOpen)
      handlerBody = configBody.slice(handlerOpen + 1, handlerClose)
    }
    definitions.push({ constName: match[1], name: nameMatch[1], handlerBody })
  }
  return definitions
}

/**
 * The gate itself. Returns { total, helperMode, failures } where failures
 * lists the tools whose handlers lose the isError flag.
 *
 * Two regimes, one rule each:
 *
 * - With the shared helper defined in the registry (the fixed state), every
 *   handler must route its result through respondFilesystemResult(...). A
 *   tool added later that builds its response by hand fails the gate.
 *
 * - Without the helper (the registry as this issue found it), a handler
 *   passes only if it keeps the flag itself: it must test result.isError
 *   and send failures through response.error(...). This is what makes the
 *   pre-fix run name the eight broken tools instead of all twelve.
 */
function runStaticGate() {
  const source = readFileSync(REGISTRY_PATH, 'utf8')
  const helperMode =
    new RegExp(`(?:function|const)\\s+${HELPER_ID}\\b`).test(source)

  const definitions = extractToolDefinitions(source)
  if (definitions.length === 0) {
    throw new Error(
      `no defineFilesystemTool definitions found in ${relative(REPO_ROOT, REGISTRY_PATH)}`,
    )
  }

  const failures = []
  for (const definition of definitions) {
    const handler = definition.handlerBody
    if (handler === null) {
      failures.push({
        name: definition.name,
        reason: 'no handler found in the tool definition',
      })
      continue
    }
    if (helperMode) {
      if (!new RegExp(`${HELPER_ID}\\s*\\(`).test(handler)) {
        failures.push({
          name: definition.name,
          reason: `handler does not route its result through ${HELPER_ID}(...), so a failed call reaches the model as success`,
        })
      }
    } else if (!/result\.isError/.test(handler) || !/response\.error\s*\(/.test(handler)) {
      failures.push({
        name: definition.name,
        reason:
          'handler sends the result without testing result.isError and without response.error(...), so a failed call reaches the model as success',
      })
    }
  }
  return { total: definitions.length, helperMode, failures }
}

function helperModeLine(helperMode) {
  return helperMode
    ? `helper: ${HELPER_ID} is defined; every handler must call it`
    : `helper: ${HELPER_ID} is not defined; handlers must keep result.isError themselves`
}

/* ------------------------------------------------------------------ *
 * Functional tests over the real registry (bun test only)
 * ------------------------------------------------------------------ */

/**
 * Loads the real registry and framework and returns a runner that executes
 * a registered tool through executeTool with a scratch working directory,
 * exactly like the proof in the issue.
 */
async function makeHarness() {
  const registry = await import(pathToFileURL(REGISTRY_PATH).href)
  const { executeTool } = await import(pathToFileURL(FRAMEWORK_PATH).href)
  const scratch = mkdtempSync(join(tmpdir(), 'fs-tool-error-flag-gate-'))
  const ctx = { browser: {}, directories: { workingDir: scratch } }
  const signal = new AbortController().signal
  const run = async (name, args) => {
    const result = await executeTool(registry[name], args, ctx, signal)
    return {
      isError: result.isError === true,
      text: result.content
        .map((item) => (item.type === 'text' ? item.text : `<${item.type}>`))
        .join('\n'),
    }
  }
  return { scratch, run }
}

function cleanup(scratch) {
  rmSync(scratch, { recursive: true, force: true })
}

/**
 * Registers the functional tests. Expected strings were captured from the
 * registry as it stood before the fix, so the "same text as today"
 * assertions pin the success path byte for byte (FR-002).
 */
function registerFunctionalTests(test, expect) {
  // The eight tools that dropped the flag: reads and lists silently became
  // evidence. filesystem_read and fs_list stand in for that group.
  test('dropped-flag group / filesystem_read: a failed read is an error response', async () => {
    const { scratch, run } = await makeHarness()
    try {
      const result = await run('filesystem_read', {
        path: 'definitely-missing.txt',
      })
      expect(result.isError).toBe(true)
      expect(result.text).toBe(
        `ENOENT: no such file or directory, open '${join(scratch, 'definitely-missing.txt')}'`,
      )
    } finally {
      cleanup(scratch)
    }
  })

  test('dropped-flag group / filesystem_read: a successful read returns the same text as before the fix', async () => {
    const { scratch, run } = await makeHarness()
    try {
      writeFileSync(join(scratch, 'sample.txt'), 'alpha\nbeta\ngamma')
      const result = await run('filesystem_read', { path: 'sample.txt' })
      expect(result.isError).toBe(false)
      expect(result.text).toBe('1 | alpha\n2 | beta\n3 | gamma')
    } finally {
      cleanup(scratch)
    }
  })

  test('dropped-flag group / fs_list: a failed list is an error response', async () => {
    const { scratch, run } = await makeHarness()
    try {
      const result = await run('fs_list', { path: 'no-such-dir' })
      expect(result.isError).toBe(true)
      expect(result.text).toBe(
        `ENOENT: no such file or directory, scandir '${join(scratch, 'no-such-dir')}'`,
      )
    } finally {
      cleanup(scratch)
    }
  })

  test('dropped-flag group / fs_list: a successful list returns the same text as before the fix', async () => {
    const { scratch, run } = await makeHarness()
    try {
      mkdirSync(join(scratch, 'sub'))
      writeFileSync(join(scratch, 'sub', 'inner.txt'), 'inner\n')
      writeFileSync(join(scratch, 'sample.txt'), 'alpha\nbeta\ngamma')
      const result = await run('fs_list', {})
      expect(result.isError).toBe(false)
      expect(result.text).toBe('sub/\nsample.txt (16B)')
    } finally {
      cleanup(scratch)
    }
  })

  // The four tools that already kept the flag: their observable behaviour
  // must not change when they move to the shared helper. fs_edit and
  // filesystem_bash stand in for that group.
  test('already-correct group / fs_edit: a failed edit is an error response', async () => {
    const { scratch, run } = await makeHarness()
    try {
      const result = await run('fs_edit', {
        path: 'definitely-missing.txt',
        old_string: 'x',
        new_string: 'y',
      })
      expect(result.isError).toBe(true)
      expect(result.text).toBe(
        `ENOENT: no such file or directory, open '${join(scratch, 'definitely-missing.txt')}'`,
      )
    } finally {
      cleanup(scratch)
    }
  })

  test('already-correct group / fs_edit: a successful edit returns the same text as before the fix', async () => {
    const { scratch, run } = await makeHarness()
    try {
      writeFileSync(join(scratch, 'sample.txt'), 'alpha\nbeta\ngamma')
      const result = await run('fs_edit', {
        path: 'sample.txt',
        old_string: 'beta',
        new_string: 'BETA',
      })
      expect(result.isError).toBe(false)
      expect(result.text).toBe('Applied edit to sample.txt\n\n- beta\n+ BETA')
    } finally {
      cleanup(scratch)
    }
  })

  test('already-correct group / filesystem_bash: a failed command is an error response', async () => {
    const { scratch, run } = await makeHarness()
    try {
      const result = await run('filesystem_bash', { command: 'exit 3' })
      expect(result.isError).toBe(true)
      expect(result.text).toBe('\n\n[Exit code: 3]')
    } finally {
      cleanup(scratch)
    }
  })

  test('already-correct group / filesystem_bash: a successful command returns the same text as before the fix', async () => {
    const { scratch, run } = await makeHarness()
    try {
      const result = await run('filesystem_bash', {
        command: 'echo hello-from-gate',
      })
      expect(result.isError).toBe(false)
      expect(result.text).toBe('hello-from-gate\n')
    } finally {
      cleanup(scratch)
    }
  })
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

let gate
try {
  gate = runStaticGate()
} catch (err) {
  console.error(`filesystem tool error-flag gate: ${err && err.message}`)
  process.exitCode = 2
}

if (gate) {
  if (typeof Bun === 'undefined') {
    // Plain Node: static gate only, no installed dependencies.
    scriptReport(gate)
  } else {
    // Under Bun we may be a script (node wrapper / bun run) or a test file
    // (bun test). Registering the first test tells them apart: test()
    // throws outside the test runner.
    let bunTest = null
    try {
      const bt = await import('bun:test')
      bt.test(
        'static gate: every registered filesystem tool keeps the isError flag',
        () => {
          console.log(
            `static gate checked ${gate.total} exported filesystem tools (helper mode: ${gate.helperMode})`,
          )
          if (gate.failures.length > 0) {
            throw new Error(
              `${gate.failures.length} of ${gate.total} filesystem tools lose the isError flag: ` +
                gate.failures.map((f) => `${f.name} (${f.reason})`).join('; '),
            )
          }
        },
      )
      bunTest = bt
    } catch (err) {
      if (!/outside of the test runner/.test(String(err && err.message))) {
        throw err
      }
    }
    if (bunTest) {
      registerFunctionalTests(bunTest.test, bunTest.expect)
    } else {
      scriptReport(gate)
    }
  }
}

function scriptReport(gate) {
  console.log('filesystem tool error-flag gate (gHashTag/trios#1367)')
  console.log(`registry: ${relative(REPO_ROOT, REGISTRY_PATH)}`)
  console.log(helperModeLine(gate.helperMode))
  console.log(`checked ${gate.total} exported filesystem tools`)
  if (gate.failures.length === 0) {
    console.log(
      `gate passed: all ${gate.total} filesystem tools keep the isError flag`,
    )
    return
  }
  for (const failure of gate.failures) {
    console.log(`FAIL ${failure.name}: ${failure.reason}`)
  }
  console.log(
    `gate failed: ${gate.failures.length} of ${gate.total} filesystem tools lose the isError flag`,
  )
  process.exitCode = 1
}
