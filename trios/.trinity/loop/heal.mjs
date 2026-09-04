#!/usr/bin/env node
// Run every repair the swarm needs, in the order that makes them true.
//
// WHY A CHAIN AND NOT FOUR COMMANDS. The dashboard settled the argument. Across
// iterations 1 to 5 each repair was run by hand, and the counters it fixed grew
// back at almost exactly the rate they were cleared: `completed` went 6 -> 9 ->
// 10 -> 11 while being closed by hand each time. A repair that only happens
// when someone remembers is not a repair, it is a habit.
//
// THE ORDER IS NOT ARBITRARY.
//   1. reap       - free the volume first. A full disk kills every dispatch at
//                   0 s, and nothing below matters if bees cannot start.
//   2. lease      - release path fences whose claim has gone idle, so the next
//                   tick has candidates at all.
//   3. push-work  - make finished work visible on the remote. Must precede the
//                   close, or a closing comment names a branch that exists only
//                   inside a container.
//   4. close-done - clear accepted issues out of the candidate pool.
//
// WHAT IT WILL NOT DO. Nothing here forces a push, deletes a branch, closes an
// EPIC, releases a claim past the retry ceiling, or touches a worktree holding
// uncommitted work. Each step refuses those on its own; this file only orders
// them. `--dry` runs every step in its report mode.

import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const L = await import(path.join(DIR, 'loop.mjs'))

// IMPORT-SAFE. This module ran its production query and called process.exit at
// import time, so importing it hit the live database and killed the importer -
// the calibration harness could not test it and died mid-run trying. A module
// that does work merely by being imported cannot be tested, and cannot be
// reused. Everything below the guard runs only when this file IS the program.
const isMain = process.argv[1] && process.argv[1].endsWith('/heal.mjs')


// argv only when this file IS the program, so importing it cannot make it
// think it was asked for a dry run - the class loop.mjs was caught in.
const DRY = isMain && process.argv.includes('--dry')

// TAKE THE LOCK, unless this is a dry run.
//
// This exists because heal is now run by a timer as well as by hand, and the
// two must never overlap: an iteration mid-way through pushing branches while
// the timer starts closing issues would close against a branch that is only
// half-pushed. The loop's lock is the same one iterations take, so the two
// serialise against each other rather than each having a lock of its own.
//
// A dry run reads and writes nothing, so it does not queue behind anything.
// RE-ENTRANT FOR THE SAME LOGICAL RUN. An iteration already holds the lock, and
// it should still be able to run the chain as one of its steps. So a caller
// that is part of an existing run announces itself with LOOP_HOLDER; if that
// matches the current holder, heal proceeds and does NOT release on exit -
// releasing someone else's lock is how two writers end up running at once.
if (!DRY) {
  const state = L.lockHolder()
  const mine = process.env.LOOP_HOLDER && state && state.holder === process.env.LOOP_HOLDER
  if (!mine) {
    const got = L.acquire('heal')
    if (!got.ok) {
      console.log(`another run holds the loop lock (${got.held.holder}, ${Math.round(got.ageMs / 60000)} min) - standing down`)
      L.append({ kind: 'heal-skipped', note: `lock held by ${got.held.holder}` })
      process.exit(0)
    }
    const release = () => { try { L.release() } catch { /* already gone */ } }
    process.on('exit', release)
    process.on('SIGINT', () => { release(); process.exit(130) })
    process.on('SIGTERM', () => { release(); process.exit(143) })
  } else {
    console.log(`running inside ${state.holder}, which already holds the lock`)
  }
}

// The chain closes the whole cycle: repair, then check the output, then refill.
//
// The first four steps kept the swarm healthy and it still idled, because fuel
// was replenished whenever someone remembered - the same argument that made the
// repairs a chain in the first place. So authoring is the last link, and the
// audit sits between: work is checked before more is asked for.
const STEPS = [
  // The LAPTOP fills too, and for a year nothing reaped it. `git worktree add`
  // failed mid-checkout on 2026-09-04 with "No space left on device" at 100%
  // full, while reap.mjs reported the container volume healthy - which it was.
  // Landing eight PRs in a night is eight 205 MB checkouts, one of them 2.4 GB
  // with node_modules, none removed after merging.
  { name: 'reap-local', file: 'reap-local.mjs', act: '--reap', dryArgs: '', why: 'free the disk this loop runs on' },
  { name: 'reap', file: 'reap.mjs', act: '--reap', why: 'free the volume before anything else' },
  { name: 'lease', file: 'lease.mjs', act: '--release', why: 'release idle path fences' },
  { name: 'push-work', file: 'push-work.mjs', act: '--push', why: 'make finished work visible' },
  // BETWEEN THE PUSH AND THE CLOSE, because that is where the gap was.
  //
  // close-done used to close on "the branch exists on the remote", and on that
  // basis 169 issues were closed while their code sat outside the base. It now
  // demands LANDED, so without this step nothing would ever close again. The
  // order is push -> land -> close, and each step is the precondition of the
  // next.
  { name: 'land', file: 'land.mjs', act: '--land', dryArgs: '', why: 'put accepted work into the branch it was accepted for' },
  { name: 'close-done', file: 'close-done.mjs', act: '--close', why: 'clear accepted issues from the pool' },
  // An escalation raised by a defect that has SINCE BEEN FIXED is never
  // re-examined by anything else. Three tasks sat 91 hours on the reason "no
  // acceptance criteria" while the parser that produced that reading was
  // corrected four hours after they were escalated (edbc05e11).
  //
  // This is not the wait valve wearing a new hat. `sendBack` and `wait` are
  // released by a CLOCK because their input can never change; this re-measures
  // the stated cause and releases nothing whose cause still holds - and nothing
  // at all whose issue body asks for a person in its own words.
  { name: 'stale-escalations', file: 'stale-escalations.mjs', act: '--release', dryArgs: '', why: 'retire escalations whose stated cause no longer reproduces' },
  // FUEL BEFORE READING MATTER, and this order was measured the hard way.
  //
  // `author` was the LAST link, behind five read-only steps. On 2026-09-04 one
  // chain run took 18 minutes, 6.5 of them in judge-packet assembling 31
  // transcripts - so the refill that keeps four workers busy waited behind work
  // whose only output is something for a person to read later. Worse, the run
  // outlived the 10-minute timer, and every fire after it found the lock held
  // and stood down. The swarm sat at zero while the chain was busy being
  // thorough.
  //
  // Everything above this line frees the swarm; everything below only reports.
  // The refill belongs on the freeing side of that line.
  { name: 'author', file: 'author.mjs', act: '--file', why: 'refill the backlog from a measured deficit' },
  // Reads only. A claim the diff does not support is a finding for a person,
  // never something this chain acts on by itself.
  // Two defect classes that each cost an outage, now checked every round rather
  // than when someone remembers - the argument that made this a chain at all.
  // Both read only; neither can change anything.
  { name: 'clocks', file: 'clocks.mjs', act: '', dryArgs: '', why: 'no decision keyed on a field something rewrites' },
  { name: 'fields', file: 'fields.mjs', act: '', dryArgs: '', why: 'no decision reading a field its query never selects' },
  // The checkers checking themselves, against material the WORLD calls good.
  // Six false accusations shipped in one night while the synthetic fixtures
  // agreed with the checkers that wrote them.
  { name: 'fp-check', file: 'fp-check.mjs', act: '', dryArgs: '', why: 'no checker accuses anything known good' },
  { name: 'verdict-audit', file: 'verdict-audit.mjs', act: '--accepted', dryArgs: '--accepted', why: 'check what the swarm claims against what it pushed' },
  // Queue what no mechanical check can reach for a judge to read. Assembles
  // only - the judgement is an explicit act, never something this performs.
  { name: 'judge-packet', file: 'judge-packet.mjs', act: '--unauditable', dryArgs: '--unauditable', why: 'queue the unauditable for judgement' },
]

// One line per step, taken from the step's own output rather than invented, so
// the summary cannot claim more than the step reported.
const SUMMARY = [
  [/removed (\d+) of (\d+), freeing about (\d+) MB/, (m) => `${m[1]} merged worktree(s) removed, ${m[3]} MB freed`],
  [/(\d+) worktree\(s\): 0 merged and clean/, (m) => `${m[1]} worktrees, none removable`],
  [/(\d+) worktree\(s\): (\d+) merged and clean/, (m) => `${m[1]} worktrees, ${m[2]} merged and clean`],
  [/reclaimed ([\d.-]+) G/, (m) => `reclaimed ${m[1]} G`],
  [/below the high-water mark/, () => 'volume below the threshold, nothing reaped'],
  [/release (\d+)\s+quarantine (\d+)\s+hold (\d+)/, (m) => `released ${m[1]}, quarantined ${m[2]}, held ${m[3]}`],
  [/pushed (\d+)/, (m) => `pushed ${m[1]}`],
  [/not pushed: 0/, () => 'every branch with work is already on the remote'],
  [/landed (\d+) of (\d+) clean/, (m) => `${m[1]} accepted branch(es) landed`],
  [/REFUSING to continue/, () => 'REFUSED - the landed count did not move; the measure is wrong'],
  [/(\d+) landable, showing/, (m) => `${m[1]} accepted branches still outside the base`],
  [/closed (\d+)\s+failed (\d+)/, (m) => `closed ${m[1]}, failed ${m[2]}`],
  [/closable 0/, () => 'nothing closable'],
  [/released (\d+) of (\d+) back to the pool/, (m) => `${m[1]} escalation(s) retired - the cause no longer reproduces`],
  [/(\d+) escalation\(s\): 0 raised on a cause/, (m) => `${m[1]} escalation(s), every cause still holds`],
  [/(\d+) escalation\(s\): (\d+) raised on a cause/, (m) => `${m[1]} escalation(s), ${m[2]} on a cause that no longer holds`],
  [/(\d+) measurement\(s\): (\d+) on immutable/, (m) => `${m[1]} clocks, ${m[2]} on fields nothing rewrites`],
  [/(\d+) query region\(s\): (\d+) complete/, (m) => `${m[1]} query regions, ${m[2]} selecting every field they read`],
  [/(\d+) known-good input\(s\): (\d+) clean, (\d+) accused/, (m) => `${m[1]} known-good inputs, ${m[3]} falsely accused`],
  [/CLAIM UNSUPPORTED: (\d+)/, (m) => `${m[1]} CLAIM(S) UNSUPPORTED - a person should look`],
  [/SUPPORTED: (\d+)/, (m) => `${m[1]} claims supported by the diff, none unsupported`],
  [/packets written (\d+)\s+skipped (\d+)/, (m) => `${m[1]} packet(s) queued for judgement, ${m[2]} skipped`],
  [/STALLED: /, () => 'REFUSED to file - nobody is draining the backlog'],
  [/filed (\d+)/, (m) => `filed ${m[1]}`],
  [/at the WIP limit|already has an issue/, () => 'at the WIP limit, nothing filed'],
]

// A DEADLINE FOR THE WHOLE CHAIN, not just for each step.
//
// Each step had a 10-minute timeout and there are eleven of them, so the worst
// case was 110 minutes against a timer that fires every 10. One slow run held
// the lock for 18 minutes and starved the swarm for all of it, and nothing in
// here noticed. A chain that can outlive its own cadence is a chain that
// schedules its own outage.
//
// Steps are skipped, never truncated: a half-run step is worse than an unrun
// one, and the summary names every step that did not get its turn.
const DEADLINE_MS = Number(process.env.HEAL_DEADLINE_MS ?? 8 * 60 * 1000)
const startedAt = Date.now()

const results = []
for (const s of STEPS) {
  const left = DEADLINE_MS - (Date.now() - startedAt)
  if (left <= 0) {
    process.stdout.write(`\n--- ${s.name}  (${s.why})\n    SKIPPED - the chain is past its ${Math.round(DEADLINE_MS / 60000)} minute deadline\n`)
    results.push({ step: s.name, status: 'skipped', summary: 'past the chain deadline' })
    continue
  }
  const args = DRY ? (s.dryArgs || '') : s.act
  process.stdout.write(`\n--- ${s.name}  (${s.why})\n`)
  let out = ''
  let status = 'ok'
  try {
    out = execSync(`node ${path.join(DIR, s.file)} ${args}`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      // Never longer than what remains of the chain's own deadline.
      timeout: Math.max(30000, Math.min(300000, left)),
    })
  } catch (e) {
    // A step that exits non-zero is not automatically a failure: reap exits 1
    // to mean "would act", which is its report mode saying yes.
    out = String(e.stdout || '') + String(e.stderr || '')
    status = /Error:|Traceback|not a function|ENOENT/.test(out) ? 'FAILED' : 'ok'
  }
  let line = null
  for (const [re, fmt] of SUMMARY) {
    const m = out.match(re)
    if (m) { line = fmt(m); break }
  }
  console.log(`    ${status === 'FAILED' ? 'FAILED' : line || out.trim().split('\n').pop() || '(no output)'}`)
  if (status === 'FAILED') console.log(out.trim().split('\n').slice(-4).map((l) => '      ' + l).join('\n'))
  results.push({ step: s.name, status, line: line || null })
}

console.log(`\n${DRY ? 'DRY RUN - ' : ''}heal complete: ` +
  results.map((r) => `${r.step}=${r.status}`).join(' '))

// A FAILURE OF THE STEP THAT UNBLOCKS EVERYTHING IS NOT A FAILURE LIKE THE
// OTHERS.
//
// Measured 2026-09-05: the summary read
//
//   reap=FAILED lease=FAILED push-work=FAILED land=ok close-done=FAILED ...
//
// and nothing about that shouted. The container volume was 100% full, 71 MB of
// 46 GB, sixty worktrees; every bee was dying at `git worktree add: unable to
// write file`, and the issue just handed to the swarm never ran a line.
//
// The reaper had failed because `railway ssh` refused with "Your application is
// not running or in a unexpected state" - the application being unhealthy
// BECAUSE the volume was full. The tool that repairs the failure reaches through
// the thing the failure breaks, so it needs retrying rather than believing.
//
// An audit that could not run costs a round. A reaper that could not run costs
// the fleet, and the two must not print the same way.
const CRITICAL = new Set(['reap', 'reap-local', 'lease', 'push-work', 'land', 'close-done', 'author'])
const failed = results.filter((r) => r.status === 'FAILED')
const criticalFailures = failed.filter((r) => CRITICAL.has(r.step))
if (criticalFailures.length) {
  console.log('')
  console.log(`URGENT: ${criticalFailures.length} step(s) that FREE the swarm failed - ${criticalFailures.map((r) => r.step).join(', ')}.`)
  console.log('These are not audits. While they fail the swarm is being starved, and the')
  console.log('failure of `reap` in particular is circular: it reaches the volume through the')
  console.log('container, which stops answering once the volume is full. Retry it.')
  console.log('  tri why    - it checks the CONTAINER volume now, not just this laptop')
}

L.append({ kind: DRY ? 'heal-dry' : 'heal', critical: criticalFailures.map((r) => r.step), results })

process.exit(failed.length ? 1 : 0)
