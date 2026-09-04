#!/usr/bin/env node
// Turn a measured deficit into a filed, gated brief - the half the Queen is
// missing, built outside her for the same reason the lease was.
//
// WHAT ALREADY EXISTS AND DOES NOTHING. `deriveCandidates` is committed in
// `queen-tick.ts` locally and is NOT on origin/feat/queen-supervisor. It reads a
// genuinely reproducible signal - a source file longer than the threshold the
// pre-commit hook already warns on - ranks by length, and is wired to nothing.
// A deriver that files nothing is a deriver that starves. This is the other end
// of it.
//
// THE TWO RULES THE FIELD SAYS MATTER, and both are here.
//
//   EXECUTION PROOF BEFORE THE ITEM EXISTS. SWE-smith keeps a synthesized task
//   only if the patch breaks an existing passing test, and writes the issue
//   text FROM the verified failure. Here the proof is weaker but real and
//   re-measured at authoring time: the file is counted again now, and a file
//   that has since dropped under the threshold is not filed. No brief is ever
//   written from a remembered number.
//
//   A WIP LIMIT, NOT A RATE LIMIT. Dependabot's `open-pull-requests-limit`
//   defaults to 5 and does not refill until a human merges or closes, so
//   generation self-throttles to review capacity rather than to a clock. A rate
//   limit would keep filing into a backlog nobody is draining. Authored issues
//   carry a label so the open count is a question the tool can ask.
//
// AND THE ONE THIS PROJECT ADDS. Every brief goes through `brief-gate` before it
// is filed - the same gate that ports the server's own boundary parser and now
// refuses a draft with no mechanically checkable criterion. An auto-authored
// brief that cannot be audited would be the worst of both worlds: generated
// work that only its own author can grade.
//
// Usage:
//   node author.mjs              # report what it would file, and why
//   node author.mjs --file       # act, up to the WIP limit

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const L = await import(path.join(DIR, 'loop.mjs'))
const G = await import(path.join(DIR, 'brief-gate.mjs'))
const D = await import(path.join(DIR, 'disjoint.mjs'))
const SE = await import(path.join(DIR, 'stale-escalations.mjs'))

// IMPORT-SAFE. This module ran its production query and called process.exit at
// import time, so importing it hit the live database and killed the importer -
// the calibration harness could not test it and died mid-run trying. A module
// that does work merely by being imported cannot be tested, and cannot be
// reused. Everything below the guard runs only when this file IS the program.
const isMain = process.argv[1] && process.argv[1].endsWith('/author.mjs')


const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REPO = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'
const LABEL = 'queen-authored'
// THE TARGET QUEUE DEPTH, and why it is not simply the worker count.
//
// Four workers at a p50 of 748 s drain about 4 tasks every 12.5 minutes, and
// the chain that refills them fires every 10. A depth of 5 would be exactly
// enough IF every run filed 5 - and no run does. The disjoint selector can only
// file work whose boundary is free, so a round where finished dispatches still
// hold their paths files two, or none.
//
// Measured 2026-09-04: queue 0, running 0, with nine authored issues in flight
// holding paths. The depth was right for the average and wrong for the variance,
// which is the same thing as being wrong.
//
// Two drains' worth plus one, so a lean round is absorbed by the buffer instead
// of by the workers.
const WIP = Number(process.env.AUTHOR_WIP ?? 9)
const THRESHOLD = Number(process.env.AUTHOR_LINE_THRESHOLD ?? 900)
// LOWERED FROM 250, because the bar was set where the fuel ran out.
//
// Measured 2026-09-04: all FORTY of the last authored issues were the same
// thing - replacing box-drawing characters in comments. The swarm ran 4 of 4
// with 100% acceptance and produced nothing but cosmetics. The interleaving
// across signals was working; the other two signals were simply EXHAUSTED, every
// one of their findings already carrying an issue, so the cheapest detector won
// every slot by being the only one with anything fresh.
//
// That is Goodhart in miniature: I made "keep the workers busy" the target and
// got busy workers on the cheapest possible work.
//
// A module of 120 lines whose exports no test names is worth a test. At 250 the
// tree holds 9 such modules and all 9 are filed; at 120 it holds 25. The bar is
// still meaningful - a 20-line helper is not owed a suite - and it is now set by
// what deserves a test rather than by what was easy to leave alone.
const UNTESTED_MIN_LINES = Number(process.env.AUTHOR_UNTESTED_MIN ?? 120)
// Above this an issue is a project, not a task. See the note at the filter.
const UNTESTED_MAX_EXPORTS = Number(process.env.AUTHOR_UNTESTED_MAX_EXPORTS ?? 12)

const sh = (c) => execSync(c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const tryShell = (c) => { try { return sh(c) } catch { return null } }

// Where the swarm is allowed to work. Anything outside this is another agent's
// ground or build output, and a brief naming it would be refused at dispatch.
// TWO NARROWINGS STACKED, and neither was visible because the number was never
// zero.
//
// This was six hand-listed directories under apps/server/src - one app out of
// five - and the listing below used `git ls-tree` WITHOUT `-r`, so only the top
// level of each was ever read. Measured 2026-09-05: the detector saw 107 of the
// 234 .ts files inside its OWN six directories, and none at all in the other
// four apps.
//
// A detector that still returns findings is not a detector that is looking
// everywhere. This is the third time that sentence has been the answer, after
// the L3 corpus and the untested corpus.
const OWNED = (process.env.AUTHOR_LENGTH_ROOTS ||
  'trios/agent-server/apps/server/src trios/agent-server/apps/agent trios/agent-server/apps/eval/src trios/agent-server/packages/shared trios/agent-server/apps/trios-mcp-bridge/src trios/tools')
  .split(/\s+/).filter(Boolean)

// The tree the BEE gets, not the one this machine has.
//
// The first version of this counted the working tree and produced a brief
// saying `queen-tick.ts` is 1889 lines. On `origin/feat/queen-supervisor`, which
// is what a bee clones, the same file is 1792. The local checkout has diverged
// from origin, so every number in an auto-authored brief would have been one the
// worker could not reproduce - and a criterion the worker cannot reproduce is a
// criterion it cannot meet. This is the same "verify against origin, not the
// local checkout" rule this project has already paid for three times; the tool
// that enforces it elsewhere broke it here.
const BASE = process.env.AUTHOR_BASE || 'origin/feat/queen-supervisor'

/** Files over the threshold on the branch a bee actually clones, biggest first. */
export function overlongFiles() {
  const out = []
  const seenLong = new Set()
  let examined = 0
  for (const dir of OWNED) {
    // `-r`, without which only the top level of each directory is read. 127 of
    // 234 files were invisible for want of one flag.
    const listed = tryShell(`git ls-tree -r --name-only ${BASE} ${dir}/`)
    if (!listed) continue
    for (const rel of listed.split('\n').filter(Boolean)) {
      if (seenLong.has(rel)) continue
      seenLong.add(rel)
      const name = rel.slice(rel.lastIndexOf('/') + 1)
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue
      // `git show | wc -l` counts newlines; a file with no trailing newline
      // would read one short, which is why the brief quotes this exact command.
      const count = tryShell(`git show ${BASE}:${rel} | wc -l`)
      if (count === null) continue
      examined++
      const lines = Number(count.trim())
      if (!Number.isFinite(lines) || lines <= THRESHOLD) continue
      const body = tryShell(`git show ${BASE}:${rel}`)
      if (body && isGenerated(rel, body)) continue
      out.push({ rel, name, lines })
    }
  }
  const sorted = out.sort((a, b) => b.lines - a.lines)
  sorted.examined = examined
  return sorted
}

// SIGNAL 2: a module whose exports are named in no test at all.
//
// The naive form of this signal - "no test file of the same name" - reports 144
// of 260 source files and is a lie: `queen-tick.ts` has no `queen-tick.test.ts`
// and is exercised by a dozen `queen-*.test.ts` suites. A brief built on that
// count would accuse working code of being untested, and the bee would find the
// tests and be right to.
//
// The honest form asks whether ANY exported identifier of the file appears
// anywhere in the whole test corpus. That reports 9, and each of the 9 is a
// module of 250+ lines that no test mentions by name. The difference between
// 144 and 9 is the difference between a signal and a grep.
/**
 * Source files that break L3, with the characters they break it with.
 *
 * WHY THIS SIGNAL EXISTS. The backlog starved on 2026-09-04 with the swarm at
 * zero bees of four: `author.mjs` found fourteen real deficits and could file
 * against NONE of them, because every one already had an issue - and those
 * issues were the ones parked at the retry ceiling. Two detectors is not enough
 * variety to feed four workers; the pool empties and the loop looks broken when
 * it has simply run out of things it knows how to notice.
 *
 * L3 is repository law - "Source files ASCII-only" - and it is broken in 86
 * files by 2690 characters, almost all of them box drawing in comment rules
 * (U+2500), em dashes and arrows. That makes it the right kind of fuel:
 *
 *   MEASURABLE   `LC_ALL=C grep -cP '[^\x00-\x7F]' <file>` is the whole test.
 *   DISJOINT     one file per task, so N tasks really do give N workers - the
 *                exact failure that left the fourth slot empty.
 *   RENEWABLE    86 of them, filed a few at a time under the WIP limit.
 *
 * Deliberately narrow: only the server source tree, only files whose non-ASCII
 * is confined to comments, because rewriting a user-facing string is a change of
 * behaviour and not a cleanup. A file with non-ASCII in live code is skipped and
 * said to be skipped.
 */
/**
 * A file the repository GENERATES, which L0 forbids editing.
 *
 * `packages/cdp-protocol` alone is 114 files carrying non-ASCII in comments,
 * every one of them opening with "AUTO-GENERATED from CDP protocol. DO NOT
 * EDIT." Filing cleanup work against them would have been filing 114 tasks that
 * a correct worker must refuse - and L0 is explicit: "Generated files are
 * artifacts. They are not edited. A diff that changes a generated file without
 * changing its .t27 is a defect."
 *
 * Two tests, because either alone is escapable: the path convention, and the
 * marker the generator itself writes at the top.
 */
export function isGenerated(rel, text) {
  if (/(^|\/)(generated|__generated__|node_modules|dist|build)\//.test(rel)) return true
  const head = String(text).split('\n').slice(0, 12).join('\n')
  return /AUTO-?GENERATED|DO NOT EDIT|@generated|Code generated by/i.test(head)
}

export function asciiOffenders() {
  let examinedAscii = 0
  // WIDENED, because a detector with a finite corpus is a detector that stops.
  // The server tree ran down to 4 candidates across all three signals in a
  // night; the same law governs the whole repository, and the rest of it holds
  // roughly 130 more files whose non-ASCII is confined to comments.
  const roots = (process.env.AUTHOR_ASCII_ROOTS ||
    'trios/agent-server/apps trios/agent-server/packages trios/agent-server/scripts trios/tools')
    .split(/\s+/).filter(Boolean)
  const listed = roots
    .map((r) => tryShell(`git ls-tree -r --name-only ${BASE} ${r}/`) || '')
    .join('\n')
  if (!listed.trim()) return []
  const out = []
  const seen = new Set()
  for (const rel of listed.split('\n').filter(Boolean)) {
    if (seen.has(rel)) continue
    seen.add(rel)
    if (!/\.(ts|tsx|mjs)$/.test(rel) || rel.endsWith('.test.ts')) continue
    const text = tryShell(`git show ${BASE}:${rel}`)
    if (!text) continue
    if (isGenerated(rel, text)) continue
    // Counted at the READ, not at the keep. Counting kept files gave
    // "ascii=71/71 seen", a denominator that can never differ from its
    // numerator and therefore says nothing at all - the exact failure the
    // denominator was added to prevent.
    examinedAscii++
    const lines = text.split('\n')
    let inComment = 0
    let bad = 0
    let badInCode = 0
    const chars = new Set()
    for (const raw of lines) {
      const line = raw.trim()
      const isComment = line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')
      const n = [...raw].filter((ch) => ch.charCodeAt(0) > 127)
      if (!n.length) continue
      bad += n.length
      for (const ch of n) chars.add(ch)
      if (isComment) inComment += n.length
      else badInCode += n.length
    }
    if (!bad) continue
    // A string a person reads is not a comment rule. Skipped, and the skip is
    // visible in the report rather than silent.
    if (badInCode > 0) continue
    out.push({
      rel,
      name: rel.slice(rel.lastIndexOf('/') + 1),
      lines: lines.length,
      bad,
      chars: [...chars].slice(0, 8),
    })
  }
  // Worst first: a file with 530 offending characters is a better first task
  // than one with 2, and it is the one a reader is most likely to hit.
  const sortedAscii = out.sort((a, b) => b.bad - a.bad)
  sortedAscii.examined = examinedAscii
  return sortedAscii
}

/** The brief for an L3 cleanup. One file, one mechanical test. */
function asciiBrief(c) {
  const codes = c.chars.map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(', ')
  return `# ${c.rel} breaks L3 with ${c.bad} non-ASCII characters, all of them in comments

Law L3 of this repository reads "Everything is written in English - source,
comments, documentation, issues, commit messages. Source files ASCII-only."

\`${c.rel}\` carries ${c.bad} characters above U+007F across ${c.lines} lines.
Every one of them is inside a comment; the codepoints present are ${codes}.
Most are box drawing used to rule off a comment block, em dashes, and arrows.

Measured on ${BASE} with:

\`\`\`
LC_ALL=C grep -cP '[^\\x00-\\x7F]' ${c.rel}
\`\`\`

## User Scenarios & Testing

### User Story 1 - The file obeys the law it is governed by (P1)

**Given** the file today, **When** the ASCII check runs over it, **Then** it
reports zero offending characters.

### User Story 2 - Nothing a person reads has changed (P1)

**Given** the rewritten file, **When** it is compared with the original, **Then**
only comment characters differ and no string, identifier or expression is
touched.

**Acceptance Scenarios**:
1. **Given** the file after the change, **When** the grep above runs, **Then**
   its output is 0.

## Requirements

- **FR-001**: Every character above U+007F MUST be replaced with an ASCII
  equivalent: box drawing with \`-\`, an em or en dash with \`-\`, an arrow with
  \`->\` or \`<-\`, an ellipsis with \`...\`, and a multiplication sign with \`x\`.
- **FR-002**: No change may fall outside a comment. Strings, identifiers and
  expressions MUST be byte-identical.
- **FR-003**: The file MUST introduce no NEW typecheck error. The repository
  typecheck is red today for 42 unrelated reasons; the demand is that this file
  is not among them.

## Success Criteria

- \`LC_ALL=C grep -cP '[^\\x00-\\x7F]' ${c.rel}\` prints 0, and the raw output is quoted in the report. The command MUST NOT name or enumerate the specific items it counts.
- \`bun run typecheck 2>&1 | grep -c ${c.rel}\` prints 0, and the raw output is quoted. The command MUST NOT name or enumerate the specific items it counts. (The repository typecheck does NOT pass today - 42 pre-existing errors on a clean checkout - so the demand is that THIS file contributes none, not that the tree is green.)
- The report quotes \`git diff --stat\` for the branch, showing exactly one file changed.
- The report quotes one before-and-after comment line, so a reader can see the substitution that was made.

## Boundary

\`${c.rel}\`
`
}

export function untestedModules() {
  // WIDENED, for the same reason the L3 detector was: a detector confined to one
  // directory runs dry, and then the cheapest detector is the only one filing.
  //
  // Measured 2026-09-05:
  //
  //   apps/server   447 ts files, 161 tests
  //   apps/agent    457 ts files,  18 tests
  //   apps/eval     115 ts files,  27 tests
  //
  // `apps/agent` is the same size as the server and has a ninth of the tests.
  // Keeping the detector pointed only at `apps/server` was not a judgement about
  // where tests matter; it was where I happened to start.
  //
  // The corpus of EXISTING tests is gathered from the whole tree, because a
  // symbol named by a test in another app is still a symbol somebody named.
  const listed = tryShell(`git ls-tree -r --name-only ${BASE} trios/agent-server/`)
  if (!listed) return []
  const testFiles = listed.split('\n').filter((f) => /\.test\.tsx?$/.test(f))
  let corpus = ''
  for (const t of testFiles) {
    const body = tryShell(`git show ${BASE}:${t}`)
    if (body) corpus += body + '\n'
  }
  // An empty corpus would make every module look untested. Refuse rather than
  // report - a signal that cannot read its own denominator is not a signal.
  if (corpus.length < 10000) return []

  const out = []
  let examinedUntested = 0
  const roots = (process.env.AUTHOR_UNTESTED_ROOTS ||
    'trios/agent-server/apps/server/src trios/agent-server/apps/agent trios/agent-server/apps/eval/src trios/agent-server/packages/shared trios/agent-server/apps/trios-mcp-bridge/src')
    .split(/\s+/).filter(Boolean)
  const srcList = roots.map((r) => tryShell(`git ls-tree -r --name-only ${BASE} ${r}/`) || '').join('\n')
  const seenSrc = new Set()
  for (const rel of (srcList || '').split('\n').filter(Boolean)) {
    if (seenSrc.has(rel)) continue
    seenSrc.add(rel)
    if (!/\.tsx?$/.test(rel) || /\.test\.tsx?$/.test(rel)) continue
    const text = tryShell(`git show ${BASE}:${rel}`)
    if (!text) continue
    examinedUntested++
    // The same refusal the L3 detector carries: L0 says a generated file is an
    // artifact and is not edited, and a test written against one would be a test
    // of the generator's output rather than of anybody's code.
    if (isGenerated(rel, text)) continue
    const lines = text.split('\n').length
    if (lines < UNTESTED_MIN_LINES) continue
    const exports = [...text.matchAll(/export (?:async )?(?:function|const|class) ([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])
    if (!exports.length) continue
    if (exports.some((id) => new RegExp('\\b' + id + '\\b').test(corpus))) continue
    // AN UPPER BOUND ON EXPORTS, because a task has to be finishable.
    //
    // Widening this detector to the whole tree immediately produced
    // `prompt-input.tsx exports 40 symbols and no test names any of them`. A
    // brief demanding all forty be exercised or excused is a brief no honest
    // work can satisfy - the same defect as the typecheck criterion that had to
    // be rewritten across twelve issues, arriving from the size of the task
    // rather than from the wording.
    //
    // A module with that many exports is a barrel or a component library, not a
    // unit. It is skipped, and the skip is visible in the report.
    if (exports.length > UNTESTED_MAX_EXPORTS) continue
    out.push({ rel, name: rel.slice(rel.lastIndexOf('/') + 1), lines, exports })
  }
  const sortedUntested = out.sort((a, b) => b.lines - a.lines)
  sortedUntested.examined = examinedUntested
  return sortedUntested
}

const ident = (name) => 'split' + name.replace(/\.ts$/, '').split(/[-.]/).map((p) => p[0].toUpperCase() + p.slice(1)).join('')

function brief(c) {
  const id = ident(c.name)
  const surveyPath = `trios/docs/split/${c.name.replace(/\.ts$/, '')}-survey.md`
  const toolPath = `trios/tools/${c.name.replace(/\.ts$/, '')}-split-survey.mjs`
  return `# ${c.rel} is ${c.lines} lines, and nothing has ever said what is inside it

Counted now, not remembered:

\`\`\`
$ git show origin/feat/queen-supervisor:${c.rel} | wc -l
${c.lines}
\`\`\`

Counted on \`origin/feat/queen-supervisor\`, which is the tree a bee clones - not
on a local checkout, which has diverged from it.

The repository's own pre-commit hook already objects. Every commit touching this
file prints \`Warning: ${c.rel} has ${c.lines} lines (threshold: 400)\` and then
commits anyway, so the warning has been true for a long time and has changed
nothing. A warning that never blocks is a warning nobody reads.

This task does NOT split the file. Splitting a ${c.lines}-line module that the
supervisor depends on, without first knowing what is in it, is how a refactor
becomes an outage. It produces the survey that a split would have to be argued
from: what the file actually contains, which parts have no dependency on the
rest, and which single extraction would remove the most lines for the least
risk.

The judgement of whether to split, and when, stays with a person. This makes
that judgement possible.

## User Scenarios & Testing

### User Story 1 - The file's contents are enumerated, not described (P1)

**Acceptance Scenarios**:
1. **Given** the file,
   **When** the survey runs,
   **Then** it lists every top-level declaration - exported and not - with its
   line range and its length, sorted by length descending.
2. **Given** those declarations,
   **When** the survey runs,
   **Then** each one names the other top-level declarations in this file that it
   references, so a reader can see what would travel with it.
3. **Given** a declaration that references nothing else in the file,
   **When** the survey runs,
   **Then** it is marked as independently extractable, and the totals count how
   many lines those account for.
4. **Given** two runs with no edit between them,
   **When** their outputs are compared,
   **Then** they are byte-identical.

### User Story 2 - The recommendation is one move, with its cost (P2)

**Acceptance Scenarios**:
1. **Given** the survey,
   **When** its closing section is read,
   **Then** it names ONE extraction - the largest independently extractable
   group - with the lines it would remove, the declarations that move, and every
   call site outside this file that would need its import changed.
2. **Given** that no group is independently extractable,
   **When** the closing section is read,
   **Then** it says so plainly rather than proposing a split that would drag the
   whole file behind it.

## Requirements

- **FR-001**: The survey MUST NOT modify \`${c.rel}\` or any other source file. It reads and reports.
- **FR-002**: Declarations MUST be found by parsing the source text, not from a list written into the tool, so the survey does not go stale the moment the file changes.
- **FR-003**: A declaration the parser cannot classify MUST be reported as \`unparsed\` with its line, and counted separately. A survey that silently drops what it did not understand is worse than a short one.
- **FR-004**: Line counts MUST be measured during the run. No number in the output may be copied from this issue.
- **FR-005**: It MUST run under \`node\` with the Node standard library only, and MUST NOT invoke a TypeScript compiler, \`make\`, or any build.

## Success Criteria

- \`${toolPath}\` exists and runs as \`node ${toolPath}\`.
- Its output lists every top-level declaration in \`${c.rel}\` with a line range, and the count of declarations it found is printed; the run is quoted in the bee's closing report.
- The total of all declaration line ranges plus the unparsed count accounts for the file, and the run prints both that total and the file's own line count so a reader can see they agree.
- Two consecutive runs produce identical bytes; the comparison is quoted.
- \`${surveyPath}\` carries the table and the single recommended extraction with its call sites, or the explicit statement that none is independently extractable.
- The tool exports a function named \`${id}\`; that identifier appears nowhere in the tree today.

## Boundary

\`${toolPath}\`
\`${surveyPath}\`
`
}

const testIdent = (name) => name.replace(/\.ts$/, '').split(/[-.]/).map((p, i) => i ? p[0].toUpperCase() + p.slice(1) : p).join('') + 'Contract'

function untestedBrief(c) {
  const id = testIdent(c.name)
  // THE TEST GOES WHERE THAT APP KEEPS ITS TESTS. Sending an apps/agent test to
  // apps/server/tests would put it in a suite that does not run it and a
  // directory its imports cannot reach.
  const base = c.name.replace(/\.tsx?$/, '')
  const testPath = c.rel.startsWith('trios/agent-server/apps/server/')
    ? `trios/agent-server/apps/server/tests/api/${base}.test.ts`
    : `${c.rel.replace(/\/[^/]+$/, '')}/${base}.test.ts`
  const shown = c.exports.slice(0, 6)
  return `# ${c.rel} exports ${c.exports.length === 1 ? 'one symbol' : c.exports.length + ' symbols'} and no test names any of them

Measured on \`origin/feat/queen-supervisor\`, the tree a bee clones:

\`\`\`
$ git show origin/feat/queen-supervisor:${c.rel} | wc -l
${c.lines}

exports: ${shown.join(', ')}${c.exports.length > shown.length ? ', ...' : ''}
searched: every *.test.ts under apps/server/tests, ${'${}'.replace('${}','')}concatenated
found:    none of these identifiers appears anywhere in that corpus
\`\`\`

The weak version of this claim would be "there is no \`${c.name.replace(/\.ts$/, '')}.test.ts\`",
and it would be worthless: 144 of 260 source files have no test of the same name,
and most of them are covered perfectly well by suites named after something else.
\`queen-tick.ts\` is exercised by a dozen \`queen-*.test.ts\` files and has no test
of its own name. So the question asked here is the stronger one - whether any
exported identifier of this module is mentioned anywhere in the test corpus at
all - and by that measure only nine modules in the repository qualify. This is
one of them.

Untested is not the same as broken. This asks for the first suite, not a rewrite:
the behaviour that already exists, pinned, so the next change to this file has
something to fail against.

## User Scenarios & Testing

### User Story 1 - The module's contract is pinned as it stands today (P1)

**Acceptance Scenarios**:
1. **Given** each exported symbol,
   **When** the suite runs,
   **Then** at least one assertion exercises it, and the suite names the symbol
   it is covering so a reader can map assertions to exports.
2. **Given** the module's behaviour as it is today,
   **When** the suite runs against the unmodified source,
   **Then** it passes. A first suite that requires changing the subject is a
   redesign wearing a test's clothes.
3. **Given** a deliberately broken copy of the subject,
   **When** the suite runs against it,
   **Then** it fails. A suite never shown failing has not been tested.
4. **Given** the suite,
   **When** it runs,
   **Then** it needs no network, no database and no container.

### User Story 2 - What could not be pinned is named (P2)

**Acceptance Scenarios**:
1. **Given** an export whose behaviour cannot be exercised without a live
   dependency,
   **When** the suite is read,
   **Then** that export is listed in a comment with the dependency that blocked
   it, rather than silently omitted. An untested export inside a file that now
   looks tested is worse than one in a file that plainly is not.

## Requirements

- **FR-001**: The subject MUST NOT be modified. If a symbol cannot be tested without changing it, say so in the comment required above and leave it.
- **FR-002**: The suite MUST run under \`bun test\` in an existing group and MUST NOT require a database, a container or the network.
- **FR-003**: Every assertion MUST test observable behaviour, not the shape of the implementation. A test that asserts a function calls another function pins the code rather than the contract.
- **FR-004**: The bee MUST demonstrate the suite failing against a deliberately broken copy before showing it passing, and quote both runs.
- **FR-005**: No existing test may be modified or weakened.

## Success Criteria

- \`bun test ${testPath}\` passes, and its raw stdout is quoted in the report, unedited and unsummarised.
- Every one of the ${c.exports.length} exported symbols is either exercised by an assertion or listed in a comment with the dependency that prevented it; the report quotes \`grep -c 'it(' ${testPath}\` and its raw output, and the two counts sum to ${c.exports.length}. The command MUST NOT name or enumerate the specific items it counts.
- A failing run against a deliberately broken copy of the subject is quoted, raw and unedited, alongside the passing one - a suite never shown failing has not been tested.
- \`git diff --name-only\` is quoted raw and does not list \`${c.rel}\`.
- The suite registers under a describe named \`${id}\`; that identifier appears nowhere in the tree today.

## Boundary

\`${testPath}\`
`
}

// ------------------------------------------------------------------ the gate

/**
 * The QUEUE: authored issues nobody has started yet.
 *
 * THE CATEGORY ERROR THIS FIXES. The limit was applied to OPEN issues, which is
 * the backlog column. Kanban limits work IN PROGRESS and never the backlog, and
 * Dependabot's `open-pull-requests-limit` - the model this was copied from -
 * exists to protect a HUMAN reviewer's capacity. Measured here 2026-09-04: the
 * review takes p50 0.8 seconds. There is no human to protect.
 *
 * The consequence was exact. Five authored issues were open, so the author
 * refused to file: "at the WIP limit". Four of the five had already been
 * dispatched and were sitting in sendBack or wait - work in progress, not queue.
 * The real queue depth was ONE, and the swarm ran at 14% of capacity.
 *
 * Little's Law says what the target should be: with four workers and a measured
 * p50 bee runtime of 792 s, keeping them busy needs arrivals at roughly 18 an
 * hour, and the author fires about four times an hour. So the queue must hold
 * enough for a worker to always find something - hence a depth of workers + 1,
 * not a count of everything that happens to be open.
 *
 * An issue that has a dispatch row - running, sent back, waiting or escalated -
 * is IN PROGRESS. It is not queue and must not be counted as queue.
 *
 * Returns null when it cannot tell, and null still refuses to file: a count that
 * failed must never read as zero and lift the limit.
 */
function unstartedAuthored() {
  const raw = tryShell(`gh issue list --repo ${REPO} --state open --label ${LABEL} --limit 100 --json number -q '.[].number'`)
  if (raw === null) return null
  const open = raw.split('\n').filter(Boolean)
  if (!open.length) return { queue: 0, open: 0, inProgress: 0 }

  const js = "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});" +
    `p.query("select distinct issue from queen_dispatch where issue in (${open.join(',')})")` +
    ".then(r=>{console.log(JSON.stringify(r.rows)); return p.end()}).catch(e=>{console.log('ERR '+e.message); process.exit(1)})"
  let started
  try {
    const out = SE.remote(js)
    const line = String(out ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('['))
    if (!line) return null
    started = new Set(JSON.parse(line).map((r) => String(r.issue)))
  } catch { return null }

  const queue = open.filter((n) => !started.has(n))
  return { queue: queue.length, open: open.length, inProgress: open.length - queue.length, numbers: queue }
}

// BOTH SIGNALS, INTERLEAVED. Taking one signal to exhaustion and then stopping
// is how a generator looks productive for an hour and then starves. Interleaving
// also spreads the work across different parts of the tree, which matters here
// because a boundary held by a parked dispatch fences everything near it.
if (!isMain) { /* imported for calibration or reuse: do nothing */ } else {
const bySignal = [
  { kind: 'length', items: overlongFiles(), brief, title: (c) => `${c.rel} is ${c.lines} lines, and nothing has ever said what is inside it` },
  { kind: 'untested', items: untestedModules(), brief: untestedBrief, title: (c) => `${c.rel} exports ${c.exports.length === 1 ? 'one symbol' : c.exports.length + ' symbols'} and no test names any of them` },
  // Third detector, added because two were not enough variety to feed four
  // workers: the pool emptied and the swarm sat idle while the loop had simply
  // run out of things it knew how to notice. One file per task, so N tasks
  // really do give N workers.
  { kind: 'ascii', items: asciiOffenders(), brief: asciiBrief, title: (c) => `${c.rel} breaks L3 with ${c.bad} non-ASCII characters, all of them in comments` },
]

const interleaved = []
for (let i = 0; ; i++) {
  const round = bySignal.filter((s) => s.items[i]).map((s) => ({ ...s, c: s.items[i] }))
  if (!round.length) break
  interleaved.push(...round)
}

const q = unstartedAuthored()
const open = q === null ? null : q.queue

// REPORT THE DENOMINATOR.
//
// Every one of the three detectors was found narrowed, and each time the tell
// was missing because the number it produced was never zero: the L3 corpus was
// one directory of five, the untested corpus was one app of five, and the length
// detector read only the top level of its own six directories - 107 of 234
// files - for want of a `-r`.
//
// A count of findings cannot show that. A count of findings against the number
// of files LOOKED AT can, and costs one number per detector.
console.log(`signals: ${bySignal.map((s) => {
  const seen = s.items.examined
  return `${s.kind}=${s.items.length}${seen !== undefined ? `/${seen} seen` : ''}`
}).join('  ')}`)
console.log(`queue depth target ${WIP} - counted on UNSTARTED issues, not open ones`)
if (open === null) {
  console.error(`could not measure the ${LABEL} queue - refusing to file, because a failed count would read as zero and lift the limit`)
  process.exit(1)
}
console.log(`${LABEL} issues: ${q.open} open, ${q.inProgress} already dispatched, ${q.queue} still QUEUE`)
console.log(`queue depth target ${WIP}   room: ${Math.max(0, WIP - open)}\n`)

// An issue already filed for the same subject must not be filed again. The
// title carries the path, so the path is the key.
// IS ANYONE DRAINING THIS? A WIP limit bounds the QUEUE, not the direction.
//
// Five open authored issues means "wait" whether the swarm is chewing through
// them or has not touched one in a day. Those are different situations and only
// one of them should ever be refilled. So before filing, ask how many authored
// issues have CLOSED recently: if the answer is zero while some have been open
// past the stall window, the backlog is not being drained and filing more would
// be filing into a hole.
//
// This is the failure the Dependabot rule does not cover, because a human
// merging PRs is a drain you can assume; an automated reviewer that has quietly
// stopped is not.
// The guard still reads the OLDEST OPEN issue rather than the oldest unstarted
// one, and that is deliberate. An issue dispatched six hours ago and still not
// closed is exactly as much evidence that the drain has stopped as one nobody
// ever started; the question this asks is "is anything finishing", not "is
// anything starting". The queue depth answers the second question, above.
const STALL_H = Number(process.env.AUTHOR_STALL_H ?? 6)
const closedRecently = tryShell(
  `gh issue list --repo ${REPO} --state closed --label ${LABEL} --limit 50 --search "closed:>=$(date -u -v-${STALL_H}H +%Y-%m-%dT%H:%M:%SZ)" --json number -q 'length'`,
)
const oldestOpenH = (() => {
  const iso = tryShell(`gh issue list --repo ${REPO} --state open --label ${LABEL} --limit 50 --json createdAt -q '[.[].createdAt] | sort | .[0] // empty'`)
  return iso ? (Date.now() - Date.parse(iso)) / 3600000 : 0
})()

if (closedRecently !== null && Number(closedRecently) === 0 && oldestOpenH > STALL_H && open > 0) {
  console.error(
    `STALLED: ${q.open} authored issue(s) open (${q.queue} still queue, ${q.inProgress} dispatched), ` +
    `the oldest for ${oldestOpenH.toFixed(1)} h, and none closed in the last ${STALL_H} h. ` +
    `Filing more would be filing into a backlog nobody is draining. Refusing.`,
  )
  L.append({ kind: 'author-stalled', open: q.open, queue: q.queue, inProgress: q.inProgress, oldestOpenH: Number(oldestOpenH.toFixed(1)), closedRecently: 0 })
  process.exit(3)
}
console.log(`drain: ${closedRecently ?? '?'} authored issue(s) closed in the last ${STALL_H} h, oldest open ${oldestOpenH.toFixed(1)} h\n`)

/**
 * The paths live dispatches already own.
 *
 * Read from the service, and an unreadable answer returns an EMPTY set rather
 * than throwing - the author still files, it just cannot avoid a collision it
 * could not see. Refusing to file because the fence could not be read would
 * turn a transient network fault into a starved swarm, which is the louder
 * failure and the wrong one here.
 */
function heldPaths() {
  const js = "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});" +
    "p.query(\"select owned_paths from queen_dispatch where owned_paths is not null and jsonb_array_length(owned_paths) > 0 and review_state is distinct from 'accept' and dispatched_at > now() - interval '7 days'\")" +
    ".then(r=>{console.log(JSON.stringify(r.rows)); return p.end()}).catch(e=>{console.log('ERR '+e.message); process.exit(1)})"
  let raw
  try { raw = SE.remote(js) } catch { return [] }
  const line = String(raw ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('['))
  if (!line) return []
  try {
    return JSON.parse(line).flatMap((r) => (r.owned_paths || []).map(D.normalize)).filter(Boolean)
  } catch { return [] }
}

const existingTitles = tryShell(`gh issue list --repo ${REPO} --state all --label ${LABEL} --limit 200 --json title -q '.[].title'`) || ''
const already = (c) => existingTitles.split('\n').some((line) => line.includes(c.rel))

const fresh = interleaved.filter((s) => !already(s.c))
interleaved.forEach((s) => console.log(`   ${already(s.c) ? '..' : '->'} ${s.kind.padEnd(9)} ${String(s.c.lines).padStart(5)}  ${s.c.rel}`))

const room = Math.max(0, WIP - open)

// FILING N TASKS DOES NOT GIVE YOU N WORKERS.
//
// `fresh.slice(0, room)` took candidates in the order they were measured and
// never asked whether they could run side by side. Measured 2026-09-04: four
// issues were filed, two of them named
// `trios/agent-server/apps/server/src/api/services/queen-tick.ts`, and the
// scheduler correctly refused the second with `fileConflict` - so the fourth
// worker slot stayed empty while the backlog looked healthy.
//
// The conflict is a property of the WORK, so it is settled here, where the work
// is created, rather than at dispatch. That is what Dependabot's grouping, Nx's
// file-keyed task graph and Kubernetes anti-affinity all do: tell the scheduler
// only about things that can actually coexist.
const withPaths = fresh.map((s) => ({ ...s, paths: G.boundaryPathsOf(s.brief(s.c)) || [] }))
const held = heldPaths()
// NO DETECTOR MAY TAKE MORE THAN HALF A ROUND.
//
// Insurance against the failure above returning by another route. A corpus of
// 111 files and one of 25 are not equally urgent, and the larger one must not be
// able to fill every slot simply by being larger. Half a round leaves the mix
// visible in `tri mix` rather than requiring anyone to notice a monoculture
// forty issues later.
const QUOTA = Math.max(1, Math.ceil(room / 2))
const perKind = new Map()
const quotaFiltered = []
const overQuota = []
for (const s of withPaths) {
  const n = perKind.get(s.kind) ?? 0
  if (n >= QUOTA) { overQuota.push({ ...s, why: `${s.kind} already has ${QUOTA} of this round - one detector may not take them all` }); continue }
  perKind.set(s.kind, n + 1)
  quotaFiltered.push(s)
}
const { taken: take, setAside: collided } = D.disjointBatch(quotaFiltered, held, room)
const setAside = [...collided, ...overQuota]
if (held.length) console.log(`\nthe swarm already holds ${held.length} path(s); a candidate touching one of them is not filed`)
for (const s of setAside) console.log(`   x  ${s.kind.padEnd(9)} ${s.c.rel}  -  ${s.why}`)
console.log(`\nnot yet filed: ${fresh.length}   would file ${take.length}`)

if (!process.argv.includes('--file')) { console.log('\nreport only. re-run with --file to act.'); process.exit(0) }
if (!take.length) { console.log('\nnothing to file - at the WIP limit, or every subject already has an issue'); process.exit(0) }

let filed = 0
for (const s of take) {
  const body = s.brief(s.c)
  const tmp = path.join('/tmp', `authored-${s.kind}-${s.c.name}.md`)
  fs.writeFileSync(tmp, body)
  // The gate is not advisory. A draft it refuses is not filed, and the refusal
  // is printed rather than swallowed.
  try {
    execSync(`node ${path.join(DIR, 'brief-gate.mjs')} ${tmp}`, { cwd: ROOT, stdio: 'pipe' })
  } catch (e) {
    console.log(`REFUSED by the gate: ${s.kind} ${s.c.rel}`)
    console.log(String(e.stdout || '').split('\n').filter((l) => l.includes('!!')).join('\n'))
    continue
  }
  const url = tryShell(`gh issue create --repo ${REPO} --title ${L.shq(s.title(s.c))} --body-file ${tmp} --label ${LABEL}`)
  if (url) { console.log(`filed ${url}`); filed++ } else { console.log(`FAILED to file ${s.c.rel}`) }
}
console.log(`\nfiled ${filed}`)
L.append({ kind: 'authored', filed, signals: Object.fromEntries(bySignal.map((s) => [s.kind, s.items.length])), open, wip: WIP })
}
