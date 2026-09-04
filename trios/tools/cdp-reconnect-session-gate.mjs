#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 BrowserOS
 *
 * Gate for gHashTag/trios#1368.
 *
 * The CDP backend reconnects its WebSocket on its own. A new socket means
 * Chrome issues new session ids, and every id cached by the previous
 * connection is dead. If the backend does not announce the reconnect, the
 * browser layer keeps using those dead ids and every page tool fails with
 * "Session with given id not found." for the life of the process.
 *
 * This gate keeps the reconnect notification contract intact:
 *   - `onReconnected` MUST be declared on the backend interface
 *     (backends/types.ts) so a second backend cannot omit it silently
 *     (FR-001), and
 *   - `onReconnected` MUST be consumed by the browser layer (browser.ts)
 *     so the per-connection caches are actually cleared.
 *
 * It fails if the notification is declared in one place and not consumed in
 * the other. It reads the two files as text — no build, no bun, no packages:
 * plain node with the Node standard library only (FR-005).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NOTIFICATION = 'onReconnected'

const toolsDir = dirname(fileURLToPath(import.meta.url))
const browserPath = resolve(
  toolsDir,
  '../agent-server/apps/server/src/browser/browser.ts',
)
const typesPath = resolve(
  toolsDir,
  '../agent-server/apps/server/src/browser/backends/types.ts',
)

/** Strip // line comments and /* block *​/ comments so a commented-out
 * declaration or call does not count as present. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function readStripComments(path, label) {
  try {
    return stripComments(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(
      `cdp-reconnect-session-gate: cannot read ${label} at ${path}: ${error.message}`,
    )
    process.exit(1)
  }
}

const browserSource = readStripComments(browserPath, 'browser.ts')
const typesSource = readStripComments(typesPath, 'backends/types.ts')

// Declared: the notification appears as a member of the backend interface.
const declaredInTypes = new RegExp(`\\b${NOTIFICATION}\\s*\\(`).test(typesSource)
// Consumed: the browser layer actually subscribes via a method call.
const consumedInBrowser = new RegExp(
  `\\.\\s*${NOTIFICATION}\\s*\\(`,
).test(browserSource)

const failures = []
if (declaredInTypes && !consumedInBrowser) {
  failures.push(
    `${NOTIFICATION} is declared on the backend interface (backends/types.ts) ` +
      `but browser.ts never subscribes to it. The browser layer would keep ` +
      `caching session ids from a dead connection forever (trios#1368). ` +
      `Consume it in Browser and clear the per-connection caches.`,
  )
}
if (consumedInBrowser && !declaredInTypes) {
  failures.push(
    `browser.ts calls ${NOTIFICATION}() but the backend interface ` +
      `(backends/types.ts) does not declare it. A second backend could omit ` +
      `the notification silently and reintroduce trios#1368 (FR-001).`,
  )
}
if (!declaredInTypes && !consumedInBrowser) {
  failures.push(
    `${NOTIFICATION} is missing from both backends/types.ts and browser.ts. ` +
      `FR-001 requires the backend to expose a reconnect notification and ` +
      `requires it to be part of the backend interface (trios#1368).`,
  )
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`cdp-reconnect-session-gate: FAIL — ${failure}`)
  }
  process.exit(1)
}

console.log(
  `cdp-reconnect-session-gate: PASS — ${NOTIFICATION} is declared on the ` +
    `backend interface (backends/types.ts) and consumed by browser.ts`,
)
