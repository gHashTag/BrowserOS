#!/usr/bin/env node
// t27-migration-ledger.mjs — measure the distance between the law and the tree.
//
// L0 in CLAUDE.md states the law: everything below the interface is written in
// `.t27` and generated to its target. This script does not assert the law and
// does not assert progress toward it — it counts. Every number in the ledger
// it emits is read from the files at the moment it runs.
//
// What it walks:
//   - `rings/` for `*.t27` (the spec sources), skipping `.claude` directories,
//     which is where stale worktree copies hide — a count that does not
//     exclude worktrees is a count that flatters itself.
//   - `agent-server/queen-core/Sources/` for `*.swift` (the hand-written
//     decision core that RING-00 restates).
//
// What it emits: one markdown table row per trunk ring (T27-00 .. T27-04,
// the ring order), plus a per-ring breakdown, plus the provenance (ISO date
// and git commit, both read from the environment). Rings whose generated-file
// count is zero are marked "not yet generated" because the count said so.
//
// Constraints honoured here:
//   - Runs under `node` with nothing outside the Node standard library,
//     because the worker image has no python3.
//   - Reads and writes nothing outside this repository (no /Users/playra/t27,
//     no absolute paths, no exceptions). Every path passes `insideRepo`.
//
// Regenerate: node tools/t27-migration-ledger.mjs (from the repository root),
// or `node trios/tools/t27-migration-ledger.mjs` from the directory that
// contains this repository. The script finds its own root, so the working
// directory does not matter.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Repository root, derived from this file's own location.
// ---------------------------------------------------------------------------

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');

// FR-003: refuse to touch anything outside this repository. Every read and
// write in this script goes through this guard.
function insideRepo(relativePath) {
  const resolved = path.resolve(repoRoot, relativePath);
  const relative = path.relative(repoRoot, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to touch a path outside the repository: ${relativePath}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Counting primitives.
// ---------------------------------------------------------------------------

// A line count with `wc -l` semantics: newline characters, plus one if the
// file ends without a trailing newline. Files that end in a newline count
// identically to `wc -l`, which is how the epic's own numbers were measured.
function countLines(absolutePath) {
  const content = fs.readFileSync(absolutePath, 'utf8');
  if (content === '') return 0;
  const newlines = content.split('\n').length - 1;
  return content.endsWith('\n') ? newlines : newlines + 1;
}

// Directory names never descended into. `.claude` holds worktrees, where
// stale copies of specifications go to be counted twice.
const SKIPPED_DIRECTORIES = new Set(['.claude', '.git', '.worktrees', 'node_modules']);

// Recursively collect files under a directory inside the repository. Returns
// absolute paths; `onSkippedWorktree` receives `.t27` files found inside a
// skipped `.claude` worktree, so the exclusion is itself counted, not silent.
function walkFiles(relativeDir, { onSkippedWorktree = () => {} } = {}) {
  const absoluteDir = insideRepo(relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const child = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        // Still surface `.t27` copies hiding in worktrees, as a count.
        if (entry.name === '.claude') {
          collectT27InWorktree(child, onSkippedWorktree);
        }
        continue;
      }
      found.push(...walkFiles(path.relative(repoRoot, child), { onSkippedWorktree }));
    } else if (entry.isFile()) {
      found.push(child);
    }
  }
  return found;
}

function collectT27InWorktree(absoluteDir, onSkippedWorktree) {
  if (!fs.existsSync(absoluteDir)) return;
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const child = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      collectT27InWorktree(child, onSkippedWorktree);
    } else if (entry.isFile() && entry.name.endsWith('.t27')) {
      onSkippedWorktree(child);
    }
  }
}

const relativeToRoot = (absolutePath) => path.relative(repoRoot, absolutePath);

// ---------------------------------------------------------------------------
// The walks FR-001 names: `rings/` for *.t27, queen-core Sources for *.swift.
// ---------------------------------------------------------------------------

const worktreeT27Copies = [];
const allFilesUnderRings = walkFiles('rings', {
  onSkippedWorktree: (p) => worktreeT27Copies.push(p),
});
const t27FilesUnderRings = allFilesUnderRings.filter((p) => p.endsWith('.t27'));

const swiftFilesUnderQueenCore = walkFiles('agent-server/queen-core/Sources').filter((p) =>
  p.endsWith('.swift'),
);

// Spec sources grouped by the ring directory that holds them
// (`rings/T27-00/queen_core.t27` belongs to ring `T27-00`).
const specFilesByRing = new Map();
for (const file of t27FilesUnderRings) {
  const segments = relativeToRoot(file).split(path.sep);
  if (segments.length < 3 || segments[0] !== 'rings') continue;
  const ring = segments[1];
  if (!specFilesByRing.has(ring)) specFilesByRing.set(ring, []);
  specFilesByRing.get(ring).push(file);
}

// Generated files for a ring: everything under its ring directory that is not
// a `.t27` spec. When the compiler runs, its output lands here and the count
// stops being zero — by counting, not by flipping a flag.
function generatedFilesForRing(ring) {
  const specs = specFilesByRing.get(ring) || [];
  const ringDir = insideRepo(path.join('rings', ring));
  if (!fs.existsSync(ringDir)) return { files: [], specs };
  const everything = walkFiles(path.join('rings', ring));
  return { files: everything.filter((p) => !p.endsWith('.t27')), specs };
}

// ---------------------------------------------------------------------------
// The five trunk rings, in ring order (the epic's own table). The twins are
// the hand-written files that implement the same rule today; each one is
// counted from disk below, never typed.
// ---------------------------------------------------------------------------

const queenPolicySwift = swiftFilesUnderQueenCore.filter((p) =>
  relativeToRoot(p).startsWith(path.join('agent-server', 'queen-core', 'Sources', 'QueenPolicy')),
);

const RINGS = [
  {
    ring: 'T27-00',
    what: 'decision core: retry, review, merge gate, capacity',
    // The Swift the Dockerfile actually builds; summed over every `*.swift`
    // under QueenPolicy, found by the walk above rather than listed by hand.
    twins: queenPolicySwift,
  },
  {
    ring: 'T27-01',
    what: 'A2A protocol',
    // The contract the spec header itself names as already running: the nine
    // routes, the `agents` table, and the Swift client.
    twins: [
      'agent-server/apps/server/src/api/routes/a2a.ts',
      'agent-server/apps/server/src/api/services/a2a/pg-agent-store.ts',
      'rings/SR-02/A2ARegistryClient.swift',
    ].map((p) => insideRepo(p)),
  },
  {
    ring: 'T27-02',
    what: 'orchestration: the Queen\u2019s tick',
    twins: [insideRepo('agent-server/apps/server/src/api/services/queen-tick.ts')],
  },
  {
    ring: 'T27-03',
    what: 'transport: SSE',
    twins: [insideRepo('rings/SR-01/SSETransport.swift')],
  },
  {
    ring: 'T27-04',
    what: 'scoring: salience, reliability, latency',
    twins: [insideRepo('agent-server/queen-core/Sources/QueenPolicy/QueenSalience.swift')],
  },
];

// ---------------------------------------------------------------------------
// Row assembly. One row per ring, every number counted.
// ---------------------------------------------------------------------------

function sumLines(absolutePaths) {
  let total = 0;
  for (const p of absolutePaths) {
    if (fs.existsSync(p)) total += countLines(p);
  }
  return total;
}

// The one function the success criteria name: turn a ring's counted numbers
// into its markdown table row. Zero generated files is marked "not yet
// generated" here and nowhere else — the mark is a consequence of the count.
function migrationRow({ ring, specLines, specCount, handwrittenLines, generatedCount }) {
  const specCell = specCount === 0 ? '0 (no .t27 in tree)' : String(specLines);
  const generatedCell =
    generatedCount === 0 ? '0 (not yet generated)' : String(generatedCount);
  return `| ${ring} | ${specCell} | ${handwrittenLines} | ${generatedCell} |`;
}

const rows = RINGS.map((entry) => {
  const { files: generatedFiles, specs } = generatedFilesForRing(entry.ring);
  const specLines = sumLines(specs);
  const present = entry.twins.filter((p) => fs.existsSync(p));
  const handwrittenLines = sumLines(present);
  return {
    entry,
    specs,
    generatedFiles,
    specLines,
    specCount: specs.length,
    handwrittenLines,
    missingTwins: entry.twins.filter((p) => !fs.existsSync(p)),
    row: migrationRow({
      ring: entry.ring,
      specLines,
      specCount: specs.length,
      handwrittenLines,
      generatedCount: generatedFiles.length,
    }),
  };
});

// ---------------------------------------------------------------------------
// Provenance, read from the environment rather than typed.
// ---------------------------------------------------------------------------

const generatedAtIso = new Date().toISOString();

function shortCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    return `unknown (git rev-parse failed: ${error.message.split('\n')[0]})`;
  }
}
const commit = shortCommit();

// ---------------------------------------------------------------------------
// The ledger.
// ---------------------------------------------------------------------------

const lines = [];
lines.push('# T27 migration ledger');
lines.push('');
lines.push(
  'L0 states the law: everything below the interface is written in `.t27` and',
);
lines.push(
  'generated to its target. This ledger measures the distance between that law',
);
lines.push(
  'and this tree. Every number below was counted from the files at generation',
);
lines.push('time — nothing here is typed, retyped, or carried over by hand.');
lines.push('');
lines.push(`- Generated: \`${generatedAtIso}\``);
lines.push(`- Commit: \`${commit}\` (\`git rev-parse --short HEAD\`)`);
lines.push(
  '- Regenerate: `node tools/t27-migration-ledger.mjs` from the repository root,',
);
lines.push(
  '  or `node trios/tools/t27-migration-ledger.mjs` from the directory that',
);
lines.push('  contains this repository.');
lines.push('');
lines.push('## The migration surface');
lines.push('');
lines.push('| ring | spec lines | hand-written lines | generated files |');
lines.push('| --- | --- | --- | --- |');
for (const r of rows) lines.push(r.row);
lines.push('');
lines.push(
  '`spec lines` — total lines of every `*.t27` under `rings/<ring>/`. A ring',
);
lines.push(
  'showing `0 (no .t27 in tree)` has no specification in this tree yet; the',
);
lines.push(
  'walk found none, which is a count, not an assertion. `hand-written lines` —',
);
lines.push(
  'total lines of the files that implement the same rule by hand today, summed',
);
lines.push(
  'per ring in the breakdown below. `generated files` — every file under',
);
lines.push(
  '`rings/<ring>/` that is not a `.t27` spec, i.e. what the compiler would have',
);
lines.push(
  'emitted there. A ring showing `0 (not yet generated)` is marked so because',
);
lines.push('the count came back zero.');
lines.push('');
lines.push('## Per-ring breakdown');
for (const r of rows) {
  lines.push('');
  lines.push(`### ${r.entry.ring} — ${r.entry.what}`);
  lines.push('');
  if (r.specs.length === 0) {
    lines.push(`- Spec: none found under \`rings/${r.entry.ring}/\`.`);
  } else {
    for (const spec of r.specs) {
      lines.push(`- Spec: \`${relativeToRoot(spec)}\` — ${countLines(spec)} lines`);
    }
  }
  if (r.entry.twins.length === 0) {
    lines.push('- Hand-written twins: none declared.');
  } else {
    lines.push(`- Hand-written twins (${r.handwrittenLines} lines total):`);
    for (const twin of r.entry.twins) {
      if (fs.existsSync(twin)) {
        lines.push(`  - \`${relativeToRoot(twin)}\` — ${countLines(twin)} lines`);
      } else {
        lines.push(`  - \`${relativeToRoot(twin)}\` — absent from this tree`);
      }
    }
  }
  if (r.generatedFiles.length === 0) {
    lines.push(
      `- Generated files under \`rings/${r.entry.ring}/\`: 0 — not yet generated.`,
    );
  } else {
    lines.push(`- Generated files under \`rings/${r.entry.ring}/\` (${r.generatedFiles.length}):`);
    for (const generated of r.generatedFiles) {
      lines.push(`  - \`${relativeToRoot(generated)}\``);
    }
  }
}

lines.push('');
lines.push('## Counts, not assertions');
lines.push('');
lines.push(
  '`.t27` files found under `rings/`, excluding copies inside `.claude`',
);
lines.push(
  'worktree directories — the exclusion the quotable number forgot, applied',
);
lines.push('here by rule and counted here again:');
lines.push('');
lines.push(`- Walked and counted: ${t27FilesUnderRings.length} \`.t27\` file(s).`);
lines.push(
  `- Excluded as stale worktree copies (inside \`.claude\`): ${worktreeT27Copies.length}.`,
);
lines.push(
  `- Rings of the trunk with a \`.t27\` source: ${
    RINGS.filter((r) => (specFilesByRing.get(r.ring) || []).length > 0).length
  } of ${RINGS.length}.`,
);
lines.push(
  `- Generated files across every trunk ring: ${rows.reduce(
    (total, r) => total + r.generatedFiles.length,
    0,
  )}.`,
);
lines.push('');
lines.push(
  'The hand-written twin of the decision core is Swift, not Rust: the Dockerfile',
);
lines.push(
  'builds `queend` from `agent-server/queen-core/Sources/` and the TypeScript',
);
lines.push(
  'asks it every decision over stdin. The distance this ledger measures is the',
);
lines.push('gap between those Swift files and the `.t27` that restates them.');
lines.push('');

const ledgerPath = insideRepo(path.join('docs', 't27-migration-ledger.md'));
fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
fs.writeFileSync(ledgerPath, lines.join('\n'), 'utf8');

process.stdout.write(`t27-migration-ledger: wrote ${relativeToRoot(ledgerPath)}\n`);
for (const r of rows) {
  process.stdout.write(`${r.row}\n`);
}
