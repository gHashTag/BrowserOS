#!/usr/bin/env node
/**
 * xctest-triage.mjs -- make the failing-test count mean one thing.
 *
 * An XCTest summary line ("Executed N tests, with M failures") counts
 * ASSERTION failures, not tests, so "104 failures" can be 74 failing tests.
 * This script counts distinct `Test Case '...' failed` lines instead: one
 * failing-test total, one row per class, and -- when given a second log from
 * a per-class run -- the isolation column, flagging every class that fails
 * MORE alone than in the full run (order dependence in the direction nobody
 * looks for).
 *
 * Usage:
 *   node tools/xctest-triage.mjs <full-run.log>
 *   node tools/xctest-triage.mjs <full-run.log> <per-class-run.log>
 *
 * The script only reads the log files it is given. It never builds anything
 * and never runs tests (FR-002). Node standard library only; no third-party
 * packages.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * A failing-test line, in either spelling:
 *   Test Case 'Class.testMethod()' failed (0.311 seconds)     (swift test)
 *   Test Case '-[Class testMethod]' failed (0.842 seconds)    (xcodebuild)
 *
 * Anchored to the start of the line so it can never match an XCTAssert /
 * XCTFail failure message (those lines begin with a file path), a `passed`,
 * `skipped` or `started` line, or a `Test Suite` summary line (FR-001).
 */
const TEST_CASE_FAILED_RE = /^Test Case .* failed/;

/** Normalize either spelling of a test-case name to "Class.method". */
function normalizeTestCaseName(rawName) {
  const bracketed = rawName.match(/^-\[(.+)\]$/); // xcodebuild: -[Class method]
  if (bracketed) {
    const parts = bracketed[1].trim().split(/\s+/);
    if (parts.length >= 2) {
      return `${parts.slice(0, -1).join('.')}.${parts[parts.length - 1]}`;
    }
    return parts[0];
  }
  return rawName.replace(/\(\)$/, ''); // swift test: Class.method()
}

/** Extract the quoted test-case name from a `Test Case` line, or null. */
function testCaseNameFromLine(line) {
  const match = line.match(/'([^']+)'/);
  return match ? normalizeTestCaseName(match[1]) : null;
}

/** "LogsTabViewTests.testFilter" -> "LogsTabViewTests" (last dot wins). */
function classOf(testName) {
  const dot = testName.lastIndexOf('.');
  return dot === -1 ? testName : testName.slice(0, dot);
}

/**
 * Count DISTINCT failing tests per class in one XCTest log.
 *
 * Every unique `Test Case ... failed` line contributes one failing test to
 * its class. Duplicate lines and retries of the same test count once.
 * XCTAssert / XCTFail lines are never counted (FR-001).
 *
 * @param {string} logText Full text of an xcodebuild / `swift test` log.
 * @returns {Map<string, number>} test class -> number of failing tests.
 */
export function failingTestsByClass(logText) {
  const counted = new Set();
  const perClass = new Map();
  for (const line of String(logText).split(/\r?\n/)) {
    if (!TEST_CASE_FAILED_RE.test(line)) continue;
    const testName = testCaseNameFromLine(line);
    if (testName === null || counted.has(testName)) continue;
    counted.add(testName);
    const cls = classOf(testName);
    perClass.set(cls, (perClass.get(cls) ?? 0) + 1);
  }
  return perClass;
}

const sumCounts = (counts) => [...counts.values()].reduce((a, b) => a + b, 0);

/** Render the FR-003 table. `aloneCounts` null means single-log mode. */
function renderTable(fullCounts, aloneCounts) {
  const classes = new Set(fullCounts.keys());
  if (aloneCounts) {
    for (const cls of aloneCounts.keys()) classes.add(cls);
  }
  const rows = [...classes].map((cls) => ({
    cls,
    full: fullCounts.get(cls) ?? 0,
    alone: aloneCounts ? (aloneCounts.get(cls) ?? 0) : null,
  }));
  rows.sort(
    (a, b) =>
      b.full - a.full ||
      (b.alone ?? -1) - (a.alone ?? -1) ||
      a.cls.localeCompare(b.cls),
  );
  const lines = [
    '| class | full | alone | worse alone |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const alone = row.alone === null ? '—' : String(row.alone);
    const worse =
      row.alone === null ? '—' : row.alone > row.full ? '⚠ yes' : 'no';
    lines.push(`| ${row.cls} | ${row.full} | ${alone} | ${worse} |`);
  }
  return lines.join('\n');
}

function readLog(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`xctest-triage: cannot read ${path}: ${error.message}`);
    process.exit(1);
  }
}

function main(argv) {
  const logPaths = argv.slice(2);
  if (logPaths.length < 1 || logPaths.length > 2) {
    console.error(
      'usage: node tools/xctest-triage.mjs <full-run.log> [per-class-run.log]',
    );
    process.exit(1);
  }

  const fullCounts = failingTestsByClass(readLog(logPaths[0]));
  console.log(`failing tests: ${sumCounts(fullCounts)}`);

  let aloneCounts = null;
  if (logPaths.length === 2) {
    aloneCounts = failingTestsByClass(readLog(logPaths[1]));
    console.log(`failing tests (isolated run): ${sumCounts(aloneCounts)}`);
    const worse = [...new Set([...fullCounts.keys(), ...aloneCounts.keys()])]
      .filter((cls) => (aloneCounts.get(cls) ?? 0) > (fullCounts.get(cls) ?? 0))
      .sort();
    console.log(
      worse.length === 0
        ? 'classes worse alone: none'
        : `classes worse alone: ${worse.length} (${worse.join(', ')})`,
    );
  }

  console.log();
  console.log(renderTable(fullCounts, aloneCounts));
}

// Behave as a CLI when executed, stay quiet when imported (for tests of the
// exported failingTestsByClass function).
const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main(process.argv);
}
