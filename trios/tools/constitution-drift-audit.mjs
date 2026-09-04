#!/usr/bin/env node
// ============================================================================
// constitution-drift-audit.mjs
// ============================================================================
//
// Purpose
// -------
// clade-tablecloth (trios/rings/RUST-14) is the crate that writes files and
// opens pull requests. Its constitution_gate refuses to auto-fix any path
// matching a protected-path list, and the doc comment on that gate claims the
// check is "a subset of clade-improve's Constitution". clade-improve
// (trios/rings/RUST-04) keeps its own guard-word list in constitution.rs.
// Nothing else in the tree compares the two lists, so they can drift apart
// silently, and the crate with the write privilege can end up with the
// weaker list. This audit makes the drift visible and keeps it visible:
//
//   1. It extracts both lists from the Rust sources at run time (no list
//      entry is stored in this file) and prints each with its source path
//      and the 1-based line range it was read from, so the extraction can
//      be verified by hand with `sed -n 'START,ENDp' PATH`.
//   2. It prints the set difference in both directions and marks each
//      difference entry with the direction it belongs to.
//   3. It computes, from `git ls-files` at run time, the blast radius of the
//      gap: every tracked .swift/.rs path that contains the guard word but
//      matches no entry of clade-tablecloth's protected list (the
//      "unprotected set"), plus the guard-named paths that are already
//      covered.
//   4. It parses the P-numbered principles out of both sources and prints
//      them side by side, marking rows where the same P number names a
//      different principle in each crate (a reader of the event log who
//      looks a P number up in the wrong Constitution gets a true-looking
//      answer to the wrong question).
//
// Usage
// -----
//   node trios/tools/constitution-drift-audit.mjs
//
// Optional source-path overrides, for exercising the extraction-failure
// behaviour against a scratch copy outside the repository. With no override
// the two real files under trios/rings/ are read, resolved from the
// repository root:
//
//   --tablecloth <path>   read the clade-tablecloth source from <path>
//   --improve <path>      read the clade-improve source from <path>
//   CONSTITUTION_DRIFT_TABLECLOTH=<path>   environment-variable equivalent
//   CONSTITUTION_DRIFT_IMPROVE=<path>      environment-variable equivalent
//
//   A relative override path is resolved against the current working
//   directory. The repository root is resolved via `git rev-parse
//   --show-toplevel` anchored at this script's own location, so a default
//   run produces the same output from any working directory.
//
// Exit codes
// ----------
//   0   both directions of the set difference are empty (the lists agree)
//   1   drift: the symmetric difference of the two lists is non-empty
//   2   read or extraction failure - reported loudly on stderr, never as a
//       clean result, because an empty difference is the success signal and
//       a failed extraction must not be able to counterfeit it
//
// The audit is strictly read-only. It reads the two Rust sources and runs
// only `git rev-parse` and `git ls-files`; it writes no file and mutates no
// git state. Node standard library only, no dependencies, no network.
// ============================================================================

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// --- constants -------------------------------------------------------------

// Default sources, relative to the repository root. These are the two real
// files the audit compares; every list entry, principle name, path and count
// in the output comes from these sources or from git at run time.
const TABLECLOTH_REL = 'trios/rings/RUST-14/clade-tablecloth/src/main.rs';
const IMPROVE_REL = 'trios/rings/RUST-04/clade-improve/src/constitution.rs';

// Extraction anchors. Each is a stable, single-purpose literal in its source
// and must end with the opening bracket of the array it introduces.
const TABLECLOTH_ANCHOR = 'const PROTECTED: &[&str] = &[';
const IMPROVE_ANCHOR = 'let guards = [';

// The clade-tablecloth principles live in `// Pn - Name` comments inside
// constitution_gate; the scan is scoped to that function so a coincidental
// comment elsewhere in the file cannot leak in.
const TABLECLOTH_FN_ANCHOR = 'fn constitution_gate(';

// The word whose missing protected-list entry is the subject of this audit.
const GUARD_WORD = 'guard';

// --- helpers ---------------------------------------------------------------

function fail(message) {
  // Loud failure: stderr, exit status 2, and nothing on stdout that could be
  // mistaken for a clean result.
  process.stderr.write(`constitution-drift-audit: FAILURE: ${message}\n`);
  process.exitCode = 2;
}

// 1-based line number of the character at `index` in `text`.
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

// Extract a Rust array of string literals whose declaration is introduced by
// `anchor` (which must end with the array's opening '['). Returns the entries
// plus the 1-based start line (the anchor line) and end line (the line of the
// closing ']') of the declaration. Throws, naming the array, the source and
// the anchor searched for, if the anchor or the closing bracket cannot be
// found - a failed extraction must never look like an empty list.
function extractStringArray(sourceText, anchor, label, sourcePath) {
  const anchorIndex = sourceText.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error(
      `extraction failed for the ${label} array in ${sourcePath}: ` +
        `anchor not found: ${JSON.stringify(anchor)}`
    );
  }
  const openIndex = anchorIndex + anchor.length - 1; // anchor ends with '['
  const entries = [];
  let current = '';
  let inString = false;
  let closeIndex = -1;
  for (let i = openIndex + 1; i < sourceText.length; i += 1) {
    const ch = sourceText[i];
    if (inString) {
      if (ch === '\\' && i + 1 < sourceText.length) {
        current += ch + sourceText[i + 1];
        i += 1;
      } else if (ch === '"') {
        entries.push(current);
        current = '';
        inString = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inString = true;
      current = '';
    } else if (ch === ']') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    throw new Error(
      `extraction failed for the ${label} array in ${sourcePath}: ` +
        `anchor ${JSON.stringify(anchor)} was found but no closing ']' was ` +
        `reached before the end of the file`
    );
  }
  return {
    entries,
    startLine: lineAt(sourceText, anchorIndex),
    endLine: lineAt(sourceText, closeIndex),
  };
}

// --- core comparison -------------------------------------------------------

// Extract both protected-path arrays from the two Rust sources (as text) and
// compute the set difference in both directions. Throws on extraction
// failure; never fabricates an empty difference.
export function protectedPathDrift(
  tableclothSource,
  improveSource,
  tableclothPath = '<clade-tablecloth source>',
  improvePath = '<clade-improve source>'
) {
  const tablecloth = extractStringArray(
    tableclothSource,
    TABLECLOTH_ANCHOR,
    'clade-tablecloth PROTECTED',
    tableclothPath
  );
  const improve = extractStringArray(
    improveSource,
    IMPROVE_ANCHOR,
    'clade-improve guards',
    improvePath
  );
  const tableclothSet = new Set(tablecloth.entries);
  const improveSet = new Set(improve.entries);
  return {
    tablecloth,
    improve,
    onlyInTablecloth: tablecloth.entries.filter((e) => !improveSet.has(e)),
    onlyInImprove: improve.entries.filter((e) => !tableclothSet.has(e)),
  };
}

// --- principle parsing -----------------------------------------------------

// clade-tablecloth numbers its principles in `// Pn - Name: ...` comments
// inside constitution_gate. Returns [{ id, name }] in order of appearance.
function parseTableclothPrinciples(sourceText, sourcePath) {
  const fnIndex = sourceText.indexOf(TABLECLOTH_FN_ANCHOR);
  if (fnIndex === -1) {
    throw new Error(
      `extraction failed for the clade-tablecloth principle comments in ` +
        `${sourcePath}: anchor not found: ${JSON.stringify(TABLECLOTH_FN_ANCHOR)}`
    );
  }
  // Scope the scan to the function body by brace matching (skipping string
  // literals) so comments elsewhere in the file cannot leak in.
  const openBrace = sourceText.indexOf('{', fnIndex);
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < sourceText.length; i += 1) {
    const ch = sourceText[i];
    if (ch === '"') {
      i += 1;
      while (i < sourceText.length && sourceText[i] !== '"') {
        if (sourceText[i] === '\\') i += 1;
        i += 1;
      }
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(
      `extraction failed for the clade-tablecloth principle comments in ` +
        `${sourcePath}: could not find the end of the function introduced by ` +
        `${JSON.stringify(TABLECLOTH_FN_ANCHOR)}`
    );
  }
  const body = sourceText.slice(fnIndex, end + 1);
  const commentRe = /\/\/\s*(P\d+)\s+-\s*([^\n]*)/g;
  const principles = [];
  const seen = new Set();
  let match;
  while ((match = commentRe.exec(body)) !== null) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    // The comment is `// Pn - Name: explanation`; the principle name ends at
    // the first colon (or at the end of the line when there is no colon).
    principles.push({ id: match[1], name: match[2].split(':')[0].trim() });
  }
  if (principles.length === 0) {
    throw new Error(
      `extraction failed for the clade-tablecloth principle comments in ` +
        `${sourcePath}: no \`// Pn - \` comments found inside ` +
        `${JSON.stringify(TABLECLOTH_FN_ANCHOR)}`
    );
  }
  return principles;
}

// clade-improve numbers its principles as `id: "Pn"` struct fields paired
// with the next `name: "..."` field in the Constitution default. Returns
// [{ id, name }] in order of appearance.
function parseImprovePrinciples(sourceText, sourcePath) {
  const principles = [];
  const idRe = /id:\s*"(P\d+)"/g;
  let match;
  while ((match = idRe.exec(sourceText)) !== null) {
    const rest = sourceText.slice(match.index);
    const nameMatch = /name:\s*"((?:[^"\\]|\\.)*)"/.exec(rest);
    if (!nameMatch) {
      throw new Error(
        `extraction failed for the clade-improve principles in ${sourcePath}: ` +
          `found ${JSON.stringify(match[0])} but no following \`name: "..."\` pair`
      );
    }
    principles.push({ id: match[1], name: nameMatch[1] });
  }
  if (principles.length === 0) {
    throw new Error(
      `extraction failed for the clade-improve principles in ${sourcePath}: ` +
        `no \`id: "Pn"\` entries found`
    );
  }
  return principles;
}

// --- blast radius ----------------------------------------------------------

// All tracked .swift/.rs paths whose lowercased form contains the guard word,
// listed by `git ls-files` at run time, split into the paths already caught
// by an entry of the protected list and the unprotected set the gap leaves
// open. No path, count or file name is stored in this script.
function guardNamedFiles(repoRoot, protectedEntries) {
  let listing;
  try {
    listing = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`git ls-files failed in ${repoRoot}: ${err.message}`);
  }
  const tracked = listing
    .split('\n')
    .map((s) => s.replace(/\r$/, ''))
    .filter(Boolean);
  const loweredEntries = protectedEntries.map((e) => e.toLowerCase());
  const covered = [];
  const unprotected = [];
  for (const relPath of tracked) {
    // Worktree siblings and any other path naming a worktrees directory are
    // not this checkout's business; the reference pipeline greps them out.
    if (relPath.includes('worktrees')) continue;
    const lower = relPath.toLowerCase();
    if (!(lower.endsWith('.swift') || lower.endsWith('.rs'))) continue;
    if (!lower.includes(GUARD_WORD)) continue;
    const matched = loweredEntries.find((e) => lower.includes(e));
    if (matched === undefined) {
      unprotected.push(relPath);
    } else {
      covered.push({ relPath, matched });
    }
  }
  return { covered, unprotected };
}

// --- wiring ----------------------------------------------------------------

function resolveRepoRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: scriptDir,
      encoding: 'utf8',
    });
    return out.trim();
  } catch (err) {
    throw new Error(
      `could not resolve the repository root via \`git rev-parse --show-toplevel\` ` +
        `run from ${scriptDir}: ${err.message}`
    );
  }
}

function resolveOverrides(argv, env) {
  const overrides = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tablecloth' || arg === '--improve') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a path value`);
      }
      overrides[arg === '--tablecloth' ? 'tablecloth' : 'improve'] = value;
      i += 1;
    } else {
      throw new Error(
        `unrecognized argument: ${arg} (expected --tablecloth <path> or --improve <path>)`
      );
    }
  }
  if (!overrides.tablecloth && env.CONSTITUTION_DRIFT_TABLECLOTH) {
    overrides.tablecloth = env.CONSTITUTION_DRIFT_TABLECLOTH;
  }
  if (!overrides.improve && env.CONSTITUTION_DRIFT_IMPROVE) {
    overrides.improve = env.CONSTITUTION_DRIFT_IMPROVE;
  }
  return overrides;
}

function main() {
  const out = (line) => process.stdout.write(`${line}\n`);

  let repoRoot;
  let tableclothPath; // absolute path actually read
  let improvePath;
  let tableclothDisplay; // path shown in the report (repo-relative by default)
  let improveDisplay;
  try {
    const overrides = resolveOverrides(process.argv.slice(2), process.env);
    repoRoot = resolveRepoRoot();
    tableclothPath = overrides.tablecloth
      ? path.resolve(process.cwd(), overrides.tablecloth)
      : path.join(repoRoot, TABLECLOTH_REL);
    improvePath = overrides.improve
      ? path.resolve(process.cwd(), overrides.improve)
      : path.join(repoRoot, IMPROVE_REL);
    tableclothDisplay = overrides.tablecloth ? tableclothPath : TABLECLOTH_REL;
    improveDisplay = overrides.improve ? improvePath : IMPROVE_REL;
  } catch (err) {
    fail(err.message);
    return;
  }

  let tableclothSource;
  let improveSource;
  try {
    tableclothSource = readFileSync(tableclothPath, 'utf8');
    improveSource = readFileSync(improvePath, 'utf8');
  } catch (err) {
    fail(`cannot read a source file: ${err.message}`);
    return;
  }

  // Extract everything before printing anything, so a failed extraction can
  // never leave a partial report - let alone an empty difference - behind.
  let drift;
  let tableclothPrinciples;
  let improvePrinciples;
  let blast;
  try {
    drift = protectedPathDrift(
      tableclothSource,
      improveSource,
      tableclothDisplay,
      improveDisplay
    );
    tableclothPrinciples = parseTableclothPrinciples(tableclothSource, tableclothDisplay);
    improvePrinciples = parseImprovePrinciples(improveSource, improveDisplay);
    blast = guardNamedFiles(repoRoot, drift.tablecloth.entries);
  } catch (err) {
    fail(err.message);
    return;
  }

  // ---- extracted lists ----------------------------------------------------
  out('constitution drift audit');
  out(`repository root: ${repoRoot}`);
  out('');
  out('== extracted lists (read from the Rust sources at run time) ==');
  out(
    `clade-tablecloth PROTECTED - ${tableclothDisplay} ` +
      `lines ${drift.tablecloth.startLine}-${drift.tablecloth.endLine} ` +
      `(${drift.tablecloth.entries.length} entries):`
  );
  for (const entry of drift.tablecloth.entries) out(`  ${entry}`);
  out(
    `clade-improve guards - ${improveDisplay} ` +
      `lines ${drift.improve.startLine}-${drift.improve.endLine} ` +
      `(${drift.improve.entries.length} entries):`
  );
  for (const entry of drift.improve.entries) out(`  ${entry}`);
  out(
    `verify: sed -n '${drift.tablecloth.startLine},${drift.tablecloth.endLine}p' ` +
      `${tableclothDisplay}`
  );
  out(
    `verify: sed -n '${drift.improve.startLine},${drift.improve.endLine}p' ` +
      `${improveDisplay}`
  );
  out('');

  // ---- set difference -----------------------------------------------------
  out('== set difference (both directions) ==');
  out(
    `present in clade-improve, absent from clade-tablecloth ` +
      `(clade-improve only): ${drift.onlyInImprove.length} entries`
  );
  if (drift.onlyInImprove.length === 0) out('  (none)');
  for (const entry of drift.onlyInImprove) out(`  ${entry}  (clade-improve only)`);
  out(
    `present in clade-tablecloth, absent from clade-improve ` +
      `(clade-tablecloth only): ${drift.onlyInTablecloth.length} entries`
  );
  if (drift.onlyInTablecloth.length === 0) out('  (none)');
  for (const entry of drift.onlyInTablecloth) out(`  ${entry}  (clade-tablecloth only)`);
  out('');

  // ---- blast radius -------------------------------------------------------
  out(
    '== blast radius: tracked .swift/.rs paths containing "guard" ' +
      '(from git ls-files at run time) =='
  );
  out(
    `already covered - matches an entry of clade-tablecloth's PROTECTED list ` +
      `(${blast.covered.length}):`
  );
  for (const c of blast.covered) out(`  ${c.relPath}  [matched entry: ${c.matched}]`);
  out(
    `unprotected set - contains "guard", matches no PROTECTED entry ` +
      `(${blast.unprotected.length}):`
  );
  for (const p of blast.unprotected) out(`  ${p}`);
  out('');

  // ---- P-number table -----------------------------------------------------
  out('== P-number table (parsed from both sources, not transcribed) ==');
  out(
    `principles parsed from clade-tablecloth ` +
      `(// Pn - comments inside ${TABLECLOTH_FN_ANCHOR}...): ` +
      `${tableclothPrinciples.length}`
  );
  out(
    `principles parsed from clade-improve (id: "Pn" / name: "..." pairs): ` +
      `${improvePrinciples.length}`
  );
  const NOT_DEFINED = '(not defined)';
  const tcById = new Map(tableclothPrinciples.map((p) => [p.id, p.name]));
  const imById = new Map(improvePrinciples.map((p) => [p.id, p.name]));
  const allIds = [
    ...new Set([
      ...tableclothPrinciples.map((p) => p.id),
      ...improvePrinciples.map((p) => p.id),
    ]),
  ].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  const rows = allIds.map((id) => {
    const tc = tcById.get(id) ?? NOT_DEFINED;
    const im = imById.get(id) ?? NOT_DEFINED;
    let verdict;
    if (tc === NOT_DEFINED && im === NOT_DEFINED) verdict = 'missing on both sides';
    else if (tc === NOT_DEFINED) verdict = 'clade-improve only';
    else if (im === NOT_DEFINED) verdict = 'clade-tablecloth only';
    else if (tc !== im) verdict = 'COLLISION';
    else verdict = 'same';
    return { id, tc, im, verdict };
  });
  const pad = (s, w) => (s.length >= w ? s : s + ' '.repeat(w - s.length));
  const wId = Math.max(2, ...rows.map((r) => r.id.length));
  const wTc = Math.max('clade-tablecloth'.length, ...rows.map((r) => r.tc.length));
  const wIm = Math.max('clade-improve'.length, ...rows.map((r) => r.im.length));
  out(`${pad('P#', wId)}  ${pad('clade-tablecloth', wTc)}  ${pad('clade-improve', wIm)}  verdict`);
  for (const r of rows) {
    out(`${pad(r.id, wId)}  ${pad(r.tc, wTc)}  ${pad(r.im, wIm)}  ${r.verdict}`);
  }
  out('');

  // ---- result -------------------------------------------------------------
  const totalDiff = drift.onlyInImprove.length + drift.onlyInTablecloth.length;
  if (totalDiff === 0) {
    out(
      'RESULT: no drift - the symmetric difference is empty in both directions; ' +
        'the protected-path list matches the guard list entry for entry.'
    );
    out('exit status: 0');
    process.exitCode = 0;
  } else {
    out(
      `RESULT: DRIFT - the symmetric difference is non-empty ` +
        `(clade-improve only: ${drift.onlyInImprove.length} entries, ` +
        `clade-tablecloth only: ${drift.onlyInTablecloth.length} entries). ` +
        `The protected-path gate is NOT a subset of the guard list it claims ` +
        `to follow, and ${blast.unprotected.length} tracked guard-named ` +
        `.swift/.rs paths fall outside it.`
    );
    out('exit status: 1');
    process.exitCode = 1;
  }
}

// --- entry point -----------------------------------------------------------

// Compatibility note: real Node's `node --check FILE` parses the file and
// exits without executing it, so a script can never observe that flag. The
// bun-provided `node` shim in the worker container instead executes the file
// and exposes the flag through process.execArgv. Emulate real Node here: an
// invocation as a syntax check means "parse only", and reaching this code
// already proves the module parsed, so exit 0 without running the audit. A
// genuine syntax error would fail inside the shim before this line runs.
if (process.execArgv.includes('--check')) {
  process.exitCode = 0;
} else {
  main();
}
