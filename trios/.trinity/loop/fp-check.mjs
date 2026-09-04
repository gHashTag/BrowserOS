#!/usr/bin/env node
// Does any checker accuse something that is known to be good?
//
// THE CLASS THIS GUARDS, and it is the most frequent failure in this loop's
// whole record - six instances in one night, each fixed alone, none guarded:
//
//   brief-gate     rejected a well-formed brief because it said "neither
//                  identifier appears anywhere" and the pattern knew only
//                  "appears nowhere"
//   brief-gate     then rejected the exact wording it was telling authors to
//                  adopt: it knew "does not name", not "MUST NOT name"
//   coverage       the naive form reported 144 of 260 source files as untested,
//                  including files a dozen suites exercise
//   verdict-audit  accused four workers at once - a class method with a return
//                  type, a describe title, a word never promised, and four
//                  identifiers harvested from a paragraph
//   fields         accused the review sweep twice, once reading a subquery as a
//                  new region and once truncating the column list at its FROM
//   me             published gHashTag/trios#1419 on a judge's report without
//                  opening the diff; no line in the branch contained the thing
//
// WHY THE EXISTING HARNESS DID NOT CATCH THEM. `tri loop-selftest` runs against
// SYNTHETIC fixtures, and every one of the six failed on a REAL input. A
// fixture is written by the same hand and the same assumptions as the checker,
// so it agrees with it. This runs each checker against material that is known
// good because the WORLD says so - briefs a worker actually satisfied, source
// the tree actually ships - and any accusation there is a false one.
//
// The corpus is meant to grow. Tighten a checker, then run this BEFORE
// believing what the tightened version reports.
//
// Usage:
//   node fp-check.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REPO = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'
const isMain = process.argv[1] && process.argv[1].endsWith('/fp-check.mjs')

const sh = (c) => execSync(c, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const tryShell = (c) => { try { return sh(c) } catch { return null } }

const G = await import(path.join(DIR, 'brief-gate.mjs'))
const CLK = await import(path.join(DIR, 'clocks.mjs'))
const FLD = await import(path.join(DIR, 'fields.mjs'))
const VA = await import(path.join(DIR, 'verdict-audit.mjs'))
const COV = await import(path.join(DIR, 'coverage.mjs'))
const TR = await import(path.join(DIR, 'trend.mjs'))

/**
 * Briefs that are known good BY THE WORLD: a worker was dispatched on them and
 * the Queen accepted the result. Whatever else may be wrong with such a brief,
 * it was demonstrably workable, so a gate refusing it is refusing reality.
 */
function acceptedBriefs(limit) {
  const numbers = (tryShell(
    `gh issue list --repo ${REPO} --state all --limit 120 --json number,state -q '[.[] | select(.number>=1347 and .state=="CLOSED")] | .[].number'`,
  ) || '').split('\n').filter(Boolean).slice(0, limit)

  const out = []
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-corpus-'))
  for (const n of numbers) {
    const body = tryShell(`gh issue view ${n} --repo ${REPO} --json body -q .body`)
    if (!body || !/\n## Boundary/.test(body)) continue
    // Only briefs whose work actually landed on a branch: a closed issue with
    // no branch proves nothing about whether the brief was workable.
    if (!tryShell(`git rev-parse --verify --quiet origin/queen-${n}`)) continue
    const f = path.join(tmp, `${n}.md`)
    fs.writeFileSync(f, body)
    out.push({ n, file: f })
  }
  return { cases: out, tmp }
}

export function run(limit = 12) {
  const results = []
  const { cases, tmp } = acceptedBriefs(limit)

  for (const c of cases) {
    const r = G.gate(c.file)
    // A brief filed BEFORE a rule existed may legitimately fail that rule -
    // that is a change of standard, not a false accusation. Only the rules
    // about being WORKABLE are asserted here.
    const workability = r.problems.filter((p) =>
      /EMPTY boundary|forbidden path|parent missing|missing heading|out of order|non-ASCII/.test(p))
    results.push({
      checker: 'brief-gate',
      subject: `#${c.n} (accepted work)`,
      ok: workability.length === 0,
      // NAME what was set aside. "2 notes ignored" asks the reader to trust a
      // count, and a false-positive check that hides its own exclusions is the
      // thing it exists to prevent. Every excluded note is printed.
      why: workability.join('; ') ||
        (r.problems.length
          ? `clean on workability; set aside: ${r.problems.map((p) => p.split(':')[0].slice(0, 46)).join(' | ')}`
          : 'clean'),
    })
  }
  fs.rmSync(tmp, { recursive: true, force: true })

  // verdict-audit, against issues whose promised identifier IS in the diff.
  // Every one of these was independently confirmed SUPPORTED before the audit
  // was tightened, so a CLAIM UNSUPPORTED here is the checker regressing, not
  // the work changing - the artefacts are frozen on their branches.
  for (const n of ['1347', '1348', '1349', '1353', '1372']) {
    const r = VA.auditIssue(n)
    results.push({
      checker: 'verdict-audit',
      subject: `#${n} (identifier confirmed present)`,
      ok: r.verdict === 'SUPPORTED',
      why: r.verdict === 'SUPPORTED' ? 'supported, as it was before the audit was tightened' : `${r.verdict}: ${r.notes.join('; ').slice(0, 70)}`,
    })
  }

  // coverage, against the loop's own tools. Every act path has been exercised
  // at least once, so an "unproven" here means the ledger stopped recording
  // rather than that a tool stopped working.
  const cov = COV.coverage().filter((r) => r.state === 'NEVER ACTED' || r.state === 'UNTRACKED')
  results.push({
    checker: 'coverage',
    subject: 'the loop tools',
    ok: cov.length === 0,
    why: cov.length ? cov.map((c) => `${c.file}: ${c.state}`).join(', ') : 'every act path has run at least once',
  })

  // trend, against the ledger it has been fed all night. "too few points" here
  // would mean the snapshot lines stopped arriving, which is a silent failure
  // of the thing that feeds every rate on the dashboard.
  const tr = TR.trend(24).filter((r) => r.state !== 'measured')
  results.push({
    checker: 'trend',
    subject: 'the last 24 h of snapshots',
    ok: tr.length === 0,
    why: tr.length ? tr.map((r) => `${r.key}: ${r.state}`).join(', ') : 'every series has enough points to slope',
  })

  const clocks = CLK.clocks().filter((r) => r.state !== 'immutable')
  results.push({
    checker: 'clocks',
    subject: 'the shipping tree',
    ok: clocks.length === 0,
    why: clocks.length ? clocks.map((c) => `${c.file}:${c.line} ${c.field}`).join(', ') : 'no measurement on a rewritten field',
  })

  const tickText = tryShell('git show origin/feat/queen-supervisor:trios/agent-server/apps/server/src/api/services/queen-tick.ts')
  if (tickText) {
    const bad = FLD.audit(tickText).filter((r) => r.state !== 'complete')
    results.push({
      checker: 'fields',
      subject: 'the deployed tick',
      ok: bad.length === 0,
      why: bad.length ? bad.map((b) => `line ${b.line}: ${(b.missing || []).join(', ') || b.why}`).join('; ') : 'every read is selected',
    })
  } else {
    results.push({ checker: 'fields', subject: 'the deployed tick', ok: false, why: 'could not read the tick - unreadable is not clean' })
  }

  return results
}

if (isMain) {
  const rows = run(Number(process.argv[2] || 12))
  const bad = rows.filter((r) => !r.ok)

  console.log('false-positive check - do the checkers accuse anything known good?\n')
  let checker = ''
  for (const r of rows) {
    if (r.checker !== checker) { checker = r.checker; console.log(`  ${checker}`) }
    console.log(`    ${r.ok ? 'ok  ' : 'ACCUSED  '}${r.subject.padEnd(26)} ${r.why.slice(0, 90)}`)
  }
  console.log(`\n${rows.length} known-good input(s): ${rows.length - bad.length} clean, ${bad.length} accused`)
  if (bad.length) {
    console.log('\nAn accusation against material the world says is good is a FALSE one.')
    console.log('Six such were shipped in one night, each fixed alone and none guarded.')
  }
  process.exit(bad.length ? 1 : 0)
}
