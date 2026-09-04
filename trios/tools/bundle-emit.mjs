#!/usr/bin/env node
//
// bundle-emit.mjs - turn a finished worktree branch into one verifiable file.
//
// Context (gHashTag/trios#1400): the worker container deliberately holds no
// credential for the shared remote. Rather than handing the worker a token,
// the handoff is split in two: this tool packages the branch's commits as a
// git bundle plus a small manifest, and a separate, permission-controlled
// step applies the bundle and carries it to the remote. A bundle is the
// right container rather than a patch because it carries commits with their
// parents and messages, so applying it reproduces history rather than
// replaying a squashed diff.
//
// This is the packaging half only. It contacts no network, writes to no
// remote, and reads no credential. Those prohibitions are asserted by the
// source audit inside --selftest, not merely promised in this comment
// (FR-001).
//
// Runtime: the Node standard library only, shelling out to git (FR-005).
// Every git invocation goes through runGit below, which always passes
// `-c safe.directory=*`; without it, a differently-owned checkout makes git
// return an empty result instead of an error, which reads as "nothing to
// pack" (FR-006).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TOOL = 'bundle-emit';
// The base that "ahead" is measured against when --base is not given: the
// default branch of this repository (FR-003). Every run prints the base it
// used, marked [default] or [given with --base].
export const DEFAULT_BASE = 'origin/dev';

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

// Single choke point for every git invocation in this file. Always injects
// `-c safe.directory=*` (FR-006) so an ownership mismatch cannot silently
// turn a failure into an empty result.
function runGit(args, opts = {}) {
  const res = spawnSync('git', ['-c', 'safe.directory=*'].concat(args), {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`could not execute git: ${res.error.message}`);
  // stdout/stderr stay raw: `git status --porcelain=v1` lines begin with a
  // meaningful space that a blanket trim here would silently eat. Callers
  // that want a single-line value use trimOutput/trimError below.
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
  };
}

const trimOutput = (r) => r.stdout.trim();
const trimError = (r) => r.stderr.trim() || r.stdout.trim();

function gitOrThrow(args, opts) {
  const r = runGit(args, opts);
  if (!r.ok) {
    throw new Error(`git ${args.join(' ')} failed with status ${r.status}: ${trimError(r)}`);
  }
  return trimOutput(r);
}

// Resolve a revision to a commit sha. Tries refs/heads/<rev> first so a
// branch name cannot be shadowed by a tag of the same name.
function resolveCommit(cwd, rev) {
  const specs = rev.startsWith('refs/') ? [rev] : [`refs/heads/${rev}`, rev];
  for (const spec of specs) {
    const r = runGit(['rev-parse', '--verify', '--quiet', `${spec}^{commit}`], { cwd });
    if (r.ok) return { sha: trimOutput(r), spec };
  }
  return null;
}

// Uncommitted entries (staged, unstated, and untracked) with their status
// codes, for the dirty-worktree refusal (FR-002).
function statusEntries(cwd) {
  const r = runGit(['status', '--porcelain=v1'], { cwd });
  if (!r.ok) throw new Error(`git status failed: ${r.stderr || r.stdout}`);
  const entries = [];
  for (const line of r.stdout ? r.stdout.split('\n') : []) {
    if (line.length < 4) continue;
    let p = line.slice(3);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    entries[entries.length] = { code: line.slice(0, 2).trim(), path: p };
  }
  return entries;
}

function bundleFileName(branch) {
  return `${branch.replace(/[^A-Za-z0-9._-]+/g, '_')}.bundle`;
}

function refusal(status, message, ctx) {
  return Object.assign({ ok: false, status, message }, ctx);
}

// ---------------------------------------------------------------------------
// the packer
// ---------------------------------------------------------------------------

// Package the commits between base and branch as <branch>.bundle plus a
// manifest beside it (FR-004). Returns a structured result:
//   packed            ok:true   bundle + manifest written
//   empty             ok:true   nothing ahead of the base, no file written
//   dirty             ok:false  worktree has uncommitted paths, none written
//   missing-base      ok:false  base ref does not resolve
//   missing-branch    ok:false  branch ref does not resolve
//   bad-worktree      ok:false  path is not a directory or not a git worktree
//   bundle-*-failed   ok:false  git itself refused
export function packBranchBundle({ worktree, branch, base = null, outDir = null }) {
  const absWorktree = path.resolve(String(worktree));
  const baseIsDefault = base == null || base === '';
  const baseRef = baseIsDefault ? DEFAULT_BASE : String(base);
  const ctx = {
    branch: String(branch),
    base: baseRef,
    baseIsDefault,
    baseSha: null,
    headSha: null,
    commitCount: null,
    bundlePath: null,
    manifestPath: null,
  };

  if (!fs.existsSync(absWorktree) || !fs.statSync(absWorktree).isDirectory()) {
    return refusal('bad-worktree', `worktree path is not a directory: ${absWorktree}`, ctx);
  }
  const gitDir = runGit(['rev-parse', '--absolute-git-dir'], { cwd: absWorktree });
  if (!gitDir.ok) {
    return refusal('bad-worktree', `not a git worktree: ${absWorktree}`, ctx);
  }

  const head = resolveCommit(absWorktree, String(branch));
  if (!head) {
    return refusal('missing-branch', `branch not found in ${absWorktree}: ${branch}`, ctx);
  }
  ctx.headSha = head.sha;

  const baseCommit = resolveCommit(absWorktree, baseRef);
  if (!baseCommit) {
    const which = baseIsDefault ? ' (the default base; pass --base to choose another)' : '';
    return refusal('missing-base', `base ref not found in ${absWorktree}: ${baseRef}${which}`, ctx);
  }
  ctx.baseSha = baseCommit.sha;

  const dirty = statusEntries(absWorktree);
  if (dirty.length > 0) {
    const listed = dirty.map((e) => `  ${e.code.padEnd(2)} ${e.path}`).join('\n');
    ctx.paths = dirty.map((e) => e.path);
    return refusal(
      'dirty',
      `refusing to bundle: worktree has ${dirty.length} uncommitted path(s):\n${listed}\nno bundle written; commit or stash these first`,
      ctx
    );
  }

  const counted = runGit(['rev-list', '--count', `${baseCommit.sha}..${head.sha}`], { cwd: absWorktree });
  if (!counted.ok) {
    return refusal('rev-list-failed', `could not count commits ${baseRef}..${branch}: ${trimError(counted)}`, ctx);
  }
  ctx.commitCount = Number(trimOutput(counted));

  if (ctx.commitCount === 0) {
    return Object.assign(
      { ok: true, status: 'empty', message: `branch ${branch} has no commits ahead of ${baseRef}; no bundle written` },
      ctx
    );
  }

  const absOutDir = path.resolve(outDir == null ? process.cwd() : String(outDir));
  fs.mkdirSync(absOutDir, { recursive: true });
  ctx.bundlePath = path.join(absOutDir, bundleFileName(String(branch)));
  ctx.manifestPath = `${ctx.bundlePath}.manifest.json`;

  // base..branch spelled with the exact refnames verified above, so the
  // bundle labels its tip ref and records the base commit as the
  // prerequisite the receiver must already have.
  const range = `${baseCommit.sha}..${head.spec}`;
  const created = runGit(['bundle', 'create', ctx.bundlePath, range], { cwd: absWorktree });
  if (!created.ok) {
    return refusal('bundle-create-failed', `git bundle create failed: ${trimError(created)}`, ctx);
  }

  // Verify inside the worktree, which by construction holds the
  // prerequisite, so a shipped file is never unverified.
  const verified = runGit(['bundle', 'verify', ctx.bundlePath], { cwd: absWorktree });
  if (!verified.ok) {
    return refusal('bundle-verify-failed', `git bundle verify rejected ${ctx.bundlePath}: ${trimError(verified)}`, ctx);
  }

  const manifest = {
    tool: TOOL,
    manifestVersion: 1,
    createdAt: new Date().toISOString(),
    worktree: absWorktree,
    branch: String(branch),
    branchRef: head.spec,
    base: baseRef,
    baseIsDefault,
    baseSha: baseCommit.sha,
    prerequisite: baseCommit.sha,
    headSha: head.sha,
    commitCount: ctx.commitCount,
    bundle: path.basename(ctx.bundlePath),
  };
  fs.writeFileSync(ctx.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return Object.assign(
    {
      ok: true,
      status: 'packed',
      message: `packed ${ctx.commitCount} commit(s) of ${branch} ahead of ${baseRef} into ${ctx.bundlePath}`,
      verifyOutput: verified.stdout.trim(),
    },
    ctx
  );
}

// ---------------------------------------------------------------------------
// command line
// ---------------------------------------------------------------------------

function usageLine() {
  const here = path.basename(process.argv[1] || `${TOOL}.mjs`);
  return [
    `${TOOL}: package a finished worktree branch as a git bundle plus a manifest.`,
    '',
    'usage:',
    `  node ${here} <worktree> <branch> [--base <ref>] [--out <dir>]`,
    `  node ${here} --selftest`,
    '',
    'options:',
    '  --base <ref>   base to bundle against; "ahead" means base..branch',
    `                 (default: ${DEFAULT_BASE})`,
    '  --out <dir>    directory for <branch>.bundle and its manifest',
    '                 (default: the current directory)',
    '  --selftest     build temporary fixture repositories, assert the four',
    '                 outcomes plus a source audit, exit 0 on success',
    '  -h, --help     show this text',
    '',
    'exit codes: 0 packed or nothing to pack, 1 refused or failed, 2 usage',
  ].join('\n');
}

function parseArgv(argv) {
  const opts = { base: null, out: null, help: false, selftest: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') {
      if (i + 1 >= argv.length) return { error: '--base needs a value' };
      i += 1;
      opts.base = argv[i];
    } else if (a.startsWith('--base=')) {
      opts.base = a.slice('--base='.length);
    } else if (a === '--out') {
      if (i + 1 >= argv.length) return { error: '--out needs a value' };
      i += 1;
      opts.out = argv[i];
    } else if (a.startsWith('--out=')) {
      opts.out = a.slice('--out='.length);
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '--selftest') {
      opts.selftest = true;
    } else if (a.length > 1 && a.startsWith('-')) {
      return { error: `unknown option: ${a}` };
    } else {
      positional[positional.length] = a;
    }
  }
  return { opts, positional };
}

function main(argv) {
  const parsed = parseArgv(argv);
  if (parsed.error) {
    console.error(usageLine());
    console.error(`${TOOL}: ${parsed.error}`);
    return 2;
  }
  const { opts, positional } = parsed;
  if (opts.help) {
    console.log(usageLine());
    return 0;
  }
  if (opts.selftest) return runSelfTest();

  if (positional.length < 2) {
    console.error(usageLine());
    console.error(`${TOOL}: expected <worktree> <branch>`);
    return 2;
  }
  if (positional.length > 2) {
    console.error(usageLine());
    console.error(`${TOOL}: unexpected extra argument: ${positional[2]}`);
    return 2;
  }
  const [worktree, branch] = positional;

  const result = packBranchBundle({ worktree, branch, base: opts.base, outDir: opts.out });

  // The base line is printed on every run, refusal or not, so a reader
  // always knows what "ahead" was measured against (FR-003).
  console.log(`worktree: ${path.resolve(String(worktree))}`);
  console.log(`branch:   ${result.branch}${result.headSha ? ` (${result.headSha})` : ''}`);
  const given = result.baseIsDefault ? 'default' : 'given with --base';
  console.log(`base:     ${result.base}${result.baseSha ? ` (${result.baseSha})` : ''} [${given}]`);

  if (result.ok && result.status === 'packed') {
    console.log(`commits ahead of ${result.base}: ${result.commitCount}`);
    console.log(`bundle:   ${result.bundlePath}`);
    console.log(`manifest: ${result.manifestPath}`);
    console.log('git bundle verify:');
    for (const line of result.verifyOutput.split('\n')) console.log(`  ${line}`);
    return 0;
  }
  if (result.ok && result.status === 'empty') {
    console.log(result.message);
    return 0;
  }
  console.error(result.message);
  return 1;
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

function runSelfTest() {
  let checks = 0;
  const failures = [];
  const ok = (cond, label) => {
    checks += 1;
    if (cond) console.log(`  ok - ${label}`);
    else {
      failures[failures.length] = label;
      console.error(`  FAIL - ${label}`);
    }
  };
  const eq = (actual, expected, label) =>
    ok(Object.is(actual, expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${TOOL}-selftest-`));
  console.log(`selftest: fixtures under ${tmp}`);

  try {
    const makeRepo = (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      gitOrThrow(['init', '-q', '.'], { cwd: dir });
      gitOrThrow(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir });
      gitOrThrow(['config', 'user.name', 'Bundle Emit Selftest'], { cwd: dir });
      gitOrThrow(['config', 'user.email', 'selftest@users.noreply.example.invalid'], { cwd: dir });
      return dir;
    };
    const commitFile = (dir, file, content, message) => {
      fs.writeFileSync(path.join(dir, file), content, 'utf8');
      gitOrThrow(['add', '-A'], { cwd: dir });
      gitOrThrow(['commit', '-q', '-m', message], { cwd: dir });
    };
    const isEmptyDir = (d) => !fs.existsSync(d) || fs.readdirSync(d).length === 0;

    // ---- case 1: a branch ahead of the base -------------------------------
    console.log('case 1: a branch ahead of the base becomes one bundle file');
    const r1 = makeRepo(path.join(tmp, 'ahead'));
    commitFile(r1, 'base-one.txt', 'base one\n', 'base one');
    commitFile(r1, 'base-two.txt', 'base two\n', 'base two');
    const mainSha = gitOrThrow(['rev-parse', 'main'], { cwd: r1 });
    gitOrThrow(['checkout', '-q', '-b', 'feature'], { cwd: r1 });
    const subjects = ['feature one', 'feature two', 'feature three'];
    subjects.forEach((s, i) => commitFile(r1, `feature-${i}.txt`, `${s}\n`, s));
    const featureHead = gitOrThrow(['rev-parse', 'feature'], { cwd: r1 });
    const featureTree = gitOrThrow(['rev-parse', 'feature^{tree}'], { cwd: r1 });

    const out1 = path.join(tmp, 'out-ahead');
    const res1 = packBranchBundle({ worktree: r1, branch: 'feature', base: 'main', outDir: out1 });
    ok(res1.ok === true && res1.status === 'packed', 'case 1: status is packed');
    ok(typeof res1.bundlePath === 'string' && fs.existsSync(res1.bundlePath), 'case 1: exactly one bundle file is written');
    ok(typeof res1.manifestPath === 'string' && fs.existsSync(res1.manifestPath), 'case 1: a manifest is written beside it');
    const m1 = JSON.parse(fs.readFileSync(res1.manifestPath, 'utf8'));
    eq(m1.branch, 'feature', 'manifest names the branch');
    eq(m1.base, 'main', 'manifest names the base');
    eq(m1.headSha, featureHead, 'manifest names the head sha');
    const revCount = Number(gitOrThrow(['rev-list', '--count', 'main..feature'], { cwd: r1 }));
    eq(m1.commitCount, revCount, `manifest commit count equals git rev-list --count main..feature (${revCount})`);

    const verify1 = runGit(['bundle', 'verify', res1.bundlePath], { cwd: r1 });
    ok(verify1.ok, 'git bundle verify accepts the produced file');
    console.log('  git bundle verify says:');
    for (const line of verify1.stdout.split('\n')) if (line) console.log(`    ${line}`);
    ok(verify1.stdout.includes('refs/heads/feature'), 'verify names the contained ref refs/heads/feature');
    ok(verify1.stdout.includes(mainSha), 'verify names the prerequisite the receiver must already have');

    console.log('case 1b: applying the bundle to a second repository reproduces history');
    const r2 = makeRepo(path.join(tmp, 'receiver'));
    commitFile(r2, 'seed.txt', 'seed\n', 'seed');
    const mainBundle = path.join(tmp, 'main.bundle');
    gitOrThrow(['bundle', 'create', mainBundle, 'main'], { cwd: r1 });
    gitOrThrow(['bundle', 'unbundle', mainBundle], { cwd: r2 });
    gitOrThrow(['update-ref', 'refs/heads/main', mainSha], { cwd: r2 });
    const verify2 = runGit(['bundle', 'verify', res1.bundlePath], { cwd: r2 });
    ok(verify2.ok, 'verify passes once the receiver holds the prerequisite');
    gitOrThrow(['bundle', 'unbundle', res1.bundlePath], { cwd: r2 });
    gitOrThrow(['update-ref', 'refs/heads/feature', featureHead], { cwd: r2 });
    eq(Number(gitOrThrow(['rev-list', '--count', 'main..feature'], { cwd: r2 })), revCount, 'receiver counts the same commits');
    const gotSubjects = gitOrThrow(['log', '--format=%s', 'main..feature'], { cwd: r2 }).split('\n');
    eq(gotSubjects.join(' | '), subjects.slice().reverse().join(' | '), 'receiver reads the same commit messages in order');
    eq(gitOrThrow(['rev-parse', 'feature^{tree}'], { cwd: r2 }), featureTree, 'receiver ends on the same tree');

    // ---- case 2: nothing ahead --------------------------------------------
    console.log('case 2: no commits ahead writes no file and says so');
    gitOrThrow(['checkout', '-q', 'main'], { cwd: r1 });
    gitOrThrow(['branch', 'even'], { cwd: r1 });
    const out2 = path.join(tmp, 'out-even');
    const res2 = packBranchBundle({ worktree: r1, branch: 'even', base: 'main', outDir: out2 });
    ok(res2.ok === true && res2.status === 'empty', 'case 2: status is empty');
    eq(res2.commitCount, 0, 'case 2: commit count is 0');
    ok(/no commits ahead/.test(String(res2.message)), 'case 2: the message says no commits ahead');
    ok(isEmptyDir(out2), 'case 2: no file is written');

    // ---- case 3: dirty worktree -------------------------------------------
    console.log('case 3: a dirty worktree is refused and the uncommitted paths are named');
    gitOrThrow(['checkout', '-q', 'feature'], { cwd: r1 });
    const dirtyFile = path.join(r1, 'feature-0.txt');
    const cleanContent = fs.readFileSync(dirtyFile, 'utf8');
    fs.writeFileSync(dirtyFile, `${cleanContent}uncommitted edit\n`, 'utf8');
    fs.writeFileSync(path.join(r1, 'untracked.txt'), 'never committed\n', 'utf8');
    const out3 = path.join(tmp, 'out-dirty');
    const res3 = packBranchBundle({ worktree: r1, branch: 'feature', base: 'main', outDir: out3 });
    ok(res3.ok === false && res3.status === 'dirty', 'case 3: status is dirty');
    ok(Array.isArray(res3.paths) && res3.paths.includes('feature-0.txt'), 'case 3: the modified path is named');
    ok(Array.isArray(res3.paths) && res3.paths.includes('untracked.txt'), 'case 3: the untracked path is named');
    ok(
      String(res3.message).includes('feature-0.txt') && String(res3.message).includes('untracked.txt'),
      'case 3: the refusal message names both paths'
    );
    ok(isEmptyDir(out3), 'case 3: no file is written');
    fs.writeFileSync(dirtyFile, cleanContent, 'utf8');
    fs.rmSync(path.join(r1, 'untracked.txt'), { force: true });

    // ---- case 4: missing base ---------------------------------------------
    console.log('case 4: a missing base is refused by name');
    const out4 = path.join(tmp, 'out-missing-base');
    const res4 = packBranchBundle({ worktree: r1, branch: 'feature', base: 'refs/heads/does-not-exist', outDir: out4 });
    ok(res4.ok === false && res4.status === 'missing-base', 'case 4: status is missing-base');
    ok(String(res4.message).includes('does-not-exist'), 'case 4: the missing base ref is named');
    ok(isEmptyDir(out4), 'case 4: no file is written');

    // ---- case 5: the command line surface ---------------------------------
    console.log('case 5: the command line surface');
    const self = process.argv[1];
    ok(typeof packBranchBundle === 'function', 'packBranchBundle is exported');
    const outCli = path.join(tmp, 'out-cli');
    const cli1 = spawnSync(process.execPath, [self, r1, 'feature', '--base', 'main', '--out', outCli], { encoding: 'utf8' });
    eq(cli1.status, 0, 'node bundle-emit.mjs <worktree> <branch> exits 0');
    ok(String(cli1.stdout).includes('commits ahead of main: 3'), 'the run prints the commit count');
    ok(
      String(cli1.stdout).includes('base:     main') && String(cli1.stdout).includes('[given with --base]'),
      'the run prints the base it measured against'
    );
    ok(fs.existsSync(path.join(outCli, 'feature.bundle')), 'the run writes <branch>.bundle');
    ok(fs.existsSync(path.join(outCli, 'feature.bundle.manifest.json')), 'the run writes the manifest beside it');

    gitOrThrow(['update-ref', 'refs/remotes/origin/dev', mainSha], { cwd: r1 });
    const outCliDefault = path.join(tmp, 'out-cli-default');
    const cli2 = spawnSync(process.execPath, [self, r1, 'feature', '--out', outCliDefault], { encoding: 'utf8' });
    eq(cli2.status, 0, 'with no --base the run still exits 0');
    ok(
      String(cli2.stdout).includes(`base:     ${DEFAULT_BASE}`) && String(cli2.stdout).includes('[default]'),
      'the run prints the default base'
    );

    const cli3 = spawnSync(process.execPath, [self, r1, 'feature', '--base', 'no-such-ref', '--out', path.join(tmp, 'out-cli-missing')], {
      encoding: 'utf8',
    });
    eq(cli3.status, 1, 'a missing base exits 1');

    // ---- audit: no credential, no remote write, no network ----------------
    console.log('audit: the source holds no credential and no remote write');
    const ownSource = fs.readFileSync(new URL(import.meta.url), 'utf8');
    ok(ownSource.includes("'safe.directory=*'"), 'every git call routes through the one helper that sets safe.directory=*');
    // The forbidden patterns below are assembled from pieces at runtime so
    // that this file itself stays free of the strings it forbids.
    const bans = [
      ['git subcommand that writes to a remote', 'pu' + 'sh'],
      ['short-form GitHub token variable', 'GH_' + 'TOKEN'],
      ['long-form GitHub token variable', 'GITHUB_' + 'TOKEN'],
      ['GitHub personal access token variable', 'GITHUB_' + 'PAT'],
      ['git credential helper variable', 'GIT_' + 'ASKPASS'],
      ['authorization header name', 'Autho' + 'rization'],
      ['environment variable read of any kind', 'proc' + 'ess.env'],
      ['external transfer tool (first)', 'cu' + 'rl'],
      ['external transfer tool (second)', 'wg' + 'et'],
      ['browser transfer library', 'undi' + 'ci'],
      ['Node network module (web, plain)', 'node:' + 'http'],
      ['Node network module (web, secure)', 'node:' + 'https'],
      ['Node network module (raw sockets)', 'node:' + 'net'],
      ['Node network module (encrypted sockets)', 'node:' + 'tls'],
      ['Node network module (datagrams)', 'node:' + 'dgram'],
      ['Node network module (name resolution)', 'node:' + 'dns'],
      ['plain web address', 'ht' + 'tp://'],
      ['secure web address', 'ht' + 'tps://'],
    ];
    for (const [why, token] of bans) {
      ok(ownSource.indexOf(token) === -1, `source contains no ${why}`);
    }
    const remoteWords = ['pu' + 'll', 'clo' + 'ne', 'fet' + 'ch', 'ls-' + 'remote', 'remote'].join('|');
    const remoteCommand = new RegExp(`\\bgit\\s+(${remoteWords})\\b`);
    ok(!remoteCommand.test(ownSource), 'source invokes no git subcommand that talks to a remote');
  } catch (err) {
    failures[failures.length] = `unexpected error: ${err && err.stack ? err.stack : String(err)}`;
  }

  if (failures.length === 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`selftest: all ${checks} checks passed; fixtures removed`);
    return 0;
  }
  console.error(`selftest: ${failures.length} failure(s) of ${checks} checks; fixtures kept at ${tmp}`);
  return 1;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

const invokedAsScript = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  process.exitCode = main(process.argv.slice(2));
}
