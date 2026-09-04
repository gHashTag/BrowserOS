#!/usr/bin/env node
/**
 * Unlanded work inventory - gHashTag/trios#1359
 *
 * Lists every `queen-*` branch in this repository, compares it against a base
 * ref, checks the remote with `git ls-remote`, and reports which branches
 * carry work that has never reached the remote. The point is to make
 * invisible finished work visible, countable and rankable.
 *
 * Contract (from the issue):
 *   FR-001  Read-only. This script pushes, merges, deletes and modifies
 *           nothing. It only runs git reads: rev-parse, for-each-ref, log,
 *           diff --numstat, ls-remote and config --get-regexp.
 *   FR-002  Remote state comes from `git ls-remote`. If that call fails for a
 *           branch, the branch is reported as `unknown` - never `stranded`,
 *           never `landed`. A network failure must not read as a finding.
 *   FR-003  The base is a parameter with a stated default
 *           (feat/queen-supervisor) and the base actually used is printed
 *           with the report.
 *   FR-004  Issue state (open/closed) is read from a file the caller supplies
 *           with --issues-file. Nothing here talks to GitHub.
 *   FR-005  Node standard library only, shelling out to git. Works from a
 *           worktree: the repository root is resolved with
 *           `git rev-parse --show-toplevel`.
 *   FR-006  Every git command this script runs is printed with the report, so
 *           the numbers can be re-derived by hand.
 *
 * Usage: node trios/tools/unlanded-work-inventory.mjs
 *               [--base <ref>] [--pattern <glob>] [--remote <name>]
 *               [--issues-file <path>] [--selftest] [-h|--help]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE = 'feat/queen-supervisor';
const DEFAULT_PATTERN = 'queen-*';
const DEFAULT_REMOTE = 'origin';

/** Wraps `git`; records every invocation in a journal (FR-006). */
class Git {
  constructor(cwd, journal) {
    this.cwd = cwd;
    this.journal = journal;
  }

  run(args, { tolerateFailure = false } = {}) {
    const cmd = `git ${args.join(' ')}`;
    let stdout = '';
    let stderr = '';
    let ok = true;
    try {
      stdout = execFileSync('git', args, {
        cwd: this.cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      ok = false;
      stderr = String((err && err.stderr) || err.message || '');
    }
    if (this.journal) this.journal.push({ cmd, ok, stderr: stderr.trim() });
    if (!ok && !tolerateFailure) {
      throw new Error(`git command failed: ${cmd}\n${stderr.trim()}`);
    }
    return { ok, stdout: String(stdout), stderr };
  }
}

/** `queen-*` -> /^queen-.*$/ ('*' and '?' are the only wildcards). */
function globToRegExp(glob) {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`);
}

/**
 * FR-002 lives here. The order of the checks is the contract:
 *   1. zero commits ahead       -> 'empty'    a running or abandoned bee is not stranded work
 *   2. remote lookup failed     -> 'unknown'  a failed lookup is never a finding
 *   3. ref exists on the remote -> 'landed'
 *   4. otherwise                -> 'stranded'
 *
 * @param {{commitsAhead: number, remoteLookup: 'ok'|'failed',
 *          remoteSha: string|null}} branch
 * @returns {'stranded'|'landed'|'empty'|'unknown'}
 */
function classifyBranchLanding(branch) {
  if (branch.commitsAhead === 0) return 'empty';
  if (branch.remoteLookup === 'failed') return 'unknown';
  if (branch.remoteSha) return 'landed';
  return 'stranded';
}

/** `queen-1359` -> '1359'; null when the branch name carries no number. */
function deriveIssueNumber(branchName) {
  const m = branchName.match(/-([0-9]+)$/);
  return m ? m[1] : null;
}

/**
 * FR-004: read issue state from a caller-supplied file on disk, never the
 * network. Accepted shapes:
 *   - JSON array: [{"number": 1359, "state": "closed"}, ...]
 *   - JSON map:   {"1359": "closed", "1360": "open"}
 *   - plain lines: "1359 closed" (whitespace separated; '#' starts a comment)
 * @returns {Record<string, string>} issue number -> state
 */
function readIssueStates(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read issues file '${file}': ${err.message}`);
  }
  const states = {};
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`issues file '${file}' is not valid JSON: ${err.message}`);
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry && entry.number != null) {
          states[String(entry.number)] = String(entry.state ?? 'unknown');
        }
      }
    } else if (parsed && typeof parsed === 'object') {
      for (const [number, state] of Object.entries(parsed)) {
        states[String(number)] = String(state);
      }
    }
  } else {
    for (const line of trimmed.split('\n')) {
      const m = line.trim().match(/^([0-9]+)\s+(\S+)/);
      if (m) states[m[1]] = m[2];
    }
  }
  return states;
}

/**
 * Gather everything the report needs. Runs only read-only git commands
 * (FR-001) and journals each one (FR-006).
 */
function collectInventory(options = {}) {
  const startDir = options.cwd ?? process.cwd();
  const base = options.base ?? DEFAULT_BASE;
  const pattern = options.pattern ?? DEFAULT_PATTERN;
  const remoteDefault = options.remote ?? DEFAULT_REMOTE;
  const journal = options.journal ?? [];

  // FR-005: resolve the real repository root so the tool works from a
  // worktree as well as from the main checkout.
  const gitStart = new Git(startDir, journal);
  const rootRes = gitStart.run(['rev-parse', '--show-toplevel'], { tolerateFailure: true });
  if (!rootRes.ok) {
    throw new Error(
      `'${startDir}' is not inside a git repository (git rev-parse --show-toplevel failed)`,
    );
  }
  const repoRoot = rootRes.stdout.trim();
  const git = new Git(repoRoot, journal);

  const version = git.run(['--version']).stdout.trim();

  const baseRes = git.run(['rev-parse', '--verify', base], { tolerateFailure: true });
  if (!baseRes.ok) {
    throw new Error(
      `base ref '${base}' not found - pass --base <ref> to compare against something else`,
    );
  }
  const baseSha = baseRes.stdout.trim();

  const headBranchRes = git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { tolerateFailure: true });
  const headShaRes = git.run(['rev-parse', 'HEAD'], { tolerateFailure: true });
  const headBranch = headBranchRes.ok ? headBranchRes.stdout.trim() : '(unknown)';
  const headSha = headShaRes.ok ? headShaRes.stdout.trim() : '(unknown)';

  const matcher = globToRegExp(pattern);
  const names = git
    .run(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((name) => matcher.test(name))
    .sort();

  // Per-branch remote overrides (branch.<name>.remote), read in one call.
  const branchRemote = new Map();
  const cfg = git.run(['config', '--get-regexp', '^branch\\..*\\.remote$'], { tolerateFailure: true });
  if (cfg.ok) {
    for (const line of cfg.stdout.split('\n')) {
      const m = line.trim().match(/^branch\.(.+)\.remote\s+(\S+)\s*$/);
      if (m) branchRemote.set(m[1], m[2]);
    }
  }

  const issueStates = options.issuesFile ? readIssueStates(options.issuesFile) : null;

  const rows = names.map((name) => {
    const subjects = git
      .run(['log', '--format=%s', `${base}..${name}`])
      .stdout.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const commitsAhead = subjects.length;

    let files = 0;
    let insertions = 0;
    let deletions = 0;
    let numstatError = null;
    if (commitsAhead > 0) {
      const res = git.run(['diff', '--numstat', `${base}...${name}`], { tolerateFailure: true });
      if (res.ok) {
        for (const line of res.stdout.split('\n')) {
          if (!line.trim()) continue;
          const parts = line.split('\t');
          files += 1;
          const added = parts[0];
          const deleted = parts[1];
          if (added && added !== '-') insertions += Number(added) || 0;
          if (deleted && deleted !== '-') deletions += Number(deleted) || 0;
        }
      } else {
        numstatError = firstLine(res.stderr) || 'git diff --numstat failed';
      }
    }

    const issue = deriveIssueNumber(name);
    return {
      branch: name,
      issue,
      subjects,
      commitsAhead,
      files,
      insertions,
      deletions,
      numstatError,
      remoteName: branchRemote.get(name) ?? remoteDefault,
      remoteLookup: null,
      remoteSha: null,
      classification: null,
      issueState: issueStates && issue ? (issueStates[issue] ?? null) : null,
    };
  });

  // FR-002: remote state from git ls-remote, one call per remote. A failed
  // call marks every branch in that group 'unknown', never stranded or landed.
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.remoteName)) groups.set(row.remoteName, []);
    groups.get(row.remoteName).push(row);
  }
  for (const [remoteName, groupRows] of groups) {
    const args = [
      'ls-remote', '--heads', remoteName,
      ...groupRows.map((row) => `refs/heads/${row.branch}`),
    ];
    const res = git.run(args, { tolerateFailure: true });
    if (!res.ok) {
      for (const row of groupRows) {
        row.remoteLookup = 'failed';
        row.remoteSha = null;
      }
      continue;
    }
    const found = new Map();
    for (const line of res.stdout.split('\n')) {
      const m = line.match(/^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/);
      if (m) found.set(m[2], m[1]);
    }
    for (const row of groupRows) {
      row.remoteLookup = 'ok';
      row.remoteSha = found.get(row.branch) ?? null;
    }
  }

  for (const row of rows) row.classification = classifyBranchLanding(row);

  const totals = {
    stranded: { count: 0, files: 0 },
    landed: { count: 0 },
    empty: { count: 0 },
    unknown: { count: 0 },
  };
  for (const row of rows) {
    if (row.classification === 'stranded') {
      totals.stranded.count += 1;
      if (row.files != null) totals.stranded.files += row.files;
    } else if (row.classification === 'landed') totals.landed.count += 1;
    else if (row.classification === 'empty') totals.empty.count += 1;
    else totals.unknown.count += 1;
  }

  // Story 2.1: stranded branches first, ranked by files changed descending.
  const rank = { stranded: 0, landed: 1, empty: 2, unknown: 3 };
  const sortedRows = [...rows].sort(
    (a, b) =>
      rank[a.classification] - rank[b.classification] ||
      (b.files ?? -1) - (a.files ?? -1) ||
      b.commitsAhead - a.commitsAhead ||
      a.branch.localeCompare(b.branch),
  );

  return {
    runAt: new Date().toISOString(),
    repoRoot,
    version,
    headBranch,
    headSha,
    base,
    baseIsDefault: options.base == null,
    baseSha,
    pattern,
    remoteDefault,
    issuesFile: options.issuesFile ?? null,
    rows,
    sortedRows,
    totals,
    journal,
  };
}

function firstLine(text) {
  const line = String(text).split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function remoteCell(row) {
  if (row.remoteLookup === 'failed') return 'lookup-failed';
  if (row.remoteSha) return `${row.remoteName}@${row.remoteSha.slice(0, 7)}`;
  return 'absent';
}

/**
 * Up to maxCount subjects per row, each capped at maxLen characters. The full
 * list for any branch is one printed `git log` command away (FR-006).
 */
function formatSubjects(subjects, maxCount = 5, maxLen = 80) {
  if (subjects.length === 0) return '-';
  const shown = subjects.slice(0, maxCount).map((s) =>
    s.length > maxLen ? `${s.slice(0, maxLen - 3)}...` : s,
  );
  const extra = subjects.length > maxCount ? ` (+${subjects.length - maxCount} more)` : '';
  return shown.join(' | ') + extra;
}

function printReport(r) {
  const out = [];
  out.push('Unlanded work inventory (gHashTag/trios#1359)');
  out.push('mode: read-only (FR-001) - nothing here pushes, merges, deletes or modifies');
  out.push(`run at: ${r.runAt}`);
  out.push(`repository root: ${r.repoRoot}`);
  out.push(`head: ${r.headBranch} @ ${r.headSha.slice(0, 12)}`);
  out.push(`git: ${r.version}`);
  out.push(
    `base for comparison: ${r.base} ${r.baseIsDefault ? '(default; override with --base <ref>)' : '(from --base)'} [FR-003]`,
  );
  out.push(`base sha: ${r.baseSha}  (git rev-parse --verify ${r.base})`);
  out.push(`branch pattern: ${r.pattern} (default ${DEFAULT_PATTERN})`);
  out.push(`default remote: ${r.remoteDefault} (per-branch branch.<name>.remote overrides when set)`);
  out.push(
    `issues file: ${r.issuesFile ?? `none supplied - ISSUE-STATE column shows '-' (FR-004: issue state comes from a caller-supplied file, never the network)`}`,
  );
  out.push('');
  out.push(`branches matched: ${r.rows.length}`);
  out.push('');
  out.push(
    'BRANCH'.padEnd(18) +
      '  ' +
      'STATUS'.padEnd(9) +
      '  ' +
      'ISSUE'.padStart(5) +
      '  ' +
      'AHEAD'.padStart(5) +
      '  ' +
      'FILES'.padStart(6) +
      '  ' +
      'INS'.padStart(8) +
      '  ' +
      'DEL'.padStart(8) +
      '  ' +
      'REMOTE'.padEnd(16) +
      '  ' +
      'ISSUE-STATE'.padStart(11) +
      '  SUBJECTS',
  );
  for (const row of r.sortedRows) {
    const files = row.numstatError ? 'ERR' : String(row.files);
    const ins = row.numstatError ? 'ERR' : String(row.insertions);
    const del = row.numstatError ? 'ERR' : String(row.deletions);
    out.push(
      row.branch.padEnd(18) +
        '  ' +
        row.classification.padEnd(9) +
        '  ' +
        String(row.issue ?? '-').padStart(5) +
        '  ' +
        String(row.commitsAhead).padStart(5) +
        '  ' +
        files.padStart(6) +
        '  ' +
        ins.padStart(8) +
        '  ' +
        del.padStart(8) +
        '  ' +
        remoteCell(row).padEnd(16) +
        '  ' +
        String(row.issueState ?? '-').padStart(11) +
        '  ' +
        (row.numstatError ? `[numstat failed: ${row.numstatError}]` : formatSubjects(row.subjects)),
    );
  }
  out.push('');
  out.push('Totals (three separate numbers, per issue story 1.4):');
  out.push(
    `  stranded : ${r.totals.stranded.count} branches | ${r.totals.stranded.files} files changed (sum of per-branch files-changed)`,
  );
  out.push(`  landed   : ${r.totals.landed.count} branches`);
  out.push(`  empty    : ${r.totals.empty.count} branches`);
  out.push(
    `  unknown  : ${r.totals.unknown.count} branches (remote lookup failed - excluded from stranded and landed per FR-002)`,
  );
  out.push('');
  out.push(
    `git commands run (${r.journal.length} - every command executed above, FR-006; '# failed' marks a non-zero exit):`,
  );
  for (const entry of r.journal) {
    out.push(
      `  $ ${entry.cmd}${entry.ok ? '' : `   # failed${entry.stderr ? `: ${firstLine(entry.stderr)}` : ''}`}`,
    );
  }
  console.log(out.join('\n'));
}

/**
 * --selftest: build a throwaway repository with four branches - one stranded,
 * one landed (matching a fake remote), one empty, one whose remote lookup
 * fails - assert the four classifications, and exit 0 only if all pass.
 */
function runSelftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unlanded-selftest-'));
  try {
    const work = path.join(tmp, 'work');
    const bare = path.join(tmp, 'remote.git');
    const brokenUrl = path.join(tmp, 'no-such-remote.git');

    // Fixture. The fixture writes inside its own throwaway directory only;
    // the inventory it exercises afterwards still touches nothing but reads.
    const gitTmp = new Git(tmp, null);
    gitTmp.run(['-c', `init.defaultBranch=${DEFAULT_BASE}`, 'init', '-q', 'work']);
    const git = new Git(work, null);
    const initialBranch = git.run(['symbolic-ref', '--short', 'HEAD']).stdout.trim();
    if (initialBranch !== DEFAULT_BASE) {
      git.run(['branch', '-m', DEFAULT_BASE]);
    }
    git.run(['config', 'user.email', 'selftest@example.invalid']);
    git.run(['config', 'user.name', 'unlanded-work selftest']);
    git.run(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(work, 'base.txt'), 'base\n');
    git.run(['add', '-A']);
    git.run(['commit', '-q', '-m', 'chore: base']);
    git.run(['init', '-q', '--bare', bare]);
    git.run(['remote', 'add', 'origin', bare]);

    // 1) stranded: commits ahead of the base, absent from the remote.
    git.run(['checkout', '-q', '-b', 'queen-1001', DEFAULT_BASE]);
    fs.writeFileSync(path.join(work, 'a.txt'), 'stranded one\n');
    git.run(['add', '-A']);
    git.run(['commit', '-q', '-m', 'feat(test): stranded change one']);
    fs.writeFileSync(path.join(work, 'b.txt'), 'stranded two\n');
    git.run(['add', '-A']);
    git.run(['commit', '-q', '-m', 'feat(test): stranded change two']);

    // 2) landed: commits ahead, and the ref exists on the throwaway remote.
    git.run(['checkout', '-q', '-b', 'queen-1002', DEFAULT_BASE]);
    fs.writeFileSync(path.join(work, 'c.txt'), 'landed\n');
    git.run(['add', '-A']);
    git.run(['commit', '-q', '-m', 'feat(test): landed change']);
    git.run(['push', '-q', 'origin', 'queen-1002']);

    // 3) empty: zero commits ahead of the base.
    git.run(['branch', 'queen-1003', DEFAULT_BASE]);

    // 4) unknown: commits ahead, but its remote lookup fails.
    git.run(['checkout', '-q', '-b', 'queen-1004', DEFAULT_BASE]);
    fs.writeFileSync(path.join(work, 'd.txt'), 'behind a broken remote\n');
    git.run(['add', '-A']);
    git.run(['commit', '-q', '-m', 'feat(test): change behind a broken remote']);
    git.run(['remote', 'add', 'broken', brokenUrl]);
    git.run(['config', 'branch.queen-1004.remote', 'broken']);

    const journal = [];
    const result = collectInventory({ cwd: work, journal });
    const byName = new Map(result.rows.map((row) => [row.branch, row]));

    const expected = {
      'queen-1001': 'stranded',
      'queen-1002': 'landed',
      'queen-1003': 'empty',
      'queen-1004': 'unknown',
    };

    let failures = 0;
    const check = (label, pass) => {
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
      if (!pass) failures += 1;
    };

    console.log(
      `selftest: built ${work} (base ${DEFAULT_BASE} @ ${result.baseSha.slice(0, 7)}, bare remote ${bare}, broken remote ${brokenUrl})`,
    );
    console.log('selftest: assertions -');
    for (const [name, want] of Object.entries(expected)) {
      const row = byName.get(name);
      const got = row ? row.classification : 'no-row';
      check(`${name}: classified '${got}', expected '${want}'`, got === want);
    }

    // FR-002 as its own assertion: a failed remote lookup must classify as
    // 'unknown'. If classifyBranchLanding ever returned 'stranded', 'landed'
    // or 'empty' here, this check would fail the self-test.
    const fr002 = classifyBranchLanding({ commitsAhead: 3, remoteLookup: 'failed', remoteSha: null });
    check(
      `FR-002: classifyBranchLanding({commitsAhead:3, remoteLookup:'failed'}) === 'unknown' (got '${fr002}'; 'stranded'/'landed'/'empty' would all fail this)`,
      fr002 === 'unknown',
    );

    const row1004 = byName.get('queen-1004');
    check(
      `queen-1004: its remote lookup really failed (remoteLookup='${row1004.remoteLookup}', remote '${row1004.remoteName}')`,
      row1004.remoteLookup === 'failed',
    );

    const t = result.totals;
    check(
      `totals: stranded=1 landed=1 empty=1 unknown=1 (got stranded=${t.stranded.count} landed=${t.landed.count} empty=${t.empty.count} unknown=${t.unknown.count})`,
      t.stranded.count === 1 &&
        t.landed.count === 1 &&
        t.empty.count === 1 &&
        t.unknown.count === 1,
    );

    if (failures === 0) {
      console.log('selftest OK - all assertions passed');
      return 0;
    }
    console.error(`selftest FAILED - ${failures} assertion(s) failed`);
    return 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function usage() {
  return [
    'Usage: node trios/tools/unlanded-work-inventory.mjs [options]',
    '',
    'Read-only inventory of queen-* branches whose work never reached the remote',
    '(gHashTag/trios#1359). Classifications:',
    '  stranded  commits ahead of the base, absent from the remote',
    '  landed    present on the remote',
    '  empty     zero commits ahead of the base (not stranded work)',
    '  unknown   the git ls-remote lookup failed - never reported as stranded',
    '            or landed (FR-002)',
    '',
    'Options:',
    `  --base <ref>          base to compare against (default: ${DEFAULT_BASE})`,
    `  --pattern <glob>      branch glob (default: ${DEFAULT_PATTERN}; '*' and '?' are wildcards)`,
    `  --remote <name>       default remote for landing checks (default: ${DEFAULT_REMOTE};`,
    '                        a per-branch branch.<name>.remote config overrides it)',
    '  --issues-file <path>  issue state from this local file only, never the network',
    '                        (FR-004). Shapes: JSON array [{"number":1359,"state":"closed"}],',
    '                        JSON map {"1359":"closed"}, or lines of "1359 closed".',
    '  --selftest            build a throwaway repository, assert the four classifications',
    '  -h, --help            show this text',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    base: null,
    pattern: null,
    remote: null,
    issuesFile: null,
    selftest: false,
    help: false,
  };
  const need = (args, index, flag) => {
    const value = args[index];
    if (value == null || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--selftest') opts.selftest = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--base') opts.base = need(argv, (i += 1), '--base');
    else if (arg === '--pattern') opts.pattern = need(argv, (i += 1), '--pattern');
    else if (arg === '--remote') opts.remote = need(argv, (i += 1), '--remote');
    else if (arg === '--issues-file') opts.issuesFile = need(argv, (i += 1), '--issues-file');
    else throw new Error(`unknown argument '${arg}' (see --help)`);
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`unlanded-work-inventory: ${err.message}`);
    console.error(usage());
    return 2;
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  if (opts.selftest) return runSelftest();

  const journal = [];
  try {
    const result = collectInventory({
      cwd: process.cwd(),
      base: opts.base ?? undefined,
      pattern: opts.pattern ?? undefined,
      remote: opts.remote ?? undefined,
      issuesFile: opts.issuesFile,
      journal,
    });
    printReport(result);
  } catch (err) {
    console.error(`unlanded-work-inventory: ${err.message}`);
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
