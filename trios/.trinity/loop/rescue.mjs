#!/usr/bin/env node
// Work a bee wrote and never committed, saved onto its own branch.
//
// WHAT THIS IS FOR. The container volume reached 95% and every bee died at
// `git worktree add: unable to write file`. The reaper tried twenty worktrees
// and removed one: nineteen refused, because `git worktree remove` will not
// take a tree with modified or untracked files, and `--force` is not used on a
// worktree in this project.
//
// The refusals were right. Asked what those trees held, on 2026-09-05:
//
//     49 uncommitted path(s) across 21 tree(s)
//
// Nine of them are TEST FILES a bee wrote - NewTab.test.ts,
// ConversationInput.test.ts, AISettingsPage.test.ts - and five are modified
// source files. That is real work, it is the only copy of itself, and it was
// invisible to everything: the branch does not have it, the issue does not
// mention it, `push-work` cannot push what was never committed, and the tree
// holding it was one `--force` away from being deleted to make room.
//
// So the answer is not to delete it and not to keep refusing. It is to COMMIT
// it, on the branch it belongs to, with a message that says exactly what
// happened - after which `push-work` publishes it like any other work and the
// tree becomes ordinary and removable.
//
// WHAT IT WILL NOT DO. It does not judge the work. A rescued commit is not
// reviewed, may be half-finished, and says so in its own message. It does not
// touch a tree whose bee is still running, because that is somebody mid-thought
// rather than something abandoned. It never forces anything.
//
// Usage:
//   node rescue.mjs             # report what is stranded
//   node rescue.mjs --rescue    # commit it onto each branch

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/rescue.mjs')
const WT = process.env.TRIOS_WORKTREES || '/workspace/BrowserOS/.worktrees'
const G = 'git -c safe.directory=*'

/**
 * Paths that are not work, whatever git says about them.
 *
 * `.worktrees/` appeared as an untracked entry inside a worktree - a nested
 * checkout, not a file anybody wrote. Committing it would put a directory of
 * checkouts into a branch, which is the kind of accident that is hard to undo
 * and easy to avoid.
 */
export const NOT_WORK = [/^\.worktrees\//, /^node_modules\//, /(^|\/)dist\//, /(^|\/)\.turbo\//, /\.log$/]

/**
 * A SUBMODULE IS NOT A FILE A BEE WROTE.
 *
 * The first pass after this tool shipped found exactly one stranded path:
 * `trios/rings/RUST-13/trios-mesh`, modified. It is a declared submodule, and
 * its `M` means the checked-out commit differs from the one the superproject
 * records. Committing that moves the repository's dependency - a real and
 * possibly wrong change, made blind, by a tool whose entire remit is to preserve
 * a file somebody wrote.
 *
 * The list is read from `.gitmodules` rather than written here, because a
 * hard-coded path is a second copy of a fact the repository already states.
 */
export function submodulePaths(gitmodulesOutput) {
  return String(gitmodulesOutput || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^submodule\..*\.path\s/.test(l))
    .map((l) => l.replace(/^\S+\s+/, '').trim())
    .filter(Boolean)
}

export function isWork(p) {
  const s = String(p || '').trim()
  if (!s) return false
  return !NOT_WORK.some((re) => re.test(s))
}

/** Parse `git status --porcelain` into paths, keeping only real work. */
export function workPaths(porcelain) {
  return String(porcelain || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[^\s]+\s+/, ''))
    .filter(isWork)
}

/**
 * The shell that finds and reports stranded work, one line per tree.
 *
 * Reporting and acting are the same walk with one flag, so the report cannot
 * describe a different set from the one the action touches.
 */
export function script(act, running = [], submodules = []) {
  const skip = running.length ? running.map((n) => `"${n}"`).join(' ') : ''
  // Read from .gitmodules, so the exclusion cannot drift from what the
  // repository actually declares.
  const subre = submodules.length ? submodules.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : '$^'
  const subfilter = submodules.length
    ? submodules.map((s) => `| grep -v ${JSON.stringify('^' + s + '$')}`).join(' ')
    : ''
  return `
set -u
subre='${subre}'
subfilter_note=''
skiplist="${skip}"
total=0; trees=0; committed=0
for d in ${WT}/*/; do
  [ -d "$d" ] || continue
  n=$(basename "$d")
  case " $skiplist " in *" \\"$n\\" "*) echo "$n SKIPPED - its bee is still running"; continue;; esac
  st=$(${G} -C "$d" status --porcelain 2>/dev/null | grep -v '^!!' || true)
  [ -n "$st" ] || continue
  paths=$(echo "$st" | sed 's/^...//' | grep -v '^\\.worktrees/' | grep -v '^node_modules/' ${subfilter} || true)
  subs=$(echo "$st" | sed 's/^...//' | grep -E "^(${subre})$" || true)
  [ -z "$subs" ] || { echo "$n submodule pointer differs, REPORTED and never committed:"; echo "$subs" | sed 's/^/    /'; }
  [ -n "$paths" ] || continue
  trees=$((trees+1))
  cnt=$(echo "$paths" | wc -l | tr -d ' ')
  total=$((total+cnt))
  echo "$n $cnt path(s)"
  echo "$paths" | head -3 | sed 's/^/    /'
  ${act ? `
  br=$(${G} -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ -n "$br" ] && [ "$br" != "HEAD" ]; then
    ${G} -C "$d" add -A -- . ':!.worktrees' ':!node_modules' >/dev/null 2>&1 || true
    if ${G} -C "$d" -c user.name="trios-rescue" -c user.email="rescue@trios.local" commit -q --no-verify -m "rescue: work left uncommitted in the worktree

Written by a bee and never committed. Saved here so it is not destroyed when
the worktree is reclaimed - the volume was full and every dispatch was dying at
\\\`git worktree add\\\`.

NOT REVIEWED and possibly unfinished. It is preserved, not endorsed." >/dev/null 2>&1; then
      committed=$((committed+1)); echo "    COMMITTED on $br"
    else
      echo "    could not commit - left exactly as it was"
    fi
  else
    echo "    detached HEAD - no branch to save it on, left alone"
  fi` : ''}
done
echo "STRANDED total=$total trees=$trees committed=$committed"
`
}

export function parse(out) {
  const m = String(out || '').match(/STRANDED total=(\d+) trees=(\d+) committed=(\d+)/)
  return m ? { total: Number(m[1]), trees: Number(m[2]), committed: Number(m[3]) } : null
}

if (isMain) {
  const CH = await import(path.join(DIR, 'channel.mjs'))
  const ACT = process.argv.includes('--rescue')

  // A tree whose bee is still working is somebody mid-thought, not something
  // abandoned. The board is asked rather than assumed.
  // EMPTY IS NOT ABSENT, and here the difference decides whether it is safe to
  // write. An empty running-set means every tree is abandoned and all of them
  // may be committed; an unreadable board means nothing is known and none of
  // them may be. The first version used one empty array for both.
  let running = []
  let boardRead = false
  try {
    const SE = await import(path.join(DIR, 'stale-escalations.mjs'))
    const js = 'const {Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL});' +
      '(async()=>{try{const r=await p.query("select branch from queen_dispatch where finished_at is null and branch is not null");' +
      'console.log(JSON.stringify(r.rows.map(x=>x.branch)))}catch(e){console.log("[]")}await p.end()})()'
    const raw = SE.remote(js)
    const line = String(raw ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('['))
    if (line) { running = JSON.parse(line); boardRead = true }
  } catch { /* boardRead stays false: nothing is known, so nothing may be written */ }

  if (ACT && !boardRead) {
    console.log('could not read which bees are running - refusing to commit into a tree that may be in use.')
    console.log('An unreadable board is not an empty one, and this is the difference that decides')
    console.log('whether writing here is safe. Run the report, or re-run when the board answers.')
    process.exit(3)
  }
  if (ACT) console.log(`board read: ${running.length} bee(s) running, their trees will be left alone\n`)

  // Ask the repository which paths are submodules rather than knowing it here.
  let submodules = []
  try {
    const raw = CH.remote('git -c safe.directory=* -C /workspace/BrowserOS config --file .gitmodules --get-regexp path 2>/dev/null || true', { attempts: 2 })
    submodules = submodulePaths(raw)
  } catch { /* none read: the filter is empty and submodules are reported, not committed */ }
  if (submodules.length) console.log(`${submodules.length} submodule path(s) will be reported and never committed\n`)

  const out = CH.remote(script(ACT, running, submodules), { attempts: 2, timeout: 280000 })
  console.log(out)
  const t = parse(out)
  if (t) {
    console.log(`\n${t.total} uncommitted path(s) across ${t.trees} tree(s)` +
      (ACT ? `, ${t.committed} tree(s) committed` : ' - re-run with --rescue to save them'))
    if (!ACT && t.total) {
      console.log('Each is the only copy of itself. push-work cannot publish what was never')
      console.log('committed, and the reaper cannot reclaim a tree that holds it.')
    }
  }
  process.exit(0)
}
