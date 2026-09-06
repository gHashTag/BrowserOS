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
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
// ONE RULE, ONE IMPLEMENTATION: the gate asks the extractor that does the
// checking rather than keeping a second opinion about what counts as checkable.
import { promisedIdentifiers } from './verdict-audit.mjs'

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


/**
 * Does this path exist anywhere it could legitimately exist?
 *
 * THE WORKING TREE IS NOT THE ONLY ANSWER, and reading only it produced
 * FOURTEEN false accusations the first time this gate was pointed at filed
 * issues. `rings/SR-00/QueenInterfaceDivergence.swift` is absent from this
 * checkout and present at the shipping ref: the checkout is 385 commits behind,
 * so "the file does not exist" was a statement about this laptop.
 *
 * That is the fourth time this loop has published a measurement of the wrong
 * tree, so the rule goes in the tool rather than in my head: a path counts as
 * known if the SHIPPING REF has it, or the working tree does. The ref covers a
 * stale checkout; the tree covers a draft that names a file the author has just
 * created and not yet pushed. Neither alone is enough.
 */
const SHIP_REF = process.env.TRIOS_SHIP_REF || 'origin/feat/queen-supervisor'

export function pathIsKnown(p, deps = {}) {
  const onDisk = deps.onDisk || ((q) => fs.existsSync(atRoot(q)) || fs.existsSync(path.dirname(atRoot(q))))
  const inRef = deps.inRef || ((q) => {
    for (const candidate of [`trios/${q}`, q]) {
      try {
        execSync(`git cat-file -e ${SHIP_REF}:${JSON.stringify(candidate)}`, { cwd: ROOT, stdio: 'ignore' })
        return true
      } catch { /* try the next shape */ }
    }
    return false
  })
  return inRef(p) || onDisk(p)
}


/**
 * A failing brief is one of three different things, and a count hid that.
 *
 * I reported "19 open briefs will produce the next unauditable verdicts", then
 * "14". Both conflated situations that want opposite responses. Measured
 * 2026-09-06 over the 14: EIGHT already have a pushed branch and a verdict the
 * audit could not check - history somebody forgot to close, not a warning - and
 * only SIX have no landed work at all. Six is the number worth acting on, and
 * it was buried under two others three rounds running.
 *
 * UNKNOWN IS ITS OWN ANSWER. A brief whose audit could not be run belongs to
 * neither bucket; putting it in either would be the empty-versus-absent defect
 * this directory keeps finding, in the tool written to report on it.
 */
export function classifyFailing(numbers, deps = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const sh2 = deps.sh || ((c) => {
    try { return execSync(c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
  })
  const hasBranch = deps.hasBranch || ((n) => sh2(`git rev-parse --verify --quiet origin/queen-${n}`) !== null)
  const verdictOf = deps.verdictOf || ((n) => sh2(`node ${path.join(here, 'verdict-audit.mjs')} ${n} 2>/dev/null | head -1`))
  const ahead = []
  const history = []
  const unknown = []
  for (const n of numbers) {
    if (!hasBranch(n)) { ahead.push(n); continue }
    const v = verdictOf(n)
    if (v === null || v === '') unknown.push(n)
    else if (/NO MECHANICAL CLAIM|EMPTY DIFF/.test(v)) history.push(n)
    else ahead.push(n)
  }
  return { ahead, history, unknown }
}

export function gate(file) {
  return gateBody(fs.readFileSync(file, 'utf8'), file)
}

/**
 * The same rules, against a body that is already in hand.
 *
 * SPLIT OUT SO FILED ISSUES CAN BE MEASURED, not only drafts. This gate was
 * written to judge a draft before it is filed, and it has never once been
 * pointed at the 39 accepted verdicts whose briefs state nothing a checker can
 * reach. "Unauditable" has been a single bucket for weeks; the gate already
 * knows how to say WHICH rule each one fails, and the answer decides whether
 * the repair is a judge, a template, or the gate itself.
 */
export function gateBody(body, label = '(body)', opts = {}) {
  // A FILED ISSUE MAY ALREADY BE DONE, AND A DRAFT MAY NOT BE.
  //
  // The "identifier already exists" rule catches a vacuous DRAFT criterion -
  // one satisfiable by an empty patch. Pointed at a filed issue whose bee has
  // already landed the work, it reports that success as a brief defect: #1090
  // is SUPPORTED by the audit ("absent at the fork point, present on the
  // branch") and the gate calls its identifier already-existing, because the
  // gate looks at the tree NOW and the audit looks at the fork point. Both are
  // right about different moments. In `filed` mode the finding is a note.
  const filed = opts.filed === true
  const file = label
  const problems = []
  // Findings that teach without blocking. A gate with only one severity has to
  // choose between saying nothing and refusing everything.
  const notes = []

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
    if (!pathIsKnown(p)) {
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
  // ONE EXTRACTOR, NOT TWO. This file had its own regex for "what counts as a
  // promise" and `verdict-audit` has another - two opinions about the same
  // question, which is the defect this loop keeps finding elsewhere and had
  // here. Measured 2026-09-06: #1090 was rejected by this gate as having no
  // mechanically checkable criterion while the audit extracted `briefShape`
  // from the same body and proved it against the pushed branch. The audit's
  // extractor is the one hardened by five rounds of false accusations - the
  // mention-versus-definition rule, the `node_modules` case, the tree-search
  // form - so the gate asks it rather than keeping a narrower copy.
  const promised = promisedIdentifiers(body)

  // ...and there must be at least one such promise, because it is the ONLY
  // criterion that can be checked without a human or a model. Measured on the
  // 53 briefs filed 2026-09-04: 27 carried one and every one of them was
  // verifiable against the bee's real diff; 18 carried none and are permanently
  // unauditable - the swarm's word is the only evidence they will ever have.
  // The Queen accepts on the bee's self-reported VERDICT block, so a brief with
  // no mechanical claim is a brief that can only ever be self-graded.
  // A CRITERION THAT DEMANDS A GREEN TREE MUST BE CHECKED AGAINST THE TREE.
  //
  // I wrote "`bun run typecheck` passes from `trios/agent-server`" into the
  // template for every L3 cleanup. It does not pass, and has not: 42
  // pre-existing errors on a clean checkout. So around a dozen issues carried a
  // criterion no honest work could satisfy, and the workers did exactly the
  // right thing - one stashed its change, re-ran, proved the failures were
  // identical without it, and reported the criterion unmet. Excellent work,
  // marked down by my sentence.
  //
  // This is the same defect as #1377 SC-2, which demanded output without the
  // word `skip` from a suite named `queen-skip-reason-parity`. Twice now. So the
  // gate refuses a whole-repository green demand and asks for the scoped form -
  // does THIS file contribute an error - which is what the author actually
  // wants to know and is satisfiable on a red tree.
  const GREEN_TREE = [
    [/`?(?:bun run |npm run |yarn )?typecheck`?\s+(?:passes|is clean|succeeds|exits 0)/i, 'the repository typecheck'],
    [/`?(?:bun|npm|yarn) (?:run )?test`?\s+(?:passes|is green|succeeds)(?!\s+(?:for|from `?trios\/agent-server`? on))/i, 'the whole test suite'],
    [/\ball tests? pass\b/i, 'every test in the tree'],
  ]
  for (const [re, what] of GREEN_TREE) {
    for (const l of criteriaLines) {
      if (!re.test(l)) continue
      // A demand scoped to a path is fine: it is about this work, not the tree.
      if (boundary && boundary.some((p) => l.includes(String(p).trim()))) continue
      problems.push(
        `a criterion demands ${what} be green. It is not, and a criterion that ` +
        `cannot be met by correct work is worse than none - it teaches the ` +
        `worker that the report is theatre. Scope it to a path in the Boundary ` +
        `("...| grep -c <that path>` + '`' + ` prints 0")`,
      )
      break
    }
  }

  // A SECOND SHAPE THAT IS EQUALLY MECHANICAL, and refusing it was a false
  // refusal of exactly the kind this gate keeps committing.
  //
  // A cleanup task defines no new identifier - there is nothing to name - yet
  // "`LC_ALL=C grep -cP '[^\\x00-\\x7F]' <a path in the Boundary>` prints 0" is a
  // property of the TREE, not of the report. It is harder to fake than an
  // identifier, because the reader runs it against the branch rather than
  // reading what the worker said about it.
  //
  // The demand stays strict: the command must state an EXACT expected output,
  // and its subject must be a path the Boundary actually reserves - otherwise a
  // worker could satisfy it by pointing at a file it never touched.
  const boundaryPaths = (boundary || []).map((p) => String(p).trim())
  const treeChecks = criteriaLines.filter((l) => {
    if (!/`[^`]*\b(grep|wc|test|\[)\b[^`]*`/.test(l)) return false
    if (!/\b(prints|outputs|reports|exits|is|equals)\s+`?[0-9]/i.test(l)) return false
    return boundaryPaths.some((p) => p && l.includes(p))
  })

  if (!promised.length && !treeChecks.length) {
    problems.push('no mechanically checkable criterion: name an identifier the bee must define ' +
      '("defines a function named `x`; that identifier appears nowhere in the tree today"), ' +
      'or state a command over a path in the Boundary with its exact expected output ' +
      '("`grep -c X path` prints 0"), otherwise nothing but the bee\'s own word can ever confirm the work')
  }

  for (const id of promised) {
    try {
      const n = execSync(`git grep -w '${id}' -- . 2>/dev/null | grep -vc worktrees || true`, { cwd: ROOT, encoding: 'utf8' }).trim()
      if (n !== '0') {
        const already = `identifier ${id} already exists (${n} hits) - the criterion is already met`
        // On a FILED issue this may simply mean the bee's work has landed: the
        // audit judges the same identifier at the FORK POINT and calls #1090
        // SUPPORTED for exactly that reason. Both are right about different
        // moments, so only a draft is failed for it.
        if (filed) notes.push(`${already}; on a filed issue this may mean the work has landed`)
        else problems.push(already)
      }
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
    // A BRIEF THAT IS PROVABLY AUDITABLE IS NOT REJECTED FOR STYLE.
    //
    // This rule is right about a command criterion - a described result is not
    // an observed one - and it was applied as a hard failure regardless of what
    // else the brief carried. Measured 2026-09-06: FIVE open issues fail this
    // gate on nothing but this rule, and `verdict-audit` extracts a promised
    // identifier from every one of them. Four of the five were already proved
    // SUPPORTED against their pushed branch - so the gate was rejecting briefs
    // whose verdicts the same directory had mechanically confirmed.
    //
    // ONE RULE, ONE IMPLEMENTATION: rather than keep a second opinion about
    // what counts as checkable, this asks the extractor that actually does the
    // checking. If it finds a promise, the raw-output finding is a note - the
    // teaching survives, the false rejection does not.
    const alsoCheckable = promisedIdentifiers(body).length > 0
    if (!demandsOutput && alsoCheckable) {
      notes.push(
        `${commandish.length} criterion(s) name a command without asking for its raw output - ` +
          'a described result is not an observed one. Not a failure here: the brief also ' +
          'promises an identifier the audit can check on its own.',
      )
    } else if (!demandsOutput) {
      problems.push(
        `${commandish.length} criterion(s) name a command but none asks for its raw output. ` +
        'A described result, a count, or an exit code without its stdout is a number the ' +
        'worker can reason out instead of observing - and two such counts have already been ' +
        'wrong. Add: paste the command and its raw stdout, unedited and unsummarised.',
      )
    }
  }

  return { file: path.basename(file), problems, notes, boundary, promised }
}

// GATED ON isMain, not merely on "were there arguments".
//
// This read process.argv unconditionally, and I judged it import-safe because
// it does nothing when argv is empty. It is not: an importer with its own
// arguments hands them straight to the gate. fp-check.mjs, invoked as
// `fp-check.mjs 4`, imported this and the gate tried to open a file named "4".
// The same class as the module that ran a production query on import - a file
// that does work merely by being imported cannot be reused.
const argv = isMain ? process.argv.slice(2) : []

// --issues: point the gate at FILED issues instead of drafts.
//
// "Unauditable" has been one bucket for weeks - 39 accepted verdicts whose
// briefs state nothing a checker can reach - and nobody had asked WHICH rule
// each of them fails. This gate already knows, and the distribution decides the
// repair: a judge if the criteria are real but prose, a template if the section
// is missing, this gate itself if it is stricter than the server.
if (argv[0] === '--issues' || argv[0] === '--open') {
  const repo = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'
  let bodies = null
  let numbers = argv.slice(1).filter((a) => /^\d+$/.test(a))
  if (argv[0] === '--open') {
    // ONE CALL, NOT ONE PER ISSUE. The backlog is ~200 issues and a `gh issue
    // view` each is minutes; the list endpoint returns every body at once.
    let listed = null
    try {
      listed = JSON.parse(execSync(`gh issue list --repo ${repo} --state open --limit 500 --json number,body`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }))
    } catch { listed = null }
    if (!listed || !listed.length) {
      // An empty list is not a clean backlog. This is the same distinction the
      // rest of this directory keeps having to relearn.
      console.log('the open issue list could not be read - NOTHING was gated, which is not the same as nothing failing')
      process.exit(3)
    }
    bodies = new Map(listed.map((r) => [String(r.number), r.body || '']))
    numbers = [...bodies.keys()]
  }
  if (!numbers.length) {
    console.log('usage: brief-gate.mjs --issues <N> [N ...] | --open')
    process.exit(1)
  }
  const tally = new Map()
  const failing = []
  let clean = 0
  let unread = 0
  for (const n of numbers) {
    let body = bodies ? (bodies.get(String(n)) ?? null) : null
    if (body === null && !bodies) {
      try {
        body = execSync(`gh issue view ${n} --repo ${repo} --json body -q .body`,
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      } catch { body = null }
    }
    // A body that could not be read is NOT a clean brief. It is counted apart,
    // because the one answer this must never give is health for work it never
    // looked at.
    if (body === null) { unread++; console.log(`?? #${n}  body unreadable - NOT gated`); continue }
    const r = gateBody(body, `#${n}`, { filed: true })
    if (!r.problems.length) {
      clean++
      if (!bodies) {
        console.log(`ok #${n}`)
        ;(r.notes || []).forEach((x) => console.log(`      ~   ${x.slice(0, 110)}`))
      }
      continue
    }
    failing.push(n)
    console.log(`!! #${n}  ${r.problems.length} problem(s)`)
    for (const p of r.problems) {
      // Tallied by RULE, not by issue: the question is which rule the corpus
      // fails, and a per-issue list answers a different one.
      const key = p.replace(/[:\-] .*$/, '').replace(/\b#?\d+\b/g, 'N').trim()
      tally.set(key, (tally.get(key) || 0) + 1)
      if (!bodies) console.log(`      ${p.slice(0, 110)}`)
    }
  }
  console.log(`\n${numbers.length} brief(s): ${clean} pass this gate, ${numbers.length - clean - unread} fail, ${unread} unreadable`)

  // A FAILING BRIEF IS ONE OF THREE DIFFERENT THINGS, AND THE COUNT HID THAT.
  //
  // I reported "19 open briefs will produce the next unauditable verdicts" and
  // then "14". Both conflated three situations that want opposite responses.
  // Of the 14: five already have a pushed branch AND a verdict the audit could
  // not check - that is history somebody forgot to close, not a future problem.
  // Five more have no branch at all and no structure - those are the forward
  // ones. The rest have structure and a gap.
  //
  // The forward number is the only one worth acting on, so it is the one
  // printed last. Asking git and the audit costs a second each and turns a
  // count into a decision.
  if (failing.length) {
    const r = classifyFailing(failing)
    console.log('')
    console.log(`  ${r.history.length} already produced a verdict nothing could check - history, not a warning: ${r.history.map((n) => `#${n}`).join(' ')}`)
    if (r.unknown.length) console.log(`  ${r.unknown.length} could not be audited, so neither bucket claims them: ${r.unknown.map((n) => `#${n}`).join(' ')}`)
    console.log(`  ${r.ahead.length} have no landed work yet - THESE are the next unauditable verdicts: ${r.ahead.map((n) => `#${n}`).join(' ')}`)
  }

  process.exit(0)
}

const files = argv
if (files.length) {
  let bad = 0
  for (const f of files) {
    const r = gate(f)
    console.log(`${r.problems.length ? 'FAIL  ' : 'ok    '}${r.file}   parser sees ${r.boundary.length} path(s)`)
    r.boundary.forEach((p) => console.log(`        boundary  ${p}`))
    r.problems.forEach((p) => console.log(`        !!  ${p}`))
    // Notes are findings that teach without blocking. A gate with one severity
    // must choose between saying nothing and refusing everything.
    ;(r.notes || []).forEach((n) => console.log(`        ~   ${n}`))
    if (r.problems.length) bad++
  }
  console.log(`\nfailing: ${bad} of ${files.length}`)
  process.exit(bad ? 1 : 0)
}
