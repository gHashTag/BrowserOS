/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Lease predicate gate - gHashTag/trios#1378
 *
 * The stale-lease rule ("a running row with no lease, or one whose lease has
 * expired, is free to take over") is written down exactly once, as the
 * module-level constant STALE_LEASE_PREDICATE, and interpolated by both
 * dequeueNextTask and reclaimStaleLeases. Before the fix the same comparison
 * was hand-written twice and the two copies drifted: only the dequeue arm
 * matched a running row whose lease was NULL, so the reaper never recovered
 * such rows. This gate reads the service source as text - never by line
 * number, line numbers rot on the next edit - and goes red when the two call
 * sites drift apart again or when updateTaskStatus stops maintaining the
 * lease columns.
 *
 * The gate carries a negative self-check: it re-derives the pre-fix text in
 * memory by substituting the constant reference back to the bare literal,
 * runs its own assertions against that regressed text, and exits non-zero
 * unless those assertions reject it. A gate that cannot fail is not a gate.
 *
 * Zero dependencies: node builtins only. No install step, no network socket,
 * no database.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PREDICATE_NAME = 'STALE_LEASE_PREDICATE'
const PREDICATE_REFERENCE = '${' + PREDICATE_NAME + '}'
const PREDICATE_COMPARISON = 'lease_expires_at < NOW()'
const PREDICATE_VALUE =
  "status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < NOW())"
const REGRESSED_COMPARISON = "status = 'running' AND lease_expires_at < NOW()"

const servicePath = join(
  dirname(realpathSync(process.argv[1])),
  '..',
  'agent-server',
  'apps',
  'server',
  'src',
  'api',
  'services',
  'task-queue-service.ts',
)

/** Count non-overlapping occurrences of a substring. */
function countOccurrences(haystack, needle) {
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/** The span of source between two textual markers: one method's body. */
function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  if (start === -1) {
    throw new Error('cannot locate ' + startMarker + ' in the service source')
  }
  const end = src.indexOf(endMarker, start)
  if (end === -1) {
    throw new Error('cannot locate ' + endMarker + ' after ' + startMarker)
  }
  return src.slice(start, end)
}

/**
 * Run every assertion against a source text and return the list of failures.
 * An empty list means the text passes. Each failure names the method that
 * regressed, where one did.
 */
function checkServiceSource(src) {
  const failures = []
  const fail = (message) => failures.push(message)

  // Locate the three methods by their text, not by line number.
  const dequeueBody = sliceBetween(
    src,
    'async dequeueNextTask',
    'async renewLease',
  )
  const reclaimBody = sliceBetween(
    src,
    'async reclaimStaleLeases',
    'private startLeaseHeartbeat',
  )
  const updateBody = sliceBetween(
    src,
    'async updateTaskStatus',
    'async retryTask',
  )

  // The declaration: exactly one, at module level, holding the unified
  // predicate. The value is pinned with its IS NULL arm, so the reaper can
  // never again be narrower than the dequeue path, and the dequeue path can
  // never be narrowed to match the old reaper.
  const declarationLines = src.match(/^const STALE_LEASE_PREDICATE = .*$/gm)
  const declarations = declarationLines === null ? 0 : declarationLines.length
  if (declarations !== 1) {
    fail(
      'expected exactly one module-level declaration of ' +
        PREDICATE_NAME +
        ', found ' +
        declarations,
    )
  }
  const declaration = declarations === 1 ? declarationLines[0] : ''
  const valueMatch = declaration.match(
    /^const STALE_LEASE_PREDICATE = [`"](.*)[`"]$/,
  )
  if (valueMatch === null || valueMatch[1] !== PREDICATE_VALUE) {
    fail(PREDICATE_NAME + ' must hold exactly: ' + PREDICATE_VALUE)
  }

  // The comparison is written down exactly once, and that one time is inside
  // the declaration. Any other occurrence is a hand-written copy that can
  // drift away from the first again.
  const comparisonCount = countOccurrences(src, PREDICATE_COMPARISON)
  if (comparisonCount !== 1) {
    fail(
      'the comparison must be written down exactly once, found ' +
        comparisonCount +
        ' occurrences of ' +
        PREDICATE_COMPARISON,
    )
  }
  const declarationAt = src.indexOf(declaration)
  const comparisonAt = src.indexOf(PREDICATE_COMPARISON)
  if (
    comparisonAt !== -1 &&
    declarationAt !== -1 &&
    (comparisonAt < declarationAt ||
      comparisonAt >= declarationAt + declaration.length)
  ) {
    fail(
      'the only occurrence of the comparison must sit inside the ' +
        PREDICATE_NAME +
        ' declaration',
    )
  }

  // Both call sites go through the constant and neither keeps a hand-written
  // copy of the comparison.
  if (!dequeueBody.includes(PREDICATE_REFERENCE)) {
    fail(
      'dequeueNextTask does not interpolate ' +
        PREDICATE_NAME +
        ' - its stale-lease arm is hand-written or missing',
    )
  }
  if (dequeueBody.includes(PREDICATE_COMPARISON)) {
    fail('dequeueNextTask keeps a hand-written copy of the comparison')
  }
  if (!reclaimBody.includes(PREDICATE_REFERENCE)) {
    fail(
      'reclaimStaleLeases does not interpolate ' +
        PREDICATE_NAME +
        ' - its reclaim predicate is hand-written or missing',
    )
  }
  if (reclaimBody.includes(PREDICATE_COMPARISON)) {
    fail('reclaimStaleLeases keeps a hand-written copy of the comparison')
  }

  // updateTaskStatus maintains the lease columns: entering running grants a
  // real lease, the same five minutes the dequeue path grants, so the reclaim
  // sweep does not reap a legitimately running task on the next heartbeat;
  // any move out of running clears both columns.
  if (!updateBody.includes('lease_owner')) {
    fail('updateTaskStatus never mentions lease_owner')
  }
  if (!updateBody.includes('lease_expires_at')) {
    fail('updateTaskStatus never mentions lease_expires_at')
  }
  const runningAt = updateBody.indexOf("status === 'running'")
  if (runningAt === -1) {
    fail("updateTaskStatus has no status === 'running' branch")
  } else if (
    !updateBody.slice(runningAt).includes("NOW() + interval '5 minutes'")
  ) {
    fail(
      "entering running must grant the dequeue path's five minute lease: NOW() + interval '5 minutes'",
    )
  }
  if (
    !updateBody.includes('lease_owner = NULL') ||
    !updateBody.includes('lease_expires_at = NULL')
  ) {
    fail('leaving running must clear lease_owner and lease_expires_at to NULL')
  }

  // Scheduling and locking stay as they were: the claim ordering, the
  // SKIP LOCKED row lock and the 30 second heartbeat interval.
  for (const invariant of [
    'FOR UPDATE SKIP LOCKED',
    'ORDER BY priority DESC, created_at ASC',
    '30_000',
  ]) {
    if (!src.includes(invariant)) {
      fail('scheduling/locking invariant lost: ' + invariant)
    }
  }

  return failures
}

/**
 * Re-derive the pre-fix text: every constant reference becomes the bare
 * literal again, the shape the two call sites had before the fix.
 */
function deriveRegressedSource(src) {
  return src.split(PREDICATE_REFERENCE).join(REGRESSED_COMPARISON)
}

function main() {
  let src
  try {
    src = readFileSync(servicePath, 'utf8')
  } catch (error) {
    console.error(
      'queen-lease-predicate-gate: cannot read the service source at ' +
        servicePath,
    )
    process.exitCode = 1
    return
  }

  const failures = checkServiceSource(src)
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error('queen-lease-predicate-gate: FAIL - ' + failure)
    }
    console.error(
      'queen-lease-predicate-gate: red against the service file - the service file is what must change (gHashTag/trios#1378)',
    )
    process.exitCode = 1
    return
  }

  console.log(
    'queen-lease-predicate-gate: ' +
      PREDICATE_NAME +
      ' declared once, holding the unified predicate',
  )
  console.log(
    'queen-lease-predicate-gate: the comparison is written down exactly once, inside the declaration',
  )
  console.log(
    'queen-lease-predicate-gate: dequeueNextTask and reclaimStaleLeases interpolate the constant',
  )
  console.log(
    'queen-lease-predicate-gate: updateTaskStatus grants a lease on entering running and clears it on leaving',
  )

  const regressed = deriveRegressedSource(src)
  const regressedFailures = checkServiceSource(regressed)
  const namesDequeue = regressedFailures.some((failure) =>
    failure.includes('dequeueNextTask'),
  )
  const namesReclaim = regressedFailures.some((failure) =>
    failure.includes('reclaimStaleLeases'),
  )
  if (regressedFailures.length === 0 || !namesDequeue || !namesReclaim) {
    console.error(
      'queen-lease-predicate-gate: FAIL - negative self-check did not reject the regressed source; this gate is vacuous',
    )
    process.exitCode = 1
    return
  }

  console.log(
    'queen-lease-predicate-gate: negative self-check: rejected regressed source (named dequeueNextTask and reclaimStaleLeases)',
  )
  console.log('queen-lease-predicate-gate: PASS')
}

main()
