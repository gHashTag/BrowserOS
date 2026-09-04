#!/usr/bin/env node
// Is the swarm still proving anything, or has it started accepting work that
// changes nothing?
//
// WHY THIS IS NOT A THRESHOLD ON A PERCENTAGE.
//
// The obvious version compares this run's number against the last run's and
// shouts when it drops. Two independent reasons that is wrong, and the field
// has receipts for both:
//
//   A CONTROL CHART OF AN IN-CONTROL PROCESS SHOWS NOTHING AMISS, WHILE A
//   REGRESSION FIT OF THE SAME POINTS APPEARS TO SHOW A TREND. Reading trend
//   lines as regressions is a documented source of phantom findings in
//   flaky-test dashboards. A ratio that wanders inside its own noise band is
//   not a regression, and a tool that says it is will be muted within a week.
//
//   THE DENOMINATOR MOVES FOR REASONS THAT ARE NOT QUALITY. Coverage rises when
//   briefs happen to be written in a shape the auditor can read and falls when
//   a batch of hand-written epics lands. Neither is the swarm getting better or
//   worse at its job.
//
// So this asks the question canary analysis asks: not "is the number low"
// against a fixed line, but "is the RECENT work different from the BASELINE
// this same process established" - which controls for drift that a static limit
// cannot. And it answers with Wilson score intervals, because at these sample
// sizes the normal approximation runs outside [0,1] exactly where the question
// is being asked.
//
// It refuses to say "worse" on overlapping intervals. "No detectable
// difference" is a real answer and it is the honest one most of the time.
//
// TWO TIERS, from the multi-window burn-rate pattern: a sharp separated drop is
// something to act on now; a drift inside the noise is something to watch. They
// are different messages and collapsing them into one alert is how the one
// alert stops being read.
//
// Usage:
//   node proven.mjs            # report
//   node proven.mjs --record   # report and append the reading to history
//   node proven.mjs --fresh    # re-read every brief rather than the cache

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/proven.mjs')
const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const HISTORY = path.join(DIR, 'state', 'proven-history.jsonl')

// How many of the newest verdicts count as RECENT. Small enough that a bad
// afternoon is visible, large enough that a Wilson interval on it means
// something. Named because a constant nobody explains is the defect this
// codebase keeps finding.
export const RECENT_N = Number(process.env.PROVEN_RECENT_N || 40)

const tryShell = (cmd) => {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}

/**
 * The two windows: the newest RECENT_N verdicts, and everything before them.
 *
 * Ordered by issue number, which is a proxy for time and a good one here -
 * these issues are filed by a machine in sequence. It is a PROXY and not the
 * thing itself, which matters if issues are ever filed out of order.
 */
export function split(results, recentN = RECENT_N) {
  const ordered = [...results].sort((a, b) => Number(b.number) - Number(a.number))
  return { recent: ordered.slice(0, recentN), baseline: ordered.slice(recentN) }
}

/**
 * Of the verdicts this window could judge at all, how many proved something?
 *
 * The denominator is CHECKABLE, not total. A brief with nothing mechanical in
 * it is not evidence the swarm got worse; it is evidence about the brief, and
 * mixing the two makes both unreadable.
 */
export function rate(window) {
  const checkable = window.filter((r) => ['SUPPORTED', 'VACUOUS CLAIM', 'CLAIM UNSUPPORTED'].includes(r.verdict))
  const proven = checkable.filter((r) => r.verdict === 'SUPPORTED')
  return { proven: proven.length, checkable: checkable.length, total: window.length }
}

/**
 * The reading, and what it does and does not license anyone to say.
 *
 * `act` is the two-tier decision: 'now' when the intervals are separated and
 * the recent window is lower, 'watch' when the point estimate fell but the
 * intervals still overlap, 'none' otherwise. A drop inside the noise is not
 * nothing - it is the thing to look at twice next round - but it is not a
 * finding and must not be printed as one.
 */
export function assess(recent, baseline, compare) {
  const r = rate(recent)
  const b = rate(baseline)
  if (!r.checkable || !b.checkable) {
    return { act: 'none', why: 'not enough judged work in one of the two windows to compare', r, b }
  }
  const c = compare(b.proven, b.checkable, r.proven, r.checkable, 'baseline', 'recent')
  const fell = c.b.p < c.a.p
  const act = !c.overlap && fell ? 'now' : fell ? 'watch' : 'none'
  return { act, comparison: c, r, b }
}


/**
 * Which detector filed this brief, read from the title it wrote.
 *
 * A PROXY, and worth naming as one: the kind is not stored anywhere, so it is
 * recovered from the sentence `author.mjs` composes for each detector. Change a
 * title template and this silently reclassifies everything filed after that -
 * which is why 'other' is a real bucket rather than a dumping ground, and why
 * the report prints its size.
 */
export function classify(title) {
  const s = String(title || '')
  if (/breaks L3 with \d+ non-ASCII/.test(s)) return 'ascii'
  if (/exports (?:one symbol|\d+ symbols) and no test names any of them/.test(s)) return 'untested'
  if (/is \d+ lines, and nothing has ever said what is inside it/.test(s)) return 'length'
  return 'other'
}

/**
 * Each kind of work against ALL THE OTHER KINDS, corrected for the fact that
 * asking several questions at once makes a surprising answer likelier.
 *
 * TWO THINGS THIS GETS RIGHT ON PURPOSE.
 *
 * A group is compared with the REST, not with the overall rate. A group sitting
 * inside its own baseline drags that baseline toward itself, which shrinks every
 * difference and hides exactly the outlier the split was made to find.
 *
 * And the threshold is family-corrected. Four groups tested at 95% each carry a
 * 19% chance that one comes back significant with nothing wrong anywhere. A
 * split-by-category dashboard tested at the single-comparison threshold raises a
 * false alarm about every fifth look, and then it gets muted, and then the real
 * one is missed too.
 *
 * WHAT IT STILL CANNOT TELL YOU. Simpson's paradox: the overall rate can move
 * in the opposite direction to every single group, if the MIX changes. So the
 * mix is printed beside the rates rather than left to be assumed constant.
 */
export function bySource(results, titleOf, compare, z) {
  const groups = new Map()
  for (const r of results) {
    const k = classify(titleOf(r.number))
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const out = []
  for (const [kind, rows] of groups) {
    const mine = rate(rows)
    const rest = rate(results.filter((r) => !rows.includes(r)))
    if (!mine.checkable || !rest.checkable) {
      out.push({ kind, mine, rest, act: 'none', why: 'too little judged work on one side to compare' })
      continue
    }
    const c = compare(rest.proven, rest.checkable, mine.proven, mine.checkable, 'rest', kind, z)
    const fell = c.b.p < c.a.p
    out.push({ kind, mine, rest, comparison: c, act: !c.overlap && fell ? 'now' : fell ? 'watch' : 'none' })
  }
  return out.sort((a, b) => b.mine.total - a.mine.total)
}

export function render(a) {
  const out = []
  const pct = (x) => `${(100 * x).toFixed(1)}%`
  if (!a.comparison) {
    out.push(`  ${a.why}`)
    return out.join('\n')
  }
  const c = a.comparison
  out.push(`  baseline  ${String(c.a.hits).padStart(4)}/${String(c.a.n).padEnd(4)} ${pct(c.a.p).padStart(7)}   95% ${pct(c.a.low)} to ${pct(c.a.high)}`)
  out.push(`  recent    ${String(c.b.hits).padStart(4)}/${String(c.b.n).padEnd(4)} ${pct(c.b.p).padStart(7)}   95% ${pct(c.b.low)} to ${pct(c.b.high)}`)
  out.push('')
  if (a.act === 'now') {
    out.push('  ACT NOW: the recent window proves LESS than this process has established,')
    out.push('  and the intervals do not overlap. The swarm is accepting work that changes')
    out.push('  nothing measurable. Read the newest VACUOUS and UNSUPPORTED verdicts.')
  } else if (a.act === 'watch') {
    out.push('  WATCH: the recent rate is lower, but the intervals overlap - this is not')
    out.push('  yet distinguishable from noise, and calling it a regression is how a')
    out.push('  dashboard earns the right to be ignored.')
    if (Number.isFinite(c.needed)) {
      out.push(`  About ${c.needed} judged verdicts in each window would separate a gap this size.`)
    }
  } else {
    out.push(`  ${c.verdict}`)
  }
  return out.join('\n')
}

/** Append one reading, so drift across rounds is visible rather than inferred. */
export function record(a, file = HISTORY) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      act: a.act,
      recent: a.r,
      baseline: a.b,
    }) + '\n')
  } catch { /* a reading that cannot be stored is still a reading */ }
}

if (isMain) {
  const VA = await import(path.join(DIR, 'verdict-audit.mjs'))
  const AB = await import(path.join(DIR, 'ab.mjs'))
  const FRESH = process.argv.includes('--fresh')

  const branches = tryShell(`git branch -r --list 'origin/queen-*'`) || ''
  const numbers = [...new Set(
    branches.split('\n').map((b) => (b.match(/queen-(\d+)\s*$/) || [])[1]).filter(Boolean),
  )].sort((a, b) => Number(b) - Number(a))

  if (!numbers.length) {
    console.log('no pushed queen branches - nothing to measure, which is not the same as nothing wrong')
    process.exit(1)
  }

  const cache = FRESH ? {} : VA.loadCache()
  const results = numbers.map((n) => VA.auditIssue(n, cache))
  if (!FRESH) VA.saveCache(cache)

  const { recent, baseline } = split(results)
  const a = assess(recent, baseline, AB.compare)

  console.log(`proven verdicts: the newest ${RECENT_N} against the ${baseline.length} before them\n`)
  console.log(render(a))

  const all = rate(results)
  console.log(`\n  overall ${all.proven}/${all.checkable} judged verdicts prove something; ${all.total - all.checkable} carry nothing this can check`)

  if (process.argv.includes('--by-source')) {
    const raw = tryShell(`gh issue list --repo ${process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'} --state all --label queen-authored --limit 500 --json number,title`)
    let titles = new Map()
    try { titles = new Map(JSON.parse(raw || '[]').map((r) => [String(r.number), r.title])) } catch { /* none */ }
    const rows = bySource(results, (n) => titles.get(String(n)), AB.compare, AB.zForFamily(4))
    console.log(`\n  by the kind of work that was filed  (Bonferroni z=${AB.zForFamily(4).toFixed(3)} for 4 comparisons)\n`)
    const pct = (x) => `${(100 * x).toFixed(1)}%`
    for (const g of rows) {
      const mark = { now: '!!', watch: '..', none: 'ok' }[g.act]
      const c = g.comparison
      console.log(`  ${mark} ${g.kind.padEnd(9)} ${String(g.mine.proven).padStart(4)}/${String(g.mine.checkable).padEnd(4)} ` +
        `${c ? pct(c.b.p).padStart(7) : '      -'}   vs the rest ${c ? pct(c.a.p) : '-'}   ${g.mine.total} verdict(s)`)
    }
    const flagged = rows.filter((g) => g.act === 'now')
    console.log(flagged.length
      ? `\n  ${flagged.map((g) => g.kind).join(', ')} proves measurably less than the rest, at a threshold corrected for asking four questions at once.`
      : '\n  no kind of work proves measurably less than the others once the threshold is corrected for asking four questions at once.')
    console.log('  The MIX is printed because Simpson\'s paradox is real: the overall rate can move')
    console.log('  opposite to every group if the proportions change underneath it.')
  }

  if (process.argv.includes('--record')) record(a)

  // Exit 2 only for the tier that means act. A watch is information, and a
  // chain that fails on information is a chain that gets its failures ignored.
  process.exit(a.act === 'now' ? 2 : 0)
}
