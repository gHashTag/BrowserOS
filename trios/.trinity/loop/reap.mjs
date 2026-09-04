#!/usr/bin/env node
// Reap bee worktrees before the volume fills, so the swarm never dies the way
// it died on 2026-09-04: 74 worktrees, 46 G, 100 % full, and every dispatch
// failing in 0 s with "git worktree add failed ... unable to write file".
//
// THRESHOLDS. Borrowed from the kubelet's image GC because the shape is the
// same - a cache that grows on its own and must be trimmed before it hurts.
// Reap when usage crosses HIGH, and keep reaping until it drops to LOW. A
// single threshold makes the reaper run on almost every tick once usage sits
// near it; a high/low pair gives it hysteresis.
//
// SAFETY, and the part that is measured rather than assumed. `git worktree
// remove` WITHOUT --force refuses any tree carrying modified or untracked
// files, and it removes only the working directory - the branch ref and every
// commit on it survive. On 2026-09-04 that refused exactly 4 of 74 trees, which
// is the whole point: those four held uncommitted work. Published advice says
// agent worktrees are always unclean so --force is mandatory; on this fleet
// that is false, 70 of 74 were clean, and --force would have destroyed the four
// that were not. Never pass --force here.
//
// `git worktree prune` does NOT free space. It only drops metadata for trees
// whose directory is already gone. `remove` is what reclaims bytes; `prune`
// tidies up after.
//
// Usage:
//   node reap.mjs              # report only, change nothing
//   node reap.mjs --reap       # reap if usage is at or above HIGH

import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const L = await import(path.join(path.dirname(fileURLToPath(import.meta.url)), 'loop.mjs'))
const { shq } = L

// IMPORT-SAFE. This module ran its production query and called process.exit at
// import time, so importing it hit the live database and killed the importer -
// the calibration harness could not test it and died mid-run trying. A module
// that does work merely by being imported cannot be tested, and cannot be
// reused. Everything below the guard runs only when this file IS the program.
const isMain = process.argv[1] && process.argv[1].endsWith('/reap.mjs')


// MEASURED, NOT CHOSEN. The volume went 27% -> 67% in under three hours with
// four bees running: roughly fifteen points an hour. At that rate a threshold
// of 80 gives about fifty-five minutes of warning, and the timer only looks
// every twenty. That is not a margin, it is a coin toss - and the failure it
// guards against is total: at 100% every dispatch dies at 0 s and nothing else
// in the chain matters.
//
// 55 is a little over three hours of headroom at the observed rate, which is
// nine timer firings rather than three.
const HIGH = Number(process.env.REAP_HIGH ?? 55)   // start reaping at this % used
const LOW = Number(process.env.REAP_LOW ?? 30)     // stop once down to this
const KEEP_NEWEST = Number(process.env.REAP_KEEP ?? 6) // never touch the newest N
const SVC = 'trios-agent-server'

/**
 * The railway invocation, with the project named EXPLICITLY.
 *
 * `railway ssh --service X` resolves the project from whatever directory it is
 * run in, by walking up until it finds a linked one. That works from a shell a
 * person is sitting in and does not work from a launchd timer: measured
 * 2026-09-04, every railway-calling step of the chain failed with
 * `Must provide project when setting service or environment`, while the
 * read-only steps passed - so the timer reported a mostly-healthy chain that
 * had pushed nothing, closed nothing and released nothing for hours, and the
 * swarm sat idle between the runs I happened to trigger by hand.
 *
 * Naming the project removes the dependency on where the process happens to be
 * standing. The id is public - it is in every build URL this repository has
 * ever printed - and carries no credential.
 */
export const RAILWAY = `railway ssh --project 564d9ebd-7aa8-44fe-93ec-e0b03c87158d --environment production`

const WT = '/workspace/BrowserOS/.worktrees'
const GIT = 'git -c safe.directory=* -C /workspace/BrowserOS'

function remote(script) {
  const out = execSync(
    `${RAILWAY} --service ${SVC} -- sh -c ${shq(script)}`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 280000 },
  )
  // railway prints connection chatter on the same stream; drop it.
  return out.split('\n').filter((l) => !/Using SSH|railway\.json|Migrate|Existing/.test(l)).join('\n')
}

export function usage() {
  const raw = remote(`df -P ${WT} | tail -1; echo ---; ls ${WT} 2>/dev/null | wc -l`)
  const [dfLine, , countLine] = raw.split('\n')
  const cols = (dfLine || '').trim().split(/\s+/)
  return {
    percent: Number(String(cols[4] || '0').replace('%', '')),
    freeKb: Number(cols[3] || 0),
    trees: Number((countLine || '0').trim()),
  }
}

// A LOW at or above HIGH makes the inner loop break on its first test, so the
// reaper would run, remove nothing, and report success. That is the defect this
// project keeps finding in itself - a tool that cannot do its job and says
// nothing - so it is a hard error rather than a warning.
if (!isMain) { /* imported for calibration or reuse: do nothing */ } else {
if (!(LOW < HIGH)) {
  console.error(`REAP_LOW (${LOW}) must be below REAP_HIGH (${HIGH}); as configured the reaper would free nothing and report success`)
  process.exit(2)
}

const before = usage()
console.log(`volume ${before.percent}% used, ${(before.freeKb / 1048576).toFixed(1)} G free, ${before.trees} worktrees`)

// A LEVEL IS NOT A RATE. 67% falling is fine; 50% climbing fifteen points an
// hour is twenty minutes from the threshold and an hour from a dead swarm. The
// previous reading is the only thing that tells them apart, so it is recorded
// on every run whether or not anything is reaped.
{
  const prev = L.anchorOf('volume.percent')
  const prevAt = (L.loadState().anchors['volume.percent'] || {}).at
  L.anchor('volume.percent', before.percent)
  if (prev !== undefined && prev !== null && prevAt) {
    const hours = (Date.now() - Date.parse(prevAt)) / 3600000
    if (hours > 0.05) {
      const rate = (before.percent - prev) / hours
      const toFull = rate > 0.5 ? (100 - before.percent) / rate : null
      console.log(
        `  rate: ${rate >= 0 ? '+' : ''}${rate.toFixed(1)} points/hour since ${prevAt.slice(11, 16)}` +
        (toFull !== null ? `  -  full in about ${toFull.toFixed(1)} h at this rate` : ''),
      )
      if (toFull !== null && toFull < 2) {
        console.log('  WARNING: under two hours of headroom. The threshold is a level; this is the rate.')
      }
    }
  }
}
console.log(`thresholds: reap at >=${HIGH}%, down to ${LOW}%, always keep the newest ${KEEP_NEWEST}`)

if (before.percent < HIGH) {
  console.log(`below the high-water mark - nothing to do`)
  process.exit(0)
}
if (!process.argv.includes('--reap')) {
  console.log(`AT OR ABOVE the high-water mark. Re-run with --reap to act.`)
  process.exit(1)
}

// Oldest first, and never the newest few: a tree that was just created probably
// belongs to a bee that is still running, and `worktree remove` would not
// refuse it because a fresh checkout is clean.
// ONE LINE for the same reason the survey in push-work.mjs is one line: a real
// newline becomes a literal backslash-n inside `sh -c "..."`, so a multi-line
// script arrives as one line and fails to parse. This branch had never been
// executed, so the bug sat here unnoticed until push-work.mjs hit it.
const script = [
  'removed=0; refused=0; i=0',
  `total=$(ls -d ${WT}/*/ 2>/dev/null | wc -l)`,
  `for d in $(ls -dtr ${WT}/*/ 2>/dev/null); do i=$((i+1)); if [ $((total - i)) -lt ${KEEP_NEWEST} ]; then break; fi; pct=$(df -P ${WT} | tail -1 | awk '{gsub("%","",$5); print $5}'); if [ "$pct" -le ${LOW} ]; then break; fi; if ${GIT} worktree remove "$d" 2>/dev/null; then removed=$((removed+1)); else refused=$((refused+1)); fi; done`,
  `${GIT} worktree prune`,
  'echo "REAPED removed=$removed refused=$refused of $total"',
].join('; ')

console.log(remote(script).trim())
const after = usage()
console.log(`now ${after.percent}% used, ${(after.freeKb / 1048576).toFixed(1)} G free, ${after.trees} worktrees`)
console.log(`reclaimed ${((after.freeKb - before.freeKb) / 1048576).toFixed(1)} G`)
// Record the act, so `tri loop-coverage` can tell a reaper that has run from
// one that has only ever reported. An unproven act path is the defect this
// tool itself carried for two iterations.
L.append({
  kind: 'reaped',
  before: { percent: before.percent, trees: before.trees },
  after: { percent: after.percent, trees: after.trees },
  reclaimedG: Number(((after.freeKb - before.freeKb) / 1048576).toFixed(1)),
})
}
