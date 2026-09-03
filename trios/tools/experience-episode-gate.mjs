#!/usr/bin/env node
// Gate: experience episodes and done-queue evidence must exist in git.
//
// Background: trios/.gitignore used to ignore the whole .trinity/experience/
// directory. The t27-experience-save skill writes a JSON episode there after
// every task and .trinity/queue/done.json cites those files as evidence, but
// ignored files never reach a commit. Episodes were written, cited as
// evidence, and then silently lost. This gate makes that loss loud instead.
//
// What it checks, all derived at run time (nothing about today's data is
// hard-coded):
//   A. A not-yet-existing .json episode path must NOT be ignored by git, so a
//      freshly written episode can be committed. A non-.json path in the same
//      directory must STAY ignored, so scratch files do not sneak in.
//   B. Every .trinity/queue/done.json entry with a repository-relative
//      artifact must name a path that git tracks in HEAD. Each entry whose
//      artifact git does not track is printed with its task id, its verdict,
//      and the artifact path. Entries with a null artifact and entries with
//      an absolute path are two distinct skipped classes; both are counted
//      and neither is reported as untracked evidence.
//
// Why every git check-ignore call passes --no-index and a FILE path:
//   - --no-index: tracked files in the index would otherwise make git answer
//     "not ignored" for paths that the ignore rule still matches.
//   - A file path, never the directory: the corrected .gitignore rule still
//     matches the directory itself, so
//       git check-ignore --no-index -v -- trios/.trinity/experience/
//     still prints the .trinity/experience/** pattern and exits 0 after the
//     fix. A directory probe therefore answers "ignored" under both the old
//     rule and the corrected rule and cannot tell them apart. Measured with
//     the old rule: the episode probe exited 0 (ignored). Measured after the
//     fix: the episode probe exits 1 (not ignored). Do not "fix" this gate
//     by switching it to the directory.
//
// Artifact paths inside done.json are relative to trios/, not to the
// repository root; the gate prefixes them with trios/ before asking git.
//
// Usage, from the repository root:
//   node trios/tools/experience-episode-gate.mjs
// Exit status 0 means every check passed, 1 means at least one failed.
// Reads local files and runs local git only; it makes no network call.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRIOS_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(TRIOS_DIR, '..');
const DONE_REL = 'trios/.trinity/queue/done.json';
const EPISODE_PROBE = 'trios/.trinity/experience/gate-probe-episode.json';
const SCRATCH_PROBE = 'trios/.trinity/experience/gate-probe-scratch.txt';
const MAX_BUFFER = 1024 * 1024 * 64;

function gitRun(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (result.error) throw result.error;
  return result;
}

// True when git ignores the given repository-relative path.
// --no-index and a file path are required; see the header comment.
function isIgnored(relPath) {
  const result = gitRun(['check-ignore', '--no-index', '--quiet', '--', relPath]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error('git check-ignore exited with status ' + result.status + ' for ' + relPath);
}

function trackedHeadPaths() {
  const result = gitRun(['ls-tree', '-r', '--name-only', '--full-name', 'HEAD']);
  if (result.status !== 0) {
    throw new Error('git ls-tree exited with status ' + result.status + (result.stderr ? ': ' + result.stderr.trim() : ''));
  }
  return new Set(result.stdout.split('\n').filter((line) => line.length > 0));
}

function field(entry, key) {
  const value = entry[key];
  if (value === undefined || value === null) return '(no ' + key + ')';
  return String(value);
}

export function experienceEpisodeGate() {
  const failures = [];

  try {
    if (isIgnored(EPISODE_PROBE)) {
      failures.push('git still ignores new episode files: ' + EPISODE_PROBE + ' matches an ignore rule in trios/.gitignore, so episodes written today cannot be committed');
    } else {
      console.log('ok: episode path is not ignored: ' + EPISODE_PROBE);
    }
    if (isIgnored(SCRATCH_PROBE)) {
      console.log('ok: non-episode path stays ignored: ' + SCRATCH_PROBE);
    } else {
      failures.push('git no longer ignores non-episode files: ' + SCRATCH_PROBE + ' is trackable, so the re-include rule is too broad');
    }
  } catch (err) {
    failures.push('ignore probe failed: ' + err.message);
  }

  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, DONE_REL), 'utf8'));
  } catch (err) {
    console.error('FAIL cannot read ' + DONE_REL + ': ' + err.message);
    return 1;
  }
  if (!Array.isArray(entries)) {
    console.error('FAIL ' + DONE_REL + ' does not contain a JSON array');
    return 1;
  }

  let skippedNull = 0;
  let skippedAbsolute = 0;
  const relativeEntries = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const artifact = entry.artifact;
    if (typeof artifact !== 'string' || artifact.length === 0) {
      skippedNull += 1;
      console.log('skipped null-artifact: ' + field(entry, 'task_id'));
      continue;
    }
    if (artifact.startsWith('/')) {
      skippedAbsolute += 1;
      console.log('skipped absolute-artifact: ' + field(entry, 'task_id') + ' ' + artifact);
      continue;
    }
    relativeEntries.push(entry);
  }

  let tracked;
  try {
    tracked = trackedHeadPaths();
  } catch (err) {
    console.error('FAIL ' + err.message);
    return 1;
  }

  const untracked = [];
  for (const entry of relativeEntries) {
    if (!tracked.has('trios/' + entry.artifact)) untracked.push(entry);
  }
  for (const entry of untracked) {
    console.log('UNTRACKED ' + field(entry, 'task_id') + ' ' + field(entry, 'verdict') + ' ' + entry.artifact);
  }

  console.log('summary: done-entries=' + entries.length
    + ' non-null-artifacts=' + (skippedAbsolute + relativeEntries.length)
    + ' skipped-null-artifact=' + skippedNull
    + ' skipped-absolute-artifact=' + skippedAbsolute
    + ' checked-repo-relative=' + relativeEntries.length
    + ' untracked=' + untracked.length);

  if (untracked.length > 0) {
    failures.push('done queue cites ' + untracked.length + ' artifact(s) that git does not track; see the UNTRACKED lines above');
  }

  if (failures.length === 0) {
    console.log('PASS: every done-queue artifact is tracked and new episodes can reach git');
    return 0;
  }
  for (const failure of failures) {
    console.error('FAIL ' + failure);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = experienceEpisodeGate();
}
