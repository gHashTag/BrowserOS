#!/usr/bin/env node
// What is left of a branch the base has moved past.
//
// WHY THIS IS NOT A REBASE, AND WILL NEVER RUN ONE.
//
// `land` can already say a branch conflicts and how far the base has travelled
// on the files it touches. The next question is the one a person has to answer:
// rebase it, or re-do the work? Rebasing #1302 would have deleted #1308's landed
// code and reintroduced a non-ASCII ellipsis into a redaction the base already
// performs in ASCII. The advice was one line long and would have destroyed
// finished work.
//
// And a clean rebase would not have proved otherwise. A SEMANTIC CONFLICT
// carries no markers: git resolves the text correctly while the combined code is
// logically broken - upstream renames a function your commit still calls, the
// changes are on different lines, nothing conflicts, everything is wrong. So
// "it applied cleanly" is not evidence, and this tool does not offer it.
//
// WHAT IT PRODUCES INSTEAD is a SPECIFICATION OF INTENT: the names this branch
// introduces that the repository still does not have. That is the standard
// advice for a branch whose module has been restructured underneath it - use the
// old diff as a statement of what was wanted, not as a patch - and it is
// language-independent, because ABSENCE is checkable without knowing how Swift
// or TypeScript spells "define".
//
// It is also exactly the shape a brief needs: a name that appears nowhere in the
// tree today is a criterion `verdict-audit` can run, and the fork-point check
// makes it a fail-to-pass one by construction.
//
// Usage:
//   node salvage.mjs <branch or issue number> [...]
//   node salvage.mjs --conflicting        # every branch land reports as stuck

import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/salvage.mjs')
const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const BASE = process.env.TRIOS_BASE || 'feat/queen-supervisor'

const sh = (cmd) => {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim()
  } catch { return null }
}

// Words that are not a contribution. A keyword, a type name from the standard
// library, or a token every file already contains says nothing about what this
// branch was for - and proposing one as "the name the repository lacks" is the
// `node_modules` accusation in a new costume.
export const NOISE = new Set([
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'from', 'type',
  'interface', 'class', 'enum', 'async', 'await', 'this', 'null', 'undefined',
  'true', 'false', 'string', 'number', 'boolean', 'object', 'void', 'never',
  'public', 'private', 'static', 'readonly', 'extends', 'implements', 'struct',
  'guard', 'throws', 'where', 'case', 'switch', 'default', 'break', 'continue',
  'catch', 'throw', 'finally', 'yield', 'typeof', 'instanceof', 'delete',
  'describe', 'expect', 'test', 'beforeEach', 'afterEach', 'console', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Error', 'Math',
  'JSON', 'Date', 'Map', 'Set', 'RegExp', 'Symbol', 'BigInt', 'globalThis',
])

/**
 * Candidate names introduced by the added lines of a diff.
 *
 * Deliberately NOT a parse. Six false accusations came from a checker that tried
 * to recognise a declaration by its shape across Swift, TypeScript and markdown;
 * the list of ways to spell "define" has no end. Every identifier-looking token
 * is a candidate, and the base tree decides which of them are actually new.
 */
export function candidates(addedLines) {
  const seen = new Map()
  for (const line of addedLines) {
    // Skip the diff's own leading '+', and anything inside a string or comment
    // is fine to include - a name that only appears in a comment will be
    // filtered out by the base-tree check if the base has it, and reported with
    // its count if it does not.
    for (const m of line.slice(1).matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) {
      const id = m[0]
      if (NOISE.has(id)) continue
      // A hex blob is a fixture, not a name. queen-1303's diff yielded `fedcba`
      // and `fedcba9876` - fragments of a fake commit sha in a test - and
      // proposing them as capabilities the repository lacks would be exactly
      // the `node_modules` accusation wearing a new costume.
      if (/^[0-9a-fA-F]{6,}$/.test(id)) continue
      seen.set(id, (seen.get(id) || 0) + 1)
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, n }))
}

/** Is this name anywhere in the tree at this ref? */
export function inTree(ref, id, run = sh) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return false
  return Boolean(run(`git grep -l -w -e ${id} ${ref} -- . | head -1`))
}

/**
 * What this branch would still add, expressed as names the base does not have.
 *
 * `cap` exists because a large branch yields hundreds of candidates and each one
 * costs a `git grep`. The cap is on the CANDIDATES, ordered by how often the
 * branch mentions them, and the number examined is printed - a silent truncation
 * would read as "this is everything", which it would not be.
 */
export function surviving(branch, opts = {}) {
  const { cap = 80, run = sh } = opts
  const fork = run(`git merge-base origin/${BASE} origin/${branch}`)
  if (!fork) return null
  const files = (run(`git diff --name-only ${fork}..origin/${branch}`) || '').split('\n').filter(Boolean)
  const added = (run(`git diff ${fork}..origin/${branch} -- . | grep '^+' | grep -v '^+++'`) || '').split('\n').filter(Boolean)
  const all = candidates(added)
  const examined = all.slice(0, cap)
  const missing = examined.filter((c) => !inTree(`origin/${BASE}`, c.id, run))
  return {
    branch,
    fork,
    files,
    addedLines: added.length,
    candidates: all.length,
    examined: examined.length,
    missing,
  }
}


/**
 * The measurement, written as a brief a bee can pass.
 *
 * Every criterion here is fail-to-pass BY CONSTRUCTION: the name was measured
 * absent from the base a moment ago, so the check cannot be satisfied by an
 * empty patch and `verdict-audit` will run it against both the fork point and
 * the branch without being asked.
 *
 * The old branch is cited as the specification of intent and NOT as a patch to
 * apply, which is the whole finding of the round that produced this: rebasing
 * one of these would have deleted landed work and reintroduced a law violation,
 * and a clean rebase would not have shown it, because a semantic conflict
 * carries no markers.
 */
export function brief(s, issue) {
  const names = s.missing.map((m) => m.id)
  const shown = names.slice(0, 10)
  return `## Why

\`origin/${s.branch}\` carries accepted work that never reached the base. Its issue
is closed and its code is not in the branch, which is a false statement about the
repository in the direction nobody checks for.

It cannot simply be rebased. The base has moved on the files it touches, and on a
sibling branch of the same vintage a replay would have deleted work that landed
since and reintroduced a non-ASCII character into a file governed by L3. A clean
rebase would not have revealed either: a semantic conflict carries no conflict
markers.

So the old branch is a SPECIFICATION OF INTENT here, not a patch. What follows was
measured, not read: of ${s.candidates} identifier-shaped tokens in its ${s.addedLines}
added lines, these ${names.length} appear nowhere in the base today.

## What done looks like

The capability those names stand for exists on today's base, with tests, written
as if for the first time. Reproducing the old file byte for byte is not the goal
and is very likely wrong.

## What a bee can do here

Read \`git diff $(git merge-base origin/${process.env.TRIOS_BASE || 'feat/queen-supervisor'} origin/${s.branch})..origin/${s.branch}\`
as a statement of what was wanted. Then write it against the base as it stands.

## User Scenarios & Testing

### User Story 1 - The capability exists on today's base (P1)

**Acceptance Scenarios**:
1. **Given** the base as it stands, **When** the change is applied,
   **Then** the names below exist and are exercised by a test.
2. **Given** the same base, **When** the test suite runs,
   **Then** nothing that passed before fails.

## Requirements

- **FR-001**: The capability MUST be implemented against the CURRENT base, not
  copied from \`origin/${s.branch}\`.
- **FR-002**: Every name in the criteria below MUST exist in the tree afterwards.
- **FR-003**: Source files MUST be ASCII-only (L3). The old branch violates this
  in at least one sibling; do not inherit it.

## Success Criteria

${shown.map((id) => `- The tree defines \`${id}\`; that identifier appears nowhere in the tree today.`).join('\n')}
- \`bun test ${s.files.find((f) => /test/.test(f)) || '<the new test file>'}\` exits 0, and its raw stdout is quoted in the report.
- \`LC_ALL=C grep -cP '[^\\x00-\\x7F]' <each changed file>\` prints 0, and the raw output is quoted.

## Boundary

${s.files.map((f) => `\`${f}\``).join('\n')}
`
}

export function render(s) {
  if (!s) return '  no fork point - this branch cannot be compared with the base'
  const out = []
  out.push(`  ${s.files.length} file(s), ${s.addedLines} added line(s), fork ${s.fork.slice(0, 9)}`)
  for (const f of s.files) {
    const moved = sh(`git rev-list --count ${s.fork}..origin/${BASE} -- ${JSON.stringify(f)}`)
    out.push(`    ${f}  ${Number(moved) ? `base moved ${moved} commit(s) since the fork` : 'base untouched since the fork'}`)
  }
  out.push('')
  if (!s.missing.length) {
    out.push(`  every one of the ${s.examined} name(s) this branch introduces is ALREADY in the base.`)
    out.push('  Nothing here is a missing capability. Close it as superseded rather than rebasing it.')
    return out.join('\n')
  }
  out.push(`  ${s.missing.length} name(s) of ${s.examined} examined (${s.candidates} candidates) are absent from the base:`)
  for (const m of s.missing.slice(0, 14)) out.push(`    ${String(m.n).padStart(4)}x  ${m.id}`)
  if (s.missing.length > 14) out.push(`    ... and ${s.missing.length - 14} more`)
  out.push('')
  out.push('  These are a SPECIFICATION OF INTENT, not a patch. Each is a criterion a brief')
  out.push('  can state and verdict-audit can run: absent at the fork point, present on the')
  out.push('  branch, which is a fail-to-pass check by construction.')
  out.push('')
  out.push('  A clean rebase would not have proved this branch correct either: a semantic')
  out.push('  conflict carries no markers, so "it applied" is not evidence.')
  return out.join('\n')
}

if (isMain) {
  let names = process.argv.slice(2).filter((a) => !a.startsWith('--'))
    .map((a) => (/^\d+$/.test(a) ? `queen-${a}` : a))

  if (process.argv.includes('--conflicting')) {
    const LAND = await import(path.join(DIR, 'land.mjs'))
    const rows = await LAND.survey()
    names = rows
      .filter((r) => r.state === 'conflict' || /conflict/i.test(r.why || ''))
      .map((r) => r.branch)
  }

  if (!names.length) {
    console.log('usage: salvage.mjs <branch or issue number> [...] | --conflicting')
    process.exit(1)
  }

  const CAP = Number(process.env.SALVAGE_CAP || 400)
  for (const n of names) {
    const s = surviving(n, { cap: CAP })
    if (process.argv.includes('--brief')) {
      if (!s || !s.missing.length) {
        console.log(`# ${n}: nothing absent from the base - close as superseded rather than re-filing`)
        continue
      }
      console.log(brief(s))
      continue
    }
    console.log(`\n──── ${n}`)
    console.log(render(s))
  }
}
