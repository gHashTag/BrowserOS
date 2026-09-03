#!/usr/bin/env node
// t27-spec-inventory.mjs - count the *.t27 specs the t27-lowering gate can see.
//
// Why this instrument exists (gHashTag/trios#1391). The gate enumerates specs
// with, at trios/Makefile:1156-1157,
//
//     find "$(ROOT)/rings" -name '*.t27' \
//         -not -path '*/.worktrees/*' -not -path '*/.claude/*'
//
// ROOT is absolute (trios/Makefile:16), so both -not -path tests run against
// the ABSOLUTE spec path. The deployed dispatcher puts every bee worktree
// under a .worktrees directory (agent-server/apps/server/src/api/services/
// queen-dispatch.ts:375-377), so for exactly those checkouts the filter
// excludes the whole tree: the loop body never runs, tot stays 0, and the
// recipe still takes its success branch (trios/Makefile:1218-1226) and
// reports OK over a tree it never looked at. The sibling gate states the
// opposite rule in tests/t27/ring00_parity.sh:44-46: "Empty is never green."
//
// What this tool does differently:
//   - the .worktrees and .claude exclusions are applied to each spec's path
//     RELATIVE to the rings root, so a checkout that itself lives under
//     .worktrees is counted, while a nested copy such as
//     rings/RUST-13/trios-mesh/.claude/worktrees/<name>/specs stays excluded;
//   - a spec under a directory that carries its own .git marker (an
//     initialized submodule such as rings/RUST-13/trios-mesh, or a nested
//     clone) is counted as submodule, not owned, because this repository
//     cannot land edits there. An uninitialized submodule is an empty
//     directory and simply contributes nothing. The split is discovered from
//     the filesystem at run time; no owner list lives in this file;
//   - T27_NOCOMPILE_CEILING is read out of the Makefile text in the same
//     checkout, never remembered here;
//   - a measurement of zero specs is reported as a failure, never as a pass.
//
// The tool never writes to the Makefile and never wires itself into check:
// it prints trios/Makefile:1157 so that wiring stays a separate, reviewed
// change with the instrument already in hand. Node standard library only:
// no dependency, no package.json, and no make / t27c / rustc / cargo / swift
// / python3 - none of those exist in the worker container this runs in.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The gate's two exclusions, kept for their original purpose: they exist to
// skip nested checkouts left inside the rings tree (the Makefile comment at
// trios/Makefile:1150-1154 records one that made the first version of the
// gate scan 138 specs instead of 70). Here they are tested against path
// segments RELATIVE to the rings root, never against the absolute path.
const EXCLUDED_SEGMENTS = new Set(['.worktrees', '.claude']);

function isExcludedRelative(relPath) {
  return relPath.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

// Does this directory carry its own repository marker? Such a directory under
// the rings tree is a separate repository - an initialized submodule or a
// nested clone - and this repository cannot land edits to specs inside it.
function isSeparateRepository(dirPath) {
  return existsSync(join(dirPath, '.git'));
}

// Walk the rings tree and return every *.t27 path relative to the rings root,
// split into counted specs and excluded (nested-copy) specs. Directory
// entries are visited in name order, mirroring the gate's `| sort`, and
// symbolic links are never followed, mirroring find's default.
function walkRings(ringsRoot) {
  const counted = [];
  const excluded = [];
  const walk = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else if (entry.name.endsWith('.t27')) {
        if (isExcludedRelative(rel)) excluded.push(rel);
        else counted.push(rel);
      }
    }
  };
  walk(ringsRoot, '');
  return { counted, excluded };
}

// Read the nocompile ceiling out of the Makefile text, keyed by the
// variable's name; a later assignment wins, as in make itself. Returns null
// when the file or the assignment is absent.
function readNocompileCeiling(makefilePath) {
  if (!existsSync(makefilePath)) return null;
  const text = readFileSync(makefilePath, 'utf8');
  let ceiling = null;
  for (const line of text.split('\n')) {
    const match = /^[ \t]*T27_NOCOMPILE_CEILING[ \t]*[:+?]?=[ \t]*([0-9]+)/.exec(line);
    if (match) ceiling = Number.parseInt(match[1], 10);
  }
  return ceiling;
}

// Measure one rings tree. Every number in the result is derived here, at run
// time: spec counts by walking the filesystem, the owned/submodule split by
// looking for separate repositories under the rings root, and the ceiling by
// reading the Makefile text. Nothing is cached or hard-coded.
export function t27SpecInventory({ ringsRoot, repoRoot, makefilePath }) {
  const { counted, excluded } = walkRings(ringsRoot);

  const ownedSpecs = [];
  const submoduleSpecs = [];
  for (const rel of counted) {
    const segments = rel.split('/');
    let separate = false;
    let dir = ringsRoot;
    for (let i = 0; i < segments.length - 1; i += 1) {
      dir = join(dir, segments[i]);
      if (isSeparateRepository(dir)) {
        separate = true;
        break;
      }
    }
    if (separate) submoduleSpecs.push(rel);
    else ownedSpecs.push(rel);
  }

  return {
    ringsRoot,
    repoRoot,
    makefilePath,
    ownedSpecs,
    submoduleSpecs,
    excludedSpecs: excluded,
    owned: ownedSpecs.length,
    submodule: submoduleSpecs.length,
    total: ownedSpecs.length + submoduleSpecs.length,
    ceiling: readNocompileCeiling(makefilePath),
  };
}

function formatReport(result) {
  const lines = [];
  lines.push(`rings root: ${result.ringsRoot}`);
  lines.push("exclusions: the gate's */.worktrees/* and */.claude/* filters, applied to the path");
  lines.push('            RELATIVE to the rings root. At trios/Makefile:1157 they are applied to the');
  lines.push('            ABSOLUTE path, so a checkout that itself lives under .worktrees measures');
  lines.push('            0 specs there while this tool measures the same tree.');
  for (const rel of result.ownedSpecs) lines.push(`counted (owned): ${rel}`);
  for (const rel of result.submoduleSpecs) lines.push(`counted (submodule): ${rel}`);
  for (const rel of result.excludedSpecs) lines.push(`excluded (nested copy): ${rel}`);
  lines.push(`owned specs: ${result.owned}`);
  lines.push(`submodule specs: ${result.submodule}`);
  lines.push(`total specs: ${result.total}`);
  if (result.ceiling === null) {
    lines.push(`nocompile ceiling: not found (no T27_NOCOMPILE_CEILING assignment in ${result.makefilePath})`);
  } else {
    lines.push(`nocompile ceiling: ${result.ceiling}`);
  }
  if (result.total === 0) {
    lines.push(`[FAIL] an empty measurement is not a pass: 0 specs counted under ${result.ringsRoot}.`);
    lines.push('       Nothing was measured, so nothing may be reported as surviving lowering.');
    lines.push('       tests/t27/ring00_parity.sh:44-46 states the same rule for its own gate:');
    lines.push('       "Empty is never green." This is the shape of the defect recorded at');
    lines.push('       trios/Makefile:1157: there, a checkout under .worktrees measures 0 specs and');
    lines.push('       the t27-lowering recipe still reports success over a tree it never looked');
    lines.push('       at, with tot=0 feeding the same success branch.');
  }
  return lines;
}

// --selftest. Builds a fixture under a temporary directory whose path
// contains a .worktrees component - the layout the dispatcher gives a bee,
// and the layout that makes the Makefile's absolute-path filter measure
// nothing - runs this script as a subprocess against it, asserts the counts,
// then empties the fixture and asserts the failure. The fixture lives
// entirely under the temporary directory: nothing inside this repository's
// rings tree is created, moved, or deleted, and the directory is removed
// before the process exits, whatever the assertions found.
function runSelftest() {
  const problems = [];
  const check = (ok, what) => {
    if (!ok) problems.push(what);
  };
  const base = mkdtempSync(join(tmpdir(), 't27-spec-inventory-selftest-'));
  const repo = join(base, '.worktrees', 'queen-selftest', 'repo');
  const rings = join(repo, 'rings');
  const self = fileURLToPath(import.meta.url);

  try {
    check(repo.split(sep).includes('.worktrees'), 'fixture repo path must contain a .worktrees component');

    mkdirSync(join(rings, 'T27-00'), { recursive: true });
    mkdirSync(join(rings, 'RUST-13', 'trios-mesh', '.claude', 'worktrees', 'x'), { recursive: true });
    writeFileSync(join(repo, 'Makefile'), '# selftest fixture makefile\nT27_NOCOMPILE_CEILING := 42\n');
    // An initialized submodule carries its own .git marker; that marker is
    // what separates submodule specs from owned specs at run time.
    writeFileSync(join(rings, 'RUST-13', 'trios-mesh', '.git'), 'gitdir: ../../.git/modules/rings/RUST-13/trios-mesh\n');
    writeFileSync(join(rings, 'T27-00', 'selftest-owned.t27'), 'selftest owned spec\n');
    writeFileSync(join(rings, 'RUST-13', 'trios-mesh', 'selftest-submodule.t27'), 'selftest submodule spec\n');
    writeFileSync(join(rings, 'RUST-13', 'trios-mesh', '.claude', 'worktrees', 'x', 'selftest-decoy.t27'), 'selftest decoy spec\n');

    const runTool = (args) => spawnSync(process.execPath, [self, ...args], { encoding: 'utf8' });

    const populated = runTool(['--repo', repo]);
    check(populated.status === 0, `populated fixture: expected exit 0, got ${populated.status}${populated.stderr ? ` (${String(populated.stderr).trim()})` : ''}`);
    const out = populated.stdout || '';
    check(/^owned specs: 1$/m.test(out), 'populated fixture: expected "owned specs: 1"');
    check(/^submodule specs: 1$/m.test(out), 'populated fixture: expected "submodule specs: 1"');
    check(/^total specs: 2$/m.test(out), 'populated fixture: expected "total specs: 2" despite the .worktrees component in the root path');
    check(/^nocompile ceiling: 42$/m.test(out), 'populated fixture: expected "nocompile ceiling: 42" read from the fixture Makefile');
    check(out.includes('counted (owned): T27-00/selftest-owned.t27'), 'populated fixture: the owned spec was not listed as counted');
    check(out.includes('counted (submodule): RUST-13/trios-mesh/selftest-submodule.t27'), 'populated fixture: the submodule spec was not listed as counted');
    check(out.includes('excluded (nested copy): RUST-13/trios-mesh/.claude/worktrees/x/selftest-decoy.t27'), 'populated fixture: the decoy under .claude/worktrees was not reported as excluded');

    // Empty the tree of real specs (the decoy stays, still excluded) and
    // require the failure: empty is never green.
    rmSync(join(rings, 'T27-00', 'selftest-owned.t27'));
    rmSync(join(rings, 'RUST-13', 'trios-mesh', 'selftest-submodule.t27'));
    const emptied = runTool(['--repo', repo]);
    check(emptied.status !== 0, `emptied fixture: expected a non-zero exit, got ${emptied.status}`);
    const out2 = emptied.stdout || '';
    check(/^total specs: 0$/m.test(out2), 'emptied fixture: expected "total specs: 0"');
    check(out2.includes('an empty measurement is not a pass'), 'emptied fixture: expected the sentence "an empty measurement is not a pass"');
    check(!out2.includes('[OK]'), 'emptied fixture: output must not contain "[OK]"; a zero count may not be reported through a word that reads as success');
  } catch (err) {
    problems.push(`selftest crashed: ${err instanceof Error ? err.stack : String(err)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`[FAIL] selftest: ${problem}`);
    return 1;
  }
  console.log(`selftest: fixture built under ${dirname(repo)} (root path contains a .worktrees component)`);
  console.log('selftest: populated tree -> owned=1 submodule=1 total=2, decoy under .claude/worktrees excluded, ceiling 42 read from the fixture Makefile');
  console.log('selftest: emptied tree -> non-zero exit with "an empty measurement is not a pass" and no success wording');
  console.log('[OK] selftest');
  return 0;
}

const USAGE = `usage: node tools/t27-spec-inventory.mjs [--selftest] [--repo <dir>] [--rings <dir>] [--makefile <file>]

Counts the *.t27 specs under the rings tree and prints owned / submodule /
total plus the T27_NOCOMPILE_CEILING value read from the Makefile. The
.worktrees and .claude exclusions are applied to paths relative to the rings
root, so a checkout that itself lives under .worktrees is measured. Exits
non-zero when the measurement is empty: an empty measurement is not a pass.
--selftest builds a throwaway fixture under a temporary .worktrees path,
asserts the counts, asserts the empty-tree failure, and removes the fixture.`;

function parseArgs(argv) {
  const opts = { selftest: false, help: false, repo: null, rings: null, makefile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--selftest') {
      opts.selftest = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--repo' || arg === '--rings' || arg === '--makefile') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      if (arg === '--repo') opts.repo = next;
      else if (arg === '--rings') opts.rings = next;
      else opts.makefile = next;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

// A directory that holds both rings/ and Makefile is the repository root as
// far as this tool is concerned. Searched from the script's own location so
// the measurement does not depend on the caller's working directory.
function findRepoRoot(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'rings')) && existsSync(join(dir, 'Makefile'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[FAIL] ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.selftest) return runSelftest();

  const repoRoot = opts.repo
    || findRepoRoot(dirname(fileURLToPath(import.meta.url)))
    || findRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error('[FAIL] cannot find the repository root (a directory holding both rings/ and Makefile); pass --repo <dir>');
    return 2;
  }
  const ringsRoot = opts.rings || join(repoRoot, 'rings');
  if (!existsSync(ringsRoot)) {
    console.error(`[FAIL] no rings tree at ${ringsRoot}`);
    return 2;
  }
  const makefilePath = opts.makefile || join(repoRoot, 'Makefile');

  const result = t27SpecInventory({ ringsRoot, repoRoot, makefilePath });
  for (const line of formatReport(result)) console.log(line);
  return result.total === 0 ? 1 : 0;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
