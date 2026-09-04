#!/usr/bin/env node
// A claim lease with an idle timer, run from outside the supervisor.
//
// THE DEFECT. `QueenDelegationPolicy.claimOnIssue` counts `rejected` as a LIVE
// claim, and its own comment says why: "the same bee is expected to return to
// those files". No bee ever returns - the tick's header states plainly that
// nothing reopens a worker on a send-back. So every sendBack, escalate and wait
// becomes a permanent claim, its `owned_paths` become a permanent fence, and on
// 2026-09-04 that blocked 23 of 31 delegatable candidates.
//
// WHY THIS RUNS OUTSIDE THE SUPERVISOR. The proper fix is a lease inside the
// tick. That is a code change to a production supervisor and a deploy; doing it
// unattended overnight is the riskiest available action. This reproduces the
// same semantics from the loop, changing only data the tick already treats as
// mutable, so it can be undone from the ledger.
//
// THE SEMANTICS ARE A MESSAGE QUEUE'S, not an invention. Redis XAUTOCLAIM is
// the reference: a claim carries an idle time, the holder renews it, a reaper
// releases claims idle beyond a threshold, and a delivery counter sends an item
// that keeps failing to quarantine instead of round-tripping forever. The field
// survey found no agent orchestrator implementing this, which is why it has to
// be built rather than configured.
//
// THE CEILING IS THE PROJECT'S OWN. `QueenRetryPolicy.maximumRealAttempts = 2`
// already exists in Swift, in both copies. Inventing a second number here would
// be a second statement of one rule - the thing this repository's L0 exists to
// prevent - so the ceiling is read from there and stated in the output.
//
// Usage:
//   node lease.mjs                  # report: what would be released and why
//   node lease.mjs --release        # act, recording prior values in the ledger

import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const L = await import(path.join(DIR, 'loop.mjs'))
const { shq } = L

// IMPORT-SAFE. This module ran its production query and called process.exit at
// import time, so importing it hit the live database and killed the importer -
// the calibration harness could not test it and died mid-run trying. A module
// that does work merely by being imported cannot be tested, and cannot be
// reused. Everything below the guard runs only when this file IS the program.
const isMain = process.argv[1] && process.argv[1].endsWith('/lease.mjs')


const CEILING = Number(process.env.LEASE_CEILING ?? 2)      // QueenRetryPolicy.maximumRealAttempts
const MIN_IDLE_H = Number(process.env.LEASE_MIN_IDLE_H ?? 1) // do not disturb a fresh verdict
const SVC = 'trios-agent-server'

function remote(js) {
  // The payload is quoted twice - once for `bun -e`, once for `sh -c` - so a
  // newline survives as a literal backslash-n and bun rejects it as an invalid
  // escape sequence. Collapse to one line before either quoting happens. This
  // is also why the payloads below carry no `//` comments: on one line, a line
  // comment would swallow the rest of the program.
  const oneLine = js.replace(/\s*\n\s*/g, ' ').trim()
  const script = `cd /app/apps/server && bun -e ${shq(oneLine)}`
  const out = execSync(`railway ssh --service ${SVC} -- sh -c ${shq(script)}`, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 280000,
  })
  return out.split('\n').filter((l) => !/Using SSH|railway\.json|Migrate|Existing/.test(l)).join('\n').trim()
}

// NOTE ON `$1`. A placeholder cannot be used here. The payload travels inside a
// double-quoted `sh -c "..."`, and the shell expands `$1` to its own first
// positional parameter - empty - so `any($1)` reaches Postgres as `any()` and
// fails with "syntax error at or near )". The values are therefore inlined as
// literals, which is safe because they are constants written here, not input.
// THE CLOCK MUST BE ONE NOTHING TOUCHES.
// reviewFinishedDispatches re-reads every `wait` row each round and UPDATEs it
// in place, so `reviewed_at` on a wait row is never more than one tick old.
// Measured 2026-09-04: wait rows showed reviewed_at 0.03 h old against finishes
// 4.7 h old, while accept, escalate and sendBack rows carried honest values.
// A valve keyed on reviewed_at could therefore never fire for wait - it did not,
// for six hours, and cost a whole swarm outage (BrowserOS#109).
// finished_at is written once and never again. Used for every state, not only
// the broken one, because a measure whose correctness depends on which rows
// happen to be swept is a measure waiting to break.
const QUERY = `
const {Pool} = require('pg');
const p = new Pool({connectionString: process.env.DATABASE_URL});
p.query(
  "select d.issue, d.review_state, d.send_backs, d.owned_paths, " +
  " extract(epoch from (now() - d.finished_at))/3600 as idle_h, " +
  " i.state as istate " +
  "from queen_dispatch d left join queen_issues i on i.number = d.issue " +
  "where d.finished_at is not null " +
  "  and (d.review_state is null or d.review_state in ('wait','sendBack','escalate')) " +
  "  and jsonb_array_length(d.owned_paths) > 0"
).then(r => { console.log(JSON.stringify(r.rows)); process.exit(0); })
 .catch(e => { console.log('ERR ' + e.message); process.exit(1); });
`

/** What should happen to one parked claim, and the reason, in words. */
export function classify(row) {
  const idle = Number(row.idle_h || 0)
  const sends = Number(row.send_backs || 0)
  if (row.istate !== 'open') {
    return { action: 'release', why: 'the issue is closed - a closed issue is never a candidate, so this claim fences for nothing' }
  }
  if (sends >= CEILING) {
    return { action: 'quarantine', why: `${sends} attempts, at or over the ceiling of ${CEILING} - a person decides, not a timer` }
  }
  if (idle < MIN_IDLE_H) {
    return { action: 'hold', why: `idle ${idle.toFixed(1)} h, under the ${MIN_IDLE_H} h floor - the verdict is still fresh` }
  }
  return { action: 'release', why: `idle ${idle.toFixed(1)} h with ${sends} of ${CEILING} attempts used - eligible for another pass` }
}

if (!isMain) { /* imported for calibration or reuse: do nothing */ } else {
const raw = remote(QUERY)
if (raw.startsWith('ERR')) { console.error(raw); process.exit(1) }
const rows = JSON.parse(raw.slice(raw.indexOf('[')))

console.log(`ceiling ${CEILING} (QueenRetryPolicy.maximumRealAttempts)   idle floor ${MIN_IDLE_H} h`)
console.log(`parked claims holding paths: ${rows.length}\n`)

const buckets = { release: [], quarantine: [], hold: [] }
for (const r of rows) {
  const c = classify(r)
  buckets[c.action].push({ ...r, why: c.why })
  const mark = { release: '->', quarantine: '!!', hold: '..' }[c.action]
  console.log(`${mark} #${String(r.issue).padEnd(5)} ${String(r.review_state).padEnd(9)} sb=${r.send_backs} paths=${(r.owned_paths || []).length}  ${c.why}`)
}

console.log(`\nrelease ${buckets.release.length}   quarantine ${buckets.quarantine.length}   hold ${buckets.hold.length}`)

if (!process.argv.includes('--release')) {
  console.log('\nreport only. re-run with --release to act.')
  process.exit(0)
}
if (!buckets.release.length) { console.log('\nnothing to release'); process.exit(0) }

// Record before mutating, so this is reversible from the ledger alone.
L.append({
  kind: 'lease-release',
  note: `clearing owned_paths on ${buckets.release.length} parked dispatches`,
  before: buckets.release.map((r) => ({ issue: r.issue, review_state: r.review_state, owned_paths: r.owned_paths, why: r.why })),
})

const issues = buckets.release.map((r) => Number(r.issue))
const UPDATE = `
const {Pool} = require('pg');
const p = new Pool({connectionString: process.env.DATABASE_URL});
p.query("update queen_dispatch set owned_paths = '[]'::jsonb where issue in (${issues.join(',')}) and finished_at is not null returning issue")
 .then(r => { console.log('released ' + r.rows.length); process.exit(0); })
 .catch(e => { console.log('ERR ' + e.message); process.exit(1); });
`
console.log('\n' + remote(UPDATE))
L.append({ kind: 'lease-released', issues })
}
