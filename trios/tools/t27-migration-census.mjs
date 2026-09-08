#!/usr/bin/env node
//
// t27-migration-census.mjs — the migration surface, counted.
//
// For gHashTag/trios#1350. Answers three countable questions about the
// tree, and nothing else:
//
//   1. How many distinct .t27 specs exist, and how many copied .t27 files
//      were excluded to get that number. The two counts are printed as two
//      separate numbers and are never summed.
//   2. Which distinct specs have a generated artifact beside them, and how
//      many have none.
//   3. How much hand-written source each ring under trios/rings/ carries
//      (files, lines, specs, generated target), ranked by source lines
//      descending so the largest un-migrated surface is the first row.
//
// The census counts and ranks. It does NOT decide whether any hand-written
// file restates a .t27 rule; that judgement belongs to a human (FR-002).
//
// Node standard library only (FR-004). The tree root is resolved from this
// script's own location, so the census can be run from any directory as:
//
//     node trios/tools/t27-migration-census.mjs  (from the checkout root)
//     node tools/t27-migration-census.mjs      (from the trios root)
//
// It reads nothing outside the trios tree and writes exactly one file:
// trios/.trinity/dashboard/t27-census.json (FR-003). The output carries no
// timestamp and no absolute path, so two runs on an unchanged tree produce
// byte-identical stdout and a byte-identical dashboard file.
//

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The trios tree root, derived from this file's own location
// (trios/tools/t27-migration-census.mjs -> trios/). Never from process.cwd().
const TRIOS_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DASHBOARD_FILE = '.trinity/dashboard/t27-census.json';

// FR-001 — the copy exclusion rule. A path containing a ".claude/worktrees/"
// segment is a copy of another checkout of this repository, not a distinct
// file. On the tree this issue was filed against, those copies live under
// rings/RUST-13/trios-mesh/.claude/worktrees/. The rule is printed with the
// report and applies to every count in it: copied .t27 files are counted
// separately from distinct specs (never summed), and copied source files are
// not counted at all.
const COPY_DIR_SEGMENTS = ['.claude', 'worktrees'];

// Directories never entered by the walk.
const SKIPPED_DIRECTORIES = ['.git', 'node_modules'];

// A file counts as hand-written source when its extension is in this list.
// The list is printed with the report so a reader can see what counted.
const SOURCE_EXTENSIONS = [
  '.c', '.h', '.cpp', '.hpp',
  '.js', '.jsx', '.mjs',
  '.py',
  '.rs',
  '.sh',
  '.swift',
  '.ts', '.tsx',
  '.v',
  '.zig',
];

// ---------------------------------------------------------------------------
// Deterministic helpers. Every sort in this file uses code-unit order
// (never localeCompare, whose result depends on the machine's locale).
// ---------------------------------------------------------------------------

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function segmentsOf(relPath) {
  return relPath.split('/');
}

function isCopyPath(relPath) {
  const seg = segmentsOf(relPath);
  for (let i = 0; i + 1 < seg.length; i++) {
    if (seg[i] === COPY_DIR_SEGMENTS[0] && seg[i + 1] === COPY_DIR_SEGMENTS[1]) {
      return true;
    }
  }
  return false;
}

function extensionOf(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

function stemOf(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  return base.slice(0, base.length - '.t27'.length);
}

function lineCount(text) {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// Walk the tree rooted at `absDir` (recording paths relative to the trios
// root in `relDir`). Collects every regular file in `files` and every
// directory in `dirs`, both as '/'-separated relative paths in sorted
// order. Symlinks are never followed, so the walk cannot leave the tree.
function walk(absDir, relDir, files, dirs) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => cmp(a.name, b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const rel = relDir === '' ? entry.name : relDir + '/' + entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
      dirs.push(rel);
      walk(join(absDir, entry.name), rel, files, dirs);
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
}

// ---------------------------------------------------------------------------
// The census itself.
// ---------------------------------------------------------------------------

function readLines(relPath) {
  try {
    return lineCount(readFileSync(join(TRIOS_ROOT, relPath), 'utf8'));
  } catch {
    return 0;
  }
}

// The generated-artifact rule, as one string so stdout and the dashboard
// file state it identically: a spec has a generated artifact when a
// directory named "generated" beside the spec file exists and holds, at any
// depth under it, a file whose name is the spec stem or begins with the
// stem followed by ".".
const GENERATED_RULE =
  'a spec has a generated artifact when a directory named "generated" beside ' +
  'the spec file (<spec directory>/generated/) exists and holds, under it, a ' +
  'file whose name is the spec stem or begins with the stem followed by "."';

function artifactFor(generatedDir, stem, files) {
  const prefix = generatedDir + '/';
  for (const rel of files) {
    if (!rel.startsWith(prefix)) continue;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (base === stem || base.startsWith(stem + '.')) return rel;
  }
  return null;
}

function specCensus(files, dirs) {
  const t27 = files.filter((rel) => rel.endsWith('.t27'));
  const distinct = t27.filter((rel) => !isCopyPath(rel)).sort(cmp);
  const copied = t27.filter((rel) => isCopyPath(rel)).sort(cmp);

  const generatedDirs = new Set(dirs.filter((rel) => rel.slice(rel.lastIndexOf('/') + 1) === 'generated'));

  const entries = distinct.map((rel) => {
    const specDir = rel.slice(0, rel.lastIndexOf('/'));
    const generatedDir = specDir === '' ? 'generated' : specDir + '/generated';
    const dirPresent = generatedDirs.has(generatedDir);
    const artifact = dirPresent ? artifactFor(generatedDir, stemOf(rel), files) : null;
    return {
      path: rel,
      generatedDir,
      generatedDirPresent: dirPresent,
      artifact,
      hasGeneratedArtifact: artifact !== null,
    };
  });

  return {
    distinct,
    copied,
    withoutGeneratedArtifact: entries.filter((e) => !e.hasGeneratedArtifact).length,
    entries,
    excludedCopyPaths: [...new Set(copied.map((rel) => rel.slice(0, rel.lastIndexOf('/'))))].sort(cmp),
  };
}

// One row of the ring table: the migration surface of a single directory
// under trios/rings/. Counts only files inside that ring, excluding copy
// paths everywhere. `allFiles` and `allDirs` are the full walked lists.
function ringSurface(ringName, allFiles, allDirs) {
  const ringPrefix = 'rings/' + ringName + '/';
  const inside = (rel) => rel.startsWith(ringPrefix);

  const ringFiles = allFiles.filter(inside);
  const sources = ringFiles
    .filter((rel) => !isCopyPath(rel) && SOURCE_EXTENSIONS.includes(extensionOf(rel)))
    .sort(cmp);

  const specFiles = ringFiles.filter((rel) => rel.endsWith('.t27') && !isCopyPath(rel));

  const generatedTarget = allDirs.some(
    (rel) => inside(rel) && rel.slice(rel.lastIndexOf('/') + 1) === 'generated'
  );

  return {
    ring: ringName,
    path: 'rings/' + ringName,
    sourceFiles: sources.length,
    sourceLines: sources.reduce((sum, rel) => sum + readLines(rel), 0),
    specFiles: specFiles.length,
    generatedTarget,
  };
}

function ringTable(files, dirs) {
  const rings = dirs
    .filter((rel) => {
      const seg = segmentsOf(rel);
      return seg[0] === 'rings' && seg.length === 2;
    })
    .map((rel) => segmentsOf(rel)[1])
    .sort(cmp);
  return rings.map((name) => ringSurface(name, files, dirs)).sort((a, b) => {
    if (a.sourceLines !== b.sourceLines) return b.sourceLines - a.sourceLines;
    return cmp(a.ring, b.ring);
  });
}

function buildCensus() {
  const files = [];
  const dirs = [];
  walk(TRIOS_ROOT, '', files, dirs);
  files.sort(cmp);
  dirs.sort(cmp);

  const specs = specCensus(files, dirs);
  const rings = ringTable(files, dirs);

  const census = {
    census: 't27-migration-census',
    issue: 'gHashTag/trios#1350',
    scope: {
      treeRoot: 'trios',
      specFiles: 'any file named *.t27 anywhere under the trios tree',
      skippedDirectories: SKIPPED_DIRECTORIES,
      sourceExtensions: SOURCE_EXTENSIONS,
    },
    exclusionRule: {
      rule:
        'any path containing a ".claude/worktrees/" segment is a copy of another ' +
        'checkout of this repository, not a distinct file',
      appliesTo: 'every count in this census',
      knownCopyLocation: 'rings/RUST-13/trios-mesh/.claude/worktrees/',
      excludedCopyPathsSeenThisRun: specs.excludedCopyPaths,
    },
    specs: {
      distinct: specs.distinct.length,
      copied: specs.copied.length,
      neverSummed: true,
      generatedArtifactRule: GENERATED_RULE,
      withoutGeneratedArtifact: specs.withoutGeneratedArtifact,
      entries: specs.entries,
    },
    rings: {
      rankedBy: 'source lines descending, then ring name ascending',
      table: rings,
    },
    nonClaim:
      'This census counts and ranks. It does not decide whether any hand-written ' +
      'file restates a .t27 rule; that judgement belongs to a human (FR-002).',
  };
  return census;
}

// ---------------------------------------------------------------------------
// Rendering. Plain text for stdout, JSON for the dashboard file. Both carry
// only trios-relative paths and no timestamp, so both are byte-stable.
// ---------------------------------------------------------------------------

function padRight(text, width) {
  let out = String(text);
  while (out.length < width) out += ' ';
  return out;
}

function padLeft(text, width) {
  let out = String(text);
  while (out.length < width) out = ' ' + out;
  return out;
}

function renderReport(census) {
  const lines = [];
  lines.push('t27 migration census — gHashTag/trios#1350');
  lines.push('==========================================');
  lines.push('');
  lines.push('Scope');
  lines.push('  tree root            trios (resolved from this script\'s location; nothing outside it is read)');
  lines.push('  spec files           ' + census.scope.specFiles);
  lines.push('  directories skipped  ' + census.scope.skippedDirectories.join(', ') + ' (never entered)');
  lines.push('');
  lines.push('Exclusion rule (FR-001)');
  lines.push('  ' + census.exclusionRule.rule + '.');
  lines.push('  Known copy location: ' + census.exclusionRule.knownCopyLocation);
  lines.push('  The rule applies to every count below: copied .t27 files are counted');
  lines.push('  separately from distinct specs and never summed with them, and copied');
  lines.push('  source files are not counted at all.');
  const seen = census.exclusionRule.excludedCopyPathsSeenThisRun;
  lines.push('  Excluded copy paths seen this run:' + (seen.length === 0 ? ' none' : ''));
  for (const p of seen) lines.push('    ' + p);
  lines.push('');
  lines.push('Spec census');
  lines.push('  distinct .t27 specs         ' + census.specs.distinct);
  lines.push('  copied .t27 files excluded  ' + census.specs.copied);
  lines.push('  (two separate numbers; the census never prints their sum)');
  lines.push('');
  lines.push('Generated artifacts');
  lines.push('  Rule: ' + census.specs.generatedArtifactRule + '.');
  lines.push('  specs with no generated artifact: ' + census.specs.withoutGeneratedArtifact +
    ' of ' + census.specs.distinct);
  for (const e of census.specs.entries) {
    let why;
    if (!e.generatedDirPresent) why = 'no generated/ directory beside it';
    else if (e.artifact === null) why = 'generated/ beside it holds no matching file';
    else why = 'artifact: ' + e.artifact;
    lines.push('    ' + padRight(e.path, 34) + '  ' + why);
  }
  lines.push('');
  lines.push('Ring surface — one row per directory under rings/, ranked by source lines, descending');
  lines.push('  source extensions counted: ' + census.scope.sourceExtensions.join(' '));
  lines.push('  spec files are distinct specs (copies excluded)');
  lines.push('');
  const table = census.rings.table;
  const wRing = Math.max(4, ...table.map((r) => r.ring.length));
  const wSrcF = Math.max(12, ...table.map((r) => String(r.sourceFiles).length));
  const wSrcL = Math.max(12, ...table.map((r) => String(r.sourceLines).length));
  const wSpec = Math.max(10, ...table.map((r) => String(r.specFiles).length));
  lines.push('    ' + padRight('ring', wRing) + '  ' + padLeft('source files', wSrcF) + '  ' +
    padLeft('source lines', wSrcL) + '  ' + padLeft('spec files', wSpec) + '  generated target');
  for (const r of table) {
    lines.push('    ' + padRight(r.ring, wRing) + '  ' + padLeft(r.sourceFiles, wSrcF) + '  ' +
      padLeft(r.sourceLines, wSrcL) + '  ' + padLeft(r.specFiles, wSpec) + '  ' +
      (r.generatedTarget ? 'yes' : 'no'));
  }
  lines.push('');
  lines.push('Dashboard (FR-003)');
  lines.push('  written: ' + DASHBOARD_FILE + ' (deterministic; identical bytes on re-run)');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function main() {
  const census = buildCensus();
  const json = JSON.stringify(census, null, 2) + '\n';
  const dashboardPath = join(TRIOS_ROOT, DASHBOARD_FILE);
  mkdirSync(join(TRIOS_ROOT, '.trinity/dashboard'), { recursive: true });
  writeFileSync(dashboardPath, json, 'utf8');
  process.stdout.write(renderReport(census));
}

main();
