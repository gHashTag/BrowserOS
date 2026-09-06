#!/usr/bin/env node
// A gate that exists and runs nowhere.
//
// WHAT THIS FOUND. `make queen-core-sync` compares the eleven policy files that
// exist twice - `rings/SR-00` for the app, `agent-server/queen-core` for the
// Linux container - byte for byte. Its comment states the stakes exactly: "a
// policy that differs between them is two arbiters of the same rule."
//
// It appeared in no workflow. On 2026-09-06, twelve of thirteen files were
// identical and one was not: the ring gained a string-aware literal view on
// 2026-09-05 and the copy that ships to Linux was last touched on 2026-08-29.
// The fix never crossed, and it was not a comment - the copy is missing the
// whole escape-and-quote branch.
//
// The gate was written, was correct, and had never been asked. Writing a check
// is the easy half; the half that decides whether it protects anything is
// whether something runs it without being reminded.
//
// WHY A LIST OF UNWIRED TARGETS IS NOT ENOUGH. Sixty-eight targets, eleven
// invoked by a workflow. Most of the rest SHOULD be local: `make` builds an
// app, `run` launches it, `relaunch` needs a window server. A report that
// listed all fifty-seven would be ignored by the second week, correctly.
//
// So this asks two questions rather than one:
//
//   1. Does the target LOOK like a gate? A name carrying check, gate, guard,
//      audit, verify, drift, sync, parity or seal is a promise to refuse
//      something. Naming is weak evidence, which is why it is not the only
//      question.
//   2. COULD it run on a CI runner at all? A recipe that shells out to
//      xcodebuild, swiftc, `open`, or the app bundle needs a Mac with a window
//      server. One that runs cmp, grep, node or bun needs nothing. The second
//      group is the actionable one, and it is where `queen-core-sync` sat.
//
// It reports the first group and RANKS the second, rather than accusing
// everything with a suggestive name.
//
// Usage:
//   node unwired.mjs              # gates nobody runs, portable ones first
//   node unwired.mjs --all        # every unwired target, including local-only

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/unwired.mjs')

/** A name that promises to refuse something. */
export const GATE_WORDS = [
  'check', 'gate', 'guard', 'audit', 'verify', 'drift', 'sync', 'parity',
  'seal', 'prove', 'honest', 'selftest', 'lint',
]

/** Tools that need a desktop, a window server or Apple's toolchain. */
export const MAC_ONLY = [
  'xcodebuild', 'xcrun', 'swiftc', 'swift build', 'osascript', 'open ',
  'codesign', 'security ', 'defaults ', '.app', 'DEVELOPER_DIR',
]

/**
 * Every target in a Makefile, with the recipe lines that belong to it.
 *
 * Parsed rather than asked of `make`, because `make -qp` runs the file and this
 * has to work against a checkout it is not standing in - the shipping ref, most
 * often, which is where the answer that matters lives.
 */
export function targetsOf(makefile) {
  const out = new Map()
  let current = null
  for (const raw of String(makefile || '').split('\n')) {
    const header = raw.match(/^([a-zA-Z][a-zA-Z0-9._-]*)\s*:(?!=)(.*)$/)
    if (header) {
      current = header[1]
      if (!out.has(current)) out.set(current, { recipe: [], needs: [] })
      // The prerequisites matter as much as the recipe: `check:` and `verify:`
      // have NO recipe at all - they are a list of other targets - and reading
      // only the recipe called both of them portable while their prerequisites
      // build an app and open a window. Found by checking the tool's own output
      // against two entries in it, before it shipped.
      for (const dep of header[2].trim().split(/\s+/).filter(Boolean)) {
        if (/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(dep)) out.get(current).needs.push(dep)
      }
      continue
    }
    if (current && (raw.startsWith('\t') || raw.startsWith('    '))) {
      out.get(current).recipe.push(raw)
      continue
    }
    if (raw.trim() === '') continue
    if (!raw.startsWith('\t')) current = null
  }
  return out
}

/**
 * Every recipe line a target reaches, through its prerequisites.
 *
 * Depth-limited and cycle-guarded rather than trusting the graph: a Makefile
 * with a loop in it would otherwise hang the audit, and an audit that hangs is
 * one somebody removes from the chain.
 */
export function reachedRecipes(name, targets, seen = new Set()) {
  if (seen.has(name) || seen.size > 200) return []
  seen.add(name)
  const node = targets.get(name)
  if (!node) return []
  let lines = [...node.recipe]
  // A RECIPE THAT CALLS `make` REACHES THAT TARGET TOO, and missing this was the
  // second defect of the same family as the first. `check-bypass` is one line -
  // `$(MAKE) check` - so following only prerequisites saw an empty recipe and
  // called it portable, while `check` builds an app and opens a window. Its own
  // echo says "never for CI", which is how it was caught: the tool disagreed
  // with the target's own description of itself.
  const submakes = new Set()
  for (const line of node.recipe) {
    for (const m of line.matchAll(/\$\((?:MAKE|make)\)[^\n]*?\s([a-zA-Z][a-zA-Z0-9._-]*)/g)) submakes.add(m[1])
    for (const m of line.matchAll(/\bmake\s+(?:--\S+\s+)*([a-zA-Z][a-zA-Z0-9._-]*)/g)) submakes.add(m[1])
  }
  for (const dep of [...node.needs, ...submakes]) {
    lines = lines.concat(reachedRecipes(dep, targets, seen))
  }
  return lines
}

/** Targets a workflow invokes, however the line is spelled. */
export function wiredIn(workflowText) {
  const wired = new Set()
  for (const m of String(workflowText || '').matchAll(/\bmake\s+([a-zA-Z][a-zA-Z0-9._-]*)/g)) {
    wired.add(m[1])
  }
  return wired
}

/**
 * Sort one unwired target.
 *
 * `portable` is the finding. `mac-only` is an explanation, not an excuse - it
 * says why nobody wired it, and a reader may still decide the gate deserves a
 * macOS job. `not-a-gate` is everything else and is not reported by default.
 */
export function classify(name, recipe) {
  const looksLikeGate = GATE_WORDS.some((w) => name.toLowerCase().includes(w))
  if (!looksLikeGate) return { name, kind: 'not-a-gate' }
  const body = (recipe || []).join('\n')
  const needsMac = MAC_ONLY.filter((t) => body.includes(t))
  if (needsMac.length) return { name, kind: 'mac-only', why: `it reaches ${needsMac.slice(0, 3).join(', ')}` }
  // A RECIPE THAT SHELLS OUT TO A SCRIPT IS OPAQUE FROM HERE, and saying so is
  // the difference between a heuristic and a claim. `drift-guard` is a single
  // line - `bash tests/swift/run_chat_sse_e2e.sh` with an env var set - and it
  // called the Swift compiler inside that script for four minutes before a
  // 240-second run gave up on it. This scan sees one layer; a script is the
  // second, and guessing about it is how the first two misclassifications
  // happened. Third of the same family: prerequisites, then $(MAKE), now this.
  const scripts = [...body.matchAll(/([\w./$()-]*\.sh)\b/g)].map((m) => m[1])
  if (scripts.length) {
    return { name, kind: 'opaque', why: `it runs ${scripts[0].split('/').pop()}, and this cannot see inside a script` }
  }
  return { name, kind: 'portable', why: 'nothing it reaches needs a desktop, so a runner could do this' }
}

export function render(rows, targetCount, wiredCount, showAll = false) {
  const by = { portable: [], 'mac-only': [], opaque: [], 'not-a-gate': [] }
  for (const r of rows) by[r.kind].push(r)
  const out = [
    `${targetCount} make target(s), ${wiredCount} invoked by a workflow`,
    '',
  ]
  out.push(`${by.portable.length} gate(s) that nothing runs and a CI runner COULD run:`)
  for (const r of by.portable) out.push(`   ${r.name}`)
  if (!by.portable.length) out.push('   (none - every portable gate is wired)')
  out.push('')
  out.push(`${by['mac-only'].length} more look like gates but need a desktop:`)
  for (const r of by['mac-only']) out.push(`   ${r.name}  -  ${r.why}`)
  if (by.opaque.length) {
    out.push('')
    out.push(`${by.opaque.length} cannot be judged from here - they run a script:`)
    for (const r of by.opaque) out.push(`   ${r.name}  -  ${r.why}`)
  }
  if (showAll && by['not-a-gate'].length) {
    out.push('')
    out.push(`${by['not-a-gate'].length} unwired target(s) whose names promise nothing:`)
    out.push(`   ${by['not-a-gate'].map((r) => r.name).join(' ')}`)
  }
  out.push('')
  out.push('A NAME IS WEAK EVIDENCE and this leans on it, so read the list rather')
  out.push('than counting it. What it cannot tell you is whether a gate is worth')
  out.push('running - only that nothing is running it. `queen-core-sync` sat in the')
  out.push('portable group while the copy it guards had already drifted.')
  return out.join('\n')
}

if (isMain) {
  const { execFileSync } = await import('node:child_process')
  const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
  const REF = process.env.TRIOS_SHIP_REF || 'origin/feat/queen-supervisor'

  // READ THE SHIPPING REF, not this checkout. The local tree is hundreds of
  // commits behind what runs, and a gate wired upstream would read as unwired
  // here - an accusation produced entirely by standing in the wrong place.
  const show = (p) => {
    try {
      return String(execFileSync('git', ['show', `${REF}:${p}`], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      }))
    } catch { return null }
  }

  const makefile = show('trios/Makefile')
  if (!makefile) {
    console.log(`the Makefile could not be read at ${REF} - NOTHING was examined.`)
    process.exit(3)
  }

  let workflows = ''
  try {
    const names = String(execFileSync('git', ['ls-tree', '--name-only', `${REF}`, '.github/workflows/'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })).split('\n').filter(Boolean)
    for (const n of names) workflows += `${show(n) ?? ''}\n`
  } catch { workflows = '' }
  if (!workflows.trim()) {
    console.log(`no workflow could be read at ${REF} - every target would look unwired, so NOTHING is reported.`)
    process.exit(3)
  }

  const targets = targetsOf(makefile)
  const wired = wiredIn(workflows)
  const rows = []
  for (const [name] of targets) {
    if (wired.has(name)) continue
    rows.push(classify(name, reachedRecipes(name, targets)))
  }
  console.log(render(rows, targets.size, wired.size, process.argv.includes('--all')))
  const portable = rows.filter((r) => r.kind === 'portable').length
  console.log(`\n${portable} portable gate(s) that nothing runs`)
  process.exit(portable ? 2 : 0)
}
