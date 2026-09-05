#!/usr/bin/env node
// One installed dependency tree, linked into every worktree that wants it.
//
// WHAT THIS IS FOR. Eight of eleven container worktrees carried their own
// `node_modules` at about 2.5 GB each - roughly 19 GB of the same packages on a
// 46 GB volume. `bun install` copies out of its cache into every install, and
// three rounds of reaper work could not out-collect that.
//
// AND THE OBVIOUS VERSION DOES NOT WORK, which is why this is a link FARM and
// not a symlinked directory. Moving `node_modules` to a shared place and
// pointing at it breaks immediately:
//
//   error: Cannot find module '@browseros/shared/constants/limits'
//
// A bun workspace links its own packages INSIDE node_modules by relative path.
// Shared away, those links resolve against the store instead of the worktree and
// find nothing. So the store holds the external packages, each worktree gets a
// real directory of links to them, and the workspace packages are linked back
// to that worktree's own sources.
//
// That is pnpm's arrangement, arrived at by hitting the same wall it was built
// for. The store root has 14 top-level entries because bun hoists into `.bun`,
// so the farm is fourteen symlinks per node_modules directory, seven
// directories per worktree.
//
// PROVEN BY INTERVENTION, not argued. Two worktrees rebuilt against one store:
//
//   queen-1555   2536M -> 159M   8 tests pass
//   queen-1528   2561M -> 159M   8 tests pass
//
// The lockfile hash is identical across every worktree - they are checkouts of
// one repository at nearly one commit - and the store is keyed by that hash, so
// a worktree whose dependencies differ gets its own store rather than the wrong
// packages.
//
// IT NEVER TOUCHES A RUNNING BEE'S TREE. Rebuilding node_modules under a running
// install is how a dispatch dies for a reason nobody can reconstruct.
//
// Usage:
//   node share-modules.mjs           # what it would do
//   node share-modules.mjs --share   # do it

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/share-modules.mjs')
const WT = process.env.TRIOS_WORKTREES || '/workspace/BrowserOS/.worktrees'
const STORE = process.env.TRIOS_MODULE_STORE || '/workspace/BrowserOS/.node_modules_store'

/** Big enough to be a private install rather than a bare checkout. */
export const BIG_MB = Number(process.env.TRIOS_SHARE_MIN_MB || 500)

/**
 * Which trees are worth rebuilding, and which must be left alone.
 *
 * Returned with reasons, because a tool that silently skips things reads as a
 * tool that found nothing to do.
 */
export function decide(trees, running, minMb = BIG_MB) {
  const runningSet = new Set(running)
  const share = []
  const keep = []
  for (const t of trees) {
    if (runningSet.has(t.name)) { keep.push({ ...t, why: 'its bee is running - rebuilding node_modules under a live install kills the dispatch' }); continue }
    if (!(t.mb >= minMb)) { keep.push({ ...t, why: `${t.mb}M - no private install to share` }); continue }
    share.push(t)
  }
  return { share, keep }
}

/** The walk that measures every worktree once. */
export function surveyScript() {
  return `
for d in ${WT}/*/; do
  [ -d "$d" ] || continue
  n=$(basename "$d")
  mb=$(du -sm "$d" 2>/dev/null | cut -f1)
  f="$d/trios/agent-server/bun.lock"
  [ -f "$f" ] || f="$d/trios/agent-server/bun.lockb"
  h=$(md5sum "$f" 2>/dev/null | cut -c1-12)
  echo "TREE $n \${mb:-0} \${h:-nolock}"
done
`
}

export function parseSurvey(out) {
  return String(out || '').split('\n')
    .map((l) => l.match(/^TREE (\S+) (\d+) (\S+)$/))
    .filter(Boolean)
    .map((m) => ({ name: m[1], mb: Number(m[2]), lock: m[3] }))
}

/**
 * Promote one tree's install into the store, then farm every chosen tree.
 *
 * The first tree with a given lock hash donates its install; the rest are
 * rebuilt as farms. A tree whose store does not exist and which is not the
 * donor is left alone rather than emptied.
 */
export function shareScript(trees) {
  if (!trees.length) return 'echo "SHARED trees=0 saved=0"'
  const list = trees.map((t) => `${t.name}:${t.lock}`).join(' ')
  return `
set -u
saved=0; done_n=0
for pair in ${list}; do
  n=\${pair%%:*}; h=\${pair##*:}
  W=${WT}/$n
  S=${STORE}/$h
  [ -d "$W" ] || continue
  before=$(du -sm "$W" 2>/dev/null | cut -f1)

  # The first tree of this lock hash donates its install to the store.
  if [ ! -d "$S" ]; then
    mkdir -p "$S"
    for rel in $(cd "$W" && find . -maxdepth 6 -name node_modules -type d -prune 2>/dev/null | sed 's|^\\./||'); do
      mkdir -p "$(dirname "$S/$rel")"
      mv "$W/$rel" "$S/$rel" 2>/dev/null || true
    done
    echo "  $n donated its install to the store for $h"
  fi

  for rel in $(cd "$S" && find . -maxdepth 6 -name node_modules -type d -prune 2>/dev/null | sed 's|^\\./||'); do
    src="$S/$rel"
    rm -rf "$W/$rel"
    mkdir -p "$W/$rel"
    for e in "$src"/*; do ln -s "$e" "$W/$rel/$(basename "$e")" 2>/dev/null || true; done
    # A bun workspace links its OWN packages by relative path inside
    # node_modules. Shared away they resolve against the store and find
    # nothing, so they are linked back to this worktree's sources.
    if [ -d "$src/@browseros" ]; then
      rm -f "$W/$rel/@browseros"; mkdir -p "$W/$rel/@browseros"
      for w in "$src/@browseros"/*; do
        real=$(readlink -f "$w" 2>/dev/null || echo "")
        mapped=$(echo "$real" | sed "s|$S|$W|")
        if [ -d "$mapped" ]; then ln -s "$mapped" "$W/$rel/@browseros/$(basename "$w")"
        else ln -s "$w" "$W/$rel/@browseros/$(basename "$w")"; fi
      done
    fi
  done
  chown -R 999:999 "$W" "$S" 2>/dev/null || true
  after=$(du -sm "$W" 2>/dev/null | cut -f1)
  saved=$((saved + before - after))
  done_n=$((done_n+1))
  echo "  $n \${before}M -> \${after}M"
done
echo "SHARED trees=$done_n saved=\${saved}"
`
}

export function parseShared(out) {
  const m = String(out || '').match(/SHARED trees=(\d+) saved=(\d+)/)
  return m ? { trees: Number(m[1]), savedMb: Number(m[2]) } : null
}

if (isMain) {
  const CH = await import(path.join(DIR, 'channel.mjs'))
  const SE = await import(path.join(DIR, 'stale-escalations.mjs'))
  const ACT = process.argv.includes('--share')

  const trees = parseSurvey(CH.remote(surveyScript(), { attempts: 2, timeout: 280000 }))
  if (!trees.length) {
    console.log('no worktrees in the container - nothing to share')
    process.exit(0)
  }

  // EMPTY IS NOT ABSENT. A board that says nobody is running and a board that
  // could not be read give the same empty list, and here they lead to opposite
  // acts: rebuild everything, or rebuild nothing.
  let running = []
  let boardRead = false
  try {
    const js = 'const {Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL});' +
      '(async()=>{try{const r=await p.query("select branch from queen_dispatch where finished_at is null and branch is not null");' +
      'console.log(JSON.stringify(r.rows.map(x=>x.branch)))}catch(e){console.log("ERR")}await p.end()})()'
    const raw = SE.remote(js)
    const line = String(raw ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('['))
    if (line) { running = JSON.parse(line); boardRead = true }
  } catch { /* boardRead stays false */ }

  if (ACT && !boardRead) {
    console.log('could not read which bees are running - refusing to rebuild anything.')
    console.log('Rebuilding node_modules under a live install kills the dispatch, and an')
    console.log('unreadable board is not an empty one.')
    process.exit(3)
  }

  const { share, keep } = decide(trees, running)
  const total = share.reduce((a, t) => a + t.mb, 0)
  console.log(`${trees.length} worktree(s): ${share.length} with a private install (${total} MB), ${keep.length} left alone`)
  for (const k of keep.slice(0, 6)) console.log(`  keep ${k.name.padEnd(14)} ${k.why}`)

  if (!ACT) {
    console.log(`\nreport only. re-run with --share to rebuild ${share.length} tree(s) against one store.`)
    console.log('Proven on two: 2536M -> 159M and 2561M -> 159M, tests passing through the farm.')
    process.exit(0)
  }

  const out = CH.remote(shareScript(share), { attempts: 2, timeout: 280000 })
  console.log(out)
  const r = parseShared(out)
  if (r) console.log(`\n${r.trees} tree(s) rebuilt against one store, about ${r.savedMb} MB returned to the volume`)
  process.exit(0)
}
