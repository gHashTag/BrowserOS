#!/usr/bin/env node
// Queue depth, which is not the open count - and where the time actually goes.
//
// THE CATEGORY ERROR THIS MEASURES. `author.mjs` refused to file with "at the
// WIP limit" while the swarm ran at 14% of capacity. Five authored issues were
// open; FOUR of them had already been dispatched and were sitting in sendBack
// or wait. The real queue - issues nobody has started - was ONE.
//
// Kanban limits work IN PROGRESS and never the backlog. Dependabot's
// `open-pull-requests-limit`, which that rule was copied from, exists to protect
// a HUMAN reviewer's capacity. Measured here over 119 dispatches, the review
// takes p50 0.8 SECONDS. There is no human to protect and nothing to throttle.
//
// So the number that matters is the depth of unstarted work, and the number to
// compare it against comes from Little's Law: N workers at a service time of W
// consume N/W tasks per unit time, and the arrival rate has to match. This
// prints both, because a depth without the rate it must sustain is a number
// nobody can act on.
//
// Usage:
//   node queue.mjs             # queue depth
//   node queue.mjs --latency   # where the time goes, and the arrival rate needed

import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'
const LABEL = process.env.AUTHOR_LABEL || 'queen-authored'
const WORKERS = Number(process.env.QUEEN_WORKERS ?? 4)
const isMain = process.argv[1] && process.argv[1].endsWith('/queue.mjs')

const SE = await import(path.join(DIR, 'stale-escalations.mjs'))

const tryShell = (c) => {
  try {
    return execSync(c, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}

/** The first JSON line of a remote answer, or null. Never an empty array. */
function jsonFrom(raw) {
  const line = String(raw ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('[') || l.startsWith('{'))
  if (!line) return null
  try { return JSON.parse(line) } catch { return null }
}

/**
 * How many authored issues nobody has started.
 *
 * An issue with a dispatch row is IN PROGRESS whatever its verdict - running,
 * sent back, waiting, escalated. It is not queue.
 *
 * Returns null when the service cannot be reached, and the caller must treat
 * that as UNKNOWN rather than as empty. An unreadable queue reported as 0 would
 * tell the author it has room for everything.
 */
export function depth() {
  const raw = tryShell(`gh issue list --repo ${REPO} --state open --label ${LABEL} --limit 100 --json number -q '.[].number'`)
  if (raw === null) return null
  const open = raw.split('\n').filter(Boolean)
  if (!open.length) return { open: 0, inProgress: 0, queue: 0, numbers: [] }

  const js = `const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});` +
    `p.query("select distinct issue from queen_dispatch where issue in (${open.join(',')})")` +
    `.then(r=>{console.log(JSON.stringify(r.rows)); return p.end()}).catch(e=>{console.log('ERR '+e.message); process.exit(1)})`
  const rows = jsonFrom(SE.remote(js))
  if (!Array.isArray(rows)) return null

  const started = new Set(rows.map((r) => String(r.issue)))
  const queue = open.filter((n) => !started.has(n))
  return { open: open.length, inProgress: open.length - queue.length, queue: queue.length, numbers: queue }
}

/**
 * Where the time goes: the reviewer, or the worker.
 *
 * I assumed for a whole iteration that review latency bounded throughput and
 * wrote it into the skill. It does not, and this is the measurement that said
 * so. Assumptions about which stage is slow are worth exactly what they cost to
 * check, which here is one query.
 */
export function latency(days = 14) {
  const js = `const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});` +
    `(async()=>{` +
    `const a=await p.query("select count(*) n, round(percentile_cont(0.5) within group (order by extract(epoch from (reviewed_at-finished_at)))::numeric,1) p50 from queen_dispatch where finished_at is not null and reviewed_at >= finished_at and dispatched_at > now() - interval '${days} days'");` +
    `const b=await p.query("select count(*) n, round(percentile_cont(0.5) within group (order by extract(epoch from (finished_at-dispatched_at)))::numeric,1) p50 from queen_dispatch where finished_at is not null and dispatched_at > now() - interval '${days} days'");` +
    `console.log(JSON.stringify({review:a.rows[0], bee:b.rows[0]})); await p.end()})()` +
    `.catch(e=>{console.log('ERR '+e.message); process.exit(1)})`
  return jsonFrom(SE.remote(js))
}

if (isMain) {
  if (process.argv.includes('--latency')) {
    const d = latency(Number(process.env.QUEUE_DAYS ?? 14))
    if (!d) {
      console.log('could not reach the service - where the time goes is unknown, which is not the same as fast')
      process.exit(1)
    }
    const beeP50 = Number(d.bee?.p50 ?? 0)
    console.log('where the time goes\n')
    console.log(`  review   finished -> verdict     n=${String(d.review?.n ?? '?').padStart(4)}   p50 ${d.review?.p50 ?? '?'} s`)
    console.log(`  bee      dispatched -> finished  n=${String(d.bee?.n ?? '?').padStart(4)}   p50 ${beeP50} s`)
    if (beeP50 > 0) {
      const perHour = (WORKERS * 3600) / beeP50
      console.log(`\nLittle's Law: ${WORKERS} workers at that service time consume about ${perHour.toFixed(1)} tasks an hour.`)
      console.log('If the swarm is idle, compare the ARRIVAL rate against that number - not the review.')
    }
    process.exit(0)
  }

  const q = depth()
  if (!q) {
    console.log('could not reach the service - the queue is unknown, which is not the same as empty')
    process.exit(1)
  }
  console.log(`${LABEL} issues\n`)
  console.log(`  open                              ${q.open}`)
  console.log(`  already dispatched (in progress)  ${q.inProgress}`)
  console.log(`  UNSTARTED - the actual queue      ${q.queue}${q.numbers.length ? `   (${q.numbers.join(' ')})` : ''}`)
  console.log(`\nA limit on the first number is a limit on the backlog column, where limits`)
  console.log(`do not belong. Only the third is queue.`)
}
