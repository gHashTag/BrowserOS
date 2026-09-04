#!/usr/bin/env node
//
// t27-migration-census.mjs — the migration surface, counted and ranked.
//
// Issue gHashTag/trios#1350, "The migration surface, counted: which files
// restate a rule a .t27 already carries" — the fresh filing of the question
// #1338 asked and lost to a send-back. What this census does:
//
//   - It counts .t27 specifications two ways and never sums them: the
//     distinct count (every .t27 in the trios tree) and the copied count
//     (.t27 files whose path runs through a .claude/worktrees/ directory —
//     agent-worktree copies of the specs tree, not distinct specifications).
//     The exclusion rule is printed verbatim so a later reader can see
//     exactly what was not counted (FR-001).
//   - For every distinct spec it reports whether a generated artifact for
//     that spec exists under a generation-output directory (gen/ or
//     generated/) within the spec's ring, and how many specs have none
//     (scenario 2). Under L0 generated files are artifacts, not hand-written
//     source, so they are never counted as source.
//   - It prints one row per directory under rings/ — source files, source
//     lines, spec files, and whether the ring has a generated target —
//     ranked by source lines descending, so the largest un-migrated surface
//     is the first row (scenario 3). Each row is built by ringSurface().
//
// What it deliberately does NOT do (FR-002): it never claims that any file
// is, or is not, a duplicate of a rule a .t27 already states. Deciding that
// a Swift or Rust file restates a spec is a judgement that belongs to a
// human. This tool counts and ranks, nothing more; no spec-to-source pairing
// is attempted or implied anywhere in its output.
//
// Determinism (FR-003): no timestamps, no hostname, no path from the machine
// the census ran on. Every path printed is relative to the trios root with
// forward slashes, and every list is sorted by ordinal string order. Two
// runs over an unedited tree produce byte-identical stdout and a
// byte-identical trios/.trinity/dashboard/t27-census.json.
//
// Runtime (FR-004): Node standard library only (node:fs, node:path,
// node:url). The trios root is derived from this script's own location, so
// the census runs identically as `node trios/tools/t27-migration-census.mjs`
// from the directory above trios/ or as
// `node tools/t27-migration-census.mjs` from the trios root, regardless of
// the working directory, and it reads nothing outside the trios tree.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const TRIOS_ROOT = dirname(dirname(SCRIPT_PATH)); // .../trios, contains tools/
const RINGS_DIR = join(TRIOS_ROOT, 'rings');
const DASHBOARD_PATH = join(TRIOS_ROOT, '.trinity', 'dashboard', 't27-census.json');
const DASHBOARD_LABEL = 'trios/.trinity/dashboard/t27-census.json';

// Directories the walk never enters. They hold no specifications and no
// hand-written ring source. Note that .claude/worktrees is NOT skipped: the
// copies under it must be found to be counted as copies.
const SKIPPED_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);

// Generation-output directory names. t27c emits under gen/ (L0: "Targets:
// t27c gen-rust (server), gen (Zig), gen-c, gen-verilog"); generated/ is
// accepted as the same convention under another name.
const GENERATED_DIRECTORY_NAMES = new Set(['gen', 'generated']);

// Hand-written code extensions: the languages a .t27 rule can be restated
// in, by hand, in this tree (Rust, Swift, TypeScript/JavaScript, C, Zig,
// Verilog). .t27 itself is counted separately as a spec, never as source.
const CODE_EXTENSIONS = new Set([
  '.rs', '.swift', '.ts', '.tsx', '.js', '.mjs', '.c', '.h', '.zig', '.v',
]);

// The rules below are single-sourced here and printed in both the stdout
// report and the dashboard JSON, so the numbers can never travel without
// the rule that produced them.
const COPY_EXCLUSION_RULE = [
  'A .t27 file whose path runs through a .claude/worktrees/ directory is a',
  'copy made by an agent worktree of the specs tree, not a distinct',
  'specification. Copies are excluded from the distinct count and reported',
  'separately as the copied count; the two numbers are never summed. The',
  'walk also skips .git and node_modules, which contain no specifications.',
].join(' ');

const GENERATED_ARTIFACT_RULE = [
  'A distinct spec <stem>.t27 has a generated artifact when a file named',
  '<stem>.<ext> exists under a directory named gen or generated within the',
  "spec's ring (the t27c output convention; under L0 generated files are",
  'artifacts, not hand-written source). A spec outside rings/ is scoped to',
  'its own directory. Artifact matches under .claude/worktrees/ are ignored,',
  'like all copies.',
].join(' ');

const SOURCE_FILE_RULE = [
  'A source file is a hand-written code file — extension .rs, .swift, .ts,',
  '.tsx, .js, .mjs, .c, .h, .zig or .v — inside the ring, excluding .t27',
  'specs (counted separately), generation output under gen/ or generated/,',
  'worktree copies under .claude/worktrees/, and the .git and node_modules',
  'directories. Source lines use wc -l semantics: one line per newline, plus',
  'one for a file whose final line is unterminated.',
].join(' ');

const RING_ROW_RULE = [
  'One row per directory under rings/. A ring has a generated target when',
  'its subtree contains a directory named gen or generated.',
].join(' ');

const RANKING_RULE = [
  'Rows are ranked by source lines descending, ties broken by ring name in',
  'ordinal order, so the largest un-migrated surface is the first row.',
].join(' ');

const NON_CLAIM = [
  'This census counts and ranks. It does not claim that any file is, or is',
  'not, a duplicate of a rule a .t27 already states; that judgement belongs',
  'to a human. No file-to-spec pairing is attempted or implied anywhere in',
  'this output.',
].join(' ');

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Ordinal (code-unit) comparison: independent of locale and ICU data. */
function byOrdinal(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Depth-first walk of the trios tree. Regular files only: symlinks are
 * neither followed nor reported, so the census can never read a path that
 * escapes the tree. Directories named in SKIPPED_DIRECTORY_NAMES are pruned.
 */
function walkTree(onFile) {
  const stack = [TRIOS_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => byOrdinal(a.name, b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink() && !SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
          stack.push(full);
        }
      } else if (entry.isFile()) {
        onFile(full);
      }
    }
  }
}

/** POSIX-style, trios-root-relative path for reporting. */
function reportPath(absolutePath) {
  return relative(TRIOS_ROOT, absolutePath).split(sep).join('/');
}

/** True when path segments run through a .claude/worktrees pair. */
function isCopyPath(segments) {
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] === '.claude' && segments[i + 1] === 'worktrees') return true;
  }
  return false;
}

/** Index of the first generation-output segment, or -1 when none. */
function generatedSegmentIndex(segments) {
  for (let i = 0; i < segments.length; i += 1) {
    if (GENERATED_DIRECTORY_NAMES.has(segments[i])) return i;
  }
  return -1;
}

/** The ring (directory under rings/) containing the segments, or null. */
function ringOfSegments(segments) {
  if (segments[0] === 'rings' && segments.length >= 3) return segments[1];
  return null;
}

/** wc -l semantics: one line per newline, plus one for an unterminated tail. */
function countLines(text) {
  if (text.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  if (text.charCodeAt(text.length - 1) !== 10) lines += 1;
  return lines;
}

function readFileLines(absolutePath) {
  return countLines(readFileSync(absolutePath, 'utf8'));
}

/** Filename without its final extension: the spec stem. */
function stemOf(fileName) {
  return fileName.slice(0, fileName.length - extname(fileName).length);
}

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

/**
 * Collect every .t27 in the trios tree, then split them into distinct
 * specifications and worktree copies. The naive count is kept as well: it is
 * the number a plain `find . -name '*.t27'` produces, copies included, and
 * printing it next to the split is how a reader reconciles this census with
 * a hand count. The two counts that matter are never summed.
 */
function collectSpecs() {
  const naive = [];
  const distinct = [];
  const copies = [];
  walkTree((absolutePath) => {
    if (!absolutePath.endsWith('.t27')) return;
    const rel = reportPath(absolutePath);
    naive.push(rel);
    const segments = rel.split('/');
    if (isCopyPath(segments)) {
      copies.push(rel);
      return;
    }
    distinct.push({
      path: rel,
      absolutePath,
      ring: ringOfSegments(segments),
      lines: readFileLines(absolutePath),
      artifacts: [],
    });
  });
  naive.sort(byOrdinal);
  copies.sort(byOrdinal);
  distinct.sort((a, b) => byOrdinal(a.path, b.path));
  return { naive, distinct, copies };
}

/**
 * Collect, per ring, the hand-written source files (for the ring table) and
 * the files under generation-output directories (to match generated
 * artifacts to specs). Copies are ignored for both: a copy of source or of a
 * generated artifact is machine state, not surface.
 */
function collectRingContents() {
  const ringSourceFiles = new Map(); // ring -> [{ path, lines }]
  const ringGeneratedFiles = new Map(); // ring -> [path]
  const ringsWithGeneratedDir = new Set(); // ring names
  const unringedGeneratedFiles = []; // generated files outside rings/
  walkTree((absolutePath) => {
    const rel = reportPath(absolutePath);
    const segments = rel.split('/');
    if (isCopyPath(segments)) return;
    const ring = ringOfSegments(segments);
    const genIndex = generatedSegmentIndex(segments);
    if (genIndex >= 0) {
      if (ring !== null) {
        const list = ringGeneratedFiles.get(ring) ?? [];
        list.push(rel);
        ringGeneratedFiles.set(ring, list);
        if (segments[genIndex + 1] !== undefined) {
          ringsWithGeneratedDir.add(ring);
        }
      } else {
        unringedGeneratedFiles.push(rel);
      }
      return; // generated output is never hand-written source
    }
    if (ring === null) return;
    if (!CODE_EXTENSIONS.has(extname(rel))) return;
    const list = ringSourceFiles.get(ring) ?? [];
    list.push({ path: rel, lines: readFileLines(absolutePath) });
    ringSourceFiles.set(ring, list);
  });
  for (const list of ringSourceFiles.values()) list.sort((a, b) => byOrdinal(a.path, b.path));
  for (const list of ringGeneratedFiles.values()) list.sort(byOrdinal);
  unringedGeneratedFiles.sort(byOrdinal);
  return { ringSourceFiles, ringGeneratedFiles, ringsWithGeneratedDir, unringedGeneratedFiles };
}

/**
 * Attach generated artifacts to distinct specs per GENERATED_ARTIFACT_RULE:
 * a file under a gen/generated directory, inside the spec's ring (or, for a
 * spec outside rings/, inside the spec's own directory), whose basename stem
 * equals the spec's stem. Matching is by generated artifact only — it says
 * the compiler has run for this spec; it says nothing about hand-written
 * files, which this census does not judge (FR-002).
 */
function attachGeneratedArtifacts(specs, ringContents) {
  for (const spec of specs) {
    const stem = stemOf(basename(spec.path));
    if (spec.ring !== null) {
      const candidates = ringContents.ringGeneratedFiles.get(spec.ring) ?? [];
      spec.artifacts = candidates.filter((p) => stemOf(basename(p)) === stem);
    } else {
      const scope = dirname(spec.path);
      spec.artifacts = ringContents.unringedGeneratedFiles.filter(
        (p) => p.startsWith(`${scope}/`) && stemOf(basename(p)) === stem,
      );
    }
  }
}

/**
 * The surface of one ring, as a single ranked-table row: how many hand-
 * written source files it holds, how many lines they span, how many
 * distinct .t27 specs live in it, and whether it has a generated target.
 * This is counting, not judging: nothing here says any source file restates
 * any spec (FR-002).
 */
function ringSurface(ringName, sourceFiles, specFiles, generatedTarget) {
  let sourceLines = 0;
  for (const file of sourceFiles) sourceLines += file.lines;
  return {
    ring: ringName,
    sourceFiles: sourceFiles.length,
    sourceLines,
    specFiles,
    generatedTarget,
  };
}

/** Every directory under rings/, in ordinal order — one table row each. */
function ringNames() {
  const entries = readdirSync(RINGS_DIR, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name);
  names.sort(byOrdinal);
  return names;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function wrapRule(text, indent) {
  const width = 78 - indent.length;
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.map((l) => indent + l);
}

function buildStdoutReport(census) {
  const { specs, naive, copies, rings } = census;
  const withArtifact = specs.filter((s) => s.artifacts.length > 0);
  const withoutArtifact = specs.filter((s) => s.artifacts.length === 0);

  const lines = [];
  lines.push('t27 migration census - gHashTag/trios#1350');
  lines.push('===========================================');
  lines.push('Scope: the trios tree, located from this script\'s own position');
  lines.push('(trios/tools/); nothing outside the trios tree is read (FR-004).');
  lines.push('Every path below is relative to the trios root; no timestamp,');
  lines.push('hostname or machine path appears in this output (FR-003).');
  lines.push('');
  lines.push('Copy exclusion rule (FR-001)');
  lines.push(...wrapRule(COPY_EXCLUSION_RULE, '  '));
  lines.push('');
  lines.push('.t27 specification counts');
  lines.push(`  distinct specs: ${specs.length}`);
  lines.push(`  copied specs:   ${copies.length}`);
  lines.push(`  naive find:     ${naive.length}  (what find . -name '*.t27' reports, copies included)`);
  lines.push('  The distinct count and the copied count are two separate numbers');
  lines.push('  and are never summed. For reference, the filing of this issue');
  lines.push('  recorded 164 naive paths on the tree it was filed from, of which 94');
  lines.push('  were copies under rings/RUST-13/trios-mesh/.claude/worktrees/,');
  lines.push('  leaving the same 70 distinct specifications. Copies are untracked');
  lines.push('  agent-worktree state, so the copied count varies by machine and by');
  lines.push('  day; the distinct count does not.');
  lines.push('');
  lines.push('Generated artifacts per distinct spec');
  lines.push(...wrapRule(GENERATED_ARTIFACT_RULE, '  '));
  lines.push(`  specs with a generated artifact: ${withArtifact.length}`);
  lines.push(`  specs with none:                ${withoutArtifact.length}`);
  lines.push('');
  const pathWidth = Math.max(...specs.map((s) => s.path.length), 'spec'.length);
  for (const spec of specs) {
    const mark = spec.artifacts.length > 0 ? 'artifact: yes' : 'artifact: none';
    lines.push(`  ${spec.path.padEnd(pathWidth)}  ${mark}`);
  }
  lines.push('');
  lines.push('Ring surface, ranked by source lines descending');
  lines.push(...wrapRule(SOURCE_FILE_RULE, '  '));
  lines.push(...wrapRule(RING_ROW_RULE, '  '));
  lines.push(...wrapRule(RANKING_RULE, '  '));
  lines.push('');
  const columns = [
    ['ring', (row) => row.ring, 'padEnd'],
    ['source files', (row) => String(row.sourceFiles), 'padStart'],
    ['source lines', (row) => String(row.sourceLines), 'padStart'],
    ['spec files', (row) => String(row.specFiles), 'padStart'],
    ['generated target', (row) => (row.generatedTarget ? 'yes' : 'no'), 'padEnd'],
  ];
  const widths = columns.map(([title, get]) =>
    Math.max(title.length, ...rings.map((row) => get(row).length)),
  );
  const header = columns
    .map(([title], i) =>
      i === columns.length - 1
        ? title
        : columns[i][2] === 'padStart'
          ? title.padStart(widths[i])
          : title.padEnd(widths[i]),
    )
    .join('  ');
  lines.push(`  ${header}`);
  for (const row of rings) {
    const cells = columns.map(
      ([, get], i) =>
        i === columns.length - 1
          ? get(row)
          : columns[i][2] === 'padStart'
            ? get(row).padStart(widths[i])
            : get(row).padEnd(widths[i]),
    );
    lines.push(`  ${cells.join('  ')}`);
  }
  lines.push('');
  lines.push('What this census does not decide (FR-002)');
  lines.push(...wrapRule(NON_CLAIM, '  '));
  lines.push('');
  lines.push(`wrote ${DASHBOARD_LABEL} (byte-identical on every re-run over an unedited tree)`);
  return lines.join('\n');
}

function buildDashboardJson(census) {
  const { specs, naive, copies, rings } = census;
  const withArtifact = specs.filter((s) => s.artifacts.length > 0).length;
  return {
    census: 't27-migration-census',
    issue: 'gHashTag/trios#1350',
    scope: 'the trios tree; every path is trios-root-relative and POSIX-style',
    rules: {
      copyExclusion: COPY_EXCLUSION_RULE,
      skippedDirectories: [...SKIPPED_DIRECTORY_NAMES].sort(byOrdinal),
      generatedArtifact: GENERATED_ARTIFACT_RULE,
      sourceFile: SOURCE_FILE_RULE,
      ringRow: RING_ROW_RULE,
      ranking: RANKING_RULE,
      nonClaim: NON_CLAIM,
    },
    specCounts: {
      naiveFindCount: naive.length,
      distinctCount: specs.length,
      copiedCount: copies.length,
      neverSummed: true,
      withGeneratedArtifact: withArtifact,
      withoutGeneratedArtifact: specs.length - withArtifact,
    },
    specs: specs.map((spec) => ({
      path: spec.path,
      lines: spec.lines,
      ring: spec.ring,
      generatedArtifact: spec.artifacts.length > 0,
      artifacts: spec.artifacts,
    })),
    ringSurface: rings,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const { naive, distinct, copies } = collectSpecs();
  const ringContents = collectRingContents();
  attachGeneratedArtifacts(distinct, ringContents);

  const specCountByRing = new Map();
  for (const spec of distinct) {
    if (spec.ring === null) continue;
    specCountByRing.set(spec.ring, (specCountByRing.get(spec.ring) ?? 0) + 1);
  }

  const rings = ringNames().map((name) =>
    ringSurface(
      name,
      ringContents.ringSourceFiles.get(name) ?? [],
      specCountByRing.get(name) ?? 0,
      ringContents.ringsWithGeneratedDir.has(name),
    ),
  );
  rings.sort((a, b) => b.sourceLines - a.sourceLines || byOrdinal(a.ring, b.ring));

  const census = { specs: distinct, naive, copies, rings };
  console.log(buildStdoutReport(census));
  mkdirSync(dirname(DASHBOARD_PATH), { recursive: true });
  writeFileSync(DASHBOARD_PATH, `${JSON.stringify(buildDashboardJson(census), null, 2)}\n`);
}

main();
