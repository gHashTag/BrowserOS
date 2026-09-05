#!/usr/bin/env node
// What the LIVE service serves to an origin it has never heard of.
//
// WHY A LIVE PROBE AND NOT A SOURCE AUDIT. There is already a good source
// audit - `tools/route-guard-audit.mjs` reads `server.ts` and reports every
// mount that carries no guard - and on 2026-09-06 it was correct, red, and
// being merged across. `/queen/needs-you` had been mounted with a comment
// saying it "sits behind the trusted-origin catch-all" and nothing behind it at
// all; production answered 200 to a request carrying a hostile `Origin`,
// returning outstanding escalations with issue numbers, ages and the
// worker-written reason text.
//
// A source audit says what the code declares. This says what the deployment
// does. They are different questions and the gap between them is where the
// defect lived: the deployed image is built from a branch that can be days
// behind, so a guard added in source is not a guard in production until a
// deploy happens - and a guard REMOVED in source is a hole immediately.
//
// WHAT IT WILL NOT DO. It never prints a response body. The thing being
// measured is exposure, and a tool that dumps the payload to prove a leak has
// published it a second time. Status codes and path names only. It sends no
// credential, no cookie and no token: the whole question is what an ANONYMOUS
// stranger gets, so anything that authenticates would answer a different one.
//
// THE PUBLIC LIST IS READ, NOT TYPED. Which paths are meant to be public comes
// out of `server.ts` at the shipping ref - the `publicReadCorsMiddleware()`
// calls and the audit's own reasoned allowlist. A hand-kept list here would be
// one more copy of exactly the thing this project keeps finding.
//
// Usage:
//   node exposure.mjs            # probe every declared /queen route
//   node exposure.mjs --json     # the same, as data

import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/exposure.mjs')

const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REF = process.env.TRIOS_SHIP_REF || 'origin/feat/queen-supervisor'
const SERVER = 'trios/agent-server/apps/server/src/api/server.ts'
// The reasoned allowlist lives in the source audit and is READ from it. Its
// first run without this produced FIVE false accusations - /queen/dashboard,
// /queen/feed, /queen/kanban, /queen/roadmap and /queen/tree are deliberate
// public shells, each with a written reason, and a probe that does not know
// that reports the design as a breach. A tool whose first output is five false
// positives is the defect this whole directory hunts, and it was in the
// instrument built to hunt it.
const AUDIT = 'trios/tools/route-guard-audit.mjs'
const BASE = process.env.TRIOS_PUBLIC_BASE || 'https://trios-agent-server-production.up.railway.app'
// An origin the service has never issued and never will. Not a real domain:
// `.invalid` is reserved by RFC 2606 precisely so nobody can register it.
const HOSTILE = 'https://example.invalid'

const sh = (c) => { try { return execSync(c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }) } catch { return null } }

/**
 * Every `/queen/...` path the server mounts, and which of them it declares public.
 *
 * Parsed from the shipping ref rather than from the working tree: this compares
 * a DEPLOYED service against what the branch says, and a local edit describes
 * neither.
 */
export function declaredRoutes(source, auditSource = '') {
  const mounts = [...String(source || '').matchAll(/\.route\('(\/queen\/[^']*)'/g)].map((m) => m[1])
  const publicRead = [...String(source || '').matchAll(/\.use\('(\/queen\/[^']*)',\s*publicReadCorsMiddleware\(\)\)/g)].map((m) => m[1])
  // Every allowlist entry carries a `reason`. An entry without one is not
  // treated as permission: the audit itself reports those separately, and a
  // path allowed for no stated reason is exactly what nobody should inherit.
  const allowed = [...String(auditSource || '').matchAll(/path:\s*'(\/[^']*)',\s*\n\s*reason:/g)].map((m) => m[1])
  return {
    mounts: [...new Set(mounts)].sort(),
    publicRead: new Set([...publicRead, ...allowed]),
    declaredPublic: new Set(publicRead),
    allowlisted: new Set(allowed),
  }
}

/**
 * Which answers are an exposure, and which are the service working as declared.
 *
 * A 200 to a stranger is only a finding when the path was NOT declared public.
 * Anything that is not a 200 is not an exposure whatever its code: a 401, a 403,
 * a 404 and a 500 all fail to hand the stranger the payload, and reporting them
 * as different kinds of safe would invite somebody to start treating one of
 * them as a finding.
 */
export function classify(results, publicRead) {
  const exposed = []
  const asDeclared = []
  const unreachable = []
  for (const r of results) {
    if (r.code === null) { unreachable.push(r); continue }
    if (r.code === 200 && !publicRead.has(r.path)) exposed.push(r)
    else asDeclared.push(r)
  }
  return { exposed, asDeclared, unreachable }
}

export function probe(p, run) {
  const url = `${BASE}${p}`
  const out = run
    ? run(url)
    : sh(`curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H ${JSON.stringify(`Origin: ${HOSTILE}`)} ${JSON.stringify(url)}`)
  const code = Number(String(out || '').trim())
  return { path: p, code: Number.isFinite(code) && code > 0 ? code : null }
}

export function render(r, total) {
  const out = [
    `${total} declared /queen route(s) probed at ${BASE}`,
    `  with Origin: ${HOSTILE} - a domain reserved by RFC 2606 so it can never be issued`,
    `  ${r.exposed.length} answered 200 without being declared public, ${r.asDeclared.length} behaved as declared, ${r.unreachable.length} unreachable`,
  ]
  for (const e of r.exposed) out.push(`  !! ${e.path} answered 200 to a stranger and is not on the public-read list`)
  for (const u of r.unreachable) out.push(`  ?  ${u.path} could not be reached - NOT a pass`)
  if (!r.exposed.length && !r.unreachable.length) {
    out.push('', 'Nothing the branch calls private answered a stranger. That is a statement about')
    out.push('the DEPLOYED image, which is built from a branch that can be days behind - so it')
    out.push('is worth re-asking after every deploy rather than after every merge.')
  }
  return out.join('\n')
}

if (isMain) {
  const source = sh(`git show ${REF}:${SERVER}`)
  if (!source) {
    console.log(`could not read ${SERVER} at ${REF} - nothing was probed.`)
    console.log('A route list that could not be read is not an empty route list.')
    process.exit(3)
  }
  const auditSource = sh(`git show ${REF}:${AUDIT}`)
  if (!auditSource) {
    console.log(`could not read ${AUDIT} at ${REF} - the reasoned allowlist is unknown, so nothing was probed.`)
    console.log('Probing without it turns five deliberate public shells into five accusations.')
    process.exit(3)
  }
  const { mounts, publicRead, allowlisted } = declaredRoutes(source, auditSource)
  if (!mounts.length) {
    console.log('no /queen route was parsed out of the server source - the parser has drifted, not the routes')
    process.exit(3)
  }
  const results = mounts.map((p) => probe(p))
  const r = classify(results, publicRead)
  console.log(render(r, mounts.length))
  console.log(`  (${allowlisted.size} path(s) are public by a written reason in the audit's allowlist, not by CORS)`)
  if (process.argv.includes('--json')) console.log(JSON.stringify({ base: BASE, ref: REF, ...r }, null, 1))
  console.log(`\n${mounts.length} probed, ${r.exposed.length} exposed, ${r.unreachable.length} unreachable`)
  process.exit(r.exposed.length ? 2 : r.unreachable.length ? 3 : 0)
}
