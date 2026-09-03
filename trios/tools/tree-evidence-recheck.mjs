#!/usr/bin/env node
// tree-evidence-recheck.mjs — re-check the evidence of every node in
// .trinity/dashboard/tech-tree.json against today's tree.
//
// Why this exists (gHashTag/trios#1357): the tree is the Queen's own route
// from measurement to work (tools/tree-to-briefs.mjs reads it), so a node
// whose evidence has gone stale does not merely mislead a reader — it
// manufactures work. The motivating case is `boundary-observer-container`,
// whose evidence says agent-server emits no boundary detection, while
// agent-server/apps/server/src/api/services/queen-tick.ts now carries
// boundaryStrays(), the `strays` column, and the warn that uses them.
//
// Contract (from the issue):
//   FR-001  This tool NEVER writes tech-tree.json. It reports; a human
//           decides. The sha256 of the tree is printed before and after the
//           run to prove it.
//   FR-002  Only read-only commands from an explicit allowlist are re-run:
//           grep, ls, find, wc, git grep, git ls-tree. A quoted command
//           outside that list is reported `unverifiable` and NOT executed.
//           Evidence text is data; executing arbitrary strings out of a data
//           file is how a data file becomes a shell.
//   FR-003  Every re-run command is printed with its output, so the report
//           can be checked without trusting the checker.
//   FR-004  A command that errors is `unverifiable`, never `holds`.
//           (grep exit 1 — "no lines selected" — is a result, not an error.)
//   FR-005  Node standard library only; reads nothing outside the repository.
//           Every path operand is resolved inside the repository root before
//           anything is spawned, and absolute or `..`-escaping operands are
//           rejected as `unverifiable`.
//
// The only file this tool writes is docs/tree-evidence-report.md.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TREE_PATH = path.join(REPO_ROOT, '.trinity', 'dashboard', 'tech-tree.json');
const REPORT_PATH = path.join(REPO_ROOT, 'docs', 'tree-evidence-report.md');
const SELF_NAME = 'tree-evidence-recheck.mjs';
const REPORT_NAME = 'tree-evidence-report.md';

// FR-002 — the allowlist, printed by every run. `git` is allowed only with
// the subcommands listed here.
const ALLOWED_PROGRAMS = new Set(['grep', 'ls', 'find', 'wc']);
const ALLOWED_GIT_SUBCOMMANDS = new Set(['grep', 'ls-tree']);
const ALLOWED_LIST_TEXT = 'grep, ls, find, wc, git grep, git ls-tree';

// Programs that make a backtick span look like a command even though it is
// NOT on the allowlist. Those spans are reported unverifiable, never run.
const KNOWN_COMMAND_WORDS = new Set([
  'grep', 'ls', 'find', 'wc', 'git', 'make', 'bash', 'sh', 'cmp', 'cat',
  'df', 'mount', 'ps', 'cargo', 'rustc', 'swift', 'swiftc', 'node', 'bun',
  'npm', 'open', 'railway', 'xcodebuild', 'python', 'python3', 'sed', 'awk',
  'diff', 'head', 'tail', 'echo', 'cd', 'env', 'export', 'iverilog', 'vvp',
  'pgrep', 'kill', 'defaults', 'PlistBuddy',
]);

// Exit codes that mean "the command answered" rather than "the command
// failed". grep exits 1 when it selects no lines — that is a result.
const BENIGN_EXITS = { grep: new Set([0, 1]), ls: new Set([0]), find: new Set([0]), wc: new Set([0]), git: new Set([0]) };

// When a recorded grep names no path (the evidence says "over the whole
// tree"), the checker re-runs it over `.` with these additions so that
// (a) .git, dependency trees and sibling worktrees are not mistaken for the
// working tree, and (b) the checker's own two output files cannot make a
// run differ from the run before it. The command as actually run is printed
// in full, additions included (FR-003).
const CHECKER_ADDED_GREP_FLAGS = [
  '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=.worktrees',
  `--exclude=${SELF_NAME}`, `--exclude=${REPORT_NAME}`,
];

// Checker-defined probes (NOT read from the tree) that name, for a diverged
// node, the code that arrived after the evidence was written. Every probe is
// an allowlisted read-only command, executed by the same engine and printed
// with its output like any other (FR-002, FR-003).
const WHAT_CHANGED_PROBES = {
  'boundary-observer-container': [
    ["grep -n 'boundaryStrays' agent-server/apps/server/src/api/services/queen-tick.ts",
      'the function that computes which committed files fell outside the boundary'],
    ["grep -n 'ADD COLUMN IF NOT EXISTS strays' agent-server/apps/server/src/api/services/queen-tick.ts",
      'the migration that stores those files per dispatch'],
    ["grep -n 'Queen found work outside the boundary she gave' agent-server/apps/server/src/api/services/queen-tick.ts",
      'the log line that fires when a bee strays'],
  ],
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function tokenizeCommand(span) {
  // A small shell-like tokenizer: respects single and double quotes, keeps
  // track of whether a token was quoted (quoted tokens are never
  // glob-expanded), and treats | ; && || > < as structural tokens.
  const tokens = [];
  let cur = '';
  let quoted = false;
  let quote = null;
  const push = () => { if (cur !== '' || quoted) tokens.push({ text: cur, quoted }); cur = ''; quoted = false; };
  for (let i = 0; i < span.length; i++) {
    const c = span[i];
    if (quote) {
      if (c === '\\' && quote === '"' && span[i + 1]) { cur += span[i + 1] === '"' || span[i + 1] === '\\' ? span[i + 1] : '\\' + span[i + 1]; i++; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c; continue;
    }
    if (c === "'" || c === '"') { quote = c; quoted = true; continue; }
    if (/\s/.test(c)) { push(); continue; }
    if (c === '|' && span[i + 1] !== '|' && span[i - 1] !== '|') { push(); tokens.push({ text: '|', op: true }); continue; }
    if (c === '>' || c === '<' || c === ';' || c === '&' || c === '`' || c === '$') { push(); tokens.push({ text: c + (span[i + 1] === c ? span[i + 1] : ''), op: true, unsafe: true }); if (span[i + 1] === c) i++; continue; }
    cur += c;
  }
  push();
  return tokens.filter((t) => t.text !== '');
}

const isUnsafe = (tokens) => tokens.some((t) => t.unsafe);

function looksLikeCommand(span) {
  const first = span.trim().split(/\s+/)[0] || '';
  if (KNOWN_COMMAND_WORDS.has(first)) return true;
  if (/^\.\//.test(first) || /^\.\/.+\.(sh|mjs|js|swift)$/.test(first)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(first) && span.trim().includes(' ')) return true; // env-prefixed
  return false;
}

function programOf(tokens) {
  // Returns { program, allowed } for the head of a token list, peeling any
  // env-var prefix and checking the git subcommand against the allowlist.
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].text) && !tokens[i].quoted) i++;
  const head = tokens[i] && tokens[i].text;
  if (!head) return { program: null, allowed: false };
  if (head === 'git') {
    const sub = tokens[i + 1] && tokens[i + 1].text;
    return { program: 'git', subcommand: sub, allowed: ALLOWED_GIT_SUBCOMMANDS.has(sub), exec: ['git', sub].filter(Boolean) };
  }
  return { program: head, allowed: ALLOWED_PROGRAMS.has(head), exec: [head] };
}

// --- file index (for resolving bare filenames and suffix paths) -----------

function buildFileIndex() {
  const skip = new Set(['.git', 'node_modules', '.worktrees', 'target', 't27c-build']);
  const files = [];
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(r); continue; }
      if (e.isFile()) files.push(r);
    }
  };
  walk('');
  return files;
}

// Minimal glob: supports * and ? within one segment and ** across segments.
function globExpand(pattern) {
  const segs = pattern.split('/');
  const recur = (dirIdx, rel) => {
    if (dirIdx === segs.length) return [rel];
    const seg = segs[dirIdx];
    if (seg === '**') {
      const out = [];
      let entries;
      try { entries = fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true }); } catch { return []; }
      for (const e of entries) {
        if (e.isDirectory()) out.push(...recur(dirIdx, rel ? `${rel}/${e.name}` : e.name));
      }
      out.push(...recur(dirIdx + 1, rel));
      return out;
    }
    const re = new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
    let entries;
    try { entries = fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (dirIdx === segs.length - 1 ? (e.isFile() || e.isDirectory() || e.isSymbolicLink()) && re.test(e.name) : e.isDirectory() && re.test(e.name)) {
        out.push(...recur(dirIdx + 1, r));
      }
    }
    return out;
  };
  return recur(0, '').sort();
}

function insideRepo(p) {
  const abs = path.resolve(REPO_ROOT, p);
  return abs === REPO_ROOT || abs.startsWith(REPO_ROOT + path.sep) ? abs : null;
}

// --- command execution (only allowlisted programs reach this) -------------

function runAllowlisted(tokens, input = '') {
  const res = spawnSync(tokens[0], tokens.slice(1), {
    cwd: REPO_ROOT, input, encoding: 'utf8', timeout: 20000, maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) return { error: res.error.message, timedOut: res.error.code === 'ETIMEDOUT' };
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', timedOut: false };
}

// Options that consume the following token as a value (so it is not mistaken
// for a path operand). Applies to grep-family only; `find` predicates are
// handled separately.
const OPTS_WITH_VALUE = new Set(['--exclude-dir', '--exclude', '--include', '-e', '-m', '--color', '--separator', '-A', '-B', '-C', '--label']);

function splitArgs(tokens, program) {
  // Returns { flags, pattern, paths } — a loose per-program grammar, enough
  // for the commands this tree actually quotes. `flags` keeps every token
  // that is not a path operand or (for grep) the pattern, in order.
  const flags = [];
  const rest = [];
  if (program === 'find') {
    // find [paths...] [predicates...]: paths come first, then everything
    // from the first -token on is a predicate, kept verbatim and in order.
    let i = 0;
    while (i < tokens.length && !tokens[i].text.startsWith('-')) { rest.push(tokens[i]); i++; }
    while (i < tokens.length) { flags.push(tokens[i]); i++; }
    return { flags, pattern: null, paths: rest };
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op) continue;
    if (t.text.startsWith('-') && !t.quoted && t.text !== '-') {
      flags.push(t);
      if (program !== 'find' && OPTS_WITH_VALUE.has(t.text) && tokens[i + 1] && !tokens[i + 1].op) { i++; flags.push(tokens[i]); }
      continue;
    }
    rest.push(t);
  }
  let pattern = null;
  const paths = [];
  if (program === 'grep' || program === 'git grep') {
    if (rest.length) { pattern = rest.shift(); }
  } else if (program === 'git ls-tree') {
    if (rest.length) rest.shift(); // tree-ish
  }
  for (const t of rest) paths.push(t);
  return { flags, pattern, paths };
}

function prepareSegment(tokens) {
  // Validate + normalize one allowlisted segment. Returns either
  // { argv, notes } or { reject, reason } — a rejection is never executed.
  const head = programOf(tokens);
  const program = head.subcommand ? `${head.program} ${head.subcommand}` : head.program;
  const body = tokens.slice(head.program === 'git' ? 2 : 1);
  const { flags, pattern, paths } = splitArgs(body, program);
  const notes = [];

  // Resolve path operands: glob-expand unquoted globs, keep everything
  // inside the repository (FR-005).
  const resolved = [];
  for (const p of paths) {
    let t = p.text;
    if (!p.quoted && /[*?]/.test(t)) {
      const hits = globExpand(t).filter((h) => insideRepo(h));
      if (hits.length === 0) { notes.push(`glob '${t}' matched nothing; the literal was passed on (shell behaviour) and the command will error`); resolved.push(t); continue; }
      resolved.push(...hits);
      continue;
    }
    const abs = insideRepo(t);
    if (!abs) return { reject: true, reason: `path operand '${t}' resolves outside the repository (FR-005: the checker reads nothing outside it)` };
    resolved.push(path.relative(REPO_ROOT, abs) || '.');
  }

  const isRecursiveGrep = program === 'grep' && flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f.text) || f.text.startsWith('--recursive'));
  const hasDirOperand = resolved.some((p) => { try { return fs.statSync(path.join(REPO_ROOT, p)).isDirectory(); } catch { return false; } });

  if (program === 'grep' && resolved.length === 0) {
    resolved.push('.');
    notes.push("the recorded command names no path ('over the whole tree'); re-run over '.'");
  }
  if (program === 'ls' && resolved.length === 0) { resolved.push('.'); notes.push("no operand recorded; re-run over '.'"); }
  if (program === 'find' && resolved.length === 0) { resolved.push('.'); notes.push("no operand recorded; re-run over '.'"); }
  if (program === 'wc' && resolved.length === 0 && pattern === null) {
    // wc reading stdin is legitimate in a pipeline; standalone it is fed the
    // empty stdin this checker always provides, which is printed below.
  }
  let addedFlags = [];
  if (program === 'grep' && isRecursiveGrep && (resolved.includes('.') || hasDirOperand)) {
    addedFlags = [...CHECKER_ADDED_GREP_FLAGS];
    notes.push(`checker added ${addedFlags.join(' ')} so .git/, dependency trees and this checker's own outputs are not mistaken for the working tree (and so re-runs are stable)`);
  }

  // find wants its paths BEFORE its predicates; everything else takes flags
  // first, then the pattern, then the paths.
  const argv = program === 'find'
    ? [...head.exec, ...resolved, ...flags.map((f) => f.text)]
    : [...head.exec, ...flags.map((f) => f.text), ...(pattern ? [pattern.text] : []), ...resolved, ...addedFlags];
  return { argv, notes, program, resolved, pattern: pattern ? pattern.text : null };
}

// --- recorded-result parsing ----------------------------------------------

function parseExpectation(after) {
  const w = after.slice(0, 100);
  if (/->\s*No such file or directory/.test(w)) return { kind: 'recorded-error' };
  if (/=\s*(\d+)\b/.test(w)) return { kind: 'count', n: Number(w.match(/=\s*(\d+)\b/)[1]) };
  if (/\bone hit\b/i.test(w)) return { kind: 'count', n: 1 };
  if (/returns?\s+exactly one file/i.test(w) || /returns?\s+exactly a single file/i.test(w)) return { kind: 'file-count', n: 1 };
  const set = w.match(/returns?\s+exactly\s+((?:[\w.\/+-]+)(?:\s*(?:,|and)\s*[\w.\/+-]+)*)/i);
  if (set) {
    // Only path-shaped items belong to the set; prose that follows ("run
    // today.") is not part of the recorded result.
    const looksPath = (t) => /[\w+.-]+\/[\w+.-]+|[\w+.-]+\.[\w+.-]+/.test(t);
    const items = [];
    for (const part of set[1].split(/\s*(?:,|and)\s*/i)) {
      if (!looksPath(part)) break;
      items.push(part);
    }
    if (items.length) return { kind: 'set', items };
  }
  if (/returns?\s+(nothing|NOTHING)\b/i.test(w) || /->\s*(nothing|NOTHING)\b/.test(w) || /ZERO hits/i.test(w) || /returns?\s+zero\b/i.test(w)) return { kind: 'empty' };
  return null;
}

function countableOutput(program, argv, stdout) {
  if (stdout.trim() === '') return 0;
  const hasCountFlag = argv.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)); // -c, -ciE, …
  if (hasCountFlag || program === 'wc') {
    const nums = stdout.split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l) || /:\d+$/.test(l));
    if (nums.length) return nums.reduce((a, l) => a + Number(l.split(':').pop()), 0);
  }
  return stdout.split('\n').filter((l) => l.trim() !== '' && !/binary file matches/i.test(l)).length;
}

// ---------------------------------------------------------------------------
// The checkers
// ---------------------------------------------------------------------------

function checkCommand(span, after) {
  const base = { kind: 'command', recorded: span };
  const tokens = tokenizeCommand(span);
  if (isUnsafe(tokens)) {
    return { ...base, outcome: 'unverifiable', reason: `quoted command contains shell operators (${tokens.filter((t) => t.unsafe).map((t) => `'${t.text}'`).join(', ')}); not a plain read-only command, so it is not executed (FR-002)` };
  }
  const segments = [];
  let cur = [];
  for (const t of tokens) { if (t.op && t.text === '|') { segments.push(cur); cur = []; } else cur.push(t); }
  segments.push(cur);

  const heads = segments.map((s) => programOf(s));
  const disallowed = heads.find((h) => h.program && !h.allowed);
  if (disallowed) {
    const name = disallowed.subcommand ? `git ${disallowed.subcommand}` : disallowed.program;
    return { ...base, outcome: 'unverifiable', reason: `'${name}' is not on the allowed list (${ALLOWED_LIST_TEXT}); reported unverifiable rather than executed (FR-002)` };
  }
  if (heads.some((h) => !h.program)) {
    return { ...base, outcome: 'unverifiable', reason: 'the quoted command could not be parsed into an allowed program; not executed' };
  }

  // Prepare every segment first — a rejection anywhere means nothing runs.
  const prepared = [];
  for (const seg of segments) {
    const p = prepareSegment(seg);
    if (p.reject) return { ...base, outcome: 'unverifiable', reason: p.reason };
    prepared.push(p);
  }

  // Execute the pipeline segment by segment (FR-003: print each).
  const lines = [];
  let data = '';
  let errored = null;
  const MAX_OUT_LINES = 30;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    const r = runAllowlisted(p.argv, data);
    // Print the argv exactly as executed; tokens that contain whitespace are
    // quoted so the printed command cannot be misread (FR-003).
    lines.push(`  $ ${p.argv.map((t) => (/[\s|;<>&]/.test(t) ? `'${t}'` : t)).join(' ')}`);
    for (const n of p.notes) lines.push(`      (${n})`);
    if (r.error) {
      lines.push(`      -> error: ${r.timedOut ? 'timed out after 20 s (killed)' : r.error}`);
      errored = r.timedOut ? 'timed out' : r.error;
      break;
    }
    const benign = BENIGN_EXITS[p.program] || new Set([0]);
    const outLines = r.stdout.split('\n');
    const shown = outLines.slice(0, MAX_OUT_LINES);
    const body = shown.map((l) => '      ' + l).join('\n').replace(/ +$/, '');
    lines.push(`      -> exit ${r.code}${body.trim() ? '\n' + body : ' (no output)'}${shown.length < outLines.length ? `\n      … output truncated after ${MAX_OUT_LINES} of ${outLines.length} lines` : ''}${r.stderr.trim() ? '\n      [stderr] ' + r.stderr.trim().split('\n')[0] : ''}`);
    if (!benign.has(r.code)) { errored = `exit ${r.code}${r.stderr.trim() ? ': ' + r.stderr.trim().split('\n')[0] : ''}`; break; }
    data = r.stdout;
  }
  const currentOutput = data;

  if (errored) {
    return { ...base, outcome: 'unverifiable', reason: `command errored on re-run (${errored}); an error is never 'holds' (FR-004)`, lines };
  }

  const exp = parseExpectation(after);
  if (!exp) {
    return { ...base, outcome: 'unverifiable', reason: 'command re-ran cleanly, but its recorded result is prose — nothing machine-comparable to compare against (the output above is the current result)', lines };
  }
  if (exp.kind === 'recorded-error') {
    return { ...base, outcome: 'DIVERGED', reason: 'the recorded result was an error and the command now runs cleanly — the situation the evidence describes has changed', lines, current: currentOutput.trim() || '(no output)' };
  }
  if (exp.kind === 'count') {
    const last = prepared[prepared.length - 1];
    const n = countableOutput(last.program, last.argv, currentOutput);
    return n === exp.n
      ? { ...base, outcome: 'holds', detail: `counted ${n}, as recorded`, lines }
      : { ...base, outcome: 'DIVERGED', reason: `recorded count ${exp.n}, today ${n}`, lines, current: String(n) };
  }
  if (exp.kind === 'empty') {
    return currentOutput.trim() === ''
      ? { ...base, outcome: 'holds', detail: 'still no output, as recorded', lines }
      : { ...base, outcome: 'DIVERGED', reason: 'recorded as returning nothing; today it returns output', lines, current: currentOutput.trim() };
  }
  if (exp.kind === 'file-count') {
    const files = currentOutput.split('\n').map((l) => l.trim()).filter(Boolean);
    return files.length === exp.n
      ? { ...base, outcome: 'holds', detail: `still exactly ${exp.n} file(s): ${files.join(', ')}`, lines }
      : { ...base, outcome: 'DIVERGED', reason: `recorded 'exactly ${exp.n} file'; today ${files.length}: ${files.join(', ')}`, lines, current: files.join(', ') };
  }
  if (exp.kind === 'set') {
    const cur = currentOutput.split('\n').map((l) => l.trim()).filter(Boolean).sort();
    const rec = [...exp.items].sort();
    const same = cur.length === rec.length && cur.every((c, i) => c === rec[i]);
    return same
      ? { ...base, outcome: 'holds', detail: `still exactly: ${cur.join(', ')}`, lines }
      : { ...base, outcome: 'DIVERGED', reason: `recorded 'exactly ${rec.join(' and ')}'; today: ${cur.join(', ') || '(nothing)'}`, lines, current: cur.join(', ') };
  }
  return { ...base, outcome: 'unverifiable', reason: 'unhandled expectation shape', lines };
}

// --- file:line references --------------------------------------------------

const FILE_REF_RE = /(\/?(?:[A-Za-z0-9_.\-+]+\/)*[A-Za-z0-9_.\-+]+(?:\.(?:swift|ts|tsx|js|mjs|md|sh|toml|json|ya?ml|rs|v|py|t27))|Makefile|Dockerfile):(\d+)(?:-(\d+))?/g;

function maskSpans(text) {
  // Replace backtick spans with same-length padding so regexes do not match
  // inside quoted commands.
  return text.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));
}

function resolveRef(refPath, fileIndex) {
  if (path.isAbsolute(refPath)) {
    const abs = insideRepo(refPath);
    return abs ? { rel: path.relative(REPO_ROOT, abs) } : { outside: true };
  }
  const direct = insideRepo(refPath);
  if (direct && fs.existsSync(direct)) return { rel: path.relative(REPO_ROOT, direct) };
  const suffix = fileIndex.filter((f) => f === refPath || f.endsWith('/' + refPath)).sort();
  if (suffix.length === 1) return { rel: suffix[0] };
  if (suffix.length > 1) return { ambiguous: suffix };
  // A slashed path names a specific place in this repository; if it is not
  // here, the file is gone from this tree (an unchecked-out submodule is the
  // usual reason, noted by the caller). A bare filename, by contrast, makes
  // no in-repo claim — it may live outside, which the checker cannot read.
  if (refPath.includes('/')) return { missing: true, slashed: true };
  const base = path.basename(refPath);
  const names = fileIndex.filter((f) => f.endsWith('/' + base) || f === base).sort();
  if (names.length === 1) return { rel: names[0] };
  if (names.length > 1) return { ambiguous: names };
  return { missing: true, slashed: false };
}

function emptyAncestorNote(rel) {
  // If a missing path sits under an existing but empty directory (an
  // unchecked-out submodule, typically), say so — that is a fact about this
  // checkout, not about the evidence.
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = path.join(REPO_ROOT, parts.slice(0, i).join('/'));
    try {
      if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) return ` (its parent ${parts.slice(0, i).join('/')} exists but is empty here — an unchecked-out submodule or a directory this checkout does not carry)`;
    } catch { /* keep walking */ }
  }
  return '';
}

// Non-global clone for .test(): FILE_REF_RE itself is global (it is used with
// .exec() in a loop), and a global regex used with .test() carries lastIndex
// state between calls — that is how a checker becomes nondeterministic.
const FILE_REF_RE_TEST = new RegExp(FILE_REF_RE.source);

function snippetAfter(evidence, from, to) {
  // The quoted text that immediately follows a file:line reference, if any.
  const window = evidence.slice(from, Math.min(to, from + 200));
  const re = /`([^`]{3,120})`|"([^"]{20,120})"|'([^']{20,120})'/g;
  let m;
  while ((m = re.exec(window))) {
    const s = (m[1] ?? m[2] ?? m[3]).trim();
    if (!s) continue;
    if (s.startsWith('[')) continue;                       // recorded run output
    const first = s.split(/\s+/)[0];
    if (KNOWN_COMMAND_WORDS.has(first)) continue;          // a command, not file text
    if (FILE_REF_RE_TEST.test(s)) continue;                // another reference
    const words = s.split(/\s+/);
    // A single short word or bare phrase (like `check:` or `cassettes`) names
    // a thing; it does not quote file text. Require several words, or a
    // code-ish operator, so the snippet is specific enough to search for.
    if (words.length < 2 && !/[(){}<>=]|::/.test(s)) continue;
    // A single-quoted span whose next character is a letter was not closed
    // by a real closing quote — it was cut at an apostrophe inside a word
    // ("The Queen's rings" quoted as 'The Queen'). Flag it so matching can
    // drop the amputated final word instead of failing on it.
    const truncated = m[3] !== undefined && /[A-Za-z]/.test(window[m.index + m[0].length] ?? '');
    if (distinctiveTokens(truncated ? words.slice(0, -1).join(' ') : s).length === 0) continue;
    return { text: s, truncated };
  }
  return null;
}

// Normalise text for comparison: markdown decoration and whitespace differ
// between an evidence quote and the file it quotes. Underscores are NOT
// stripped — they are part of identifiers, and stripping them here while the
// token form keeps them is an asymmetry that breaks code quotes.
const normText = (s) => s.replace(/[`*"‘’“”]/g, '').replace(/\s+/g, ' ').trim();

// One canonical form for a word, applied identically to the evidence quote
// and to the file it is searched in — an asymmetric rule here is how a
// checker cries wolf.
const canonicalToken = (w) => w.toLowerCase().replace(/['‘’"“”_]/g, '').replace(/^[`*'.,:;()!?—-]+|[`*'.,:;()!?—-]+$/g, '');

function distinctiveTokens(snippet) {
  // Words that identify the quote. Anything with a digit counts however
  // short it is ("2", "29"): numbers are exactly what goes stale in a board.
  const out = new Set();
  for (const w of snippet.split(/\s+/)) {
    const t = canonicalToken(w);
    if (!t) continue;
    if (t.length >= 3 || /\d/.test(t)) out.add(t);
  }
  return [...out];
}

const wordSet = (text) => new Set(normText(text).split(' ').map(canonicalToken).filter(Boolean));

function locateSnippet(linesArr, snippet) {
  // Ladder, strongest first:
  //   verbatim (normalised) inside the citation window → holds
  //   verbatim elsewhere → moved
  //   all distinctive words inside the window → holds (loosely quoted)
  //   all distinctive words in some 25-line window elsewhere → re-worded
  //   none of the above → absent
  const parts = snippet.includes('...') ? snippet.split('...').map((s) => s.trim()).filter(Boolean) : [snippet];
  const normParts = parts.map(normText).filter(Boolean);
  const toks = distinctiveTokens(snippet);
  return { normParts, toks };
}

function snippetVerdict(linesArr, lineStart, lineEnd, snippetObj) {
  // An apostrophe-truncated quote loses its final word; drop it for matching
  // so the amputation cannot masquerade as a divergence.
  let snippet = snippetObj.text;
  if (snippetObj.truncated) snippet = snippet.split(/\s+/).slice(0, -1).join(' ');
  const { normParts, toks } = locateSnippet(linesArr, snippet);
  const winStart = Math.max(0, lineStart - 1 - 20);
  const winEnd = Math.min(linesArr.length, (lineEnd ?? lineStart) + 20);
  const windowText = linesArr.slice(winStart, winEnd).join(' ');

  // 1. verbatim in the citation window
  if (normParts.length && normParts.every((p) => normText(windowText).includes(p))) {
    return { outcome: 'holds', detail: `quoted text still on/near :${lineStart}` };
  }
  // 2. verbatim elsewhere in the file
  for (let i = 0; i < linesArr.length; i++) {
    const span = linesArr.slice(i, i + 25).join(' ');
    if (normParts.length && normParts.every((p) => normText(span).includes(p))) {
      return { outcome: 'DIVERGED', reason: `quoted text no longer on/near :${lineStart} — found at ~line ${i + 1}` };
    }
  }
  // 3. all distinctive words in the citation window (loose or markdown-ed quote)
  if (toks.length) {
    const ws = wordSet(windowText);
    if (toks.every((t) => ws.has(t))) {
      return { outcome: 'holds', detail: `quoted text present on/near :${lineStart} (matched by its distinctive words — the evidence quotes loosely or the file's markdown differs)` };
    }
    // 4. all distinctive words together in some other 25-line window
    for (let i = 0; i < linesArr.length; i++) {
      const ws2 = wordSet(linesArr.slice(i, i + 25).join(' '));
      if (toks.every((t) => ws2.has(t))) {
        return { outcome: 'DIVERGED', reason: `quoted text no longer on/near :${lineStart} — the closest matching wording is at ~line ${i + 1}, so the citation or the wording has drifted` };
      }
    }
    // 5. absent
    return { outcome: 'DIVERGED', reason: `quoted text no longer present in the file (not verbatim, and its distinctive words do not co-occur anywhere)` };
  }
  return { outcome: 'unverifiable', reason: 'quoted span has no locatable words' };
}

function checkFileRef(ref, lineStart, lineEnd, evidence, refEnd, nextRefStart, fileIndex) {
  const base = { kind: 'file-ref', recorded: ref };
  const res = resolveRef(ref.split(':')[0], fileIndex);
  if (res.outside) return { ...base, outcome: 'unverifiable', reason: 'absolute path outside the repository; the checker reads nothing outside it (FR-005)' };
  if (res.ambiguous) return { ...base, outcome: 'unverifiable', reason: `bare name matches ${res.ambiguous.length} files (${res.ambiguous.slice(0, 4).join(', ')}${res.ambiguous.length > 4 ? ', …' : ''}); which one is meant is not machine-decidable` };
  if (res.missing) {
    return res.slashed
      ? { ...base, outcome: 'DIVERGED', reason: `file not present in this tree${emptyAncestorNote(ref.split(':')[0])}` }
      : { ...base, outcome: 'unverifiable', reason: `no file of this name anywhere in the repository — it likely lives outside (e.g. an unversioned document), which the checker cannot read (FR-005)` };
  }
  let content;
  try { content = fs.readFileSync(path.join(REPO_ROOT, res.rel), 'utf8'); } catch (e) {
    return { ...base, outcome: 'unverifiable', reason: `could not read ${res.rel}: ${e.message}` };
  }
  const linesArr = content.split('\n');
  const notes = [`${res.rel} — ${linesArr.length} lines (evidence cites :${lineEnd ?? lineStart})`];
  if (linesArr.length < (lineEnd ?? lineStart)) {
    return { ...base, outcome: 'DIVERGED', reason: `file exists but has only ${linesArr.length} lines — the evidence cites :${lineEnd ?? lineStart}`, lines: notes };
  }
  const snippet = snippetAfter(evidence, refEnd, nextRefStart);
  if (!snippet) {
    return { ...base, outcome: 'holds', detail: `file present with at least that many lines (no quoted text followed the reference to check)`, lines: notes };
  }
  const v = snippetVerdict(linesArr, lineStart, lineEnd, snippet);
  const label = `“${snippet.text.slice(0, 60)}${snippet.text.length > 60 ? '…' : ''}”`;
  if (v.outcome === 'holds') {
    return { ...base, outcome: 'holds', detail: `file present, ≥ ${lineEnd ?? lineStart} lines; ${v.detail} — quote: ${label}`, lines: notes };
  }
  return { ...base, outcome: v.outcome, reason: `${v.reason} — quote: ${label}`, lines: notes };
}

// ---------------------------------------------------------------------------
// recheckEvidence — one node in, one verdict out
// ---------------------------------------------------------------------------

function recheckEvidence(node, fileIndex) {
  const evidence = node.evidence ?? '';
  const checks = [];

  // 1) Quoted commands. Record each span's start so expectations are parsed
  //    from the text that follows it.
  const cmdRe = /`([^`]+)`/g;
  let m;
  const cmdSpans = [];
  while ((m = cmdRe.exec(evidence))) cmdSpans.push({ span: m[1], end: m.index + m[0].length });
  for (const c of cmdSpans) {
    if (!looksLikeCommand(c.span)) continue; // a backticked path or name is prose, not a claim to re-run
    checks.push(checkCommand(c.span, evidence.slice(c.end)));
  }

  // 2) file:line references (searched outside command spans).
  const masked = maskSpans(evidence);
  const refs = [];
  FILE_REF_RE.lastIndex = 0;
  while ((m = FILE_REF_RE.exec(masked))) {
    const startsSlash = masked[m.index] === '/';
    const pre = masked[m.index - 1] ?? ' ';
    // Skip matches that are the tail of a longer token, unless the reference
    // begins with '/' (an absolute path) — those are complete on their own.
    if (!startsSlash && /[\w\/.\-+]/.test(pre)) continue;
    refs.push({ ref: m[0], path: m[1], start: Number(m[2]), end: m[3] ? Number(m[3]) : null, idx: m.index, endIdx: m.index + m[0].length });
  }
  for (let i = 0; i < refs.length; i++) {
    const next = refs[i + 1];
    checks.push(checkFileRef(refs[i].ref, refs[i].start, refs[i].end, evidence, refs[i].endIdx, next ? next.idx : evidence.length, fileIndex));
  }

  // Aggregate: any divergence makes the node DIVERGED (that is the tree
  // being wrong about today); otherwise one clean re-run makes it holds;
  // otherwise it is unverifiable, which is a finding about the node.
  const diverged = checks.filter((c) => c.outcome === 'DIVERGED');
  const held = checks.filter((c) => c.outcome === 'holds');
  const unverifiable = checks.filter((c) => c.outcome === 'unverifiable');
  let verdict;
  if (diverged.length) verdict = 'DIVERGED';
  else if (held.length) verdict = 'holds';
  else verdict = 'unverifiable';

  const reason = diverged.length
    ? diverged.map((c) => c.reason).join('; ')
    : unverifiable.length
      ? `held ${held.length} of ${checks.length} checks; unverifiable: ${unverifiable.map((c) => (c.kind === 'command' ? `command \`${c.recorded.slice(0, 80)}\`: ${c.reason}` : `${c.recorded}: ${c.reason}`)).join('; ')}`
      : `all ${checks.length} check(s) re-ran and matched`;
  if (!checks.length) {
    return {
      verdict: 'unverifiable',
      reason: 'the evidence is prose: no quoted command and no file:line reference to re-check (a finding about the node, not a failure of the checker)',
      checks: [],
    };
  }
  return { verdict, reason, checks, diverged, held, unverifiable };
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

const fmtChecks = (node, result) => {
  const out = [];
  out.push(`### ${node.id} — status ${node.status}${node.layer ? `, layer ${node.layer}` : ''}`);
  out.push('');
  out.push(`- evidence (recorded): ${node.evidence}`);
  out.push('');
  out.push(`- verdict: **${result.verdict}** — ${result.reason}`);
  for (const c of result.checks) {
    out.push(`  - [${c.outcome}] ${c.kind === 'command' ? `command \`${c.recorded}\`` : `reference ${c.recorded}`}${c.detail ? ` — ${c.detail}` : ''}${c.reason && c.outcome !== 'holds' ? ` — ${c.reason}` : ''}`);
    for (const l of c.lines ?? []) out.push('    ' + l);
  }
  out.push('');
  return out;
};

function main() {
  const treeBefore = sha256(fs.readFileSync(TREE_PATH));

  const tree = JSON.parse(fs.readFileSync(TREE_PATH, 'utf8'));
  const nodes = tree.nodes;
  const fileIndex = buildFileIndex();

  // Node count, two independent ways. The second is itself an allowlisted
  // command, printed with its output (FR-003).
  const countCmd = prepareSegment(tokenizeCommand(`grep -c '"id":' .trinity/dashboard/tech-tree.json`));
  const countRun = runAllowlisted(countCmd.argv);
  const fileCount = Number((countRun.stdout || '').trim());
  const countOk = fileCount === nodes.length;

  const results = nodes.map((node) => ({ node, result: recheckEvidence(node, fileIndex) }));

  // Supplementary "what changed" probes for diverged nodes that have them.
  const probes = {};
  for (const { node, result } of results) {
    if (result.verdict !== 'DIVERGED' || !WHAT_CHANGED_PROBES[node.id]) continue;
    const out = [];
    for (const [cmd, why] of WHAT_CHANGED_PROBES[node.id]) {
      const p = prepareSegment(tokenizeCommand(cmd));
      if (p.reject) { out.push({ cmd, why, error: p.reason }); continue; }
      const r = runAllowlisted(p.argv);
      out.push({ cmd: p.argv.join(' '), why, out: (r.stdout || '').trim(), code: r.code });
    }
    probes[node.id] = out;
  }

  const treeAfter = sha256(fs.readFileSync(TREE_PATH));

  const holds = results.filter((r) => r.result.verdict === 'holds');
  const diverged = results.filter((r) => r.result.verdict === 'DIVERGED');
  const unverifiable = results.filter((r) => r.result.verdict === 'unverifiable');

  const groupingText = results.map((r) => `${r.node.id} ${r.result.verdict}`).join('\n') + '\n';
  const groupingHash = sha256(groupingText);

  // Determinism: compare with the hash the previous run left in the report.
  let prevHash = null;
  try {
    const old = fs.readFileSync(REPORT_PATH, 'utf8');
    const mOld = old.match(/grouping-sha256-this-run: ([0-9a-f]{64})/);
    if (mOld) prevHash = mOld[1];
  } catch { /* first run */ }
  const stable = prevHash === null ? null : prevHash === groupingHash;

  const L = [];
  L.push('# Tree evidence re-check');
  L.push('');
  L.push(`Produced by \`node trios/tools/${SELF_NAME}\` on ${new Date().toISOString().slice(0, 10)}. Re-running the tool regenerates this file.`);
  L.push('');
  L.push('The technology tree `.trinity/dashboard/tech-tree.json` is the Queen\'s own route from measurement to work, and most of its evidence strings quote the command that produced them. This report re-runs what can be re-run and compares, so a node whose evidence no longer describes today\'s tree is named before it can dispatch a bee at a defect that no longer exists.');
  L.push('');
  L.push('## How this was checked');
  L.push('');
  L.push(`- **Allowed commands (the only ones re-run; FR-002):** ${ALLOWED_LIST_TEXT}. A quoted command outside that list is reported \`unverifiable\` and **not executed** — evidence text is data, and executing arbitrary strings out of a data file is how a data file becomes a shell.`);
  L.push('- **Every re-run command is printed with its output** (FR-003), so this report can be checked without trusting the checker.');
  L.push('- **A command that errors is `unverifiable`, never `holds`** (FR-004). `grep` exiting 1 ("no lines selected") is a result, not an error.');
  L.push('- **tech-tree.json was not modified (FR-001).** It was opened read-only and never written; sha256 of the file before the run:');
  L.push(`  \`${treeBefore}\``);
  L.push(`  and after the run: \`${treeAfter}\` — ${treeBefore === treeAfter ? 'identical. Correcting a node is a judgement; this reports, a human decides.' : 'CHANGED — that would be a bug in this checker.'}`);
  L.push('- **Reads nothing outside the repository (FR-005).** Node standard library only; every path operand is resolved inside the repository root before anything is spawned; absolute or `..`-escaping operands are rejected.');
  L.push('- When a recorded grep names no path ("over the whole tree"), the re-run adds `.` plus `--exclude-dir`/`--exclude` flags for `.git`, `node_modules`, `.worktrees` and this checker\'s own two files, so the working tree is what gets compared and two runs of this tool cannot differ by their own output. The command **as actually run** is printed in full.');
  L.push('- **Verdict rule per node:** `DIVERGED` if any check diverged; otherwise `holds` if at least one check re-ran and matched; otherwise `unverifiable` (a finding about the node, not a failure of the checker). Checks cover the node\'s `evidence` field — quoted commands and `file:line` references — and nothing else.');
  L.push('');
  L.push('## Node count — every node is covered');
  L.push('');
  L.push(`- Checker (JSON \`nodes\` array): **${nodes.length}** nodes.`);
  L.push(`- Independent command over the same file:`);
  L.push('');
  L.push('  ```');
  L.push(`  $ ${countCmd.argv.join(' ')}`);
  L.push(`  ${countRun.stdout.trim()}`);
  L.push('  ```');
  L.push('');
  L.push(`- ${countOk ? `Both agree: **${nodes.length} = ${fileCount}**, and every one of them is grouped below.` : `**MISMATCH: ${nodes.length} vs ${fileCount}** — the report below still lists every parsed node.`}`);
  L.push('');
  L.push('## Result');
  L.push('');
  L.push(`| group | count |`);
  L.push(`| --- | --- |`);
  L.push(`| holds | ${holds.length} |`);
  L.push(`| DIVERGED | ${diverged.length} |`);
  L.push(`| unverifiable | ${unverifiable.length} |`);
  L.push(`| **total** | **${results.length}** (= node count above) |`);
  L.push('');
  L.push(`## DIVERGED (${diverged.length}) — the evidence no longer matches today's tree`);
  L.push('');
  for (const r of diverged) {
    L.push(...fmtChecks(r.node, r.result));
    if (probes[r.node.id]) {
      L.push('- **what changed** (checker-defined probes, allowlisted and printed like any other command — the recorded evidence predates this code):');
      for (const p of probes[r.node.id]) {
        L.push(`  - why: ${p.why}`);
        L.push(`    \`\`\``);
        L.push(`    $ ${p.cmd}`);
        L.push('    ' + (p.out || p.error || `(exit ${p.code}, no output)`).split('\n').join('\n    '));
        L.push('    ```');
      }
      if (r.node.id === 'boundary-observer-container') {
        L.push('');
        L.push('  The node\'s evidence says "Nothing in agent-server emits it" and its `blockedBy` says the observer "exists only on the Mac". The container-side detection now exists in `agent-server/apps/server/src/api/services/queen-tick.ts`: `boundaryStrays()` asks queend which committed files fell outside the boundary, the `strays` jsonb column stores them per dispatch, and `Queen found work outside the boundary she gave` is the warn that fires on one. The Mac-side marker `queen.observer.outOfBounds` still lives only in `rings/SR-02/ChatViewModel.swift` — the recorded grep result of "exactly one file" is stale for a different reason (see the re-run) — but the defect the node describes, no write-time boundary enforcement in the container, is fixed. This node was one edit away from dispatching a bee at a defect that no longer exists.');
      }
      L.push('');
    }
  }
  L.push(`## unverifiable (${unverifiable.length}) — reported with the reason; a finding about the node`);
  L.push('');
  for (const r of unverifiable) L.push(...fmtChecks(r.node, r.result));
  L.push(`## holds (${holds.length}) — re-ran and matched`);
  L.push('');
  for (const r of holds) L.push(...fmtChecks(r.node, r.result));
  L.push('## Determinism');
  L.push('');
  L.push('The grouping (one `id verdict` line per node, file order) hashes to:');
  L.push('');
  L.push(`grouping-sha256-this-run: ${groupingHash}`);
  L.push('');
  L.push(prevHash === null
    ? 'No previous run was recorded in this file — run the tool again and this section will compare the two.'
    : `grouping-sha256-previous-run: ${prevHash}`);
  L.push('');
  L.push(stable === null
    ? ''
    : stable
      ? 'Two consecutive runs produced an **identical** grouping.'
      : '**The grouping changed between the two runs** — investigate before trusting either.');
  L.push('');
  L.push('---');
  L.push('');
  L.push(`Exit status: 0. Nodes reported: ${results.length} (holds ${holds.length}, DIVERGED ${diverged.length}, unverifiable ${unverifiable.length}).`);

  const report = L.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, report);
  process.stdout.write(report);
  process.stdout.write(`\n[report written to docs/${REPORT_NAME}; tech-tree.json untouched (sha256 ${treeAfter})]\n`);
}

main();
