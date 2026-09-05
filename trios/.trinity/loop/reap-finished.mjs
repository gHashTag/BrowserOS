#!/usr/bin/env node
// Remove a worktree when its work is safe, not when the disk is full.
//
// THE DEFECT THIS EXISTS FOR. An hour after the volume was reaped from 95% to
// 32%, it was back at 87%. Asked what was in it: 17 worktrees, and only TWO
// belonged to a bee that was still running. Fifteen were left behind by
// dispatches that had finished, eleven of those with their branch already on the
// remote - about 27 GB of pure redundancy, waiting for a watermark to notice.
//
// A worktree has a KNOWN LIFETIME. It is created for a dispatch and it stops
// being needed the moment that dispatch's work is published. Leaving it to a
// garbage collector is the design error: CI deletes a workspace when the job
// ends, a Kubernetes job's pod goes when the job completes, and neither waits
// for a disk-pressure threshold to remember.
//
// The watermark reaper is not replaced. It stays as the backstop it should
// always have been - for the trees this cannot take, and for the case where
// something goes wrong upstream and pressure is the only signal left.
//
// THE THREE CONDITIONS, all required:
//
//   the dispatch has FINISHED    a running bee's tree is its workspace
//   the branch is ON THE REMOTE  the work has somewhere else to exist
//   `git worktree remove` agrees no --force, so anything uncommitted survives
//
// The second is the one that matters. This removes a checkout, never a commit,
// and it refuses to remove a checkout whose commits nobody else has.
//
// Usage:
//   node reap-finished.mjs           # report what is redundant
//   node reap-finished.mjs --reap    # remove it

import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/reap-finished.mjs')
const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const WT = process.env.TRIOS_WORKTREES || '/workspace/BrowserOS/.worktrees'

const sh = (cmd) => {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}

/**
 * Which trees are redundant: finished, published, and not somebody's workspace.
 *
 * `running` and `pushed` are passed in rather than fetched here so the decision
 * can be tested without a container or a database. Every exclusion is explicit -
 * a tree that fails any condition is returned with the reason it was kept, since
 * a silent omission reads as "there was nothing to do".
 */
export function decide(trees, running, pushed) {
  const runningSet = new Set(running)
  const pushedSet = new Set(pushed)
  const remove = []
  const keep = []
  for (const t of trees) {
    if (runningSet.has(t)) { keep.push({ tree: t, why: 'its bee is still running - this is somebody\'s workspace' }); continue }
    if (!pushedSet.has(t)) { keep.push({ tree: t, why: 'no branch on the remote - its commits exist nowhere else' }); continue }
    remove.push(t)
  }
  return { remove, keep }
}

/** The shell that removes them, one at a time, never forcing. */
export function script(trees) {
  if (!trees.length) return 'echo "REAPED removed=0 refused=0 of 0"'
  const list = trees.map((t) => JSON.stringify(t)).join(' ')
  return `
removed=0; refused=0; total=0
for n in ${list}; do
  d="${WT}/$n"
  [ -d "$d" ] || continue
  total=$((total+1))
  if git -c safe.directory=* -C /workspace/BrowserOS worktree remove "$d" 2>/dev/null; then
    removed=$((removed+1)); echo "  removed $n"
  else
    refused=$((refused+1)); echo "  refused $n - left alone rather than forced"
  fi
done
git -c safe.directory=* -C /workspace/BrowserOS worktree prune 2>/dev/null || true
echo "REAPED removed=$removed refused=$refused of $total"
`
}

export function parse(out) {
  const m = String(out || '').match(/REAPED removed=(\d+) refused=(\d+) of (\d+)/)
  return m ? { removed: Number(m[1]), refused: Number(m[2]), total: Number(m[3]) } : null
}

if (isMain) {
  const CH = await import(path.join(DIR, 'channel.mjs'))
  const SE = await import(path.join(DIR, 'stale-escalations.mjs'))
  const ACT = process.argv.includes('--reap')

  const trees = (CH.remote(`ls -1 ${WT} 2>/dev/null`, { attempts: 2 }) || '')
    .split('\n').map((s) => s.trim()).filter(Boolean)
  if (!trees.length) {
    console.log('no worktrees in the container - nothing to be redundant')
    process.exit(0)
  }

  // EMPTY IS NOT ABSENT. A board that says nobody is running and a board that
  // could not be read both produce an empty list, and from them follow opposite
  // conclusions: remove everything, or remove nothing.
  let running = []
  let boardRead = false
  const js = 'const {Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL});' +
    '(async()=>{try{const r=await p.query("select branch from queen_dispatch where finished_at is null and branch is not null");' +
    'console.log(JSON.stringify(r.rows.map(x=>x.branch)))}catch(e){console.log("ERR")}await p.end()})()'
  try {
    const raw = SE.remote(js)
    const line = String(raw ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('['))
    if (line) { running = JSON.parse(line); boardRead = true }
  } catch { /* boardRead stays false */ }

  if (!boardRead) {
    console.log('could not read which bees are running - refusing to remove anything.')
    console.log('An unreadable board is not an empty one, and here the two lead to opposite acts.')
    process.exit(3)
  }

  const pushed = (sh(`git branch -r --list 'origin/queen-*'`) || '')
    .split('\n').map((l) => (l.match(/origin\/(queen-\d+)\s*$/) || [])[1]).filter(Boolean)

  const { remove, keep } = decide(trees, running, pushed)
  console.log(`${trees.length} worktree(s): ${remove.length} redundant, ${keep.length} kept`)
  for (const k of keep.slice(0, 8)) console.log(`  keep ${k.tree.padEnd(14)} ${k.why}`)
  if (!ACT) {
    console.log(`\nreport only. re-run with --reap to remove the ${remove.length} redundant one(s).`)
    console.log('A worktree stops being needed when its work is published, not when the disk fills.')
    process.exit(0)
  }

  const out = CH.remote(script(remove), { attempts: 2, timeout: 280000 })
  console.log(out)
  const t = parse(out)
  if (t) console.log(`removed ${t.removed} of ${t.total} redundant worktree(s), ${t.refused} refused and left alone`)
  process.exit(0)
}
