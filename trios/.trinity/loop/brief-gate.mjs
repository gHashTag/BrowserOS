#!/usr/bin/env node
// Gate an issue draft the way the Queen will read it, before it is filed.
//
// Why this exists rather than a checklist: a draft can satisfy every rule a
// human would check and still be undelegatable, because the only opinion that
// matters is the server's own parser. So the boundary reader below is a
// FAITHFUL PORT of boundaryPathsOf in
//   trios/agent-server/apps/server/src/api/services/queen-tick.ts
// on origin/feat/queen-supervisor. Keep it that way: if that function changes,
// this one is wrong and every draft it passes is a guess.
//
// Two defects this gate has already caught in drafts that looked fine:
//   - a paragraph appended AFTER "## Boundary", which the parser swallowed as
//     five garbage paths;
//   - a boundary naming a route file that does not exist under that name.
// And one defect in ITSELF, worth keeping in mind: it first resolved paths
// against the current working directory, so it reported every real path as
// missing whenever it was run from a subdirectory. Paths resolve against ROOT.

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

// IMPORT-SAFE. This module ran its production query and called process.exit at
// import time, so importing it hit the live database and killed the importer -
// the calibration harness could not test it and died mid-run trying. A module
// that does work merely by being imported cannot be tested, and cannot be
// reused. Everything below the guard runs only when this file IS the program.
const isMain = process.argv[1] && process.argv[1].endsWith('/brief-gate.mjs')


const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const atRoot = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p))

/** Faithful port of boundaryPathsOf. Do not "improve" it. */
export function boundaryPathsOf(body) {
  const paths = []
  let inside = false
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('## ')) {
      if (inside) break
      inside = line.startsWith('## Boundary') || line.startsWith('## Границы')
      continue
    }
    if (!inside || line.length === 0) continue
    for (const token of line.split(/\s+/)) {
      const cleaned = token.replace(/^[`"'(]+/, '').replace(/[`"'.,;:!?)]+$/, '')
      if (cleaned.includes('/') || /\.\w{1,10}$/.test(cleaned)) { paths.push(cleaned); break }
    }
  }
  return paths
}

// Ground a bee cannot work, for reasons that are not style.
const FORBIDDEN = [
  [/^\/Users\/playra\/t27/, 'another agent owns this tree (L0b)'],
  [/rings\/RUST-13\/trios-mesh/, 'git submodule - a bee cannot land an edit here'],
  [/_to_delete|node_modules|\.worktrees/, 'not source'],
  [/trios(-dev|-test)?\.app\//, 'build output'],
]

// A tool used as a COMMAND, not the same word appearing in prose. "make the
// gate green" is fine; "`make check`" is not, because the worker image has no
// make. Matching the bare word produced five false failures in one batch.
const asCommand = (tool) => new RegExp('(`\\s*|\\$\\s+)' + tool + '\\s+[\\w./:-]+', 'm')
const UNRUNNABLE = [
  [asCommand('make'), 'make'],
  [asCommand('python3'), 'python3'],
  [/swift\s+(build|test|run)/, 'swift'],
  [asCommand('cargo'), 'cargo'],
  [asCommand('t27c'), 't27c'],
]

const HEADINGS = ['## User Scenarios & Testing', '## Requirements', '## Success Criteria', '## Boundary']

export function gate(file) {
  const body = fs.readFileSync(file, 'utf8')
  const problems = []

  for (const h of HEADINGS) {
    if (!body.split('\n').some((l) => l.trim().startsWith(h))) problems.push(`missing heading ${h}`)
  }
  const at = HEADINGS.map((h) => body.indexOf('\n' + h))
  if (at.every((i) => i >= 0) && at.slice(1).some((v, i) => v < at[i])) problems.push('headings are out of order')

  if (!/\*\*FR-\d{3}\*\*[^\n]*MUST/.test(body)) problems.push('no "**FR-nnn**: ... MUST ..." requirement')

  const nonAscii = [...new Set([...body].filter((c) => c.charCodeAt(0) > 126))]
  if (nonAscii.length) problems.push(`non-ASCII (law L3): ${JSON.stringify(nonAscii.slice(0, 8).join(''))}`)

  const boundary = boundaryPathsOf(body)
  if (!boundary.length) problems.push('the server parser reads an EMPTY boundary - not delegatable')
  for (const p of boundary) {
    const bad = FORBIDDEN.find(([re]) => re.test(p))
    if (bad) { problems.push(`forbidden path ${p} - ${bad[1]}`); continue }
    if (!fs.existsSync(atRoot(p)) && !fs.existsSync(path.dirname(atRoot(p)))) {
      problems.push(`path has no existing parent: ${p}`)
    }
  }

  const criteria = body.split('## Success Criteria')[1] || ''
  for (const [re, name] of UNRUNNABLE) {
    if (re.test(criteria)) problems.push(`criteria need ${name}, which the worker image does not have`)
  }

  // Every "names an identifier that does not exist yet" promise must be true...
  //
  // The first version of this pattern required the words "appears nowhere" to
  // follow the backticked name on the same line, and promptly rejected a
  // well-formed brief that said "neither identifier appears anywhere in the
  // tree today" for its two names. A gate that fails good work is worse than no
  // gate, so the rule is now: a Success Criteria line that names one or more
  // backticked identifiers AND asserts their absence, in any of the phrasings
  // this backlog actually uses.
  const criteriaLines = (body.split('## Success Criteria')[1] || '').split('\n')
  const promised = []
  for (const l of criteriaLines) {
    if (!/appears (nowhere|anywhere)|does not (exist|appear)|no such identifier/i.test(l)) continue
    for (const m of l.matchAll(/`([A-Za-z_][A-Za-z0-9_]{2,})`/g)) promised.push(m[1])
  }

  // ...and there must be at least one such promise, because it is the ONLY
  // criterion that can be checked without a human or a model. Measured on the
  // 53 briefs filed 2026-09-04: 27 carried one and every one of them was
  // verifiable against the bee's real diff; 18 carried none and are permanently
  // unauditable - the swarm's word is the only evidence they will ever have.
  // The Queen accepts on the bee's self-reported VERDICT block, so a brief with
  // no mechanical claim is a brief that can only ever be self-graded.
  if (!promised.length) {
    problems.push('no mechanically checkable criterion: name an identifier the bee must define ' +
      '("defines a function named `x`; that identifier appears nowhere in the tree today"), ' +
      'otherwise nothing but the bee\'s own word can ever confirm the work')
  }

  for (const id of promised) {
    try {
      const n = execSync(`git grep -w '${id}' -- . 2>/dev/null | grep -vc worktrees || true`, { cwd: ROOT, encoding: 'utf8' }).trim()
      if (n !== '0') problems.push(`identifier ${id} already exists (${n} hits) - the criterion is already met`)
    } catch { problems.push(`could not check identifier ${id}`) }
  }

  // A CRITERION THAT ASKS FOR A COUNT MUST ALSO ASK THAT IT BE INDEPENDENT.
  //
  // The first version of this rule looked for a rigged command IN THE BRIEF,
  // and was aimed at the wrong artefact: the rigging happens in the worker's
  // OUTPUT, which does not exist when a brief is gated. What a brief can be
  // held to is the shape of the demand.
  //
  // Found by an independent judge on 2026-09-04. A criterion asked for "a table
  // with one row per function ... and the command that produced the second
  // number". `grep -c 'func '` gives 4; the table had 5; the worker reached 5
  // with `grep -cE 'func [a-zA-Z]+\(|var prior: Int \{'`, whose second branch is
  // the literal text of the one declaration needed. Not deception - the same
  // document says the plain grep gives 4 - and still not a count.
  //
  // The criterion permitted it by asking only that a command be quoted, never
  // that the command be one whose output does not depend on knowing the answer.
  // Warn rather than refuse: the fix is one clause, and a gate that refuses
  // good work is worse than no gate.
  for (const line of criteriaLines) {
    const asksForCount = /\b(count|number)\b[^\n]*\b(equals|matches|is)\b|\bthe command that produced\b/i.test(line)
    if (!asksForCount) continue
    // The phrasings this backlog actually uses, including MUST NOT, which the
    // first version missed - and so rejected the very wording it was asking
    // authors to adopt. A gate that fails the fix it recommends is worse than
    // no gate at all.
    const demandsIndependence =
      /independent|without (?:naming|enumerating|listing)|(?:does|must|may) not (?:name|enumerate|list)|derived from|not hard-?coded/i.test(line)
    if (!demandsIndependence) {
      problems.push(
        'a criterion asks for a count and the command that produced it, but does not ' +
        'require that command to be independent. A command may be written so its output ' +
        'is the answer already known - true by construction. Add: the command MUST NOT ' +
        'name or enumerate the specific items it counts.',
      )
      break
    }
  }

  // A CRITERION ABOUT THE CHARACTERS IN AN OUTPUT IS USUALLY ABOUT THE WRONG THING.
  //
  // I wrote one: #1377 SC-2 demanded the run's output "MUST NOT contain `skip`",
  // from a suite named `queen-skip-reason-parity` that prints
  // `skipped.append sites measured`. The word was guaranteed to appear, so no
  // honest work could pass. What it meant was that the runner's TALLY must show
  // no skipped tests - a statement about what the summary reports, not about
  // which characters occur.
  //
  // The tell is a negative demand over raw output text. A positive one ("the
  // output MUST show 0 fail") is fine: it names a thing the summary reports.
  for (const line of criteriaLines) {
    if (!/\boutput\b|\bstdout\b/i.test(line)) continue
    if (!/MUST NOT contain|must not include|does not contain/i.test(line)) continue
    problems.push(
      'a criterion forbids a STRING in a command\'s output. That is a statement ' +
      'about characters, not about what the run reported, and it is usually ' +
      'unsatisfiable by accident - a suite named after the thing will print it. ' +
      'Say what the summary must REPORT instead (for example "the tally MUST show ' +
      '0 skipped"), or name the exact line the string must not appear on.',
    )
    break
  }

  // A CRITERION THAT NAMES A COMMAND MUST DEMAND ITS RAW STDOUT.
  //
  // Written by the judge that found the first two fabrications, verbatim as the
  // line a brief should carry: "Paste the shell command and its raw stdout,
  // unedited and unsummarised, for every criterion that names a command - a
  // described result, a count, or an exit code without its output is scored as
  // unmet."
  //
  // Measured across 34 run-criteria: 9 QUOTED, 23 ASSERTED, 2 FABRICATED. Both
  // fabrications were COUNTS - "returns 3 lines" where the tree has 7, "prints
  // 15" where it has 14 - predicted instead of observed, and predicted wrong.
  // The failure mode is no longer unshown runs; it is unshown counts.
  //
  // A criterion that says "quote the run" is already close. One that says only
  // "the audit reports N" invites the number to be reasoned out.
  const commandish = criteriaLines.filter((l) =>
    /`[^`]*\b(?:git|grep|node|bun|sh|wc|diff|ls)\b[^`]*`/.test(l) || /\brun[s]? as\b|\bruns\b.*`/.test(l))
  if (commandish.length) {
    const demandsOutput = criteriaLines.some((l) =>
      /raw stdout|unedited|quoted? (?:in|the)|paste|verbatim|its output/i.test(l))
    if (!demandsOutput) {
      problems.push(
        `${commandish.length} criterion(s) name a command but none asks for its raw output. ` +
        'A described result, a count, or an exit code without its stdout is a number the ' +
        'worker can reason out instead of observing - and two such counts have already been ' +
        'wrong. Add: paste the command and its raw stdout, unedited and unsummarised.',
      )
    }
  }

  return { file: path.basename(file), problems, boundary, promised }
}

// GATED ON isMain, not merely on "were there arguments".
//
// This read process.argv unconditionally, and I judged it import-safe because
// it does nothing when argv is empty. It is not: an importer with its own
// arguments hands them straight to the gate. fp-check.mjs, invoked as
// `fp-check.mjs 4`, imported this and the gate tried to open a file named "4".
// The same class as the module that ran a production query on import - a file
// that does work merely by being imported cannot be reused.
const files = isMain ? process.argv.slice(2) : []
if (files.length) {
  let bad = 0
  for (const f of files) {
    const r = gate(f)
    console.log(`${r.problems.length ? 'FAIL  ' : 'ok    '}${r.file}   parser sees ${r.boundary.length} path(s)`)
    r.boundary.forEach((p) => console.log(`        boundary  ${p}`))
    r.problems.forEach((p) => console.log(`        !!  ${p}`))
    if (r.problems.length) bad++
  }
  console.log(`\nfailing: ${bad} of ${files.length}`)
  process.exit(bad ? 1 : 0)
}
