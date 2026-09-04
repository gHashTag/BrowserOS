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
const WIP = Number(process.env.AUTHOR_WIP ?? 5)
const THRESHOLD = Number(process.env.AUTHOR_LINE_THRESHOLD ?? 900)
const UNTESTED_MIN_LINES = Number(process.env.AUTHOR_UNTESTED_MIN ?? 250)

const sh = (c) => execSync(c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const tryShell = (c) => { try { return sh(c) } catch { return null } }

// Where the swarm is allowed to work. Anything outside this is another agent's
// ground or build output, and a brief naming it would be refused at dispatch.
const OWNED = [
  'trios/agent-server/apps/server/src/api/services',
  'trios/agent-server/apps/server/src/api/routes',
  'trios/agent-server/apps/server/src/agent',
  'trios/agent-server/apps/server/src/tools',
  'trios/agent-server/apps/server/src/browser',
  'trios/agent-server/apps/server/src/lib',
]

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
  for (const dir of OWNED) {
    const listed = tryShell(`git ls-tree --name-only ${BASE} ${dir}/`)
    if (!listed) continue
    for (const rel of listed.split('\n').filter(Boolean)) {
      const name = rel.slice(rel.lastIndexOf('/') + 1)
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
      // `git show | wc -l` counts newlines; a file with no trailing newline
      // would read one short, which is why the brief quotes this exact command.
      const count = tryShell(`git show ${BASE}:${rel} | wc -l`)
      if (count === null) continue
      const lines = Number(count.trim())
      if (!Number.isFinite(lines) || lines <= THRESHOLD) continue
      out.push({ rel, name, lines })
    }
  }
  return out.sort((a, b) => b.lines - a.lines)
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
export function asciiOffenders() {
  const listed = tryShell(`git ls-tree -r --name-only ${BASE} trios/agent-server/apps/server/src/`)
  if (!listed) return []
  const out = []
  for (const rel of listed.split('\n').filter(Boolean)) {
    if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue
    const text = tryShell(`git show ${BASE}:${rel}`)
    if (!text) continue
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
  return out.sort((a, b) => b.bad - a.bad)
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
- **FR-003**: The file MUST still typecheck and its existing tests MUST still
  pass.

## Success Criteria

- \`LC_ALL=C grep -cP '[^\\x00-\\x7F]' ${c.rel}\` prints 0, and the raw output is quoted in the report. The command MUST NOT name or enumerate the specific items it counts.
- \`bun run typecheck\` passes from \`trios/agent-server\`, and its raw stdout is quoted.
- The report quotes \`git diff --stat\` for the branch, showing exactly one file changed.
- The report quotes one before-and-after comment line, so a reader can see the substitution that was made.

## Boundary

\`${c.rel}\`
`
}

export function untestedModules() {
  const listed = tryShell(`git ls-tree -r --name-only ${BASE} trios/agent-server/apps/server/tests/`)
  if (!listed) return []
  const testFiles = listed.split('\n').filter((f) => f.endsWith('.test.ts'))
  let corpus = ''
  for (const t of testFiles) {
    const body = tryShell(`git show ${BASE}:${t}`)
    if (body) corpus += body + '\n'
  }
  // An empty corpus would make every module look untested. Refuse rather than
  // report - a signal that cannot read its own denominator is not a signal.
  if (corpus.length < 10000) return []

  const out = []
  const srcList = tryShell(`git ls-tree -r --name-only ${BASE} trios/agent-server/apps/server/src/`)
  for (const rel of (srcList || '').split('\n').filter(Boolean)) {
    if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue
    const text = tryShell(`git show ${BASE}:${rel}`)
    if (!text) continue
    const lines = text.split('\n').length
    if (lines < UNTESTED_MIN_LINES) continue
    const exports = [...text.matchAll(/export (?:async )?(?:function|const|class) ([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])
    if (!exports.length) continue
    if (exports.some((id) => new RegExp('\\b' + id + '\\b').test(corpus))) continue
    out.push({ rel, name: rel.slice(rel.lastIndexOf('/') + 1), lines, exports })
  }
  return out.sort((a, b) => b.lines - a.lines)
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
  const testPath = `trios/agent-server/apps/server/tests/api/${c.name.replace(/\.ts$/, '')}.test.ts`
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

- \`${testPath}\` exists and runs under \`bun test\`.
- Every one of the ${c.exports.length} exported symbols is either exercised by an assertion or listed in a comment with the dependency that prevented it; the count of each is printed in the bee's closing report and the two sum to ${c.exports.length}.
- The passing run is quoted, and so is a failing run against a broken copy of the subject.
- \`git diff --name-only\` shows the subject file unchanged.
- The suite registers under a describe named \`${id}\`; that identifier appears nowhere in the tree today.

## Boundary

\`${testPath}\`
`
}

// ------------------------------------------------------------------ the gate

function openAuthored() {
  const raw = tryShell(`gh issue list --repo ${REPO} --state open --label ${LABEL} --limit 100 --json number -q 'length'`)
  // A failed count must not read as zero, or the WIP limit silently lifts.
  return raw === null ? null : Number(raw)
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

const open = openAuthored()

console.log(`signals: ${bySignal.map((s) => `${s.kind}=${s.items.length}`).join('  ')}`)
console.log(`WIP limit ${WIP} open '${LABEL}' issues`)
if (open === null) {
  console.error(`could not count open ${LABEL} issues - refusing to file, because a failed count would read as zero and lift the limit`)
  process.exit(1)
}
console.log(`open ${LABEL} issues: ${open}   room: ${Math.max(0, WIP - open)}\n`)

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
    `STALLED: ${open} authored issue(s) open, the oldest for ${oldestOpenH.toFixed(1)} h, ` +
    `and none closed in the last ${STALL_H} h. Filing more would be filing into a backlog ` +
    `nobody is draining. Refusing.`,
  )
  L.append({ kind: 'author-stalled', open, oldestOpenH: Number(oldestOpenH.toFixed(1)), closedRecently: 0 })
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
const { taken: take, setAside } = D.disjointBatch(withPaths, held, room)
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
