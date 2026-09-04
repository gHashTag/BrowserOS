// The gate for the two copies of the Queen's policy.
//
// rings/SR-00/<File>.swift is compiled into the Mac app. The same bytes are
// copied to agent-server/queen-core/Sources/QueenCore/ and
// agent-server/queen-core/Sources/QueenPolicy/ (see `make queen-core-sync`)
// because the Docker build context is the agent-server directory and cannot
// reach above it, and are compiled there into the Linux container. Two
// compilations of one rule: when the bytes stop matching, the app and the
// container quietly become two different arbiters of the same decision.
//
// That happened once. Commit 5a913246 ("fix(queen): normalize
// repository-relative boundaries", #1306) fixed strays() in the container copy
// only, so the two halves disagreed about which committed files count as
// inside a boundary - each half internally consistent, and nothing comparing
// them, because the check that existed lived in a Makefile target that never
// ran where the drift was committed. #1372 is the fallout.
//
// This gate is the same comparison with nothing in front of it:
//
//     node trios/tools/queen-core-copy-drift.mjs
//
// It pairs by file name, compares bytes, and exits non-zero on any difference,
// any unpaired file, or any ambiguity. Node standard library only. The check
// itself is exported as queenCoreCopyDrift(appDir, containerSourcesDir) so it
// can be exercised against any pair of directories.

import { Buffer } from 'node:buffer';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

// The container library modules whose sources are copies of rings/SR-00 files.
const CONTAINER_MODULE_DIRS = ['QueenCore', 'QueenPolicy'];

// Sources/queend is the container's own executable entry point, not a copy of
// anything on the app side. The rule does not pair it - and names it in every
// report instead of skipping it silently.
const CONTAINER_ENTRY_DIR = 'queend';

const APP_LABEL = 'rings/SR-00';
const CONTAINER_LABEL = 'agent-server/queen-core/Sources';

// All .swift files under `root`, as '/'-separated paths relative to it,
// sorted. Returns null when a directory cannot be read at all (missing, or
// worse); the caller turns that into a reported error, never silence.
function swiftFilesUnder(root, rel = '') {
  let entries;
  try {
    entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
  } catch {
    return null;
  }
  const out = [];
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const nested = swiftFilesUnder(root, relPath);
      if (nested === null) return null;
      out.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith('.swift')) {
      out.push(relPath);
    }
  }
  out.sort();
  return out;
}

function basenameOf(relPath) {
  return relPath.split('/').pop();
}

// Where two non-identical buffers first disagree, for the report: the byte
// offset the way cmp counts it, and both files' text at the first differing
// line. '<end of file>' means that side ran out of lines first.
function firstDifference(appBytes, containerBytes) {
  let byte = Math.min(appBytes.length, containerBytes.length);
  for (let i = 0; i < byte; i += 1) {
    if (appBytes[i] !== containerBytes[i]) {
      byte = i;
      break;
    }
  }
  const appLines = appBytes.toString('utf8').split('\n');
  const containerLines = containerBytes.toString('utf8').split('\n');
  let i = 0;
  while (i < appLines.length && i < containerLines.length && appLines[i] === containerLines[i]) {
    i += 1;
  }
  return {
    byte: byte + 1,
    line: i + 1,
    appLine: appLines[i] ?? '<end of file>',
    containerLine: containerLines[i] ?? '<end of file>',
  };
}

// Compare the app copy of the Queen's policy (rings/SR-00) with the container
// copy (agent-server/queen-core/Sources), pair by pair.
//
// Pairing rule: every .swift file under the container's copied library modules
// (Sources/QueenCore, Sources/QueenPolicy) is paired, by file name, with the
// .swift file of that name under the app directory, and each pair is compared
// byte for byte. A paired name that exists on only one side is unpaired, is
// reported with the side that has it, and fails the run - unpaired is not
// identical. Files the rule deliberately does not pair are named in the
// report, never dropped.
//
// Returns { ok, exitCode, rows, counts, lines } and touches nothing: no
// printing, no exit, no writes.
export function queenCoreCopyDrift(appDir, containerSourcesDir) {
  const rows = [];

  // Enumerate the app side, indexed by file name.
  const appFiles = swiftFilesUnder(appDir);
  const appByName = new Map();
  if (appFiles === null) {
    rows.push({
      kind: 'error',
      name: '(app directory)',
      detail: `cannot read ${appDir}`,
    });
  } else {
    for (const rel of appFiles) {
      const name = basenameOf(rel);
      if (!appByName.has(name)) appByName.set(name, []);
      appByName.get(name).push(rel);
    }
  }

  // Enumerate the container side: only the copied modules pair.
  const containerCandidates = [];
  const containerByName = new Map();
  for (const moduleDir of CONTAINER_MODULE_DIRS) {
    const files = swiftFilesUnder(join(containerSourcesDir, moduleDir));
    if (files === null) {
      rows.push({
        kind: 'error',
        name: moduleDir,
        detail: `cannot read ${join(containerSourcesDir, moduleDir)}`,
      });
      continue;
    }
    for (const rel of files) {
      const name = basenameOf(rel);
      containerCandidates.push({ name, rel: `${moduleDir}/${rel}` });
      if (!containerByName.has(name)) containerByName.set(name, []);
      containerByName.get(name).push(`${moduleDir}/${rel}`);
    }
  }

  // Name what the rule does not pair: the container entry point, and the
  // app-only sources that were never copied.
  let entryNote;
  const entryFiles = swiftFilesUnder(join(containerSourcesDir, CONTAINER_ENTRY_DIR));
  if (entryFiles === null) {
    entryNote = `${CONTAINER_ENTRY_DIR}/ (could not be read)`;
  } else {
    entryNote = entryFiles.map((rel) => `${CONTAINER_ENTRY_DIR}/${rel}`).join(', ');
  }
  const appOnly = appFiles === null ? [] : appFiles.filter((rel) => !containerByName.has(basenameOf(rel)));

  // Pair and compare. One row per pair, in name order.
  const names = [...new Set(containerCandidates.map((c) => c.name))].sort();
  for (const name of names) {
    const containerPaths = containerByName.get(name);
    const appPaths = appByName.get(name) ?? [];
    if (appPaths.length === 0) {
      rows.push({
        kind: 'unpaired',
        name,
        detail: 'present only on the agent-server (container) side',
      });
      continue;
    }
    if (appPaths.length > 1 || containerPaths.length > 1) {
      rows.push({
        kind: 'error',
        name,
        detail: `ambiguous file name: app has [${appPaths.join(', ')}], container has [${containerPaths.join(', ')}]`,
      });
      continue;
    }
    const appBytes = readFileSync(join(appDir, appPaths[0]));
    const containerBytes = readFileSync(join(containerSourcesDir, containerPaths[0]));
    if (Buffer.compare(appBytes, containerBytes) === 0) {
      rows.push({ kind: 'identical', name, detail: null });
    } else {
      rows.push({
        kind: 'DIFFERS',
        name,
        detail: firstDifference(appBytes, containerBytes),
      });
    }
  }

  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const counts = {
    identical: rows.filter((r) => r.kind === 'identical').length,
    differs: rows.filter((r) => r.kind === 'DIFFERS').length,
    unpaired: rows.filter((r) => r.kind === 'unpaired').length,
    errors: rows.filter((r) => r.kind === 'error').length,
  };
  counts.pairs = counts.identical + counts.differs;
  const ok = counts.differs === 0 && counts.unpaired === 0 && counts.errors === 0;

  const lines = renderReport({
    appDir,
    containerSourcesDir,
    rows,
    counts,
    entryNote,
    appOnlyCount: appOnly.length,
    ok,
  });

  return { ok, exitCode: ok ? 0 : 1, rows, counts, lines };
}

function renderReport({ appDir, containerSourcesDir, rows, counts, entryNote, appOnlyCount, ok }) {
  const lines = [];
  const push = (...ls) => lines.push(...ls);

  push('queen-core copy drift gate');
  push(`  app copy:       ${appDir}`);
  push(`  container copy: ${containerSourcesDir} (copied modules: ${CONTAINER_MODULE_DIRS.join(', ')})`);
  push('');
  push('Pairing rule: every .swift file under the copied modules');
  push(`${CONTAINER_LABEL}/{${CONTAINER_MODULE_DIRS.join(',')}} is paired by file name with the`);
  push(`.swift file of that name under ${APP_LABEL}, and each pair is compared byte for`);
  push('byte. A paired name that exists on only one side is unpaired, is reported with');
  push('the side that has it, and fails the run: unpaired is not identical. Named by');
  push('this rule and deliberately not paired, so nothing is skipped silently:');
  push(`  ${CONTAINER_LABEL}/${entryNote} - the container's executable entry point, not a copy;`);
  push(`  ${APP_LABEL}: ${appOnlyCount} further .swift files with no container twin - app-only`);
  push('    sources, outside the copied set.');
  push('');
  for (const row of rows) {
    if (row.kind === 'identical') {
      push(`  identical  ${row.name}`);
    } else if (row.kind === 'DIFFERS') {
      push(`  DIFFERS    ${row.name}`);
      push(`             first difference at byte ${row.detail.byte}, line ${row.detail.line}:`);
      push(`               ${APP_LABEL}:        ${row.detail.appLine.trim()}`);
      push(`               agent-server copy:  ${row.detail.containerLine.trim()}`);
    } else if (row.kind === 'unpaired') {
      push(`  unpaired   ${row.name} - ${row.detail}`);
    } else {
      push(`  ERROR      ${row.name} - ${row.detail}`);
    }
  }
  push('');
  push(
    `Pairs: ${counts.pairs}   identical: ${counts.identical}   DIFFERS: ${counts.differs}` +
      `   unpaired: ${counts.unpaired}   errors: ${counts.errors}`
  );
  push(`unpaired count: ${counts.unpaired}`);

  if (ok) {
    push(
      `[OK] ${counts.pairs} pairs identical, ${counts.unpaired} unpaired: the app and the` +
        ' container compile the same policy bytes'
    );
  } else {
    const differing = rows.filter((r) => r.kind === 'DIFFERS').map((r) => r.name);
    const unpaired = rows.filter((r) => r.kind === 'unpaired').map((r) => r.name);
    const errored = rows.filter((r) => r.kind === 'error').map((r) => r.name);
    const parts = [];
    if (differing.length > 0) parts.push(`differing: ${differing.join(', ')}`);
    if (unpaired.length > 0) parts.push(`unpaired: ${unpaired.join(', ')}`);
    if (errored.length > 0) parts.push(`errors: ${errored.join(', ')}`);
    push(`[FAIL] the copied Queen policy has drifted - ${parts.join('; ')}`);
  }
  return lines;
}

// CLI: resolve the two directories from this file's location, so the gate runs
// correctly from any working directory, print the report, and set the exit
// code. Importing the module for queenCoreCopyDrift runs none of this.
function runCli() {
  const toolsDir = dirname(fileURLToPath(import.meta.url)); // <repository>/tools
  const root = dirname(toolsDir);
  const appDir = join(root, 'rings', 'SR-00');
  const containerSourcesDir = join(root, 'agent-server', 'queen-core', 'Sources');
  const result = queenCoreCopyDrift(appDir, containerSourcesDir);
  for (const line of result.lines) console.log(line);
  process.exitCode = result.exitCode;
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  runCli();
}
