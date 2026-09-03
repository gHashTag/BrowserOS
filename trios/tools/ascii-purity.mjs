#!/usr/bin/env node
// ascii-purity -- survey and gate for L3 (PURITY) of trios/CLAUDE.md:
// "Source files ASCII-only." Extended from "English identifiers" by the
// operator on 2026-08-19. See also .claude/skills/ascii-lint for the
// human-facing lint recipe; this script is the gate that skill never had.
//
// One script, one rule (FR-002): survey mode and gate mode read the same
// scan() and count with the same offendingBytes(). There is no second
// implementation of the law anywhere in this file.
//
//   node trios/tools/ascii-purity.mjs --survey
//       Print the distance to the law: how many covered files hold at
//       least one byte above 0x7F, and how many such bytes exist in total.
//       Always exits 0 -- a survey measures, it does not fail.
//
//   node trios/tools/ascii-purity.mjs --gate
//       Exit non-zero only when a violating file is absent from the
//       committed baseline (new work breaking the law), or when a baseline
//       entry no longer violates (a baseline that only grows is a baseline
//       nobody shrinks). The baseline is trios/tools/ascii-purity-baseline.txt:
//       one repository-relative path per line, sorted.
//
// Covered (FR-001): .swift, .ts, .rs, .zig, .t27 and .sh files under
// trios/rings/, trios/agent-server/apps/server/src/ and trios/tools/,
// excluding node_modules, .worktrees and .claude/worktrees directories.
//
// Node standard library only (FR-004). Reads only (FR-005): this script
// never rewrites a source file; fixing existing violations is separate work.

import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..', '..'); // the repository root that holds trios/
const BASELINE_PATH = join(SCRIPT_DIR, 'ascii-purity-baseline.txt');

const COVERED_ROOTS = [
  'trios/rings',
  'trios/agent-server/apps/server/src',
  'trios/tools',
];
const COVERED_EXTENSIONS = new Set(['.swift', '.ts', '.rs', '.zig', '.t27', '.sh']);
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', '.worktrees', '.git']);

// The one rule of L3 purity: a byte above 0x7F offends. Returns how many
// offending bytes the buffer holds. (One non-ASCII character in UTF-8 is
// two to four offending bytes; the law counts bytes, not characters.)
export function offendingBytes(buffer) {
  let count = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] > 0x7f) count += 1;
  }
  return count;
}

function repoPath(absolutePath) {
  return relative(ROOT, absolutePath).split('\\').join('/');
}

// Walk the covered roots and return every covered file as a sorted list of
// repository-relative paths. node_modules, .worktrees, .git and
// .claude/worktrees directories are never entered (FR-001).
function coveredFiles() {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // a directory we cannot read holds nothing to gate on
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        if (entry.name === 'worktrees' && basename(directory) === '.claude') continue; // .claude/worktrees
        walk(absolute);
      } else if (entry.isFile() && COVERED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        found.push(repoPath(absolute));
      }
    }
  };
  for (const root of COVERED_ROOTS) walk(join(ROOT, root));
  return found.sort();
}

// Scan every covered file once. Both modes read this same result, so the
// survey and the gate can never disagree about what violates.
export function scan() {
  const violations = [];
  for (const path of coveredFiles()) {
    let bytes = 0;
    try {
      bytes = offendingBytes(readFileSync(join(ROOT, path)));
    } catch (error) {
      console.error(`ascii-purity: cannot read ${path}: ${error.message}`);
      continue;
    }
    if (bytes > 0) violations.push({ path, bytes });
  }
  const violatingBytes = violations.reduce((total, violation) => total + violation.bytes, 0);
  return { violations, violatingBytes };
}

function loadBaseline() {
  let text;
  try {
    text = readFileSync(BASELINE_PATH, 'utf8');
  } catch {
    console.error(`ascii-purity: baseline missing: ${repoPath(BASELINE_PATH)}`);
    console.error('ascii-purity: run a survey, commit the baseline, then gate.');
    process.exit(2);
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function survey() {
  const { violations, violatingBytes } = scan();
  console.log(`violating files: ${violations.length}`);
  console.log(`violating bytes: ${violatingBytes}`);
  return 0; // a survey measures the distance to the law; it never fails
}

function gate() {
  const { violations } = scan();
  const baseline = loadBaseline();
  const known = new Set(baseline);
  const offending = new Set(violations.map((violation) => violation.path));

  const fresh = violations.filter((violation) => !known.has(violation.path));
  const stale = baseline.filter((path) => !offending.has(path));

  for (const violation of fresh) {
    console.log(`new violation: ${violation.path} (${violation.bytes} offending bytes)`);
  }
  for (const path of stale) {
    console.log(`stale baseline entry: ${path} -- no violation found (file is clean, gone, or no longer covered); shrink the baseline`);
  }
  if (fresh.length > 0 || stale.length > 0) {
    console.log(`gate: FAILED -- ${fresh.length} new violation(s), ${stale.length} stale baseline entry(s)`);
    return 1;
  }
  console.log(`gate: clean -- ${violations.length} known violation(s) all match the baseline, nothing new, nothing stale`);
  return 0;
}

function main() {
  const mode = process.argv[2];
  if (mode === '--survey') return survey();
  if (mode === '--gate') return gate();
  console.error('usage: node trios/tools/ascii-purity.mjs --survey | --gate');
  return 2;
}

const invokedDirectly = resolve(process.argv[1] || '') === SCRIPT_PATH;
if (invokedDirectly) process.exitCode = main();
