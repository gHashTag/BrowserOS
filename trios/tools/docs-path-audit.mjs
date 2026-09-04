#!/usr/bin/env node
// docs-path-audit: verify that file references in the four law documents
// resolve to something that exists in this working tree.
//
// Usage:
//   node trios/tools/docs-path-audit.mjs                  audit the working tree
//   node trios/tools/docs-path-audit.mjs --ref <git-ref>  read document content
//                                                         from <git-ref> while
//                                                         testing existence
//                                                         against the working
//                                                         tree (the red run)
//   node trios/tools/docs-path-audit.mjs --print-allow    print the allow list
//
// A reference is any token delimited by whitespace, backticks, pipes,
// brackets, braces, quotes or parentheses that carries a known file
// extension or starts with a known directory prefix. Existence is decided
// by testing the token itself (as a file or directory) against the
// repository root and against trios/; the existence of a parent directory
// never resolves a reference. Tokens beginning with /, ~ or http are not
// repository-relative and are skipped. Tokens containing * ? < > or a
// YYYY date placeholder are patterns and are resolved against their parent
// directory instead.
//
// Every reference the tool cannot resolve must end in exactly one of three
// states, and the tool prints which:
//   1. corrected in the document to a path that exists,
//   2. rewritten so the sentence no longer names a path, or
//   3. carried in DOCS_PATH_AUDIT_ALLOW below, with a reason that says what
//      creates the path or why it can never exist in a checkout.
//
// Dependencies: node builtins only. No install step. The tool never invokes
// make, swift, python, cargo or t27c. It reads only the four documents
// below (plus git ls-files and, with --ref, git show); it never reads
// anything under t27/, trios/rings/RUST-13/trios-mesh/, trios/_to_delete/,
// node_modules/ or .worktrees/.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

// The four documents this audit is allowed to read.
const DOCS = [
  'CLAUDE.md',
  'trios/CLAUDE.md',
  'trios/docs/API_REFERENCE.md',
  'trios/docs/issue-spec-template.md',
];

// References that may legitimately fail to resolve, each with its reason.
// A reason must say what creates the path or why it can never exist in a
// checkout; "does not exist" or "build artifact" alone is not a reason.
const DOCS_PATH_AUDIT_ALLOW = {
  'docs/images/agent-step.png':
    'example destination, not a real file; docs/images/ at the repository root is the folder that receives screenshots, and the operator replaces this name when one is taken',
  '.trinity/current_task/activity.md':
    'runtime state written by the Trinity agent harness while a task runs; the current_task directory is gitignored per trios/.gitignore and is absent from every fresh checkout',
  '.trinity/agent_events.jsonl':
    'runtime event log appended by the live agent swarm; no tracked source file writes it and .trinity runtime state is gitignored, so it never exists in a fresh checkout',
  'docs/T27-CONSTITUTION.md':
    'never tracked on any branch; the sentence that names it exists to record that it was removed from the read order because it does not exist',
  '.trinity/state/session_summary.md':
    'never tracked on any branch; the sentence that names it records that the experience files and git log replaced it',
  't27/fpga/HARDWARE_SSOT.md':
    "belongs to the other agent's t27 repository (/Users/playra/t27, L0b TERRITORY); this repository points at it and must never copy or edit it",
};

const KNOWN_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'swift', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx',
  'json', 'jsonl', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf',
  'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml', 'xml', 'plist', 'html',
  'css', 'rs', 'zig', 'c', 'h', 'm', 'mm', 'sql', 'csv', 'tsv', 'wasm',
]);

const KNOWN_PREFIXES = [
  '.trinity/',
  '.claude/',
  'docs/',
  'rings/',
  'BR-OUTPUT/',
  'scripts/',
  'agent-server/',
  'e2e/',
  'tests/',
  'tools/',
];

// Ground this tool never enters, in any form.
const FORBIDDEN_PREFIXES = [
  't27/',
  'trios/rings/RUST-13/trios-mesh/',
  'trios/_to_delete/',
  'node_modules/',
  '.worktrees/',
];

const PATTERN_CHARS = /[*?<>]/;
const DATE_PLACEHOLDER = /YYYY/;

// Tokens are cut on whitespace and on shell/markdown punctuation. Glob and
// placeholder characters (* ? < >) are deliberately NOT separators: a token
// carrying one is a pattern, not a literal path.
const SPLIT_RE = /[\s`|()\[\]{}"'\\]+/;
// Edge punctuation trimmed from tokens. A leading '.' is never trimmed:
// it belongs to hidden directories such as .trinity/ and .claude/, and a
// ./ prefix is normalized later instead. A trailing '.' is prose.
const LEADING_TRIM = '$,;:!?=+';
const TRAILING_TRIM = '$.,;:!?=+';

function hasKnownExtension(token) {
  const base = path.posix.basename(token);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return false;
  return KNOWN_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

function isCandidate(token) {
  if (token.startsWith('/') || token.startsWith('~') || token.startsWith('http')) {
    return false; // not repository-relative
  }
  return (
    hasKnownExtension(token) || KNOWN_PREFIXES.some((p) => token.startsWith(p))
  );
}

function extractTokens(line) {
  const tokens = [];
  for (const raw of line.split(SPLIT_RE)) {
    let token = raw;
    while (token.length > 1 && LEADING_TRIM.includes(token[0])) token = token.slice(1);
    while (token.length > 1 && TRAILING_TRIM.includes(token[token.length - 1])) {
      token = token.slice(0, -1);
    }
    if (token && isCandidate(token)) tokens.push(token);
  }
  return tokens;
}

function candidatePaths(token) {
  const rel = token.replace(/^\.\//, '');
  return [path.join(REPO_ROOT, rel), path.join(REPO_ROOT, 'trios', rel)];
}

function entryExists(absPath) {
  try {
    const st = statSync(absPath);
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
}

function directoryExists(absPath) {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

// Decide the state of one reference: 'resolved', 'allowed', or
// 'unresolved'. A pattern reference resolves when its parent directory
// exists; every other reference resolves only when the token itself exists.
function resolveDocPathReference(ref) {
  if (Object.prototype.hasOwnProperty.call(DOCS_PATH_AUDIT_ALLOW, ref.token)) {
    return { state: 'allowed' };
  }
  const isPattern =
    PATTERN_CHARS.test(ref.token) || DATE_PLACEHOLDER.test(ref.token);
  if (isPattern) {
    const parent = path.posix.dirname(ref.token.replace(/^\.\//, ''));
    const ok = candidatePaths(parent).some(directoryExists);
    return { state: ok ? 'resolved' : 'unresolved', pattern: true };
  }
  const ok = candidatePaths(ref.token).some(entryExists);
  return { state: ok ? 'resolved' : 'unresolved', pattern: false };
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(
      (p) =>
        !FORBIDDEN_PREFIXES.some(
          (x) => p === x.slice(0, -1) || p.startsWith(x)
        )
    );
}

// For an unresolved reference, look for tracked files with the same
// basename: print the match when exactly one exists, say so when there are
// zero or several. Never guess.
function basenameSuggestion(token, tracked) {
  const base = path.posix.basename(token.replace(/^\.\//, ''));
  const matches = tracked.filter((p) => path.posix.basename(p) === base);
  if (matches.length === 1) {
    return `exactly one tracked file has this basename: ${matches[0]}`;
  }
  if (matches.length === 0) {
    return 'no tracked file has this basename';
  }
  const listed = matches.slice(0, 4).join(', ');
  const more = matches.length > 4 ? ', ...' : '';
  return `${matches.length} tracked files share this basename (${listed}${more}); pick by hand, do not guess`;
}

function readDoc(docPath) {
  return readFileSync(path.join(REPO_ROOT, docPath), 'utf8');
}

function readDocAtRef(ref, docPath) {
  try {
    return execFileSync('git', ['show', `${ref}:${docPath}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`cannot read ${docPath} at ${ref}: ${err.message}`);
    process.exit(2);
  }
}

function scanDoc(docPath, content) {
  const refs = [];
  content.split('\n').forEach((line, index) => {
    for (const token of extractTokens(line)) {
      refs.push({ doc: docPath, line: index + 1, token });
    }
  });
  return refs;
}

function printAllow() {
  for (const [p, reason] of Object.entries(DOCS_PATH_AUDIT_ALLOW)) {
    console.log(`${p} - ${reason}`);
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--print-allow')) {
    printAllow();
    return 0;
  }

  let ref = null;
  const refIndex = args.indexOf('--ref');
  if (refIndex !== -1) {
    if (refIndex + 1 >= args.length) {
      console.error('--ref needs a git ref, e.g. --ref origin/feat/queen-supervisor');
      return 2;
    }
    ref = args[refIndex + 1];
  }

  const tracked = trackedFiles();
  let checked = 0;
  let unresolved = 0;
  let allowed = 0;

  for (const doc of DOCS) {
    const content = ref ? readDocAtRef(ref, doc) : readDoc(doc);
    for (const refEntry of scanDoc(doc, content)) {
      checked += 1;
      const verdict = resolveDocPathReference(refEntry);
      if (verdict.state === 'resolved') continue;
      if (verdict.state === 'allowed') {
        allowed += 1;
        console.log(`ALLOWED    ${refEntry.doc}:${refEntry.line} ${refEntry.token}`);
        continue;
      }
      unresolved += 1;
      const patternNote = verdict.pattern ? ' (pattern)' : '';
      console.log(
        `UNRESOLVED ${refEntry.doc}:${refEntry.line} ${refEntry.token}${patternNote}`
      );
      console.log(`           ${basenameSuggestion(refEntry.token, tracked)}`);
    }
  }

  const origin = ref
    ? ` (documents read from ${ref}, existence tested against the working tree)`
    : '';
  console.log(
    `checked ${checked} references across ${DOCS.length} files; unresolved ${unresolved}${origin}`
  );
  if (unresolved > 0) {
    console.log(
      'Each unresolved reference must be corrected to a path that exists, rewritten to name no path, or added to DOCS_PATH_AUDIT_ALLOW with a reason.'
    );
    return 1;
  }
  return 0;
}

process.exitCode = main();
