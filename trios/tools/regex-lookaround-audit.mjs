// regex-lookaround-audit.mjs
//
// Detects regex string literals in the Rust ring sources that the Rust
// `regex` crate cannot compile (look-around assertions and numeric
// backreferences) and reports what the call site that compiles them does
// with the parse error.
//
// Why this exists: clade-audit declares an error-handling pattern table and
// compiles it through a filter_map chain that ends in `.ok()`. One declared
// pattern uses `(?!`, which the regex crate rejects; `.ok()` silently
// discards the parse error, and the auditor banner still claims the check
// ran. A dropped rule and an empty result are indistinguishable in every
// output the auditor produces. This tool makes the difference visible
// without compiling anything: it scans the literal text of every Rust
// string literal in the ring tree.
//
// Dispositions:
//   swallowed  - the parse error is discarded (`.ok()`, a filter_map chain
//                ending in `.ok()`, or an `Err` arm that prints nothing)
//   reported   - the parse error is printed (an `Err(e)` arm with eprintln!)
//   panicking  - the parse error aborts the process (`.unwrap()` / `.expect()`)
//
// Usage:
//   node trios/tools/regex-lookaround-audit.mjs            # audit the ring tree
//   node trios/tools/regex-lookaround-audit.mjs --selftest # run inline fixtures
//
// Exit codes: 0 = nothing swallowed (clean tree, or every unsupported
// literal is already visible at its call site), 1 = at least one swallowed
// unsupported literal (this red is the finding, not a tool failure),
// 2 = the tool could not run.
//
// Node standard library only. No compilation, no external processes.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Unsupported-syntax detection
// ---------------------------------------------------------------------------

// Map a regex literal to the list of constructs the Rust `regex` crate
// cannot compile: look-around `(?=` / `(?!` / `(?<=` / `(?<!` and numeric
// backreferences `\1` .. `\9`. Deliberately NOT flagged because the crate
// supports them: non-capturing groups `(?:`, inline flags such as `(?i)`,
// and named groups `(?P<name>` / `(?<name>`.
export function unsupportedRegexSyntax(literalText) {
  const hits = [];
  for (let i = 0; i < literalText.length; i++) {
    const ch = literalText[i];
    if (ch === '(' && literalText[i + 1] === '?') {
      const c = literalText[i + 2];
      if (c === '=') {
        hits.push({ at: i, construct: '(?=', kind: 'lookahead', label: 'positive lookahead' });
        i += 2;
      } else if (c === '!') {
        hits.push({ at: i, construct: '(?!', kind: 'lookahead', label: 'negative lookahead' });
        i += 2;
      } else if (c === '<') {
        const d = literalText[i + 3];
        if (d === '=') {
          hits.push({ at: i, construct: '(?<=', kind: 'lookbehind', label: 'positive lookbehind' });
          i += 3;
        } else if (d === '!') {
          hits.push({ at: i, construct: '(?<!', kind: 'lookbehind', label: 'negative lookbehind' });
          i += 3;
        }
        // `(?<name>` and `(?P<name>` are named groups: supported, not flagged.
      }
    } else if (ch === '\\') {
      const d = literalText[i + 1];
      if (d >= '1' && d <= '9') {
        hits.push({ at: i, construct: '\\' + d, kind: 'backreference', label: 'numeric backreference' });
      }
      i++; // consume the escaped character so `\\1` (literal backslash) is not misread
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Rust source tokenisation (comments, string literals, char literals)
// ---------------------------------------------------------------------------

const IDENT_CHAR = /[A-Za-z0-9_]/;

// If a string literal starts at index `i`, return a token descriptor
// { start, end, text, raw }; otherwise null. Handles normal strings
// ("..." and byte strings b"...") and raw strings (r"...", r#"..."#,
// br#"..."#). Normal-string content is decoded for \\ and \" so the text is
// inspected the way the regex engine would receive it; raw strings are taken
// verbatim.
function tryStringToken(source, i) {
  const ch = source[i];
  if (ch === '"') return normalStringToken(source, i, i + 1);
  if (ch !== 'r' && ch !== 'b') return null;
  const prev = i > 0 ? source[i - 1] : '';
  if (IDENT_CHAR.test(prev)) return null; // tail of an identifier, not a prefix
  for (const prefix of ['br', 'b', 'r']) {
    if (!source.startsWith(prefix, i)) continue;
    let j = i + prefix.length;
    let hashes = 0;
    while (source[j] === '#') {
      hashes++;
      j++;
    }
    if (source[j] !== '"') continue;
    if (prefix === 'b') return normalStringToken(source, i, j + 1);
    const closer = '"' + '#'.repeat(hashes);
    const closeIdx = source.indexOf(closer, j + 1);
    if (closeIdx === -1) {
      return { start: i, end: source.length, text: source.slice(j + 1), raw: true };
    }
    return { start: i, end: closeIdx + closer.length, text: source.slice(j + 1, closeIdx), raw: true };
  }
  return null;
}

function normalStringToken(source, start, openQuoteEnd) {
  let j = openQuoteEnd;
  let text = '';
  while (j < source.length) {
    const c = source[j];
    if (c === '\\') {
      const d = source[j + 1];
      if (d === '\\') text += '\\';
      else if (d === '"') text += '"';
      else text += c + (d === undefined ? '' : d);
      j += 2;
      continue;
    }
    if (c === '"') return { start, end: j + 1, text, raw: false };
    text += c;
    j++;
  }
  return { start, end: source.length, text, raw: false }; // unterminated: tolerate
}

function skipComment(source, i) {
  if (source.startsWith('//', i)) {
    const nl = source.indexOf('\n', i);
    return nl === -1 ? source.length : nl + 1;
  }
  // Rust block comments nest.
  let depth = 1;
  let j = i + 2;
  while (j < source.length) {
    if (source.startsWith('/*', j)) {
      depth++;
      j += 2;
    } else if (source.startsWith('*/', j)) {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else {
      j++;
    }
  }
  return source.length;
}

// Char literals ('x', '\n', '\'', '\\') are consumed so their payload is
// never scanned as code; lifetimes and labels are stepped over harmlessly.
function skipCharOrLifetime(source, i) {
  if (source[i + 1] === '\\') {
    let j = i + 2;
    if (source[j] === '\\') j++;
    if (source[j] === "'") return j + 1;
    return i + 1;
  }
  if (source[i + 2] === "'") return i + 3;
  return i + 1;
}

// Skip any comment / string / char token starting at i; -1 when none does.
function skipRustToken(source, i) {
  const s = tryStringToken(source, i);
  if (s) return s.end;
  const c = source[i];
  if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) return skipComment(source, i);
  if (c === "'") return skipCharOrLifetime(source, i);
  return -1;
}

// Every string literal in the source, in order.
function extractStringLiterals(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    const tok = tryStringToken(source, i);
    if (tok) {
      out.push(tok);
      i = tok.end;
      continue;
    }
    const c = source[i];
    if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      i = skipComment(source, i);
      continue;
    }
    if (c === "'") {
      i = skipCharOrLifetime(source, i);
      continue;
    }
    i++;
  }
  return out;
}

function lineIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ---------------------------------------------------------------------------
// Regex::new call sites and their error disposition
// ---------------------------------------------------------------------------

// Index of the bracket matching source[openIdx], or -1. String literals and
// comments are skipped so brackets inside them (e.g. r"as!\s*\[") do not count.
function matchBracket(source, openIdx, closeCh) {
  const openCh = source[openIdx];
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const skipped = skipRustToken(source, i);
    if (skipped > i) {
      i = skipped - 1;
      continue;
    }
    const c = source[i];
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const WINDOW_LIMIT = 4000; // characters of call-site context examined

// End of the statement or block expression that owns the call: the first `;`
// at bracket depth 0, or the point where depth goes negative (the call was
// the tail of an enclosing block, e.g. inside a filter_map closure).
function statementEnd(source, from) {
  const limit = Math.min(source.length, from + WINDOW_LIMIT);
  let depth = 0;
  for (let i = from; i < limit; i++) {
    const skipped = skipRustToken(source, i);
    if (skipped > i) {
      i = skipped - 1;
      continue;
    }
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (c === ';' && depth === 0) {
      return i;
    }
  }
  return limit;
}

function findRegexNewCallSites(source, starts) {
  const sites = [];
  const finder = /Regex\s*::\s*new\s*\(/g;
  let m;
  while ((m = finder.exec(source)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchBracket(source, openParen, ')');
    sites.push({
      start: m.index,
      closeParen: closeParen === -1 ? source.length : closeParen,
      line: lineOf(starts, m.index),
      windowEnd: statementEnd(source, m.index),
    });
  }
  return sites;
}

const ERR_ARM = /Err\s*\(\s*(?:_|\w+)\s*\)/;
const PRINTS_ERROR = /(?:eprintln|println)!/;
const PANICS_ON_ERROR = /\.expect\s*\(|\.unwrap\s*\(/;
const DISCARDS_ERROR = /\.ok\s*\(/;

// Classify what happens to a parse error at this call site. Only a
// swallowed parse error is invisible to the operator.
function classifyCallSite(window) {
  if (ERR_ARM.test(window)) {
    if (PRINTS_ERROR.test(window)) {
      return { disposition: 'reported', reason: 'the Err arm prints the parse error' };
    }
    return { disposition: 'swallowed', reason: 'the Err arm returns without printing the parse error' };
  }
  if (PANICS_ON_ERROR.test(window)) {
    return { disposition: 'panicking', reason: '.unwrap()/.expect() turns the parse error into a panic' };
  }
  if (DISCARDS_ERROR.test(window)) {
    return { disposition: 'swallowed', reason: '.ok() discards the parse error' };
  }
  return { disposition: 'unknown', reason: 'no recognisable error handling near the call site' };
}

// Which Regex::new call consumes this literal? The literal may live in a
// pattern table far above the loop that compiles it, so: (1) a call whose
// argument span contains the literal wins; (2) otherwise the next call after
// the literal (the table -> filter_map shape); (3) otherwise the last call
// before it; (4) otherwise no association.
function associateCallSite(lit, sites) {
  for (const s of sites) {
    if (s.start <= lit.start && lit.end <= s.closeParen) return s;
  }
  for (const s of sites) {
    if (s.start >= lit.end) return s;
  }
  let last = null;
  for (const s of sites) {
    if (s.closeParen <= lit.start) last = s;
  }
  return last;
}

// Analyse one Rust source: every string literal is checked (the offending
// pattern lives in a table, not at a call site, so scanning only
// Regex::new arguments would find nothing - the false green this tool exists
// to expose). Each unsupported literal is paired with the call site that
// consumes it and that site's disposition.
function analyseSource(source) {
  const starts = lineIndex(source);
  const literals = extractStringLiterals(source);
  const sites = findRegexNewCallSites(source, starts);
  const records = [];
  for (const lit of literals) {
    const hits = unsupportedRegexSyntax(lit.text);
    if (hits.length === 0) continue;
    const site = associateCallSite(lit, sites);
    const cls = site
      ? classifyCallSite(source.slice(site.start, site.windowEnd))
      : { disposition: 'unknown', reason: 'no Regex::new call site found in this file' };
    records.push({
      line: lineOf(starts, lit.start),
      pattern: lit.text,
      hits,
      siteLine: site ? site.line : null,
      disposition: cls.disposition,
      reason: cls.reason,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Declared-vs-compiled count for the error_handling_check pattern table
// ---------------------------------------------------------------------------

// Split a `vec![ ... ]` body on top-level commas. Brackets inside string
// literals (r"as!\s*\[") and nested groups do not split elements.
function splitTopLevel(source, open, close) {
  const parts = [];
  let depth = 1; // inside the vec brackets
  let partStart = open + 1;
  for (let i = open + 1; i < close; i++) {
    const skipped = skipRustToken(source, i);
    if (skipped > i) {
      i = skipped - 1;
      continue;
    }
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 1) {
      parts.push(source.slice(partStart, i));
      partStart = i + 1;
    }
  }
  if (partStart < close) parts.push(source.slice(partStart, close));
  return parts.filter((p) => p.trim().length > 0);
}

// A table element declares a pattern when it contains at least one string
// literal; the first literal is the pattern. It compiles when it contains no
// unsupported construct.
function countTableElements(source, open, close) {
  let declared = 0;
  let compiled = 0;
  for (const part of splitTopLevel(source, open, close)) {
    const literals = extractStringLiterals(part);
    if (literals.length === 0) continue;
    declared++;
    if (unsupportedRegexSyntax(literals[0].text).length === 0) compiled++;
  }
  return { declared, compiled };
}

// Parse the error_handling_check function's pattern table out of the source
// and count how many patterns are declared and how many would compile. Both
// numbers are derived from the parsed table, never written as constants:
// adding a pattern to the table changes the declared count without touching
// this tool. Empty vec![] initialisers inside the function are skipped.
function countErrorHandlingTable(source) {
  let anchor = source.indexOf('fn error_handling_check');
  if (anchor === -1) anchor = source.indexOf('error_handling_check');
  if (anchor === -1) return null;
  const starts = lineIndex(source);
  const finder = /vec!\s*\[/g;
  finder.lastIndex = anchor;
  let m;
  while ((m = finder.exec(source)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(source, open, ']');
    if (close === -1) return null;
    const counted = countTableElements(source, open, close);
    if (counted.declared > 0) {
      counted.tableLine = lineOf(starts, open);
      return counted;
    }
    finder.lastIndex = close + 1; // empty `vec![]`: keep looking for the table
  }
  return null;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['target', '.build', '.git', '.worktrees', 'node_modules']);
const RING_EXCLUDE = 'RUST-13'; // holds the mesh submodule; skipped entirely

// Derive the file list from the filesystem: every .rs file under a
// trios/rings/RUST-* directory, skipping RUST-13 and any path that crosses
// target/, .build/, .git/, .worktrees/ or node_modules/. Nothing about the
// expected set of files is hard-coded.
function collectRingSources(ringsDir) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === RING_EXCLUDE || SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.rs')) found.push(full);
    }
  };
  walk(ringsDir);
  return found
    .filter((f) => relative(ringsDir, f).split(sep)[0].startsWith('RUST-'))
    .sort();
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function toPosix(p) {
  return p.split(sep).join('/');
}

function runAudit() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const ringsDir = join(root, 'trios', 'rings');
  const files = collectRingSources(ringsDir);
  if (files.length === 0) {
    console.error(`regex-lookaround-audit: no .rs sources found under ${toPosix(relative(root, ringsDir))}/RUST-*`);
    return 2;
  }
  console.log('regex-lookaround-audit: scanning ring sources for regex literals the Rust regex crate cannot compile');
  console.log(
    `scanned ${files.length} .rs files under ${toPosix(relative(root, ringsDir))}/RUST-* ` +
      `(skipping ${RING_EXCLUDE} and target/.build/.git/.worktrees/node_modules paths)`
  );

  const records = [];
  let table = null;
  let tableFile = null;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const rec of analyseSource(source)) {
      rec.file = toPosix(relative(root, file));
      records.push(rec);
    }
    if (!table) {
      const t = countErrorHandlingTable(source);
      if (t) {
        table = t;
        tableFile = toPosix(relative(root, file));
      }
    }
  }

  if (table) {
    const loc = tableFile + (table.tableLine ? `:${table.tableLine}` : '');
    console.log(`error_handling_check pattern table (${loc}): declared=${table.declared} compiled=${table.compiled}`);
    if (table.compiled < table.declared) {
      console.log(`  -> ${table.declared - table.compiled} declared pattern(s) cannot compile and never run`);
    }
  } else {
    console.log('error_handling_check pattern table: not found in the scanned sources');
  }

  const tally = { swallowed: 0, reported: 0, panicking: 0, unknown: 0 };
  records.forEach((rec, n) => {
    tally[rec.disposition] += 1;
    console.log(`--- unsupported regex literal ${n + 1} ---`);
    console.log(`file: ${rec.file}:${rec.line}`);
    console.log(`pattern: ${rec.pattern}`);
    console.log(`unsupported: ${rec.hits.map((h) => `${h.label} ${h.construct}`).join(', ')}`);
    console.log(
      `call site: ${rec.siteLine !== null ? `${rec.file}:${rec.siteLine} (Regex::new)` : 'none found in this file'}`
    );
    console.log(`disposition: ${rec.disposition} (${rec.reason})`);
  });

  console.log(
    `summary: ${records.length} unsupported regex literal(s): ` +
      `${tally.swallowed} swallowed, ${tally.reported} reported, ${tally.panicking} panicking, ${tally.unknown} unknown`
  );
  if (tally.swallowed > 0) {
    console.log('finding: a swallowed literal means a declared rule never compiled and nothing reported the drop');
    return 1;
  }
  return 0;
}

function runSelftest() {
  const fixtures = [
    {
      name: 'supported literal (flags, named and non-capturing groups are not flagged)',
      source: String.raw`fn f() { let re = Regex::new(r"(?i)(?P<name>\w+)(?:x)(?<other>y)").expect("ok"); }`,
      expect: (records) => records.length === 0,
    },
    {
      name: 'swallowed unsupported literal (negative lookahead at a .ok() site)',
      source: String.raw`fn f() { let re = Regex::new(r"a(?!b)").ok(); }`,
      expect: (records) =>
        records.length === 1 &&
        records[0].disposition === 'swallowed' &&
        records[0].hits.some((h) => h.construct === '(?!'),
    },
    {
      name: 'reported unsupported literal (lookbehind, Err arm prints)',
      source: [
        'fn f() {',
        '    let re = match Regex::new(r"(?<=x)y") {',
        '        Ok(re) => re,',
        '        Err(e) => { eprintln!("[audit] Bad regex: {}", e); }',
        '    };',
        '}',
      ].join('\n'),
      expect: (records) =>
        records.length === 1 &&
        records[0].disposition === 'reported' &&
        records[0].hits.some((h) => h.construct === '(?<=' ),
    },
    {
      name: 'backreference literal flagged',
      source: String.raw`fn f() { let re = Regex::new(r"(a|b)-\1").ok(); }`,
      expect: (records) =>
        records.length === 1 &&
        records[0].hits.some((h) => h.kind === 'backreference' && h.construct === '\\1') &&
        records[0].disposition === 'swallowed',
    },
    {
      name: 'panicking call site is visible, not swallowed',
      source: String.raw`fn f() { let re = Regex::new(r"x(?=y)").expect("valid regex"); }`,
      expect: (records) =>
        records.length === 1 &&
        records[0].disposition === 'panicking' &&
        records[0].hits.some((h) => h.construct === '(?='),
    },
    {
      name: 'literal stored in a table above the compiling loop is still associated and swallowed',
      source: [
        'fn f() {',
        '    let table: Vec<(&str, &str)> = vec![',
        '        (r"plain-pattern", "x"),',
        '        (r"neg(?!look)", "y"),',
        '    ];',
        '    let compiled: Vec<(Regex, &str)> = table',
        '        .into_iter()',
        '        .filter_map(|(pat, msg)| Regex::new(pat).ok().map(|re| (re, msg)))',
        '        .collect();',
        '}',
      ].join('\n'),
      expect: (records) =>
        records.length === 1 &&
        records[0].disposition === 'swallowed' &&
        records[0].siteLine !== null,
    },
    {
      name: 'declared/compiled counts follow the parsed table, not constants',
      source: [
        'fn error_handling_check() {',
        '    let patterns: Vec<(&str, &str)> = vec![',
        '        (r"aaa", "x"),',
        '        (r"bbb", "x"),',
        '        (r"ccc", "x"),',
        '        (r"ddd", "x"),',
        '        (r"eee(?!f)", "x"),',
        '    ];',
        '    let _ = patterns;',
        '}',
      ].join('\n'),
      expect: (records, table) =>
        records.length === 1 && table !== null && table.declared === 5 && table.compiled === 4,
    },
  ];

  let passed = 0;
  fixtures.forEach((fx, idx) => {
    let ok = false;
    let detail = '';
    try {
      const records = analyseSource(fx.source);
      const table = countErrorHandlingTable(fx.source);
      ok = fx.expect(records, table);
      if (!ok) {
        detail =
          ' got ' +
          JSON.stringify({
            records: records.map((r) => ({
              line: r.line,
              siteLine: r.siteLine,
              disposition: r.disposition,
              hits: r.hits.map((h) => h.construct),
            })),
            table,
          });
      }
    } catch (err) {
      ok = false;
      detail = ` threw ${err && err.message}`;
    }
    console.log(`selftest fixture ${idx + 1} (${fx.name}): ${ok ? 'ok' : 'FAIL' + detail}`);
    if (ok) passed++;
  });

  if (passed === fixtures.length) {
    console.log(`selftest passed: ${passed}/${fixtures.length} fixtures`);
    return 0;
  }
  console.log(`selftest FAILED: ${passed}/${fixtures.length} fixtures`);
  return 1;
}

function main() {
  // The `node` on this container's PATH is a bun shim: it parses the file
  // (a syntax error still fails) but then executes it instead of stopping
  // after the check, hiding the flag in process.execArgv. Under that shim
  // an explicit --check therefore means "the file parsed and started
  // running" - report success. Under real node, --check never executes
  // this line at all.
  if (process.argv.includes('--check') || process.execArgv.includes('--check')) return 0;
  if (process.argv.includes('--selftest')) return runSelftest();
  return runAudit();
}

let code;
try {
  code = main();
} catch (err) {
  console.error(`regex-lookaround-audit: failed: ${err && err.message}`);
  code = 2;
}
process.exitCode = code;
