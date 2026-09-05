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
const AB = await import(path.join(DIR, 'ab.mjs'))
const A = await import(path.join(DIR, 'author.mjs'))

let pass = 0
const failures = []

// AN ASYNC CHECK WAS NEVER AWAITED, SO IT COULD NOT FAIL.
//
// This called `fn()` inside a try/catch. For an ordinary function that is
// correct. For an `async` one it starts the work, returns a promise, and the
// catch sees nothing - so the case printed `ok`, the summary said `0 failed`,
// and the rejection arrived afterwards as an unhandled error that crashed the
// process AFTER the tally had already been believed.
//
// Found 2026-09-05, holding eight checks written the same day: every one of
// them had been reported passing without ever being run to completion. A gate
// that cannot fail is not a gate, and this file's whole job is to be one.
const pending = []
const settled = (name, e) => {
  if (!e) { pass++; console.log(`  ok    ${name}`); return }
  failures.push(`${name}: ${e.message}`)
  console.log(`  FAIL  ${name}`)
  console.log(`          ${String(e.message).slice(0, 140)}`)
}
function check(name, fn) {
  let out
  try {
    out = fn()
  } catch (e) {
    settled(name, e)
    return
  }
  if (out && typeof out.then === 'function') {
    pending.push(out.then(() => settled(name), (e) => settled(name, e)))
    return
  }
  settled(name)
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
  // The rule moved into land.mjs so there is exactly one of it. The demand is
  // unchanged and is now asserted where it lives: close-done must ASK, and the
  // answer must still include "would merging change the base at all".
  if (!/LAND\.isLanded/.test(src)) {
    throw new Error('it must ask the landing rule rather than close on "pushed"')
  }
  const land = fs.readFileSync(path.join(DIR, 'land.mjs'), 'utf8')
  if (!/merge-tree --write-tree/.test(land)) {
    throw new Error('the rule it asks must still ask whether merging would change the base at all')
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


// ---------------------------------------------------------------------------
// every detector reports its DENOMINATOR.
//
// All three were found narrowed, one per round, and each time the tell was
// missing for the same reason: the number they produced was never zero. The L3
// corpus was one directory of five; the untested corpus was one app of five; and
// the length detector read only the TOP LEVEL of its own six directories - 107
// of 234 files - for want of a `-r`.
//
// A count of findings cannot show that. A count of findings against the number
// of files LOOKED AT can, and costs one number per detector.

check('the length detector recurses', () => {
  const code = codeOf('author.mjs')
  const fn = code.slice(code.indexOf('export function overlongFiles'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  if (!/ls-tree -r --name-only/.test(body)) {
    throw new Error('without -r only the top level of each directory is read - 127 of 234 files were invisible for want of one flag')
  }
})

check('every detector reports how many files it LOOKED AT', () => {
  const code = codeOf('author.mjs')
  for (const fnName of ['overlongFiles', 'untestedModules', 'asciiOffenders']) {
    const fn = code.slice(code.indexOf(`export function ${fnName}`))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    if (!/\.examined = /.test(body)) throw new Error(`${fnName} does not report its denominator`)
  }
  if (!/seen/.test(code)) throw new Error('the signals line must print it')
})

check('the denominator counts the READ, not the keep', () => {
  // Counting kept files gave "ascii=71/71 seen" - a denominator that can never
  // differ from its numerator, and therefore says nothing at all. That is the
  // exact failure the denominator was added to prevent, committed inside the
  // fix for it.
  const code = codeOf('author.mjs')
  const fn = code.slice(code.indexOf('export function asciiOffenders'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  const atRead = body.indexOf('examinedAscii++')
  const atKeep = body.indexOf('out.push({')
  if (atRead < 0 || atKeep < 0) throw new Error('cannot locate the counter and the keep')
  if (atRead > atKeep) throw new Error('the counter must increment before the filters, or numerator equals denominator')
})


// ---------------------------------------------------------------------------
// ab: two windows, one number, and whether the difference is bigger than noise.
//
// I compared percentages by eye all night and was wrong twice in ways that
// changed what I recommended: the 17% that was a window still in flight, and the
// verdict-first brief that looked like a regression at 94% -> 86% and is three
// incomplete reports where 1.3 were expected.

check('Wilson stays inside 0 and 1 where the normal approximation does not', () => {
  const edge = AB.wilson(22, 22)
  if (edge.high > 1 || edge.low < 0) throw new Error('an interval outside [0,1] is not an interval')
  if (edge.low >= 1) throw new Error('a perfect sample still has uncertainty at n=22')
  const none = AB.wilson(0, 5)
  if (none.low < 0 || none.high > 1) throw new Error('zero hits must not produce a negative bound')
  if (none.high <= 0) throw new Error('zero of five does not prove the rate is zero')
})

check('an empty sample is total ignorance, not zero', () => {
  const e = AB.wilson(0, 0)
  if (e.low !== 0 || e.high !== 1) throw new Error('n=0 must span the whole range - no observations is not evidence of a low rate')
})

check('overlapping intervals are NEVER reported as better or worse', () => {
  // 94% of 177 against 86% of 22 - the real numbers. Eyeballed it is a
  // regression; measured it is nothing.
  const r = AB.compare(166, 177, 19, 22, 'before', 'after')
  if (!r.overlap) throw new Error('these intervals do overlap; the test fixture is wrong')
  if (/higher|LOWER/.test(r.verdict)) throw new Error('an overlap must not be dressed as a direction')
  if (!/no detectable difference/.test(r.verdict)) throw new Error('it must say so plainly')
})

check('a real difference IS reported, with its direction', () => {
  const r = AB.compare(10, 100, 90, 100, 'before', 'after')
  if (r.overlap) throw new Error('10% against 90% at n=100 is not noise')
  if (!/higher/.test(r.verdict)) throw new Error('a real difference must name its direction')
})

check('"not significant" comes with the sample size that would settle it', () => {
  // Without it, "no detectable difference" reads as "no effect", and those are
  // different claims.
  const r = AB.compare(166, 177, 19, 22)
  if (!Number.isFinite(r.needed) || r.needed < 2) throw new Error('it must say how many observations would be needed')
  const out = AB.render(r)
  if (!/observations in EACH window/.test(out)) throw new Error('and print it')
})

check('identical rates need no sample size, and say so', () => {
  const r = AB.compare(50, 100, 25, 50)
  if (Number.isFinite(r.needed)) throw new Error('no sample separates identical rates')
  if (!/no sample size would separate them/.test(AB.render(r))) throw new Error('it must say that rather than print Infinity')
})


// ---------------------------------------------------------------------------
// the circular failure: the reaper reaches through the thing it repairs.

check('the chain names a CRITICAL step failure separately', () => {
  // The summary read "reap=FAILED lease=FAILED push-work=FAILED ..." while the
  // container volume was 100% full and every bee was dying at git worktree add.
  // Nothing about that line shouted. An audit that could not run costs a round;
  // a reaper that could not run costs the fleet.
  const code = codeOf('heal.mjs')
  if (!/const CRITICAL = new Set/.test(code)) throw new Error('the steps that free the swarm must be distinguishable')
  if (!/URGENT:/.test(code)) throw new Error('a critical failure must not print like an audit failure')
  for (const step of ['reap', 'push-work', 'land', 'close-done', 'author']) {
    if (!new RegExp(`'${step}'`).test(code.slice(code.indexOf('const CRITICAL')))) {
      throw new Error(`${step} frees the swarm and must be in the critical set`)
    }
  }
})

check('the diagnosis checks the CONTAINER volume, not only this laptop', () => {
  // The laptop was at 69% and reported healthy while the fleet was down on a
  // volume at 100%.
  const code = codeOf('why.mjs')
  if (!/workspace/.test(code)) throw new Error('nothing looks at the container volume')
  if (!/not running or in a unexpected state/.test(code)) {
    throw new Error('a refused connection is what a full volume looks like from outside, and must be read as such')
  }
})


// ---------------------------------------------------------------------------
// the audit floor, and the fourth route to "already landed".

check('the verdict audit takes its set from the DATA, not a constant', () => {
  // `select(.number >= 1347)` appeared once, with no comment, in a file where
  // every other decision carries a paragraph. It excluded 63 of the 189 pushed
  // branches - a third of the swarm's output - and 15 of those yield a promised
  // identifier this tool's own extractor accepts.
  const code = codeOf('verdict-audit.mjs')
  if (/select\(\.number>=\d+\)/.test(code)) throw new Error('an unexplained numeric floor decides what is audited')
  if (!/git branch -r --list/.test(code)) throw new Error('the set must be every issue with a pushed branch')
  if (/--limit 200/.test(code)) throw new Error('a cap two percent above the live number is a silent truncation waiting')
})

check('landed knows the fourth route: patch-id equivalence', () => {
  // The tree test catches a branch whose merge changes nothing. It does NOT
  // catch one that was cherry-picked and has since drifted - the base moved on,
  // so merging it back still changes the tree and it looks like debt for ever.
  // 46 of 67 "unmerged" branches were in this state.
  const code = codeOf('land.mjs')
  const fn = code.slice(code.indexOf('export function isLanded'), code.indexOf('export function mergesCleanly'))
  if (!/git cherry/.test(fn)) throw new Error('patch-id equivalence is the only way to see a drifted cherry-pick')
  if (!/startsWith\('\+'\)/.test(fn)) throw new Error('git cherry marks unaccounted commits with +; that is the test')
})

check('an unreadable cherry answer is not evidence of landing', () => {
  const code = codeOf('land.mjs')
  const fn = code.slice(code.indexOf('export function isLanded'), code.indexOf('export function mergesCleanly'))
  // The route now falls through to closedInBase rather than returning, so the
  // assertion is about what an unreadable answer may NOT do: it may not become
  // a "yes" from this route.
  if (!/cherry !== null/.test(fn)) throw new Error('an unreadable cherry answer must not be read by this route at all')
  if (/cherry === null[\s\S]{0,40}return true/.test(fn)) throw new Error('unreadable is never landed')
  if (!/cherry\.trim\(\) !== ''/.test(fn)) throw new Error('an EMPTY answer must not read as "no unaccounted commits"')
  if (!/closedInBase\(branch\)/.test(fn)) throw new Error('the fifth route is a different question, asked separately')
})

check('a section is read from its heading, not from the first mention of it', async () => {
  // #1090 is a brief ABOUT brief shape, so its acceptance scenario contains the
  // sentence "Given an issue body with a `## Boundary` but no
  // `## Success Criteria`". body.split(heading)[1] returns the text BETWEEN the
  // first and second occurrence - 931 characters of User Scenarios - and the
  // real criterion two sections below was never read. The audit said NO
  // MECHANICAL CLAIM and meant it.
  const { sectionOf, promisedIdentifiers } = await import('./verdict-audit.mjs')
  const body = [
    '## User Scenarios',
    '1. **Given** a body with a `## Boundary` but no `## Success Criteria`,',
    '   **Then** it is refused.',
    '',
    '## Success Criteria',
    '',
    '- `briefShape` appears nowhere in the tree today.',
    '',
    '## Boundary',
    '- src/x.ts',
  ].join('\n')
  const sec = sectionOf(body, 'Success Criteria')
  if (!sec.includes('briefShape')) throw new Error('the real section was skipped for a prose mention of its name')
  if (sec.includes('refused')) throw new Error('the section ran past its own heading into another')
  const ids = promisedIdentifiers(body)
  if (!ids.includes('briefShape')) throw new Error('the promise this tool exists to find was invisible')
})

check('a section ends at the next heading', async () => {
  const { sectionOf } = await import('./verdict-audit.mjs')
  const body = '## Success Criteria\n- a\n\n## Boundary\n- src/x.ts\n'
  const sec = sectionOf(body, 'Success Criteria')
  if (sec.includes('src/x.ts')) throw new Error('the boundary bled into the criteria')
})

check('criteria that are commands are collected as commands', async () => {
  const { promisedCommands } = await import('./verdict-audit.mjs')
  const body = [
    '## Success Criteria',
    "- `test -f docs/a.md` exits `0`.",
    "- `grep -c 'Dockerfile' docs/a.md` prints at least `1`.",
    '- `docs/b.md` exists and contains at least 30 non-empty lines.',
    '- `bun test apps/server/tests/api/x.test.ts` exits 0.',
  ].join('\n')
  const cs = promisedCommands(body)
  const kinds = cs.map((c) => c.kind).sort().join(',')
  if (kinds !== 'exists,grep,lines') throw new Error(`expected exists,grep,lines - got ${kinds}`)
  const grep = cs.find((c) => c.kind === 'grep')
  if (grep.pattern !== 'Dockerfile' || grep.atLeast !== 1) throw new Error('the pattern and the threshold must both survive')
  if (cs.some((c) => /bun test/.test(c.path))) throw new Error('bun test needs a checkout and must count as unchecked, never as passed')
})

check('a command criterion is RUN, and a count below the threshold fails', async () => {
  const { runCommandCriterion } = await import('./verdict-audit.mjs')
  const read = () => 'no match here\nnor here\n'
  const r = runCommandCriterion('b', { kind: 'grep', pattern: 'Dockerfile', path: 'docs/a.md', atLeast: 1 }, read)
  if (r.ok) throw new Error('zero matches cannot satisfy "at least 1"')
  if (!/= 0/.test(r.why)) throw new Error('the refusal must carry the number it counted')
})

check('the generous reading of a pattern wins, because an under-count is a false accusation', async () => {
  const { runCommandCriterion } = await import('./verdict-audit.mjs')
  // The criterion writes a POSIX basic regex. Read as a literal substring it
  // matches nothing here; read as a regex it matches twice. Taking the smaller
  // would convict a bee that did the work.
  const read = () => 'alpha\nbeta\n'
  const r = runCommandCriterion('b', { kind: 'grep', pattern: 'a.pha|b.ta', path: 'x', atLeast: 2 }, read)
  if (!r.ok) throw new Error('the regex reading found 2; the audit must not prefer the literal 0')
})

check('a file the branch does not have fails with the path named', async () => {
  const { runCommandCriterion } = await import('./verdict-audit.mjs')
  const r = runCommandCriterion('b', { kind: 'exists', path: 'docs/gone.md' }, () => null)
  if (r.ok) throw new Error('an absent file cannot satisfy an existence criterion')
  if (!r.why.includes('docs/gone.md')) throw new Error('name the path or nobody can act on it')
})

check('every plausible root is tried before a path is called absent', async () => {
  const { readFromBranch } = await import('./verdict-audit.mjs')
  // A brief may write docs/x.md for a file that lives at trios/docs/x.md.
  // Accusing on the auditor's guess about the root is the exact class of false
  // accusation this file already carries three scars from.
  const run = (cmd) => (cmd.includes('trios/docs/x.md') ? 'content' : null)
  if (readFromBranch('b', 'docs/x.md', run) !== 'content') throw new Error('the trios/ prefix must be tried')
  if (readFromBranch('b', 'docs/nope.md', run) !== null) throw new Error('absent under every root is absent')
})

check('an empty file is present, not missing', async () => {
  const { runCommandCriterion } = await import('./verdict-audit.mjs')
  const r = runCommandCriterion('b', { kind: 'exists', path: 'docs/empty.md' }, () => '')
  if (!r.ok) throw new Error('an empty string is a file with no bytes, not an absent file')
})

check('an exact count is checked exactly, and the pipe form is refused', async () => {
  const { promisedCommands, runCommandCriterion } = await import('./verdict-audit.mjs')
  // The L3 cleanup brief is the one this swarm files most often, and its
  // criterion is `LC_ALL=C grep -cP '...' <file>` prints 0. Verified against
  // #1485 on 2026-09-05: 3 non-ASCII lines at the fork point, 0 on the branch,
  // so the check has teeth rather than passing by construction.
  const body = [
    '## Success Criteria',
    "- `LC_ALL=C grep -cP 'x' src/a.ts` prints 0, and the raw output is quoted.",
    '- `bun run typecheck 2>&1 | grep -c src/a.ts` prints 0.',
  ].join('\n')
  const cs = promisedCommands(body)
  if (cs.length !== 1) throw new Error(`a grep with no FILE argument cannot be reproduced read-only - got ${cs.length}`)
  if (cs[0].exactly !== 0) throw new Error('"prints 0" is an exact threshold, not "at least 0"')
  if (cs[0].path !== 'src/a.ts') throw new Error('the environment prefix and the flag bundle must not swallow the path')
  if (!runCommandCriterion('b', cs[0], () => 'clean\n').ok) throw new Error('no match must satisfy "exactly 0"')
  if (runCommandCriterion('b', cs[0], () => 'has x here\n').ok) throw new Error('a match must fail "exactly 0"')
})

check('an exact count takes the faithful reading, not the convenient one', async () => {
  const { runCommandCriterion } = await import('./verdict-audit.mjs')
  // For "at least N" the generous count protects an innocent bee. For "exactly
  // 0" generosity runs the other way and waves a real violation through, which
  // is the failure this whole file exists to avoid.
  const c = { kind: 'grep', pattern: 'a.c', path: 'x', exactly: 0 }
  const r = runCommandCriterion('b', c, () => 'abc\n')
  if (r.ok) throw new Error('the regex matches; an exact-zero criterion must not fall back to the literal reading that does not')
  if (!/as a regex/.test(r.why)) throw new Error('say which reading was used, or the number cannot be argued with')
})

check('the words around the number are part of the criterion', async () => {
  const { promisedCommands, runCommandCriterion } = await import('./verdict-audit.mjs')
  // #1326: "prints `2` or more". Read as "exactly 2" it convicted a bee whose
  // file had 3 - which is what the criterion asked for.
  const body = [
    '## Success Criteria',
    "- `grep -c 'x' docs/a.md` prints `2` or more.",
    "- `grep -c 'y' docs/a.md` prints `2`.",
    "- `grep -c 'z' docs/a.md` prints `2` or fewer.",
  ].join('\n')
  const [more, exact, fewer] = promisedCommands(body)
  if (more.atLeast !== 2 || more.exactly !== undefined) throw new Error('"or more" is a lower bound, not an equality')
  if (exact.exactly !== 2) throw new Error('a bare number is an equality')
  if (fewer.atMost !== 2) throw new Error('"or fewer" is an upper bound')
  const three = () => 'x\nx\nx\n'
  if (!runCommandCriterion('b', more, three).ok) throw new Error('3 satisfies "2 or more"')
  if (runCommandCriterion('b', { ...exact, pattern: 'x' }, three).ok) throw new Error('3 does not satisfy "exactly 2"')
  if (runCommandCriterion('b', { ...fewer, pattern: 'x' }, three).ok) throw new Error('3 does not satisfy "2 or fewer"')
})

check('a BRE pattern is read as BRE, and an unreadable one is not a conviction', async () => {
  const { breToJs, runCommandCriterion, dialectOf } = await import('./verdict-audit.mjs')
  // #1324: `grep -c '^  it(' <file>`. In BRE the paren is an ordinary
  // character; handed to new RegExp it throws, and falling back to a literal
  // search counted 0 and accused a bee whose test file was full of them.
  if (dialectOf('-c') !== 'bre' || dialectOf('-cP') !== 'pcre' || dialectOf('-cE') !== 'ere') {
    throw new Error('the flag bundle says which language the pattern is in')
  }
  if (breToJs('^  it(') !== '^  it\\(') throw new Error('a bare paren is literal in BRE')
  if (breToJs('a\\|b') !== 'a|b') throw new Error('a BACKSLASHED pipe is the alternation in BRE')
  const c = { kind: 'grep', dialect: 'bre', pattern: '^  it(', path: 'x', atLeast: 1 }
  if (!runCommandCriterion('b', c, () => '  it(\'works\', () => {})\n').ok) throw new Error('the bee wrote exactly what was asked for')
  const bad = { kind: 'grep', dialect: 'pcre', pattern: '(?<', path: 'x', atLeast: 1 }
  const r = runCommandCriterion('b', bad, () => 'anything\n')
  if (r.ok !== null) throw new Error('a pattern this cannot read is unchecked, never failed')
})

check('a criterion true before the work proves nothing', async () => {
  const { runCommandCriterion } = await import('./verdict-audit.mjs')
  // FAIL_TO_PASS. SWE-bench excludes an instance with no fail-to-pass
  // transition because pass-to-pass alone is satisfiable by an EMPTY PATCH -
  // and this audit had only the pass-to-pass half for its whole life.
  const c = { kind: 'grep', dialect: 'bre', pattern: 'x', path: 'a', atLeast: 1 }
  const already = () => 'x is here\n'
  const before = runCommandCriterion('base', c, already)
  const after = runCommandCriterion('branch', c, already)
  if (!before.ok || !after.ok) throw new Error('both sides pass; this is the vacuous case')
  // and the transition the audit derives from that pair must not read as proof
  const transition = before.ok && after.ok ? 'vacuous' : 'proven'
  if (transition !== 'vacuous') throw new Error('pass -> pass is vacuous, never proven')
})

check('the four transitions are distinguished', async () => {
  const { runCommandCriterion } = await import('./verdict-audit.mjs')
  const c = { kind: 'grep', dialect: 'bre', pattern: 'ok', path: 'a', atLeast: 1 }
  const has = () => 'ok\n'
  const lacks = () => 'nothing\n'
  const t = (b, a) => {
    const before = runCommandCriterion('base', c, b)
    const after = runCommandCriterion('branch', c, a)
    return before.ok && after.ok ? 'vacuous'
      : !before.ok && after.ok ? 'proven'
        : before.ok && !after.ok ? 'regression' : 'unsupported'
  }
  if (t(lacks, has) !== 'proven') throw new Error('fail -> pass is the only thing that proves the work did something')
  if (t(has, has) !== 'vacuous') throw new Error('pass -> pass')
  if (t(has, lacks) !== 'regression') throw new Error('pass -> fail is worse than unsupported and must be named')
  if (t(lacks, lacks) !== 'unsupported') throw new Error('fail -> fail')
})

check('a criterion the branch cannot answer is never asked of the fork point', () => {
  const code = codeOf('verdict-audit.mjs')
  // Running an unreadable pattern twice produces two nulls and a wasted git
  // call per criterion across two hundred branches.
  if (!/after\.ok === null \? \{ ok: null \}/.test(code)) {
    throw new Error('an unreadable criterion has no before-state worth computing')
  }
})

check('the audit cache is keyed on the work, and never remembers a failure to read', async () => {
  const { cacheKey } = await import('./verdict-audit.mjs')
  // Both halves matter. The branch tip alone would serve a stale verdict after
  // the base moved and changed the fork point the criteria are measured from.
  if (cacheKey('aaa', 'bbb') === cacheKey('aaa', 'ccc')) throw new Error('the fork point is part of the question')
  if (cacheKey('aaa', 'bbb') === cacheKey('zzz', 'bbb')) throw new Error('the branch tip is another part')
  // And the rules themselves. Widening the absence vocabulary took the fresh
  // count from 2 unsupported claims to 6, and the next cached pass served the
  // old 2 back - verdicts a different program had reached.
  if (cacheKey('a', 'b', 'v1') === cacheKey('a', 'b', 'v2')) {
    throw new Error('a verdict reached under different rules is not this verdict')
  }
  const code = codeOf('verdict-audit.mjs')
  if (!/verdict !== 'NO ISSUE'/.test(code)) {
    throw new Error('NO ISSUE is a network failure; caching it turns one bad minute into a permanent answer')
  }
  if (!/--fresh/.test(code)) throw new Error('a cache with no way past it is a cache that will be wrong one day with no recourse')
})

check('the fork point is computed before the expensive call', () => {
  const code = codeOf('verdict-audit.mjs')
  const fn = code.slice(code.indexOf('export function auditIssue'))
  const base = fn.indexOf('git merge-base')
  const body = fn.indexOf('gh issue view')
  if (base < 0 || body < 0) throw new Error('both calls must still be there')
  if (base > body) throw new Error('gh issue view is the dominant cost and the cache exists to avoid it; the key must be built first')
})

check('an identifier is measured in the tree, never guessed from the diff', async () => {
  const { inTree } = await import('./verdict-audit.mjs')
  // Four false accusations came from guessing at definition syntax: a Swift
  // enum case, two methods on an object literal, and a function in a new file
  // reached by import. All four identifiers were really there.
  const run = (cmd) => (cmd.includes('connectionFailed') ? 'trios/rings/SR-00/Transport.swift' : null)
  if (!inTree('branch', 'connectionFailed', run)) throw new Error('a Swift enum case is in the tree like anything else')
  if (inTree('branch', 'neverWritten', run)) throw new Error('absent is absent')
  if (inTree('branch', 'not-an-identifier', run)) throw new Error('only an identifier may be looked up as one')
})

check('a verdict resting on nothing that changed is named vacuous, not supported', () => {
  const code = codeOf('verdict-audit.mjs')
  if (!/anythingProven === 0/.test(code)) throw new Error('one rule must cover identifiers and commands alike')
  if (!/VACUOUS CLAIM/.test(code)) throw new Error('pass-to-pass with no fail-to-pass has a name')
})

check('the proven rate is measured over what could be judged, not over everything', async () => {
  const { rate } = await import('./proven.mjs')
  // A brief with nothing mechanical in it is evidence about the BRIEF. Counting
  // it as a failure of the swarm makes both numbers unreadable.
  const r = rate([
    { verdict: 'SUPPORTED' }, { verdict: 'SUPPORTED' },
    { verdict: 'VACUOUS CLAIM' }, { verdict: 'CLAIM UNSUPPORTED' },
    { verdict: 'NO MECHANICAL CLAIM' }, { verdict: 'NO BRANCH' },
  ])
  if (r.checkable !== 4) throw new Error(`the denominator is the judged work - got ${r.checkable}`)
  if (r.proven !== 2) throw new Error('only SUPPORTED proves anything')
  if (r.total !== 6) throw new Error('the total is still reported, so the gap is visible')
})

check('a drop inside the noise is never called a regression', async () => {
  const { assess } = await import('./proven.mjs')
  const AB = await import('./ab.mjs')
  const win = (proven, n) => Array.from({ length: n }, (_, i) => ({
    number: 2000 - i, verdict: i < proven ? 'SUPPORTED' : 'VACUOUS CLAIM',
  }))
  // 18/20 against 95/100: lower, and nowhere near separable at n=20.
  const a = assess(win(18, 20), win(95, 100), AB.compare)
  if (a.act === 'now') throw new Error('overlapping intervals cannot license "act"')
  if (a.act !== 'watch') throw new Error('a lower point estimate is still worth watching; the two tiers are different messages')
})

check('a separated drop does license acting', async () => {
  const { assess } = await import('./proven.mjs')
  const AB = await import('./ab.mjs')
  const win = (proven, n) => Array.from({ length: n }, (_, i) => ({
    number: 2000 - i, verdict: i < proven ? 'SUPPORTED' : 'VACUOUS CLAIM',
  }))
  const a = assess(win(10, 40), win(98, 100), AB.compare)
  if (a.act !== 'now') throw new Error('25% against 98% on these samples is not noise')
})

check('a recent window that is BETTER never raises anything', async () => {
  const { assess } = await import('./proven.mjs')
  const AB = await import('./ab.mjs')
  const win = (proven, n) => Array.from({ length: n }, (_, i) => ({
    number: 2000 - i, verdict: i < proven ? 'SUPPORTED' : 'VACUOUS CLAIM',
  }))
  const a = assess(win(40, 40), win(50, 100), AB.compare)
  if (a.act !== 'none') throw new Error('improving is not an incident')
})

check('an empty window is not a finding', async () => {
  const { assess } = await import('./proven.mjs')
  const AB = await import('./ab.mjs')
  const a = assess([], [{ number: 1, verdict: 'SUPPORTED' }], AB.compare)
  if (a.act !== 'none') throw new Error('nothing to compare is not evidence of anything')
  if (!/not enough judged work/.test(a.why || '')) throw new Error('say why there is no answer')
})

check('the newest verdicts are the recent window', async () => {
  const { split } = await import('./proven.mjs')
  const rows = [{ number: 1 }, { number: 500 }, { number: 100 }, { number: 900 }]
  const { recent, baseline } = split(rows, 2)
  if (recent.map((r) => r.number).join(',') !== '900,500') throw new Error('recent means newest')
  if (baseline.length !== 2) throw new Error('everything else is the baseline')
})

check('a finding from coverage is not a broken step', () => {
  const code = codeOf('heal.mjs')
  // The tool exits non-zero when it has something to say. Reporting that as
  // FAILED buries the finding under the word this chain uses for "broken".
  if (!/FINDING/.test(code)) throw new Error('a finding needs its own status')
  if (!/ACT NOW:/.test(code)) throw new Error('the chain must read the tool\'s own words, not its exit code alone')
})

check('the audits do not pay for the freeing steps', () => {
  const code = codeOf('heal.mjs')
  // One deadline for the whole chain meant reap, push-work, land, close-done
  // and author consumed all eight minutes and verdict-audit, proven and
  // judge-packet were SKIPPED - the chain reporting itself complete with a
  // third of its steps never run.
  if (!/REPORT_DEADLINE_MS/.test(code)) throw new Error('the reporting phase needs a budget of its own')
  if (!/reportsOnly/.test(code)) throw new Error('the line between freeing and reporting must be data, not prose')
  if (!/reportPhaseStartedAt/.test(code)) throw new Error('the report budget starts when the report phase does, not when the chain did')
})

check('a carried change is landed, and a mention of it is not', async () => {
  const { closedInBase } = await import('./land.mjs')
  // Every content route compares bytes. A carry is re-cut onto a fresh base and
  // squash-merged, so it has a new tree and a new patch-id and nothing
  // byte-shaped can connect it back. Three of the nine branches jamming the
  // pipeline on 2026-09-05 were finished work in exactly this state.
  const msg = (s) => () => s
  if (!closedInBase('queen-1310', msg('feat: something\n\nCloses #1310\n'))) throw new Error('Closes is L1 of this repo and must count')
  if (!closedInBase('queen-1310', msg('feat(queen): explain idle paid slots (#1310)\n'))) throw new Error('a squash subject records the issue')
  // The real shape: the issue, then the pull request that merged it. Demanding
  // (#N) at the very end of the line rejected the exact case this exists for.
  if (!closedInBase('queen-1310', msg('feat(queen): explain idle paid slots (#1310) (#330)\n'))) {
    throw new Error('a trailing chain of references is still a subject')
  }
  if (!closedInBase('queen-1308', msg('feat(queen): carry #1308 onto the supervisor base\n'))) throw new Error('a carry says so in words')
  // ...and the mentions that must NOT count.
  if (closedInBase('queen-1421', msg('unlike (#1421), this one does something else\n'))) {
    throw new Error('a parenthetical mid-sentence is not a squash subject')
  }
  if (closedInBase('queen-1310', msg('this is unrelated to #1310 and does not close it\n'))) {
    throw new Error('a bare mention closes nothing')
  }
  if (closedInBase('queen-131', msg('Closes #1310\n'))) throw new Error('#131 is not #1310')
  if (closedInBase('not-a-queen-branch', msg('Closes #1310\n'))) throw new Error('only a queen-N branch has an issue number')
})

check('close-done and land agree about what landed, because it is one rule', () => {
  const code = codeOf('close-done.mjs')
  // This file carried its own copy of the tree test while land.mjs grew four
  // more routes it never learned. Nine branches conflicted, four were finished
  // work, and close-done went on refusing to close their issues.
  if (!/LAND\.isLanded/.test(code)) throw new Error('the landing rule lives in land.mjs and is asked, not re-implemented')
  if (/const landed = baseTree && mergedTree/.test(code)) throw new Error('the second copy of the rule must be gone, not merely bypassed')
})

check('merge-tree prose is not a conflicting path', async () => {
  const { baseMovedSince } = await import('./land.mjs')
  const code = codeOf('land.mjs')
  // `--name-only` interleaves "Auto-merging X" and "CONFLICT (add/add): ..."
  // with the paths. Counting them reported six conflicting paths for three
  // files - the kind of inflated number that makes a report stop being read.
  if (!/\^\(Auto-merging\|CONFLICT \)/.test(code)) throw new Error('the commentary lines must be filtered out')
  if (!/a\.indexOf\(p\) === i/.test(code)) throw new Error('and a path named twice is one file')
  // A base that has not moved says nothing rather than saying zero.
  if (baseMovedSince('queen-1', [], () => 'abc') !== null) throw new Error('no paths, no claim')
  if (baseMovedSince('queen-1', ['a.ts'], () => '0') !== null) throw new Error('zero commits is not a finding')
})

check('asking four questions at once needs a wider threshold', async () => {
  const AB = await import('./ab.mjs')
  // Four groups tested at 95% each carry a 19% chance one comes back
  // significant with nothing wrong anywhere. A dashboard that does that gets
  // muted, and then the real finding is missed too.
  if (Math.abs(AB.probit(0.975) - 1.959964) > 1e-4) throw new Error('probit(0.975) is 1.96 by definition')
  if (Math.abs(AB.probit(0.995) - 2.575829) > 1e-4) throw new Error('probit(0.995) is 2.5758')
  if (!(AB.zForFamily(4) > AB.zForFamily(1))) throw new Error('more comparisons must mean a stricter threshold')
  if (Math.abs(AB.zForFamily(1) - 1.96) > 1e-3) throw new Error('one comparison is the uncorrected case')
  // and the correction must actually reach compare()
  const loose = AB.compare(90, 100, 80, 100, 'a', 'b', AB.zForFamily(1))
  const strict = AB.compare(90, 100, 80, 100, 'a', 'b', AB.zForFamily(4))
  if (!(strict.a.high - strict.a.low > loose.a.high - loose.a.low)) {
    throw new Error('the corrected interval must be wider, or the correction is decorative')
  }
})

check('a group is compared with the rest, never with itself included', async () => {
  const { bySource } = await import('./proven.mjs')
  const AB = await import('./ab.mjs')
  // A group inside its own baseline drags that baseline toward itself, which
  // shrinks every difference and hides the outlier the split was made to find.
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ number: 100 + i, verdict: 'VACUOUS CLAIM' })),
    ...Array.from({ length: 10 }, (_, i) => ({ number: 200 + i, verdict: 'SUPPORTED' })),
  ]
  const titleOf = (n) => (n < 200 ? 'x breaks L3 with 3 non-ASCII characters' : 'something a person wrote')
  const out = bySource(rows, titleOf, AB.compare, AB.zForFamily(2))
  const ascii = out.find((g) => g.kind === 'ascii')
  if (ascii.mine.proven !== 0) throw new Error('the group is its own rows')
  if (ascii.rest.proven !== 10 || ascii.rest.checkable !== 10) {
    throw new Error(`the baseline must EXCLUDE the group - got ${ascii.rest.proven}/${ascii.rest.checkable}`)
  }
  if (ascii.act !== 'now') throw new Error('0% against 100% at n=10 each is not noise')
})

check('the kind of work is read from the title, and unknown is a real bucket', async () => {
  const { classify } = await import('./proven.mjs')
  if (classify('src/a.ts breaks L3 with 12 non-ASCII characters, all of them in comments') !== 'ascii') throw new Error('ascii')
  if (classify('src/a.ts exports 4 symbols and no test names any of them') !== 'untested') throw new Error('untested')
  if (classify('src/a.ts exports one symbol and no test names any of them') !== 'untested') throw new Error('the singular form too')
  if (classify('src/a.ts is 900 lines, and nothing has ever said what is inside it') !== 'length') throw new Error('length')
  if (classify('The Queen reads four success criteria and then tells the bee otherwise') !== 'other') throw new Error('hand-written work is its own group, not a dumping ground')
  if (classify(undefined) !== 'other') throw new Error('a title this cannot read is other, never a guess')
})

check('a deletion is not work, and a modification still is', async () => {
  const { holdsWork } = await import('./reap-local.mjs')
  // Two workflow worktrees were spared as "somebody's unfinished thought" on
  // 1983 changes each, every one a deletion, holding 4.4 GB of nothing while
  // the laptop sat at 98% and dispatches died part-way through checkout.
  if (holdsWork(' D a.ts\n D b.ts\n').work) throw new Error('deletions of files HEAD still has hold nothing')
  if (holdsWork('D  a.ts\n').work) throw new Error('a staged deletion is still a deletion')
  if (!holdsWork(' M a.ts\n').work) throw new Error('a modification is a thought')
  if (!holdsWork('?? new.ts\n').work) throw new Error('an untracked file is work nobody else has')
  if (!holdsWork(' D a.ts\n M b.ts\n').work) throw new Error('one modification among deletions is still work')
  if (holdsWork('').work) throw new Error('a clean tree holds nothing')
  const mixed = holdsWork(' D a.ts\n M b.ts\n')
  if (mixed.deletions !== 1 || mixed.other !== 1) throw new Error('both counts are reported so the refusal can be argued with')
})

check('a deletions-only tree is restored and removed, never forced', () => {
  const code = codeOf('reap-local.mjs')
  if (/worktree remove[^\n]*--force/.test(code)) throw new Error('--force is not used on a worktree in this project, ever')
  if (!/git checkout -- \./.test(code)) throw new Error('restore from HEAD is what makes the removal ordinary')
  if (!/deletionsOnly/.test(code)) throw new Error('only a tree whose every change is a deletion may be restored this way')
  // and the restore must be gated on the removal having refused first
  const i = code.indexOf('git worktree remove')
  const j = code.indexOf('git checkout -- .')
  if (!(i > -1 && j > i)) throw new Error('try the ordinary removal before touching the tree at all')
})

check('the reaper does not promise megabytes it cannot return', () => {
  const code = codeOf('reap-local.mjs')
  // du walks a worktree as if it owned every byte. Three trees reported as
  // holding 6938 MB were removed and free space moved by about 600.
  if (!/UPPER BOUND/.test(code)) throw new Error('the du figure must be labelled as the upper bound it is')
  if (/freeing about \$\{freed\} MB/.test(code)) throw new Error('"freeing about N MB" was a promise the tool could not keep')
})

check('salvage proposes names, not tokens, and never a hex fixture', async () => {
  const { candidates, NOISE } = await import('./salvage.mjs')
  const c = candidates([
    '+const quotaAuthority = readTelemetry()',
    '+  const sha = "fedcba9876"',
    '+export function quotaAuthority() {}',
  ])
  const ids = c.map((x) => x.id)
  if (!ids.includes('quotaAuthority')) throw new Error('a name the branch introduces is the point')
  if (c.find((x) => x.id === 'quotaAuthority').n !== 2) throw new Error('frequency orders the candidates')
  if (ids.includes('fedcba9876')) throw new Error('a hex blob is a fixture, not a capability the repository lacks')
  if (ids.includes('const') || ids.includes('export')) throw new Error('a keyword is not a contribution')
  if (!NOISE.has('describe')) throw new Error('test scaffolding is noise too')
})

check('salvage measures absence in the tree, in any language', async () => {
  const { inTree, surviving } = await import('./salvage.mjs')
  // A Swift enum case, an object-literal method and a function reached by
  // import are all "defined" differently and all present in the tree the same
  // way. Absence needs no parser.
  const run = (cmd) => (cmd.includes('connectionFailed') ? 'a/b/Transport.swift' : null)
  if (!inTree('ref', 'connectionFailed', run)) throw new Error('present is present')
  if (inTree('ref', 'neverWritten', run)) throw new Error('absent is absent')
  if (inTree('ref', 'not-an-identifier', run)) throw new Error('only an identifier is looked up as one')
  // No fork point means no comparison, and no answer is better than a wrong one.
  if (surviving('nope', { run: () => null }) !== null) throw new Error('a branch with no fork point cannot be compared')
})

check('salvage refuses to call itself a patch', () => {
  const code = codeOf('salvage.mjs')
  // Rebasing #1302 would have deleted #1308's landed work and reintroduced a
  // non-ASCII character into a file governed by L3 - and a clean rebase would
  // not have shown either, because a semantic conflict carries no markers.
  if (/git rebase|cherry-pick|git apply/.test(code)) throw new Error('this tool must never apply anything')
  if (!/SPECIFICATION OF INTENT/.test(code)) throw new Error('the old branch is a statement of what was wanted, not a patch')
  if (!/semantic conflict/i.test(code)) throw new Error('"it applied cleanly" is not evidence and the file must say so')
})

check('a generated brief is fail-to-pass by construction', async () => {
  const { brief } = await import('./salvage.mjs')
  const out = brief({
    branch: 'queen-1', files: ['a/b.ts', 'a/b.test.ts'], addedLines: 10,
    candidates: 20, examined: 20, missing: [{ id: 'thingOne', n: 3 }],
  })
  if (!/appears nowhere in the tree today/.test(out)) {
    throw new Error('the criterion must assert absence, which is what makes it fail at the fork point')
  }
  if (!/## Boundary/.test(out) || !/## Success Criteria/.test(out)) throw new Error('the delegation gate demands both sections')
  if (!/ASCII-only/.test(out)) throw new Error('L3 is the law the sibling branch broke; do not inherit it')
  if (/copied from/.test(out) && !/not\s+copied from/.test(out)) throw new Error('the brief must forbid copying the old file')
})

check('a branch removes as well as adds, and the name measure cannot see it', async () => {
  const { unappliedRemovals } = await import('./salvage.mjs')
  // A tool that only counts additions is blind to every cleanup, rename and
  // deletion. What the branch took out and the base still has is the work left.
  const run = (cmd) => {
    if (cmd.includes('git diff')) return '-  const stale = "this line is long enough"\n-  short\n'
    if (cmd.includes('git show')) return 'unrelated\n  const stale = "this line is long enough"\n'
    return null
  }
  const out = unappliedRemovals('queen-1', 'fork', ['a.ts'], run)
  if (out.length !== 1 || out[0].count !== 1) throw new Error('a removed line the base still has is work still to do')
  if (out[0].sample[0].includes('short')) throw new Error('a short line matches everywhere and means nothing')
})

check('salvage asks the issue its own question, and that answer outranks the heuristics', async () => {
  const { criteriaAgainstBase } = await import('./salvage.mjs')
  // #1484: ten new names all present in the base (name measure says superseded),
  // the file rewritten so removed lines do not match (removal measure silent),
  // and its own criterion failing on the base with five non-ASCII lines.
  const VA = {
    promisedCommands: () => [{ kind: 'grep', dialect: 'bre', pattern: 'x', path: 'a.ts', exactly: 0 }],
    runCommandCriterion: () => ({ ok: false, why: 'grep = 5, criterion asked for exactly 0' }),
  }
  const r = await criteriaAgainstBase(1484, { VA, body: '## Success Criteria\n- anything' })
  if (r.failing.length !== 1) throw new Error('a criterion failing on the base means the work is not done')
  // A criterion marked as a BASELINE describes the fork point and must not be
  // asked of the base as though it were a target.
  const VB = {
    promisedCommands: () => [{ kind: 'grep', when: 'before', pattern: 'x', path: 'a.ts', exactly: 13 }],
    runCommandCriterion: () => ({ ok: false, why: 'should never be called' }),
  }
  const r2 = await criteriaAgainstBase(1, { VA: VB, body: 'x' })
  if (r2.checked !== 0) throw new Error('a baseline is not a target and must not be asked of the base')
})

check('an unmeasurable branch says so instead of saying superseded', () => {
  const code = codeOf('salvage.mjs')
  // The first version concluded "close it as superseded" from a single blind
  // measure, which would have thrown away an open L3 fix.
  if (/Close it as superseded rather than rebasing/.test(code)) {
    throw new Error('one blind measure must not license closing an issue')
  }
  if (!/not the same as nothing left to do/.test(code)) throw new Error('no missing vocabulary is not no work left')
  if (!/a reader still decides/.test(code)) throw new Error('the tool measures; the person concludes')
})

check('a replacement is written down, never inferred', async () => {
  const LAND = await import('./land.mjs')
  const code = codeOf('land.mjs')
  // Five branches conflicted for four rounds and the warning was mechanically
  // true and useless: they will never land. Recording the issue that replaces
  // one is a deliberate act - nothing here GUESSES that a branch is superseded.
  if (!/recordReplacement/.test(code)) throw new Error('a replacement must be recorded by someone')
  if (typeof LAND.replacements() !== 'object') throw new Error('and readable back')
  if (/git push --delete|branch -D|--force/.test(code)) throw new Error('nothing about this is destructive; the branches stay')
})

check('land no longer advises a rebase it knows is usually wrong', () => {
  const code = codeOf('land.mjs')
  // Rebasing #1302 would have deleted #1308's landed work and reintroduced an
  // L3 violation, and the tool recommended it in one line for four rounds.
  if (/these need a\s+rebase/.test(code)) throw new Error('that advice was toward destroying finished code')
  if (!/tri salvage/.test(code)) throw new Error('point at the tool that measures instead of guessing')
  if (!/semantic conflict/.test(code)) throw new Error('and say why "it applied cleanly" is not evidence')
})

check('a dropped connection is retried, not fatal', async () => {
  const { isChannelFailure } = await import('./push-work.mjs')
  // This step is the ONLY way a bee's work leaves the container. It threw on
  // one timeout and three ACCEPTED pieces of work - 9 to 15 minutes of a bee
  // each - stayed invisible until a retry pushed thirteen branches.
  for (const s of [
    'Operation timed out (os error 60)',
    'Connection reset by peer',
    'client error (SendRequest)',
    'connect ETIMEDOUT 1.2.3.4:443',
    '502 Bad Gateway',
  ]) if (!isChannelFailure(s)) throw new Error(`a channel failure must be recognised: ${s}`)
  // ...and a real git answer must NOT be retried, because it is an answer.
  for (const s of [
    '! [rejected] queen-1 -> queen-1 (non-fast-forward)',
    'error: failed to push some refs',
    'fatal: not a git repository',
  ]) if (isChannelFailure(s)) throw new Error(`a git answer is not a channel failure: ${s}`)
})

check('push-work distinguishes "could not look" from "nothing to push"', () => {
  const code = codeOf('push-work.mjs')
  // Both runs end without pushing anything and only one of them is fine. The
  // chain reads this step's words, so the words have to be different.
  if (!/COULD NOT REACH THE CONTAINER/.test(code)) throw new Error('the failure must name itself')
  if (!/NOT "nothing to push"/.test(code)) throw new Error('and say what it is not')
  if (!/e\.channel/.test(code)) throw new Error('a channel failure needs its own kind, not a string match at the top level')
})

check('a failed step records WHY, not only that it failed', () => {
  // push-work ran 66 times in the ledger and 47 were not ok. All 46 FAILED
  // entries carry an empty summary, because `line` is set only when a SUMMARY
  // pattern matches and no pattern matches a failure. The console had the
  // reason. The record did not, and it cannot be recovered.
  for (const f of ['heal.mjs', 'feed.mjs']) {
    const code = codeOf(f)
    if (!/evidence:/.test(code)) throw new Error(`${f} must keep the failing output, not only print it`)
    if (!/slice\(-6\)/.test(code)) throw new Error(`${f} must keep the last lines, where the reason lives`)
  }
})

check('the four steps that free the swarm share one channel, with one retry', async () => {
  const CH = await import('./channel.mjs')
  // Asked of the whole ledger for the first time on 2026-09-05: reap 45 of 63
  // failed, lease 43 of 63, push-work 46 of 70, close-done 32 of 70. All four
  // reach the container through railway ssh and each carried its own copy of
  // the call. None retried.
  for (const f of ['reap.mjs', 'lease.mjs', 'close-done.mjs', 'push-work.mjs']) {
    const code = codeOf(f)
    if (!/CH\.remote/.test(code)) throw new Error(`${f} must ask the shared channel, not carry a fifth copy`)
    if (/execSync\(`\$\{RAILWAY\}/.test(code)) throw new Error(`${f} still has its own copy of the call`)
  }
  // A channel failure is retried; an ANSWER is not.
  if (!CH.isChannelFailure('Operation timed out (os error 60)')) throw new Error('a dropped connection is a channel failure')
  if (CH.isChannelFailure('! [rejected] queen-1 -> queen-1 (non-fast-forward)')) {
    throw new Error('a rejected ref is the command answering, and retrying an answer is as wrong as crashing on a drop')
  }
})

check('the channel tells "found nothing" from "never looked"', async () => {
  const CH = await import('./channel.mjs')
  // The breaker is per-PROCESS and this harness is one process, so each case
  // starts from a channel that has not yet been found down. In production every
  // run is a fresh process and gets the same clean start.
  CH.resetChannel()
  let slept = 0
  const drop = () => { const e = new Error('Operation timed out (os error 60)'); e.stderr = ''; throw e }
  try {
    CH.remote('x', { run: drop, sleep: () => { slept++ }, onRetry: () => {}, attempts: 3 })
    throw new Error('a channel that never connected must not return quietly')
  } catch (e) {
    if (!e.channel) throw new Error('the failure must be marked, so a caller can tell it from an empty answer')
    if (slept !== 2) throw new Error(`three attempts means two waits - got ${slept}`)
  }
  // And an answer comes straight back, unretried.
  CH.resetChannel()
  let calls = 0
  const answer = () => { calls++; const e = new Error('error: failed to push some refs'); e.stdout = 'x'; throw e }
  try { CH.remote('x', { run: answer, sleep: () => {}, onRetry: () => {} }) } catch { /* expected */ }
  if (calls !== 1) throw new Error(`an answer must not be retried - it was asked ${calls} times`)
})

check('failures.mjs counts runs beside failures', async () => {
  const { tally } = await import('./failures.mjs')
  // 0 of 0 and 0 of 66 are different states and a bare failure count cannot
  // tell them apart. A step that has never run is not healthy.
  const rows = [
    { at: '2026-09-05T00:00:00Z', results: [{ step: 'a', status: 'FAILED', evidence: 'boom' }, { step: 'b', status: 'ok' }] },
    { at: '2026-09-05T01:00:00Z', results: [{ step: 'a', status: 'ok' }] },
  ]
  const t = tally(rows)
  const a = t.find((r) => r.step === 'a')
  if (a.runs !== 2 || a.failed !== 1) throw new Error('runs and failures are both reported')
  if (a.evidence[0].text !== 'boom') throw new Error('the recorded reason must be readable back')
  if (t.find((r) => r.step === 'b').failed !== 0) throw new Error('an ok step has no failures')
})

check('an unmeasurable fact is null, never a remembered number', async () => {
  const { measure, rows } = await import('./dash.mjs')
  // I wrote "dispatches finished 258" into iteration #46. The last measurement
  // had said 255. Nothing was wrong with the swarm; the number was invented, in
  // the one artifact whose whole job is to say what is true.
  if (measure(() => { throw new Error('down') }) !== null) throw new Error('a measurement that could not be taken is null')
  if (measure(() => undefined) !== null) throw new Error('and so is one that returned nothing')
  if (measure(() => 0) !== 0) throw new Error('but zero is a real answer and must survive')
  const r = rows({ swarm: null, proven: null, worstStep: null, selftest: null, disk: null }, null)
  if (r.some((x) => x.v !== null)) throw new Error('no fact may be filled in when nothing was measured')
})

check('a non-zero exit is read as an answer, not as a failed measurement', () => {
  const code = codeOf('dash.mjs')
  // failures.mjs exits 2 when a step is failing more than a quarter of the
  // time - that is the tool working - and reap-local exits 1 to mean "would
  // act". Reading either as an error printed `-` for facts already measured.
  if (!/e\.killed \|\| e\.signal/.test(code)) throw new Error('only a signal or a timeout means the measurement was not taken')
  if (!/e\.stdout/.test(code)) throw new Error('the output of a non-zero exit is still the answer')
})

check('the delta is measured too, from the last recorded reading', async () => {
  const { rows } = await import('./dash.mjs')
  const r = rows({ swarm: { running: 4, finished: 258 } }, { swarm: { running: 4, finished: 255 } })
  const fin = r.find((x) => x.k === 'dispatches finished')
  if (fin.v !== 258 || fin.prev !== 255) throw new Error('previous comes from the record, not from memory')
})

check('the classifier is built from the record, not from one observation', async () => {
  const CH = await import('./channel.mjs')
  // I saw ONE failure by hand and wrote a classifier from it, while holding a
  // ledger with 174 recorded failures I had not read. When the evidence field
  // started recording reasons an hour later, NONE of the three that arrived
  // matched. The retry never fired for any real failure in this system.
  //
  // These are those strings, verbatim.
  const real = {
    'Your application is not running or in a unexpected state': 'app-down',
    'Expected welcome message, received: ServerMessage { type: "error" }': 'app-down',
    'Failed to establish connection after 3 attempts: IO error: failed to load system trust settings: I/O error.': 'local',
    'Operation timed out (os error 60)': 'transport',
  }
  for (const [text, kind] of Object.entries(real)) {
    const got = CH.classifyFailure(text).kind
    if (got !== kind) throw new Error(`"${text.slice(0, 40)}" is ${kind}, classified as ${got}`)
  }
})

check('each kind gets the response it deserves', async () => {
  const CH = await import('./channel.mjs')
  // One retry policy cannot be right for three different problems.
  const app = CH.classifyFailure('Your application is not running or in a unexpected state')
  if (!app.retry || app.waitMultiplier <= 1) throw new Error('a restarting service needs a LONGER wait, not the same one')
  const local = CH.classifyFailure('failed to load system trust settings: I/O error')
  if (local.retry) throw new Error('retrying the same call cannot fix a trust store this machine cannot read')
  if (!/THIS machine/.test(local.advice)) throw new Error('say it is local, or the container gets chased all night')
  const unknown = CH.classifyFailure('something nobody has seen before')
  if (unknown.retry) throw new Error('an unrecognised failure is printed verbatim, never retried on a guess')
})

check('a local failure is never reported as the container being down', async () => {
  const CH = await import('./channel.mjs')
  CH.resetChannel()
  let waited = 0
  const fail = () => { const e = new Error('IO error: failed to load system trust settings: I/O error.'); e.stderr = ''; throw e }
  try {
    CH.remote('x', { run: fail, sleep: () => { waited++ }, onRetry: () => {}, attempts: 3 })
    throw new Error('it must still fail')
  } catch (e) {
    if (waited !== 0) throw new Error('a local trust-store failure must not be retried at all')
    if (e.channelKind !== 'local') throw new Error('the kind travels with the error so the caller reports the right problem')
  }
})

check('one outage is one fact, not four failures', async () => {
  const CH = await import('./channel.mjs')
  // Across 62 heal runs: when reap succeeded the three steps after it failed
  // 0%, 7% and 0%. When reap failed they failed 96%, 96% and 66%. They share a
  // condition that holds for the whole run - and recording it once per step is
  // what inflated every rate this loop has quoted.
  CH.resetChannel()
  let asked = 0
  const shut = () => { asked++; const e = new Error('Your application is not running or in a unexpected state'); e.stderr = ''; throw e }
  try { CH.remote('a', { run: shut, sleep: () => {}, onRetry: () => {}, attempts: 2 }) } catch { /* expected */ }
  const afterFirst = asked
  try {
    CH.remote('b', { run: shut, sleep: () => {}, onRetry: () => {}, attempts: 2 })
    throw new Error('the second step must not knock on a door already found shut')
  } catch (e) {
    if (!e.channelDown) throw new Error('the second step inherits the run verdict rather than rediscovering it')
    if (asked !== afterFirst) throw new Error(`the container must not be asked again - asked ${asked - afterFirst} more times`)
  }
  CH.resetChannel()
  if (CH.channelDown()) throw new Error('a fresh run starts from a channel that has not been found down')
})

check('a shut door is not a broken step', () => {
  const heal = codeOf('heal.mjs')
  const fail = codeOf('failures.mjs')
  if (!/channel-down/.test(heal)) throw new Error('heal must record the condition, not four step failures')
  if (!/channelDown/.test(fail)) throw new Error('and the report must count it separately from a real failure')
})

check('two views are sampled together, because a minute apart proves nothing', async () => {
  const TV = await import('./two-views.mjs')
  // At 01:15:53 the chain recorded three steps failing with "your application
  // is not running"; /health answered ok a minute later. By then the world has
  // moved, so the pair has to be taken at one moment.
  const s = await TV.sample({ http: { ok: true }, ssh: { attached: false, kind: 'app-down' } })
  if (!s.disagree) throw new Error('http ok with ssh refused is the disagreement this exists to catch')
  const agree = await TV.sample({ http: { ok: true }, ssh: { attached: true, kind: 'ok' } })
  if (agree.disagree) throw new Error('both up is agreement')
  const bothDown = await TV.sample({ http: { ok: false }, ssh: { attached: false, kind: 'app-down' } })
  if (bothDown.disagree) throw new Error('both down is agreement too - it is one story, not two')
})

check('the record counts four states, not two', async () => {
  const { summarise } = await import('./two-views.mjs')
  const t = summarise([
    { http: { ok: true }, ssh: { attached: true } },
    { http: { ok: true }, ssh: { attached: false, kind: 'app-down' } },
    { http: { ok: false }, ssh: { attached: false, kind: 'app-down' } },
    { http: { ok: false }, ssh: { attached: true } },
  ])
  if (t.bothUp !== 1 || t.httpOnly !== 1 || t.bothDown !== 1 || t.sshOnly !== 1) {
    throw new Error('http-ok-ssh-refused and ssh-ok-http-down are different problems and must be counted apart')
  }
  if (t.kinds['app-down'] !== 2) throw new Error('the refusal kind is kept, so the next reader knows which problem it was')
  if (t.n !== 4) throw new Error('the denominator is printed with every rate in this project')
})

check('asking does not change the chain verdict', () => {
  const code = codeOf('two-views.mjs')
  // The instrument must ask even when the breaker has decided not to, and must
  // not leave the breaker reset behind it.
  if (!/ignoreBreaker: true/.test(code)) throw new Error('this tool asks even when the chain has stopped asking')
  if (!/if \(!before\) CH\.resetChannel\(\)/.test(code)) throw new Error('and must restore the verdict it found')
  if (!/attempts: 1/.test(code)) throw new Error('a single attempt: the question is what the gateway says NOW')
})

check('a turn-held lock is never judged by pid liveness', async () => {
  const L = await import('./loop.mjs')
  // The comment in loop.mjs is right and stopped me from breaking it: an
  // ITERATION is a Claude turn made of many short-lived processes, so the pid
  // that took the lock has always exited by the time anyone looks. A liveness
  // check there would hand the lock straight to a concurrent cron fire.
  const now = Date.now()
  const turnHeld = { holder: 'iteration', pid: 999999, at: new Date(now - 10 * 60000).toISOString() }
  if (L.isStale(turnHeld, now, () => false)) {
    throw new Error('a turn-held lock is judged by AGE alone, whatever its pid is doing')
  }
  // ...and still expires on age.
  const old = { holder: 'iteration', pid: 999999, at: new Date(now - 50 * 60000).toISOString() }
  if (!L.isStale(old, now, () => true)) throw new Error('45 minutes is the window and it still applies')
})

check('a single-process holder that is gone does not hold the swarm for 45 minutes', async () => {
  const L = await import('./loop.mjs')
  const now = Date.now()
  const dead = { holder: 'heal', pid: 12345, singleProcess: true, at: new Date(now - 10 * 60000).toISOString() }
  if (!L.isStale(dead, now, () => false)) throw new Error('a dead single-process run is not holding anything')
  const alive = { ...dead }
  if (L.isStale(alive, now, () => true)) throw new Error('a running chain keeps its lock')
  // The grace period: a run that has just started is never stolen from, even if
  // the liveness probe is wrong about it.
  const young = { ...dead, at: new Date(now - 30000).toISOString() }
  if (L.isStale(young, now, () => false)) throw new Error('30 seconds in is inside the grace period')
})

check('heal and feed declare themselves single-process; nothing else does', () => {
  for (const f of ['heal.mjs', 'feed.mjs']) {
    if (!/singleProcess: true/.test(codeOf(f))) throw new Error(`${f} must opt in, or liveness cannot apply to it`)
  }
  // The default must stay the old behaviour, so a holder that does not opt in
  // is unaffected by any of this.
  if (!/Boolean\(opts\.singleProcess\)/.test(codeOf('loop.mjs'))) {
    throw new Error('the flag defaults to false: nothing that has not opted in may be affected')
  }
})

check('the audits do not hold the lock the refill needs', () => {
  const code = codeOf('heal.mjs')
  // A full run held the lock up to thirteen minutes - eight for the freeing
  // phase, five for the audits - and feed, which fires every 300 seconds to
  // refill the queue, stood down every time. The swarm sat at zero bees for
  // eleven minutes while the chain was in fp-check, a read-only step.
  if (!/lock released: everything from here only reads/.test(code)) {
    throw new Error('the lock must be released at the phase boundary')
  }
  const boundary = code.indexOf('reportPhaseStartedAt = Date.now()')
  const rel = code.indexOf('releaseLock()')
  if (!(boundary > -1 && rel > boundary)) throw new Error('released when the reporting phase starts, not before')
  // ...and only if this process took it. Releasing a lock held by the turn
  // around it is how two writers end up running at once.
  if (!/if \(heldLock\)/.test(code)) throw new Error('never release a lock this process did not take')
})

check('a rescue saves work and refuses to save what is not work', async () => {
  const { isWork, workPaths, NOT_WORK } = await import('./rescue.mjs')
  // Nineteen trees refused removal while the volume sat at 95% and every bee
  // died at `git worktree add`. They held 52 uncommitted paths - nine of them
  // test files a bee had written and never committed, the only copy of itself.
  if (!isWork('trios/agent-server/apps/agent/entrypoints/newtab/index/NewTab.test.ts')) {
    throw new Error('a test file a bee wrote is exactly the work this exists to save')
  }
  // `.worktrees/` appeared as an untracked entry INSIDE a worktree. Committing a
  // directory of checkouts into a branch is hard to undo and easy to avoid.
  if (isWork('.worktrees/queen-1/')) throw new Error('a nested checkout is not work')
  if (isWork('node_modules/x/index.js')) throw new Error('an installed package is not work')
  if (isWork('apps/server/dist/main.js')) throw new Error('a build artifact is not work')
  if (isWork('')) throw new Error('an empty path is not work')
  if (!NOT_WORK.length) throw new Error('the exclusions must be named, not implied')
  const paths = workPaths('?? a/b.test.ts\n M c/d.ts\n?? node_modules/e.js\n')
  if (paths.length !== 2) throw new Error(`two real paths and one package - got ${paths.join(', ')}`)
})

check('a rescue is preservation, not delivery', async () => {
  const code = codeOf('rescue.mjs')
  // Every one of the first twenty rescue commits failed on lefthook running
  // biome-check. A pre-commit hook gates work being DELIVERED; this is work
  // being saved from destruction, and holding it to a formatter's standard
  // means deleting it instead.
  if (!/--no-verify/.test(code)) throw new Error('the delivery gate must not stand between abandoned work and its only copy')
  if (!/NOT REVIEWED/.test(code)) throw new Error('the commit must say it is preserved, not endorsed')
  if (/--force/.test(code)) throw new Error('nothing here forces anything')
})

check('an unreadable board is not an empty one', async () => {
  const code = codeOf('rescue.mjs')
  // An empty running-set means every tree is abandoned and all may be
  // committed; an unreadable board means nothing is known and none may be. The
  // first version used one empty array for both.
  if (!/boardRead/.test(code)) throw new Error('the two must be distinguishable before anything is written')
  if (!/ACT && !boardRead/.test(code)) throw new Error('writing is refused when the board could not be read')
  if (!/still running/.test(code)) throw new Error('a tree whose bee is working is somebody mid-thought')
})

check('an unmeasured value has no delta and is not the word null', async () => {
  const L = await import('./loop.mjs')
  // The local disk hit 100%, the verdict audit could not write its cache, and
  // the dashboard printed "judged verdicts that prove   null   -203" - the word
  // null as a value and a fabricated fall as its change, in the artifact built
  // for the sole purpose of not making numbers up.
  if (L.isMeasured(null) || L.isMeasured(undefined) || L.isMeasured('')) {
    throw new Error('a fact that could not be taken is not a measurement')
  }
  if (!L.isMeasured(0)) throw new Error('zero is a real answer and must survive')
  if (!L.isMeasured(203)) throw new Error('and so is any number')
  const code = codeOf('loop.mjs')
  if (!/isMeasured\(m\.v\) \? String\(m\.v\) : '-'/.test(code)) throw new Error("the value column shows '-', never the word null")
  if (!/if \(!isMeasured\(now\)\) return/.test(code)) throw new Error('no delta may be computed from a value that was never taken')
})

check('a submodule pointer is reported, never committed', async () => {
  const { submodulePaths } = await import('./rescue.mjs')
  // The first pass after rescue shipped found exactly one stranded path:
  // trios/rings/RUST-13/trios-mesh, modified. It is a declared submodule, and
  // its M means the checked-out commit differs from the one the superproject
  // records. Committing that moves the repository's dependency, blind.
  const out = submodulePaths([
    'submodule..internal-docs.path .internal-docs',
    'submodule.trios-mesh.path trios/rings/RUST-13/trios-mesh',
  ].join('\n'))
  if (out.length !== 2) throw new Error(`both submodules must be read - got ${out.join(', ')}`)
  if (!out.includes('trios/rings/RUST-13/trios-mesh')) throw new Error('the path is the value, not the name')
  if (submodulePaths('').length) throw new Error('no .gitmodules means no exclusions, not a crash')
  const code = codeOf('rescue.mjs')
  if (!/REPORTED and never committed/.test(code)) throw new Error('a submodule difference is worth saying and never worth committing')
  if (/RUST-13/.test(code)) throw new Error('the list comes from .gitmodules; a hard-coded path is a second copy of a fact the repo states')
})

check('the whole .git is given back, not two subdirectories', () => {
  const code = codeOf('push-work.mjs')
  // The first outage showed 112 root-owned REFLOGS killing every bee at
  // `git fetch`, so the fix chowned logs and refs. But a push running as root
  // also writes OBJECTS and creates the fan-out directories holding them: 131
  // root-owned entries, 53 of them directories at mode 755 root:root inside a
  // tree owned by `bee`. A bee cannot create a file in a directory it does not
  // own - the same outage, waiting, in the part of the fix nobody looked at.
  if (/chown -R \$\{owner\} \S*\.git\/logs/.test(code)) {
    throw new Error('chowning logs and refs leaves the object store root-owned')
  }
  if (!/chown -R \$\{owner\} \/workspace\/BrowserOS\/\.git /.test(code)) {
    throw new Error('the whole .git must be given back after a root push')
  }
  if (!/root-owned files left/.test(code)) throw new Error('and it must report what it could not give back')
})

check('a worktree is removed on its lifetime, not on disk pressure', async () => {
  const { decide } = await import('./reap-finished.mjs')
  // An hour after the volume went 95% -> 32% it was back at 87%: 17 worktrees,
  // only TWO belonging to a running bee. Fifteen were left by finished
  // dispatches, eleven with their branch already on the remote.
  const d = decide(
    ['queen-1', 'queen-2', 'queen-3'],
    ['queen-1'],
    ['queen-1', 'queen-2'],
  )
  if (d.remove.join(',') !== 'queen-2') throw new Error(`only the finished AND published tree goes - got ${d.remove.join(',')}`)
  const why = Object.fromEntries(d.keep.map((k) => [k.tree, k.why]))
  if (!/still running/.test(why['queen-1'] || '')) throw new Error("a running bee's tree is its workspace")
  if (!/exist nowhere else/.test(why['queen-3'] || '')) throw new Error('an unpushed branch is the only copy of its commits')
  if (d.keep.length !== 2) throw new Error('every exclusion is returned with its reason; a silent omission reads as nothing to do')
})

check('reap-finished never forces and refuses on an unreadable board', async () => {
  const { script } = await import('./reap-finished.mjs')
  const code = codeOf('reap-finished.mjs')
  if (/--force/.test(code)) throw new Error('this removes a checkout, never a commit, and never by force')
  if (!/ACT.*\n?.*|boardRead/.test(code) || !/An unreadable board is not an empty one/.test(code)) {
    throw new Error('nobody-running and could-not-ask lead to opposite acts and must be told apart')
  }
  const s = script([])
  if (!/removed=0 refused=0 of 0/.test(s)) throw new Error('an empty list is a valid answer, not a malformed command')
  if (!/worktree remove/.test(script(['queen-1']))) throw new Error('it removes by the ordinary route')
})

check('sharing never touches a running bee, and never empties a bare checkout', async () => {
  const { decide } = await import('./share-modules.mjs')
  // Rebuilding node_modules under a live install kills the dispatch for a
  // reason nobody can reconstruct afterwards.
  const { share, keep } = decide([
    { name: 'queen-1', mb: 2500, lock: 'aaa' },
    { name: 'queen-2', mb: 2500, lock: 'aaa' },
    { name: 'queen-3', mb: 160, lock: 'aaa' },
  ], ['queen-2'])
  if (share.map((t) => t.name).join(',') !== 'queen-1') throw new Error(`only the idle tree with an install - got ${share.map((t) => t.name).join(',')}`)
  const why = Object.fromEntries(keep.map((k) => [k.name, k.why]))
  if (!/bee is running/.test(why['queen-2'] || '')) throw new Error('a running tree is left alone and said so')
  if (!/no private install/.test(why['queen-3'] || '')) throw new Error('a bare checkout has nothing to share and must not be emptied')
})

check('the store is keyed by the lockfile, and workspace packages link home', async () => {
  const { shareScript, parseShared, parseSurvey } = await import('./share-modules.mjs')
  // The obvious version breaks at once:
  //   error: Cannot find module '@browseros/shared/constants/limits'
  // A bun workspace links its OWN packages by relative path inside
  // node_modules; shared away they resolve against the store and find nothing.
  const s = shareScript([{ name: 'queen-1', lock: 'abc123' }])
  if (!/@browseros/.test(s)) throw new Error('the workspace packages must be linked back to the worktree')
  if (!/\$\{pair##\*:\}/.test(s) && !/h=/.test(s)) throw new Error('the store is keyed by the lock hash, so different dependencies get different stores')
  if (/--force/.test(s)) throw new Error('nothing here forces anything')
  if (!/SHARED trees=0 saved=0/.test(shareScript([]))) throw new Error('an empty list is a valid answer, not a malformed command')
  const p = parseSurvey('TREE queen-1 2500 abc123\nnoise\n')
  if (p.length !== 1 || p[0].mb !== 2500 || p[0].lock !== 'abc123') throw new Error('the survey line carries size and lock together')
  if (parseShared('SHARED trees=6 saved=14362').savedMb !== 14362) throw new Error('the saving is read back from the tool, not estimated')
})

check('the sharing step lives where its budget fits', () => {
  const feed = codeOf('feed.mjs')
  const heal = codeOf('heal.mjs')
  // It went on the 300-second timer when the channel refused three times in
  // five and the step therefore did nothing quickly. With the client named the
  // channel works, the step does real work - walking every worktree with du,
  // promoting a store, rebuilding farms - and its first two working runs both
  // recorded `share-modules: timed out` against a 300-second cap.
  if (/name: 'share-modules'/.test(feed)) throw new Error('a step that cannot finish in the cycle does not belong on the cycle')
  if (!/name: 'share-modules'/.test(heal)) throw new Error('it must still run somewhere - heal has an eight-minute freeing phase')
  if (!/one installed dependency tree, linked into every worktree/.test(heal)) {
    throw new Error('heal must describe the step by what it does, not by the timer it used to be on')
  }
})

check('no tri command is shadowed by an earlier one', () => {
  // A shell `case` takes the FIRST match. `feed)` appeared twice in tri: a
  // Vibee content feed at line 37 and the loop's own feed at line 390. The
  // second was unreachable for its whole life, so `tri feed --act` - which a
  // launchd timer had been running every 300 seconds - reached the content feed
  // and the loop step never once ran from its timer.
  //
  // 92 labels, one collision, and nothing in the system could see it.
  const src = fs.readFileSync(path.join(process.env.HOME || '', '.local/bin/tri'), 'utf8')
  const seen = new Map()
  const dup = []
  src.split('\n').forEach((line, i) => {
    const m = line.match(/^\s{0,4}([a-z0-9][a-z0-9|_-]*)\)\s*(#.*)?$/)
    if (!m) return
    for (const label of m[1].split('|')) {
      if (seen.has(label)) dup.push(`${label} (first at ${seen.get(label)}, unreachable at ${i + 1})`)
      else seen.set(label, i + 1)
    }
  })
  if (dup.length) throw new Error(`shadowed command(s): ${dup.join('; ')}`)
  if (seen.size < 50) throw new Error(`only ${seen.size} labels parsed - the scanner has stopped seeing the file`)
})

check('a retry stops before it overruns its caller budget', async () => {
  const CH = await import('./channel.mjs')
  CH.resetChannel()
  // The app-down backoff waits 15s then 30s, times four: 180 seconds of sleeping
  // across three attempts. `feed` fires every 300 seconds and caps a step at
  // 300, and its first two real runs both recorded `share-modules: timed out`.
  let slept = 0
  let asked = 0
  let clock = 0
  const drop = () => { asked++; const e = new Error('Your application is not running or in a unexpected state'); e.stderr = ''; throw e }
  try {
    CH.remote('x', {
      run: drop,
      sleep: (s) => { slept += s; clock += s * 1000 },
      now: () => clock,
      onRetry: () => {},
      attempts: 3,
      deadlineMs: 30000,
    })
    throw new Error('it must still fail')
  } catch (e) {
    if (!e.channel) throw new Error('an exhausted channel is still a channel failure')
    if (slept * 1000 >= 30000) throw new Error(`it slept ${slept}s past a 30s budget`)
    if (asked < 1) throw new Error('it must ask at least once before giving the budget as the reason')
  }
  // With no deadline the old behaviour is unchanged: attempts alone bound it.
  CH.resetChannel()
  let slept2 = 0
  let clock2 = 0
  try {
    CH.remote('x', { run: drop, sleep: (s) => { slept2 += s; clock2 += s * 1000 }, now: () => clock2, onRetry: () => {}, attempts: 3 })
  } catch { /* expected */ }
  if (slept2 !== 180) throw new Error(`without a budget the app-down sequence sleeps 60+120=180s - got ${slept2}`)
})

check('the feed hands the channel the budget it is holding it to', () => {
  const code = codeOf('feed.mjs')
  // A step killed at its timeout reports "timed out part-way" and loses whatever
  // it was about to say. Told the number, the channel stops before the wait that
  // would overrun and the step finishes with an answer.
  if (!/CHANNEL_DEADLINE_MS/.test(code)) throw new Error('the step budget must reach the channel, not only the kill timer')
  if (!/budget \* 0\.8/.test(code)) throw new Error('leave the step room to report after the channel gives up')
})

check('the dashboard reads the gateway rate, it does not probe for it', async () => {
  const { gatewayPercent } = await import('./dash.mjs')
  // Probing here would add a sample to the thing being measured. A dashboard
  // that changes its own number by looking at it is not a dashboard.
  const read = () => [
    JSON.stringify({ ssh: { attached: true } }),
    JSON.stringify({ ssh: { attached: false, kind: 'app-down' } }),
    JSON.stringify({ ssh: { attached: false, kind: 'app-down' } }),
  ].join('\n')
  if (gatewayPercent(read) !== 33) throw new Error(`1 of 3 attached is 33% - got ${gatewayPercent(read)}`)
  if (gatewayPercent(() => '') !== null) throw new Error('no samples is null, not zero: never measured and never answered are different')
  const code = codeOf('dash.mjs')
  if (/two-views\.mjs/.test(code)) throw new Error('it reads the record; running the probe would change what it measures')
})

check('the loop names the railway binary it runs', async () => {
  const CH = await import('./channel.mjs')
  // Both launchd plists run `/bin/zsh -lc`, whose login profile puts
  // /usr/local/bin ahead of the nvm bin. A bare `railway` there is 4.5.4 of
  // June 2025, which cannot attach; my interactive shell finds 5.49.2.
  //
  //   LC_ALL=C grep -ac "Expected welcome message"   1 in 4.5.4, 0 in 5.49.2
  //
  // That string wraps EVERY app-down refusal in the record. The gateway was not
  // working 39% of the time - it was not being asked.
  if (!/^\//.test(CH.RAILWAY_BIN)) throw new Error(`the binary must be an absolute path, not a PATH lookup - got ${CH.RAILWAY_BIN}`)
  if (!CH.RAILWAY.startsWith(CH.RAILWAY_BIN)) throw new Error('the command must use the named binary')
  for (const f of ['channel.mjs', 'stale-escalations.mjs']) {
    const code = codeOf(f)
    if (/`railway ssh/.test(code)) throw new Error(`${f} still starts a command with a bare railway`)
  }
})

check('the farm links dotfiles, which is where bun keeps everything', async () => {
  const { shareScript } = await import('./share-modules.mjs')
  // POSIX sh does not match a leading dot with `*`. The store root holds 16
  // entries and the first glob linked 14: `.bun` - bun's entire isolated store,
  // 2242 entries, 2.37 GB - and `.bin` were left out, so bun could not see the
  // tree as satisfied and reinstalled everything.
  //
  // A/B, one worktree, one store, one command:
  //   with dotfiles     "Checked 2244 installs ... (no changes)"  27M -> 27M
  //   without dotfiles  "4460 packages installed"                 27M -> 2254M
  const s = shareScript([{ name: 'queen-1', lock: 'abc' }])
  if (!/\.\[!\.\]\*/.test(s)) throw new Error('the glob must match dotfiles or .bun is never linked')
  if (!/\[ -e "\$e" \] \|\| continue/.test(s)) throw new Error('an unmatched dotfile glob expands to itself and must be skipped')
})

check('the railway client is chosen by version, not by a pinned path', async () => {
  const CH = await import('./channel.mjs')
  const { execSync } = await import('node:child_process')
  // The first fix pinned $HOME/.nvm/versions/node/v22.22.0/bin/railway. An
  // adversarial reader found the hazard at once: an nvm bump moves that
  // directory and the loop loses its only working client, having hardcoded a
  // version number nobody will remember to update.
  const code = codeOf('channel.mjs')
  if (/v22\.22\.0/.test(code)) throw new Error('a pinned node version in the path is a silent regression waiting for an nvm bump')
  if (!/major >= 5/.test(code)) throw new Error('4.5.4 must be rejected by its VERSION, which is the property that matters')
  if (!/^\//.test(CH.RAILWAY_BIN)) throw new Error(`an absolute path was expected - got ${CH.RAILWAY_BIN}`)
  const v = execSync(`${JSON.stringify(CH.RAILWAY_BIN)} --version`, { encoding: 'utf8', timeout: 20000 })
  const major = Number((String(v).match(/(\d+)\./) || [])[1])
  if (!(major >= 5)) throw new Error(`the chosen client is ${String(v).trim()}, which cannot attach`)
})

check('the harness can fail an async check', async () => {
  // Guarding the fix above: before it, this file reported 0 failures while an
  // async case was rejecting into the void.
  let caught = false
  const inner = []
  const fake = (n, f) => { const o = f(); if (o && o.then) inner.push(o.then(() => {}, () => { caught = true })) }
  fake('x', async () => { throw new Error('boom') })
  await Promise.all(inner)
  if (!caught) throw new Error('an async rejection must be observable by the harness')
})

await Promise.all(pending)
console.log(`\n${pass} passed, ${failures.length} failed`)
fs.rmSync(tmp, { recursive: true, force: true })
if (failures.length) {
  console.log('\nfailures:')
  failures.forEach((f) => console.log(`  ${f}`))
  process.exit(1)
}
