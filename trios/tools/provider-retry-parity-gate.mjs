#!/usr/bin/env node
/**
 * provider-retry-parity-gate.mjs
 *
 * Guards the single-source-of-truth rule for provider-error retryability:
 * both gateway fetch wrappers (`browseros-fetch.ts` and `openrouter-fetch.ts`)
 * must route terminal-error detection through the shared
 * `isTerminalProviderError` classifier, and the BrowserOS
 * `CREDITS_EXHAUSTED` code must not be re-inlined anywhere.
 *
 * One line is printed per check ("PASS <name>" / "FAIL <name>: <reason>").
 * The gate exits non-zero when any check fails; a missing file is a FAIL.
 *
 * Uses only the Node standard library. The repository root is resolved from
 * this file's own location (import.meta.url), so the gate behaves the same
 * from any working directory.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The gate lives at <repo-root>/trios/tools/; step up twice to reach the root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const FILES = {
  classifier: 'trios/agent-server/apps/server/src/lib/provider-error-classifier.ts',
  browserosFetch: 'trios/agent-server/apps/server/src/lib/browseros-fetch.ts',
  openrouterFetch: 'trios/agent-server/apps/server/src/lib/openrouter-fetch.ts',
}

/** Maps a file key to its contents, or to a failure reason when unreadable. */
function loadFiles() {
  const loaded = new Map()
  for (const [key, relativePath] of Object.entries(FILES)) {
    try {
      loaded.set(key, readFileSync(join(REPO_ROOT, relativePath), 'utf8'))
    } catch (error) {
      loaded.set(key, `cannot read ${relativePath}: ${error.message}`)
    }
  }
  return loaded
}

/** Counts quoted occurrences of a value, single- or double-quoted. */
function countQuoted(text, value) {
  const single = (text.match(new RegExp(`'${value}'`, 'g')) ?? []).length
  const double = (text.match(new RegExp(`"${value}"`, 'g')) ?? []).length
  return single + double
}

/** True when `identifier` is used inside the named function's body. */
function usedInsideFunction(text, identifier, functionName) {
  const fn = text.indexOf(`function ${functionName}`)
  return fn !== -1 && text.indexOf(identifier, fn) !== -1
}

const IMPORT_CLASSIFIER_RE =
  /import\s*\{[^}]*isTerminalProviderError[^}]*\}\s*from\s*['"]\.\/provider-error-classifier['"]/
const CALL_CLASSIFIER_RE = /isTerminalProviderError\s*\(/

/**
 * Each check names the file it reads and returns null on PASS or a failure
 * reason string on FAIL.
 */
const CHECKS = [
  {
    name: 'classifier-exports-browseros-code',
    file: 'classifier',
    verify: (text) => {
      if (
        !/export\s+const\s+BROWSEROS_CREDITS_EXHAUSTED_CODE\s*=\s*['"]CREDITS_EXHAUSTED['"]/.test(
          text,
        )
      ) {
        return 'provider-error-classifier.ts must export BROWSEROS_CREDITS_EXHAUSTED_CODE = "CREDITS_EXHAUSTED"'
      }
      if (countQuoted(text, 'CREDITS_EXHAUSTED') !== 1) {
        return 'the quoted CREDITS_EXHAUSTED literal must appear exactly once (the constant definition), not duplicated in the function body'
      }
      return null
    },
  },
  {
    name: 'classifier-uses-browseros-code-in-function',
    file: 'classifier',
    verify: (text) =>
      usedInsideFunction(text, 'BROWSEROS_CREDITS_EXHAUSTED_CODE', 'isTerminalProviderError')
        ? null
        : 'isTerminalProviderError must reference BROWSEROS_CREDITS_EXHAUSTED_CODE inside its body',
  },
  {
    name: 'classifier-keeps-zai-code',
    file: 'classifier',
    verify: (text) => {
      if (!/export\s+const\s+ZAI_INSUFFICIENT_BALANCE_CODE\s*=/.test(text)) {
        return 'provider-error-classifier.ts must keep exporting ZAI_INSUFFICIENT_BALANCE_CODE'
      }
      if (!usedInsideFunction(text, 'ZAI_INSUFFICIENT_BALANCE_CODE', 'isTerminalProviderError')) {
        return 'isTerminalProviderError must keep referencing ZAI_INSUFFICIENT_BALANCE_CODE'
      }
      return null
    },
  },
  {
    name: 'browseros-fetch-imports-classifier',
    file: 'browserosFetch',
    verify: (text) =>
      IMPORT_CLASSIFIER_RE.test(text)
        ? null
        : "browseros-fetch.ts must import isTerminalProviderError from './provider-error-classifier'",
  },
  {
    name: 'browseros-fetch-uses-classifier',
    file: 'browserosFetch',
    verify: (text) =>
      CALL_CLASSIFIER_RE.test(text)
        ? null
        : 'browseros-fetch.ts must call isTerminalProviderError(...) to decide isRetryable',
  },
  {
    name: 'browseros-fetch-no-inline-credits-literal',
    file: 'browserosFetch',
    verify: (text) =>
      countQuoted(text, 'CREDITS_EXHAUSTED') === 0
        ? null
        : "browseros-fetch.ts must not contain a quoted 'CREDITS_EXHAUSTED' literal of its own (unquoted header mentions are fine)",
  },
  {
    name: 'openrouter-fetch-imports-classifier',
    file: 'openrouterFetch',
    verify: (text) =>
      IMPORT_CLASSIFIER_RE.test(text)
        ? null
        : "openrouter-fetch.ts must import isTerminalProviderError from './provider-error-classifier'",
  },
  {
    name: 'openrouter-fetch-uses-classifier',
    file: 'openrouterFetch',
    verify: (text) =>
      CALL_CLASSIFIER_RE.test(text)
        ? null
        : 'openrouter-fetch.ts must call isTerminalProviderError(...) to decide isRetryable',
  },
]

const files = loadFiles()
let failures = 0
for (const check of CHECKS) {
  const entry = files.get(check.file)
  // `entry` is either the file text, or a "cannot read ..." failure string.
  const failure =
    typeof entry === 'string' && entry.startsWith('cannot read ')
      ? entry
      : check.verify(entry)
  if (failure == null) {
    console.log(`PASS ${check.name}`)
  } else {
    failures += 1
    console.log(`FAIL ${check.name}: ${failure}`)
  }
}

if (failures > 0) {
  console.log(`provider-retry-parity-gate: ${failures} of ${CHECKS.length} checks failed`)
  process.exit(1)
}
console.log(`provider-retry-parity-gate: all ${CHECKS.length} checks passed`)
