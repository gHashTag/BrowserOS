#!/usr/bin/env node
// Why is the swarm idle? Asked four times in one night, answered by hand each
// time, and the answer was different every time.
//
//   the chain was failing from its own timer, silently enough to look healthy
//   the refill was the last link, behind five steps that only produce reading
//   accepted work was never closed, so every boundary stayed held
//   the queue was empty because a detector's corpus had run out
//   the disk was 100% full and every dispatch died at 0 s
//   a stuck chain held the lock and every timer fire stood down
//
// None of these is guessable from "RUNNING 0". Each has a different remedy and
// several look identical from outside - a held boundary, an unclosed issue and
// an empty queue all present as "nothing to choose".
//
// So the diagnosis stops being something I do and becomes something the system
// says. This checks the causes in the order that makes them true: an unreachable
// service explains everything after it, a full disk explains an empty queue, and
// a held lock explains why nothing refilled. It stops at the FIRST cause that
// explains what is seen, names the evidence, and gives the command that acts on
// it.
//
// Usage:
//   node why.mjs         # diagnose
//   node why.mjs --all   # every check, including the ones that passed

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const STATUS = process.env.QUEEN_STATUS_URL || 'https://trios-agent-server-production.up.railway.app/queen/status'
const WORKERS = Number(process.env.QUEEN_WORKERS ?? 4)
const isMain = process.argv[1] && process.argv[1].endsWith('/why.mjs')

const L = await import(path.join(DIR, 'loop.mjs'))
const Q = await import(path.join(DIR, 'queue.mjs'))
const RL = await import(path.join(DIR, 'reap-local.mjs'))

const sh = (c, opts = {}) => {
  try {
    return execSync(c, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, ...opts }).trim()
  } catch { return null }
}

/** The live tick, or null. */
export function status() {
  const out = sh(`curl -s --max-time 20 ${STATUS}`)
  if (!out) return null
  try { return JSON.parse(out) } catch { return null }
}

/**
 * The causes, in the order that makes them true.
 *
 * Each returns null when it does not apply, or `{ cause, evidence, remedy }`.
 * The first that fires is the answer; the rest are printed only under `--all`,
 * because a diagnosis that lists six possibilities has not diagnosed anything.
 */
export function checks(s) {
  const tick = s?.lastTick ?? {}
  const skips = tick.skipSummary ?? {}
  const running = Number(s?.dispatches?.running ?? 0)

  return [
    {
      name: 'the service answers',
      test: () => (s ? null : {
        cause: 'the supervisor cannot be reached',
        evidence: `no answer from ${STATUS}`,
        remedy: 'railway logs --service trios-agent-server',
      }),
    },
    {
      name: 'the scheduler is on',
      test: () => (s?.scheduler?.enabled === false ? {
        cause: 'the scheduler is disabled, so no round will ever start',
        evidence: JSON.stringify(s.scheduler),
        remedy: 'turn it back on in the service configuration',
      } : null),
    },
    {
      name: 'the workers are actually idle',
      test: () => (running >= WORKERS ? {
        cause: `nothing is wrong - ${running} of ${WORKERS} workers are busy`,
        evidence: `last tick ${tick.decidedAt ?? '?'}`,
        remedy: 'tri verdicts - load is not health; check what the work is worth',
      } : null),
    },
    {
      name: 'the loop lock is free',
      test: () => {
        const held = L.lockHolder()
        if (!held) return null
        const mins = Math.round(held.ageMs / 60000)
        if (mins < 8) return null
        return {
          cause: `a run has held the loop lock for ${mins} minutes, so nothing has refilled the queue`,
          evidence: `holder ${held.holder}, pid ${held.pid}, since ${held.at}`,
          remedy: 'ps -p ' + held.pid + '  - if it is gone the lock expires on its own at 45 min',
        }
      },
    },
    {
      name: 'the disk has room',
      test: () => {
        const used = RL.diskUsedPercent()
        if (used === null || used < 92) return null
        return {
          cause: `the disk this loop runs on is ${used}% full - a worktree checkout fails part-way and the dispatch dies at 0 s`,
          evidence: sh('df -h / | tail -1') || '',
          remedy: 'tri reap-local --reap',
        }
      },
    },
    {
      name: 'the queue has work nobody has started',
      test: () => {
        const q = Q.depth()
        if (q === null) return {
          cause: 'the queue depth could not be measured, so it is UNKNOWN rather than empty',
          evidence: 'the service did not answer the depth query',
          remedy: 'tri queue',
        }
        if (q.queue > 0) return null
        return {
          cause: 'the queue is empty - every authored issue has already been dispatched',
          evidence: `${q.open} open, ${q.inProgress} already dispatched, ${q.queue} unstarted`,
          remedy: 'tri feed --act   (push -> close -> author, without waiting for the whole chain)',
        }
      },
    },
    {
      name: 'accepted work has been closed',
      test: () => (Number(skips.completed ?? 0) >= 8 ? {
        cause: `${skips.completed} issues whose work was ACCEPTED are still open, and each holds its boundary - so the selector finds no free path and the author files nothing`,
        evidence: `skipSummary.completed = ${skips.completed}`,
        remedy: 'tri push-work --push && tri close-done --close',
      } : null),
    },
    {
      name: 'candidates are not all claimed',
      test: () => {
        const claimed = Number(skips.claimed ?? 0)
        const others = Object.entries(skips).filter(([k]) => k !== 'claimed').reduce((n, [, v]) => n + Number(v), 0)
        if (claimed < 8 || claimed <= others) return null
        return {
          cause: `${claimed} candidates are claimed by dispatches that have not been released`,
          evidence: `skipSummary = ${JSON.stringify(skips)}`,
          remedy: 'tri unpark && tri lease   - some may be at the retry ceiling, which is a decision for a person',
        }
      },
    },
    {
      name: 'boundaries do not collide',
      test: () => (Number(skips.fileConflict ?? 0) >= 3 ? {
        cause: `${skips.fileConflict} candidates want files another worker holds`,
        evidence: `skipSummary.fileConflict = ${skips.fileConflict}`,
        remedy: 'tri holds   - and file work with disjoint boundaries, N tasks only give N workers if their paths differ',
      } : null),
    },
    {
      name: 'the open issues are workable',
      test: () => {
        const bad = Number(skips.missingBoundary ?? 0) + Number(skips.incompleteSpec ?? 0)
        if (bad < 3) return null
        return {
          cause: `${bad} open issues are not delegatable - no Boundary section, or no criteria to judge them by`,
          evidence: `missingBoundary ${skips.missingBoundary ?? 0}, incompleteSpec ${skips.incompleteSpec ?? 0}`,
          remedy: 'give them a ## Boundary and a ## Success Criteria, or close them',
        }
      },
    },
    {
      name: 'the detectors still have fuel',
      test: () => {
        const out = sh(`node ${path.join(DIR, 'author.mjs')}`, { timeout: 240000 })
        const m = out && out.match(/not yet filed: (\d+)/)
        if (!m) return null
        const left = Number(m[1])
        if (left > 3) return null
        return {
          cause: `the author has only ${left} candidate(s) left across every detector - the backlog is about to run dry`,
          evidence: (out.match(/^signals:.*$/m) || [''])[0],
          remedy: 'add a detector, or widen one - a detector with a finite corpus is a detector that stops',
        }
      },
    },
  ]
}

if (isMain) {
  const all = process.argv.includes('--all')
  const s = status()
  const running = Number(s?.dispatches?.running ?? 0)
  const tick = s?.lastTick ?? {}

  console.log(`swarm: ${running} of ${WORKERS} running   last tick ${tick.decidedAt ?? '?'}   refusal ${tick.refusal ?? 'none'}\n`)

  let found = null
  for (const c of checks(s)) {
    const hit = c.test()
    if (hit && !found) {
      found = { ...hit, name: c.name }
      console.log(`  ->  ${hit.cause}`)
      console.log(`      evidence: ${hit.evidence}`)
      console.log(`      do:       ${hit.remedy}`)
      if (!all) break
      console.log('')
      continue
    }
    if (all) console.log(`  ok  ${c.name}${hit ? ' (also true)' : ''}`)
  }

  if (!found) {
    console.log('  No known cause fires. The swarm is idle for a reason this tool does not')
    console.log('  yet know about, which is worth adding to it rather than diagnosing again.')
    console.log(`  skipSummary: ${JSON.stringify(tick.skipSummary ?? {})}`)
    process.exit(2)
  }
  process.exit(0)
}
