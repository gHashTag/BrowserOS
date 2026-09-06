#!/usr/bin/env node
// Which of these red tests are broken, and which are weather?
//
// WHY THIS EXISTS. Six assertions have been failing on this branch and the only
// tool for triaging them was a hunch: `navigation tools`, `window tools` and
// `get_dom` "look flaky", `probeGatewayReady` "looks real". A hunch decides
// whether somebody spends a night on a browser test that was going to pass
// anyway, or merges past a regression because its neighbours are noisy.
//
// The measurement is simple and nobody was making it: a failure that appears in
// EVERY run is deterministic; one that appears in some is intermittent. That is
// the definition of flake, and it is a frequency.
//
// THE DENOMINATOR IS RUNS THAT COULD BE READ, and this is the whole care of the
// tool. A name missing from a run's failures can mean it passed - or that the
// job died before reaching it, or that the log could not be fetched. Counting
// an unreadable run as a pass would manufacture intermittency out of network
// trouble, which is exactly the shape this directory keeps finding: a checker
// reporting health for work it never looked at.
//
// AND THE CAVEAT IS PRINTED, NOT ASSUMED AWAY. These runs are of DIFFERENT
// commits, because that is what a busy branch produces. A test fixed halfway
// through the window looks intermittent and is not. So the tool prints the
// commit count beside the frequency and refuses to call anything "flaky" on its
// own: it says how often, over how many readable runs, of how many commits. The
// word for 6-of-12 across 12 commits is "unstable", and what to do about it is
// a judgement this does not make.
//
// Usage:
//   node flaky.mjs              # the last 10 Tests runs
//   node flaky.mjs 12           # the last N
//   node flaky.mjs <id> <id>…   # exactly these runs

import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/flaky.mjs')

const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REPO = process.env.TRIOS_CODE_REPO || 'gHashTag/BrowserOS'

const sh = (c) => {
  try { return execSync(c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }) } catch (e) { return String(e.stdout || '') }
}

/**
 * Count how often each failure name appears across runs.
 *
 * `runs` is a list of `{ id, sha, failures }` where `failures` is null for a
 * run whose log could not be read. A null run is excluded from the denominator
 * entirely rather than counted as a pass - the difference between "it passed
 * there" and "we never looked" is the whole point.
 */
export function tally(runs) {
  const readable = runs.filter((r) => r.failures !== null)
  const unreadable = runs.length - readable.length
  const counts = new Map()
  for (const r of readable) {
    for (const name of r.failures) {
      if (!counts.has(name)) counts.set(name, { name, seen: 0, shas: new Set() })
      const e = counts.get(name)
      e.seen++
      if (r.sha) e.shas.add(r.sha)
    }
  }
  const n = readable.length
  const rows = [...counts.values()].map((e) => ({
    name: e.name,
    seen: e.seen,
    of: n,
    commits: e.shas.size,
    // Named for what was measured, never for what it implies. "deterministic"
    // is a fact about this window; "unstable" is too. Neither is a verdict on
    // whether the test is worth keeping.
    kind: n === 0 ? 'unknown' : e.seen === n ? 'deterministic' : 'unstable',
  }))
  rows.sort((a, b) => b.seen - a.seen || a.name.localeCompare(b.name))
  return { rows, readable: n, unreadable, runs: runs.length }
}

export function render(t) {
  if (!t.readable) {
    return 'no run log could be read, so NOTHING was measured.\n' +
      'A run that cannot be read is not a run that passed.'
  }
  const out = [
    `${t.readable} readable run(s) of ${t.runs}` + (t.unreadable ? `, ${t.unreadable} skipped because their logs could not be read` : ''),
    '',
  ]
  const det = t.rows.filter((r) => r.kind === 'deterministic')
  const uns = t.rows.filter((r) => r.kind === 'unstable')
  out.push(`DETERMINISTIC - failed in every readable run (${det.length}):`)
  for (const r of det) out.push(`  !! ${r.seen}/${r.of}  ${r.name}`)
  if (!det.length) out.push('  (none)')
  out.push('', `UNSTABLE - failed in some (${uns.length}):`)
  for (const r of uns) out.push(`  ~  ${r.seen}/${r.of}  ${r.name}`)
  if (!uns.length) out.push('  (none)')
  out.push('')
  out.push('These runs are of DIFFERENT commits, which is what a busy branch produces.')
  out.push('A test fixed halfway through the window looks unstable and is not, so the')
  out.push('commit count is printed with each row and no row is called "flaky" here -')
  out.push('that word is a judgement, and this only measures how often.')
  return out.join('\n')
}

/** The failing test names of one run, or null if its log could not be read. */
export function failuresOf(id, deps = {}) {
  const run = deps.run || sh
  const parse = deps.parse
  const out = run(`gh run view ${id} --repo ${REPO} --log-failed 2>/dev/null`)
  if (!out || !out.trim()) {
    // A GREEN RUN IS NOT AN UNREADABLE ONE. `--log-failed` prints nothing when
    // every job passed, and counting that as unreadable would drop the very
    // runs that prove something was fixed - inflating every remaining failure's
    // frequency toward "deterministic" exactly when it stopped being one.
    // AN EMPTY STRING IS NOT A ZERO. `Number('')` is 0, so an unreadable job
    // list would have read as "no failures" - the same defect one level down.
    const failed = String(run(`gh run view ${id} --repo ${REPO} --json jobs -q '[.jobs[]|select(.conclusion=="failure")]|length' 2>/dev/null`) ?? '').trim()
    if (!/^\d+$/.test(failed)) return null
    return Number(failed) === 0 ? [] : null
  }
  if (parse) return parse(out)
  return [...new Set(
    (out.match(/\(fail\)[^\n]*/g) || [])
      .map((l) => l.replace(/\s*\[[0-9.]+m?s\]\s*$/, '').replace(/^\(fail\)\s*/, '').trim())
      .filter(Boolean),
  )]
}

if (isMain) {
  const argv = process.argv.slice(2)
  const ids = argv.filter((a) => /^\d{6,}$/.test(a))
  let runs
  if (ids.length) {
    runs = ids.map((id) => ({ id, sha: null }))
  } else {
    const want = Number(argv.find((a) => /^\d{1,3}$/.test(a)) || 10)
    const listed = sh(`gh run list --repo ${REPO} --workflow Tests --limit ${want} --json databaseId,headSha -q '.[]|"\\(.databaseId) \\(.headSha)"'`)
    runs = listed.split('\n').filter(Boolean).map((l) => {
      const [id, sha] = l.trim().split(/\s+/)
      return { id, sha }
    })
  }
  if (!runs.length) {
    console.log('no Tests run was found - nothing was measured, which is not the same as nothing failing')
    process.exit(3)
  }
  console.log(`reading ${runs.length} run(s)…\n`)
  for (const r of runs) r.failures = failuresOf(r.id)
  const t = tally(runs)
  console.log(render(t))
  const det = t.rows.filter((r) => r.kind === 'deterministic').length
  console.log(`\n${t.rows.length} distinct failure(s), ${det} deterministic, ${t.rows.length - det} unstable, over ${t.readable} readable run(s)`)
  process.exit(t.readable ? 0 : 3)
}
