#!/usr/bin/env node
// trios/tools/release-blocker-recheck.mjs
//
// Re-measure the numeric claims of trios/.trinity/dashboard/RELEASE-BLOCKER.md
// against this checkout, and check that the closed second blocker stays
// closed. A reader's tool, run on demand.
//
// It is deliberately NOT referenced from trios/Makefile or any CI workflow:
// the branch's counts drift by design, and a decaying number must not be
// able to turn a release gate red.
//
// Usage (from the repository root, or from anywhere inside the work tree):
//   node trios/tools/release-blocker-recheck.mjs
//   node trios/tools/release-blocker-recheck.mjs --doc=PATH
//   node trios/tools/release-blocker-recheck.mjs --base=REF --head=REF
//
// Defaults: --doc is the working-tree copy of the release blocker page
// (never a `git show` of it), --base is origin/dev, --head is HEAD.
//
// Output and exit codes:
//   one line per check, then a final verdict line.
//   EXIT_OK when every check agrees; the last line starts with
//     "[recheck] OK".
//   EXIT_DRIFT when a claim disagrees with the repository, or a claim site
//     has been deleted (reported as MISSING - deleting a sentence is not a
//     route to green); the last line is "[recheck] DRIFT <n> of <m>".
//   EXIT_CANNOT_MEASURE when a ref does not resolve, the installed git does
//     not support merge-tree --write-tree, or the document cannot be read.
//     A line containing "cannot measure" names what failed, and NO verdict
//     is printed: an unmeasured check must never read as agreement.
//
// No measured value is hard-coded: every number compared against the
// document comes from a git command run at check time. The only literal
// numbers in this source are exit codes, array indices and the line-number
// sentinel. The commit identifier in the wedge-resolved check is a citation
// the page is required to carry, not a measurement.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_CANNOT_MEASURE = 3;

const DEFAULT_DOC = join('trios', '.trinity', 'dashboard', 'RELEASE-BLOCKER.md');
const DEFAULT_BASE = 'origin/dev';
const DEFAULT_HEAD = 'HEAD';
const OLD_AGENT_PATH = 'packages/browseros-agent';
const NEW_AGENT_PATH = 'trios/agent-server';

// A conflicted line, counted exactly as the document's own shell counts it:
// `grep -c '^CONFLICT\|<<<<<<<'` counts a line when it starts with CONFLICT
// or contains the seven-character conflict marker anywhere.
const CONFLICT_LINE = /^CONFLICT|<<<<<<</;

class CannotMeasure extends Error {}

// Working directory for measurement commands; undefined means process cwd.
// releaseBlockerRecheck sets it to the repository root once resolved, so
// every measurement works from the root and from trios/ alike.
let gitCwd;

function cannot(what) {
  throw new CannotMeasure(what);
}

function git(args) {
  // gitCwd anchors every measurement command to the repository root, so the
  // checker works from the root and from the trios/ subdirectory alike
  // (git ls-tree resolves its path arguments relative to the cwd).
  const res = spawnSync('git', args, { encoding: 'utf8', maxBuffer: Infinity, cwd: gitCwd });
  if (res.error) cannot(`git could not be executed (${res.error.message})`);
  return res;
}

// What the page must carry, and what it must never carry again. Each numeric
// claim is located by the command that produces it, so the checker finds the
// claim wherever the page puts it and reports the one-based line it was
// parsed from.
export const RELEASE_BLOCKER_CHECKS = {
  ahead: {
    kind: 'number',
    claim: /git rev-list --count.*\(ahead\)/,
    value: /-> *[^0-9]*([0-9]+)/,
  },
  behind: {
    kind: 'number',
    claim: /git rev-list --count.*\(behind\)/,
    value: /-> *[^0-9]*([0-9]+)/,
  },
  conflicts: {
    kind: 'number',
    claim: /merge-tree --write-tree.*->.*[0-9]/,
    value: /-> *[^0-9]*([0-9]+)/,
  },
  'dev-agent-files': {
    kind: 'number',
    claim: /packages\/browseros-agent.*on dev:/,
    value: /on dev: *([0-9]+)/,
  },
  'branch-agent-files': {
    kind: 'number',
    claim: /trios\/agent-server.*on this branch:/,
    value: /on this branch: *([0-9]+)/,
  },
  'wedge-resolved': {
    kind: 'presence',
    // The second blocker was root-caused and fixed; the page must cite the
    // fix commit (a required citation, not a measured value) and the
    // standing Makefile gate that keeps the defect closed.
    required: ['4d56070ef', 'recipe-backticks'],
  },
  'no-root-trace': {
    kind: 'absence',
    // The stale page sent its reader to root-level tracing for a defect
    // that was already closed. Those two commands must not come back.
    forbidden: ['sudo fs_usage', 'sudo lsof'],
  },
};

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--(doc|base|head)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function resolveRef(ref, role) {
  const res = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (res.status !== EXIT_OK) {
    cannot(`${role} ref ${ref} does not resolve (git rev-parse --verify failed)`);
  }
}

function countRange(fromRef, toRef) {
  const res = git(['rev-list', '--count', `${fromRef}..${toRef}`]);
  const out = String(res.stdout || '').trim();
  if (res.status !== EXIT_OK || !/^[0-9]+$/.test(out)) {
    cannot(`git rev-list --count ${fromRef}..${toRef} failed: ${out || String(res.stderr || '').trim()}`);
  }
  return Number(out);
}

function countConflictLines(base, head) {
  const res = git(['merge-tree', '--write-tree', base, head]);
  // merge-tree --write-tree exits EXIT_OK on a clean merge and EXIT_DRIFT
  // when the merge conflicts; both are measurements, not failures. Any
  // other status - a ref that does not resolve, or a git too old to know
  // --write-tree and answering with a usage error - is unmeasurable.
  if (res.status !== EXIT_OK && res.status !== EXIT_DRIFT) {
    cannot(`git merge-tree --write-tree ${base} ${head} failed with status ${res.status}: ${String(res.stderr || '').trim()}`);
  }
  let n = 0;
  for (const line of String(res.stdout || '').split('\n')) {
    if (CONFLICT_LINE.test(line)) n += 1;
  }
  return n;
}

function countTreePaths(ref, path) {
  const res = git(['ls-tree', '-r', '--name-only', ref, '--', path]);
  if (res.status !== EXIT_OK) {
    cannot(`git ls-tree -r --name-only ${ref} -- ${path} failed: ${String(res.stderr || '').trim()}`);
  }
  let n = 0;
  for (const line of String(res.stdout || '').split('\n')) {
    if (line.length > 0) n += 1;
  }
  return n;
}

function firstLineWith(lines, token) {
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(token)) return i;
  }
  return -1;
}

function evaluate(checkName, def, docLines, measured) {
  if (def.kind === 'number') {
    for (let i = 0; i < docLines.length; i += 1) {
      const line = docLines[i];
      if (!def.claim.test(line)) continue;
      const m = line.match(def.value);
      if (!m) {
        return { status: 'DRIFT', text: `${checkName} claim found at line ${i + 1} but no number where the claim should be` };
      }
      const docValue = Number(m[1]);
      if (docValue === measured) {
        return { status: 'OK', text: `${checkName} doc=${docValue} line=${i + 1} measured=${measured}` };
      }
      return { status: 'DRIFT', text: `${checkName} doc=${docValue} line=${i + 1} measured=${measured}` };
    }
    return { status: 'MISSING', text: `${checkName} claim line not found in the document` };
  }
  if (def.kind === 'presence') {
    const found = def.required.map((token) => firstLineWith(docLines, token));
    const missing = def.required.filter((token, idx) => found[idx] < 0);
    if (missing.length > 0) {
      return { status: 'DRIFT', text: `${checkName} document does not cite ${missing.join(', ')}` };
    }
    const citations = def.required
      .map((token, idx) => `${token} at line ${found[idx] + 1}`)
      .join(', ');
    return { status: 'OK', text: `${checkName} ${citations}` };
  }
  // def.kind === 'absence'
  const hits = [];
  for (let i = 0; i < docLines.length; i += 1) {
    for (const token of def.forbidden) {
      if (docLines[i].includes(token)) hits.push(`line ${i + 1}`);
    }
  }
  if (hits.length > 0) {
    return { status: 'DRIFT', text: `${checkName} forbidden root-trace command(s) at ${hits.join(', ')}` };
  }
  return { status: 'OK', text: `${checkName} no root-level trace commands in the document` };
}

export function releaseBlockerRecheck(argv = []) {
  const args = parseArgs(argv);

  const topRes = git(['rev-parse', '--show-toplevel']);
  if (topRes.status !== EXIT_OK) {
    cannot('not inside a git work tree (git rev-parse --show-toplevel failed)');
  }
  const toplevel = String(topRes.stdout || '').trim();
  gitCwd = toplevel;

  const docPath = args.doc || join(toplevel, DEFAULT_DOC);
  let docText;
  try {
    docText = readFileSync(docPath, 'utf8');
  } catch (err) {
    cannot(`document ${docPath} cannot be read (${err.message})`);
  }
  const docLines = String(docText).split('\n');

  const base = args.base || DEFAULT_BASE;
  const head = args.head || DEFAULT_HEAD;
  resolveRef(base, 'base');
  resolveRef(head, 'head');

  const measured = {
    ahead: countRange(base, head),
    behind: countRange(head, base),
    conflicts: countConflictLines(base, head),
    'dev-agent-files': countTreePaths(base, OLD_AGENT_PATH),
    'branch-agent-files': countTreePaths(head, NEW_AGENT_PATH),
  };

  console.log(`[recheck] doc ${docPath}`);
  console.log(`[recheck] base ${base} head ${head}`);

  let driftCount = 0;
  let total = 0;
  for (const name of Object.keys(RELEASE_BLOCKER_CHECKS)) {
    const def = RELEASE_BLOCKER_CHECKS[name];
    const outcome = evaluate(name, def, docLines, measured[name]);
    console.log(`[recheck] ${outcome.status} ${outcome.text}`);
    total += 1;
    if (outcome.status !== 'OK') driftCount += 1;
  }

  if (driftCount === EXIT_OK) {
    console.log(`[recheck] OK ${total} of ${total} checks agree`);
    return EXIT_OK;
  }
  console.log(`[recheck] DRIFT ${driftCount} of ${total}`);
  return EXIT_DRIFT;
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  try {
    process.exitCode = releaseBlockerRecheck(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CannotMeasure) {
      console.log(`[recheck] cannot measure: ${err.message}`);
      process.exitCode = EXIT_CANNOT_MEASURE;
    } else {
      throw err;
    }
  }
}
