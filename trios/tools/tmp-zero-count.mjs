#!/usr/bin/env node
//
// tmp-zero-count.mjs — make the /tmp violation countable (issue gHashTag/trios#1345).
//
// The technology tree node `tmp-zero-gate` describes a Rust checker that would
// fail the workspace if anyone invoked it — and nobody does
// (`grep -c tmp-zero Makefile` = 0). This script does not run the Rust gate:
// it only counts what the gate would flag, so the decision to wire the gate
// is taken against a number instead of against a memory.
//
// Rules, mirroring the gate's own semantics (rings/RUST-99/tmp-zero-gate):
//   * scan every .rs file under rings/ and count lines containing "/tmp"
//     (the gate flags any line where line.contains("/tmp"));
//   * report production and test occurrences as two separate numbers,
//     never one: a line is test code when it lies inside (or among the
//     attributes of) a #[cfg(test)] item, or when its file lives under a
//     path containing a `tests` directory. Everything else is production;
//   * read the exemption list from the gate's own source, never carry a copy.
//
// This script is read-only: it edits no Rust file and builds nothing.
// Node standard library only.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // <repo>/tools/.. = <repo>
const RINGS_DIR = join(ROOT, 'rings');
const GATE_SOURCE = join(ROOT, 'rings', 'RUST-99', 'tmp-zero-gate', 'src', 'main.rs');
const EVIDENCE_FILE = 'rings/RUST-02/clade-e2e/src/main.rs'; // the tree's cited example
const TMP_LITERAL = '/tmp';
const SKIPPED_DIRS = new Set(['target']); // cargo build artifacts, not sources

// Parse EXEMPT_DIRS out of the gate's source text (FR-001). The counter must
// never carry its own copy of the exemption list, so the two rules cannot
// drift apart silently.
function exemptDirs(gateSourcePath) {
  const lines = readFileSync(gateSourcePath, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /const\s+EXEMPT_DIRS\b/.test(l));
  if (start < 0) {
    throw new Error(`EXEMPT_DIRS declaration not found in ${gateSourcePath}`);
  }
  const dirs = [];
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/"([^"]*)"/g)) dirs.push(m[1]);
    if (i > start && /^\s*\];/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    throw new Error(`EXEMPT_DIRS array in ${gateSourcePath} never closes`);
  }
  return { dirs, fromLine: start + 1, toLine: end + 1 };
}

// Collect every .rs file under a directory, recursively.
function walkRustFiles(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIPPED_DIRS.has(name)) walkRustFiles(p, acc);
    } else if (name.endsWith('.rs')) {
      acc.push(p);
    }
  }
  return acc;
}

// Strip line comments, string literals and char literals so brace counting is
// not confused by braces appearing inside them. Heuristic: raw strings with
// embedded braces are not handled.
function codeOnly(line) {
  const commentAt = line.indexOf('//');
  let s = commentAt >= 0 ? line.slice(0, commentAt) : line;
  s = s.replace(/r#*"(?:[^"\\]|\\.)*"/g, '""');
  s = s.replace(/'(?:[^'\\]|\\.)'/g, "''");
  return s;
}

function braceDelta(code) {
  let d = 0;
  for (const ch of code) {
    if (ch === '{') d += 1;
    else if (ch === '}') d -= 1;
  }
  return d;
}

// Decide, for every line of a file, whether it is test code. A line is test
// code when the file lives under a `tests` directory, or when the line lies
// inside the item introduced by a #[cfg(test)] attribute (the attribute line
// and sibling attributes of that item count as part of the test item).
function testLineFlags(lines, pathIsTest) {
  const flags = new Array(lines.length).fill(pathIsTest);
  if (pathIsTest) return flags;
  let seenCfgTest = false;
  let insideTestItem = false;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const code = codeOnly(lines[i]);
    if (insideTestItem) {
      flags[i] = true;
      depth += braceDelta(code);
      if (depth <= 0) {
        insideTestItem = false;
        seenCfgTest = false;
        depth = 0;
      }
      continue;
    }
    if (seenCfgTest) {
      flags[i] = true; // attribute or opening line of the cfg(test) item
      if (/#\[cfg\(test\)\]/.test(code)) continue;
      if (code.includes('{')) {
        insideTestItem = true;
        depth = braceDelta(code);
        if (depth <= 0) {
          insideTestItem = false;
          seenCfgTest = false;
          depth = 0;
        }
      } else if (/;\s*$/.test(code) && !/^\s*#\[/.test(code)) {
        seenCfgTest = false; // braceless item (e.g. `mod tests;`) — region ends
      }
      continue;
    }
    if (/#\[cfg\(test\)\]/.test(code)) {
      seenCfgTest = true;
      flags[i] = true;
    }
  }
  return flags;
}

// Count /tmp occurrences in one file, split into production and test.
function countFile(absPath) {
  const rel = relative(ROOT, absPath).split('\\').join('/');
  const lines = readFileSync(absPath, 'utf8').split(/\r?\n/);
  const pathIsTest = rel.split('/').includes('tests');
  const flags = testLineFlags(lines, pathIsTest);
  let production = 0;
  let test = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(TMP_LITERAL)) {
      if (flags[i]) test += 1;
      else production += 1;
    }
  }
  return { rel, production, test, total: production + test };
}

function main() {
  const gate = exemptDirs(GATE_SOURCE);
  const files = walkRustFiles(RINGS_DIR).map(countFile);
  const withHits = files
    .filter((f) => f.total > 0)
    .sort((a, b) => b.total - a.total || a.rel.localeCompare(b.rel));

  const production = files.reduce((n, f) => n + f.production, 0);
  const test = files.reduce((n, f) => n + f.test, 0);

  console.log('tmp-zero count: /tmp literals in Rust sources under rings/ (issue gHashTag/trios#1345)');
  console.log(`production lines: ${production}`);
  console.log(`test lines: ${test}`);
  console.log(`files: ${withHits.length}`);
  console.log(`exempt dirs: ${gate.dirs.length}`);
  console.log(
    `exempt list (read from ${relative(ROOT, GATE_SOURCE)} lines ${gate.fromLine}-${gate.toLine}): ${gate.dirs.join(', ')}`
  );
  console.log(`scanned: ${files.length} .rs files under rings/`);
  console.log('');
  console.log(`files with the most occurrences (top ${Math.min(10, withHits.length)} of ${withHits.length}):`);
  withHits.slice(0, 10).forEach((f, i) => {
    console.log(`  ${i + 1}. ${f.rel}: ${f.total} total (${f.production} production, ${f.test} test)`);
  });

  // Evidence check: the tree's cited example must show up; if it does not,
  // the discrepancy is reported, not hidden.
  const evidence = withHits.find((f) => f.rel === EVIDENCE_FILE);
  console.log('');
  if (evidence) {
    console.log(
      `evidence check: ${EVIDENCE_FILE} is among the files with occurrences (${evidence.total} lines) — matches the tree's evidence.`
    );
  } else {
    console.log(
      `evidence check: ${EVIDENCE_FILE} is NOT among the files with occurrences — DISCREPANCY with the tree's evidence.`
    );
    const scanned = files.find((f) => f.rel === EVIDENCE_FILE);
    if (!scanned) {
      console.log(`  (${EVIDENCE_FILE} was not scanned; it may have moved or been removed.)`);
    }
  }

  const exemptHits = withHits.filter((f) => gate.dirs.some((d) => f.rel.startsWith(d)));
  console.log('');
  console.log(
    `exemption overlap: ${exemptHits.length === 0 ? 'none of the' : `${exemptHits.length} of the`} ${withHits.length} files with occurrences fall under an exempt directory.`
  );
  console.log(
    `reconciliation: ${production} production + ${test} test = ${production + test} lines containing /tmp.`
  );
  console.log(
    'classification: a line is test code inside a #[cfg(test)] item or under a tests/ path; all other lines are production.'
  );
}

main();
