#!/usr/bin/env node
// silent-skip-audit.mjs — find every early exit that silently skips work when
// a required tool or path is missing.
//
// Usage:
//   node trios/tools/silent-skip-audit.mjs             audit this tree
//   node trios/tools/silent-skip-audit.mjs --selftest  build a fixture (one silent
//                                                      skip, one that warns first),
//                                                      assert only the silent one is
//                                                      reported, exit 0 on pass
//
// The defect this hunts (trios issue #1355): a hook or tool guards its real work
// behind "is the tool/path available?", cannot find it, and returns anyway —
// printing nothing. `cargo build` then reports success while the job was
// silently not done. The exemplar is trios/rings/RUST-13/trios-mesh/build.rs.
//
// THE RULE — what counts as a silent skip (stated so every finding can be
// checked by hand):
//   1. EXIT. A statement that abandons the remaining work or skips the current
//      item: `return` / `continue` / `exit` (and `sys.exit` / `process.exit`).
//   2. GOVERNED BY AN AVAILABILITY GUARD, NEGATED. The condition that governs
//      the exit must test that a file, directory, executable or command exists,
//      in "skip when missing" form: `!Path::new(p).exists()`, `!p.exists()`,
//      `[ -f p ] ||`, `! command -v tool`, `!existsSync(p)`,
//      `not Path(p).exists()`, `!fileExists(p)`. A positive check ("if it IS
//      there, do it") is the skip-if-present idiom, not this defect, and is
//      never reported.
//   3. NO MESSAGE FIRST. Between the start of the guarded branch and the exit
//      statement there must be no message primitive — no call that writes to
//      the user: println!/print!/eprintln!/panic!/log macros (Rust),
//      echo/printf/log/fail (shell), console.*/print/throw (JS/TS),
//      print/logging/raise (Python), print/NSLog (Swift). A skip that emits a
//      warning BEFORE returning is loud; it is deliberately NOT reported.
//      Flagging both would make this tool a grep for `return`.
//   A returned payload (an error object, an empty string, a 404 helper) is not
//   an emission under this rule; such sites are listed and left to human
//   review, because only the reader can tell a deliberate "missing means
//   empty" contract from a real silent skip.
//
// Scope: source files under the trios/ tree (this script's own project
// directory). Pruned: any directory named `t27` (nothing under t27/ is read or
// written by this audit — issue FR-005), .git, node_modules, build products
// (target/, *.app, trios_*_app, Frameworks*, .build, dist, out), .worktrees,
// .archive, and .trinity runtime state (only .trinity/patches/ is in scope
// below .trinity, plus root-level .trinity scripts). The audit reads source
// text only; it edits nothing and invokes nothing — no cargo, no git, Node
// standard library only.
//
// Submodule record: trios/rings/RUST-13/trios-mesh is a git submodule (mode
// 160000) whose content is not materialized in this checkout, so its files
// cannot be read from disk — and must not be written regardless (an edit there
// cannot be landed from this repository; FR-001). The parent tree records the
// submodule's current content in .trinity/patches/<name>-integration.patch.
// For every empty directory whose basename has such a recorded patch, the
// audit reconstructs the patch's post-image (the "+" and context lines, with
// true line numbers from the hunk headers) and audits it under the
// submodule's real path. Findings from that source are marked [record].
//
// Output is sorted by path then line and contains no timestamps, so two runs
// on an unchanged tree produce identical bytes.

import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_DIR = resolve(SCRIPT_PATH, '..', '..'); // the trios/ tree

// ---------------------------------------------------------------------------
// Directory pruning (see Scope above). Names are matched per path segment.
// ---------------------------------------------------------------------------
const PRUNE_DIR_NAMES = new Set([
  '.git', 'node_modules', 'target', 't27', 't27c-build', '.worktrees',
  '.archive', '.build', 'dist', 'out', 'coverage',
  'Frameworks', 'Frameworks-dev', 'Frameworks-test',
  'trios.app', 'trios-dev.app', 'trios-test.app',
  'trios_app', 'trios_dev_app', 'trios_test_app',
]);

// Inside .trinity only patches/ is source; everything else there is runtime
// state. Root-level .trinity scripts are still yielded (the filter below only
// applies to subdirectories).
const TRINITY_ALLOWED_SUBDIRS = new Set(['patches']);

const SOURCE_EXTENSIONS = new Set([
  'rs', 'sh', 'bash', 'zsh', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'swift',
]);
const SOURCE_BASENAMES = new Set(['Makefile', 'makefile', 'GNUmakefile']);

// ---------------------------------------------------------------------------
// Comment/string blanking. Returns text of the SAME LENGTH with comment and
// string-literal contents replaced by spaces, so structural scanning (braces,
// keywords) never trips over prose, while indexes stay valid for slicing the
// original text.
// ---------------------------------------------------------------------------
function blankCode(text, style) {
  const out = text.split('');
  const n = text.length;
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  if (style === 'hash') {
    // shell: blank from an unquoted # to end of line
    let inS = false, inD = false, i = 0;
    while (i < n) {
      const c = text[i];
      if (c === '\'' && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (c === '#' && !inS && !inD) {
        let j = i;
        while (j < n && text[j] !== '\n') j++;
        blank(i, j); i = j; continue;
      }
      i++;
    }
    return out.join('');
  }
  // braced languages (rust/js/ts/swift): line comments, block comments, strings
  let i = 0;
  while (i < n) {
    const c = text[i], d = i + 1 < n ? text[i + 1] : '';
    if (c === '/' && d === '/') { let j = i; while (j < n && text[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { let j = i + 2; while (j + 1 < n && !(text[j] === '*' && text[j + 1] === '/')) j++; j = Math.min(j + 2, n); blank(i, j); i = j; continue; }
    if (c === '"') { let j = i + 1; while (j < n && text[j] !== '"' && text[j] !== '\n') j++; blank(i + 1, j); i = Math.min(j + 1, n); continue; }
    if (c === "'") { let j = i + 1; while (j < n && text[j] !== "'" && text[j] !== '\n') j++; blank(i + 1, j); i = Math.min(j + 1, n); continue; }
    if (c === 'r' && (d === '"' || d === '#')) { // rust raw string, shallow handling
      let j = i + 1; while (j < n && text[j] !== '"') j++;
      let k = j + 1; while (k < n && text[k] !== '"') k++;
      blank(i, Math.min(k + 1, n)); i = Math.min(k + 1, n); continue;
    }
    i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Guard recognition per language. A qualifier returns null (not an
// availability guard in skip-when-missing form) or { checks: [expressions] }.
// ---------------------------------------------------------------------------
function splitTopLevel(cond) {
  const parts = []; let depth = 0, cur = '';
  for (let i = 0; i < cond.length; i++) {
    const c = cond[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && c === '|' && cond[i + 1] === '|') { parts.push(cur); cur = ''; i++; continue; }
    if (depth === 0 && c === '&' && cond[i + 1] === '&') { parts.push(cur); cur = ''; i++; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

// If the checked expression is a bare local variable assigned a string literal
// (or Path::new("...")/PathBuf::from("...")/format!("...")) shortly above,
// report the literal so the reader can verify the path without the source.
function resolveLetLiteral(expr, letLiterals) {
  const e = expr.replace(/^&/, '').trim();
  if (letLiterals && letLiterals.has(e)) return `${e} (= ${letLiterals.get(e)})`;
  return expr.trim();
}
function collectLetLiterals(lines, uptoIdx) {
  const map = new Map();
  const from = Math.max(0, uptoIdx - 25);
  for (let i = from; i < uptoIdx && i < lines.length; i++) {
    const m = /let\s+(?:mut\s+)?([A-Za-z_]\w*)\s*=\s*(.+?);?\s*$/.exec(lines[i]);
    if (!m) continue;
    const rhs = m[2];
    const lit = /^"([^"]*)"\s*$/.exec(rhs)
      || /^Path\s*::\s*new\s*\(\s*"([^"]*)"\s*\)\s*$/.exec(rhs)
      || /^PathBuf\s*::\s*from\s*\(\s*"([^"]*)"\s*\)\s*$/.exec(rhs)
      || /^format!\s*\(\s*"([^"]*)"/.exec(rhs);
    if (lit) map.set(m[1], `"${lit[1]}"`);
  }
  return map;
}

// Rust: keep negated existence operands of the condition.
function qualifyRustGuard(cond, letLiterals) {
  const checks = [];
  let any = false;
  for (const raw of splitTopLevel(cond)) {
    const op = raw.trim();
    const m = /^!\s*([\s\S]*)$/.exec(op);
    if (!m) continue; // positive operand — not skip-when-missing
    const body = m[1].trim();
    let e = null;
    let pm = /^(?:std\s*::\s*)?(?:path\s*::\s*)?Path\s*::\s*new\s*\((.*)\)\s*\.\s*exists\(\)\s*$/s.exec(body);
    if (pm) e = pm[1].trim();
    if (e === null) { pm = /^fs\s*::\s*metadata\s*\((.*)\)\s*\.\s*is_ok\(\)\s*$/s.exec(body); if (pm) e = pm[1].trim(); }
    if (e === null) { pm = /^([\s\S]+?)\s*\.\s*(?:try_)?exists\(\)\s*$/.exec(body); if (pm) e = pm[1].trim(); }
    if (e === null) continue;
    any = true;
    checks.push(resolveLetLiteral(e, letLiterals));
  }
  return any ? { checks } : null;
}

// JS/TS: negated call to something named *exists / *Exists / existsSync
// (covers `!existsSync(p)`, `!fs.existsSync(p)`, `!(await file.exists())`).
function stripAwaitAndParens(s) {
  let t = s.trim();
  for (;;) {
    const nxt = t.replace(/^await\s+/, '');
    if (nxt !== t) { t = nxt; continue; }
    if (t.startsWith('(') && t.endsWith(')')) {
      let d = 0, wrap = true;
      for (let i = 0; i < t.length; i++) {
        if (t[i] === '(') d++;
        else if (t[i] === ')') { d--; if (d === 0 && i !== t.length - 1) { wrap = false; break; } }
      }
      if (wrap && d === 0) { t = t.slice(1, -1); continue; }
    }
    return t;
  }
}
function qualifyJsGuard(cond) {
  const checks = [];
  let any = false;
  for (const raw of splitTopLevel(cond)) {
    // unwrap the if's own wrapping parens first: `(!existsSync(p))`
    let op = stripAwaitAndParens(raw.trim());
    if (!op.startsWith('!')) continue; // positive operand — not skip-when-missing
    op = stripAwaitAndParens(op.slice(1));
    const cm = /^([A-Za-z_$][\w$.]*)\s*\(([^()]*)\)\s*$/.exec(op);
    if (!cm || !/[Ee]xists(?:Sync)?$/.test(cm[1])) continue;
    any = true;
    checks.push((cm[2] || '').trim() || cm[1]);
  }
  return any ? { checks } : null;
}

// Python: `not os.path.isfile(x)` / `not Path(x).exists()` / `not x.exists()`.
function qualifyPyGuard(cond) {
  const checks = [];
  let any = false;
  for (const raw of splitTopLevel(cond)) {
    const op = raw.trim();
    const m = /^not\s+([\s\S]*)$/.exec(op);
    if (!m) continue;
    const body = m[1].trim();
    let e = null;
    let pm = /^(?:os\.path\.)?isfile\s*\((.*)\)\s*$/.exec(body); if (pm) e = pm[1];
    if (e === null) { pm = /^Path\s*\((.*)\)\s*\.\s*exists\(\)\s*$/.exec(body); if (pm) e = pm[1]; }
    if (e === null) { pm = /^([\s\S]+?)\s*\.\s*exists\(\)\s*$/.exec(body); if (pm) e = pm[1]; }
    if (e === null) continue;
    any = true; checks.push(e.trim());
  }
  return any ? { checks } : null;
}

// Swift: negated existence helper — FileManager's fileExists or any helper
// whose name ends in exists/Exists (e.g. a private fileExists(rev:path:)).
function qualifySwiftGuard(cond) {
  const c = stripAwaitAndParens(cond.trim()); // drop the if's wrapping parens
  const m = /^!\s*([\s\S]*)$/.exec(c);
  if (!m) return null;
  const body = stripAwaitAndParens(m[1].trim());
  const cm = /^([A-Za-z_]\w*xists\w*)\s*\(([^()]*)\)\s*$/.exec(body)
    || /^([A-Za-z_]\w*)\s*\.\s*fileExists\s*\(([^()]*)\)\s*$/.exec(body);
  if (!cm) return null;
  const args = cm[2];
  const pm = /(?:^|[,]\s*)path\s*:\s*([A-Za-z_][\w.]*)/.exec(args)
    || /(?:^|[,]\s*)(?:atPath|forItemAtPath)\s*:\s*([A-Za-z_][\w.]*)/.exec(args)
    || /^([A-Za-z_][\w.]*)/.exec(args.trim());
  return { checks: [pm ? pm[1] : `${cm[1]}(...)`] };
}

// Shell: a guard must be exactly one availability test — `[ -f p ]`,
// `test -f p`, `command -v tool`, `which tool`, `type -P tool` — optionally
// negated with `!`. Anchored full-match, so a guard can never swallow the
// statements before it (that is how `bash x.sh || exit 1` stays loud).
function parseShellGuard(text) {
  let t = text.trim();
  // strip redirection suffixes such as `>/dev/null 2>&1` or `&>/dev/null`
  for (;;) {
    const nxt = t.replace(/(?:\s*(?:2>&1|2>\S+|&>\S*|\d?>\S+))+$/, '');
    if (nxt === t) break;
    t = nxt.trim();
  }
  let m = /^\[\s*(!?)\s*(-[fdexr])\s+([^\]]+?)\s*\]$/.exec(t);
  if (m) return { checks: [m[3]], negated: m[1] === '!' };
  m = /^test\s+(!?)\s*(-[fdexr])\s+(\S+)$/.exec(t);
  if (m) return { checks: [m[3]], negated: m[1] === '!' };
  m = /^(!?)\s*command\s+(?:-v|--)\s+(\S+)$/.exec(t);
  if (m) return { checks: [`command -v ${m[2]}`], negated: m[1] === '!' };
  m = /^(!?)\s*(which|type\s+-P)\s+(\S+)$/.exec(t);
  if (m) return { checks: [`${m[2]} ${m[3]}`], negated: m[1] === '!' };
  return null;
}

// ---------------------------------------------------------------------------
// Message primitives per language (anything that writes to the user, plus
// loud aborts). Checked in the region BEFORE the exit statement. The trailing
// `!` of Rust macro names is followed by `(`, so no word boundary is demanded
// after a macro name.
// ---------------------------------------------------------------------------
const MESSAGES = {
  rust: /\b(println!|print!|eprintln!|eprint!|dbg!|panic!|assert!|assert_eq!|assert_ne!|unreachable!|todo!|unimplemented!|warn!|warning!|info!|error!|debug!|trace!|write!|writeln!)\s*\(|\bstd\b[^;{]*\b(stderr|stdout)\b/,
  js: /\bconsole\s*\.|\b(log|warn|error|print|printf|info|debug)\s*\(|\blogger\b|\bthrow\b|process\s*\.\s*(stdout|stderr)/,
  py: /\bprint\s*\(|\blogging\b|\blogger\b|\braise\b|\bwarn\b|\berror\b/,
  swift: /\bprint\s*\(|\bNSLog\b|\bos_log\b|\bLogger\b|\.error\s*\(|\.warning\s*\(/,
  shell: /(^|[^A-Za-z_.])(echo|printf|log|warn|error|fail|die|print)\b/,
};

// ---------------------------------------------------------------------------
// Exit detection in braced languages: first `return` / `continue` /
// `process.exit` at brace depth 0 of the guarded branch.
// ---------------------------------------------------------------------------
function firstExitInBody(bodyClean, lang) {
  let depth = 0;
  for (let i = 0; i < bodyClean.length; i++) {
    const c = bodyClean[i];
    if (c === '{') { depth++; continue; }
    if (c === '}') { if (depth === 0) return null; depth--; continue; }
    if (depth !== 0 || !/[A-Za-z_$]/.test(c)) continue;
    const m = /^([A-Za-z_$][\w$]*)/.exec(bodyClean.slice(i));
    if (!m) continue;
    const word = m[1];
    let j = i - 1;
    while (j >= 0 && /\s/.test(bodyClean[j])) j--;
    const prev = j >= 0 ? bodyClean[j] : null;
    const stmtStart = prev === null || prev === ';' || prev === '}' || prev === '{';
    if (stmtStart && (word === 'return' || word === 'continue')) return { idx: i, kind: word };
    if (stmtStart && lang === 'js' && word === 'process'
      && /^\s*\.\s*exit\s*\(/.test(bodyClean.slice(i + word.length))) return { idx: i, kind: 'exit' };
    i += word.length - 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Braced-language scanner (rust / js / swift).
// ---------------------------------------------------------------------------
function scanBraced(origText, file, lang, qualifier, baseLine = 1) {
  const findings = [];
  const clean = blankCode(origText, 'brace');
  const lineStarts = [-1];
  for (let i = 0; i < origText.length; i++) if (origText[i] === '\n') lineStarts.push(i);
  // lineStarts[k] is the newline that ends 0-based line k-1, so a 0-based index
  // idx lives on 0-based line k-1 where k is the first entry >= idx.
  const lineOf = (idx) => {
    for (let k = 1; k < lineStarts.length; k++) if (lineStarts[k] >= idx) return baseLine + k - 1;
    return baseLine + lineStarts.length - 1;
  };
  const lines = origText.split('\n');

  const ifRe = /(^|[\n};])\s*(else\s+)?if\s/g;
  let m;
  while ((m = ifRe.exec(clean))) {
    const condStart = m.index + m[0].length;
    // find the { that opens the branch (paren-balanced condition)
    let depth = 0, openBrace = -1;
    let i = condStart;
    for (; i < clean.length && i - condStart < 600; i++) {
      const c = clean[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === '{' && depth <= 0) { openBrace = i; break; }
      else if (c === ';' && depth <= 0) break;
    }
    if (openBrace < 0) { ifRe.lastIndex = condStart; continue; }
    const cond = clean.slice(condStart, openBrace).trim();
    const guardLineIdx = lineOf(condStart) - baseLine; // 0-based into `lines`
    const letLiterals = lang === 'rust' ? collectLetLiterals(lines, guardLineIdx) : null;
    const q = qualifier(cond, letLiterals);
    if (!q) { ifRe.lastIndex = openBrace; continue; }
    let d = 0, close = -1;
    for (let j = openBrace; j < clean.length; j++) {
      if (clean[j] === '{') d++;
      else if (clean[j] === '}') { d--; if (d === 0) { close = j; break; } }
    }
    if (close < 0) continue;
    const bodyClean = clean.slice(openBrace + 1, close);
    const exit = firstExitInBody(bodyClean, lang);
    if (!exit) { ifRe.lastIndex = openBrace; continue; }
    const region = bodyClean.slice(0, exit.idx);
    if (MESSAGES[lang].test(region)) { ifRe.lastIndex = openBrace; continue; }
    findings.push({
      file, line: lineOf(openBrace + 1 + exit.idx), kind: exit.kind,
      guard: origText.slice(condStart, openBrace).trim().replace(/\s+/g, ' ').slice(0, 100),
      checks: q.checks, source: 'tree',
    });
    ifRe.lastIndex = openBrace;
  }

  // JS single-line braceless form: `if (guard) return ...` / `continue` /
  // `process.exit(...)`. By construction nothing can sit between the guard and
  // the exit, so such a skip is silent whenever the guard qualifies.
  if (lang === 'js') {
    const oneRe = /if\s*\(([^\n{}]*)\)\s*(return|continue|process\s*\.\s*exit)\b/g;
    let om;
    while ((om = oneRe.exec(clean))) {
      const q = qualifyJsGuard(om[1]);
      if (!q) continue;
      findings.push({
        file, line: lineOf(om.index + om[0].length), kind: om[2].includes('.') ? 'exit' : om[2],
        guard: om[1].trim().replace(/\s+/g, ' ').slice(0, 100),
        checks: q.checks, source: 'tree',
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Shell scanner (.sh/.bash/.zsh, the `trios` launcher, Makefile recipes).
// ---------------------------------------------------------------------------
function countNewlines(s) { let n = 0; for (const c of s) if (c === '\n') n++; return n; }

// The text immediately before a `||`/`&&` operator, cut back to the previous
// statement boundary, with shell keywords and the Make `@` prefix stripped so
// `do [ -f x ] || exit` yields the guard `[ -f x ]`.
function shellGuardBeforeOperator(clean, opIdx) {
  let b = -1;
  for (const tok of [';', '{', '}', '\n', '&&', '||']) {
    const p = clean.lastIndexOf(tok, opIdx - 1);
    if (p > b) b = p;
  }
  let guardText = clean.slice(b + (b >= 0 && (clean[b] === '&' || clean[b] === '|') ? 2 : 1), opIdx).trim();
  for (;;) {
    const nx = guardText.replace(/^@+/, '').replace(/^(?:do|then|else|fi|done|esac|in)\b\s*/, '').trim();
    if (nx === guardText) break;
    guardText = nx;
  }
  return guardText;
}

function scanShell(origText, file, baseLine = 1) {
  const findings = [];
  // Join backslash continuations into logical units, remembering the start line.
  const units = [];
  let cur = '', curLine = 0;
  const phys = origText.split('\n');
  for (let i = 0; i < phys.length; i++) {
    const line = phys[i];
    if (cur === '') curLine = i;
    if (/\\$/.test(line)) { cur += line.replace(/\\$/, '') + '\n'; continue; }
    cur += line;
    units.push({ text: cur, line: baseLine + curLine });
    cur = '';
  }
  if (cur) units.push({ text: cur, line: baseLine + curLine });

  for (const unit of units) {
    const clean = blankCode(unit.text, 'hash');

    // --- one-liner: GUARD || EXIT — the exit arm runs when the path is
    // missing. The guard is the text from the previous statement boundary up
    // to the operator, and it must parse as exactly one availability test.
    const exitRe = /\b(exit|return|continue)\b/g;
    let om;
    while ((om = exitRe.exec(clean))) {
      const before = clean.slice(0, om.index);
      const opMatch = /\|\|\s*$/.exec(before) || /&&\s*$/.exec(before);
      if (!opMatch) continue;
      const op = opMatch[0].trim();
      const opIdx = om.index - opMatch[0].length;
      const guardText = shellGuardBeforeOperator(clean, opIdx);
      const g = parseShellGuard(guardText);
      if (!g) continue;
      if (op === '||' && g.negated) continue;  // "[ ! -f x ] || exit" exits when x EXISTS — not skip-on-missing
      if (op === '&&' && !g.negated) continue; // "[ -f x ] && exit" is skip-if-present
      const between = clean.slice(opIdx, om.index);
      if (MESSAGES.shell.test(between)) continue;
      findings.push({
        file, line: unit.line + countNewlines(unit.text.slice(0, om.index)),
        kind: om[1],
        guard: guardText.replace(/\s+/g, ' ').slice(0, 100),
        checks: g.checks, source: 'tree',
      });
    }

    // --- one-liner with a braced arm: GUARD || { ... exit ...; } — the arm
    // may contain a message before the exit, which makes the skip loud.
    const braceArmRe = /\|\|\s*\{([^{}]*)\}/g;
    let bm;
    while ((bm = braceArmRe.exec(clean))) {
      const guardText = shellGuardBeforeOperator(clean, bm.index);
      const g = parseShellGuard(guardText);
      if (!g || g.negated) continue;
      const arm = bm[1];
      const em = /\b(exit|return|continue)\b/.exec(arm);
      if (!em) continue;
      if (MESSAGES.shell.test(arm.slice(0, em.index))) continue;
      const exitAbs = bm.index + bm[0].indexOf(em[0], bm[0].indexOf('{') + 1);
      findings.push({
        file, line: unit.line + countNewlines(unit.text.slice(0, exitAbs)),
        kind: em[1],
        guard: guardText.replace(/\s+/g, ' ').slice(0, 100),
        checks: g.checks, source: 'tree',
      });
    }

    // --- block form: if <negated guard>; then ... (elif|else|fi)
    const ifRe = /\bif\s+([^;{]+?)\s*(?:;|&&|\|\|)?\s*then\b/g;
    let im;
    while ((im = ifRe.exec(clean))) {
      let cond = im[1].trim();
      let g = parseShellGuard(cond);
      if (!g || !g.negated) {
        const bang = /^!\s*(.*)$/.exec(cond);
        if (bang) {
          const inner = parseShellGuard(bang[1].trim());
          if (inner && !inner.negated) g = { checks: inner.checks, negated: true };
        }
      }
      if (!g || !g.negated) continue; // block form requires an explicit negation
      const after = clean.slice(im.index + im[0].length);
      const stop = /\b(elif|else|fi)\b/.exec(after);
      const body = stop ? after.slice(0, stop.index) : '';
      const em = /(^|[\n;])\s*(return|exit|continue)\b/.exec(body);
      if (!em) continue;
      if (MESSAGES.shell.test(body.slice(0, em.index))) continue;
      const offsetInUnit = im.index + im[0].length + em.index + (em[1] ? em[1].length : 0);
      findings.push({
        file, line: unit.line + countNewlines(unit.text.slice(0, offsetInUnit)),
        kind: em[2],
        guard: cond.replace(/\s+/g, ' ').slice(0, 100),
        checks: g.checks, source: 'tree',
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Python scanner (indentation based).
// ---------------------------------------------------------------------------
function scanPython(text, file, baseLine = 1) {
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:el)?if\s+(.+?):\s*(#.*)?$/.exec(lines[i]);
    if (!m) continue;
    const q = qualifyPyGuard(m[2]);
    if (!q) continue;
    const indent = m[1].length;
    let exitLine = -1, loud = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') continue;
      const ind = (/^ */.exec(l))[0].length;
      if (ind <= indent) break;
      if (MESSAGES.py.test(l)) { loud = true; break; }
      if (/^\s*(return|sys\.exit|exit)\b/.test(l)) { exitLine = j; break; }
    }
    if (exitLine < 0 || loud) continue;
    findings.push({
      file, line: baseLine + exitLine, kind: 'return',
      guard: m[2].replace(/\s+/g, ' ').slice(0, 100), checks: q.checks, source: 'tree',
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Tree walking and language dispatch.
// ---------------------------------------------------------------------------
function* walkFiles(root, dirRel) {
  const dirAbs = dirRel ? join(root, dirRel) : root;
  let entries;
  try { entries = readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (PRUNE_DIR_NAMES.has(e.name)) continue;
      const insideTrinity = dirRel === '.trinity' || (dirRel || '').startsWith('.trinity/');
      if (insideTrinity && !TRINITY_ALLOWED_SUBDIRS.has(e.name)) continue;
      yield* walkFiles(root, rel);
    } else if (e.isFile() && !e.isSymbolicLink()) {
      yield rel;
    }
  }
}

function emptyDirs(root, dirRel, acc) {
  const dirAbs = dirRel ? join(root, dirRel) : root;
  let entries;
  try { entries = readdirSync(dirAbs, { withFileTypes: true }); } catch { return acc; }
  if (entries.length === 0) { acc.push(dirRel); return acc; }
  for (const e of entries) {
    if (!e.isDirectory() || PRUNE_DIR_NAMES.has(e.name)) continue;
    const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
    emptyDirs(root, rel, acc);
  }
  return acc;
}

function languageOf(absPath, rel) {
  const ext = extname(rel).slice(1).toLowerCase();
  if (SOURCE_EXTENSIONS.has(ext)) {
    if (ext === 'rs') return 'rust';
    if (['js', 'mjs', 'cjs', 'ts', 'tsx'].includes(ext)) return 'js';
    if (ext === 'py') return 'py';
    if (ext === 'swift') return 'swift';
    return 'shell'; // sh / bash / zsh
  }
  if (SOURCE_BASENAMES.has(basename(rel))) return 'make';
  if (!ext) {
    let first = '';
    try { first = readFileSync(absPath, 'utf8').split('\n', 1)[0]; } catch { return null; }
    if (first.startsWith('#!')) {
      if (/node|bun/.test(first)) return 'js';
      if (/sh|bash|zsh|ash/.test(first)) return 'shell';
    }
  }
  return null;
}

function scanText(text, file, lang, baseLine = 1) {
  switch (lang) {
    case 'rust': return scanBraced(text, file, 'rust', qualifyRustGuard, baseLine);
    case 'swift': return scanBraced(text, file, 'swift', qualifySwiftGuard, baseLine);
    case 'js': return scanBraced(text, file, 'js', qualifyJsGuard, baseLine);
    case 'py': return scanPython(text, file, baseLine);
    case 'shell': return scanShell(text, file, baseLine);
    case 'make': return scanShell(text, file, baseLine);
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Recorded submodule content: reconstruct the post-image of
// .trinity/patches/<name>-integration.patch for every empty directory whose
// basename is <name>, and audit it under the directory's real path.
// ---------------------------------------------------------------------------
function recordedSubmoduleFindings(root) {
  const findings = [];
  const patchesDir = join(root, '.trinity', 'patches');
  let patches;
  try { patches = readdirSync(patchesDir); } catch { return findings; }
  const empties = emptyDirs(root, '', []);
  for (const p of patches.sort()) {
    const m = /^(.+)-integration\.patch$/.exec(p);
    if (!m) continue;
    const name = m[1];
    const target = empties.find((d) => basename(d) === name);
    if (!target) continue; // materialized on disk or no record: nothing to do
    let patchText;
    try { patchText = readFileSync(join(patchesDir, p), 'utf8'); } catch { continue; }
    // group hunks by target file; post-image line numbers from hunk headers
    const sections = new Map(); // file -> [{startLine, lines:[]}]
    let curFile = null, curSeg = null;
    for (const line of patchText.split('\n')) {
      const dm = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (dm) { curFile = dm[2]; curSeg = null; continue; }
      if (!curFile) continue;
      const hm = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hm) {
        const start = parseInt(hm[1], 10);
        const segs = sections.get(curFile) ?? [];
        const last = segs[segs.length - 1];
        if (last && last.startLine + last.lines.length === start) curSeg = last;
        else { curSeg = { startLine: start, lines: [] }; segs.push(curSeg); }
        sections.set(curFile, segs);
        continue;
      }
      if (!curSeg) continue;
      if (line.startsWith(' ') || line.startsWith('+')) curSeg.lines.push(line.slice(1));
      // '-' lines are pre-image only; '\' lines are "\ No newline at end of file"
    }
    for (const [file, segs] of [...sections.entries()].sort()) {
      const lang = languageOf(join(root, target, file), file);
      if (!lang) continue;
      for (const seg of segs) {
        const text = seg.lines.join('\n');
        findings.push(...scanText(text, `${target}/${file}`, lang, seg.startLine)
          .map((f) => ({ ...f, source: 'record' })));
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The audit. silentSkips(rootDir) -> sorted findings for that tree.
// ---------------------------------------------------------------------------
export function silentSkips(rootDir = PROJECT_DIR) {
  const findings = [];
  for (const rel of walkFiles(rootDir, '')) {
    const abs = join(rootDir, rel);
    if (abs === SCRIPT_PATH) continue; // never audit the audit
    const lang = languageOf(abs, rel);
    if (!lang) continue;
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    findings.push(...scanText(text, `trios/${rel}`, lang));
  }
  findings.push(...recordedSubmoduleFindings(rootDir).map((f) => ({ ...f, file: `trios/${f.file}` })));
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return findings;
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------
function render(findings) {
  const out = [];
  out.push('silent-skip audit — early exits that skip work when a tool or path is missing');
  out.push('scope: trios/ (paths relative to the repository root)');
  out.push('rule: an exit (return/continue/exit) governed by a NEGATED availability check');
  out.push('  (missing path or missing tool) with no message primitive emitted before the');
  out.push('  exit. A skip that prints/warns first is LOUD and is not listed.');
  out.push('out of bounds: nothing under any t27/ directory is read; the trios-mesh');
  out.push('  submodule is audited from its recorded patch, never from disk (it is not');
  out.push('  materialized in this checkout, and nothing inside it may be edited).');
  out.push('');
  for (const f of findings) {
    const tag = f.source === 'record' ? ' [record]' : '';
    out.push(`${f.file}:${f.line}${tag}  ${f.kind}  guard: ${f.guard}  checks: ${f.checks.join(' | ')}`);
  }
  out.push('');
  const files = new Set(findings.map((f) => f.file));
  const recorded = findings.filter((f) => f.source === 'record').length;
  out.push(`total: ${findings.length} silent skips in ${files.size} files (${recorded} from the recorded submodule patch)`);
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Selftest: one silent fixture, one that warns first; only the silent one may
// be reported.
// ---------------------------------------------------------------------------
function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'silent-skip-audit-'));
  try {
    writeFileSync(join(root, 'silent-build.rs'), [
      'use std::path::Path;',
      'fn main() {',
      '    let tool = "../t27/target/release/t27c";',
      '    if !Path::new(tool).exists() {',
      '        return; // silent: nothing is printed before the exit',
      '    }',
      '    println!("cargo:rerun-if-changed=specs/");',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'loud-build.rs'), [
      'use std::path::Path;',
      'fn main() {',
      '    let tool = "../t27/target/release/t27c";',
      '    if !Path::new(tool).exists() {',
      '        println!("cargo:warning=t27c not found at ../t27/target/release/t27c - skipping regen");',
      '        return; // loud: a warning is emitted first',
      '    }',
      '}',
      '',
    ].join('\n'));
    const found = silentSkips(root);
    const silent = found.filter((f) => f.file.endsWith('silent-build.rs'));
    const loud = found.filter((f) => f.file.endsWith('loud-build.rs'));
    const fail = (msg) => { console.error(`selftest FAILED: ${msg}`); process.exit(1); };
    if (loud.length !== 0) fail(`the fixture that warns first was reported (${loud.length} finding(s)); the rule must treat it as loud`);
    if (silent.length !== 1) fail(`expected exactly 1 finding in silent-build.rs, got ${silent.length} (all findings: ${JSON.stringify(found)})`);
    const f = silent[0];
    if (f.line !== 5) fail(`exit line expected 5, got ${f.line}`);
    if (f.kind !== 'return') fail(`exit kind expected "return", got ${f.kind}`);
    if (!/t27c/.test(f.checks.join(' '))) fail(`checks must name the checked path, got ${f.checks.join(' | ')}`);
    console.log('selftest OK:');
    console.log(`  silent fixture reported once at ${f.file}:${f.line} (${f.kind}, checks ${f.checks.join(' | ')})`);
    console.log('  loud fixture (warns before returning) reported 0 times');
    process.exit(0);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  selftest();
} else {
  process.stdout.write(render(silentSkips()));
}
