#!/usr/bin/env node
/**
 * The gate for gHashTag/trios#1379: the report's started count must come from
 * the `started` boolean on each dispatch outcome, not from the length of the
 * array that also holds refusals.
 *
 * Node standard library only, no installed dependencies, because a worker
 * checkout has no `node_modules` and the gate has to run there. It prints
 * every number it compared so a disagreement can be judged without reading
 * the code that produced it.
 *
 * Red is a finding, not a failure: run on the unfixed tree it prints
 * `started.length occurrences in queen-tick.ts: 8` and exits non-zero, and
 * that count is exactly the measurement the fix exists to bring to zero.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tickPath = join(
  repoRoot,
  'trios/agent-server/apps/server/src/api/services/queen-tick.ts',
)
const linesPath = join(
  repoRoot,
  'trios/agent-server/apps/server/src/api/services/queen-report-lines.ts',
)

const failures = []

// The rule lives in queen-report-lines.ts, a module with no imports so its own
// test can load it in a worker checkout. A tree without that file is the
// unfixed tree, and the gate says so instead of throwing: it has to be runnable
// before the file is written, to measure what is there today.
if (!existsSync(linesPath)) {
  console.log('queen-report-lines.ts: missing')
  failures.push('queen-report-lines.ts does not exist')
}

const source = readFileSync(tickPath, 'utf8')

// Counted as occurrences, not lines: `started.length` appears twice on one
// line of the original (the headline ternary), and both must go.
const occurrenceCount = source.split('started.length').length - 1
const workingLiteralPresent = source.includes('bee(s) working')
const helperPresent = source.includes('dispatchesThatStarted')

console.log(`started.length occurrences in queen-tick.ts: ${occurrenceCount}`)
console.log(
  `bee(s) working literal in queen-tick.ts: ` +
    (workingLiteralPresent ? 'present' : 'absent'),
)
console.log(
  `dispatchesThatStarted in queen-tick.ts: ` +
    (helperPresent ? 'present' : 'absent'),
)

if (occurrenceCount !== 0) {
  failures.push(`expected 0 started.length occurrences, found ${occurrenceCount}`)
}
if (workingLiteralPresent) {
  failures.push("expected the literal 'bee(s) working' to be absent")
}
if (!helperPresent) {
  failures.push(
    'expected dispatchesThatStarted to be present (the rule must be called, ' +
      'not copied)',
  )
}

if (failures.length > 0) {
  console.log(`queen-report-started-gate: FAIL (${failures.length} check(s))`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('queen-report-started-gate: PASS')
