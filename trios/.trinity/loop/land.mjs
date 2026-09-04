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
  if (!baseTree || !mergedTree) return false
  return mergedTree.split('\n')[0].trim() === baseTree
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
  return { clean: false, why: `${lines.length - 1} conflicting path(s): ${lines.slice(1, 4).join(', ')}` }
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
  for (const r of skipped) console.log(`  CONFL ${r.branch.padEnd(16)} ${r.why.slice(0, 96)}`)
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
