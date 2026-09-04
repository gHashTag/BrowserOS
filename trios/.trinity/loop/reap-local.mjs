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

/** Percent of the root filesystem in use, or null if it cannot be read. */
export function diskUsedPercent() {
  const out = sh('df -P / | tail -1')
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
      const contained = sh(`git merge-base --is-ancestor ${head} ${BASE} && echo yes`)
      if (contained !== 'yes') {
        const ahead = sh(`git rev-list --count ${BASE}..${head}`)
        rec.why = `${ahead ?? '?'} commit(s) not in ${BASE} - unmerged work lives here`
        return rec
      }

      // Merged, so now dirtiness decides - and it wins. A tree with uncommitted
      // work is somebody's unfinished thought, and no disk pressure justifies
      // taking it.
      const dirty = sh('git status --porcelain', t.path)
      if (dirty === null) {
        rec.why = 'its status could not be read, and unreadable is not removable'
        return rec
      }
      if (dirty.length > 0) {
        rec.state = 'dirty'
        rec.why = `${dirty.split('\n').length} uncommitted change(s) - somebody is mid-thought`
        return rec
      }
      rec.state = 'REAPABLE'
      rec.why = `its HEAD is already contained in ${BASE}`
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
    const out = sh(`git worktree remove ${JSON.stringify(r.path)}`)
    if (out === null) {
      console.log(`  refused: ${r.path.replace('/Users/playra', '~')} - left alone rather than forced`)
      continue
    }
    removed++
    freed += r.mb ?? 0
  }
  sh('git worktree prune')
  console.log(`\nremoved ${removed} of ${reapable.length}, freeing about ${freed} MB`)
  const after = diskUsedPercent()
  if (after !== null) console.log(`disk now ${after}% used`)

  const L = await import(path.join(DIR, 'loop.mjs'))
  L.append({ kind: 'reap-local', removed, freedMB: freed, before: used, after, dirty: dirty.length })
  process.exit(0)
}
