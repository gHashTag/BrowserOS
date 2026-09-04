#!/usr/bin/env node
/**
 * rust-gate-extension-audit.mjs — dotted-extension predicate audit for trios/rings/RUST-*
 *
 * Origin: gHashTag/trios#1371. `tmp-zero-gate` reports OK on a tree with 90 /tmp
 * references because its extension list carries a leading dot: Rust's
 * `std::path::Path::extension()` returns the extension WITHOUT the dot
 * ("main.rs" -> Some("rs")), so `SOURCE_EXTS.contains(&e)` with
 * `SOURCE_EXTS = [".rs", ".swift"]` can never hold. The gate visits zero files
 * and still exits 0 — the most expensive kind of green.
 *
 * This audit finds every extension predicate in the ring tree (any code that
 * compares a `Path::extension()` value against string literals) and classifies
 * each literal set as dotted / sound / undetermined. It is a static text scan:
 * it runs under `node` with the Node standard library only, never invokes
 * `cargo`, and never edits a Rust file (the worker image has no Rust
 * toolchain, so an edit could not be compiled or tested here).
 *
 * Usage:
 *   node trios/tools/rust-gate-extension-audit.mjs            audit the ring tree
 *   node trios/tools/rust-gate-extension-audit.mjs --selftest build a fixture
 *                                                             (one dotted, one
 *                                                             bare, one opaque
 *                                                             predicate), assert
 *                                                             all three outcomes
 *
 * Exit codes: main run exits 1 when any dotted predicate is found (red is a
 * FINDING), 0 otherwise. Selftest exits 0 on pass, 1 on failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Classification rule — printed on every run (FR-003).
// ---------------------------------------------------------------------------
export const CLASSIFICATION_RULE = [
  'Classification rule:',
  '  Rust std::path::Path::extension() returns the extension WITHOUT its leading',
  '  dot ("main.rs" -> Some("rs")). A predicate that compares that value against a',
  '  literal carrying a leading dot (".rs") can never match; the guarded arm is',
  '  dead, and a gate built on it is inert (visits zero files and still prints OK).',
  '    dotted       at least one compared literal begins with "." — that arm can',
  '                 never match; this is the finding class from trios#1371',
  '    sound        every compared literal is bare (no leading dot); the',
  '                 comparison works as written',
  '    undetermined the compared literal set could not be extracted (compared',
  '                 against a variable or an unresolvable list). Reported with a',
  '                 reason and its own count — never counted as sound.',
].join('\n');

/** How many lines after a `path.extension()` site we scan for its comparison. */
const WINDOW_LINES = 40;

/** An "extension-shaped" literal: short alphanumeric, optional leading dot. */
const EXT_SHAPE = /^\.?[A-Za-z0-9]{1,10}$/;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Split source into 1-based-addressable lines (CRLF tolerant). */
function toLines(text) {
  return text.split(/\r?\n/);
}

/** Extract raw contents of every string literal in a segment of source. */
function extractStringLiterals(segment) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(segment)) !== null) out.push(m[1]);
  return out;
}

/**
 * Collect named literal arrays in a file: `const NAME: &[&str] = &[...]` and
 * `let NAME = [...]` (also `let mut NAME`, `&[...]`). Returns
 * Map<name, { line, literals }>. Multiline arrays are handled by bracket
 * scanning that skips over string literals so brackets inside strings do not
 * confuse the depth count. Declarations whose initializer is not an array
 * literal (e.g. `let x: HashSet<String> = match ...`) are not collected.
 */
function collectNamedArrays(lines) {
  const arrays = new Map();
  const declRe =
    /(?:const|let\s+mut|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]*?)?\s*=\s*&?\s*(?=\[)/g;
  for (let i = 0; i < lines.length; i++) {
    declRe.lastIndex = 0;
    let m;
    while ((m = declRe.exec(lines[i])) !== null) {
      const name = m[1];
      // Find the opening '[' after the match position on this line.
      const openCol = lines[i].indexOf('[', m.index + m[0].length - 1);
      if (openCol === -1) continue;
      const scanned = scanBracketed(lines, i, openCol);
      if (!scanned) continue;
      arrays.set(name, { name, line: i + 1, literals: extractStringLiterals(scanned.body) });
    }
  }
  return arrays;
}

/**
 * Scan a `[ ... ]` region starting at lines[startLine][openCol]. Skips string
 * literals so brackets inside them do not affect depth. Returns
 * { body, endLine } or null if unterminated within the file.
 */
function scanBracketed(lines, startLine, openCol) {
  let depth = 0;
  let body = '';
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    const from = i === startLine ? openCol : 0;
    let closedAt = -1;
    for (let c = from; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"') {
        // consume the whole string literal
        let k = c + 1;
        while (k < line.length) {
          if (line[k] === '\\') { k += 2; continue; }
          if (line[k] === '"') break;
          k++;
        }
        c = k;
        continue;
      }
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) { closedAt = c; break; }
      }
    }
    if (closedAt >= 0) {
      body += line.slice(from, closedAt);
      return { body, endLine: i };
    }
    body += line.slice(from) + ' ';
  }
  return null;
}

/** All `id == "lit"` / `"lit" == id` / `id != "lit"` literals for the given ids. */
function collectEqLiterals(text, ids) {
  const found = [];
  for (const v of ids) {
    const id = escapeRe(v);
    const rx1 = new RegExp('\\b' + id + '\\b\\s*(?:==|!=)\\s*"((?:[^"\\\\]|\\\\.)*)"', 'g');
    const rx2 = new RegExp('"((?:[^"\\\\]|\\\\.)*)"\\s*(?:==|!=)\\s*\\b' + id + '\\b', 'g');
    let m;
    while ((m = rx1.exec(text)) !== null) found.push(m[1]);
    while ((m = rx2.exec(text)) !== null) found.push(m[1]);
  }
  return found;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/**
 * extensionPredicateHazards(files) — classify every extension predicate.
 *
 * files: [{ path, text }] — virtual Rust source files (path is used only for
 * reporting). Returns { findings, counts, scanned } where each finding is:
 *   {
 *     file, line,              // site of the `path.extension()` call (1-based)
 *     kind,                    // 'dotted' | 'sound' | 'undetermined'
 *     reason,                  // set for 'undetermined'
 *     literals: [{ value, line, listName?, listLine? }],
 *     lists: [{ name, line, literals }],  // resolved literal arrays used here
 *     summary                  // short human-readable evidence string
 *   }
 * and counts is { dotted, sound, undetermined } (FR-004: undetermined is its
 * own outcome and count).
 */
export function extensionPredicateHazards(files) {
  const findings = [];
  for (const file of files) {
    findings.push(...analyzeFile(file.path, file.text));
  }
  const counts = { dotted: 0, sound: 0, undetermined: 0 };
  for (const f of findings) counts[f.kind] += 1;
  const order = { dotted: 0, undetermined: 1, sound: 2 };
  findings.sort((a, b) => order[a.kind] - order[b.kind] || a.file.localeCompare(b.file) || a.line - b.line);
  return { findings, counts, scanned: files.length };
}

function analyzeFile(filePath, text) {
  const lines = toLines(text);
  const arrays = collectNamedArrays(lines);
  const out = [];

  // Every line containing a `path.extension()` call anchors one predicate.
  const siteLines = [];
  lines.forEach((line, idx) => {
    if (line.includes('.extension()')) siteLines.push(idx);
  });

  siteLines.forEach((siteIdx, n) => {
    const siteLine = lines[siteIdx];
    const nextSite = n + 1 < siteLines.length ? siteLines[n + 1] : lines.length;
    const winEnd = Math.min(siteIdx + WINDOW_LINES, nextSite - 1);

    // --- identifiers that may hold the extension value ---------------------
    const siteValueIds = new Set(); // closure params bound on the site line
    const paramRe = /\|\s*([a-z_][a-z0-9_]*)\s*\|/g;
    let pm;
    while ((pm = paramRe.exec(siteLine)) !== null) siteValueIds.add(pm[1]);

    let boundVar = null;
    let letM = siteLine.match(/\blet\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (letM) boundVar = letM[1];
    if (!boundVar) {
      const ifLetM = siteLine.match(/\bif\s+let\s+Some\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*=/);
      if (ifLetM) boundVar = ifLetM[1];
    }

    // The site line may start a `match <extension expr> { ... }`; its arm
    // bindings (e.g. `Some(e) if LIST.contains(&e) =>`) hold the value too.
    const startsMatch = /\bmatch\b.*\.extension\(\)/.test(siteLine);

    const literals = [];   // { value, line, listName?, listLine? }
    const lists = new Map(); // resolved literal arrays used by this predicate
    const unresolved = []; // contains() receivers we could not resolve

    // `Some(x)` arm bindings on the site line itself (single-line matches):
    // `match p.extension() { Some(e) if LIST.contains(&e) => ... }`
    const siteSomeIds = new Set();
    if (startsMatch) {
      const someIdRe = /\bSome\(\s*&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
      let s0;
      while ((s0 = someIdRe.exec(siteLine)) !== null) siteSomeIds.add(s0[1]);
    }

    /** Membership evidence on one line: `LIST.contains(&id)` for our ids. */
    const collectContains = (line, ids, lineNo) => {
      const containsRe = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*contains\(\s*&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
      let cm;
      while ((cm = containsRe.exec(line)) !== null) {
        const [, receiver, arg] = cm;
        if (!ids.has(arg)) continue; // not our value
        const arr = arrays.get(receiver);
        if (!arr) {
          unresolved.push({ receiver, line: lineNo });
          continue;
        }
        const extish = arr.literals.filter((v) => EXT_SHAPE.test(v));
        if (extish.length === 0) continue; // a literal array, but not extension-shaped
        lists.set(receiver, arr);
        for (const v of extish) {
          literals.push({ value: v, line: lineNo, listName: receiver, listLine: arr.line });
        }
      }
    };

    // --- evidence on the site line itself -----------------------------------
    const siteIds = new Set([...siteValueIds, ...siteSomeIds]);
    if (boundVar) siteIds.add(boundVar);
    pushLiterals(collectEqLiterals(siteLine, siteIds), siteIdx + 1, literals);
    // direct Option comparison: `path.extension()... == Some("json")`
    const someRe = /(?:==|!=)\s*Some\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
    let sm;
    while ((sm = someRe.exec(siteLine)) !== null) {
      literals.push({ value: sm[1], line: siteIdx + 1 });
    }
    collectContains(siteLine, siteIds, siteIdx + 1);

    // --- evidence in the window after the site ------------------------------
    const windowSomeIds = new Set();
    let inMatchArms = false;
    for (let i = siteIdx + 1; i <= winEnd && i < lines.length; i++) {
      const line = lines[i];

      // The bound variable is rebound — this window no longer tracks our value.
      if (boundVar && new RegExp('\\blet\\s+(?:mut\\s+)?' + escapeRe(boundVar) + '\\b').test(line)) break;

      if (startsMatch) {
        const someM = line.match(/\bSome\(\s*&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
        if (someM) windowSomeIds.add(someM[1]);
      }

      // eq comparisons against the bound variable / match-arm bindings
      const windowIds = new Set([...(boundVar ? [boundVar] : []), ...windowSomeIds]);
      pushLiterals(collectEqLiterals(line, windowIds), i + 1, literals);

      // `match ext { "md" => ..., "swift" | "rs" => ... }`
      if (boundVar && new RegExp('\\bmatch\\s+' + escapeRe(boundVar) + '\\s*\\{').test(line)) {
        inMatchArms = true;
      }
      if (inMatchArms) {
        const armRe = /"((?:[^"\\]|\\.)*)"\s*(?:\|\s*"(?:[^"\\]|\\.)*"\s*)*=>/g;
        let am;
        while ((am = armRe.exec(line)) !== null) {
          for (const v of extractStringLiterals(am[0])) {
            literals.push({ value: v, line: i + 1 });
          }
        }
        if (/^\s*\}\s*;?\s*$/.test(line)) inMatchArms = false;
      }

      // membership tests: `LIST.contains(&e)` where e holds the extension.
      collectContains(line, new Set([...windowIds, ...siteIds]), i + 1);
    }

    // --- classify -------------------------------------------------------------
    let kind, reason = '';
    if (literals.length > 0) {
      kind = literals.some((l) => l.value.startsWith('.')) ? 'dotted' : 'sound';
    } else {
      kind = 'undetermined';
      reason = unresolved.length > 0
        ? `membership receiver '${unresolved[0].receiver}' (line ${unresolved[0].line}) could not be resolved to a literal array`
        : 'no extension string literal found in the comparison window — the value is compared against a non-literal or used opaquely';
    }

    out.push({
      file: filePath,
      line: siteIdx + 1,
      kind,
      reason,
      literals,
      lists: [...lists.values()],
      summary: summarize(literals),
    });
  });

  return out;
}

function pushLiterals(values, line, into) {
  for (const v of values) into.push({ value: v, line });
}

function summarize(literals) {
  const uniq = [...new Set(literals.map((l) => l.value))];
  return uniq.length > 0 ? uniq.map((v) => `"${v}"`).join(' | ') : '(no literals)';
}

// ---------------------------------------------------------------------------
// File collection (scope: trios/rings/RUST-*, excluding the trios-mesh
// submodule — FR-002; build directories are skipped as noise)
// ---------------------------------------------------------------------------

export function collectRustFiles(rootDir) {
  const ringsDir = path.join(rootDir, 'rings');
  const files = [];
  let ringDirs;
  try {
    ringDirs = fs.readdirSync(ringsDir, { withFileTypes: true });
  } catch {
    return files;
  }
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const rel = path.relative(ringsDir, p).split(path.sep);
      if (rel.includes('trios-mesh')) continue; // git submodule, unreachable here
      if (e.isDirectory()) {
        if (e.name === 'target' || e.name === '.git') continue;
        walk(p);
      } else if (e.isFile() && e.name.endsWith('.rs')) {
        files.push(p);
      }
    }
  };
  for (const ent of ringDirs) {
    if (ent.isDirectory() && ent.name.startsWith('RUST-')) walk(path.join(ringsDir, ent.name));
  }
  return files;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function relFromTriosRoot(absPath, displayRoot) {
  return path.relative(displayRoot, absPath).split(path.sep).join('/');
}

function render(result, displayRoot) {
  const L = [];
  L.push('rust-gate-extension-audit — extension-predicate reachability for trios/rings/RUST-*');
  L.push('(gHashTag/trios#1371: a dotted extension list makes path.extension() comparisons dead)');
  L.push('');
  L.push(CLASSIFICATION_RULE);
  L.push('');
  L.push('Scope: trios/rings/RUST-* Rust sources, excluding the RUST-13/trios-mesh git submodule.');
  L.push('Runtime: node with the Node standard library only; cargo is never invoked.');
  L.push(`Scanned ${result.scanned} Rust files; found ${result.findings.length} extension predicates.`);
  L.push('');

  const dotted = result.findings.filter((f) => f.kind === 'dotted');
  const undetermined = result.findings.filter((f) => f.kind === 'undetermined');
  const sound = result.findings.filter((f) => f.kind === 'sound');

  L.push(`DOTTED (${dotted.length}) — the comparison can never match; the guarded code path is dead:`);
  if (dotted.length === 0) L.push('  (none)');
  for (const f of dotted) {
    const file = relFromTriosRoot(f.file, displayRoot);
    L.push(`  ${file}:${f.line}  [dotted]`);
    for (const list of f.lists) {
      L.push(`      list ${list.name} declared at ${file}:${list.line} = [${list.literals.map((v) => `"${v}"`).join(', ')}]`);
      const bare = list.literals.map((v) => `"${v.replace(/^\./, '')}"`).join(', ');
      L.push(`      repair (one line): ${file}:${list.line}  drop the leading dots -> [${bare}]`);
    }
    const inlineDotted = [...new Set(f.literals.filter((l) => l.value.startsWith('.') && !l.listName).map((l) => l.value))];
    if (inlineDotted.length > 0) {
      L.push(`      dotted literals compared inline: ${inlineDotted.map((v) => `"${v}"`).join(' | ')} (drop the leading dots)`);
    }
    L.push(`      NOT repaired here: this worker image has no Rust toolchain (no rustc/cargo),`);
    L.push(`      so the change could not be compiled or tested. See trios/docs/rust-gate-reach.md.`);
  }
  L.push('');

  L.push(`UNDETERMINED (${undetermined.length}) — could not classify; never counted as sound:`);
  if (undetermined.length === 0) L.push('  (none)');
  for (const f of undetermined) {
    L.push(`  ${relFromTriosRoot(f.file, displayRoot)}:${f.line}  [undetermined] ${f.reason}`);
  }
  L.push('');

  L.push(`SOUND (${sound.length}) — bare literals; the comparison works as written:`);
  for (const f of sound) {
    L.push(`  ${relFromTriosRoot(f.file, displayRoot)}:${f.line}  [sound]      ${f.summary}`);
  }
  L.push('');

  L.push(`counts: dotted=${result.counts.dotted} sound=${result.counts.sound} undetermined=${result.counts.undetermined}`);
  L.push('exit code: 1 while any dotted predicate exists (red is a FINDING), 0 otherwise.');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Selftest — builds a fixture with one dotted, one bare, and one opaque
// (unclassifiable) predicate, plus a trios-mesh directory that must be
// excluded, then asserts all three outcomes and the exclusion.
// ---------------------------------------------------------------------------

function selftest() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-gate-ext-audit-'));
  let failed = 0;
  const check = (name, cond) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
    if (!cond) failed += 1;
  };
  try {
    const mk = (rel) => fs.mkdirSync(path.join(fixtureRoot, rel), { recursive: true });
    mk('rings/RUST-TST/dotted-gate/src');
    mk('rings/RUST-TST/bare-gate/src');
    mk('rings/RUST-TST/opaque-gate/src');
    mk('rings/RUST-TST/trios-mesh/src'); // must be excluded (FR-002)

    // 1. dotted — the tmp-zero-gate shape, verbatim mechanism.
    fs.writeFileSync(
      path.join(fixtureRoot, 'rings/RUST-TST/dotted-gate/src/main.rs'),
      [
        'use std::path::Path;',
        '',
        'const SOURCE_EXTS: &[&str] = &[".rs", ".swift"];',
        '',
        'fn is_source(p: &Path) -> bool {',
        '    let ext = match p.extension().and_then(|s| s.to_str()) {',
        '        Some(e) if SOURCE_EXTS.contains(&e) => e,',
        '        _ => return false,',
        '    };',
        '    !ext.is_empty()',
        '}',
        '',
      ].join('\n'),
    );

    // 2. bare — the same gate written correctly.
    fs.writeFileSync(
      path.join(fixtureRoot, 'rings/RUST-TST/bare-gate/src/main.rs'),
      [
        'use std::path::Path;',
        '',
        'fn is_source(p: &Path) -> bool {',
        '    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");',
        '    ext == "rs" || ext == "swift"',
        '}',
        '',
      ].join('\n'),
    );

    // 3. opaque — compared against a variable: no literal set to classify.
    fs.writeFileSync(
      path.join(fixtureRoot, 'rings/RUST-TST/opaque-gate/src/main.rs'),
      [
        'use std::path::Path;',
        '',
        'fn matches_wanted(p: &Path, wanted: &str) -> bool {',
        '    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");',
        '    ext == wanted',
        '}',
        '',
      ].join('\n'),
    );

    // 4. inside the trios-mesh submodule — dotted, but out of scope.
    fs.writeFileSync(
      path.join(fixtureRoot, 'rings/RUST-TST/trios-mesh/src/lib.rs'),
      [
        'use std::path::Path;',
        '',
        'const EXTS: &[&str] = &[".rs"];',
        '',
        'pub fn is_src(p: &Path) -> bool {',
        '    match p.extension().and_then(|s| s.to_str()) {',
        '        Some(e) if EXTS.contains(&e) => true,',
        '        _ => false,',
        '    }',
        '}',
        '',
      ].join('\n'),
    );

    console.log('rust-gate-extension-audit --selftest');
    console.log(`fixture: ${fixtureRoot}`);
    const files = collectRustFiles(fixtureRoot).map((p) => ({
      path: p,
      text: fs.readFileSync(p, 'utf8'),
    }));
    const result = extensionPredicateHazards(files);

    check('fixture walks exactly 3 files (trios-mesh excluded)', files.length === 3);
    check('no scanned path contains trios-mesh', files.every((f) => !f.path.includes('trios-mesh')));
    check(`counts.dotted === 1 (got ${result.counts.dotted})`, result.counts.dotted === 1);
    check(`counts.sound === 1 (got ${result.counts.sound})`, result.counts.sound === 1);
    check(`counts.undetermined === 1 (got ${result.counts.undetermined})`, result.counts.undetermined === 1);

    const dotted = result.findings.find((f) => f.kind === 'dotted');
    check('dotted finding is dotted-gate/src/main.rs', !!dotted && dotted.file.endsWith('dotted-gate/src/main.rs'));
    check('dotted finding reports the SOURCE_EXTS list line',
      !!dotted && dotted.lists.some((l) => l.name === 'SOURCE_EXTS' && l.line === 3));
    check('dotted finding names the dotted literals',
      !!dotted && dotted.literals.some((l) => l.value === '.rs') && dotted.literals.some((l) => l.value === '.swift'));

    const undet = result.findings.find((f) => f.kind === 'undetermined');
    check('undetermined finding is opaque-gate/src/main.rs with a reason',
      !!undet && undet.file.endsWith('opaque-gate/src/main.rs') && undet.reason.length > 0);

    const snd = result.findings.find((f) => f.kind === 'sound');
    check('sound finding is bare-gate/src/main.rs with bare literals',
      !!snd && snd.file.endsWith('bare-gate/src/main.rs') && snd.literals.every((l) => !l.value.startsWith('.')));

    console.log('');
    if (failed === 0) {
      console.log('selftest OK: one dotted, one sound, one undetermined; trios-mesh excluded.');
      return 0;
    }
    console.log(`selftest FAILED: ${failed} assertion(s) failed.`);
    return 1;
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const triosRoot = path.resolve(scriptDir, '..');
  const displayRoot = path.resolve(triosRoot, '..'); // print paths as trios/rings/...

  const files = collectRustFiles(triosRoot).map((p) => ({
    path: p,
    text: fs.readFileSync(p, 'utf8'),
  }));
  const result = extensionPredicateHazards(files);
  console.log(render(result, displayRoot));
  return result.counts.dotted > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest());
  }
  process.exit(main());
}
