#!/usr/bin/env node
// The three steps that decide whether a worker has anything to start.
//
// WHY THIS IS SEPARATE FROM THE CHAIN. `heal.mjs` runs eleven steps and takes
// about 480 seconds of its 600-second cycle. Four workers drain the queue in
// roughly 13 minutes. So the refill arrives once per cycle at best, and the
// swarm spends the gap idle - measured repeatedly on 2026-09-04: queue 0,
// running 0, with the chain mid-way through auditing.
//
// The audits are worth running. They are not worth making the workers wait
// for. So the three steps that FEED the swarm are also runnable alone, on a
// cadence of their own:
//
//   push-work   a branch nobody can see cannot be closed against
//   close-done  an accepted issue left open holds its boundary, so the
//               disjoint selector finds no free path and the author files
//               nothing - the failure looks exactly like an empty backlog
//   author      refill to the queue depth
//
// The order is not arbitrary and is the same one heal.mjs uses: skipping the
// first step disables the last.
//
// IT TAKES THE SAME LOCK. Two writers pushing and closing at once is the thing
// the lock exists to prevent, and a feed running beside a chain would be
// exactly that. A feed that finds the lock held stands down and says so - the
// chain it stood down for does the same work a minute later.
//
// Usage:
//   node feed.mjs           # report what it would do
//   node feed.mjs --act     # push, close, file

import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/feed.mjs')
const L = await import(path.join(DIR, 'loop.mjs'))

export const STEPS = [
  { name: 'push-work', file: 'push-work.mjs', act: '--push', why: 'a branch nobody can see cannot be closed against' },
  // Between the push and the close: close-done now demands LANDED rather than
  // pushed, so without this nothing would ever close again.
  { name: 'land', file: 'land.mjs', act: '--land', why: 'put accepted work into the branch' },
  { name: 'close-done', file: 'close-done.mjs', act: '--close', why: 'an open accepted issue holds its boundary' },
  // THE ONLY THING LEFT STANDING AFTER THREE REFUTATIONS.
  //
  // Every dispatch runs `bun install` and writes ~2.5 GB of node_modules into
  // its worktree, and three attempts to stop that at the source were each
  // measured and each failed: moving the package cache onto the volume (bun
  // copies whatever device it is on), pre-building a link farm before the
  // install (bun wipes it - 159M becomes 2562M), and `--backend=symlink`, which
  // gives 41M on a single-package project and 2561M on this workspace.
  //
  // What works is sharing AFTERWARDS, and the only variable left is how long the
  // duplicates sit there. On the chain alone that is 10 to 25 minutes and the
  // volume climbed at 133 points per hour; on this timer it is five, which
  // bounds the accumulation to roughly what two bees produce.
  //
  // It is a mop, not a tap, and it is named as one.
  { name: 'share-modules', file: 'share-modules.mjs', act: '--share', why: 'bound how long duplicate installs sit on the volume' },
  { name: 'author', file: 'author.mjs', act: '--file', why: 'refill to the queue depth' },
]

/** One line per step, read from the step's own output rather than invented. */
export const SUMMARY = [
  [/(\d+) tree\(s\) rebuilt against one store, about (\d+) MB returned/, (m) => `${m[1]} tree(s) share one store, ${m[2]} MB returned`],
  [/could not read which bees are running/, () => 'stood down: the board could not be read, and rebuilding under a live install kills a dispatch'],
  [/pushed (\d+)/, (m) => `pushed ${m[1]}`],
  [/not pushed: 0/, () => 'every branch with work is already on the remote'],
  [/landed (\d+) of (\d+) clean/, (m) => `${m[1]} accepted branch(es) landed`],
  [/(\d+) landable, showing/, (m) => `${m[1]} accepted branches still outside the base`],
  [/closed (\d+)\s+failed (\d+)/, (m) => `closed ${m[1]}, failed ${m[2]}`],
  [/closable 0/, () => 'nothing closable'],
  [/filed (\d+)/, (m) => `filed ${m[1]}`],
  [/STALLED: /, () => 'REFUSED to file - nobody is draining the backlog'],
  [/at the WIP limit|already has an issue|would file 0/, () => 'queue already at depth, nothing filed'],
]

export function summarise(out) {
  for (const [re, f] of SUMMARY) {
    const m = out.match(re)
    if (m) return f(m)
  }
  const line = out.split('\n').filter((l) => l.trim()).pop()
  return (line || '').slice(0, 90)
}

if (isMain) {
  const ACT = process.argv.includes('--act')
    // EIGHT MINUTES, not four, and the per-step cap is 300 s rather than 180.
  //
  // The first version capped a step at 180 s. `close-done` and `author` both
  // take longer than that when there is real work - so they were KILLED
  // mid-way, after closing some issues and filing one, and reported FAILED.
  // That breaks the rule the chain already carries: a half-run step is worse
  // than an unrun one. Being slower is not the failure; being cut off is.
  const DEADLINE_MS = Number(process.env.FEED_DEADLINE_MS ?? 8 * 60 * 1000)

  if (ACT) {
    const state = L.lockHolder()
    const mine = process.env.LOOP_HOLDER && state && state.holder === process.env.LOOP_HOLDER
    if (!mine) {
      const got = L.acquire('feed', { singleProcess: true })
      if (!got.ok) {
        // Not an error. The chain holds it and does this same work.
        console.log(`the loop lock is held by ${got.held.holder} (${Math.round(got.ageMs / 60000)} min) - standing down; it feeds too`)
        L.append({ kind: 'feed-skipped', note: `lock held by ${got.held.holder}` })
        process.exit(0)
      }
      const release = () => { try { L.release() } catch { /* already gone */ } }
      process.on('exit', release)
      process.on('SIGINT', () => { release(); process.exit(130) })
      process.on('SIGTERM', () => { release(); process.exit(143) })
    }
  }

  const startedAt = Date.now()
  const results = []
  for (const s of STEPS) {
    const left = DEADLINE_MS - (Date.now() - startedAt)
    if (left <= 0) {
      console.log(`\n--- ${s.name}  (${s.why})\n    SKIPPED - past the ${Math.round(DEADLINE_MS / 60000)} minute deadline`)
      results.push({ step: s.name, status: 'skipped' })
      continue
    }
    process.stdout.write(`\n--- ${s.name}  (${s.why})\n`)
    let out = ''
    let status = 'ok'
    try {
      // THE STEP'S BUDGET IS TOLD TO THE CHANNEL, not just enforced on it.
      //
      // A step killed at its timeout reports "timed out part-way" and loses
      // whatever it was about to say. The channel's app-down backoff sleeps 180
      // seconds across three attempts; on a 300-second cycle that is most of the
      // budget spent waiting. Given the number, the channel stops before the
      // wait that would overrun and the step finishes with an answer.
      const budget = Math.max(30000, Math.min(300000, left))
      out = execSync(`node ${path.join(DIR, s.file)} ${ACT ? s.act : ''}`, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: budget,
        env: { ...process.env, CHANNEL_DEADLINE_MS: String(Math.round(budget * 0.8)) },
      })
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '')
      // A step KILLED by the timeout is not a step that failed, and calling it
      // one sent me hunting a bug in close-done that did not exist. Say what
      // actually happened: it ran out of time, part-way, and what it did before
      // that still counts.
      if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        status = 'timed out'
      } else {
        // A non-zero exit is not automatically a failure - author exits 3 when
        // it refuses to file into a backlog nobody is draining, which is it
        // working.
        status = /STALLED|would file 0|at the WIP limit/.test(out) ? 'ok' : 'FAILED'
      }
    }
    const line = status === 'ok'
      ? summarise(out)
      : status === 'timed out'
        ? `timed out part-way - what it did before that stands: ${summarise(out)}`
        : `FAILED\n${out.split('\n').slice(-4).join('\n')}`
    console.log(`    ${line}`)
    results.push({
      step: s.name,
      status,
      summary: line.slice(0, 120),
      // Same reason as in heal.mjs: a failure whose evidence is only printed is
      // a failure nobody can diagnose an hour later.
      evidence: status === 'FAILED' ? out.trim().split('\n').slice(-6).join(' | ').slice(0, 400) : undefined,
    })
  }

  const bad = results.filter((r) => r.status === 'FAILED')
  console.log(`\nfeed ${ACT ? 'complete' : '(report only)'}: ${results.map((r) => `${r.step}=${r.status}`).join(' ')}`)
  if (ACT) L.append({ kind: 'feed', results, elapsedMs: Date.now() - startedAt })
  process.exit(bad.length ? 1 : 0)
}
