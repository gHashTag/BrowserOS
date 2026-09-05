#!/usr/bin/env node
// The laptop fills too, and nothing was reaping it.
//
// THE INCIDENT, 2026-09-04. `git worktree add` failed mid-checkout with
// `fatal: cannot create directory at 'docs/images/icons': No space left on
// device`. The disk was at 100% with 161 MB free. `reap.mjs` had been guarding
// the CONTAINER volume all night and reported it healthy, which it was - the
// machine running the loop was the one filling up.
//
// The cause was mine. Landing eight PRs in a night meant eight worktrees, each
// a 205 MB checkout, one of them 2.4 GB with node_modules, none removed after
// its branch merged. Plus 33 more from other sessions going back three days.
//
// THE RULE, and it is the only one that is safe without knowing who made a
// worktree: remove it when its branch is FULLY MERGED into the base and the
// tree is CLEAN. A merged, clean worktree holds nothing that is not already in
// the repository - deleting it destroys no work, whoever created it. Anything
// else is reported and left alone, including a tree with uncommitted changes,
// because a dirty tree is somebody's unfinished thought.
//
// NEVER `--force`. That flag is what turns "this has something in it" into
// silence, and the standing rule in this project is that it is not used on a
// worktree. A tree this refuses to remove is a tree a person should look at.
//
// Usage:
//   node reap-local.mjs           # report
//   node reap-local.mjs --reap    # remove the merged and clean ones

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const BASE = process.env.REAP_LOCAL_BASE || 'origin/feat/queen-supervisor'
const HIGH = Number(process.env.REAP_LOCAL_HIGH ?? 85)
const isMain = process.argv[1] && process.argv[1].endsWith('/reap-local.mjs')

/**
 * Every shell call is bounded.
 *
 * Without a timeout this tool ran past 500 seconds twice and had to be killed,
 * and I could not tell which of 33 worktrees was hanging - a directory on a
 * slow volume, a stale index lock, an unmounted path all look identical from
 * outside. A step that can hang for ever is a step that hangs the whole chain,
 * and heal.mjs now runs this first of eleven.
 *
 * A call that times out returns null, which every caller already treats as
 * "cannot tell" and therefore "do not touch".
 */
const sh = (c, cwd = ROOT, timeout = Number(process.env.REAP_LOCAL_TIMEOUT_MS ?? 15000)) => {
  try {
    return execSync(c, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout }).trim()
  } catch { return null }
}

/**
 * Percent in use of the filesystem the WORKTREES actually live on.
 *
 * It asked `df -P /` and was wrong on this machine every time it ran.
 *
 * On macOS the root is a sealed read-only system snapshot; everything a person
 * writes lives on `/System/Volumes/Data`. Measured 2026-09-05, minutes apart:
 *
 *   df -P /              55%     the snapshot
 *   df -P /private/tmp   97%     393 Gi of 460 on the data volume
 *
 * So this reported a comfortable 57% all night while the disk that matters was
 * nearly full - and the `git worktree add` that failed with "No space left on
 * device" happened while it said there was room. A guard pointed at the wrong
 * filesystem is worse than no guard, because it answers.
 *
 * Ask about the path we care about, and let df resolve which filesystem that is.
 */

/**
 * Does this porcelain status hold WORK, or only the absence of it?
 *
 * A deletion is not work. A worktree whose entire dirty set is ` D path` lines
 * has removed files that are still in its own HEAD commit - everything it
 * contains is in git, and taking the tree destroys nothing that `git checkout`
 * would not put straight back.
 *
 * Found 2026-09-05 with the laptop at 98% and dispatches dying part-way through
 * checkout. Two workflow worktrees were being spared as "somebody's unfinished
 * thought" on the strength of 1983 and 1984 changes each. Every one was a
 * DELETION - the file-flicker this tree does mid-build - and between them they
 * held 4.4 GB of nothing while the guard, correctly refusing to force, watched
 * the disk fill.
 *
 * An addition or a modification is a thought. A deletion is the shape of one
 * that was already saved.
 */
export function holdsWork(porcelain) {
  const lines = String(porcelain || '').split('\n').filter((l) => l.trim())
  if (!lines.length) return { work: false, deletions: 0, other: 0 }
  // Porcelain v1: two status columns then a space then the path. A deletion is
  // 'D' in either column and nothing else in the other.
  const isDeletion = (l) => /^([ D])D /.test(l) || /^D[ D] /.test(l)
  const deletions = lines.filter(isDeletion).length
  const other = lines.length - deletions
  return { work: other > 0, deletions, other }
}

/**
 * Did this commit's subject land in the base, allowing for the squash suffix?
 *
 * A GitHub squash writes the PR title as the subject and appends ` (#N)`, so
 * `... looked at` lands as `... looked at (#317)`. That suffix is the ONLY
 * difference tolerated: anything else after the subject is a different commit,
 * and a subject that is merely a prefix of a base subject does not count. The
 * first version of this rule demanded whole-line equality and duly called the
 * landed branch `feat/detector-denominators` unmerged - it would have kept the
 * one tree that proved the rule was needed.
 */
export function subjectLanded(baseSubjects, subject) {
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const squashed = new RegExp(`^${escaped} \\(#\\d+\\)$`)
  return baseSubjects.some((line) => line === subject || squashed.test(line))
}

export function diskUsedPercent(target = ROOT) {
  const out = sh(`df -P ${JSON.stringify(target)} | tail -1`)
  if (!out) return null
  const m = out.match(/(\d+)%/)
  return m ? Number(m[1]) : null
}

/**
 * Every worktree, with what makes it safe or unsafe to remove.
 *
 * `merged` is asked of the COMMIT, not of the branch name: a detached worktree
 * at a commit already contained in the base is exactly as safe as a merged
 * branch, and half the worktrees a deploy leaves behind are detached.
 */
export function survey() {
  const raw = sh('git worktree list --porcelain')
  if (!raw) return null

  const trees = []
  let cur = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) trees.push(cur)
      cur = { path: line.slice(9), branch: null, head: null, detached: false }
    } else if (line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '')
    else if (line === 'detached') cur.detached = true
  }
  if (cur) trees.push(cur)

  const main = path.resolve(ROOT)
  // SIZE IS MEASURED LAST, and only for what can actually be removed.
  //
  // The first version ran `du -sm` on every worktree before classifying any of
  // them. With 33 trees, several of them multi-gigabyte, the measurement of
  // things it was never going to touch took longer than the whole rest of the
  // tool and it had to be killed. Classify with cheap git calls, then price
  // only the candidates.
  return trees
    .filter((t) => path.resolve(t.path) !== main)
    .map((t) => {
      const rec = { ...t, state: 'keep', why: '', mb: null }
      if (!fs.existsSync(t.path)) {
        rec.state = 'GONE'
        rec.why = 'the directory is missing; `git worktree prune` will clear the record'
        return rec
      }

      // MERGED IS ASKED FIRST, and the order is the whole performance of this
      // tool. "Is this commit an ancestor" is two ref lookups; `git status` has
      // to walk the working tree, and on a 2.4 GB checkout with node_modules
      // that is seconds. Asking dirtiness of all 33 trees before classifying
      // any of them timed the tool out twice - it was pricing the cleanliness
      // of trees it was never going to touch.
      //
      // An unmerged tree is kept whatever its state, so its dirtiness is not a
      // question worth asking.
      const head = t.head || sh('git rev-parse HEAD', t.path)
      if (!head) {
        rec.why = 'its HEAD could not be resolved'
        return rec
      }
      // Ancestry FIRST, then the diff - because a SQUASH merge never makes the
      // source an ancestor. Without the second question a worktree whose work
      // landed by squash looks unmerged for ever and is never reaped, which is
      // how a disk fills up while every branch on it is already in the base.
      let mergedWhy = ''
      const contained = sh(`git merge-base --is-ancestor ${head} ${BASE} && echo yes`)
      if (contained !== 'yes') {
        // The exact question, not the three-dot diff: would merging change the
        // base at all? A squash writes a new commit and leaves the source
        // looking unmerged for ever, and three-dot measures from the divergence
        // point rather than from what the base holds now.
        const baseTree = sh(`git rev-parse ${BASE}^{tree}`)
        const mergedTree = sh(`git merge-tree --write-tree ${BASE} ${head}`)
        const landed = baseTree && mergedTree && mergedTree.split('\n')[0].trim() === baseTree
        // NOT A RETURN. Both squash paths used to answer REAPABLE here and skip
        // the dirtiness question entirely, so the summary said "3 merged and
        // CLEAN" about trees whose cleanliness had never been asked - and the
        // removal then refused all three. Merged is half the question.
        if (landed) mergedWhy = `its diff against ${BASE} is empty - the work landed, by squash or otherwise`

        // AND THAT QUESTION EXPIRES. `merge-tree` asks whether merging this
        // branch would change the base AS IT STANDS NOW, which stops being true
        // the moment anyone edits the same files again - and in this loop the
        // same files are edited every round. So a branch that landed by squash
        // three rounds ago answers "unmerged" for ever, and its worktree is
        // never reaped.
        //
        // Measured 2026-09-06: 31 local worktrees, this tool called 1 of them
        // reapable, and EIGHT of the other thirty were my own trees whose work
        // had landed as #119, #121, #123, #125, #127, #313, #314 and #320. They
        // held 1.67 GB on a volume sitting at 125 MB free, and the loop that
        // filled it was reporting the disk as an anomaly it could not act on.
        //
        // The durable question is not about the base's current tree but about
        // this branch's own commits: is every one of them present in the base
        // under its own subject? A squash keeps the subject - GitHub writes the
        // PR title, and a single-commit PR's title is that commit's subject.
        //
        // WITH EXACTLY ONE PERMITTED DIFFERENCE, which the first version of this
        // rule got wrong and which cost it its own best example. GitHub appends
        // the PR number: `feat(loop): every detector reports how many files it
        // looked at` lands as `... looked at (#317)`. Demanding whole-line
        // equality therefore called a landed branch unmerged - the tool would
        // have kept the very tree that proved it was needed. Nothing else is
        // allowed to differ: a suffix that is not ` (#<digits>)` is a different
        // commit, and one unlanded commit keeps the tree.
        if (!mergedWhy) {
          const subjects = (sh(`git log --format=%s ${BASE}..${head}`) || '').split('\n').filter(Boolean)
          const missing = subjects.filter((s) => {
            const found = sh(`git log ${BASE} --format=%s --fixed-strings --grep=${JSON.stringify(s)} -n 20`)
            return !subjectLanded((found || '').split('\n'), s)
          })
          if (missing.length || !subjects.length) {
            rec.why = `${subjects.length || '?'} commit(s) not in ${BASE}` +
              (missing.length ? `, ${missing.length} whose subject is nowhere in it - unmerged work lives here` : ' - unmerged work lives here')
            return rec
          }
          mergedWhy = `all ${subjects.length} of its commit(s) are in ${BASE} under their own subject - landed by squash`
        }
      }

      // Merged, so now dirtiness decides - and it wins. A tree with uncommitted
      // work is somebody's unfinished thought, and no disk pressure justifies
      // taking it.
      const dirty = sh('git status --porcelain', t.path)
      if (dirty === null) {
        rec.why = 'its status could not be read, and unreadable is not removable'
        return rec
      }
      const held = holdsWork(dirty)
      if (held.work) {
        rec.state = 'dirty'
        rec.why = `${held.other} uncommitted change(s) - somebody is mid-thought` +
          (held.deletions ? ` (and ${held.deletions} deletion(s), which are not work)` : '')
        return rec
      }
      if (held.deletions) {
        // NOT REAPABLE, WHATEVER I THINK OF DELETIONS.
        //
        // This called a deletions-only tree removable on the argument that a
        // deletion of a file HEAD still has destroys nothing. True, and beside
        // the point: `git worktree remove` refuses ANY modified tree, and the
        // only way past it is `--force`, which this loop does not use. So the
        // tool counted three trees as "merged and clean, holding 278 MB" and
        // then removed none of them - a promise git was never going to keep.
        // Restoring the files first would work and is a mutation of somebody
        // else's tree, so it is named here and left to a human.
        rec.deletionsOnly = held.deletions
        rec.state = 'restorable'
        rec.why = `${mergedWhy}; but ${held.deletions} file(s) are deleted in the tree, and git refuses to remove it without --force - restore them (git -C <path> checkout -- .) and it becomes reapable`
        return rec
      }
      rec.state = 'REAPABLE'
      rec.why = mergedWhy || `its HEAD is already contained in ${BASE}`
      return rec
    })
}

if (isMain) {
  const doReap = process.argv.includes('--reap')
  const used = diskUsedPercent()
  const rows = survey()
  if (!rows) {
    console.log('could not list the worktrees')
    process.exit(1)
  }

  const reapable = rows.filter((r) => r.state === 'REAPABLE')
  for (const r of reapable) {
    // `du` gets a longer leash than the git calls: a 2.4 GB checkout takes
    // real time to walk, and an unpriced candidate is still removable.
    const du = sh(`du -sm ${JSON.stringify(r.path)} 2>/dev/null | cut -f1`, ROOT, 60000)
    r.mb = du ? Number(du) : null
  }
  const freeable = reapable.reduce((n, r) => n + (r.mb ?? 0), 0)
  console.log(`local worktrees   disk ${used === null ? '?' : used + '%'} used, high-water ${HIGH}%\n`)
  const order = { REAPABLE: 0, dirty: 1, keep: 2, GONE: 3 }
  for (const r of [...rows].sort((a, b) => (order[a.state] - order[b.state]) || (b.mb ?? 0) - (a.mb ?? 0))) {
    const mark = { REAPABLE: 'reap  ', dirty: 'DIRTY ', keep: 'keep  ', GONE: 'gone  ' }[r.state]
    const size = r.mb === null ? '     ' : `${String(r.mb).padStart(5)}M`
    console.log(`  ${mark}${size}  ${r.path.replace('/Users/playra', '~')}`)
    console.log(`          ${r.branch || '(detached)'} - ${r.why}`)
  }
  console.log('')

  const dirty = rows.filter((r) => r.state === 'dirty')
  console.log(`\n${rows.length} worktree(s): ${reapable.length} merged and clean, holding ${freeable} MB`)
  if (dirty.length) console.log(`${dirty.length} carry uncommitted work and are never touched, whatever the disk says`)

  if (!doReap) {
    console.log('\nreport only. re-run with --reap to remove the merged and clean ones.')
    process.exit(0)
  }

  let removed = 0
  let freed = 0
  for (const r of reapable) {
    // No `--force`, ever. A tree that refuses to go is a tree to look at.
    let out = sh(`git worktree remove ${JSON.stringify(r.path)}`)
    if (out === null && r.deletionsOnly) {
      // IT REFUSED BECAUSE THE TREE IS DIRTY, AND THE DIRT IS ONLY DELETIONS.
      //
      // `git worktree remove` will not take a tree with changes in it, which is
      // right, and `--force` is not the answer, which is also right. But a tree
      // whose every change is a deleted file that its own HEAD still contains
      // has nothing to lose: restoring from HEAD puts back exactly what git
      // already holds, and then the removal is an ordinary one.
      //
      // Two workflow worktrees sat in this state holding 4.4 GB while the disk
      // was at 98% and dispatches were dying part-way through checkout. The
      // guard was refusing correctly and the situation was still wrong.
      const restored = sh('git checkout -- .', r.path)
      if (restored !== null) out = sh(`git worktree remove ${JSON.stringify(r.path)}`)
      if (out !== null) console.log(`  restored ${r.deletionsOnly} deleted file(s) from HEAD, then removed cleanly: ${r.path.replace('/Users/playra', '~')}`)
    }
    if (out === null) {
      console.log(`  refused: ${r.path.replace('/Users/playra', '~')} - left alone rather than forced`)
      continue
    }
    removed++
    freed += r.mb ?? 0
  }
  sh('git worktree prune')
  // THE MB FIGURE IS AN UPPER BOUND AND SAYS SO.
  //
  // `du -sh` walks a worktree as if it owned every byte. It does not: a git
  // worktree shares its object store with the main checkout, and much of what du
  // counts is already on disk once. Measured 2026-09-05 - three trees reported
  // as holding 6938 MB were removed and the free space moved by about 600.
  //
  // Printing the du number as "freed" was a promise the tool could not keep, and
  // a tool that overstates what it recovers is one nobody believes about the
  // disk being full either.
  const before = freed
  const actual = diskUsedPercent()
  console.log(`\nremoved ${removed} of ${reapable.length}; du counted ${before} MB in them, which is an UPPER BOUND - a worktree shares its object store with the main checkout, so the space actually returned is smaller`)
  const after = actual === null ? diskUsedPercent() : actual
  if (after !== null) console.log(`disk now ${after}% used`)

  const L = await import(path.join(DIR, 'loop.mjs'))
  L.append({ kind: 'reap-local', removed, freedMB: freed, before: used, after, dirty: dirty.length })
  process.exit(0)
}
