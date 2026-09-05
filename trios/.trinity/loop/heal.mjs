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
let releaseLock = () => {}
let heldLock = false

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
    const got = L.acquire('heal', { singleProcess: true })
    if (!got.ok) {
      console.log(`another run holds the loop lock (${got.held.holder}, ${Math.round(got.ageMs / 60000)} min) - standing down`)
      L.append({ kind: 'heal-skipped', note: `lock held by ${got.held.holder}` })
      process.exit(0)
    }
    const release = () => { try { L.release() } catch { /* already gone */ } }
    releaseLock = release
    heldLock = true
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
  // FIRST, because it records the state that explains everything after it.
  //
  // Three steps failed at 01:15:53 with "your application is not running", and
  // `/health` answered ok a minute later. A minute is too late: by then the
  // world has moved. Sampling both views together, before the remote steps run,
  // is what turns the next outage into evidence instead of an anecdote.
  { name: 'two-views', file: 'two-views.mjs', act: '--record', dryArgs: '', why: 'both views of the service, at the same moment' },
  { name: 'reap-local', file: 'reap-local.mjs', act: '--reap', dryArgs: '', why: 'free the disk this loop runs on' },
  // BEFORE the reaper, because the reaper cannot take a tree that holds work and
  // the work is the only copy of itself. On 2026-09-05 nineteen trees refused
  // removal while the volume sat at 95% and every bee died at `git worktree
  // add`; they held 52 uncommitted paths, nine of them test files a bee had
  // written and never committed. Rescued first, the same reaper freed 28.6 G.
  { name: 'rescue', file: 'rescue.mjs', act: '--rescue', dryArgs: '', why: 'save work a bee never committed, before anything reclaims it' },
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
  // RIGHT AFTER THE PUSH, because that is when a worktree stops being needed.
  //
  // An hour after the volume went from 95% to 32% it was back at 87%: seventeen
  // worktrees, only TWO belonging to a running bee. Fifteen were left by
  // finished dispatches and eleven had their branch on the remote already -
  // about 27 GB of pure redundancy waiting for a watermark to notice.
  //
  // A worktree has a known lifetime. CI deletes a workspace when the job ends;
  // it does not wait for disk pressure to remember. The watermark reaper stays
  // as the backstop it should always have been.
  { name: 'reap-finished', file: 'reap-finished.mjs', act: '--reap', dryArgs: '', why: 'a worktree stops being needed when its work is published' },
  // AFTER the redundant trees are gone, share what the rest are duplicating.
  //
  // Eight of eleven worktrees carried their own node_modules at ~2.5 GB - about
  // 19 GB of identical packages on a 46 GB volume, which no collector can
  // out-pace. One store, a farm of links per worktree, and the workspace
  // packages linked back home. First run returned 14.3 GB.
  { name: 'share-modules', file: 'share-modules.mjs', act: '--share', dryArgs: '', why: 'one installed dependency tree, linked into every worktree' },
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
  // ---- the line the file has always drawn in prose, now drawn in data. ----
  // Everything above frees the swarm. Everything below only reports, and the
  // two must not compete for the same budget.
  { name: 'clocks', file: 'clocks.mjs', act: '', dryArgs: '', reportsOnly: true, why: 'no decision keyed on a field something rewrites' },
  { name: 'fields', file: 'fields.mjs', reportsOnly: true, act: '', dryArgs: '', why: 'no decision reading a field its query never selects' },
  // The checkers checking themselves, against material the WORLD calls good.
  // Six false accusations shipped in one night while the synthetic fixtures
  // agreed with the checkers that wrote them.
  { name: 'fp-check', file: 'fp-check.mjs', reportsOnly: true, act: '', dryArgs: '', why: 'no checker accuses anything known good' },
  // THE RING AGAINST ITS TWIN, EVERY ROUND.
  //
  // L0's whole argument is that a rule transcribed into four languages is four
  // rules that agree until someone edits one. `can_start_another` is in this
  // tree three times today and they agree; nothing anywhere would have noticed
  // when they stopped. Comparing them is cheap - 460 exhaustive cases, a few
  // seconds - and it is the only thing standing between "they agree" and "they
  // agreed when somebody last looked."
  // ONE FILE IN TWO PLACES, EVERY ROUND. Seventeen Swift files exist in both
  // rings/SR-00 and agent-server/queen-core/Sources. Nothing compared them, and
  // on the first run one of the seventeen was already being edited on one side
  // only - identical at HEAD, 45 lines apart on disk. Catching that before it
  // lands is the whole difference between a warning and a fork.
  { name: 'forked-files', file: 'forked-files.mjs', reportsOnly: true, act: '', dryArgs: '', why: 'a file that exists twice must not start saying two things' },
  { name: 't27-parity', file: 't27-parity.mjs', reportsOnly: true, act: '', dryArgs: '', why: 'the generated ring and the twin in production still answer the same' },
  { name: 'verdict-audit', file: 'verdict-audit.mjs', reportsOnly: true, act: '--accepted', dryArgs: '--accepted', why: 'check what the swarm claims against what it pushed' },
  // Queue what no mechanical check can reach for a judge to read. Assembles
  // only - the judgement is an explicit act, never something this performs.
  // The audit says what each verdict is worth. This says whether the swarm's
  // RECENT work is worth less than the baseline this same process established -
  // the one question a per-verdict audit cannot answer, because it is about the
  // distribution and not about any one branch.
  { name: 'proven', file: 'proven.mjs', reportsOnly: true, act: '--record', dryArgs: '', why: 'is the recent work still proving anything' },
  { name: 'judge-packet', file: 'judge-packet.mjs', reportsOnly: true, act: '--unauditable', dryArgs: '--unauditable', why: 'queue the unauditable for judgement' },
]

// One line per step, taken from the step's own output rather than invented, so
// the summary cannot claim more than the step reported.
const SUMMARY = [
  [/(\d+) tree\(s\) rebuilt against one store, about (\d+) MB returned/, (m) => `${m[1]} tree(s) share one store, ${m[2]} MB returned`],
  [/(\d+) worktree\(s\): (\d+) with a private install/, (m) => `${m[2]} of ${m[1]} worktrees still carry a private install`],
  [/removed (\d+) of (\d+) redundant worktree\(s\), (\d+) refused/, (m) => `${m[1]} redundant worktree(s) removed, ${m[3]} still hold work`],
  [/(\d+) worktree\(s\): (\d+) redundant, (\d+) kept/, (m) => `${m[2]} of ${m[1]} worktrees are redundant`],
  [/(\d+) uncommitted path\(s\) across (\d+) tree\(s\), (\d+) tree\(s\) committed/, (m) => `rescued ${m[1]} stranded path(s) from ${m[3]} tree(s)`],
  [/STRANDED total=0/, () => 'nothing stranded in any worktree'],
  [/THEY DISAGREE/, () => 'the two views of the service DISAGREE - a green health check is not evidence the channel will connect'],
  [/http ok   ssh attached   they agree/, () => 'both views agree the service is up'],
  [/ACT NOW: the recent window proves LESS/, () => 'the recent window proves measurably less than the baseline - read the newest verdicts'],
  [/WATCH: the recent rate is lower/, () => 'recent rate lower but inside the noise - watch, do not act'],
  [/overall (\d+)\/(\d+) judged verdicts prove something/, (m) => `${m[1]} of ${m[2]} judged verdicts prove something`],
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
// TWO BUDGETS, BECAUSE THEY ARE TWO JOBS.
//
// One deadline for the whole chain meant the audits paid for the freeing steps.
// Measured 2026-09-05: reap, push-work, land, close-done and author consumed the
// full eight minutes, and verdict-audit, proven and judge-packet were all
// SKIPPED - not because they are slow (a warm audit is ten seconds) but because
// nothing was left. The chain reported itself complete with a third of its
// steps never run, which is the same shape as every defect in this directory: a
// confident answer about work that did not happen.
//
// So the steps that FREE the swarm have the first budget, and the steps that
// only REPORT have their own, starting when the first phase ends. A slow reap
// can no longer silence the audit that would have found what the reap was for.
const DEADLINE_MS = Number(process.env.HEAL_DEADLINE_MS ?? 8 * 60 * 1000)
const REPORT_DEADLINE_MS = Number(process.env.HEAL_REPORT_DEADLINE_MS ?? 5 * 60 * 1000)
let reportPhaseStartedAt = null
const startedAt = Date.now()

const results = []
for (const s of STEPS) {
  if (s.reportsOnly && reportPhaseStartedAt === null) {
    reportPhaseStartedAt = Date.now()
    // THE AUDITS DO NOT NEED THE LOCK, AND HOLDING IT STARVES THE REFILL.
    //
    // Everything above this line changes the swarm's shared state and must not
    // run twice at once. Everything below only reads it. But the lock covered
    // both, so a full run held it for up to thirteen minutes - eight for the
    // freeing phase, five for the audits - and `feed`, which fires every 300
    // seconds and exists precisely to refill the queue, stood down every single
    // time.
    //
    // Measured 2026-09-05: the swarm sat at zero bees for eleven minutes while
    // the chain was in `fp-check`, an entirely read-only step.
    //
    // So the lock is released at the phase boundary. The reporting steps write
    // only their own caches and records - a verdict cache, a paired sample, a
    // dashboard reading - where a second writer costs nothing, and none of them
    // touches a branch, an issue or a worktree.
    if (heldLock) {
      releaseLock()
      heldLock = false
      console.log('\n  lock released: everything from here only reads, and the refill needs it')
    }
  }
  const budget = s.reportsOnly ? REPORT_DEADLINE_MS : DEADLINE_MS
  const since = s.reportsOnly ? reportPhaseStartedAt : startedAt
  const left = budget - (Date.now() - since)
  if (left <= 0) {
    const which = s.reportsOnly ? 'reporting' : 'swarm-freeing'
    process.stdout.write(`\n--- ${s.name}  (${s.why})\n    SKIPPED - past the ${Math.round(budget / 60000)} minute ${which} deadline\n`)
    results.push({ step: s.name, status: 'skipped', summary: `past the ${which} deadline` })
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
    // EXIT 2 FROM coverage IS A FINDING, NOT A BREAKAGE.
    //
    // The tool exits 2 when the recent window proves measurably less than the
    // baseline. That is the tool working, and calling it FAILED would bury the
    // one thing it exists to say under a word this chain uses for "the step is
    // broken". It gets its own status so both can be read.
    // A STEP THAT COULD NOT REACH THE CONTAINER HAS NOT FAILED. The container
    // was unreachable, once, for the whole run - and recording that as four
    // separate step failures is what inflated every rate this loop has quoted.
    // A STEP KILLED BY THIS CHAIN'S OWN TIMEOUT WAS BEING RECORDED AS `ok`.
    //
    // `feed.mjs` has had this arm since the day a step was cut off mid-run; this
    // file never got one. `git log -S ETIMEDOUT -- heal.mjs` is empty. So a step
    // that the chain itself SIGTERMed at its `timeout:` produced no output,
    // matched none of the patterns below, and fell through to `ok`.
    //
    // MEASURED on this machine: heal.timer.log holds 62 `(no output)` lines -
    // land 25, fp-check 22, author 5, reap-local 4, lease 2, judge-packet 2,
    // verdict-audit 1, close-done 1 - and every one was recorded ok. That is 25
    // of land's 36 ok records describing a step that produced not one byte.
    // `feed.timer.log` holds zero, because feed classifies the kill.
    //
    // A step cut off part-way is not a step that succeeded and not a step that
    // broke. What it did before the cut still stands, and saying so is the
    // difference between a chain that reports work and one that reports minutes.
    status = (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') ? 'timed out'
      : /THEY DISAGREE/.test(out) ? 'FINDING'
        : /the channel was already found down in this run/.test(out) ? 'channel-down'
          : /ACT NOW:/.test(out) ? 'FINDING'
            : /Error:|Traceback|not a function|ENOENT/.test(out) ? 'FAILED' : 'ok'
  }
  let line = null
  for (const [re, fmt] of SUMMARY) {
    const m = out.match(re)
    if (m) { line = fmt(m); break }
  }
  console.log(`    ${status === 'FAILED' ? 'FAILED'
    : status === 'timed out' ? `timed out - what it did before the cut still stands: ${line || '(nothing recorded)'}`
      : line || out.trim().split('\n').pop() || '(no output)'}`)
  if (status === 'FAILED') console.log(out.trim().split('\n').slice(-4).map((l) => '      ' + l).join('\n'))
  // THE EVIDENCE IS KEPT, NOT ONLY PRINTED.
  //
  // `line` is set only when a SUMMARY pattern matches, and no pattern matches a
  // failure - so the ledger recorded `line: null` for every failed step and the
  // reason went to a terminal nobody was watching.
  //
  // Measured 2026-09-05 over the whole ledger: push-work, the ONE step that gets
  // a bee's work out of the container, ran 66 times and 47 were not ok. Every
  // one of the 46 FAILED entries carries an empty summary, so what went wrong on
  // any of them cannot now be known. The console had it. The record did not.
  results.push({
    step: s.name,
    status,
    line: line || null,
    evidence: (status === 'FAILED' || status === 'FINDING' || status === 'channel-down' || status === 'timed out')
      ? out.trim().split('\n').slice(-6).join(' | ').slice(0, 400)
      : undefined,
  })
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
// A FINDING is shown, loudly, and does not count as a broken step. The chain's
// exit code is about whether the chain ran; the finding is about what it saw.
const findings = results.filter((r) => r.status === 'FINDING')
if (findings.length) {
  console.log('')
  // `summary` is only set on SKIPPED records; a FINDING carries `line`. This
  // printed `undefined` for every finding it has ever announced - the one word
  // the operator was meant to read.
  for (const f of findings) console.log(`  FINDING  ${f.step}: ${f.line || f.evidence || '(no detail recorded)'}`)
}
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
