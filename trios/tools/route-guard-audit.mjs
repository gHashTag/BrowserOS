#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Route-guard audit — gHashTag/trios#1382.
 *
 * A static gate over trios/agent-server/apps/server/src/api/server.ts. The
 * rule it enforces: every top-level route mount in the REAL server is
 * either guarded by requireTrustedAppOrigin() (through a preceding
 * `.use('<prefix>/*', ...)` or a guarded sub-app wrapper), exposed through a
 * `publicReadCorsMiddleware()` public-read projection, or named on an
 * allowlist entry that carries a reason. server.ts states in its own comment
 * why this gate exists: twice a route shipped without the guard its
 * neighbours all carry, and one of them answered 200 to the open internet.
 *
 * What this is, and what it is not:
 *   - It is a text classifier. It proves a guard is DECLARED for every
 *     mount, in source order. It cannot prove Hono's matcher applies the
 *     guard at runtime and it cannot reach a deployed server; the
 *     behavioural middleware test lives in tests/api/routes/auth-routes.test.ts.
 *   - It READS src/api/server.ts and never writes it (FR-007).
 *   - The classifier functions are exported and imported by
 *     tests/api/routes/route-guard.test.ts, so the rule exists in exactly
 *     one place (FR-009) and the test builds no replica application.
 *
 * Usage:
 *   node trios/tools/route-guard-audit.mjs
 *       Full audit with the shipped allowlist. Exits 0 only when every
 *       mount is guarded, public-read, or allowlisted with a reason, and
 *       every allowlist entry names a mounted path.
 *   node trios/tools/route-guard-audit.mjs --no-allowlist
 *       Raw unguarded list; the allowlist is ignored. Exits 1 if anything
 *       is unguarded.
 *   node trios/tools/route-guard-audit.mjs --self-test
 *       Runs two inline failure fixtures (a mount with no guard, and a
 *       prefix guard declared after the route it should cover) plus an
 *       ordering control. Proves the gate can go red without touching
 *       server.ts.
 *   node trios/tools/route-guard-audit.mjs --allowlist-entry '<path>::<reason>'
 *       Adds one allowlist entry (repeatable). An entry whose path is not
 *       mounted fails the run as stale; an entry without '::reason' fails
 *       the run for missing its reason string (FR-006).
 *
 * The script resolves server.ts relative to its own location (FR-010), so it
 * behaves identically from the repository root and from trios/.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SERVER_TS_URL = new URL(
  '../agent-server/apps/server/src/api/server.ts',
  import.meta.url,
)
export const SERVER_TS_LABEL = 'trios/agent-server/apps/server/src/api/server.ts'

/**
 * Floor on the parsed mount count (FR-001). A regex that silently matches
 * nothing would report a perfectly clean tree; below this count the run
 * fails instead of certifying a table it cannot see.
 */
export const MIN_MOUNTS = 30

/**
 * The only mounts allowed to carry no guard, each with the reason the
 * comments beside the mount in server.ts already give. A seventh entry is
 * a defect: add a guard instead.
 */
export const DEFAULT_ALLOWLIST = [
  {
    path: '/health',
    reason:
      'liveness probe — it must answer before any auth handshake could exist; see src/api/routes/health',
  },
  {
    path: '/queen/dashboard',
    reason:
      'shell only — holds no state and no token; every byte of data it shows comes from /queen/lease, which stays guarded (comment at the mount)',
  },
  {
    path: '/queen/tree',
    reason:
      'shell only — renders a generated file already in the repository, so there is nothing here a reader could not get from git (comment at the mount)',
  },
  {
    path: '/queen/kanban',
    reason:
      'shell only — the board page carries none of the board data; the data sits behind the same bearer check as the lease (queenBoardRoutes)',
  },
  {
    path: '/queen/roadmap',
    reason:
      'shell only — roadmap data is served by /queen/roadmap/data, mounted through the guarded queenRoadmapDataRoutes wrapper',
  },
  {
    path: '/queen/feed',
    reason:
      'shell only — feed data is served by /queen/feed/data, mounted through the guarded queenFeedDataRoutes wrapper',
  },
]

export function readServerSource() {
  return readFileSync(fileURLToPath(SERVER_TS_URL), 'utf8')
}

/**
 * Replace comment characters with spaces, preserving the length and therefore
 * every position in the file. String literals (single, double, template) are
 * tracked so comment markers inside them survive; comment bodies are skipped
 * opaquely so quotes or backticks inside comments cannot open a string.
 */
function stripComments(source) {
  const out = source.split('')
  const n = source.length
  let i = 0
  while (i < n) {
    const ch = source[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < n) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < n) {
        if (source[i] === '*' && source[i + 1] === '/') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          break
        }
        if (source[i] !== '\n') out[i] = ' '
        i += 1
      }
      continue
    }
    i += 1
  }
  return out.join('')
}

/** Every match of a global regex, in order, with start and end offsets. */
function* iterate(re, text) {
  re.lastIndex = 0
  let match
  while ((match = re.exec(text)) !== null) {
    yield {
      match: match[0],
      index: match.index,
      end: match.index + match[0].length,
      captures: match.slice(1),
    }
  }
}

// A `.route('<path>', <value>)` call. Applies to the app builder chain, to
// the standalone `app.route('/terminal', ...)` statement after it (FR-002),
// and to sub-app internals (which use path '/').
const ROUTE_CALL_RE = /\.route\(\s*'([^']*)'\s*,\s*/g
// A top-level prefix guard: `.use('<prefix>/*', requireTrustedAppOrigin())`.
// The '+' before '/*' keeps sub-app guards (`.use('/*', ...)`, empty prefix)
// out of this set.
const PREFIX_GUARD_RE = /\.use\(\s*'([^']+)\/\*'\s*,\s*requireTrustedAppOrigin\(\)\s*\)/g
// A public-read CORS projection: `.use('<path>', publicReadCorsMiddleware())`.
const PUBLIC_READ_RE = /\.use\(\s*'([^']*)'\s*,\s*publicReadCorsMiddleware\(\)\s*\)/g
// A sub-app wrapper guard: `.use('/*', requireTrustedAppOrigin())`.
const WRAPPER_GUARD_RE = /\.use\(\s*'\/\*'\s*,\s*requireTrustedAppOrigin\(\)\s*\)/g
// A named wrapper declaration: `const <name> = new Hono<...>(...)`.
const WRAPPER_DECL_RE = /const\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Hono\b/g
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*/

/**
 * Parse the route table out of server.ts text. Returns the top-level mounts
 * (a `.route()` with a path other than '/' — sub-app internals mount at '/'
 * and are excluded per FR-003), the top-level prefix guards, the public-read
 * projections, and the guarded sub-app wrappers (named constants whose
 * declaration carries `.use('/*', requireTrustedAppOrigin())` before its
 * first internal route, plus sub-apps declared inline at the mount).
 */
export function parseRouteTable(source) {
  const text = stripComments(source)

  const routeCalls = [...iterate(ROUTE_CALL_RE, text)]
  const prefixGuards = [...iterate(PREFIX_GUARD_RE, text)].map((m) => ({
    prefix: m.captures[0],
    position: m.index,
  }))
  const publicReadUses = [...iterate(PUBLIC_READ_RE, text)].map((m) => ({
    path: m.captures[0],
    position: m.index,
  }))
  const wrapperGuardPositions = [...iterate(WRAPPER_GUARD_RE, text)].map(
    (m) => m.index,
  )

  const firstRouteAfter = (position) =>
    routeCalls.find((call) => call.index > position)
  const firstWrapperGuardAfter = (position) =>
    wrapperGuardPositions.find((guard) => guard > position)

  // Named wrappers: the guard must sit inside the declaration, before the
  // wrapper's first internal route, or it never wraps anything.
  const guardedWrappers = []
  for (const decl of iterate(WRAPPER_DECL_RE, text)) {
    const name = decl.captures[0]
    const guard = firstWrapperGuardAfter(decl.index)
    const firstRoute = firstRouteAfter(decl.index)
    if (
      guard !== undefined &&
      firstRoute !== undefined &&
      guard < firstRoute.index
    ) {
      guardedWrappers.push({
        name,
        declarationPosition: decl.index,
        guardPosition: guard,
      })
    }
  }
  const guardedWrapperNames = new Set(guardedWrappers.map((w) => w.name))

  const mounts = []
  let inlineGuardedCount = 0
  for (const call of routeCalls) {
    const path = call.captures[0]
    // FR-003: a sub-app's internal `.route('/', ...)` is not a top-level mount.
    if (path === '/') continue

    const head = text.slice(call.end, call.end + 160)
    let wrapperName = null
    let inlineGuarded = false
    if (/^new\s/.test(head)) {
      // Sub-app declared inline at the mount. Guarded only if its own
      // `.use('/*', requireTrustedAppOrigin())` precedes its first route.
      const guard = firstWrapperGuardAfter(call.end)
      const firstRoute = firstRouteAfter(call.end)
      inlineGuarded =
        guard !== undefined &&
        firstRoute !== undefined &&
        guard < firstRoute.index
      if (inlineGuarded) inlineGuardedCount += 1
    } else {
      const identifier = IDENTIFIER_RE.exec(head)
      if (identifier && guardedWrapperNames.has(identifier[0])) {
        wrapperName = identifier[0]
      }
    }
    mounts.push({ path, position: call.index, wrapperName, inlineGuarded })
  }

  return {
    mounts,
    prefixGuards,
    publicReadUses,
    guardedWrappers,
    guardedSubAppCount: guardedWrappers.length + inlineGuardedCount,
  }
}

/**
 * Classify every top-level mount (FR-005). A mount is guarded only by:
 *   public-read — a `publicReadCorsMiddleware()` registration for that exact
 *                 path, declared before the mount;
 *   prefix-guard — a preceding `.use('<prefix>/*', requireTrustedAppOrigin())`
 *                 covering the path (FR-004: preceding, compared by position
 *                 in the file — middleware registered after a route does not
 *                 run for it);
 *   wrapper — a named wrapper constant whose declaration carries
 *                 `.use('/*', requireTrustedAppOrigin())`, or a sub-app
 *                 declared inline at the mount with the same call;
 *   unguarded — anything else, subject to the reasoned allowlist.
 */
export function classifyMounts(source) {
  const table = parseRouteTable(source)
  return table.mounts.map((mount) => {
    const publicRead = table.publicReadUses.find(
      (use) => use.path === mount.path && use.position < mount.position,
    )
    if (publicRead) {
      return {
        ...mount,
        classification: 'public-read',
        via: 'publicReadCorsMiddleware()',
      }
    }
    const prefixGuard = table.prefixGuards.find(
      (guard) =>
        (mount.path === guard.prefix ||
          mount.path.startsWith(`${guard.prefix}/`)) &&
        guard.position < mount.position,
    )
    if (prefixGuard) {
      return {
        ...mount,
        classification: 'prefix-guard',
        via: `.use('${prefixGuard.prefix}/*', requireTrustedAppOrigin())`,
      }
    }
    if (mount.wrapperName) {
      return { ...mount, classification: 'wrapper', via: mount.wrapperName }
    }
    if (mount.inlineGuarded) {
      return { ...mount, classification: 'wrapper', via: 'inline sub-app' }
    }
    return { ...mount, classification: 'unguarded', via: null }
  })
}

/**
 * The exported rule (criterion 9): source text plus an allowlist in, the
 * array of unguarded mount paths out. Paths on the allowlist are excluded;
 * pass an empty allowlist to see every unguarded mount.
 */
export function unguardedMounts(source, allowlist = []) {
  const allowed = new Set(
    allowlist.map((entry) => (entry && entry.path) || entry),
  )
  const unguarded = classifyMounts(source).filter(
    (mount) => mount.classification === 'unguarded' && !allowed.has(mount.path),
  )
  return unguarded.map((mount) => mount.path)
}

/**
 * Full audit: classification counts, unguarded paths after the allowlist,
 * and the two ways an allowlist can rot (FR-006): an entry naming a path
 * server.ts no longer mounts, or an entry without a reason string.
 */
export function auditServer(source, allowlist = DEFAULT_ALLOWLIST) {
  const table = parseRouteTable(source)
  const classifications = classifyMounts(source)
  const mountedPaths = new Set(table.mounts.map((mount) => mount.path))
  const staleAllowlistEntries = allowlist
    .filter((entry) => !mountedPaths.has(entry?.path))
    .map((entry) => entry.path)
  const entriesMissingReason = allowlist
    .filter(
      (entry) =>
        typeof entry?.reason !== 'string' || entry.reason.trim() === '',
    )
    .map((entry) => entry.path)
  return {
    totalMounts: table.mounts.length,
    prefixGuardCount: table.prefixGuards.length,
    guardedSubAppCount: table.guardedSubAppCount,
    publicReadCount: table.publicReadUses.length,
    classifications,
    unguarded: unguardedMounts(source, allowlist),
    staleAllowlistEntries,
    entriesMissingReason,
  }
}

const SELF_TEST_FIXTURES = [
  {
    name: 'mount with no guard',
    source: [
      'const app = new Hono<Env>()',
      "  .use('/fine/*', requireTrustedAppOrigin())",
      "  .route('/fine', createFineRoutes())",
      "  .route('/leaky', createLeakyRoutes())",
      '',
    ].join('\n'),
    expected: ['/leaky'],
  },
  {
    name: 'prefix guard declared after the route',
    source: [
      'const app = new Hono<Env>()',
      "  .route('/admin', createAdminRoutes())",
      "  .use('/admin/*', requireTrustedAppOrigin())",
      '',
    ].join('\n'),
    expected: ['/admin'],
  },
  {
    name: 'control: the same guard declared before the route',
    source: [
      'const app = new Hono<Env>()',
      "  .use('/admin/*', requireTrustedAppOrigin())",
      "  .route('/admin', createAdminRoutes())",
      '',
    ].join('\n'),
    expected: [],
  },
]

function runSelfTest() {
  console.log(
    'route-guard-audit self-test: the gate can go red without touching server.ts',
  )
  let ok = true
  for (const fixture of SELF_TEST_FIXTURES) {
    const found = unguardedMounts(fixture.source, [])
    const pass = JSON.stringify(found) === JSON.stringify(fixture.expected)
    if (!pass) ok = false
    const reported = found.length > 0 ? found.join(', ') : '(none)'
    const outcome = !pass
      ? 'MISSED — the classifier is broken'
      : fixture.expected.length > 0
        ? 'detected'
        : 'correctly certified'
    console.log(`  ${fixture.name}: unguarded: ${reported} — ${outcome}`)
  }
  if (!ok) {
    console.error('self-test FAILED')
    return 1
  }
  console.log(
    'self-test passed: both failure fixtures are reported as unguarded',
  )
  return 0
}

function classificationLabel(mount, allowlistByPath) {
  switch (mount.classification) {
    case 'public-read':
      return `public-read (${mount.via})`
    case 'prefix-guard':
      return `prefix-guard ${mount.via}`
    case 'wrapper':
      return `wrapper-guarded (${mount.via})`
    default: {
      const entry = allowlistByPath.get(mount.path)
      if (entry && entry.reason) return `allowlisted: ${entry.reason}`
      if (entry) return 'allowlisted WITHOUT REASON (fails the run)'
      return 'UNGUARDED'
    }
  }
}

function parseAllowlistEntries(args) {
  const entries = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--allowlist-entry') continue
    const raw = args[i + 1]
    if (!raw || raw.startsWith('--')) {
      throw new Error(
        "--allowlist-entry needs a value of the form '<path>::<reason>'",
      )
    }
    const separator = raw.indexOf('::')
    if (separator === -1) {
      entries.push({ path: raw, reason: '' })
    } else {
      entries.push({
        path: raw.slice(0, separator),
        reason: raw.slice(separator + 2),
      })
    }
  }
  return entries
}

function runAudit(args) {
  const noAllowlist = args.includes('--no-allowlist')
  let extraEntries = []
  try {
    extraEntries = parseAllowlistEntries(args)
  } catch (err) {
    console.error(`route-guard-audit: ${err.message}`)
    return 2
  }

  let source
  try {
    source = readServerSource()
  } catch (err) {
    console.error(
      `route-guard-audit: cannot read ${SERVER_TS_LABEL}: ${err.message}`,
    )
    return 1
  }

  const table = parseRouteTable(source)
  if (table.mounts.length < MIN_MOUNTS) {
    console.error(
      `route-guard-audit: parsed only ${table.mounts.length} top-level mounts in server.ts ` +
        `(floor is ${MIN_MOUNTS}). A parser that silently matches nothing would ` +
        'report a perfectly clean tree, so this run fails instead.',
    )
    return 1
  }

  const allowlist = noAllowlist
    ? []
    : [...DEFAULT_ALLOWLIST, ...extraEntries]
  const report = auditServer(source, allowlist)

  console.log(`route-guard-audit: ${SERVER_TS_LABEL}`)
  console.log(`top-level mounts: ${report.totalMounts}`)
  console.log(`prefix guards: ${report.prefixGuardCount}`)
  console.log(`guarded sub-apps: ${report.guardedSubAppCount}`)
  console.log(`public-read mounts: ${report.publicReadCount}`)

  if (noAllowlist) {
    console.log(`unguardedMounts: ${report.unguarded.length}`)
    for (const path of report.unguarded) {
      console.log(`  ${path}`)
    }
    if (report.unguarded.length > 0) {
      console.log(
        'no allowlist was applied — each path above must be guarded or allowlisted with a reason',
      )
      return 1
    }
    return 0
  }

  console.log('mount classifications:')
  const allowlistByPath = new Map(allowlist.map((entry) => [entry.path, entry]))
  for (const mount of report.classifications) {
    console.log(`  ${mount.path.padEnd(24)} ${classificationLabel(mount, allowlistByPath)}`)
  }

  console.log(`unguardedMounts: ${report.unguarded.length}`)
  for (const path of report.unguarded) {
    console.log(`  ${path}`)
  }

  let failed = report.unguarded.length > 0
  if (report.staleAllowlistEntries.length > 0) {
    failed = true
    console.log(
      'stale allowlist entries (named path is not mounted in server.ts):',
    )
    for (const path of report.staleAllowlistEntries) {
      console.log(`  ${path}`)
    }
  }
  if (report.entriesMissingReason.length > 0) {
    failed = true
    console.log('allowlist entries without a reason string:')
    for (const path of report.entriesMissingReason) {
      console.log(`  ${path}`)
    }
  }
  if (failed) return 1

  console.log(
    'OK: every top-level mount is guarded, public-read, or allowlisted with a reason',
  )
  return 0
}

function usage() {
  console.log(`usage: node trios/tools/route-guard-audit.mjs [--no-allowlist]
                                          [--self-test]
                                          [--allowlist-entry '<path>::<reason>']`)
}

function main(argv) {
  const args = argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    usage()
    return 0
  }
  if (args.includes('--self-test')) return runSelfTest()
  return runAudit(args)
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  process.exit(main(process.argv))
}
