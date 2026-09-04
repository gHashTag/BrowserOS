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

/**
 * The verdict mix, which is the swarm's real health.
 *
 * Load answers "are workers busy". This answers "is the work landing", and on
 * 2026-09-04 the two disagreed sharply: four bees running while only 17% of
 * finished dispatches were accepted, 28% answered `wait` - the review could not
 * judge them at all - and each of those held its issue for six hours.
 *
 * `wait` and a null verdict are the numbers to watch. They do not mean the work
 * was bad; they mean nobody could tell, which is worse, because a send-back at
 * least says what to fix.
 */
export function verdicts(hours = 3) {
  const js = `const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});` +
    `(async()=>{` +
    `const a=await p.query("select coalesce(review_state,'(none)') as state, count(*)::int n from queen_dispatch where finished_at is not null and dispatched_at > now() - interval '${hours} hours' group by 1 order by 2 desc");` +
    `const b=await p.query("select count(*)::int n from queen_dispatch where finished_at is null and dispatched_at > now() - interval '${hours} hours'");` +
    `console.log(JSON.stringify({rows:a.rows, inFlight:b.rows[0].n})); await p.end()})()` +
    `.catch(e=>{console.log('ERR '+e.message); process.exit(1)})`
  return jsonFrom(SE.remote(js))
}

/**
 * WHAT KIND of work the swarm has been doing.
 *
 * Load says whether workers are busy. Acceptance says whether the work lands.
 * Neither says whether it was worth doing, and on 2026-09-04 the two agreed
 * perfectly while all FORTY of the last authored issues were the same thing:
 * replacing box-drawing characters in comments. 4 of 4 running, 100% accepted,
 * and nothing but cosmetics.
 *
 * That is Goodhart in miniature - "keep the workers busy" became the target and
 * produced busy workers on the cheapest available work. A monoculture is
 * invisible in every metric that counts tasks rather than kinds, so this counts
 * kinds.
 */
export function mix(limit = 40) {
  const raw = tryShell(
    `gh issue list --repo ${REPO} --state all --label ${LABEL} --limit ${limit} --json title,state -q '.[] | .state + "\t" + .title'`,
  )
  if (raw === null) return null
  const KINDS = [
    [/breaks L3 with \d+ non-ASCII/, 'ascii cleanup'],
    [/is \d+ lines, and nothing has ever said/, 'long file, undocumented'],
    [/exports (?:one symbol|\d+ symbols) and no test/, 'untested module'],
  ]
  const counts = new Map()
  for (const line of raw.split('\n').filter(Boolean)) {
    const [, title = ''] = line.split('\t')
    const hit = KINDS.find(([re]) => re.test(title))
    const kind = hit ? hit[1] : 'other'
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return { total: raw.split('\n').filter(Boolean).length, counts: [...counts.entries()].sort((a, b) => b[1] - a[1]) }
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

  if (process.argv.includes('--verdicts')) {
    const hours = Number(process.env.VERDICT_HOURS ?? process.argv[process.argv.indexOf('--verdicts') + 1] ?? 3)
    const answer = verdicts(Number.isFinite(hours) && hours > 0 ? hours : 3)
    if (!answer || !Array.isArray(answer.rows)) {
      console.log('could not reach the service - the verdict mix is unknown, which is not the same as healthy')
      process.exit(1)
    }
    const rows = answer.rows
    const total = rows.reduce((n, r) => n + Number(r.n), 0)
    console.log(`verdicts on work finished in the last ${hours} hour(s)\n`)
    if (!total) {
      console.log('  nothing finished in that window')
      process.exit(0)
    }
    for (const r of rows) {
      const pct = Math.round((100 * Number(r.n)) / total)
      console.log(`  ${String(r.state).padEnd(10)} ${String(r.n).padStart(3)}  ${String(pct).padStart(3)}%  ${'#'.repeat(Math.round(pct / 3))}`)
    }
    const blind = rows
      .filter((r) => r.state === 'wait' || r.state === '(none)')
      .reduce((n, r) => n + Number(r.n), 0)
    console.log(`\n${total} finished. ${Math.round((100 * blind) / total)}% got NO judgement at all.`)
    console.log('A send-back at least says what to fix; a wait says nobody could tell,')
    console.log('and holds the issue for six hours while saying it.')
    // NAME THE DENOMINATOR, because getting it wrong is the mistake this tool
    // was written after. I reported "only 17% of dispatches are accepted" and
    // built a whole argument on it. The window was still in flight: most of
    // those rows had no verdict YET, and `wait` and `(none)` were transient
    // states rather than outcomes. Judged three hours later, the same window
    // read 80% accepted. A rate over a window that has not finished is not a
    // rate, and a reader cannot tell unless the tool says how much it excluded.
    if (answer.inFlight > 0) {
      console.log(`\n${answer.inFlight} dispatch(es) in this window are still RUNNING and are excluded.`)
      console.log('A window that has not finished has no rate yet - measure it again once it has.')
    }
    process.exit(0)
  }

  if (process.argv.includes('--mix')) {
    const arg = Number(process.argv[process.argv.indexOf('--mix') + 1])
    const m = mix(Number.isFinite(arg) && arg > 0 ? arg : Number(process.env.MIX_LIMIT ?? 40))
    if (!m) {
      console.log('could not list the authored issues - the mix is unknown, which is not the same as varied')
      process.exit(1)
    }
    console.log(`the last ${m.total} authored issues, by KIND\n`)
    for (const [kind, n] of m.counts) {
      const pct = Math.round((100 * n) / m.total)
      console.log(`  ${kind.padEnd(24)} ${String(n).padStart(3)}  ${String(pct).padStart(3)}%  ${'#'.repeat(Math.round(pct / 3))}`)
    }
    const top = m.counts[0]
    if (top && top[1] / m.total > 0.8) {
      console.log(`\n${Math.round((100 * top[1]) / m.total)}% of the backlog is "${top[0]}". A swarm at full load doing one`)
      console.log('cheap thing is still a swarm doing one cheap thing - load is not value.')
      process.exit(3)
    }
    console.log('\nNo single kind is more than four fifths of the backlog.')
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
