#!/usr/bin/env node
//
// shell-safety-reach-audit.mjs — instrument for issue gHashTag/trios#1383.
//
// It measures the real reach of the ShellSafety hard gate implemented in
// trios/rings/RUST-12/clade-audit ("[Check 3/8] Shell safety"), one of the
// seven hard gates behind the promotion seal in clade-promote.
//
// How that gate works, from shell_safety_check() in the audit crate:
//   1. it walks the project directory and keeps the files whose extension
//      is exactly swift and whose path is not caught by the skip
//      predicates of should_skip_audit_path;
//   2. it raises a finding only when the process regex AND the
//      shell-arguments regex both match the SAME physical line;
//   3. it then suppresses the finding when ANY entry of its forbidden
//      list matches ANYWHERE in the whole file content.
//
// This tool replays exactly that predicate over the real corpus and
// reports, with numbers computed at run time, how many lines the gate can
// possibly flag. So that the instrument tracks the gate instead of
// drifting from it, the two regex patterns, the skip tokens and the
// forbidden-list entries are not retyped here: they are parsed out of the
// audit's own source file on every run and printed together with the line
// numbers they were read from, so every value can be checked by hand
// against that file. Setting CLADE_AUDIT_SRC to a different copy of the
// source proves the extraction by substitution.
//
// Constraints honoured (from the issue):
//   - node standard library only, imported with the node: prefix only;
//     no manifest, lockfile or dependency of any kind is added anywhere;
//   - read-only: the tool writes, moves and deletes nothing and spawns
//     no subprocess;
//   - no count is embedded, expected or asserted; swiftFiles in
//     particular varies with the ignored and untracked files a checkout
//     happens to contain, so it is reported and never compared;
//   - the exit rule is structural: non-zero exactly when zero lines can
//     satisfy the same-line predicate while process-regex lines exist,
//     which is the definition of a gate with no reach. A red exit on
//     today's tree is the finding itself, not a failure of this tool.
//
// Usage:  node trios/tools/shell-safety-reach-audit.mjs
// Env:    CLADE_AUDIT_SRC - alternative copy of the audit source
//         (relative values resolve against the current directory).

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The tool lives at <repository-root>/trios/tools/, so the repository root
// is two levels up from this file, and the corpus the gate walks (what
// project_dir resolves to when the audit runs under build.sh) is the
// trios directory of that root. Report paths are shown relative to the
// repository root, the way audit findings are reported.
const TOOLS_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(TOOLS_DIR, "..", "..");
const WALK_ROOT = join(REPO_ROOT, "trios");
const DEFAULT_AUDIT_SRC = join(
  WALK_ROOT,
  "rings",
  "RUST-12",
  "clade-audit",
  "src",
  "main.rs",
);
const REPORT_ROOT = "trios";

// --- Rust source text utilities ----------------------------------------------

// Mirrors str::lines(): split on LF, drop the trailing empty piece that a
// final newline produces, and strip one trailing CR per line.
function rustLines(text) {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return starts;
}

// 1-based line number that a character offset falls on.
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

const SIMPLE_ESCAPES = {
  "\\": "\\",
  '"': '"',
  "'": "'",
  n: "\n",
  r: "\r",
  t: "\t",
  "0": "\0",
};

// Parses one Rust string literal that begins at or just after `offset`
// (leading whitespace is skipped): raw strings (r"...", r#"..."#,
// r##"..."##, ...) and normal quoted strings with the usual escapes.
// Returns { value, start, next } or null when no literal begins there.
function parseRustStringLiteral(text, offset) {
  let i = offset;
  while (i < text.length && " \t\r\n".includes(text[i])) i += 1;
  const start = i;
  let raw = false;
  if (text[i] === "r") {
    raw = true;
    i += 1;
  }
  let hashes = 0;
  while (text[i] === "#") {
    hashes += 1;
    i += 1;
  }
  if (text[i] !== '"') return null;
  i += 1;
  if (raw) {
    const closing = '"' + "#".repeat(hashes);
    const end = text.indexOf(closing, i);
    if (end === -1) return null;
    return { value: text.slice(i, end), start, next: end + closing.length };
  }
  let value = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const n = text[i + 1];
      if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, n)) {
        value += SIMPLE_ESCAPES[n];
        i += 2;
        continue;
      }
      if (n === "u" && text[i + 2] === "{") {
        const close = text.indexOf("}", i + 3);
        if (close !== -1) {
          value += String.fromCodePoint(parseInt(text.slice(i + 3, close), 16));
          i = close + 1;
          continue;
        }
      }
      if (n === "x") {
        value += String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16));
        i += 4;
        continue;
      }
      value += ch + (n === undefined ? "" : n);
      i += 2;
      continue;
    }
    if (ch === '"') return { value, start, next: i + 1 };
    value += ch;
    i += 1;
  }
  return null;
}

// --- extraction from the audit source -----------------------------------------
// Nothing below this point knows what the audit's values are; everything
// is read out of the source text on every run.

// Reads `let <name> = match Regex::new(<literal>) ...` bindings.
function extractRegexBinding(text, starts, name) {
  const anchor = text.indexOf(`let ${name}`);
  if (anchor === -1) {
    throw new Error(`audit source has no binding named ${name}`);
  }
  const windowEnd = Math.min(text.length, anchor + 600);
  const callOffset = text.slice(anchor, windowEnd).indexOf("Regex::new(");
  if (callOffset === -1) {
    throw new Error(`no Regex::new call within reach of the ${name} binding`);
  }
  const literal = parseRustStringLiteral(
    text,
    anchor + callOffset + "Regex::new(".length,
  );
  if (literal === null) {
    throw new Error(`cannot read the pattern literal of the ${name} binding`);
  }
  return { name, value: literal.value, line: lineOf(starts, literal.start) };
}

// The string literals inside the body of should_skip_audit_path ARE the
// path-skip tokens the audit applies; they are collected in order.
function extractSkipTokens(text, starts) {
  const fnIdx = text.indexOf("fn should_skip_audit_path");
  if (fnIdx === -1) {
    throw new Error("audit source has no should_skip_audit_path function");
  }
  const bodyOpen = text.indexOf("{", fnIdx);
  if (bodyOpen === -1) {
    throw new Error("cannot find the body of should_skip_audit_path");
  }
  const tokens = [];
  const tokenLines = [];
  let depth = 0;
  let bodyClose = -1;
  let i = bodyOpen;
  scan: while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break scan;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i);
      if (end === -1) break scan;
      i = end + 2;
      continue;
    }
    if (
      ch === '"' ||
      (ch === "r" && /["#]/.test(text[i + 1] === undefined ? "" : text[i + 1]))
    ) {
      const literal = parseRustStringLiteral(text, i);
      if (literal !== null) {
        tokens.push(literal.value);
        tokenLines.push(lineOf(starts, literal.start));
        i = literal.next;
        continue;
      }
    }
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        bodyClose = i;
        break scan;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (bodyClose === -1) {
    throw new Error("cannot find the end of should_skip_audit_path");
  }
  const seen = new Set();
  const uniqueTokens = [];
  const uniqueTokenLines = [];
  tokens.forEach((token, k) => {
    if (!seen.has(token)) {
      seen.add(token);
      uniqueTokens.push(token);
      uniqueTokenLines.push(tokenLines[k]);
    }
  });
  if (uniqueTokens.length === 0) {
    throw new Error("should_skip_audit_path contains no string literals");
  }
  return {
    tokens: uniqueTokens,
    tokenLines: uniqueTokenLines,
    fromLine: lineOf(starts, fnIdx),
    toLine: lineOf(starts, bodyClose),
  };
}

// The entries of the forbidden_substrings vector, each with its line.
function extractForbiddenSubstrings(text, starts) {
  const anchor = text.indexOf("forbidden_substrings");
  if (anchor === -1) {
    throw new Error("audit source has no forbidden_substrings list");
  }
  const vecIdx = text.indexOf("vec![", anchor);
  if (vecIdx === -1) {
    throw new Error("forbidden_substrings is not a vec literal");
  }
  const entries = [];
  let i = vecIdx + "vec![".length;
  let closeLine = -1;
  scan: while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === ",") {
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break scan;
      i = nl + 1;
      continue;
    }
    if (ch === "]") {
      closeLine = lineOf(starts, i);
      break scan;
    }
    const literal = parseRustStringLiteral(text, i);
    if (literal === null) {
      throw new Error(
        `cannot parse a forbidden_substrings entry near line ${lineOf(starts, i)}`,
      );
    }
    entries.push({ value: literal.value, line: lineOf(starts, literal.start) });
    i = literal.next;
  }
  if (closeLine === -1 || entries.length === 0) {
    throw new Error("cannot read the forbidden_substrings entries");
  }
  return { entries, fromLine: lineOf(starts, anchor), toLine: closeLine };
}

// --- regex compilation ---------------------------------------------------------
// The audit compiles every one of the extracted values with Regex::new,
// that is, as a regular expression — they are never compared as literal
// substrings. That matters: one forbidden entry contains a bare
// alternation and therefore matches far more text than a prose reading of
// the entry suggests. The same semantics are reproduced here verbatim and
// deliberately not corrected: both engines agree on the syntax the audit
// uses (literals, escapes, character classes, alternation, quantifiers),
// so the pattern text is compiled as-is.
function compileRegex(pattern, what) {
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `the ${what} pattern cannot be compiled as a regular expression: ${pattern} (${err.message})`,
    );
  }
}

// --- corpus walk -----------------------------------------------------------------
// Mirrors the walk in shell_safety_check(): everything below the walk
// root, keeping files whose extension is exactly swift (Rust
// Path::extension rules — a leading-dot file name with no other dot has
// no extension) and whose path contains none of the skip tokens read from
// the audit. No exclusion of any other kind is applied, so the tool
// reports exactly what the audit really scans.
function hasSwiftExtension(fileName) {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return false;
  return fileName.slice(dot + 1) === "swift";
}

function walkSwiftCorpus(rootDir, skipTokens) {
  const files = [];
  const stack = [{ dir: rootDir, prefix: REPORT_ROOT }];
  while (stack.length > 0) {
    const { dir, prefix } = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const reportPath = `${prefix}/${entry.name}`;
      if (skipTokens.some((token) => reportPath.includes(token))) continue;
      if (entry.isDirectory()) {
        stack.push({ dir: join(dir, entry.name), prefix: reportPath });
        continue;
      }
      if (entry.isFile() && hasSwiftExtension(entry.name)) {
        files.push({ reportPath, fsPath: join(dir, entry.name) });
      }
    }
  }
  return files;
}

// Mirrors read_to_string: content that cannot be read or is not valid
// UTF-8 cannot be scanned and contributes nothing.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

function readSwiftContent(fsPath) {
  let buffer;
  try {
    buffer = readFileSync(fsPath);
  } catch {
    return null;
  }
  try {
    return STRICT_UTF8.decode(buffer);
  } catch {
    return null;
  }
}

// --- the instrument ----------------------------------------------------------------

export function shellSafetyReach(auditSrcFromEnvironment) {
  const auditSrc = auditSrcFromEnvironment
    ? resolve(process.cwd(), auditSrcFromEnvironment)
    : DEFAULT_AUDIT_SRC;

  const auditText = readFileSync(auditSrc, "utf8");
  const auditLineStarts = lineStartsOf(auditText);

  const processSpec = extractRegexBinding(auditText, auditLineStarts, "process_re");
  const shellSpec = extractRegexBinding(auditText, auditLineStarts, "shell_re");
  const skip = extractSkipTokens(auditText, auditLineStarts);
  const forbidden = extractForbiddenSubstrings(auditText, auditLineStarts);

  const processRe = compileRegex(processSpec.value, "process_re");
  const shellRe = compileRegex(shellSpec.value, "shell_re");
  const forbiddenEntries = forbidden.entries.map((entry) => ({
    ...entry,
    re: compileRegex(entry.value, `forbidden_substrings entry on line ${entry.line}`),
  }));

  console.log("shell-safety reach audit — issue gHashTag/trios#1383");
  console.log(`audit source : ${auditSrc}`);
  console.log(`walk root    : ${WALK_ROOT}`);
  console.log("");
  console.log("== values extracted from the audit source ==");
  console.log("(line numbers refer to the audit source named above; check them there)");
  console.log(
    `process_re           line ${processSpec.line}    pattern: ${processSpec.value}`,
  );
  console.log(
    `shell_re             line ${shellSpec.line}    pattern: ${shellSpec.value}`,
  );
  console.log(
    `skip tokens          lines ${skip.fromLine}-${skip.toLine}  should_skip_audit_path, ${skip.tokens.length} token(s):`,
  );
  skip.tokens.forEach((token, k) => {
    console.log(`    line ${skip.tokenLines[k]}    ${JSON.stringify(token)}`);
  });
  console.log(
    `forbidden_substrings lines ${forbidden.fromLine}-${forbidden.toLine}  ${forbiddenEntries.length} entries, each compiled as a regular expression exactly as the audit compiles them:`,
  );
  forbiddenEntries.forEach((entry) => {
    console.log(`    line ${entry.line}    ${JSON.stringify(entry.value)}`);
  });
  console.log("");

  const corpus = walkSwiftCorpus(WALK_ROOT, skip.tokens);

  let swiftFiles = 0;
  let filesWithProc = 0;
  let procLines = 0;
  let shellArgLines = 0;
  let linesMatchingBothRegexes = 0;
  const procBearingFiles = [];

  for (const file of corpus) {
    const content = readSwiftContent(file.fsPath);
    if (content === null) continue;
    swiftFiles += 1;
    let fileHasProc = false;
    for (const line of rustLines(content)) {
      const processMatch = processRe.test(line);
      const shellMatch = shellRe.test(line);
      if (processMatch) {
        procLines += 1;
        fileHasProc = true;
      }
      if (shellMatch) shellArgLines += 1;
      if (processMatch && shellMatch) linesMatchingBothRegexes += 1;
    }
    if (fileHasProc) {
      filesWithProc += 1;
      procBearingFiles.push({ reportPath: file.reportPath, content });
    }
  }

  // The has-allowlist branch tests every forbidden entry against the
  // WHOLE content of the file, not against the flagged line.
  const perEntry = forbiddenEntries.map((entry) => ({
    line: entry.line,
    value: entry.value,
    exemptedFiles: procBearingFiles.filter((f) => entry.re.test(f.content)).length,
  }));
  const exemptedPaths = new Set();
  forbiddenEntries.forEach((entry) => {
    procBearingFiles.forEach((f) => {
      if (entry.re.test(f.content)) exemptedPaths.add(f.reportPath);
    });
  });
  const filesWithProcessThatTheAllowlistBranchWouldSkip = exemptedPaths.size;
  const notExempted = procBearingFiles.filter((f) => !exemptedPaths.has(f.reportPath));

  const measurement = {
    swiftFiles,
    filesWithProc,
    procLines,
    shellArgLines,
    linesMatchingBothRegexes,
    filesWithProcessThatTheAllowlistBranchWouldSkip,
  };

  console.log("== corpus measurement (every number computed on this run) ==");
  console.log(JSON.stringify(measurement, null, 2));
  console.log("");

  console.log(
    `== exemption breakdown over the ${filesWithProc} file(s) with a process-regex line ==`,
  );
  console.log(
    "(each forbidden entry is tested against the whole content of those files, as the has-allowlist branch does)",
  );
  perEntry.forEach((entry) => {
    console.log(
      `    line ${entry.line}    ${JSON.stringify(entry.value)} exempts ${entry.exemptedFiles} of ${filesWithProc} file(s)`,
    );
  });
  console.log(
    `    => the has-allowlist branch would skip ${filesWithProcessThatTheAllowlistBranchWouldSkip} of ${filesWithProc} file(s)`,
  );
  console.log(`    => file(s) no entry exempts: ${notExempted.length}`);
  notExempted.forEach((f) => console.log(`         - ${f.reportPath}`));
  console.log("");

  const gateHasNoReach = linesMatchingBothRegexes === 0 && procLines > 0;
  if (gateHasNoReach) {
    console.log(
      `RESULT: RED — ${linesMatchingBothRegexes} line(s) satisfy both regexes while ${procLines} line(s) match the process regex across ${filesWithProc} file(s); the same-line predicate can never fire, so the ShellSafety gate has no reach over this corpus.`,
    );
  } else if (procLines === 0) {
    console.log(
      `RESULT: the corpus has no line matching the process regex (${procLines}); there is nothing the predicate could fire on.`,
    );
  } else {
    console.log(
      `RESULT: the predicate can fire — ${linesMatchingBothRegexes} line(s) satisfy both regexes.`,
    );
  }

  process.exitCode = gateHasNoReach ? 1 : 0;
  return measurement;
}

// Entry point. shellSafetyReach performs the whole measurement; the audit
// source path is taken from the environment here so that the extraction
// can be proved by substitution (CLADE_AUDIT_SRC).
try {
  shellSafetyReach(process.env.CLADE_AUDIT_SRC);
} catch (err) {
  console.error(`shell-safety-reach-audit: ${err.message}`);
  process.exitCode = 2;
}
