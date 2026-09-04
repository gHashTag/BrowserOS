#!/usr/bin/env node
// bundle-apply.mjs — the privileged half of the pack/apply split.
//
// The worker packs accepted work into a git bundle and holds no credential.
// This tool runs where a credential exists: it inspects the bundle against
// its manifest and — only when told to — fetches the bundle into a local
// branch and pushes that branch. Neither half can do the other's job; that
// is the property the split exists to have.
//
// Usage:
//   node trios/tools/bundle-apply.mjs <bundle>                report only (default)
//   node trios/tools/bundle-apply.mjs <bundle> --apply        fetch into the branch and push it
//   node trios/tools/bundle-apply.mjs <bundle> --manifest <p> manifest path override
//   node trios/tools/bundle-apply.mjs <bundle> --repo <dir>   receiving repository (default: cwd)
//   node trios/tools/bundle-apply.mjs <bundle> --remote <r>   remote name or URL (default: origin)
//   node trios/tools/bundle-apply.mjs --selftest
//
// Exit codes: 0 = ok (report produced, or apply+push succeeded),
//             1 = refused or failed (nothing destructive happened),
//             2 = usage error.
//
// Manifest (JSON; by convention a sibling file, <bundle>.manifest.json):
//   {
//     "bundle": "work.bundle",     // optional; must match the file name when present
//     "branch": "queen-1401",      // required; the branch to create and push
//     "base":   "<sha>",           // required; prerequisite commit, "" for a complete bundle
//     "head":   "<sha>",           // required; the commit the bundle delivers
//     "commitCount": 3,            // required; must equal what the bundle actually contains
//     "files":  ["a", "b"]         // optional; when present must match the bundle exactly
//   }
//
// Hard rules this tool keeps:
//   * Default mode applies and pushes nothing. Inspection fetches to
//     FETCH_HEAD only, so not even a temporary ref is created. (Inspecting
//     overwrites FETCH_HEAD in the receiving repository — that is the only
//     trace a report leaves, plus objects in the object store.)
//   * It never performs a forced update of any ref, under any flag. A branch
//     that exists with different history — locally or on the remote — is
//     reported, not resolved.
//   * The bundle is checked with `git bundle verify` before anything is
//     fetched; a bundle that fails that check is not touched further.
//   * The credential is read from the environment (BUNDLE_APPLY_TOKEN,
//     then GITHUB_TOKEN, then GH_TOKEN — first hit wins) at the moment of
//     the push, embedded in a one-shot push URL, and is never written to
//     any file, any git config on disk, or any log line: every byte this
//     tool prints passes a redaction pass first, and credential helpers
//     are disabled for the push. Residual exposure of any process-argument
//     approach (`ps`) is the accepted price of the no-file rule.
//   * A failure at any step leaves the receiving repository's refs as they
//     were: a fetched branch is rolled back to its prior value, or deleted
//     if it did not exist. Fetched objects may remain in the object store;
//     that is stated in the report, never hidden, and no ref points at them.
//
// CI, stated on every push: a push made with a token does not trigger
// workflows on GitHub. The field remedy — an extra empty commit pushed with
// a separate contents:write credential — is an operator decision. This tool
// detects and reports the condition; it applies no silent workaround.
//
// Node standard library only; everything else is `git` on the PATH.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_PATH = fileURLToPath(import.meta.url);

// The empty tree object (sha1): the diff base for complete bundles.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Environment variables consulted — in this order — at the moment of the push.
const TOKEN_ENV_VARS = ['BUNDLE_APPLY_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];

// Marker substituted for any credential value before a byte is printed or stored.
const REDACTION = '<credential-redacted>';

// Secret values seen in this process. Everything printed passes scrub() first.
const secrets = [];

function scrub(text) {
  let t = String(text ?? '');
  for (const s of secrets) {
    if (s) t = t.split(s).join(REDACTION);
  }
  return t;
}

// Run git. Arguments are passed as an array (no shell), so no quoting games
// and no credential ever lands in a shell command line we build.
function runGit(args, { cwd, env } = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0', // never hang asking for a credential
      LC_ALL: 'C',              // deterministic messages for the parsers below
      ...(env || {}),
    },
  });
  return {
    code: res.status,
    out: scrub(res.stdout ?? ''),
    err: scrub(res.stderr ?? ''),
    spawnError: res.error ? scrub(String(res.error)) : null,
  };
}

function isSha(s) {
  return typeof s === 'string' && (/^[0-9a-f]{40}$/.test(s) || /^[0-9a-f]{64}$/.test(s));
}

function validateManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'not a JSON object';
  if (typeof m.branch !== 'string' || !m.branch.trim()) return 'branch must be a non-empty string';
  if (!isSha(m.head)) return 'head must be a commit sha';
  if (!(m.base === '' || isSha(m.base))) return 'base must be a commit sha or "" for a complete bundle';
  if (!Number.isInteger(m.commitCount) || m.commitCount < 0) return 'commitCount must be a non-negative integer';
  if (m.files !== undefined && (!Array.isArray(m.files) || m.files.some((f) => typeof f !== 'string'))) {
    return 'files must be an array of strings when present';
  }
  if (m.bundle !== undefined && typeof m.bundle !== 'string') return 'bundle must be a string when present';
  return null;
}

// `git bundle verify`, parsed. Returns one of:
//   { status: 'ok', heads: [{sha, ref}], prereqs: [sha], detail }
//   { status: 'missing-prereq', missing: [sha], detail }
//   { status: 'invalid', detail }
function verifyBundle(repoDir, bundlePath) {
  const r = runGit(['bundle', 'verify', bundlePath], { cwd: repoDir });
  const text = `${r.out || ''}\n${r.err || ''}`;
  if (r.code !== 0) {
    if (text.includes('lacks these prerequisite commits')) {
      const missing = [...new Set(text.match(/[0-9a-f]{40,64}/g) || [])];
      return { status: 'missing-prereq', missing, detail: text.trim() };
    }
    return { status: 'invalid', detail: (text.trim() || `git bundle verify exited ${r.code}`) };
  }
  const heads = [];
  const prereqs = [];
  let mode = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('The bundle contains')) mode = 'head';
    else if (line.startsWith('The bundle requires')) mode = 'req';
    const m = line.match(/^([0-9a-f]{40,64})\s*(\S*)\s*$/);
    if (m) {
      if (mode === 'head' && m[2]) heads.push({ sha: m[1], ref: m[2] });
      else if (mode === 'req') prereqs.push(m[1]);
    }
  }
  return { status: 'ok', heads, prereqs, detail: text.trim() };
}

// Read the credential from the environment — called at the moment of the push
// and nowhere else.
function credentialAtPush() {
  for (const name of TOKEN_ENV_VARS) {
    const v = process.env[name];
    if (typeof v === 'string' && v.trim()) return { name, value: v.trim() };
  }
  return null;
}

// Build a one-shot credentialed https push URL. Returns null when the URL is
// not https or cannot be parsed; the credential is never stored anywhere but
// the URL handed to this single push.
function buildCredentialedUrl(remoteUrl, tokenValue) {
  try {
    const u = new URL(remoteUrl);
    if (u.protocol !== 'https:') return null;
    const display = `${u.protocol}//${u.host}${u.pathname}${u.search}${u.hash}`;
    u.username = 'x-access-token';
    u.password = tokenValue;
    return { pushUrl: u.href, display };
  } catch {
    return null;
  }
}

// Is the --remote value a direct URL/path rather than a configured remote name?
function looksDirect(remote) {
  return (
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote) ||
    remote === '.' ||
    remote.startsWith('/') ||
    remote.startsWith('./') ||
    remote.startsWith('../') ||
    remote.startsWith('~')
  );
}

// Put a branch back the way it was found. Returns null on success, or a
// string naming what could not be restored (FR-005: say what is left behind).
function restoreBranch(repoDir, branch, existedBefore, oldSha, say) {
  const ref = `refs/heads/${branch}`;
  if (existedBefore) {
    const r = runGit(['update-ref', ref, oldSha], { cwd: repoDir });
    if (r.code === 0) {
      say(`rolled back ${ref} to ${oldSha}`);
      return null;
    }
    return `${ref} is left at the fetched commit; its pre-push value ${oldSha} could not be restored: ${(r.err || r.out).trim()}`;
  }
  const r = runGit(['update-ref', '-d', ref], { cwd: repoDir });
  if (r.code === 0) {
    say(`deleted the newly created ${ref}`);
    return null;
  }
  return `${ref} was newly created and could not be deleted: ${(r.err || r.out).trim()}`;
}

// The applier. Returns a result object; never exits the process, never throws
// on refusals. options:
//   bundlePath  (required) path to the git bundle
//   manifestPath (optional) path to the manifest JSON; discovered next to the bundle when omitted
//   repoDir     (optional) receiving repository; default: process.cwd()
//   remote      (optional) remote name or URL; default: 'origin'
//   apply       (optional boolean) fetch into the branch and push; default: false (report only)
//   log         (optional) callback receiving each report line (already scrubbed)
export function applyBundleAndPush(options = {}) {
  const lines = [];
  const say = (s) => {
    lines.push(s);
    if (typeof options.log === 'function') options.log(scrub(s));
  };
  const result = {
    ok: false,
    refused: false,
    reason: '',
    lines,
    bundlePath: null,
    manifestPath: null,
    branch: null,
    base: null,
    head: null,
    commitCount: null,
    files: [],
    applicable: null,
    applied: false,
    pushed: false,
    pushTarget: null,
    usedCredential: false,
    ciWouldTrigger: null,
    ciNote: null,
    restored: null,
    leftBehind: null,
  };
  const refuse = (reason) => {
    result.refused = true;
    result.ok = false;
    result.reason = scrub(reason);
    return result;
  };

  if (!options.bundlePath || typeof options.bundlePath !== 'string') {
    return refuse('no bundle given; usage: node bundle-apply.mjs <bundle> [--apply]');
  }
  const repoDir = path.resolve(options.repoDir || process.cwd());
  const bundlePath = path.resolve(options.bundlePath);
  result.bundlePath = bundlePath;

  if (!fs.existsSync(bundlePath)) return refuse(`bundle not found: ${bundlePath}`);

  // Manifest: explicit path, else discovered beside the bundle.
  let manifestPath = options.manifestPath ? path.resolve(options.manifestPath) : null;
  if (!manifestPath) {
    const candidates = [`${bundlePath}.manifest.json`];
    const stem = bundlePath.replace(/\.bundle$/, '');
    if (stem !== bundlePath) candidates.push(`${stem}.manifest.json`);
    manifestPath = candidates.find((p) => fs.existsSync(p)) || null;
    if (!manifestPath) {
      return refuse(`no manifest found for ${bundlePath} (looked at: ${candidates.join(', ')}); pass --manifest <path>`);
    }
  }
  result.manifestPath = manifestPath;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return refuse(`manifest ${manifestPath} is not readable JSON: ${e.message}`);
  }
  const schemaError = validateManifest(manifest);
  if (schemaError) return refuse(`manifest ${manifestPath} is invalid: ${schemaError}`);
  if (manifest.bundle && path.basename(bundlePath) !== manifest.bundle) {
    return refuse(`manifest disagrees with the bundle: it names bundle "${manifest.bundle}" but was given "${path.basename(bundlePath)}"`);
  }
  result.branch = manifest.branch;
  result.base = manifest.base || null;
  result.head = manifest.head;
  const wantRef = `refs/heads/${manifest.branch}`;

  const nameCheck = runGit(['check-ref-format', '--branch', manifest.branch]);
  if (nameCheck.code !== 0) {
    return refuse(`manifest branch "${manifest.branch}" is not a valid branch name: ${(nameCheck.err || nameCheck.out).trim()}`);
  }

  const repoCheck = runGit(['rev-parse', '--git-dir'], { cwd: repoDir });
  if (repoCheck.code !== 0) {
    return refuse(`${repoDir} is not a git repository`);
  }

  // FR-003: verify before anything is fetched; a bundle that fails here is
  // not touched further.
  const v = verifyBundle(repoDir, bundlePath);
  if (v.status === 'missing-prereq') {
    result.applicable = false;
    say(`verification: the receiving repository lacks prerequisite commit(s): ${v.missing.join(', ')}`);
    return refuse(`not applicable here — the receiving repository lacks prerequisite commit(s): ${v.missing.join(', ')}; nothing was attempted`);
  }
  if (v.status === 'invalid') {
    return refuse(`bundle failed verification, so nothing will be fetched from it: ${v.detail}`);
  }
  result.applicable = true;
  say(`verification: git bundle verify passed (${v.heads.length} ref(s), ${v.prereqs.length} prerequisite(s))`);

  // The manifest is a claim. Every field that can be checked against the
  // artifact is checked; disagreement is a refusal, not a puzzle to solve.
  const claimedHead = v.heads.find((h) => h.ref === wantRef && h.sha === manifest.head);
  if (!claimedHead) {
    const contained = v.heads.map((h) => `${h.ref} at ${h.sha}`).join(', ') || 'no refs';
    return refuse(`manifest disagrees with the bundle: it claims ${wantRef} at ${manifest.head}, but the bundle contains ${contained}`);
  }
  if (v.prereqs.length > 0) {
    if (!manifest.base) {
      return refuse(`manifest disagrees with the bundle: the bundle carries prerequisite(s) ${v.prereqs.join(', ')} but the manifest states no base`);
    }
    if (!v.prereqs.includes(manifest.base)) {
      return refuse(`manifest disagrees with the bundle: manifest base ${manifest.base} is not a prerequisite of the bundle (${v.prereqs.join(', ')})`);
    }
  } else if (manifest.base) {
    const have = runGit(['cat-file', '-e', `${manifest.base}^{commit}`], { cwd: repoDir });
    if (have.code !== 0) {
      return refuse(`manifest states base ${manifest.base} but the bundle is complete and the receiving repository does not have that commit`);
    }
  }

  // Inspection: fetch to FETCH_HEAD only. No branch is created or moved; the
  // only trace is FETCH_HEAD (overwritten) and objects in the object store.
  const insp = runGit(['fetch', '--quiet', bundlePath, wantRef], { cwd: repoDir });
  if (insp.code !== 0) {
    return refuse(`could not inspect the bundle (fetch to FETCH_HEAD failed; nothing was applied): ${(insp.err || insp.out).trim()}`);
  }
  const auditShaR = runGit(['rev-parse', '--verify', 'FETCH_HEAD'], { cwd: repoDir });
  if (auditShaR.code !== 0) {
    return refuse(`could not resolve FETCH_HEAD after the inspection fetch: ${(auditShaR.err || auditShaR.out).trim()}`);
  }
  const auditSha = auditShaR.out.trim();
  if (auditSha !== manifest.head) {
    return refuse(`manifest disagrees with the bundle: the fetched head is ${auditSha}, the manifest claims ${manifest.head}`);
  }

  // Commit count: the claim must match the artifact exactly.
  const countArgs = ['rev-list', '--count', manifest.base ? `${manifest.base}..${auditSha}` : auditSha];
  const countR = runGit(countArgs, { cwd: repoDir });
  if (countR.code !== 0) {
    return refuse(`could not count commits in the bundle: ${(countR.err || countR.out).trim()}`);
  }
  const commitCount = parseInt(countR.out.trim(), 10);
  result.commitCount = commitCount;
  if (commitCount !== manifest.commitCount) {
    return refuse(`manifest disagrees with the bundle: the manifest claims ${manifest.commitCount} commit(s), the bundle contains ${commitCount}`);
  }

  // Files the bundle would change.
  const diffBase = manifest.base || EMPTY_TREE;
  const nsR = runGit(['diff', '--name-status', diffBase, auditSha], { cwd: repoDir });
  if (nsR.code !== 0) {
    return refuse(`could not list the files the bundle changes: ${(nsR.err || nsR.out).trim()}`);
  }
  const files = [];
  for (const line of nsR.out.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length >= 2) files.push({ status: parts[0], paths: parts.slice(1) });
  }
  result.files = files;
  const noR = runGit(['diff', '--name-only', diffBase, auditSha], { cwd: repoDir });
  if (noR.code !== 0) {
    return refuse(`could not list the files the bundle changes: ${(noR.err || noR.out).trim()}`);
  }
  const actualFiles = noR.out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
  if (Array.isArray(manifest.files)) {
    const claimedFiles = [...manifest.files].map((s) => String(s).trim()).filter(Boolean).sort();
    if (claimedFiles.join('\n') !== actualFiles.join('\n')) {
      return refuse(
        `manifest disagrees with the bundle: file list differs (manifest: ${claimedFiles.join(', ') || '(none)'}; bundle: ${actualFiles.join(', ') || '(none)'})`
      );
    }
  }

  // The report. Identical in both modes up to this point.
  say('');
  say(`bundle:   ${bundlePath}`);
  say(`manifest: ${manifestPath}`);
  say(`branch:   ${manifest.branch}`);
  say(`base:     ${manifest.base || '(complete history)'}`);
  say(`head:     ${manifest.head}`);
  say(`commits:  ${commitCount}`);
  say('files:');
  if (files.length === 0) say('  (none)');
  for (const f of files) say(`  ${f.status}  ${f.paths.join(' -> ')}`);
  say('');

  // FR-001: default mode applies and pushes nothing.
  if (!options.apply) {
    say('mode: report only — nothing applied, nothing pushed');
    result.ok = true;
    return result;
  }

  say('mode: apply');

  // Never fetch into the branch that is checked out; git would refuse anyway.
  const headRef = runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd: repoDir });
  if (headRef.code === 0 && headRef.out.trim() === wantRef) {
    return refuse(`target branch ${wantRef} is checked out in the receiving repository; switch to another branch and re-run (nothing was done)`);
  }

  // Record prior state so a failure can put the repository back (FR-005).
  const prior = runGit(['rev-parse', '--verify', '--quiet', wantRef], { cwd: repoDir });
  const existedBefore = prior.code === 0;
  const oldSha = existedBefore ? prior.out.trim() : null;

  // Fetch the bundle into the named branch. The refspec carries no leading
  // plus sign, so git itself refuses any non-fast-forward update: an
  // existing branch with different history is a refusal here, never an
  // overwrite.
  const bf = runGit(['fetch', '--quiet', bundlePath, `${wantRef}:${wantRef}`], { cwd: repoDir });
  if (bf.code !== 0) {
    const t = (bf.err || bf.out).trim();
    if (/non-fast-forward|\[rejected\]/.test(t)) {
      return refuse(`local branch ${wantRef} exists with different history; refusing to overwrite it (no forced updates, ever). The receiving repository is unchanged.`);
    }
    return refuse(`could not fetch the bundle into ${wantRef}: ${t}. The receiving repository is unchanged.`);
  }
  result.applied = true;
  say(`fetched:  ${wantRef} at ${manifest.head}`);

  // Resolve the push target.
  const remoteValue = typeof options.remote === 'string' && options.remote ? options.remote : 'origin';
  let targetUrl = null;
  if (looksDirect(remoteValue)) {
    targetUrl = remoteValue;
  } else {
    const g = runGit(['remote', 'get-url', remoteValue], { cwd: repoDir });
    if (g.code !== 0) {
      const leftBehind = restoreBranch(repoDir, manifest.branch, existedBefore, oldSha, say);
      result.applied = false;
      result.restored = !leftBehind;
      result.leftBehind = leftBehind;
      return refuse(`no remote named '${remoteValue}' in ${repoDir}${leftBehind ? ` — ${leftBehind}` : ''}`);
    }
    targetUrl = g.out.trim();
  }

  // FR-004: the credential is read from the environment here, at the moment
  // of the push, and nowhere else. It is embedded in a one-shot push URL and
  // registered for redaction so it can never reach a log line.
  let pushUrl = targetUrl;
  let displayUrl = targetUrl;
  let usedCredential = false;
  let credSource = null;
  const cred = credentialAtPush();
  if (cred && /^https:\/\//i.test(targetUrl)) {
    const built = buildCredentialedUrl(targetUrl, cred.value);
    if (built) {
      pushUrl = built.pushUrl;
      displayUrl = built.display;
      usedCredential = true;
      credSource = cred.name;
      secrets.push(cred.value);
    }
  }
  result.pushTarget = displayUrl;
  result.usedCredential = usedCredential;
  say(`push to:  ${displayUrl}${usedCredential ? ` (credential from ${credSource} in the environment; its value is never printed, written to disk, or put in git config)` : ''}`);

  // Push. No flag that could force anything is ever passed; a divergent
  // remote branch is rejected by git itself and reported below.
  const pr = runGit(['-c', 'credential.helper=', 'push', pushUrl, `${wantRef}:${wantRef}`], { cwd: repoDir });
  if (pr.code !== 0) {
    const t = (pr.err || pr.out).trim();
    const diverged = /non-fast-forward|fetch first|\[rejected\]/.test(t);
    // FR-005: put the receiving repository back the way it was found.
    const leftBehind = restoreBranch(repoDir, manifest.branch, existedBefore, oldSha, say);
    result.applied = false;
    result.pushed = false;
    result.restored = !leftBehind;
    result.leftBehind = leftBehind;
    say('objects fetched from the bundle may remain in the receiving object store; no ref was left pointing at them');
    if (diverged) {
      return refuse(`remote branch ${wantRef} has different history; the remote was left untouched (no forced updates, ever)${leftBehind ? ` — ${leftBehind}` : ''}`);
    }
    return refuse(`push failed: ${t}${leftBehind ? ` — ${leftBehind}` : ''}`);
  }

  result.pushed = true;
  result.ok = true;
  say(`pushed:   ${wantRef} -> ${displayUrl} (${manifest.head})`);

  // User story 2.3 / the CI condition, stated on every successful push.
  result.ciWouldTrigger = !usedCredential;
  result.ciNote = usedCredential
    ? 'this push was made with a token credential; such pushes do not trigger workflows on GitHub, so CI will not run from it. The remedy — an empty commit pushed with a separate contents:write credential — is the operator\u2019s call; this tool does not apply it silently.'
    : 'this push used no token credential; it should trigger CI normally.';
  say('');
  say(`ci: ${result.ciNote}`);
  return result;
}

function usage(stream) {
  stream.write(
    [
      'usage: node bundle-apply.mjs <bundle> [--apply] [--manifest <path>] [--repo <dir>] [--remote <name-or-url>]',
      '       node bundle-apply.mjs --selftest',
      '',
      'Default mode reports the branch, base, head, commit count and changed files',
      'of the bundle against its manifest and applies nothing. --apply additionally',
      'fetches the bundle into the manifest\u2019s branch and pushes that branch.',
      'Exit codes: 0 ok, 1 refused or failed, 2 usage.',
      'Credential env vars (read at push time only): BUNDLE_APPLY_TOKEN, GITHUB_TOKEN, GH_TOKEN.',
      'A branch with different history is reported, never overwritten.',
      '',
    ].join('\n')
  );
}

function main(argv) {
  const args = [...argv];
  if (args.includes('--selftest')) return runSelfTest();
  if (args.includes('-h') || args.includes('--help')) {
    usage(process.stdout);
    return 0;
  }
  let bundle = null;
  let manifest = null;
  let repo = null;
  let remote = 'origin';
  let apply = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') apply = true;
    else if (a === '--manifest') manifest = args[++i];
    else if (a === '--repo') repo = args[++i];
    else if (a === '--remote') remote = args[++i];
    else if (a.startsWith('--')) {
      process.stderr.write(`unknown option: ${a}\n`);
      usage(process.stderr);
      return 2;
    } else rest.push(a);
  }
  bundle = rest[0] || null;
  if (!bundle) {
    usage(process.stderr);
    return 2;
  }
  const res = applyBundleAndPush({
    bundlePath: bundle,
    manifestPath: manifest,
    repoDir: repo,
    remote,
    apply,
    log: (l) => process.stdout.write(`${l}\n`),
  });
  if (res.refused) {
    process.stderr.write(`refused: ${res.reason}\n`);
    return 1;
  }
  return res.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Self-test. Builds temporary repositories, packs a branch from one, and
// exercises every rule this tool claims to keep. The pattern used to scan the
// own source for forbidden flags is assembled from pieces at run time so the
// source contains no literal that would match the scan.
// ---------------------------------------------------------------------------

function runSelfTest() {
  const SENTINEL = 'GLYPH-SENTINEL-7c1f0d9e2b6a4e8d-token';
  secrets.push(SENTINEL); // belt and braces: nothing this process prints may carry it

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-apply-selftest-'));
  let pass = 0;
  let fail = 0;
  const allChildOutput = [];

  const say = (s) => process.stdout.write(`${scrub(s)}\n`);
  const check = (name, cond, detail) => {
    if (cond) {
      pass += 1;
      say(`PASS ${name}`);
    } else {
      fail += 1;
      say(`FAIL ${name}${detail ? ` — ${scrub(detail)}` : ''}`);
    }
  };
  const git = (args, opts) => runGit(args, opts);
  const write = (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const commitAll = (repo, msg) => {
    git(['-C', repo, 'add', '-A'], {});
    const c = git(['-C', repo, 'commit', '-q', '-m', msg], {});
    if (c.code !== 0) throw new Error(`commit failed in ${repo}: ${c.err}`);
  };
  const refsOf = (dir) => git(['-C', dir, 'for-each-ref', '--format=%(refname) %(objectname)']).out;
  const headOf = (dir, ref) => git(['-C', dir, 'rev-parse', ref]).out.trim();
  const runTool = (args, env = {}) => {
    const res = spawnSync(process.execPath, [SELF_PATH, ...args], {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, ...env },
    });
    const text = scrub(`${res.stdout || ''}${res.stderr || ''}`);
    allChildOutput.push(text);
    return { code: res.status, out: scrub(res.stdout || ''), err: scrub(res.stderr || ''), text };
  };
  const writeManifest = (p, obj) => fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);

  say(`selftest: workspace ${root}`);
  let worker;
  let bare;
  let bare2;
  let receiver;
  let receiver2;
  let receiver3;
  let alone;
  let bundle;
  let manifestPath;
  let baseSha;
  let headSha;
  let divSha;
  let expectedFiles;

  try {
    // --- fixtures -----------------------------------------------------------
    worker = path.join(root, 'worker');
    fs.mkdirSync(worker, { recursive: true });
    git(['init', '-q', '-b', 'main', worker]);
    git(['-C', worker, 'config', 'user.email', 'selftest@example.invalid']);
    git(['-C', worker, 'config', 'user.name', 'bundle-apply selftest']);
    write(path.join(worker, 'file.txt'), 'A\n');
    commitAll(worker, 'A');
    baseSha = headOf(worker, 'HEAD');
    git(['-C', worker, 'checkout', '-q', '-b', 'work-branch']);
    write(path.join(worker, 'b.txt'), 'B\n');
    write(path.join(worker, 'dir', 'c.txt'), 'C\n');
    commitAll(worker, 'B');
    fs.appendFileSync(path.join(worker, 'file.txt'), 'C\n');
    commitAll(worker, 'C');
    headSha = headOf(worker, 'HEAD');
    expectedFiles = ['b.txt', 'dir/c.txt', 'file.txt'];

    // The pack: one branch, prerequisite main. (The packer is the companion
    // tool; the self-test packs directly.)
    bundle = path.join(root, 'work.bundle');
    const pack = git(['-C', worker, 'bundle', 'create', bundle, 'refs/heads/work-branch', '^refs/heads/main']);
    if (pack.code !== 0) throw new Error(`packing failed: ${pack.err}`);

    manifestPath = path.join(root, 'work.manifest.json');
    writeManifest(manifestPath, {
      bundle: 'work.bundle',
      branch: 'work-branch',
      base: baseSha,
      head: headSha,
      commitCount: 2,
      files: expectedFiles,
    });

    // Receiving side: a bare remote holding main, plus a clone of it.
    bare = path.join(root, 'remote.git');
    git(['init', '-q', '--bare', '-b', 'main', bare]);
    git(['-C', worker, 'push', '-q', bare, 'refs/heads/main:refs/heads/main']);
    receiver = path.join(root, 'receiver');
    git(['clone', '-q', '--no-local', bare, receiver]);

    // A second remote whose work-branch already holds different history.
    bare2 = path.join(root, 'remote-divergent.git');
    git(['init', '-q', '--bare', '-b', 'main', bare2]);
    git(['-C', worker, 'push', '-q', bare2, 'refs/heads/main:refs/heads/main']);
    git(['-C', worker, 'branch', '-q', 'div', baseSha]);
    git(['-C', worker, 'checkout', '-q', 'div']);
    write(path.join(worker, 'd.txt'), 'D\n');
    commitAll(worker, 'D');
    divSha = headOf(worker, 'HEAD');
    git(['-C', worker, 'push', '-q', bare2, 'refs/heads/div:refs/heads/work-branch']);
    git(['-C', worker, 'checkout', '-q', 'main']);
    receiver2 = path.join(root, 'receiver2');
    git(['clone', '-q', '--no-local', bare2, receiver2]);

    // A repo with unrelated history: the bundle is not applicable there.
    alone = path.join(root, 'alone');
    fs.mkdirSync(alone, { recursive: true });
    git(['init', '-q', '-b', 'main', alone]);
    git(['-C', alone, 'config', 'user.email', 'selftest@example.invalid']);
    git(['-C', alone, 'config', 'user.name', 'bundle-apply selftest']);
    write(path.join(alone, 'unrelated.txt'), 'X\n');
    commitAll(alone, 'X');

    // A third receiver, cloned later for the sentinel run.

    // --- 01: the export, in process: report mode applies nothing ------------
    const r1 = applyBundleAndPush({ bundlePath: bundle, manifestPath, repoDir: receiver, apply: false });
    check(
      '01 export applyBundleAndPush reports the bundle and applies nothing',
      r1.ok === true &&
        r1.refused === false &&
        r1.branch === 'work-branch' &&
        r1.base === baseSha &&
        r1.head === headSha &&
        r1.commitCount === 2 &&
        r1.applied === false &&
        r1.pushed === false &&
        r1.files.length === 3 &&
        r1.lines.some((l) => l.includes('report only')),
      JSON.stringify({ ok: r1.ok, refused: r1.refused, reason: r1.reason })
    );

    // --- 02: report mode changes nothing ------------------------------------
    const beforeRecv = refsOf(receiver);
    const beforeBare = refsOf(bare);
    const r2 = runTool([bundle, '--manifest', manifestPath, '--repo', receiver]);
    check(
      '02 report mode succeeds and states every fact',
      r2.code === 0 &&
        r2.out.includes('work-branch') &&
        r2.out.includes(baseSha) &&
        r2.out.includes(headSha) &&
        /commits:\s+2/.test(r2.out) &&
        expectedFiles.every((f) => r2.out.includes(f)) &&
        r2.out.includes('report only'),
      `exit ${r2.code}`
    );
    check(
      '02 report mode changes nothing in the receiving repository or the remote',
      refsOf(receiver) === beforeRecv && refsOf(bare) === beforeBare && !refsOf(receiver).includes('refs/heads/work-branch'),
      'refs changed'
    );
    check('02 report mode leaves the working tree clean', git(['-C', receiver, 'status', '--porcelain']).out.trim() === '', 'dirty status');

    // --- 03: a corrupted bundle is refused before any fetch ------------------
    const corrupt = path.join(root, 'corrupt.bundle');
    const raw = fs.readFileSync(bundle);
    fs.writeFileSync(corrupt, Buffer.concat([Buffer.alloc(24, 0x58), raw.subarray(24)]));
    const corruptManifest = path.join(root, 'corrupt.manifest.json');
    writeManifest(corruptManifest, { bundle: 'corrupt.bundle', branch: 'work-branch', base: baseSha, head: headSha, commitCount: 2, files: expectedFiles });
    const beforeCorrupt = refsOf(receiver);
    const r3 = runTool([corrupt, '--manifest', corruptManifest, '--repo', receiver]);
    check(
      '03 a corrupted bundle is refused at verification, before any fetch',
      r3.code === 1 &&
        r3.text.includes('verification') &&
        !r3.text.includes('[new branch]') &&
        refsOf(receiver) === beforeCorrupt,
      `exit ${r3.code}`
    );

    // --- 04: a manifest whose commit count disagrees is refused --------------
    const badCount = path.join(root, 'bad-count.manifest.json');
    writeManifest(badCount, { bundle: 'work.bundle', branch: 'work-branch', base: baseSha, head: headSha, commitCount: 7, files: expectedFiles });
    const beforeCount = refsOf(receiver);
    const r4 = runTool([bundle, '--manifest', badCount, '--repo', receiver]);
    check(
      '04 a manifest whose commit count disagrees with the bundle is refused',
      r4.code === 1 && r4.text.includes('commit(s)') && r4.text.includes('disagrees') && refsOf(receiver) === beforeCount,
      `exit ${r4.code}`
    );

    // --- 05: a manifest whose head disagrees is refused (extra) --------------
    const badHead = path.join(root, 'bad-head.manifest.json');
    writeManifest(badHead, { bundle: 'work.bundle', branch: 'work-branch', base: baseSha, head: '0'.repeat(40), commitCount: 2, files: expectedFiles });
    const r5 = runTool([bundle, '--manifest', badHead, '--repo', receiver]);
    check('05 a manifest whose head sha disagrees with the bundle is refused', r5.code === 1 && r5.text.includes('disagrees'), `exit ${r5.code}`);

    // --- 06: a missing prerequisite is reported as not applicable -----------
    const beforeAlone = refsOf(alone);
    const r6 = runTool([bundle, '--manifest', manifestPath, '--repo', alone]);
    check(
      '06 a bundle whose prerequisite the receiver lacks is reported not applicable, naming it',
      r6.code === 1 && r6.text.includes('not applicable') && r6.text.includes(baseSha) && refsOf(alone) === beforeAlone,
      `exit ${r6.code}`
    );

    // --- 07: apply into a local bare remote ----------------------------------
    const r7 = runTool([bundle, '--manifest', manifestPath, '--repo', receiver, '--apply', '--remote', 'origin']);
    check(
      '07 apply pushes the branch and reports on CI',
      r7.code === 0 && r7.out.includes('pushed:') && r7.out.includes('ci:'),
      `exit ${r7.code}, stderr: ${r7.err.slice(0, 400)}`
    );
    check(
      '07 the local bare remote holds exactly the expected head',
      headOf(bare, 'refs/heads/work-branch') === headSha && headOf(receiver, 'refs/heads/work-branch') === headSha,
      `remote ${headOf(bare, 'refs/heads/work-branch')} receiver ${headOf(receiver, 'refs/heads/work-branch')} expected ${headSha}`
    );

    // --- 08: a divergent remote branch is refused and left alone -------------
    const beforeR2 = refsOf(receiver2);
    const r8 = runTool([bundle, '--manifest', manifestPath, '--repo', receiver2, '--apply']);
    check(
      '08 a remote branch with different history is refused and left untouched',
      r8.code === 1 &&
        r8.text.includes('different history') &&
        headOf(bare2, 'refs/heads/work-branch') === divSha,
      `exit ${r8.code}, remote head ${headOf(bare2, 'refs/heads/work-branch')} expected ${divSha}`
    );
    check('08 the receiving repository is put back the way it was found', refsOf(receiver2) === beforeR2 && !refsOf(receiver2).includes('refs/heads/work-branch'), 'refs differ');

    // --- 09: the credential never reaches a log line, a file, or git config --
    receiver3 = path.join(root, 'receiver3');
    git(['clone', '-q', '--no-local', bare, receiver3]);
    const beforeR3 = refsOf(receiver3);
    const configBefore = fs.readFileSync(path.join(receiver3, '.git', 'config'), 'utf8');
    const bareConfigBefore = fs.readFileSync(path.join(bare, 'config'), 'utf8');
    const httpsRemote = 'https://example.invalid/trios/ghost.git';
    const r9 = runTool([bundle, '--manifest', manifestPath, '--repo', receiver3, '--apply', '--remote', httpsRemote], {
      BUNDLE_APPLY_TOKEN: SENTINEL,
    });
    const walkFiles = (dir) =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const filesUnderGit = walkFiles(path.join(receiver3, '.git'));
    const leakingFiles = filesUnderGit.filter((p) => {
      try {
        return fs.readFileSync(p, 'utf8').includes(SENTINEL);
      } catch {
        return false;
      }
    });
    check(
      '09 a failed https push leaks no credential into any log line',
      r9.code === 1 && !r9.text.includes(SENTINEL) && r9.out.includes('BUNDLE_APPLY_TOKEN'),
      `exit ${r9.code}`
    );
    const redactionProbe = scrub(`fatal: unable to access 'https://x-access-token:${SENTINEL}@example.invalid/x.git/'`);
    check(
      '09 the redaction pass replaces a credential wherever it appears',
      redactionProbe.includes(REDACTION) && !redactionProbe.includes(SENTINEL),
      redactionProbe
    );
    check(
      '09 no file under the receiving repository, and no git config on disk, contains the credential',
      leakingFiles.length === 0 &&
        fs.readFileSync(path.join(receiver3, '.git', 'config'), 'utf8') === configBefore &&
        fs.readFileSync(path.join(bare, 'config'), 'utf8') === bareConfigBefore &&
        !fs.readFileSync(path.join(bare2, 'config'), 'utf8').includes(SENTINEL),
      `leaking files: ${leakingFiles.join(', ')}`
    );
    check('09 the failed push leaves the receiving repository as it was', refsOf(receiver3) === beforeR3, 'refs differ');

    // --- 10: the source contains no forced-update flag and no forced refspec -
    const scanPattern = ['\\-\\-' + 'force', '\\+' + 'refs' + '/'].join('|');
    const scan = spawnSync('grep', ['-nE', scanPattern, SELF_PATH], { encoding: 'utf8' });
    check(
      '10 the source scan for forbidden update flags and refspecs finds nothing',
      scan.status === 1 && (scan.stdout || '').trim() === '',
      `grep exited ${scan.status} with output: ${scan.stdout}`
    );

    // --- 11: final sweep — no log line anywhere carries the sentinel ---------
    check('11 no output line of any run contains the credential sentinel', !allChildOutput.join('\n').includes(SENTINEL));
  } catch (e) {
    fail += 1;
    say(`FAIL selftest crashed: ${scrub(e && e.stack ? e.stack : String(e))}`);
  }

  say('');
  if (fail === 0) {
    say(`selftest: ${pass} passed, ${fail} failed — workspace removed`);
    fs.rmSync(root, { recursive: true, force: true });
    return 0;
  }
  say(`selftest: ${pass} passed, ${fail} failed — workspace kept for inspection: ${root}`);
  return 1;
}

// Run as a script only; importing the module (for applyBundleAndPush) must not
// trigger the CLI or the self-test.
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  process.exit(main(process.argv.slice(2)));
}
