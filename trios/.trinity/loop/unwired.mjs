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
/**
 * The gates the repository declares, rather than the ones a word list guesses.
 *
 * `make check` names its own suite in one line of prerequisites. That list is
 * authoritative in a way no heuristic can be, and reading it corrected this file
 * badly: of thirteen unwired gates it declares, ELEVEN were classified
 * `not-a-gate` here because they are named after their SUBJECT and not their
 * function - `t27-rings`, `type-floor`, `recipe-backticks`, `variant-fence`,
 * `vendor-step`, `skill-frontmatter`. `t27-rings` runs the 460-case parity
 * between the generated ring and the policy binary, and this file called it not
 * a gate.
 *
 * WHEN THE SYSTEM UNDER AUDIT DECLARES THE THING YOU ARE INFERRING, READ THE
 * DECLARATION. The word list stays as the fallback for targets outside the
 * suite, where nothing has declared anything.
 */
export function declaredGates(makefile) {
  const m = String(makefile || '').match(/^check:(.*)$/m)
  if (!m) return new Set()
  return new Set(m[1].split(/\s+/).filter(Boolean))
}

export function classify(name, recipe, declared = false) {
  const looksLikeGate = declared || GATE_WORDS.some((w) => name.toLowerCase().includes(w))
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

/**
 * A package script, sorted the way a make target is - but the categories differ
 * because the dialect does.
 *
 * MOST UNWIRED SCRIPTS ARE LEGITIMATELY UNWIRED, and this is the lesson that
 * shaped the classes. A first pass listed nineteen and eighteen of them were
 * fine: `test:all` and `test:core` are aggregates CI deliberately splits into
 * per-group jobs, `test:cdp` is an alias for a script that IS wired,
 * `test:cleanup` is a helper other scripts call, `lint:fix` mutates and must
 * never run in CI, `test:watch` is interactive. Reported flat, that list would
 * bury the one row worth reading.
 *
 * THE ONE IT CANNOT DECIDE, and says so: a script whose WORK is wired under a
 * different command. `lint` is `bunx biome check`, and CI runs `biome ci .` -
 * the linting happens, the script name never appears. That is the same shape as
 * `drift-guard`, whose script the macOS job already runs. Named in the output
 * rather than silently dropped, because guessing either way has been wrong.
 */
export function classifyScript(name, body) {
  const looksLikeGate = GATE_WORDS.some((w) => name.toLowerCase().includes(w))
  if (!looksLikeGate) return { name, kind: 'not-a-gate' }
  const text = String(body || '')
  if (/--write|--fix|--unsafe/.test(text)) return { name, kind: 'mutating', why: 'it rewrites files, so CI is the wrong place for it' }
  if (/--watch/.test(text)) return { name, kind: 'interactive', why: 'it watches, so it never exits' }
  if (/\brun-test-group|run-test-suite\b/.test(text) && /\b(all|core|main)\b/.test(text)) {
    return { name, kind: 'aggregate', why: 'it runs every group at once; CI splits them into jobs on purpose' }
  }
  const alias = text.match(/^\s*bun run ([\w:.-]+)\s*$/)
  if (alias) return { name, kind: 'alias', why: `it is just \`${alias[1]}\`` }
  return { name, kind: 'portable', why: 'nothing about it says CI is the wrong place' }
}

export function renderScripts(rows, total, wired) {
  const by = {}
  for (const r of rows) (by[r.kind] ||= []).push(r)
  const out = [`${total} gate-shaped package script(s), ${wired} invoked by a workflow`, '']
  const portable = by.portable || []
  out.push(`${portable.length} that nothing runs and nothing says should not run:`)
  for (const r of portable) out.push(`   ${r.pkg}  ${r.name}`)
  if (!portable.length) out.push('   (none)')
  for (const kind of ['aggregate', 'alias', 'mutating', 'interactive']) {
    const g = by[kind] || []
    if (!g.length) continue
    out.push(`  ${g.length} ${kind}: ${g.map((r) => r.name).join(' ')}`)
  }
  out.push('')
  out.push('A script whose WORK is wired under a different command still appears above:')
  out.push('`lint` is `biome check` and CI runs `biome ci .` - the linting happens and')
  out.push('the name never does. Read the row before acting on it.')
  out.push('')
  out.push('NOT AUDITED HERE: `test:*` scripts. The word is missing from the gate list')
  out.push('on purpose - including it buries the report in aggregates and aliases - and')
  out.push('that coverage already has a better guard: run-test-group.test.ts reads the')
  out.push('CI matrix and fails when a group has no job, in both directions.')
  return out.join('\n')
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
  const declared = declaredGates(makefile)
  const rows = []
  for (const [name] of targets) {
    if (wired.has(name)) continue
    rows.push(classify(name, reachedRecipes(name, targets), declared.has(name)))
  }
  const declaredUnwired = [...declared].filter((g) => !wired.has(g))
  console.log(`\`make check\` declares ${declared.size} gate(s); ${declared.size - declaredUnwired.length} of them run in a workflow.\n`)
  console.log(render(rows, targets.size, wired.size, process.argv.includes('--all')))

  // MAKE WAS ONLY ONE DIALECT. The same question asked of package scripts found
  // the t27.ai dashboard's 194-check review-lifecycle contract, which appeared
  // in no workflow at all - the string `apps/website` matched nothing.
  let manifests = []
  try {
    manifests = String(execFileSync('git', ['ls-tree', '-r', '--name-only', REF], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })).split('\n').filter((f) => f.endsWith('package.json') && !f.includes('node_modules'))
  } catch { manifests = [] }

  const scriptRows = []
  let scriptTotal = 0
  let scriptWired = 0
  for (const file of manifests) {
    let scripts = {}
    try { scripts = JSON.parse(show(file) || '{}').scripts || {} } catch { continue }
    const pkg = file.replace(/^trios\/(agent-server\/)?/, '').replace(/\/package\.json$/, '') || 'root'
    for (const [name, body] of Object.entries(scripts)) {
      const row = classifyScript(name, body)
      if (row.kind === 'not-a-gate') continue
      scriptTotal++
      const called = new RegExp(`\\b(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?${name.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')}(?:\\s|$|\\))`, 'm')
      if (called.test(workflows)) { scriptWired++; continue }
      scriptRows.push({ ...row, pkg })
    }
  }
  if (scriptTotal) {
    console.log('')
    console.log(renderScripts(scriptRows, scriptTotal, scriptWired))
  }

  const portable = rows.filter((r) => r.kind === 'portable').length
  const scriptPortable = scriptRows.filter((r) => r.kind === 'portable').length
  console.log(`\n${portable} portable make gate(s) and ${scriptPortable} package script(s) that nothing runs`)
  process.exit(portable + scriptPortable ? 2 : 0)
}
