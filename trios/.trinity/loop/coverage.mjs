#!/usr/bin/env node
// Which of the loop's own tools have never actually DONE anything.
//
// THE DEFECT THIS EXISTS FOR. `reap` carried a remote script that had never
// been executed for two iterations, because only its report path had ever run.
// It looked healthy every time it was invoked and would have failed the first
// time it mattered - which is the moment the volume is full and nothing else
// works. An untested branch is not a working branch, and a branch that has
// never run is untested however carefully it was written.
//
// The report path and the ACT path are different code. A tool that has only
// ever reported is a tool whose real work is unproven.
//
// HOW IT KNOWS. Every tool appends a line to the ledger when it acts, with its
// own kind. This reads the ledger backwards and answers, per tool: when did its
// act path last run, and has it ever. Nothing is inferred from the source.
//
// Usage:
//   node coverage.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const LEDGER = path.join(DIR, 'ledger.jsonl')
const isMain = process.argv[1] && process.argv[1].endsWith('/coverage.mjs')

// tool -> the ledger kinds that mean "this tool did its real work".
// A tool with no act kind is report-only by design and is marked so, rather
// than silently counted as covered.
const ACTS = {
  // NOT report-only by design - reap HAS an act path and it has never run,
  // because the volume has stayed below the high-water mark since the reaper
  // was written. This is the honest state: the branch that matters most is the
  // one that has never been exercised in production.
  'reap.mjs': { kinds: ['reaped'], note: 'act path never exercised in production - the volume has stayed below the threshold' },
  'lease.mjs': { kinds: ['lease-released'] },
  'push-work.mjs': { kinds: ['push-work-result'] },
  'close-done.mjs': { kinds: ['close-done-result'] },
  'author.mjs': { kinds: ['authored'] },
  'verdict-audit.mjs': { kinds: [], note: 'reads only, by design - it reports and never acts' },
  'judge-packet.mjs': { kinds: [], note: 'assembles only, by design - the model judges' },
  'needs-you.mjs': { kinds: ['needs-you'] },
  'heal.mjs': { kinds: ['heal'] },
  'snapshot.mjs': { kinds: ['snapshot'] },
  // Library and harness, not actors on the swarm. Declared explicitly rather
  // than left as UNTRACKED noise, so a genuinely undeclared tool still stands
  // out the moment one is added.
  // The guards, all read-only by design. Declared here rather than left as
  // UNTRACKED noise - and they were left as noise for four iterations, because
  // each was written after this map and nothing made me come back. The
  // false-positive corpus is what finally asked.
  // Three tools that ACT on the swarm's own bookkeeping, added 2026-09-04.
  // Declared the same round they were written - the four before them were left
  // UNTRACKED for four iterations because each was written after this map and
  // nothing made me come back. The false-positive corpus is what asks now, and
  // it asked within the hour.
  'stale-escalations.mjs': { kinds: ['stale-escalations'], note: 'releases an escalation whose stated cause no longer reproduces' },
  'unpark.mjs': { kinds: ['unpark'], note: 'releases a retry ceiling reached without any criterion being judged' },
  'disjoint.mjs': { kinds: [], note: 'a selector: it decides which candidates can run side by side and files nothing itself' },
  'queue.mjs': { kinds: [], note: 'a measure: queue depth and where the time goes; it changes nothing' },
  'reap-local.mjs': { kinds: ['reap-local'], note: 'frees the disk the loop itself runs on; never uses --force' },
  'why.mjs': { kinds: [], note: 'a diagnosis: it names the cause, the evidence and the command, and changes nothing' },
  'ab.mjs': { kinds: [], note: 'a comparison: it says whether a difference is bigger than noise, and refuses to say more' },
  'feed.mjs': { kinds: ['feed'], note: 'the three steps that decide whether a worker has anything to start' },
  'land.mjs': { kinds: ['land'], note: 'puts accepted work into the branch it was accepted for' },
  'clocks.mjs': { kinds: [], note: 'a guard: it reports which fields decisions are keyed on and changes nothing' },
  'fields.mjs': { kinds: [], note: 'a guard: it compares reads against selects and changes nothing' },
  'fp-check.mjs': { kinds: [], note: 'a guard: it runs the other checkers against known-good input' },
  'trend.mjs': { kinds: [], note: 'reads the ledger and reports slopes; it writes nothing' },
  'loop.mjs': { kinds: [], note: 'the library the others import - it has no act path of its own' },
  'brief-gate.mjs': { kinds: [], note: 'a gate: it refuses or permits, and changes nothing' },
  'coverage.mjs': { kinds: [], note: 'this file' },
  'share-modules.mjs': { kinds: ['share-modules'], note: 'rebuilds each worktree node_modules as a farm of links into one store; never touches a running tree' },
  'reap-finished.mjs': { kinds: ['reap-finished'], note: 'removes a worktree when its dispatch has finished and its branch is on the remote - lifetime, not pressure' },
  'rescue.mjs': { kinds: ['rescue'], note: 'commits work a bee left uncommitted onto its own branch, so reclaiming a worktree cannot destroy it' },
  'two-views.mjs': { kinds: [], note: 'samples the HTTP and ssh views of the service together and records the pair; it concludes nothing' },
  'dash.mjs': { kinds: [], note: 'measures the dashboard numbers instead of accepting them typed; records a reading and changes nothing else' },
  'channel.mjs': { kinds: [], note: 'the one way into the container - a library the remote steps import; it has no act path of its own' },
  'failures.mjs': { kinds: [], note: 'reads the ledger backwards and reports which steps have been failing; it changes nothing' },
  'salvage.mjs': { kinds: [], note: 'a reader: it measures what a stale branch would still add and writes a brief; it applies nothing and never rebases' },
  'proven.mjs': { kinds: [], note: 'a comparison: recent verdicts against the baseline this process established; it records a reading and changes nothing' },
  'selftest.mjs': { kinds: [], note: 'the calibration harness - proven by running, not by acting' },
}

export function coverage() {
  const rows = fs.existsSync(LEDGER)
    ? fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    : []

  const out = []
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.mjs')).sort()) {
    const spec = ACTS[file]
    if (!spec) { out.push({ file, state: 'UNTRACKED', note: 'no act kind declared - add one, or say why it never acts' }); continue }
    if (!spec.kinds.length) { out.push({ file, state: 'report-only', note: spec.note || '' }); continue }
    const hits = rows.filter((r) => spec.kinds.includes(r.kind))
    if (!hits.length) { out.push({ file, state: 'NEVER ACTED', note: `no ${spec.kinds.join(' or ')} line in the ledger` }); continue }
    const last = hits[hits.length - 1]
    out.push({ file, state: 'acted', count: hits.length, at: last.at })
  }
  return out
}

if (isMain) {
  const rows = coverage()
  const bad = rows.filter((r) => r.state === 'NEVER ACTED' || r.state === 'UNTRACKED')

  console.log('loop tool coverage - has each tool ever done its real work?\n')
  for (const r of rows) {
    const mark = { acted: 'ok  ', 'report-only': '..  ', 'NEVER ACTED': '!!  ', UNTRACKED: '??  ' }[r.state]
    const when = r.at ? `${String(r.at).slice(5, 16)}  x${r.count}` : ''
    console.log(`  ${mark}${r.file.padEnd(20)} ${r.state.padEnd(12)} ${when}${r.note ? '  ' + r.note : ''}`)
  }
  console.log(`\n${rows.filter((r) => r.state === 'acted').length} proven, ${rows.filter((r) => r.state === 'report-only').length} report-only by design, ${bad.length} unproven`)
  if (bad.length) {
    console.log('\nAn unproven act path is the reap defect waiting to repeat: it looks healthy every')
    console.log('time it is invoked and fails the first time it matters.')
  }
  process.exit(bad.length ? 1 : 0)
}
