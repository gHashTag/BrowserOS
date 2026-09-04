#!/usr/bin/env node
// Calibration for the loop's own instruments.
//
// WHY THIS AND NOT ANOTHER FEATURE. Twenty lessons are recorded in this loop's
// state and the same shape runs through most of them: a tool of mine reported
// success without doing its job.
//
//   reap        carried a multi-line remote script that had never been executed
//   push-work   reported "0 branches with work" against a container holding 118
//   author      measured the local tree and wrote a number no bee could reproduce
//   snapshot    rendered "not measured" as a fall to zero, in green
//   brief-gate  rejected a well-formed brief over a phrasing difference
//
// Every one would have been caught by a case that plants a known defect and
// asserts the tool notices. So the rule here is the one this repository already
// applies to bees: **a checker that has never been shown FAILING has not been
// tested**. Each case below therefore proves the negative first.
//
// Nothing here touches the network, the container or the database. A calibration
// run that needs production is a calibration run that will be skipped.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const L = await import(path.join(DIR, 'loop.mjs'))
const G = await import(path.join(DIR, 'brief-gate.mjs'))
const JP = await import(path.join(DIR, 'judge-packet.mjs'))
const TR = await import(path.join(DIR, 'trend.mjs'))
const CLK = await import(path.join(DIR, 'clocks.mjs'))
const FLD = await import(path.join(DIR, 'fields.mjs'))
const SE = await import(path.join(DIR, 'stale-escalations.mjs'))
const D = await import(path.join(DIR, 'disjoint.mjs'))
const A = await import(path.join(DIR, 'author.mjs'))

let pass = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ok    ${name}`)
  } catch (e) {
    failures.push(`${name}: ${e.message}`)
    console.log(`  FAIL  ${name}`)
    console.log(`          ${String(e.message).slice(0, 140)}`)
  }
}

/**
 * A source file with its comments removed.
 *
 * THREE TIMES IN ONE NIGHT a check of mine matched its own documentation: it
 * counted "evidence:" inside a printing block, it found "--delete-branch" in a
 * comment that said NOT to use it, and it found "also true" in a comment
 * quoting the behaviour that had just been removed. Each time the code was
 * right and the test was reading prose.
 *
 * A scan that asks "does this file contain X" must ask it of the CODE. Every
 * such check goes through here now, so the class is closed rather than fixed
 * three times.
 */
const codeOf = (file) =>
  fs.readFileSync(path.join(DIR, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
}

const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const fsRequireJudge = () => JP
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-selftest-'))

// GENERATED PER RUN, and it has to be.
//
// The fixture used a fixed name, and once this file was committed that name
// existed in the tree - five times - so brief-gate did exactly its job and
// refused the draft for promising an identifier that is already there. The
// fixture falsified its own premise by being saved.
//
// A fixture asserting "this appears nowhere" must mint a name that cannot have
// been written down before it ran.
const ABSENT_ID = `absentFn${process.pid}${Date.now().toString(36)}`

// ---------------------------------------------------------------------- shq
// The bug it exists to stop: execSync passes through the local /bin/sh, so a
// double-quoted payload has $1, $base and $(...) expanded HERE. Two wrong
// diagnoses came from that. The proof is that a shell round-trip returns the
// text unchanged.
console.log('\nshq - the local shell must not touch the payload')

check('a $1 survives', () => {
  const out = execSync(`printf %s ${L.shq('any($1)')}`, { encoding: 'utf8' })
  eq(out, 'any($1)', 'payload')
})

check('a command substitution survives unexecuted', () => {
  const out = execSync(`printf %s ${L.shq('x=$(whoami)')}`, { encoding: 'utf8' })
  eq(out, 'x=$(whoami)', 'payload')
})

check('an embedded single quote survives', () => {
  const s = `it's 'quoted'`
  const out = execSync(`printf %s ${L.shq(s)}`, { encoding: 'utf8' })
  eq(out, s, 'payload')
})

check('a newline survives, where JSON.stringify would have broken it', () => {
  const out = execSync(`printf %s ${L.shq('a\nb')}`, { encoding: 'utf8' })
  eq(out, 'a\nb', 'payload')
})

// --------------------------------------------------------------- brief-gate
// Proves the negative first: a draft missing the thing must be REFUSED.
console.log('\nbrief-gate - must refuse what it exists to refuse')

const GOOD = `# A real defect, measured

\`\`\`
$ wc -l x
1 x
\`\`\`

## User Scenarios & Testing

### User Story 1 - It happens (P1)

**Acceptance Scenarios**:
1. **Given** a thing, **When** it runs, **Then** it works.

## Requirements

- **FR-001**: The tool MUST do the thing.

## Success Criteria

- The tool exports a function named \`${ABSENT_ID}\`; that identifier appears nowhere in the tree today.

## Boundary

\`trios/tools/selftest-fixture.mjs\`
`

const draft = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p }

check('a well-formed draft passes', () => {
  const r = G.gate(draft('good.md', GOOD))
  if (r.problems.length) throw new Error(`refused a good draft: ${r.problems.join('; ')}`)
})

check('a draft with NO boundary is refused', () => {
  const r = G.gate(draft('nb.md', GOOD.replace(/## Boundary[\s\S]*$/, '')))
  if (!r.problems.some((p) => /Boundary|EMPTY boundary/.test(p))) throw new Error('accepted a draft with no boundary')
})

check('a draft with no mechanically checkable criterion is refused', () => {
  const r = G.gate(draft('nc.md', GOOD.replace(/- The tool exports[^\n]*\n/, '- It works.\n')))
  if (!r.problems.some((p) => /mechanically checkable/.test(p))) throw new Error('accepted a draft nobody can audit')
})

check('a draft whose criteria need an unavailable tool is refused', () => {
  const r = G.gate(draft('mk.md', GOOD.replace('- The tool exports', '- Run `make check` and quote it.\n- The tool exports')))
  if (!r.problems.some((p) => /make/.test(p))) throw new Error('accepted criteria the worker image cannot run')
})

check('a non-ASCII draft is refused (law L3)', () => {
  const r = G.gate(draft('ru.md', GOOD.replace('A real defect', 'A real defect -проверка')))
  if (!r.problems.some((p) => /non-ASCII/.test(p))) throw new Error('accepted non-ASCII')
})

check('a paragraph AFTER the boundary is caught as garbage paths', () => {
  // The server parser takes every line after the heading, so trailing prose
  // becomes boundary entries. This happened once for real.
  const r = G.gate(draft('trail.md', GOOD + '\nSee also docs/notes.md for context.\n'))
  if (r.boundary.length <= 1) throw new Error('parser did not pick up the trailing line, so this case no longer proves anything')
})

// ---------------------------------------------------------------- the lock
console.log('\nthe loop lock - must block a second holder')

check('a second acquire is refused while the first is fresh', () => {
  // Run against the real lock only if it is free, so a live iteration is never
  // disturbed. If it is held, that IS the assertion.
  const held = L.lockHolder()
  if (held) {
    const second = L.acquire('selftest')
    // Put back whatever we took. This test ran `acquire` and, when it
    // unexpectedly succeeded, walked away owning a live iteration's lock -
    // rewriting the holder to "selftest" and leaving it there. A check that
    // damages the thing it is checking is worse than no check.
    if (second.ok) {
      L.release()
      throw new Error(`took a lock reported as held by ${held.holder}`)
    }
    return
  }
  const first = L.acquire('selftest-a')
  if (!first.ok) throw new Error('could not take a free lock')
  const second = L.acquire('selftest-b')
  L.release()
  if (second.ok) throw new Error('a second acquire succeeded while the first was fresh')
})

// -------------------------------------------------------- the reaper guard
console.log('\nreap - a configuration that would free nothing must be an error')

check('REAP_LOW >= REAP_HIGH exits non-zero rather than reporting success', () => {
  let code = 0
  try {
    execSync(`node ${path.join(DIR, 'reap.mjs')}`, {
      env: { ...process.env, REAP_HIGH: '10', REAP_LOW: '60' }, stdio: 'pipe',
    })
  } catch (e) { code = e.status }
  if (code !== 2) throw new Error(`expected exit 2, got ${code}`)
})

// ------------------------------------------------------- the lease classes
console.log('\nlease - the three classes, including the one a timer must not touch')

const lease = await import(path.join(DIR, 'lease.mjs')).catch(() => null)
check('lease exposes classify without running against production', () => {
  if (!lease || typeof lease.classify !== 'function') {
    throw new Error('classify is not importable - it runs a query at import time, so it cannot be calibrated')
  }
})

// ------------------------------------------------- verdict-audit false positives
// Every shape below produced a FALSE ACCUSATION against a bee before it was
// fixed. A checker that accuses the innocent is worse than a loose one, so each
// stays pinned here.
console.log('\nverdict-audit - must not accuse work that is really there')

const VA = await import(path.join(DIR, 'verdict-audit.mjs'))

const criteriaBody = (line) => `## Success Criteria\n\n${line}\n\n## Boundary\n\n\`x/y.mjs\`\n`

check('a class method with a return-type annotation counts as defined', () => {
  const added = '+  onReconnected(handler: () => void): () => void {'
  if (!/onReconnected\s*\([^)]*\).*\{\s*$/m.test(added)) throw new Error('the method shape is not recognised')
})

check('a describe title counts, because the criterion asked for a registration', () => {
  const added = `+describe('taskQueueServiceContract', () => {`
  if (!/(?:describe|it|test|suite)\s*\(\s*['"\`]taskQueueServiceContract['"\`]/m.test(added))
    throw new Error('a registered name is not recognised')
})

check('prose inside Success Criteria is not read as a promise', () => {
  const ids = VA.promisedIdentifiers(criteriaBody(
    'The Queen judges against a section she is telling the author `criteriaWithSource` does not exist.',
  ))
  if (ids.length) throw new Error(`harvested ${ids.join(', ')} from a paragraph`)
})

check('a real criterion IS read as a promise', () => {
  const ids = VA.promisedIdentifiers(criteriaBody(
    '- The tool exports a function named `reallyPromised`; that identifier appears nowhere in the tree today.',
  ))
  if (!ids.includes('reallyPromised')) throw new Error(`missed the promise, got ${JSON.stringify(ids)}`)
})

// -------------------------------------------------- the fork point, not the tip
// A branch is compared against where it FORKED. Comparing against the base's
// current tip reports everything merged after the branch was cut as if the
// branch had DELETED it. On queen-1351 that read as "94 insertions, 234
// deletions" - a bee appearing to remove a fix and its whole test file - where
// the truth was "90 insertions". A judge handed the first version would have
// convicted an innocent worker.
console.log('\nfork point - a branch is judged against where it forked')

check('merge-base and the base tip differ, so this case still proves something', () => {
  const mb = execSync('git merge-base origin/feat/queen-supervisor origin/queen-1351', { cwd: ROOT, encoding: 'utf8' }).trim()
  const tip = execSync('git rev-parse origin/feat/queen-supervisor', { cwd: ROOT, encoding: 'utf8' }).trim()
  if (mb === tip) throw new Error('the base has not moved since this branch forked, so the trap is not reproducible here')
})

check('diffing from the fork point shows additions only, the tip shows phantom deletions', () => {
  const mb = execSync('git merge-base origin/feat/queen-supervisor origin/queen-1351', { cwd: ROOT, encoding: 'utf8' }).trim()
  const fromFork = execSync(`git diff --shortstat ${mb}..origin/queen-1351`, { cwd: ROOT, encoding: 'utf8' })
  const fromTip = execSync('git diff --shortstat origin/feat/queen-supervisor..origin/queen-1351', { cwd: ROOT, encoding: 'utf8' })
  if (/deletion/.test(fromFork)) throw new Error(`fork-point diff should be additions only, got: ${fromFork.trim()}`)
  if (!/deletion/.test(fromTip)) throw new Error('the tip diff no longer shows the phantom deletions, so this case is stale')
})

// ------------------------------------------ counts that are true by construction
// A judge found a criterion satisfied by a command written to produce the
// number already known. The brief permitted it by asking only that a command be
// quoted. Both directions are pinned, because the first version of this rule
// rejected the very wording it was telling authors to adopt.
console.log('\ncounting criteria - must demand an independent command')

const countBrief = (tail) => GOOD.replace(
  `- The tool exports a function named \`${ABSENT_ID}\`; that identifier appears nowhere in the tree today.`,
  `- The row count equals the number of declarations; the bee quotes both numbers and the command that produced the second${tail}\n- The tool exports a function named \`${ABSENT_ID}\`; that identifier appears nowhere in the tree today.`,
)

check('a count criterion with no independence clause is flagged', () => {
  const r = G.gate(draft('weak.md', countBrief('.')))
  if (!r.problems.some((p) => /true by construction/.test(p))) throw new Error('accepted a criterion a rigged command would satisfy')
})

check('the same criterion WITH the clause passes - the fix it recommends must work', () => {
  const r = G.gate(draft('strong.md', countBrief('; that command MUST NOT name or enumerate the specific items it counts.')))
  if (r.problems.some((p) => /true by construction/.test(p))) throw new Error('rejected the exact wording the rule asks for')
})

// ------------------------------------------------- the tail, not the head
// Twenty-one of twenty-three run criteria came back UNVERIFIABLE because the
// packet carried the first 40k characters of a 200k transcript - the planning,
// not the attestation. The rule is pinned as a property of the renderer.
console.log('\njudge packet - must carry the END of what the bee said')

check('the packet renders the tail of a long transcript, not its head', () => {
  const JP = fsRequireJudge()
  const said = 'HEAD-MARKER' + 'x'.repeat(200000) + 'TAIL-MARKER'
  const text = JP.render({ number: 1, title: 't', criteria: ['c'], stat: 's', diff: 'd', said, saidChars: said.length, saidTruncated: true })
  if (!text.includes('TAIL-MARKER')) throw new Error('the end of the transcript is missing - the attestation lives there')
  if (text.includes('HEAD-MARKER')) throw new Error('the head was rendered; a judge would see planning instead of evidence')
})

check('a truncated packet says how much was omitted, rather than implying completeness', () => {
  const JP = fsRequireJudge()
  const said = 'y'.repeat(200000)
  const text = JP.render({ number: 1, title: 't', criteria: ['c'], stat: 's', diff: 'd', said, saidChars: said.length, saidTruncated: true })
  if (!/UNVERIFIABLE by truncation/.test(text)) throw new Error('a truncated transcript must say so, or absence reads as omission')
})

// ------------------------------------------------------ a level is not a rate
// The counter that is MISSING on a tick must not be read as zero. A capacity
// refusal short-circuits before the skip loop, so `skips` is `{}` - including
// those as zeroes would invent a crash and a recovery twice an hour.
console.log('\ntrend - a missing counter is not a zero')

check('a snapshot with no skip summary contributes no point, rather than a zero', () => {
  const T = TR
  const rows = T.trend(24)
  const claimed = rows.find((r) => r.key === 'claimed')
  const running = rows.find((r) => r.key === 'running')
  if (!claimed || !running) throw new Error('the series are missing entirely')
  if (claimed.state === 'measured' && running.state === 'measured' && claimed.n > running.n) {
    throw new Error(`claimed has MORE points (${claimed.n}) than running (${running.n}) - empty skip summaries are being counted as zeroes`)
  }
})

// ----------------------------------------- a named command must show its output
// Both fabrications found in 34 run-criteria were COUNTS - "returns 3 lines"
// where the tree has 7, "prints 15" where it has 14 - reasoned out instead of
// observed. The rule the judge wrote is pinned in both directions.
console.log('\nbrief-gate - a criterion naming a command must demand its raw output')

const cmdBrief = (tail) => GOOD.replace(
  `- The tool exports a function named \`${ABSENT_ID}\`; that identifier appears nowhere in the tree today.`,
  `- Running \`node trios/tools/x.mjs\` reports 3 findings${tail}\n- The tool exports a function named \`${ABSENT_ID}\`; that identifier appears nowhere in the tree today.`,
)

check('a command criterion with no output demand is flagged', () => {
  const r = G.gate(draft('nostdout.md', cmdBrief('.')))
  if (!r.problems.some((p) => /raw output|raw stdout/.test(p))) throw new Error('accepted a count the worker could reason out')
})

check('the same criterion demanding raw stdout passes', () => {
  const r = G.gate(draft('withstdout.md', cmdBrief('; paste the command and its raw stdout, unedited.')))
  if (r.problems.some((p) => /raw output|raw stdout/.test(p))) throw new Error('rejected the exact wording the rule asks for')
})

// ------------------------------------------------------- clocks nothing touches
// A valve keyed on `reviewed_at` could never fire for a `wait` row, because the
// review sweep UPDATEs those in place every round. It cost a six-hour swarm
// outage. The same pattern was then found in two more tools. This guards the
// class rather than the three instances.
console.log('\nclocks - no tool may measure age from a field the sweep rewrites')

check('no loop tool measures age from reviewed_at', () => {
  const offenders = []
  // The harness itself is excluded: it carries a planted example of the very
  // shape it hunts, and a scanner that flags its own fixture reports a defect
  // where there is none - the false-accusation failure this project has now
  // paid for four times.
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.mjs') && n !== 'selftest.mjs')) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8')
    for (const line of src.split('\n')) {
      // Only a MEASUREMENT counts. Naming the column in a comment, or selecting
      // it to display, is not the defect.
      if (/now\(\)\s*-[^)]*reviewed_at|Date\.parse\([^)]*reviewed_at/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
        offenders.push(`${f}: ${line.trim().slice(0, 80)}`)
      }
    }
  }
  if (offenders.length) throw new Error(`age measured from a rewritten field:\n          ${offenders.join('\n          ')}`)
})

check('the guard would actually catch it - a planted offender is detected', () => {
  const planted = "const h = (now() - coalesce(d.reviewed_at, d.finished_at))/3600"
  if (!/now\(\)\s*-[^)]*reviewed_at/.test(planted)) throw new Error('the pattern no longer matches the shape it was written for')
})

check('the clock audit flags a rewritten field and exits non-zero', () => {
  // Planted in a throwaway copy of the loop dir would be heavy; instead assert
  // the classifier directly, which is what the exit code is computed from.
  const CL = CLK
  const rows = CL.clocks()
  if (!rows.length) throw new Error('the audit found no measurements at all, so it is proving nothing')
  const bad = rows.filter((r) => r.state !== 'immutable')
  if (bad.length) throw new Error(`clocks on rewritten or unknown fields: ${bad.map((b) => b.file + ':' + b.line + ' ' + b.field).join(', ')}`)
})

// ------------------------------------- fields a query never selected
// A retry ceiling bounded nothing for a whole deploy because `send_backs` was
// not in the SELECT: `undefined ?? 0` is a number every assertion passes. The
// negative is proved first, because this parser needed two corrections before
// it could tell the truth about a subquery.
console.log('\nfields - a read the query never selected must be found')

check('a planted missing field is detected', () => {
  const planted = [
    'const rows = await pool.query(`SELECT issue, branch FROM queen_dispatch`)',
    'for (const row of rows.rows) { const n = Number(row.send_backs ?? 0) }',
  ].join('\n')
  const rows = FLD.audit(planted)
  if (!rows.some((r) => r.state === 'MISSING' && r.missing.includes('send_backs'))) {
    throw new Error('the planted missing field was not found')
  }
})

check('a subquery alias is NOT reported missing - it broke this parser twice', () => {
  const withSub = [
    'const done = await pool.query(`SELECT d.issue,',
    "    (SELECT string_agg(t.text, '' ORDER BY t.seq) FROM queen_transcript t WHERE t.x = d.y) AS said",
    '  FROM queen_dispatch d`)',
    'for (const row of done.rows) { const s = String(row.said ?? "") }',
  ].join('\n')
  const rows = FLD.audit(withSub)
  const bad = rows.filter((r) => r.state === 'MISSING')
  if (bad.length) throw new Error(`accused a query of omitting ${bad[0].missing.join(', ')}, which the subquery provides`)
})

// ------------------------------------------ importing must never do work
// brief-gate read process.argv unconditionally and I judged it import-safe
// because it does nothing when argv is empty. An importer with its OWN
// arguments hands them straight to it: fp-check.mjs, run as `fp-check.mjs 4`,
// made the gate try to open a file named "4". Same class as the module that ran
// a production query on import.
console.log('\nimport safety - a module must do nothing merely by being imported')

check('every loop tool carries an isMain guard', () => {
  const missing = []
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.mjs') && n !== 'loop.mjs' && n !== 'selftest.mjs')) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8')
    if (!/\bisMain\b/.test(src)) missing.push(f)
  }
  if (missing.length) throw new Error(`no isMain guard in: ${missing.join(', ')}`)
})

check('no tool reads process.argv at module scope, outside an isMain block', () => {
  // The first version of this check tested whether the LINE mentioned isMain,
  // and duly accused six files that read argv correctly INSIDE an
  // `if (isMain) {` block. Seventh false accusation of the night, caught by the
  // very check written for that class - which is the point of writing it.
  // Depth tracking is the only honest reading, exactly as it was for SQL.
  const offenders = []
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.mjs') && n !== 'selftest.mjs')) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8')
    let depth = 0
    let guardDepth = null
    for (const line of src.split('\n')) {
      const trimmed = line.trim()
      if (/^if\s*\(\s*isMain\s*\)/.test(trimmed)) guardDepth = depth
      const opens = (line.match(/\{/g) || []).length
      const closes = (line.match(/\}/g) || []).length
      const before = depth
      depth += opens - closes
      if (guardDepth !== null && depth <= guardDepth && closes > 0) guardDepth = null
      if (!/process\.argv/.test(line)) continue
      if (/^\s*(\/\/|\*)/.test(trimmed)) continue
      if (/isMain/.test(line)) continue
      if (guardDepth !== null || before > 0) continue
      offenders.push(`${f}: ${trimmed.slice(0, 60)}`)
    }
  }
  if (offenders.length) throw new Error(`argv read at module scope:\n          ${offenders.join('\n          ')}`)
})


// ---------------------------------------------------------------------------
// stale-escalations: the two gates, and the near miss that made the second one.
//
// An escalation is the swarm asking for a PERSON. Retiring one is the most
// dangerous act in the chain, so both gates are pinned here: the cause must be
// re-measurable AND void, and the issue must not ask for a person in its own
// words. The first working run of the tool called #1244 stale on the strength
// of its recorded reason alone and would have returned it to the pool, while
// its body carried a section headed "why I am waiting for your word".

check('a retry-ceiling cause is never re-measured, however old', () => {
  const c = SE.causeOf('returned 2 time(s) already and 4 criterion(s) are still unmet')
  eq(c.kind, 'retry-ceiling', 'cause kind')
  eq(c.remeasurable, false, 'a fact about the conversation cannot be re-measured from the issue text')
})

check('a no-criteria cause is re-measurable', () => {
  const c = SE.causeOf('the task has no acceptance criteria, so there is nothing to judge it against')
  eq(c.kind, 'no-criteria', 'cause kind')
  eq(c.remeasurable, true, 'the issue text settles it')
})

check('an unrecognised reason is left alone rather than assumed stale', () => {
  const c = SE.causeOf('something no version of this tool has ever seen')
  eq(c.kind, null, 'cause kind')
  eq(c.remeasurable, false, 'a reason the tool cannot check must never be overruled')
})

check('an empty or absent reason is not a licence to release', () => {
  eq(SE.causeOf(null).remeasurable, false, 'null reason')
  eq(SE.causeOf('').remeasurable, false, 'empty reason')
})

check('a body asking for a person in Russian is recognised', () => {
  const body = '# T\n\n## Почему жду слова\n\nThe tabs are what you see every day.\n\n## Готово, когда\n\n- it builds\n'
  const asks = SE.bodyAsksForAPerson(body)
  if (!asks) throw new Error('the heading that saved #1244 was not recognised')
})

check('the phrase only counts as a HEADING, not anywhere in prose', () => {
  const body = '# T\n\nSome bee once wrote почему жду слова in a sentence.\n\n## Success Criteria\n\n- it builds\n'
  eq(SE.bodyAsksForAPerson(body), null, 'a phrase in prose is not a request')
})

check('an ordinary body asks for nobody', () => {
  const body = '# T\n\n## Boundary\n\ndocs/x.md\n\n## Success Criteria\n\n- it builds\n'
  eq(SE.bodyAsksForAPerson(body), null, 'no request')
})

check('the release SQL touches only rows still in escalate', () => {
  // A release that did not re-check the state would overwrite a verdict some
  // other round had already reached between the survey and the update.
  const src = fs.readFileSync(path.join(DIR, 'stale-escalations.mjs'), 'utf8')
  if (!/review_state='escalate'/.test(src)) {
    throw new Error('the update must re-assert review_state=escalate in its WHERE')
  }
  if (!/review_state='failed'/.test(src)) {
    throw new Error("a released row must land in 'failed', which the policy treats as free")
  }
})

check('the parser probe is rebuilt when the parser is newer than the binary', () => {
  const src = fs.readFileSync(path.join(DIR, 'stale-escalations.mjs'), 'utf8')
  if (!/mtimeMs/.test(src)) {
    throw new Error('a cached probe older than the parser would mask the very change this tool exists to notice')
  }
})


check('an expired lock is not a holder, and acquire agrees with lockHolder', () => {
  // The pair once disagreed: `lockHolder` returned any lock file whatever its
  // age while `acquire` was entitled to reclaim one past the stale window. So
  // `heal.mjs` could name a run that had finished 45 minutes earlier as the
  // reason it stood down.
  const src = fs.readFileSync(path.join(DIR, 'loop.mjs'), 'utf8')
  if (!/if \(!l \|\| l\.expired\) return null/.test(src)) {
    throw new Error('lockHolder must refuse to report an expired lock as a holder')
  }
  const rec = L.lockRecord()
  const holder = L.lockHolder()
  if (rec && rec.expired && holder) {
    throw new Error('lockHolder reported an expired record as a live holder')
  }
  if (holder && !L.acquire('selftest-agreement').ok === false) {
    // acquire must refuse exactly when lockHolder reports someone.
  }
})


// ---------------------------------------------------------------------------
// disjoint: filing N tasks does not give you N workers.
//
// Four issues were filed on 2026-09-04 and two named the same file, so the
// scheduler refused one with `fileConflict` and the fourth worker slot stayed
// empty while the backlog looked healthy. These pin the comparison AND the
// selection, because the comparison is the part that has been wrong before:
// path ownership compared as raw strings is a recorded defect of this project.

check('a directory conflicts with everything beneath it, both ways', () => {
  if (!D.collides('rings/SR-00', 'rings/SR-00/Queen.swift')) throw new Error('a directory must conflict with its own file')
  if (!D.collides('rings/SR-00/Queen.swift', 'rings/SR-00')) throw new Error('and in the other direction')
})

check('a string prefix that is not a directory does NOT conflict', () => {
  // The recorded defect: `rings/SR-0` is a string prefix of `rings/SR-00/X` and
  // is not a directory containing it.
  if (D.collides('rings/SR-0', 'rings/SR-00/Queen.swift')) throw new Error('compared as strings, not as path components')
})

check('two different files in one directory do not conflict', () => {
  if (D.collides('a/b/one.ts', 'a/b/two.ts')) throw new Error('siblings are not a conflict')
})

check('the same file conflicts with itself however it is written', () => {
  if (!D.collides('./a/b.ts', 'a/b.ts')) throw new Error('a leading ./ is not a different file')
  if (!D.collides('`a/b.ts`', 'a/b.ts')) throw new Error('markdown backticks are not part of the path')
  if (!D.collides('a/b/', 'a/b/c.ts')) throw new Error('a trailing slash is not a different directory')
})

check('an empty path conflicts with nothing, rather than with everything', () => {
  if (D.collides('', 'a/b.ts')) throw new Error('an empty path must not swallow the tree')
})

check('the batch drops the second candidate that names one file', () => {
  const c = [
    { id: 'A', paths: ['x/queen-tick.ts', 'x/a.test.ts'] },
    { id: 'B', paths: ['x/queen-tick.ts', 'x/b.test.ts'] },
    { id: 'C', paths: ['y/other.ts'] },
  ]
  const { taken, setAside } = D.disjointBatch(c, [], 10)
  eq(taken.length, 2, 'two of the three can run side by side')
  eq(setAside.length, 1, 'one set aside')
  if (!/already spoken for/.test(setAside[0].why)) throw new Error('the reason must name the collision')
  // The exact case measured: this is #1420 and #1421.
  const ids = taken.map((t) => t.id).sort().join('')
  if (ids !== 'AC' && ids !== 'BC') throw new Error(`took ${ids}, which is not a disjoint pair`)
})

check('a candidate colliding with what the swarm already holds is not filed', () => {
  const { taken, setAside } = D.disjointBatch(
    [{ id: 'A', paths: ['rings/SR-02/ChatViewModel.swift'] }],
    ['rings/SR-02'],
    10,
  )
  eq(taken.length, 0, 'held by a live dispatch')
  if (!/spoken for/.test(setAside[0].why)) throw new Error('must say why')
})

check('a candidate with no boundary is set aside, not silently taken', () => {
  const { taken, setAside } = D.disjointBatch([{ id: 'A', paths: [] }], [], 10)
  eq(taken.length, 0, 'nothing can be reserved for it')
  if (!/no boundary/.test(setAside[0].why)) throw new Error('must say why')
})

check('the room limit is honoured and the overflow says so', () => {
  const c = [{ id: 'A', paths: ['a.ts'] }, { id: 'B', paths: ['b.ts'] }, { id: 'C', paths: ['c.ts'] }]
  const { taken, setAside } = D.disjointBatch(c, [], 2)
  eq(taken.length, 2, 'two filed')
  eq(setAside.length, 1, 'one over the room')
  if (!/over the room/.test(setAside[0].why)) throw new Error('must distinguish room from collision')
})

check('nothing is dropped without a reason', () => {
  const c = [{ id: 'A', paths: ['a.ts'] }, { id: 'B', paths: ['a.ts'] }, { id: 'C', paths: [] }]
  const { taken, setAside } = D.disjointBatch(c, [], 10)
  eq(taken.length + setAside.length, 3, 'every candidate is accounted for')
  if (setAside.some((s) => !s.why)) throw new Error('a selector that drops work silently is indistinguishable from a broken one')
})


// ---------------------------------------------------------------------------
// brief-gate: a tree-level check is mechanical too, and the negatives still bite.

const CLEANUP = `# A cleanup task that defines nothing new

## User Scenarios & Testing

### User Story 1 - The file obeys the law (P1)

**Given** the file, **When** the check runs, **Then** it reports zero.

**Acceptance Scenarios**:
1. **Given** the file, **When** the grep runs, **Then** its output is 0.

## Requirements

- **FR-001**: Every offending character MUST be replaced.

## Success Criteria

- \`LC_ALL=C grep -cP '[^\\x00-\\x7F]' trios/tools/selftest-fixture.mjs\` prints 0, and the raw output is quoted. The command MUST NOT name or enumerate the specific items it counts.

## Boundary

\`trios/tools/selftest-fixture.mjs\`
`

check('a cleanup with a tree-level check and no new identifier is accepted', () => {
  // It defines nothing, so the identifier rule can never be satisfied. Refusing
  // it refused three real L3 cleanups on 2026-09-04 - a false refusal of the
  // exact class this gate keeps committing.
  const r = G.gate(draft('cleanup.md', CLEANUP))
  if (r.problems.some((p) => /mechanically checkable/.test(p))) {
    throw new Error(`refused a tree-level check: ${r.problems.join('; ')}`)
  }
})

check('the command must name a path the Boundary actually reserves', () => {
  // Replace ONLY the path inside the command, leaving the Boundary alone, so the
  // draft claims a check over a file it never reserved.
  const lines = CLEANUP.split('\n')
  const i = lines.findIndex((l) => l.startsWith('- `LC_ALL'))
  if (i < 0) throw new Error('the fixture no longer carries the command this case is about')
  const bad = lines
    .map((l, k) => (k === i ? l.replace('trios/tools/selftest-fixture.mjs', 'some/other/file.ts') : l))
    .join('\n')
  const r = G.gate(draft('cleanup-elsewhere.md', bad))
  if (!r.problems.some((p) => /mechanically checkable/.test(p))) {
    throw new Error('accepted a command pointing outside the boundary - the worker could satisfy it without touching its own files')
  }
})

check('the command must state an exact expected output', () => {
  const bad = CLEANUP.replace('prints 0,', 'is clean,')
  const r = G.gate(draft('cleanup-vague.md', bad))
  if (!r.problems.some((p) => /mechanically checkable/.test(p))) {
    throw new Error('accepted a command with no expected output - "clean" is the bee\'s word again')
  }
})

check('prose alone is still refused', () => {
  const bad = CLEANUP.replace(/- `LC_ALL[^\n]*\n/, '- The file looks tidy afterwards.\n')
  const r = G.gate(draft('cleanup-prose.md', bad))
  if (!r.problems.some((p) => /mechanically checkable/.test(p))) {
    throw new Error('accepted a criterion nobody can audit')
  }
})


// ---------------------------------------------------------------------------
// author: the limit belongs on the QUEUE, not on the backlog.
//
// Measured 2026-09-04: five authored issues open, the author refusing to file
// with "at the WIP limit" - and FOUR of the five already dispatched and sitting
// in sendBack or wait. The real queue was ONE, and the swarm ran at 14% of
// capacity while its reviewer answered in 0.8 seconds.
//
// Kanban limits work in progress and never the backlog. Dependabot's
// open-pull-requests-limit protects a HUMAN reviewer's capacity. Neither says
// to cap the number of things waiting to be started.

check('an issue with a dispatch is in progress, not queue', () => {
  const src = fs.readFileSync(path.join(DIR, 'author.mjs'), 'utf8')
  if (!/unstartedAuthored/.test(src)) throw new Error('the count must be of unstarted issues')
  if (/const open = openAuthored\(\)/.test(src)) throw new Error('still counting the backlog column')
  if (!/queen_dispatch where issue in/.test(src)) throw new Error('nothing asks which issues were ever dispatched')
})

check('a failed measurement still refuses to file', () => {
  // The oldest rule here: a count that could not be taken must never read as
  // zero, because zero LIFTS the limit rather than holding it.
  const src = fs.readFileSync(path.join(DIR, 'author.mjs'), 'utf8')
  const fn = src.slice(src.indexOf('function unstartedAuthored'), src.indexOf('// BOTH SIGNALS'))
  const returns = [...fn.matchAll(/return\s+([^\n]+)/g)].map((m) => m[1].trim())
  if (!returns.some((r) => r.startsWith('null'))) {
    throw new Error('an unreadable count must return null, which refuses, not 0, which permits')
  }
  if (!/=== null.*refusing|refusing.*=== null/s.test(src)) {
    throw new Error('nothing refuses on a null count')
  }
})

check('the stall guard reports the same numbers it reads', () => {
  // It once printed "${open} authored issue(s) open" while `open` had quietly
  // become the queue depth - a report that disagrees with its own measure is
  // how a number gets believed for the wrong reason.
  const src = fs.readFileSync(path.join(DIR, 'author.mjs'), 'utf8')
  const msg = src.slice(src.indexOf('STALLED:'), src.indexOf('STALLED:') + 400)
  if (!/q\.open/.test(msg) || !/q\.queue/.test(msg)) {
    throw new Error('the refusal must name both the open count and the queue depth')
  }
})


check('an unreadable queue is UNKNOWN, never empty', () => {
  // The whole point of the measure is to tell the author how much room it has.
  // A network fault reported as 0 would tell it there is room for everything.
  const src = fs.readFileSync(path.join(DIR, 'queue.mjs'), 'utf8')
  const fn = src.slice(src.indexOf('export function depth'), src.indexOf('export function latency'))
  if (!/return null/.test(fn)) throw new Error('depth() must return null when it cannot tell')
  if (/return \{ open: 0, inProgress: 0, queue: 0[^}]*\}\s*\n\s*\}/.test(fn.replace(/if \(!open\.length\)[^\n]*\n/, ''))) {
    throw new Error('an unreachable service must not fall through to a zero queue')
  }
  if (!/is unknown, which is not the same as empty/.test(src)) {
    throw new Error('the refusal must say what it does not know')
  }
})

check('the latency report states both stages, so neither can be assumed', () => {
  // I assumed review latency bounded throughput and wrote it into the skill for
  // a whole iteration. It was p50 0.8 s. An assumption about which stage is slow
  // costs one query to check.
  const src = fs.readFileSync(path.join(DIR, 'queue.mjs'), 'utf8')
  if (!/reviewed_at-finished_at/.test(src)) throw new Error('the review stage is not measured')
  if (!/finished_at-dispatched_at/.test(src)) throw new Error('the worker stage is not measured')
  if (!/Little/.test(src)) throw new Error('a depth without the rate it must sustain is a number nobody can act on')
})


check('a criterion demanding a green repository typecheck is refused', () => {
  // I wrote exactly this into the template for every L3 cleanup. The repository
  // typecheck has 42 pre-existing errors on a clean checkout, so around a dozen
  // issues carried a criterion no honest work could satisfy - and a worker did
  // the right thing, stashed its change, proved the failures were identical
  // without it, and reported the criterion unmet. Excellent work, marked down by
  // my sentence. Second time: #1377 SC-2 demanded output without the word `skip`
  // from a suite named queen-skip-reason-parity.
  const bad = CLEANUP.replace(
    /- `LC_ALL[^\n]*\n/,
    '- `bun run typecheck` passes from `trios/agent-server`, and its raw stdout is quoted.\n- `LC_ALL=C grep -cP \'[^\\x00-\\x7F]\' trios/tools/selftest-fixture.mjs` prints 0, and the raw output is quoted. The command MUST NOT name or enumerate the specific items it counts.\n',
  )
  const r = G.gate(draft('green-tree.md', bad))
  if (!r.problems.some((p) => /green/.test(p))) {
    throw new Error(`accepted a demand that the whole tree be green: ${r.problems.join('; ')}`)
  }
})

check('the SCOPED form of the same demand is accepted', () => {
  const ok = CLEANUP.replace(
    /- `LC_ALL[^\n]*\n/,
    '- `bun run typecheck 2>&1 | grep -c trios/tools/selftest-fixture.mjs` prints 0, and the raw output is quoted. The command MUST NOT name or enumerate the specific items it counts.\n',
  )
  const r = G.gate(draft('green-scoped.md', ok))
  if (r.problems.some((p) => /green/.test(p))) {
    throw new Error(`refused a demand scoped to its own boundary: ${r.problems.join('; ')}`)
  }
})


// ---------------------------------------------------------------------------
// reap-local: the laptop fills too, and the tool that frees it must never hang.

check('a shell call in the local reaper is bounded', () => {
  // Without a timeout it ran past 500 s twice and had to be killed, and there
  // was no way to tell which of 33 worktrees was hanging. A step that can hang
  // for ever hangs the whole chain, and this one runs first of eleven.
  const src = fs.readFileSync(path.join(DIR, 'reap-local.mjs'), 'utf8')
  if (!/timeout/.test(src.slice(src.indexOf('const sh ='), src.indexOf('const sh =') + 700))) {
    throw new Error('every shell call must be bounded')
  }
})

check('the cheap question is asked before the expensive one', () => {
  // "Is this commit an ancestor" is two ref lookups; `git status` walks the
  // working tree, and on a 2.4 GB checkout that is seconds. An unmerged tree is
  // kept whatever its state, so its dirtiness is never worth asking.
  const src = fs.readFileSync(path.join(DIR, 'reap-local.mjs'), 'utf8')
  const fn = src.slice(src.indexOf('export function survey'), src.indexOf('if (isMain)'))
  const ancestor = fn.indexOf('is-ancestor')
  const status = fn.indexOf('git status --porcelain')
  if (ancestor < 0 || status < 0) throw new Error('both questions must be asked')
  if (ancestor > status) throw new Error('the expensive question is being asked first')
})

check('it never passes --force to git worktree remove', () => {
  // The standing rule of this project. --force is what turns "this has
  // something in it" into silence.
  const src = fs.readFileSync(path.join(DIR, 'reap-local.mjs'), 'utf8')
  if (/worktree remove[^\n]*--force/.test(src)) {
    throw new Error('--force must never appear on a worktree removal')
  }
  if (!/left alone rather than forced/.test(src)) {
    throw new Error('a refusal must say it chose not to force')
  }
})

check('a dirty tree is kept whatever the disk says', () => {
  const src = fs.readFileSync(path.join(DIR, 'reap-local.mjs'), 'utf8')
  if (!/state = 'dirty'/.test(src)) throw new Error('dirtiness must be a state of its own')
  const reap = src.slice(src.indexOf('const reapable ='))
  if (/state === 'dirty'/.test(reap.slice(0, reap.indexOf('for (const r of reapable)')))) {
    throw new Error('a dirty tree must never enter the reapable set')
  }
})


// ---------------------------------------------------------------------------
// verdicts: a rate over a window that has not finished is not a rate.
//
// I reported "only 17% of dispatches are accepted, 50% get no verdict at all"
// and built a whole argument on it, including what to work on next. The window
// was still in flight: most of those rows simply had no verdict YET, and
// `wait` and `(none)` were transient states rather than outcomes. Judged three
// hours later the same window read 80% accepted; the following three hours read
// 96%. The swarm was healthy and I called it broken.

check('the verdict rate counts only work that has finished', () => {
  const src = fs.readFileSync(path.join(DIR, 'queue.mjs'), 'utf8')
  const fn = src.slice(src.indexOf('export function verdicts'), src.indexOf('if (isMain)'))
  if (!/finished_at is not null/.test(fn)) {
    throw new Error('an unfinished dispatch has no verdict yet and must not count against the rate')
  }
})

check('it reports how many it excluded, so the denominator is visible', () => {
  const src = fs.readFileSync(path.join(DIR, 'queue.mjs'), 'utf8')
  if (!/finished_at is null/.test(src)) throw new Error('nothing counts the in-flight rows')
  if (!/still RUNNING and are excluded/.test(src)) {
    throw new Error('a reader cannot judge a rate without being told what was left out')
  }
  if (!/has no rate yet/.test(src)) {
    throw new Error('the tool must say plainly that an unfinished window has no rate')
  }
})


// ---------------------------------------------------------------------------
// author: a detector must refuse the files the repository GENERATES.
//
// Widening the L3 detector past the server tree brought `packages/cdp-protocol`
// into range: 114 files carrying non-ASCII in comments, every one opening with
// "AUTO-GENERATED from CDP protocol. DO NOT EDIT." Filing against them would
// have been 114 tasks a correct worker must refuse, and L0 is explicit that a
// diff changing a generated file is itself a defect.

check('a file under a generated/ path is refused', () => {
  if (!A.isGenerated('trios/agent-server/packages/cdp-protocol/src/generated/create-api.ts', 'x')) {
    throw new Error('the path convention must be enough on its own')
  }
  if (!A.isGenerated('a/dist/x.ts', 'x')) throw new Error('dist is generated')
  if (!A.isGenerated('a/node_modules/x.ts', 'x')) throw new Error('node_modules is not ours')
})

check('a file whose HEADER says it is generated is refused wherever it lives', () => {
  const head = '// -- AUTO-GENERATED from CDP protocol. DO NOT EDIT. --\n\nexport const x = 1\n'
  if (!A.isGenerated('trios/agent-server/apps/agent/anywhere.ts', head)) {
    throw new Error('the marker must be enough on its own - a generator may write anywhere')
  }
  if (!A.isGenerated('a/b.ts', '/* @generated */\nexport const y = 2\n')) {
    throw new Error('@generated is the other common marker')
  }
})

check('the marker is only believed near the TOP of the file', () => {
  // A file that MENTIONS generated code in a comment two hundred lines down is
  // not itself generated, and refusing it would quietly shrink the corpus in a
  // way nobody would notice.
  const late = 'export const a = 1\n'.repeat(40) + '// this is AUTO-GENERATED elsewhere\n'
  if (A.isGenerated('a/b.ts', late)) {
    throw new Error('a mention far down the file is not a generator marker')
  }
})

check('an ordinary hand-written file is NOT refused', () => {
  if (A.isGenerated('trios/agent-server/apps/agent/real.ts', '// A comment.\nexport const z = 3\n')) {
    throw new Error('refusing hand-written files would empty the corpus silently')
  }
})


// ---------------------------------------------------------------------------
// why / feed / push-work: the diagnosis, the fast refill, and the batch that
// used to take itself down.

check('the diagnosis stops at the FIRST cause that explains what is seen', () => {
  // A diagnosis that lists six possibilities has not diagnosed anything. Asked
  // four times in one night why the swarm was idle, the answer was different
  // every time and none was guessable from "RUNNING 0".
  const src = fs.readFileSync(path.join(DIR, 'why.mjs'), 'utf8')
  if (!/if \(!all\) break/.test(src)) throw new Error('it must stop at the first hit unless asked for all')
  if (!/remedy/.test(src)) throw new Error('a cause without a command to run is half an answer')
})

check('every cause carries evidence and a remedy', () => {
  // Counted INSIDE the checks, not across the file: the printing block says
  // "evidence:" too, so a whole-file count reported 13 against 12 and blamed
  // the code for the test's own sloppiness.
  const src = fs.readFileSync(path.join(DIR, 'why.mjs'), 'utf8')
  const fn = src.slice(src.indexOf('export function checks'), src.indexOf('if (isMain)'))
  const causes = [...fn.matchAll(/cause:/g)].length
  const evidence = [...fn.matchAll(/evidence:/g)].length
  const remedies = [...fn.matchAll(/remedy:/g)].length
  if (causes !== evidence || causes !== remedies) {
    throw new Error(`${causes} causes, ${evidence} evidence, ${remedies} remedies - each must have both`)
  }
})

check('an unknown cause is reported as unknown, not as health', () => {
  const src = fs.readFileSync(path.join(DIR, 'why.mjs'), 'utf8')
  if (!/No known cause fires/.test(src)) throw new Error('silence must not read as "nothing is wrong"')
  if (!/process\.exit\(2\)/.test(src)) throw new Error('an undiagnosed idle swarm must not exit 0')
})

check('the feed stands down when the chain holds the lock', () => {
  // Two writers pushing and closing at once is the thing the lock exists to
  // prevent, and the chain does this same work a minute later.
  const src = fs.readFileSync(path.join(DIR, 'feed.mjs'), 'utf8')
  if (!/standing down/.test(src)) throw new Error('it must stand down rather than race')
  if (!/process\.exit\(0\)/.test(src.slice(src.indexOf('standing down')))) {
    throw new Error('standing down is not an error')
  }
})

check('a step killed by the timeout is not called a failure', () => {
  // Calling it one sent me hunting a bug in close-done that did not exist. A
  // half-run step is worse than an unrun one, but it is not a fault in the step.
  const src = fs.readFileSync(path.join(DIR, 'feed.mjs'), 'utf8')
  if (!/timed out/.test(src)) throw new Error('a timeout needs its own state')
  if (!/e\.killed \|\| e\.signal === 'SIGTERM'/.test(src)) {
    throw new Error('nothing distinguishes a kill from a non-zero exit')
  }
})

check('one rejected ref does not take the whole push down', () => {
  // `git push` exits non-zero when ANY ref is rejected, and this pushes a batch.
  // A single non-fast-forward made execSync throw, the script died before
  // reporting, and NONE of the other branches reached the remote - the defect
  // this tool exists to fix, committed by the tool.
  const src = fs.readFileSync(path.join(DIR, 'push-work.mjs'), 'utf8')
  if (!/function push\(/.test(src)) throw new Error('the push needs a tolerant caller of its own')
  if (!/catch \(e\)[\s\S]{0,200}e\.stdout/.test(src)) {
    throw new Error('a rejected ref must yield its OUTPUT, which the reporting already knows how to read')
  }
  if (/worktree remove[^\n]*--force|push[^\n]*--force/.test(src)) {
    throw new Error('and it must still never force')
  }
})


// ---------------------------------------------------------------------------
// mix and quota: load is not value, and a monoculture hides in every count.
//
// Measured 2026-09-04: 4 of 4 workers running, 100% acceptance, and ALL FORTY of
// the last authored issues were the same thing - replacing box-drawing
// characters in comments. Every metric agreed the swarm was healthy.
//
// The cause was not an exhausted corpus. The `untested` template had been
// failing brief-gate the whole time - a count criterion with no independence
// clause, and commands with no demand for raw stdout - so the only detector that
// could file was the cheapest one. Fifth time one of my gates has refused honest
// work, and the first time it silently shaped what the swarm did for a day.

check('the untested brief passes the gate it must pass', () => {
  const src = fs.readFileSync(path.join(DIR, 'author.mjs'), 'utf8')
  const fn = src.slice(src.indexOf('function untestedBrief'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  if (!/MUST NOT name or enumerate/.test(body)) {
    throw new Error('a count criterion needs its independence clause, or the gate refuses the brief')
  }
  if (!/raw stdout|raw output|raw and unedited/.test(body)) {
    throw new Error('a criterion naming a command must demand its raw output')
  }
})

check('no detector may take more than half a round', () => {
  const src = fs.readFileSync(path.join(DIR, 'author.mjs'), 'utf8')
  if (!/const QUOTA = Math\.max\(1, Math\.ceil\(room \/ 2\)\)/.test(src)) {
    throw new Error('a corpus of 111 must not be able to fill every slot by being larger than one of 25')
  }
  if (!/one detector may not take them all/.test(src)) {
    throw new Error('a candidate dropped for the quota must say so, like every other exclusion')
  }
})

check('the mix counts KINDS, not tasks', () => {
  const src = fs.readFileSync(path.join(DIR, 'queue.mjs'), 'utf8')
  const fn = src.slice(src.indexOf('export function mix'), src.indexOf('if (isMain)'))
  if (!/KINDS/.test(fn)) throw new Error('counting tasks is what hid the monoculture')
  if (!/other/.test(fn)) throw new Error('an unrecognised title must land somewhere visible, not be dropped')
})

check('a monoculture is an ERROR, not a note', () => {
  const src = fs.readFileSync(path.join(DIR, 'queue.mjs'), 'utf8')
  if (!/process\.exit\(3\)/.test(src)) {
    throw new Error('four fifths of the backlog being one cheap thing must not exit 0')
  }
  if (!/load is not value/.test(src)) throw new Error('it must say what the number means')
})


// ---------------------------------------------------------------------------
// land: work that was finished, accepted, closed - and never entered the branch.
//
// 174 queen branches on the remote, FIVE contained in the base, and all 169
// others carrying a real diff. The Queen accepted the work and close-done closed
// the issues on the strength of a branch EXISTING. A closed issue whose code is
// not in the branch is a false statement about the repository, and the loop had
// been making 169 of them.

check('merged is asked by comparing TREES, not ancestry or a three-dot diff', () => {
  // Two wrong answers came first. `merge-base --is-ancestor` is right for a real
  // merge and permanently wrong after a SQUASH, because a squash writes a new
  // commit and the source is never an ancestor - so this tool landed the same
  // five branches four times, opening twenty pull requests and merging fifteen
  // commits that changed zero files. And `git diff BASE...branch` is three-dot:
  // it measures from the divergence point, so it shows the branch's changes
  // whether or not they are already in the base.
  const src = fs.readFileSync(path.join(DIR, 'land.mjs'), 'utf8')
  const fn = src.slice(src.indexOf('export function isLanded'), src.indexOf('export function mergesCleanly'))
  if (!/merge-tree --write-tree/.test(fn)) throw new Error('the exact question is whether merging would change the base at all')
  if (!/\^\{tree\}/.test(fn)) throw new Error('it must compare the resulting tree with the base tree')
  if (/diff --shortstat[^\n]*\.\.\./.test(fn)) throw new Error('a three-dot diff cannot answer this')
})

check('a count that does not move after a successful act STOPS the tool', () => {
  // The tell I missed four times: "landed 5 of 5" then "146 still waiting", on
  // three consecutive runs. Confident output is not evidence that the world
  // changed.
  const src = fs.readFileSync(path.join(DIR, 'land.mjs'), 'utf8')
  if (!/REFUSING to continue/.test(src)) throw new Error('it must refuse, not warn')
  if (!/process\.exit\(4\)/.test(src)) throw new Error('a stalled count must not exit 0')
  if (!/Fix the measure, not the batch/.test(src)) throw new Error('it must say which of the two is wrong')
})

check('it re-measures against a FRESH view of the remote', () => {
  // The stall guard caught this on its first run: it compared the new world
  // against a local ref that had not been told about the merges.
  const src = fs.readFileSync(path.join(DIR, 'land.mjs'), 'utf8')
  const tail = src.slice(src.indexOf('DID THE NUMBER ACTUALLY MOVE'))
  if (!/git fetch/.test(tail)) throw new Error('re-measuring against a stale ref proves nothing')
})

check('a conflict is an ANSWER and names its paths', () => {
  // git merge-tree exits non-zero on conflict, and reading that as a failure
  // made every real conflict report "could not be computed" - the third time
  // this round an outcome was treated as an exception.
  const src = fs.readFileSync(path.join(DIR, 'land.mjs'), 'utf8')
  const fn = src.slice(src.indexOf('export function mergesCleanly'), src.indexOf('export function survey'))
  if (!/catch \(e\)/.test(fn)) throw new Error('a non-zero exit here is the answer, not a fault')
  if (!/e\.stdout/.test(fn)) throw new Error('the conflicting paths are on stdout')
  if (!/conflicting path/.test(fn)) throw new Error('it must name them')
})

check('it never lands UNACCEPTED work, and never forces or deletes', () => {
  // This case first read "never lands an OPEN issue" and failed the moment that
  // rule was found wrong - it was pinning the deadlock. A test that pins a rule
  // has to be RE-AIMED when the rule turns out to be mistaken, deliberately and
  // in the same change, or it becomes an argument for keeping the bug.
  const src = fs.readFileSync(path.join(DIR, 'land.mjs'), 'utf8')
  if (!/neither accepted by the Queen nor closed/.test(src)) {
    throw new Error('work with no accepting verdict and no closed issue is unfinished, whatever its branch looks like')
  }
  // EXECUTABLE lines only. The first version matched the COMMENT that says
  // "No --delete-branch", which is the second time tonight one of my checks
  // read prose as code - the same shape as counting "evidence:" in a printing
  // block and blaming the code for the imbalance.
  const code = codeOf('land.mjs')
  if (/--force/.test(code)) throw new Error('never force')
  if (/--delete-branch/.test(code)) throw new Error('the branch is the evidence that the work happened')
})


// ---------------------------------------------------------------------------
// close-done and land: the pipeline, and the deadlock I built between them.

check('close-done demands LANDED, not merely pushed', () => {
  // The root of the largest gap in the run. Closing on "the branch exists on
  // the remote" is what manufactured 169 closed issues whose code was outside
  // the base.
  const src = fs.readFileSync(path.join(DIR, 'close-done.mjs'), 'utf8')
  if (!/merge-tree --write-tree/.test(src)) {
    throw new Error('it must ask whether merging would change the base at all')
  }
  if (!/NOT in/.test(src)) throw new Error('the refusal must say the work is not in the base')
  if (!/false statement/.test(src)) throw new Error('and why that matters')
})

check('land follows the Queen VERDICT, not the issue state', () => {
  // TWO CORRECT-LOOKING RULES THAT TOGETHER SAID NEVER.
  //
  // land took only a CLOSED issue. close-done was changed in the same hour to
  // close only LANDED work. So an issue the Queen had accepted but which was
  // still open could not move in either direction: land refused it for being
  // open, close refused it for not having landed. The deadlock lasted one run
  // and would have looked exactly like a healthy quiet pipeline.
  const src = fs.readFileSync(path.join(DIR, 'land.mjs'), 'utf8')
  if (!/review_state = 'accept'/.test(src)) {
    throw new Error('"closed" was only ever a proxy for "the Queen accepted this" - ask the thing itself')
  }
  if (!/closed\.has\(issue\) && !accepted\.has\(issue\)/.test(src)) {
    throw new Error('either accepted OR closed must be enough, or the deadlock returns')
  }
})

check('the chain runs push -> land -> close, in that order', () => {
  // Each is the precondition of the next. Skipping the push disables the close;
  // skipping the land now disables it too.
  for (const f of ['heal.mjs', 'feed.mjs']) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8')
    const push = src.indexOf("name: 'push-work'")
    const land = src.indexOf("name: 'land'")
    const close = src.indexOf("name: 'close-done'")
    if (push < 0 || land < 0 || close < 0) throw new Error(`${f} is missing one of the three steps`)
    if (!(push < land && land < close)) throw new Error(`${f} has them out of order: push ${push}, land ${land}, close ${close}`)
  }
})


// ---------------------------------------------------------------------------
// land and why: one bad item must not block a batch, and a finding is not ok.

check('the batch is FILLED with clean candidates, not sliced off the top', () => {
  // `slice(0, BATCH)` took the newest five whatever their state, and the
  // conflicting branches sit at the HEAD of a newest-first list - so a batch of
  // five landed ONE while 35 clean branches waited behind 10 stuck ones. Fourth
  // instance this round of work that CAN proceed being held hostage by work
  // that cannot.
  const src = fs.readFileSync(path.join(DIR, 'land.mjs'), 'utf8')
  if (/const batch = landable\.slice\(0, BATCH\)/.test(src)) {
    throw new Error('taking the first N holds the clean ones hostage to the stuck ones')
  }
  if (!/if \(batch\.length >= BATCH\) break/.test(src)) throw new Error('it must fill to the batch size')
  if (!/BATCH \* 4/.test(src)) throw new Error('and the scan must be bounded, or a wall of conflicts becomes a full survey every run')
})

check('when only conflicts remain, it says the pipeline stops here', () => {
  const src = fs.readFileSync(path.join(DIR, 'land.mjs'), 'utf8')
  if (!/ALL \$\{landable\.length\} remaining branch\(es\) conflict/.test(src)) {
    throw new Error('a batch of zero must explain itself')
  }
  if (!/never resolved by guessing/.test(src)) throw new Error('a conflict is for a person')
})

check('a check that FIRED is never printed as ok', () => {
  // Under --all this printed "ok  the landing pipeline is moving (also true)"
  // for a check that had just detected a stalled pipeline. The word ok is the
  // first thing an eye lands on.
  const code = codeOf('why.mjs')
  if (/also true/.test(code)) throw new Error('a finding must not be dressed as a pass')
  if (!/ALSO/.test(code)) throw new Error('a later cause is still a cause and needs its own marker')
})

check('the all-clear names what is coming, not just what is fine', () => {
  // A stuck landing pipeline does not make a busy swarm idle today; it makes it
  // idle in an hour, once every accepted issue holds a boundary nothing will
  // release.
  const src = fs.readFileSync(path.join(DIR, 'why.mjs'), 'utf8')
  if (!/nothing is wrong RIGHT NOW/.test(src)) throw new Error('an all-clear must be scoped to now')
  if (!/AHEAD:/.test(src)) throw new Error('a leading indicator belongs inside the all-clear')
})


// ---------------------------------------------------------------------------
// untested, widened: the valuable detector must be as large as the cheap one.

check('the untested detector scans more than one directory', () => {
  // A detector confined to one directory runs dry, and then the CHEAPEST
  // detector is the only one filing. Measured 2026-09-05: apps/agent has 457 ts
  // files and 18 tests against apps/server's 447 and 161 - the same size and a
  // ninth of the tests. Pointing the detector only at apps/server was not a
  // judgement about where tests matter; it was where I happened to start.
  const code = codeOf('author.mjs')
  if (!/AUTHOR_UNTESTED_ROOTS/.test(code)) throw new Error('the roots must be a list, and configurable')
  if (!/apps\/agent/.test(code)) throw new Error('the largest untested area must be in range')
})

check('it refuses a module with too many exports to test honestly', () => {
  // Widening produced "prompt-input.tsx exports 40 symbols and no test names any
  // of them". A brief demanding all forty be exercised or excused is one no
  // honest work can satisfy - the same defect as the typecheck criterion, this
  // time arriving from the SIZE of the task rather than from its wording.
  const code = codeOf('author.mjs')
  if (!/UNTESTED_MAX_EXPORTS/.test(code)) throw new Error('a task has to be finishable')
  if (!/exports\.length > UNTESTED_MAX_EXPORTS/.test(code)) throw new Error('the cap must actually filter')
})

check('the test goes where THAT app keeps its tests', () => {
  // Sending an apps/agent test to apps/server/tests would put it in a suite that
  // does not run it and a directory its imports cannot reach.
  const code = codeOf('author.mjs')
  if (!/startsWith\('trios\/agent-server\/apps\/server\/'\)/.test(code)) {
    throw new Error('the path must branch on where the subject lives')
  }
})

check('a generated file is refused by BOTH detectors', () => {
  const code = codeOf('author.mjs')
  const fn = code.slice(code.indexOf('export function untestedModules'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  if (!/isGenerated/.test(body)) {
    throw new Error('a test written against generated output tests the generator, and L0 forbids editing it')
  }
})

console.log(`\n${pass} passed, ${failures.length} failed`)
fs.rmSync(tmp, { recursive: true, force: true })
if (failures.length) {
  console.log('\nfailures:')
  failures.forEach((f) => console.log(`  ${f}`))
  process.exit(1)
}
