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
const REPO = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'
const STATUS = process.env.QUEEN_STATUS_URL || 'https://trios-agent-server-production.up.railway.app/queen/status'
const WORKERS = Number(process.env.QUEEN_WORKERS ?? 4)
const PROJECT = process.env.QUEEN_PROJECT || '564d9ebd-7aa8-44fe-93ec-e0b03c87158d'
const SERVICE = process.env.QUEEN_SERVICE || 'trios-agent-server'
const isMain = process.argv[1] && process.argv[1].endsWith('/why.mjs')

const L = await import(path.join(DIR, 'loop.mjs'))
const Q = await import(path.join(DIR, 'queue.mjs'))
const RL = await import(path.join(DIR, 'reap-local.mjs'))
const SE = await import(path.join(DIR, 'stale-escalations.mjs'))

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
      test: () => {
        if (running < WORKERS) return null
        // FULL LOAD IS NOT AN ALL-CLEAR, and saying it is was how a day of
        // cosmetic work passed unremarked. 4 of 4 running, 100% accepted, and
        // all forty of the last authored issues were the same character
        // replacement. So this reports the MIX before it reports health.
        const m = Q.mix(Number(process.env.MIX_LIMIT ?? 30))
        const top = m?.counts?.[0]
        const share = top && m.total ? top[1] / m.total : 0
        if (share > 0.8) {
          return {
            cause: `${running} of ${WORKERS} workers are busy, and ${Math.round(share * 100)}% of the backlog is one kind: "${top[0]}"`,
            evidence: (m.counts || []).map(([k, n]) => `${k}=${n}`).join('  '),
            remedy: 'tri mix   - a swarm at full load doing one cheap thing is still a swarm doing one cheap thing',
          }
        }
        // A LEADING INDICATOR BELONGS IN THE ALL-CLEAR, not after it. The
        // landing pipeline being stuck does not make a busy swarm idle today;
        // it makes it idle in an hour, once every accepted issue is holding a
        // boundary that nothing will release. Say so while there is still time.
        const landOut = sh(`node ${path.join(DIR, 'land.mjs')}`, { timeout: 240000 }) || ''
        const stuck = landOut.match(/ALL (\d+) remaining branch\(es\) conflict/)
        return {
          cause: `nothing is wrong RIGHT NOW - ${running} of ${WORKERS} workers are busy`,
          evidence: `last tick ${tick.decidedAt ?? '?'}` +
            (top ? `, backlog led by ${top[0]} at ${Math.round(share * 100)}%` : '') +
            (stuck ? `. AHEAD: all ${stuck[1]} remaining accepted branches conflict, so nothing can land and close-done will close nothing` : ''),
          remedy: stuck
            ? 'tri land   - the pipeline is stuck behind conflicts and will starve the swarm once these boundaries are all that is left'
            : 'tri verdicts - load is not health; tri mix - health is not value',
        }
      },
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
      name: 'the CONTAINER volume has room',
      test: () => {
        // CAUSE FOURTEEN, and it is circular.
        //
        // Measured 2026-09-05: /workspace 100% used, 71 MB free of 46 GB, 60
        // worktrees. Every bee died at `git worktree add` with "unable to write
        // file docs/images/...", and #1493 - the issue I had just handed to the
        // swarm - never ran a line.
        //
        // The reaper exists for exactly this and it had NOT run, because it
        // reaches the volume through `railway ssh`, and railway refused with
        // "Your application is not running or in a unexpected state" - the
        // application being unhealthy BECAUSE the disk was full. The tool that
        // repairs the failure depends on the thing the failure breaks.
        //
        // And this diagnostic checked the LAPTOP's disk, not the container's.
        // The laptop was at 69% and reported healthy while the fleet was down.
        const out = sh(
          `${JSON.stringify(process.env.SHELL || '/bin/sh')} -c ` +
          JSON.stringify(`cd ${ROOT}/trios && railway ssh --project ${PROJECT} --environment production --service ${SERVICE} -- sh -c 'df -P /workspace | tail -1' 2>&1`),
          { timeout: 120000 },
        )
        if (!out) return null
        if (/not running or in a unexpected state/i.test(out)) {
          return {
            cause: 'the container will not accept a connection - "not running or in a unexpected state", which is what a FULL VOLUME looks like from outside',
            evidence: out.split('\n').slice(-2).join(' ').slice(0, 180),
            remedy: 'tri reap --reap   - retry it; the reaper reaches the volume through the same channel, so it may need several attempts as the app recovers',
          }
        }
        const m = out.match(/(\d+)%/)
        if (!m) return null
        const used = Number(m[1])
        if (used < 90) return null
        return {
          cause: `the container volume is ${used}% full - every bee dies at "git worktree add: unable to write file"`,
          evidence: out.trim().slice(0, 160),
          remedy: 'tri reap --reap',
        }
      },
    },
    {
      name: 'the LAPTOP disk has room',
      test: () => {
        // The path the worktrees live on, not `/`. On macOS the root is a
        // sealed system snapshot that reads 55% while the data volume - where
        // every checkout actually is - was at 97%.
        const used = RL.diskUsedPercent(ROOT)
        if (used === null || used < 92) return null
        return {
          cause: `the disk this loop runs on is ${used}% full - a worktree checkout fails part-way and the dispatch dies at 0 s`,
          evidence: sh(`df -h ${JSON.stringify(ROOT)} | tail -1`) || '',
          remedy: 'tri reap-local --reap',
        }
      },
    },
    {
      name: 'recent dispatches actually started',
      test: () => {
        // THE ROW SAYS WHY, AND NOTHING WAS READING IT.
        //
        // A dispatch that dies at 0 s records its reason in `outcome`, and the
        // tick simply chooses the same issue again next round. Measured
        // 2026-09-04: `chosen=1470` in two consecutive rounds, one worker of
        // four, and the row read "git fetch failed: ... Permission denied" -
        // 112 reflog files left owned by root by my own push tool, which the
        // worker user could not append to. Every new bee died instantly and no
        // count in the skip summary said so.
        const js = "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});" +
          "p.query(\"select issue, outcome from queen_dispatch where dispatched_at > now() - interval '30 minutes' " +
          "and finished_at is not null and extract(epoch from (finished_at - dispatched_at)) < 5 " +
          "and coalesce(outcome,'') <> '' order by dispatched_at desc limit 5\")" +
          ".then(r=>{console.log(JSON.stringify(r.rows)); return p.end()}).catch(e=>{console.log('ERR '+e.message); process.exit(1)})"
        let rows
        try {
          const out = SE.remote(js)
          const line = String(out ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('['))
          rows = line ? JSON.parse(line) : null
        } catch { rows = null }
        if (!Array.isArray(rows) || rows.length < 2) return null
        return {
          cause: `${rows.length} dispatch(es) in the last half hour died within 5 seconds of starting - the workers cannot begin at all`,
          evidence: `#${rows[0].issue}: ${String(rows[0].outcome).slice(0, 160)}`,
          remedy: 'read the outcome above; it is the actual error. A Permission denied under .git means a root-owned reflog - tri push-work --push now repairs that',
        }
      },
    },
    {
      name: 'the landing pipeline is moving',
      test: () => {
        // CAUSE THIRTEEN, added the round after I created it.
        //
        // close-done was changed to close only work that has LANDED - the repair
        // for 169 issues closed while their code sat outside the base. That
        // makes `land` load-bearing: if landing stops, nothing closes, every
        // accepted issue keeps holding its boundary, and the swarm starves
        // behind a wall of its own finished work. The failure is silent, because
        // refusing to close is the CORRECT behaviour of a healthy close-done.
        //
        // Read-only: it asks land for a survey and never lands anything itself.
        let rows
        try { rows = null } catch { rows = null }
        const out = sh(`node ${path.join(DIR, 'land.mjs')}`, { timeout: 240000 })
        if (!out) return null
        const m = out.match(/ALL (\d+) remaining branch\(es\) conflict/)
        if (m) {
          return {
            cause: `the landing pipeline is stuck: all ${m[1]} accepted branch(es) left conflict, so nothing can land and close-done will close nothing`,
            evidence: (out.match(/^ {2}CONFL[^\n]*$/m) || ['see tri land'])[0].trim().slice(0, 150),
            remedy: 'tri land   - these need a rebase or an honest closure as superseded; a conflict is for a person',
          }
        }
        const l = out.match(/(\d+) landable, showing the next (\d+)/)
        if (l && Number(l[1]) > 30) {
          return {
            cause: `${l[1]} accepted branches are still outside the base, and close-done cannot close any of them until they land`,
            evidence: `land reports ${l[1]} landable`,
            remedy: 'tri land --land   - it lands a bounded batch per run',
          }
        }
        return null
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
        // A KNOWN, PERMANENT, CORRECT SKIP IS NOT A CAUSE.
        //
        // #380 and #957 each say in their own body that no worker can start
        // them - #380 calls itself "a record of a plan whose deadline passed",
        // #957 has a section headed "Why this cannot be a bee's task". The
        // scheduler is right to skip them and will be right to skip them for
        // ever. Reporting that as the reason the swarm is idle is the same
        // mistake fp-check made counting NEVER ACTED as a false accusation: a
        // true statement, filed under the wrong heading, teaching the reader to
        // ignore the tool.
        //
        // The label makes the fact machine-readable. Prose cannot be relied on;
        // a label can.
        const declared = Number(sh(
          `gh issue list --repo ${REPO} --state open --label not-a-task --limit 100 --json number -q 'length'`,
        ) ?? 0)
        const real = bad - declared
        if (real < 3) return null
        return {
          cause: `${real} open issues are not delegatable - no Boundary section, or no criteria to judge them by`,
          evidence: `missingBoundary ${skips.missingBoundary ?? 0}, incompleteSpec ${skips.incompleteSpec ?? 0}` +
            (declared ? `, of which ${declared} carry not-a-task and are correctly skipped for ever` : ''),
          remedy: 'give them a ## Boundary and a ## Success Criteria, or label them not-a-task, or close them',
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
    // A CHECK THAT FIRED IS NOT `ok`.
    //
    // Under --all this printed "ok  the landing pipeline is moving (also true)"
    // for a check that had just detected a stalled pipeline. The word ok is the
    // first thing an eye lands on, and putting it in front of a finding is how
    // a diagnostic gets skimmed past. A later cause is still a cause; it just is
    // not the FIRST one.
    if (all && hit) {
      console.log(`  ALSO  ${c.name}`)
      console.log(`        ${hit.cause}`)
      console.log(`        do: ${hit.remedy}`)
    } else if (all) {
      console.log(`  ok    ${c.name}`)
    }
  }

  if (!found) {
    console.log('  No known cause fires. The swarm is idle for a reason this tool does not')
    console.log('  yet know about, which is worth adding to it rather than diagnosing again.')
    console.log(`  skipSummary: ${JSON.stringify(tick.skipSummary ?? {})}`)
    process.exit(2)
  }
  process.exit(0)
}
