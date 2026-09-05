#!/usr/bin/env node
// One file, two paths, and nothing comparing them.
//
// WHY THIS EXISTS, AND WHAT IT CAUGHT ON ITS FIRST RUN. `rings/SR-00` and
// `agent-server/queen-core/Sources` both hold a copy of seventeen Swift files.
// The self-audit has carried this as finding D1 for weeks in the form "a
// byte-identical fork of 16 SR-00 files, one diverged", which reads like a
// tidying job.
//
// Measured 2026-09-06, and it is not a tidying job. At HEAD all seventeen are
// byte-identical - including `QueenLocalisation.swift`, the one the audit calls
// diverged. The 45-line difference is entirely in the WORKING TREE: somebody is
// editing `rings/SR-00/QueenLocalisation.swift` right now and the fork has not
// been touched. Nothing anywhere would have said so.
//
// That is the exact moment L0 is written about - "a rule transcribed into four
// languages is four rules that agree until someone edits one" - caught while it
// is happening rather than afterwards. So the two states are reported
// differently and this is the whole point of the tool:
//
//   LANDED    the copies differ at HEAD. A fork that is already in history;
//             every build since has been compiling two different rules.
//   IN FLIGHT the copies differ only in the working tree. Not a defect yet -
//             it is an edit somebody has not mirrored, and saying so before it
//             lands is worth more than finding it afterwards.
//
// IT NEVER EDITS ANYTHING. The divergence it found belongs to another agent's
// uncommitted work; mirroring it automatically would be taking a decision that
// is not this loop's to take, on a file it does not own. It reports and stops.
//
// Usage:
//   node forked-files.mjs           # every shared filename, and whether it agrees
//   node forked-files.mjs --landed  # only what has already been committed twice

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/forked-files.mjs')

const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const LEFT = 'trios/rings/SR-00'
const RIGHT = 'trios/agent-server/queen-core/Sources'

const sh = (c) => { try { return execSync(c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }) } catch { return null } }

/**
 * Every filename that exists on both sides.
 *
 * By BASENAME, because the two trees do not share a layout: SR-00 is flat and
 * queen-core is split into QueenCore/QueenPolicy/queend. A path-based match
 * would find nothing and report a clean bill of health, which is the failure
 * mode this whole directory keeps running into.
 */
export function sharedNames(leftFiles, rightFiles) {
  const right = new Map()
  for (const f of rightFiles) {
    const b = path.basename(f)
    // A name that appears twice on the right is itself worth knowing, so the
    // first is kept and the rest recorded rather than silently overwritten.
    if (!right.has(b)) right.set(b, [f])
    else right.get(b).push(f)
  }
  const out = []
  for (const f of leftFiles) {
    const b = path.basename(f)
    if (right.has(b)) out.push({ name: b, left: f, rights: right.get(b) })
  }
  return out
}

/**
 * Classify one shared file.
 *
 * `atHead` is asked of git and `now` of the filesystem, and the pair is what
 * separates a landed fork from an edit in flight. Reading only the working tree
 * would call somebody's unfinished thought a defect; reading only HEAD would
 * miss it until it shipped.
 */
export function classify(pair, deps = {}) {
  const show = deps.show || ((p) => sh(`git show HEAD:${JSON.stringify(p)}`))
  const read = deps.read || ((p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8') } catch { return null } })
  const right = pair.rights[0]
  const lh = show(pair.left)
  const rh = show(right)
  const ln = read(pair.left)
  const rn = read(right)

  // UNREADABLE IS NOT IDENTICAL. A file git cannot show (added and never
  // committed, or deleted) has no HEAD state to compare, and calling that
  // agreement is how a checker reports health for work it never looked at.
  const headKnown = lh !== null && rh !== null
  const nowKnown = ln !== null && rn !== null
  const headSame = headKnown ? lh === rh : null
  const nowSame = nowKnown ? ln === rn : null

  let state = 'identical'
  if (headSame === false) state = 'LANDED'
  else if (headSame === true && nowSame === false) state = 'in flight'
  else if (headSame === null || nowSame === null) state = 'unknown'

  return { ...pair, right, state, headSame, nowSame, extraRights: pair.rights.length - 1 }
}

export function render(rows) {
  const by = { LANDED: [], 'in flight': [], unknown: [], identical: [] }
  for (const r of rows) by[r.state].push(r)
  const out = [
    `${rows.length} file(s) exist in both ${LEFT} and ${RIGHT}`,
    `  ${by.identical.length} identical, ${by.LANDED.length} forked in history, ${by['in flight'].length} edited on one side only, ${by.unknown.length} unreadable`,
  ]
  for (const r of by.LANDED) {
    out.push(`  !! ${r.name} differs AT HEAD - two copies of this have been compiling since it landed`)
    out.push(`     ${r.left}`)
    out.push(`     ${r.right}`)
  }
  for (const r of by['in flight']) {
    out.push(`  ~  ${r.name} is identical at HEAD and differs in the working tree`)
    out.push(`     somebody is editing one copy and has not mirrored the other; it is not a defect until it lands`)
    out.push(`     ${r.left}`)
    out.push(`     ${r.right}`)
  }
  for (const r of by.unknown) out.push(`  ?  ${r.name} could not be read on both sides at HEAD - NOT compared`)
  const dupes = rows.filter((r) => r.extraRights > 0)
  for (const d of dupes) out.push(`  ?  ${d.name} appears ${d.extraRights + 1} times on the right; only the first was compared`)
  return out.join('\n')
}

if (isMain) {
  const list = (dir) => (sh(`git ls-files ${JSON.stringify(dir)}`) || '').split('\n').filter((f) => f.endsWith('.swift'))
  const left = list(LEFT)
  const right = list(RIGHT)
  if (!left.length || !right.length) {
    console.log(`one side is empty - ${LEFT}: ${left.length} file(s), ${RIGHT}: ${right.length} file(s).`)
    console.log('Nothing was compared. An empty side is not agreement.')
    process.exit(3)
  }
  const rows = sharedNames(left, right).map((p) => classify(p))
  console.log(render(rows))

  const landed = rows.filter((r) => r.state === 'LANDED')
  const flight = rows.filter((r) => r.state === 'in flight')
  if (!landed.length && !flight.length) {
    console.log('\nEvery shared file agrees, at HEAD and on disk. That is a measurement of today,')
    console.log('not a property: the law exists because two copies are the state from which')
    console.log('divergence starts, and this is what makes the next one loud.')
  }
  if (process.argv.includes('--landed')) process.exit(landed.length ? 2 : 0)
  // The last line is the verdict, because the chain quotes it as the summary.
  console.log(`\n${rows.length} shared, ${landed.length} forked in history, ${flight.length} edited on one side only`)
  process.exit(landed.length ? 2 : 0)
}
