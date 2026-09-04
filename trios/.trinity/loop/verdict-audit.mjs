#!/usr/bin/env node
// Check a bee's claimed verdict against the diff it actually produced.
//
// WHY THIS IS NEEDED. The Queen accepts on the strength of the bee's own
// `## VERDICT` block. From the diff she reads only two things: whether any file
// was committed at all, and whether any committed path fell outside the
// boundary. Nothing anywhere asks whether the change supports the criterion the
// bee says it met. That is a self-reported score, and the field it belongs to
// has already learned what self-reported scores are worth: on Terminal-Bench
// 1.0 and 2.0 the number one slot was permanently held by vendor self-reports
// sitting 13.5 and 2.5 points above the best independently re-run entry, and
// the maintainers' answer was to stop accepting self-reports at all and to have
// a judge read every successful trajectory.
//
// THE CHECK THIS TOOL CAN MAKE MECHANICALLY. Most briefs in this backlog end
// their Success Criteria with a promise of the form:
//
//     The script defines a function named `foo`; that identifier appears
//     nowhere in the tree today.
//
// That is unfakeable. If `foo` does not appear in the branch's diff, the
// criterion cannot have been met, whatever the VERDICT block says. This is not
// a judgement about quality - it is arithmetic, and it needs no model.
//
// It became possible only on 2026-09-04, when 100 bee branches were pushed for
// the first time. Before that the diff existed nowhere a checker could read it.
//
// Usage:
//   node verdict-audit.mjs 1349 1353 1372
//   node verdict-audit.mjs --accepted        # every issue with an accept verdict

import { execSync } from 'node:child_process'

// IMPORT-SAFE. This module ran its production query and called process.exit at
// import time, so importing it hit the live database and killed the importer -
// the calibration harness could not test it and died mid-run trying. A module
// that does work merely by being imported cannot be tested, and cannot be
// reused. Everything below the guard runs only when this file IS the program.
const isMain = process.argv[1] && process.argv[1].endsWith('/verdict-audit.mjs')


const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REPO = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'

const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim()

const tryShell = (cmd) => { try { return sh(cmd) } catch { return null } }

/**
 * Identifiers a brief promised the bee would introduce.
 *
 * The first version took every backticked word in the body that looked like an
 * identifier, and duly accused a bee of failing to define `node_modules`. The
 * promise is not "this word appears in backticks" - it is a Success Criteria
 * line asserting the identifier does not exist yet, which is the same rule
 * brief-gate uses to decide a brief is auditable at all. Read it the same way,
 * or the two disagree about what was even promised.
 */
export function promisedIdentifiers(body) {
  const out = new Set()
  for (const line of (body.split('## Success Criteria')[1] || '').split('\n')) {
    // A CRITERION, not any sentence in the section. The absence phrase appears
    // in prose too: #1387 has a paragraph reading "a section she is publicly
    // telling the author does not exist", from which this harvested four
    // identifiers nobody had promised and then accused the bee of not
    // defining them. A criterion in these briefs is a bullet or a numbered
    // item; a paragraph is background.
    if (!/^\s*(?:[-*]|\d+\.)\s/.test(line)) continue
    if (!/appears (nowhere|anywhere)|does not (exist|appear)|no such identifier/i.test(line)) continue
    for (const m of line.matchAll(/`([A-Za-z_][A-Za-z0-9_]{2,})`/g)) out.add(m[1])
  }
  return [...out]
}

/** Files a brief named in its Boundary, by the server's own rule. */
export function boundaryPathsOf(body) {
  const paths = []
  let inside = false
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('## ')) { if (inside) break; inside = line.startsWith('## Boundary'); continue }
    if (!inside || !line) continue
    for (const token of line.split(/\s+/)) {
      const c = token.replace(/^[`"'(]+/, '').replace(/[`"'.,;:!?)]+$/, '')
      if (c.includes('/') || /\.\w{1,10}$/.test(c)) { paths.push(c); break }
    }
  }
  return paths
}

export function auditIssue(number) {
  const branch = `origin/queen-${number}`
  const res = { number, branch, verdict: 'UNKNOWN', notes: [] }

  const body = tryShell(`gh issue view ${number} --repo ${REPO} --json body -q .body`)
  if (body === null) { res.verdict = 'NO ISSUE'; res.notes.push('issue body unreadable'); return res }

  const head = tryShell(`git rev-parse --verify --quiet ${branch}`)
  if (!head) {
    res.verdict = 'NO BRANCH'
    res.notes.push('no pushed branch - the work is not auditable from here')
    return res
  }


// THE FORK POINT, NOT THE CURRENT TIP.
//
// A branch is compared against where it FORKED, not against where the base has
// since moved to. Comparing against the tip reports everything merged into the
// base after the branch was cut as if the branch had DELETED it. Measured
// 2026-09-04 on queen-1351: against the tip, "3 files changed, 94 insertions,
// 234 deletions" - it looked as though the bee had removed a fix and its whole
// test file. Against the merge base: "1 file changed, 90 insertions", which is
// what the bee actually did. A judge handed the first version would have
// convicted an innocent worker.
  const base = tryShell(`git merge-base origin/feat/queen-supervisor ${branch}`)
    || tryShell('git rev-parse --verify --quiet origin/feat/queen-supervisor')
  const names = tryShell(`git diff --name-only ${base}..${branch}`) || ''
  const files = names.split('\n').filter(Boolean)
  res.files = files.length
  if (!files.length) {
    res.verdict = 'EMPTY DIFF'
    res.notes.push('branch exists and changes nothing')
    return res
  }

  // The added lines of the diff. An identifier only counts if the bee ADDED it.
  const added = (tryShell(`git diff ${base}..${branch} -- . | grep '^+' | head -20000`) || '')

  const promised = promisedIdentifiers(body)
  res.promised = promised

  // A MENTION IS NOT A DEFINITION.
  //
  // The first version of this asked only whether the identifier appeared
  // anywhere among the added lines, which a comment, a string or a test name
  // would satisfy. That is precisely the shape of check a determined agent
  // games, and the field has the receipts: Terminal-Bench removed three agents
  // for storing solutions in the binary, uploading the tests folder, and
  // curling answers from the internet.
  //
  // So the identifier must appear in a DEFINITION among the added lines. This
  // is still not proof the implementation is any good - only a judge reading
  // the diff can say that - but it cannot be satisfied by writing the name in
  // a comment.
  //
  // Checked against all 38 supported results when it was tightened: none
  // changed, so the weakness was real but had not yet been exploited.
  // WHAT COUNTS AS DEFINING IT, and what tightening this cost.
  //
  // Requiring a definition rather than a mention is right - a comment or a
  // string should not satisfy a criterion - but the first pattern was too
  // narrow and produced three accusations, every one of them false:
  //
  //   #1368  `onReconnected(handler: () => void): () => void {`  a class method
  //          whose return-type annotation sits between the parens and the brace
  //   #1407  `describe('taskQueueServiceContract', () => {`      a criterion that
  //          asked for a describe NAME, which is legitimately a string literal
  //   #1376  `node_modules`                                      never promised at
  //          all; the extractor invented it
  //
  // A checker that falsely accuses is worse than a loose one, so all three
  // shapes are accepted now. This still cannot judge whether the code is any
  // good - only a reader of the diff can - but it cannot be passed by writing
  // the name in a comment.
  const defines = (id) => {
    const patterns = [
      // declaration: function foo, const foo, class Foo, type Foo
      `^\\+.*\\b(?:function|const|let|var|class|type|interface|enum)\\s+${id}\\b`,
      // object or class property: foo: ..., foo = ...
      `^\\+\\s*(?:public |private |static |readonly |export )*${id}\\s*[:=]`,
      // method or call-shaped definition, tolerating a return-type annotation
      `^\\+.*\\b${id}\\s*\\([^)]*\\).*\\{\\s*$`,
      // a name the criterion asked to REGISTER rather than declare, such as a
      // describe or test title
      `^\\+.*(?:describe|it|test|suite)\\s*\\(\\s*['"\`]${id}['"\`]`,
    ]
    return patterns.some((p) => new RegExp(p, 'm').test(added))
  }
  const missing = promised.filter((id) => !defines(id))
  res.missingIdentifiers = missing

  const boundary = boundaryPathsOf(body).map((p) => p.replace(/^trios\//, ''))
  const touched = files.map((f) => f.replace(/^trios\//, ''))
  const strays = touched.filter((f) => !boundary.some((b) => f === b || f.startsWith(b.replace(/\/$/, '') + '/')))
  res.strays = strays

  if (promised.length && missing.length) {
    res.verdict = 'CLAIM UNSUPPORTED'
    res.notes.push(`promised ${promised.length} new identifier(s); ${missing.length} never appear in the diff: ${missing.join(', ')}`)
  } else if (promised.length) {
    res.verdict = 'SUPPORTED'
    res.notes.push(`all ${promised.length} promised identifier(s) present in the diff`)
  } else {
    res.verdict = 'NO MECHANICAL CLAIM'
    res.notes.push('the brief promised no new identifier, so nothing here can be checked without a judge')
  }
  if (strays.length) res.notes.push(`${strays.length} file(s) outside the declared boundary`)
  return res
}

// ------------------------------------------------------------------------ cli

if (!isMain) { /* imported for calibration or reuse: do nothing */ } else {
let numbers = process.argv.slice(2).filter((a) => /^\d+$/.test(a))
if (process.argv.includes('--accepted')) {
  // THE FLOOR WAS A NUMBER NOBODY EXPLAINED, IN A FILE THAT EXPLAINS EVERYTHING.
  //
  // `select(.number>=1347)` appeared exactly once, with no comment, in a file
  // where the merge-base choice, the mention-versus-definition rule, the three
  // false accusations and the import guard each carry a multi-paragraph
  // justification. Audited 2026-09-05: it excluded 63 of the 189 pushed
  // `queen-*` branches - a third of the swarm's whole output. 57 of those 63
  // briefs carry a Success Criteria section, 15 yield a promised identifier this
  // tool's own extractor accepts, and running `auditIssue` on eight of them by
  // hand returned SUPPORTED for all eight.
  //
  // Both defences failed against measurement. The criteria convention is not the
  // boundary: it reaches down to #1062. Nor is it a date boundary: 34 below-floor
  // branches were committed on 2026-09-03, the same day as 44 above-floor ones.
  //
  // So the data decides instead of a constant. Every issue with a PUSHED branch
  // is auditable, because a pushed branch is exactly what this tool compares a
  // claim against - and an issue without one has nothing to audit. The set
  // justifies itself and cannot drift out of date.
  //
  // The `--limit 200` went with it. There are 189 branches today; a cap two
  // percent above the live number is a silent truncation waiting for next week.
  const branches = tryShell(`git branch -r --list 'origin/queen-*'`) || ''
  numbers = [...new Set(
    branches.split('\n')
      .map((b) => (b.match(/queen-(\d+)\s*$/) || [])[1])
      .filter(Boolean),
  )].sort((a, b) => Number(b) - Number(a))
}
if (!numbers.length) {
  console.log('usage: verdict-audit.mjs <issue> [issue ...] | --accepted')
  process.exit(1)
}

const tally = {}
for (const n of numbers) {
  const r = auditIssue(n)
  tally[r.verdict] = (tally[r.verdict] || 0) + 1
  const mark = { 'CLAIM UNSUPPORTED': '!!', SUPPORTED: 'ok', 'EMPTY DIFF': '!!', 'NO BRANCH': '??' }[r.verdict] || '  '
  console.log(`${mark} #${r.number}  ${r.verdict.padEnd(20)} files=${r.files ?? '-'}  ${r.notes.join('; ').slice(0, 90)}`)
}
console.log('\n' + Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('   '))
}
