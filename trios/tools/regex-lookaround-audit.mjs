#!/usr/bin/env node
//
// regex-lookaround-audit.mjs - flag Rust `regex` literals that can never
// compile, and report whether the call site hides that failure.
//
// The Rust `regex` crate supports neither look-around ((?=, (?!, (?<=,
// (?<!) nor backreferences (\1 .. \9). A pattern containing any of those
// constructs makes Regex::new return Err. When the surrounding code throws
// that Err away - `.ok()`, a filter_map chain ending in `.ok()`, or an
// `Err(_)` arm with no output - the rule silently never runs while every
// check banner, JSON report and seal keeps claiming it executed.
//
// What this tool does, in order:
//   1. Walk trios/rings/RUST-*/*.rs from the filesystem (the RUST-13
//      submodule checkout and build directories are skipped).
//   2. Tokenize every Rust string literal - raw and cooked, wherever the
//      literal lives, not only inside a Regex::new(...) argument - and
//      flag literals carrying constructs the crate cannot compile.
//   3. For each flagged literal, locate the Regex::new call that consumes
//      it and classify that call site: swallowed, reported or panicking.
//   4. Parse the error_handling_check pattern table and print how many
//      patterns it declares versus how many can actually compile.
//
// Exit codes: 1 when at least one unsupported literal is swallowed (that is
// the finding this tool exists to expose), 0 when clean, 2 on misuse.
//
// Node standard library only: every import resolves to a node: builtin.
// Nothing is compiled and no subprocesses are launched.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_PATH = fileURLToPath(import.meta.url);
// The script lives at <repo root>/trios/tools/regex-lookaround-audit.mjs,
// so the repository root is two levels above the script directory. Paths
// printed by the tool are relative to that root.
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..', '..');
const RINGS_DIR = join(REPO_ROOT, 'trios', 'rings');

// trios/rings/RUST-13 hosts the trios-mesh git submodule (gitlink, mode
// 160000). Its contents are not part of this repository: never descend.
const RING_PREFIX = 'RUST-';
const SUBMODULE_RING = 'RUST-13';

// Build outputs, checkouts and vendored trees must never be scanned.
const SKIPPED_DIR_SEGMENTS = new Set(['target', '.build', '.git', '.worktrees', 'node_modules']);

// A pattern table and the Regex::new call that consumes it live in the same
// function; these windows only bound the search, they encode no file facts.
const MAX_CONSUMER_DISTANCE = 8000;
const TABLE_ANCHOR_DISTANCE = 4000;

// ---------------------------------------------------------------------------
// Unsupported regex constructs
// ---------------------------------------------------------------------------

/**
 * Map a regex literal to the list of constructs the Rust `regex` crate
 * cannot compile.
 *
 * Unsupported (the crate rejects them with a parse error):
 *   (?=   (?<!  look-around
 *   (?!   (?<=
 *   \1 .. \9    backreferences
 *
 * Supported, and therefore never flagged:
 *   (?:          non-capturing groups
 *   (?i) (?i:..) inline flags
 *   (?P<name> .. and (?<name> .. named groups
 *
 * Escapes (\(, \\1) are honored, and text inside a character class is
 * literal, so [(?!] is not treated as look-around.
 *
 * @param {string} literal - the pattern text as the regex engine sees it.
 * @returns {Array<{construct: string, index: number}>} one entry per
 *   unsupported construct occurrence, in source order.
 */
export function unsupportedRegexSyntax(literal) {
  const found = [];
  let inClass = false;
  for (let i = 0; i < literal.length; i += 1) {
    const c = literal[i];
    if (c === '\\') {
      const next = literal[i + 1] ?? '';
      if (!inClass && next >= '1' && next <= '9') {
        found.push({ construct: `backreference \\${next}`, index: i });
      }
      i += 1; // skip the escaped character
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      if (literal[i + 1] === '^') i += 1; // [^...] negated class
      if (literal[i + 1] === ']') i += 1; // []...] leading ] is literal
      continue;
    }
    if (c === '(' && literal[i + 1] === '?') {
      const a = literal[i + 2] ?? '';
      const b = literal[i + 3] ?? '';
      if (a === '=') {
        found.push({ construct: 'lookahead (?=', index: i });
      } else if (a === '!') {
        found.push({ construct: 'negative-lookahead (?!', index: i });
      } else if (a === '<') {
        if (b === '=') {
          found.push({ construct: 'lookbehind (?<=', index: i });
        } else if (b === '!') {
          found.push({ construct: 'negative-lookbehind (?<!', index: i });
        }
        // (?<name> is a named group: supported, not flagged.
      }
      // (?: groups, (?i) flags and (?P<name> groups: supported, not flagged.
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Rust source tokenization
// ---------------------------------------------------------------------------

const IDENT_CHAR = /[A-Za-z0-9_]/;

function isIdentChar(ch) {
  return ch !== undefined && IDENT_CHAR.test(ch);
}

/** Decode the escapes of a cooked Rust string literal body. */
function decodeCookedString(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const e = text[i + 1];
      i += 1;
      if (e === 'n') out += '\n';
      else if (e === 't') out += '\t';
      else if (e === 'r') out += '\r';
      else if (e === '0') out += '\0';
      else if (e === '\\' || e === '"' || e === "'") out += e;
      else out += e; // \xNN, \u{...}: keep the letter, irrelevant to detection
    } else {
      out += text[i];
    }
  }
  return out;
}

/**
 * Try to read a Rust string literal starting at source[i].
 * Handles cooked strings ("...", b"...") and raw strings
 * (r"...", r#"..."#, br##"..."##). Returns {start, end, text} or null.
 */
function tryStringLiteral(source, i) {
  let p = i;
  if (source[p] === 'b') p += 1;
  const isRaw = source[p] === 'r';
  if (isRaw) p += 1;
  if (!isRaw && source[p] !== '"') return null;

  if (!isRaw) {
    let j = p + 1;
    while (j < source.length) {
      if (source[j] === '\\') {
        j += 2;
        continue;
      }
      if (source[j] === '"') break;
      j += 1;
    }
    if (j >= source.length) return null;
    return {
      start: i,
      end: j + 1,
      text: decodeCookedString(source.slice(p + 1, j)),
    };
  }

  let hashes = 0;
  while (source[p] === '#') {
    hashes += 1;
    p += 1;
  }
  if (source[p] !== '"') return null;
  const terminator = '"' + '#'.repeat(hashes);
  const close = source.indexOf(terminator, p + 1);
  if (close === -1) return null;
  return {
    start: i,
    end: close + terminator.length,
    text: source.slice(p + 1, close),
  };
}

/**
 * Skip a char literal ('x', '\n', '\x41', '\u{1F}', '\'') or a lifetime
 * ('a). Returns the index just past the construct. Real char literals are
 * recorded so they can be blanked out of the masked source (their body is
 * not code and could otherwise disturb paren matching).
 */
function skipCharLiteralOrLifetime(source, i, nonCodeSegments) {
  const n = source.length;
  if (source[i + 1] === '\\') {
    let j = i + 2;
    const e = source[j];
    if (e === 'x') j = Math.min(n, j + 3);
    else if (e === 'u') {
      const brace = source.indexOf('}', j);
      j = brace === -1 ? n : brace + 1;
    } else {
      j = Math.min(n, j + 1);
    }
    if (source[j] === "'") {
      nonCodeSegments.push({ start: i, end: j + 1 });
      return j + 1;
    }
    return i + 1;
  }
  if (source[i + 2] === "'" && source[i + 1] !== "'") {
    nonCodeSegments.push({ start: i, end: i + 3 });
    return i + 3;
  }
  return i + 1; // lifetime such as 'a
}

/**
 * Tokenize Rust source into string literals and non-code segments
 * (comments, char literals), each with [start, end) offsets.
 */
function tokenizeRust(source) {
  const strings = [];
  const nonCodeSegments = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];

    if (c === '/' && source[i + 1] === '/') {
      let j = source.indexOf('\n', i);
      if (j === -1) j = n;
      nonCodeSegments.push({ start: i, end: j });
      i = j;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (source[j] === '*' && source[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      nonCodeSegments.push({ start: i, end: j });
      i = j;
      continue;
    }

    if (c === '"' || ((c === 'r' || c === 'b') && !isIdentChar(source[i - 1]))) {
      const tok = tryStringLiteral(source, i);
      if (tok) {
        strings.push(tok);
        i = tok.end;
        continue;
      }
    }

    if (c === "'") {
      i = skipCharLiteralOrLifetime(source, i, nonCodeSegments);
      continue;
    }

    i += 1;
  }
  return { strings, nonCodeSegments };
}

/**
 * A copy of the source with identical length in which every string literal,
 * comment and char literal body is blanked. Offsets are stable between the
 * two, so regexes and paren matching run on the mask while literal text is
 * read from the tokens.
 */
function maskSource(source, strings, nonCodeSegments) {
  const chars = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < chars.length; k += 1) chars[k] = ' ';
  };
  for (const t of strings) blank(t.start, t.end);
  for (const s of nonCodeSegments) blank(s.start, s.end);
  return chars.join('');
}

// ---------------------------------------------------------------------------
// Regex::new call sites
// ---------------------------------------------------------------------------

/** Index of the bracket matching masked[openIdx] ('[' or '('), or -1. */
function matchBracket(masked, openIdx) {
  const open = masked[openIdx];
  const close = open === '[' ? ']' : ')';
  let depth = 0;
  for (let i = openIdx; i < masked.length; i += 1) {
    if (masked[i] === open) {
      depth += 1;
    } else if (masked[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** All Regex::new(...) call sites in the masked source. */
function findRegexNewCalls(masked) {
  const sites = [];
  const re = /Regex\s*::\s*new\s*\(/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchBracket(masked, openParen);
    if (closeParen === -1) continue;
    sites.push({ start: m.index, openParen, closeParen });
  }
  return sites;
}

/**
 * Classify how the call site treats a Regex::new parse error.
 *
 *   swallowed  - `.ok()` (also at the end of a filter_map chain) or an
 *                `Err(_)` / `Err(e)` arm that produces no output: the
 *                failure is invisible, the rule silently never runs.
 *   reported   - an `Err(e)` arm that prints (eprintln!, println!, ...).
 *   panicking  - `.unwrap()` or `.expect(...)`: loud, impossible to miss.
 */
export function classifyCallSite(masked, closeParen) {
  const tail = masked.slice(closeParen + 1, closeParen + 701);

  // Result chained straight into ok/unwrap/expect.
  if (/^\s*\.\s*ok\s*\(\s*\)/.test(tail)) return 'swallowed';
  if (/^\s*\.\s*unwrap\s*\(\s*\)/.test(tail)) return 'panicking';
  if (/^\s*\.\s*expect\s*\(/.test(tail)) return 'panicking';

  // Call used as a match scrutinee: inspect the Err arm.
  const arm = tail.match(/\bErr\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)\s*=>/);
  if (arm) {
    const armBody = tail.slice(arm.index + arm[0].length, arm.index + arm[0].length + 400);
    if (/(?:eprintln!|println!|print!|dbg!)/.test(armBody)) return 'reported';
    if (/(?:panic!|unreachable!|todo!|unimplemented!)/.test(armBody)) return 'panicking';
    return 'swallowed'; // Err(_) or unused Err(e): error thrown away silently
  }

  return 'unknown';
}

/**
 * Find the Regex::new call site that consumes a string literal token.
 * The literal may be the direct argument of the call, an entry of a
 * pattern table compiled a few lines later, or (rarely) feed a call that
 * appears earlier; each case is tried in turn, bounded to one function's
 * worth of source.
 */
function findConsumer(token, sites) {
  for (const s of sites) {
    if (s.start < token.start && s.closeParen >= token.end) {
      return { site: s, relation: 'argument' };
    }
  }
  let after = null;
  for (const s of sites) {
    if (s.start >= token.end && (!after || s.start < after.start)) after = s;
  }
  if (after && after.start - token.end <= MAX_CONSUMER_DISTANCE) {
    return { site: after, relation: 'after' };
  }
  let before = null;
  for (const s of sites) {
    if (s.closeParen <= token.start && (!before || s.start > before.start)) before = s;
  }
  if (before && token.start - before.closeParen <= MAX_CONSUMER_DISTANCE) {
    return { site: before, relation: 'before' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// error_handling_check pattern table
// ---------------------------------------------------------------------------

/** Top-level (...) groups in masked[from, to), as [start, end) spans. */
function topLevelGroups(masked, from, to) {
  const groups = [];
  let depth = 0;
  let start = -1;
  for (let i = from; i < to; i += 1) {
    const c = masked[i];
    if (c === '(') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        groups.push([start, i + 1]);
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return groups;
}

/**
 * Parse the pattern table of the error_handling_check function: count the
 * declared rows (every tuple of the vec![...]) and the rows that can
 * actually compile (those whose pattern literal carries no unsupported
 * construct). Both numbers come from the file, never from constants.
 */
function errorHandlingTableStats(masked, strings) {
  const anchor = masked.search(/\bfn\s+error_handling_check\b/);
  if (anchor === -1) return null;

  let from = anchor;
  for (;;) {
    const vecIdx = masked.indexOf('vec![', from);
    if (vecIdx === -1 || vecIdx - anchor > TABLE_ANCHOR_DISTANCE) return null;

    const open = masked.indexOf('[', vecIdx);
    const close = open === -1 ? -1 : matchBracket(masked, open);
    if (close !== -1) {
      const rows = topLevelGroups(masked, open + 1, close)
        .map(([s, e]) => strings.filter((t) => t.start >= s && t.start < e))
        // A pattern row is (regex, severity[, message]): at least two
        // string literals. Vecs of anything else are not this table.
        .filter((toks) => toks.length >= 2);
      if (rows.length > 0) {
        const compiled = rows
          .filter((toks) => unsupportedRegexSyntax(toks[0].text).length === 0)
          .length;
        return { declared: rows.length, compiled };
      }
    }
    from = vecIdx + 5; // try the next vec (e.g. skip an empty vec![])
  }
}

// ---------------------------------------------------------------------------
// File audit
// ---------------------------------------------------------------------------

function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function auditFile(absPath, displayPath) {
  const source = readFileSync(absPath, 'utf8');
  const { strings, nonCodeSegments } = tokenizeRust(source);
  const masked = maskSource(source, strings, nonCodeSegments);
  const sites = findRegexNewCalls(masked);

  const records = [];
  for (const token of strings) {
    const constructs = unsupportedRegexSyntax(token.text);
    if (constructs.length === 0) continue;
    const consumer = findConsumer(token, sites);
    records.push({
      displayPath,
      line: lineOf(source, token.start),
      literal: source.slice(token.start, token.end),
      constructs: [...new Set(constructs.map((c) => c.construct))],
      disposition: consumer
        ? classifyCallSite(masked, consumer.site.closeParen)
        : 'no-consumer',
      consumerLine: consumer ? lineOf(source, consumer.site.start) : null,
    });
  }

  return {
    displayPath,
    records,
    masked,
    strings,
    hasErrorHandlingFn: /\bfn\s+error_handling_check\b/.test(masked),
  };
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

function collectRustFiles(ringsDir) {
  const files = [];
  const skippedRings = [];

  let ringEntries;
  try {
    ringEntries = readdirSync(ringsDir, { withFileTypes: true });
  } catch (err) {
    console.error(`error: cannot read ${ringsDir}: ${err.message}`);
    return { files, skippedRings, fatal: true };
  }

  for (const entry of ringEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith(RING_PREFIX)) continue;
    if (entry.name === SUBMODULE_RING) {
      skippedRings.push(entry.name);
      continue;
    }
    const stack = [join(ringsDir, entry.name)];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (SKIPPED_DIR_SEGMENTS.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile() && e.name.endsWith('.rs')) files.push(p);
      }
    }
  }

  files.sort();
  return { files, skippedRings, fatal: false };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatRecord(record) {
  const consumer = record.consumerLine === null
    ? 'consumer=none-found'
    : `consumer=Regex::new at line ${record.consumerLine}`;
  return `unsupported-regex-literal: ${record.displayPath}:${record.line}`
    + ` disposition=${record.disposition}`
    + ` constructs=[${record.constructs.join(', ')}]`
    + ` ${consumer}`
    + ` literal=${record.literal}`;
}

function runAudit() {
  const { files, skippedRings, fatal } = collectRustFiles(RINGS_DIR);
  if (fatal) {
    process.exitCode = 2;
    return;
  }
  if (files.length === 0) {
    console.error(`error: no .rs files found under ${RINGS_DIR} - refusing to report a green result`);
    process.exitCode = 2;
    return;
  }

  const skipNote = skippedRings.length > 0
    ? ` (skipped ${skippedRings.join(', ')}: git submodule)`
    : '';
  console.log(`scanned .rs files: ${files.length}${skipNote}`);

  const audits = files.map((absPath) =>
    auditFile(absPath, relative(REPO_ROOT, absPath).split(sep).join('/')));

  const records = audits.flatMap((a) => a.records);
  for (const record of records) {
    console.log(formatRecord(record));
  }

  let tablePrinted = false;
  for (const a of audits) {
    if (!a.hasErrorHandlingFn) continue;
    const table = errorHandlingTableStats(a.masked, a.strings);
    if (table) {
      console.log(`error_handling_check pattern table (${a.displayPath}):`
        + ` declared=${table.declared} compiled=${table.compiled}`);
      tablePrinted = true;
    }
  }
  if (!tablePrinted) {
    console.log('error_handling_check pattern table: not found in scanned files');
  }

  const swallowed = records.filter((r) => r.disposition === 'swallowed');
  if (swallowed.length > 0) {
    console.log(`finding: ${swallowed.length} unsupported regex literal(s) whose parse`
      + ' error is swallowed by its call site - the rule never runs and nothing'
      + ' reports it; exiting 1');
    process.exitCode = 1;
    return;
  }
  console.log(`ok: no swallowed unsupported regex literals in ${files.length} scanned files; exiting 0`);
}

// ---------------------------------------------------------------------------
// Selftest - the green path: the classifier must be able to pass.
// ---------------------------------------------------------------------------

function classifySnippet(source) {
  const { strings, nonCodeSegments } = tokenizeRust(source);
  const masked = maskSource(source, strings, nonCodeSegments);
  const sites = findRegexNewCalls(masked);
  const token = strings.find((t) => unsupportedRegexSyntax(t.text).length > 0);
  if (!token) return { constructs: [], disposition: 'none' };
  const consumer = findConsumer(token, sites);
  const disposition = consumer
    ? classifyCallSite(masked, consumer.site.closeParen)
    : 'no-consumer';
  return {
    constructs: unsupportedRegexSyntax(token.text).map((c) => c.construct),
    disposition,
  };
}

function runSelfTest() {
  const tableFixture = [
    'fn error_handling_check() -> SecurityCheckResult {',
    '    let mut findings: Vec<AuditFinding> = vec![];',
    '    let patterns: Vec<(&str, &str, &str)> = vec![',
    '        (r"try!\\s*\\(", "warning", "bare try!"),',
    '        (r"as!\\s*\\w+", "warning", "force cast"),',
    '        (r"as!\\s*\\[", "warning", "force cast"),',
    '        (r"(?!handled)", "info", "unhandled"),',
    '        (r"plain\\d+", "info", "plain"),',
    '    ];',
    '    SecurityCheckResult { passed: true, findings, scanned_files: 0, duration_ms: 0 }',
    '}',
  ].join('\n');

  const filterMapFixture = [
    'let patterns: Vec<(&str, &str, &str)> = vec![',
    '    (r"(?!nope)", "info", "msg"),',
    '];',
    'let compiled: Vec<(Regex, &str, &str)> = patterns',
    '    .into_iter()',
    '    .filter_map(|(pat, sev, msg)| {',
    '        Regex::new(pat).ok().map(|re| (re, sev, msg))',
    '    })',
    '    .collect();',
  ].join('\n');

  const fixtures = [
    {
      name: 'supported literal: (?: groups, (?i) flags and named groups are not flagged',
      run: () => unsupportedRegexSyntax(
        String.raw`(?:ab)|cd(?i)|(?P<name>x)|(?<other>y)|\d{4}|[a-z]+|[(?!]`,
      ).length === 0,
    },
    {
      name: 'swallowed unsupported literal: Regex::new(...).ok() discards the parse error',
      run: () => classifySnippet('let re = Regex::new(r"(?!draft)").ok();').disposition === 'swallowed',
    },
    {
      name: 'reported unsupported literal: Err(e) arm prints with eprintln!',
      run: () => classifySnippet(
        'let re = match Regex::new(r"(?<=sentinel)") {\n'
        + '    Ok(re) => re,\n'
        + '    Err(e) => { eprintln!("bad regex: {}", e); return; }\n'
        + '};',
      ).disposition === 'reported',
    },
    {
      name: 'backreference: \\1 and \\2 in a literal are unsupported',
      run: () => {
        const found = unsupportedRegexSyntax(String.raw`(a)\1(b)\2`).map((c) => c.construct);
        return found.length === 2 && found.every((c) => c.startsWith('backreference'));
      },
    },
    {
      name: 'panicking call site: .unwrap() on Regex::new',
      run: () => classifySnippet('let re = Regex::new(r"(?<!negative)").unwrap();').disposition === 'panicking',
    },
    {
      name: 'pattern table: five declared rows, one unsupported, declared=5 compiled=4',
      run: () => {
        const { strings, nonCodeSegments } = tokenizeRust(tableFixture);
        const masked = maskSource(tableFixture, strings, nonCodeSegments);
        const table = errorHandlingTableStats(masked, strings);
        return table !== null && table.declared === 5 && table.compiled === 4;
      },
    },
    {
      name: 'filter_map chain ending in .ok() is swallowed',
      run: () => classifySnippet(filterMapFixture).disposition === 'swallowed',
    },
  ];

  let failures = 0;
  for (let i = 0; i < fixtures.length; i += 1) {
    let ok = false;
    let detail = '';
    try {
      ok = fixtures[i].run();
    } catch (err) {
      detail = ` (${err && err.message ? err.message : err})`;
    }
    if (!ok) failures += 1;
    console.log(`fixture ${i + 1}/${fixtures.length} ${ok ? 'PASS' : 'FAIL'}: ${fixtures[i].name}${detail}`);
  }

  if (failures > 0) {
    console.log(`selftest: ${fixtures.length - failures}/${fixtures.length} fixture cases passed, ${failures} FAILED`);
    process.exitCode = 1;
    return;
  }
  console.log(`selftest: all ${fixtures.length} fixture cases passed`);
}

// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--selftest') {
    runSelfTest();
    return;
  }
  if (args.length > 0) {
    console.error('usage: node trios/tools/regex-lookaround-audit.mjs [--selftest]');
    process.exitCode = 2;
    return;
  }
  runAudit();
}

try {
  main();
} catch (err) {
  console.error(`error: ${err && err.message ? err.message : err}`);
  process.exitCode = 2;
}
