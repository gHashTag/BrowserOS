#!/usr/bin/env node
// Work that was finished, accepted, closed - and never entered the branch.
//
// THE MEASUREMENT, 2026-09-04. 174 `queen-*` branches on the remote. FIVE are
// contained in `feat/queen-supervisor`. The other 169 all carry a real diff -
// not one is empty against the base.
//
// So the swarm ran at full load for a day, the Queen accepted the work, and
// `close-done` closed the issues on the strength of a branch existing. A closed
// issue whose code is not in the branch is a false statement about the
// repository, and the loop had been making 169 of them.
//
// This is the oldest defect in this project wearing its third face. First the
// work never left the container. Then it reached the remote and stopped there.
// Now it reaches the remote, the issue closes, and the code still stops there.
//
// WHAT THIS WILL AND WILL NOT DO.
//
//   - only a branch whose issue is CLOSED. An open issue is unfinished work,
//     whatever its branch looks like.
//   - only a branch that merges CLEANLY, tested with `git merge-tree` before
//     anything is attempted. A conflict is reported for a person, never
//     resolved by guessing.
//   - only into `feat/queen-supervisor`. Never `dev`, never `main`.
//   - a BOUNDED number per run, newest first, because 169 merges in one go is
//     not a repair, it is an event.
//   - never a force push, and never a branch deletion: the branch is the
//     evidence that the work happened.
//
// Usage:
//   node land.mjs            # report the gap
//   node land.mjs --land     # squash-merge the next batch that applies cleanly

import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REPO = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'
const CODE_REPO = process.env.TRIOS_CODE_REPO || 'gHashTag/BrowserOS'
const BASE = process.env.LAND_BASE || 'feat/queen-supervisor'
const BATCH = Number(process.env.LAND_BATCH ?? 5)
const isMain = process.argv[1] && process.argv[1].endsWith('/land.mjs')

const sh = (c, opts = {}) => {
  try {
    return execSync(c, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000, ...opts }).trim()
  } catch { return null }
}

/**
 * Whether a branch would merge without conflict, asked WITHOUT touching the
 * working tree.
 *
 * `git merge-tree --write-tree` performs the merge in the object database and
 * reports conflicts on stdout. Nothing is checked out, no index is locked, and
 * a run that is interrupted leaves the repository exactly as it found it -
 * which matters because this loop has already filled a disk and stolen a lock
 * by being careless about state that lives outside a single process.
 */
/**
 * Whether this branch's work is already in the base, by ANY route.
 *
 * Ancestry, then the diff. Ancestry is cheap and catches a real merge; the diff
 * catches a squash, a cherry-pick, and a change somebody applied by hand - all
 * of which leave the branch looking unmerged for ever.
 */

/**
 * THE FIFTH ROUTE: the base's own history says it closed this issue.
 *
 * Every content-based route above compares BYTES - a tree, a patch-id, an
 * ancestry. All four are blind to the one thing this loop does constantly:
 * when a bee's branch goes stale, I re-cut its change against the current base
 * and squash-merge THAT. The carry is a new commit with a new tree and a new
 * patch-id, so nothing content-shaped can connect it back, and the bee's
 * original branch becomes permanent debt - re-offered every round, conflicting
 * every round, holding its issue open and its boundary fenced for ever.
 *
 * Measured 2026-09-05 on the nine branches that had jammed the pipeline:
 * #1310 landed as PR #330, #1308 as PR #331, #1362 carries `Closes #1362` in a
 * base commit. Three of nine were finished work that no content route could see.
 *
 * So read the message. L1 of this repository is "no code merged without
 * `Closes #N`", which makes the message a load-bearing record rather than a
 * courtesy - and the squash subject convention `(#N)` says the same thing.
 *
 * THE MATCHING IS DONE IN JAVASCRIPT, not in git's regex. Two rounds ago a BRE
 * read as a JavaScript regex convicted a bee; the lesson is to keep the dialect
 * somewhere it is known. git is asked the loose question and the boundary is
 * checked here.
 */
export function closedInBase(branch, run = sh) {
  const m = String(branch).match(/queen-(\d+)$/)
  if (!m) return false
  const n = m[1]
  const raw = run(`git log origin/${BASE} --format=%B%x1e --grep=${JSON.stringify('#' + n)} -i`)
  if (!raw) return false
  const closes = new RegExp(`(?:closes|fixes|resolves)\\s+#${n}(?![0-9])`, 'i')
  // `(#N)` is how a squash subject records the issue it came from, and it must
  // END A LINE, which is what makes it a subject rather than a mention. The
  // loose version would match "unlike (#1421), this does X" in any paragraph.
  //
  // In THIS repository issue numbers are four digits and pull-request numbers
  // three, so `(#1310)` cannot be a PR reference - a repo-specific fact, stated
  // because it is not a general one.
  //
  // ...ALLOWING THE REFERENCES THAT FOLLOW IT. A squash subject here reads
  // `feat(queen): explain idle paid slots (#1310) (#330)` - the issue first,
  // then the pull request that merged it. Demanding `(#N)` at the very end of
  // the line rejected exactly the case this route was written for, which I
  // discovered by tightening the rule and watching #1310 stop being recognised
  // one minute later. A trailing CHAIN of parenthesised references is a
  // subject; a parenthesis in the middle of a sentence is not.
  const subject = new RegExp(`\\(#${n}\\)(?:\\s*\\(#\\d+\\))*\\s*$`, 'm')
  // And the phrasing my own carry commits use, which is the case this route
  // exists for: the change was re-cut onto a fresh base and merged under a
  // different branch, saying so in words because no byte-comparison can.
  const carried = new RegExp(`carr(?:y|ies|ied)\\s+(?:the\\s+)?#${n}(?![0-9])`, 'i')
  for (const message of raw.split('\x1e')) {
    if (closes.test(message)) return true
    if (carried.test(message)) return true
    if (Number(n) >= 1000 && subject.test(message)) return true
  }
  return false
}

export function isLanded(branch) {
  if (sh(`git merge-base --is-ancestor origin/${branch} origin/${BASE} && echo yes`) === 'yes') return true
  // THE EXACT QUESTION: would merging this change the base at all?
  //
  // Two wrong answers came before this one. `merge-base --is-ancestor` is right
  // for a real merge and permanently wrong after a squash, because a squash
  // writes a NEW commit and the source is never an ancestor. And
  // `git diff BASE...branch` is three-dot - it measures from the point the two
  // diverged, so it shows the branch's changes whether or not they were already
  // applied to the base.
  //
  // Merging into a tree and comparing that tree with the base's answers it
  // exactly, and it is route-blind: real merge, squash, cherry-pick or a change
  // somebody made by hand all give the same tree.
  const baseTree = sh(`git rev-parse origin/${BASE}^{tree}`)
  const mergedTree = sh(`git merge-tree --write-tree origin/${BASE} origin/${branch}`)
  if (baseTree && mergedTree && mergedTree.split('\n')[0].trim() === baseTree) return true

  // AND THE FOURTH ROUTE: every commit already in the base by PATCH-ID.
  //
  // The tree test catches a branch whose merge would change nothing. It does
  // NOT catch a branch that was cherry-picked and has since drifted - the base
  // moved on, so merging it back would still change the tree, and it looks like
  // debt for ever.
  //
  // `git cherry` compares patch-ids and marks with `-` any commit whose change
  // is already upstream. Audited 2026-09-05 across ten conflicting branches:
  // three were finished work counted as debt. queen-1298's blob is
  // BYTE-IDENTICAL to one the base landed, same author and timestamp;
  // queen-1296's two commits have matching patch-ids in the base; queen-1421 is
  // the squash source of a commit already in the base. Nothing would be gained
  // by merging any of them, and each was re-offered every round.
  //
  // A branch with no commits left unaccounted for has landed, whatever route it
  // took. An empty answer from `git cherry` is not evidence of anything.
  const cherry = sh(`git cherry origin/${BASE} origin/${branch}`)
  if (cherry !== null) {
    const unaccounted = cherry.split('\n').filter((l) => l.trim().startsWith('+'))
    if (cherry.trim() !== '' && unaccounted.length === 0) return true
  }

  // ...and the route no comparison of bytes can reach.
  return closedInBase(branch)
}

export function mergesCleanly(branch) {
  // `git merge-tree --write-tree` exits NON-ZERO when there are conflicts, and
  // that is its answer rather than a failure. Reading it as one made every real
  // conflict report "the merge could not be computed" - true, useless, and the
  // third time this round an outcome was treated as an exception.
  let out
  try {
    out = execSync(`git merge-tree --write-tree --name-only origin/${BASE} origin/${branch}`, {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000,
    }).trim()
  } catch (e) {
    out = String(e.stdout || '').trim()
    if (!out) return { clean: false, why: 'the merge could not be computed at all' }
  }
  // With --write-tree the first line is the tree oid; conflicted paths follow.
  const lines = out.split('\n').filter(Boolean)
  if (lines.length <= 1) return { clean: true }
  // `merge-tree --name-only` interleaves PROSE with paths: "Auto-merging X" and
  // "CONFLICT (add/add): Merge conflict in X" are commentary about the same file
  // the line above names. Counting them made every conflict look twice as wide
  // as it is - "6 conflicting path(s)" for three files, which is the kind of
  // inflated number that makes a report stop being read.
  const paths = lines.slice(1)
    .filter((p) => !/^(Auto-merging|CONFLICT )/.test(p))
    .filter((p, i, a) => a.indexOf(p) === i)
  const moved = baseMovedSince(branch, paths)
  const since = moved
    ? ` | the base moved on these since the fork: ${moved.commits} commit(s), ${moved.stat} - a rebase would replay OLD code over new; re-file what survives against today's base`
    : ''
  return { clean: false, why: `${paths.length} conflicting file(s): ${paths.slice(0, 3).join(', ')}${since}` }
}


/**
 * HAS THE BASE MOVED ON PAST THIS BRANCH, or merely diverged from it?
 *
 * A conflict says two sides touched the same lines. It does NOT say which side
 * is behind, and the advice that follows depends entirely on that.
 *
 * Measured 2026-09-05 on #1302, "expose Queen billing mode and quota authority
 * in public research status". Rebasing it would have replayed a 205-line file
 * over a base that had since gained `WorkerCapacityBreakdown` (#1308's landed
 * work) and tree-load-failure handling - deleting both - and would have
 * REINTRODUCED a non-ASCII ellipsis into a path redaction the base already does
 * in ASCII, breaking L3 in the same stroke.
 *
 * That branch is not waiting for a rebase. It is superseded in part, and what
 * survives is a small delta that belongs on today's base as new work. Telling a
 * person "needs a rebase" would have been advice toward destroying finished
 * code.
 *
 * So the report says how far the base has travelled on the conflicting files
 * since the fork point. It is a measurement, not a verdict: the person still
 * decides, but now with the number that decides it.
 */
export function baseMovedSince(branch, paths, run = sh) {
  const fork = run(`git merge-base origin/${BASE} origin/${branch}`)
  if (!fork || !paths.length) return null
  const quoted = paths.map((p) => JSON.stringify(p)).join(' ')
  const commits = run(`git rev-list --count ${fork}..origin/${BASE} -- ${quoted}`)
  const stat = run(`git diff --shortstat ${fork}..origin/${BASE} -- ${quoted}`)
  const n = Number(commits)
  if (!Number.isFinite(n) || n === 0) return null
  return { commits: n, stat: (stat || '').trim() }
}

export async function survey() {
  const listed = sh(`git branch -r --list 'origin/queen-*'`)
  // (the caller fetches; survey itself stays cheap so it can be called twice)
  if (listed === null) return null
  const branches = listed.split('\n').map((l) => l.trim().replace(/^origin\//, '')).filter(Boolean)

  // ACCEPTED, NOT MERELY CLOSED - and getting this wrong created a deadlock
  // that lasted exactly one run.
  //
  // The first version landed only a CLOSED issue. close-done was changed in the
  // same hour to close only LANDED work. So an issue the Queen had accepted but
  // which was still open could never move: land refused it for being open, and
  // close refused it for not having landed. Two correct-looking rules that
  // together said "never".
  //
  // "Closed" was only ever a proxy for "the Queen accepted this". Ask the thing
  // itself: a dispatch whose review_state is accept is accepted, whatever the
  // issue's state on the forge happens to be. Closed still counts, because work
  // closed by hand is accepted too.
  const closed = new Set(
    (sh(`gh issue list --repo ${REPO} --state closed --limit 400 --json number -q '.[].number'`) || '')
      .split('\n').filter(Boolean),
  )
  const accepted = new Set()
  try {
    const SE = await import(path.join(DIR, 'stale-escalations.mjs'))
    const js = "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});" +
      "p.query(\"select distinct issue from queen_dispatch where review_state = 'accept'\")" +
      ".then(r=>{console.log(JSON.stringify(r.rows)); return p.end()}).catch(e=>{console.log('ERR '+e.message); process.exit(1)})"
    const out = SE.remote(js)
    const line = String(out ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('['))
    if (line) for (const r of JSON.parse(line)) accepted.add(String(r.issue))
  } catch { /* the forge answer alone still works, just more narrowly */ }

  const out = []
  for (const b of branches) {
    // ANCESTRY IS THE WRONG QUESTION AFTER A SQUASH MERGE, and asking it cost me
    // fifteen empty commits.
    //
    // A squash merge takes the diff and writes ONE new commit on the base. The
    // source branch is never an ancestor of anything, so
    // `merge-base --is-ancestor` says "not merged" for ever - and this tool
    // landed the same five branches four times in a row, opening twenty pull
    // requests and merging twenty commits, fifteen of which changed zero files.
    // The count it printed never moved, which was the tell I should have read
    // on the second run rather than the fourth.
    //
    // The right question is whether the WORK is in the base, and the diff
    // answers it whatever route the work took: empty diff, work landed.
    if (isLanded(b)) continue
    const issue = (b.match(/queen-(\d+)/) || [])[1]
    const stat = sh(`git diff --shortstat origin/${BASE}...origin/${b}`) || ''
    const files = Number((stat.match(/(\d+) files? changed/) || [])[1] || 0)
    const rec = { branch: b, issue, files, state: 'hold', why: '' }
    if (!files) { rec.why = 'no diff against the base - nothing to land'; out.push(rec); continue }
    if (!issue) { rec.why = 'the branch name carries no issue number'; out.push(rec); continue }
    if (!closed.has(issue) && !accepted.has(issue)) {
      rec.why = `#${issue} is neither accepted by the Queen nor closed - unfinished work, whatever its branch looks like`
      out.push(rec)
      continue
    }
    rec.state = 'LANDABLE'
    rec.why = `#${issue} ${closed.has(issue) ? 'closed' : 'accepted'}, ${files} file(s)`
    out.push(rec)
  }
  // Newest first: the most recent work is the most likely to apply cleanly, and
  // the least likely to have been superseded.
  return out.sort((a, b) => Number(b.issue || 0) - Number(a.issue || 0))
}

if (isMain) {
  const doLand = process.argv.includes('--land')
  sh(`git fetch --quiet origin ${BASE}`)
  const rows = await survey()
  if (!rows) {
    console.log('could not survey the branches')
    process.exit(1)
  }

  const landable = rows.filter((r) => r.state === 'LANDABLE')
  const held = rows.filter((r) => r.state !== 'LANDABLE')
  console.log(`${rows.length} unmerged queen branch(es): ${landable.length} whose issue is closed, ${held.length} held\n`)
  for (const r of held.slice(0, 6)) console.log(`  hold  ${r.branch.padEnd(16)} ${r.why}`)
  if (held.length > 6) console.log(`  ...   and ${held.length - 6} more`)

  console.log('')
  // FILL THE BATCH WITH CLEAN ONES, rather than taking the first N and hoping.
  //
  // `slice(0, BATCH)` took the newest five whatever their state, and the
  // conflicting branches sit at the HEAD of a newest-first list - so a batch of
  // five landed ONE while four conflicts were re-checked every run. Measured:
  // the rate fell to 1 per batch with 35 clean branches waiting behind 10 stuck
  // ones.
  //
  // Fourth instance this round of one bad item blocking a batch, after a
  // rejected ref taking down a push, a timed-out step reported as failed, and a
  // conflict read as a computation failure. The shape is always the same: work
  // that CAN proceed is held hostage by work that cannot.
  //
  // Bounded scan: it looks at up to four batches' worth of candidates to find
  // one batch of clean ones, so a wall of conflicts cannot turn this into a
  // full survey every run.
  const batch = []
  const skipped = []
  for (const r of landable.slice(0, BATCH * 4)) {
    if (batch.length >= BATCH) break
    const m = mergesCleanly(r.branch)
    if (m.clean) { r.clean = true; batch.push(r) } else { r.clean = false; r.why = m.why; skipped.push(r) }
  }
  for (const r of skipped) {
    // The whole reason, not the first 96 characters of it. The truncation hid
    // exactly the half that says what to DO about the conflict.
    console.log(`  CONFL ${r.branch.padEnd(16)} ${r.why}`)
  }
  for (const r of batch) console.log(`  land  ${r.branch.padEnd(16)} ${r.why}`)
  if (skipped.length) console.log(`  (${skipped.length} conflicting branch(es) skipped over, not counted against the batch)`)

  if (!batch.length && landable.length) {
    console.log('')
    console.log(`ALL ${landable.length} remaining branch(es) conflict. Nothing here can be landed by merging.`)
    console.log('A conflict is reported for a person, never resolved by guessing - these need a')
    console.log('rebase, or an honest closure as superseded. Meanwhile close-done refuses to')
    console.log('close anything that has not landed, so this is where the pipeline stops.')
  }
  console.log(`\n${landable.length} landable, showing the next ${batch.length} (batch ${BATCH}).`)
  console.log('A closed issue whose code is not in the branch is a false statement about the repository.')

  if (!doLand) {
    console.log('\nreport only. re-run with --land to open and merge the next batch.')
    process.exit(0)
  }

  let landed = 0
  for (const r of batch.filter((x) => x.clean)) {
    const title = sh(`gh issue view ${r.issue} --repo ${REPO} --json title -q .title`) || `queen work for #${r.issue}`
    const body = `Work the Queen accepted on \`${r.branch}\`, closed as gHashTag/trios#${r.issue}, and never merged.\n\n` +
      `Measured 2026-09-04: 174 \`queen-*\` branches on the remote and FIVE contained in \`${BASE}\`. ` +
      `The other 169 all carry a real diff. A closed issue whose code is not in the branch is a false ` +
      `statement about the repository, and the loop had been making 169 of them.\n\n` +
      `Merges cleanly against the current base, checked with \`git merge-tree\` before this PR was opened.`
    const url = sh(`gh pr create --repo ${CODE_REPO} --base ${BASE} --head ${r.branch} --title ${JSON.stringify(`${title}`.slice(0, 90))} --body ${JSON.stringify(body)}`)
    if (!url) { console.log(`  could not open a PR for ${r.branch}`); continue }
    const num = (url.match(/\/(\d+)$/) || [])[1]
    // No --delete-branch: the branch is the evidence that the work happened.
    const merged = sh(`gh pr merge ${num} --repo ${CODE_REPO} --squash --admin`)
    if (merged === null) { console.log(`  opened ${url} but it did not merge - left for a person`); continue }
    console.log(`  landed ${r.branch} as ${url}`)
    landed++
  }

  // DID THE NUMBER ACTUALLY MOVE?
  //
  // The tell I missed four times. This tool reported "landed 5 of 5" and then
  // "146 still waiting" on three consecutive runs - the same five branches,
  // twenty pull requests, fifteen commits that changed zero files. A count that
  // does not move after a successful act means the act did not do what its name
  // says, and no amount of confident output is evidence against that.
  //
  // So the tool re-measures and refuses to run again on a count that stood
  // still. Reporting success while the world is unchanged is the failure this
  // whole loop keeps finding in other people's code.
  // FETCH BEFORE RE-MEASURING. The merges happened on the forge; the local ref
  // does not know until it is told. The stall guard below caught this on its
  // very first run - measuring the new world against the old one - which is the
  // same class of error it exists to catch, arriving from the other direction.
  sh(`git fetch --quiet origin ${BASE}`)
  const after = await survey()
  const stillLandable = after ? after.filter((r) => r.state === 'LANDABLE').length : null
  console.log(`\nlanded ${landed} of ${batch.filter((x) => x.clean).length} clean in this batch`)
  if (stillLandable === null) {
    console.log('could not re-measure afterwards, so whether anything moved is UNKNOWN')
  } else {
    console.log(`landable before ${landable.length}, after ${stillLandable}`)
    if (landed > 0 && stillLandable >= landable.length) {
      console.log('')
      console.log('REFUSING to continue: the count did not move after a successful merge.')
      console.log('Something about "merged" is being measured wrongly, and running again')
      console.log('would repeat whatever just happened. Fix the measure, not the batch.')
      const L = await import(path.join(DIR, 'loop.mjs'))
      L.append({ kind: 'land', landed, landable: landable.length, after: stillLandable, stalled: true })
      process.exit(4)
    }
  }
  const L = await import(path.join(DIR, 'loop.mjs'))
  L.append({ kind: 'land', landed, landable: landable.length, after: stillLandable, batch: BATCH })
  process.exit(0)
}
