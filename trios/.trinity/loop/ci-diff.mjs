#!/usr/bin/env node
// Did MY change break this, or was it already red?
//
// WHY THIS EXISTS. On 2026-09-06 a one-file Swift change arrived at a CI job
// that was already failing, and answering "is this mine?" took four separate
// investigations: read the failing job, find a merged PR with the same jobs red,
// check whether any test even reads the changed file, and finally diff two runs
// by hand. The answer each time was a SET DIFFERENCE between two runs, and doing
// it by eye is how a real regression gets waved through as "that one was already
// broken".
//
// It matters because the alternative habit is worse in both directions. Merging
// over a red gate teaches everyone to ignore it - the suite on this branch has
// been red for days and PRs merge across it. Refusing to merge over any red gate
// means a live production defect waits on somebody else's flaky browser test.
// The only honest way through is to name exactly which failures are new.
//
// WHAT IT WILL NOT DO. It does not decide whether to merge. It prints three
// sets - fixed, still failing, NEW - and a new one is the only thing that should
// stop anybody. A tool that returned a verdict here would be guessing at a
// judgement that depends on what the change was.
//
// Usage:
//   node ci-diff.mjs <baseline-run-id> <candidate-run-id>
//   node ci-diff.mjs --pr <baseline-pr> <candidate-pr>

import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && process.argv[1].endsWith('/ci-diff.mjs')

const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REPO = process.env.TRIOS_CODE_REPO || 'gHashTag/BrowserOS'

const sh = (c) => {
  try { return execSync(c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }) } catch (e) { return String(e.stdout || '') }
}

/**
 * The failing test names in one run's log.
 *
 * Names, not counts. Two runs with the same number of failures can be failing
 * at completely different places, and a count would call that "no change".
 * The timing suffix is stripped because it differs on every run and would make
 * every failure look new.
 */
export function failuresIn(log) {
  return new Set(
    (String(log || '').match(/\(fail\)[^\n]*/g) || [])
      .map((l) => l.replace(/\s*\[[0-9.]+m?s\]\s*$/, '').replace(/^\(fail\)\s*/, '').trim())
      .filter(Boolean),
  )
}

/**
 * What changed between two runs.
 *
 * `unknown` is a real answer: a run whose log could not be read tells us
 * nothing, and reporting "0 new failures" for it would be the same defect this
 * whole directory keeps finding - a check reporting health for work it never
 * looked at.
 */
export function compareRuns(baseLog, headLog) {
  if (baseLog === null || headLog === null) return { unknown: true }
  const base = failuresIn(baseLog)
  const head = failuresIn(headLog)
  return {
    unknown: false,
    fixed: [...base].filter((f) => !head.has(f)).sort(),
    stillFailing: [...head].filter((f) => base.has(f)).sort(),
    introduced: [...head].filter((f) => !base.has(f)).sort(),
  }
}

export function render(r) {
  if (r.unknown) {
    return 'one of the two runs could not be read, so NOTHING was compared.\n' +
      'A run that cannot be read is not a run that passed.'
  }
  const out = []
  out.push(`${r.introduced.length} NEW, ${r.fixed.length} fixed, ${r.stillFailing.length} already failing`)
  if (r.introduced.length) {
    out.push('', 'NEW - these appeared with the change and are the only ones that should stop anybody:')
    for (const f of r.introduced) out.push(`  !! ${f}`)
    // AND "NEW" IS NOT YET "CAUSED BY". Measured on this tool's second day: a
    // run whose only difference from the previous one was three integers in a
    // test file reported `get_dom > scopes to a CSS selector` as new. Three
    // integers cannot reach a browser-tool suite, so it was flake joining a
    // family already flaking. The way to tell is another comparison whose diff
    // is too small to explain the failure - never a re-run and a shrug.
    out.push('', 'A NEW failure is not yet a CAUSED failure. Compare two runs whose diff is too')
    out.push('small to explain it before deciding: flake looks exactly like this, and so does')
    out.push('a real regression. Re-running until it passes decides nothing.')
  }
  if (r.fixed.length) {
    out.push('', 'FIXED - failing before, not failing now:')
    for (const f of r.fixed) out.push(`  ok ${f}`)
  }
  if (r.stillFailing.length) {
    out.push('', `ALREADY FAILING - ${r.stillFailing.length} carried over, none of them this change's doing:`)
    for (const f of r.stillFailing.slice(0, 10)) out.push(`  .. ${f}`)
    if (r.stillFailing.length > 10) out.push(`  .. and ${r.stillFailing.length - 10} more`)
  }
  if (!r.introduced.length) {
    out.push('', 'No failure is new. That is not permission to merge - it is the one question')
    out.push('this answers, and whether a suite this red should be merged across is a')
    out.push('separate decision somebody makes on purpose.')
  }
  return out.join('\n')
}

/** The failing-step log of one run, or null if it cannot be read. */
export function runLog(id, run = sh) {
  const out = run(`gh run view ${id} --repo ${REPO} --log-failed 2>/dev/null`)
  return out && out.trim() ? out : null
}

/** The most recent completed run id for a pull request. */
export function runIdForPr(number, run = sh) {
  const sha = run(`gh pr view ${number} --repo ${REPO} --json headRefOid -q .headRefOid`).trim()
  if (!sha) return null
  const id = run(`gh run list --repo ${REPO} --commit ${sha} --limit 20 --json databaseId,conclusion -q '[.[]|select(.conclusion=="failure" or .conclusion=="success")][0].databaseId'`).trim()
  return id || null
}

if (isMain) {
  const argv = process.argv.slice(2)
  let baseId
  let headId
  if (argv[0] === '--pr') {
    baseId = runIdForPr(argv[1])
    headId = runIdForPr(argv[2])
    if (!baseId || !headId) {
      console.log(`could not find a completed run for ${!baseId ? `PR ${argv[1]}` : `PR ${argv[2]}`}`)
      process.exit(3)
    }
  } else {
    ;[baseId, headId] = argv
  }
  if (!baseId || !headId) {
    console.log('usage: ci-diff.mjs <baseline-run-id> <candidate-run-id>')
    console.log('       ci-diff.mjs --pr <baseline-pr> <candidate-pr>')
    process.exit(1)
  }
  console.log(`baseline  ${baseId}\ncandidate ${headId}\n`)
  const r = compareRuns(runLog(baseId), runLog(headId))
  console.log(render(r))
  process.exit(r.unknown ? 3 : r.introduced.length ? 2 : 0)
}
