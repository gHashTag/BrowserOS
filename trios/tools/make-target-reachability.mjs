#!/usr/bin/env node
// -----------------------------------------------------------------------------
// trios/tools/make-target-reachability.mjs
//
// Make target reachability audit for the worker containers this project's bees
// run in. The Makefile is the project's documented interface (see CLAUDE.md:
// "Make is the interface; ./build.sh is its implementation detail"), but the
// worker image ships only sh, bash, node, bun and git. It has no python3, no
// swift, no make. Any brief that says "run `make forensics` and quote the
// output" is therefore unrunnable by every worker, and a missing interpreter
// must never be read as a passing run.
//
// This tool does not run, port or judge the Makefile. It makes the situation
// legible: for every target it reports whether the recipe (and everything the
// recipe pulls in) can execute with the declared worker tool set.
//
// What it checks, per target:
//   - every command word of every recipe line (shell keywords/builtins pass,
//     because sh itself provides them and sh is present);
//   - command substitutions $( ... ) and `...` inside recipes;
//   - repo-local scripts launched by a recipe (directly or via sh/bash/node/
//     bun), followed ONE level deep - build.sh is sh, but its body calls
//     swift, so following it keeps `make dev` from being blessed reachable
//     when it is not;
//   - prerequisite targets: a target that depends on an unreachable target is
//     itself unreachable, and the chain is printed;
//   - $(MAKE)/make recursion inside recipes (invoking make at all already
//     needs a tool the worker lacks; the referenced target is also inherited).
//
// How to run (workers have node):
//   node trios/tools/make-target-reachability.mjs
//   node trios/tools/make-target-reachability.mjs --recipe dashboard
//   node trios/tools/make-target-reachability.mjs --makefile other/Makefile --depth 8
//
// Constraints honoured (issue gHashTag/trios#1361):
//   FR-001  no Python file is rewritten, ported or deleted - none is opened
//          for anything but a shebang line;
//   FR-002  the Makefile is read, never written; its behaviour is untouched;
//   FR-003  the worker tool set lives as data below and is printed by the run;
//   FR-004  chains are resolved to MAX_CHAIN_DEPTH_DEFAULT (printed); deeper
//          chains are reported `undetermined`, never assumed reachable;
//   FR-005  runs under node with the Node standard library only, and never
//          invokes make (or any other subprocess).
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// =============================================================================
// DATA - the single place to correct when the worker image changes (FR-003)
// =============================================================================

// Measured in the running worker container: it has exactly these, and it has
// no python3, no swift, no make. If the image gains or loses a tool, edit this
// array; every verdict below is derived from it.
const WORKER_TOOL_SET = ['sh', 'bash', 'node', 'bun', 'git'];
const WORKER_TOOLS = new Set(WORKER_TOOL_SET);

// Interpreters that, when they launch a repo-local script, cause the script's
// body to be followed (one level) by this audit.
const SCRIPT_LAUNCHERS = new Set(['sh', 'bash', 'dash', 'node', 'bun']);

// Shell keywords that may PRECEDE the real command on a command line
// (`if ! cmd`, `while cmd; do`, `time cmd`). Everything else in the builtin
// list is a command in its own right - what follows it is arguments.
const LEADING_KEYWORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', 'time',
  '!', '{', '}', '(', ')', 'esac',
]);

// Shell keywords and builtins. These are provided by sh/bash itself - they
// need no external binary, so a recipe that uses only these plus the tool set
// above is worker-reachable.
const SHELL_BUILTINS = new Set([
  ...LEADING_KEYWORDS,
  'for', 'case', 'in', 'function', 'select', 'coproc',
  ':', '.', 'break', 'cd', 'continue', 'eval', 'exec', 'exit', 'export',
  'getopts', 'hash', 'pwd', 'readonly', 'return', 'set', 'shift', 'test',
  '[', 'times', 'trap', 'true', 'false', 'umask', 'unset', 'wait',
  'alias', 'unalias', 'bind', 'builtin', 'caller', 'command', 'declare',
  'typeset', 'dirs', 'disown', 'enable', 'echo', 'let', 'local', 'logout',
  'mapfile', 'readarray', 'popd', 'pushd', 'printf', 'read', 'shopt',
  'source', 'suspend', 'type', 'ulimit', 'jobs', 'kill', 'bg', 'fg',
]);

// FR-004 - chains are resolved to this depth; deeper ones are `undetermined`.
const MAX_CHAIN_DEPTH_DEFAULT = 16;

// Repo-local scripts referenced by recipes are followed this many levels.
// Depth 1 means: a script named by the Makefile is read; scripts named by that
// script are recorded but not followed (recorded as unresolved, so a target
// whose only evidence hides two scripts down is `undetermined`, not blessed).
const SCRIPT_FOLLOW_DEPTH = 1;

// =============================================================================
// END OF DATA
// =============================================================================

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

// Unresolvable make constructs (functions like $(shell ...)) are replaced by
// this sentinel so the shell scanner cannot mistake them for shell syntax.
const UNRESOLVED_MARK = '\u00ab'; // <<

// Make function names - never variables; do not try to expand their value.
const MAKE_FUNCTIONS = new Set([
  'shell', 'wildcard', 'subst', 'patsubst', 'strip', 'findstring', 'filter',
  'filter-out', 'sort', 'word', 'words', 'wordlist', 'firstword', 'lastword',
  'dir', 'notdir', 'suffix', 'basename', 'addsuffix', 'addprefix', 'join',
  'realpath', 'abspath', 'if', 'or', 'and', 'foreach', 'call', 'value',
  'eval', 'origin', 'flavor', 'error', 'warning', 'info', 'file',
]);

const SPECIAL_TARGET_RE = /^\.[A-Za-z0-9_-]+$/;

// Absolute paths outside this checkout that are never commands.
const NON_COMMAND_ABS = [/^\/dev\//, /^\/tmp\//, /^\/proc\//, /^\/var\//, /^\/etc\//];
// Where system executables live; their basename is the tool name.
const BIN_DIRS = [
  /^\/usr\/bin\//, /^\/bin\//, /^\/usr\/local\/bin\//,
  /^\/opt\/homebrew\/bin\//, /^\/usr\/sbin\//, /^\/sbin\//,
];

// -----------------------------------------------------------------------------
// Makefile parsing
// -----------------------------------------------------------------------------

/** Join backslash continuations into logical lines, keeping line numbers. */
function logicalLines(sourceText) {
  const physical = sourceText.split('\n');
  const out = [];
  let i = 0;
  while (i < physical.length) {
    const first = i;
    let text = physical[i];
    const isRecipe = text.startsWith('\t');
    // A trailing backslash continues the line. In a recipe the next physical
    // line's leading tab is Makefile syntax, not shell text, so it is dropped.
    while (text.endsWith('\\') && i + 1 < physical.length) {
      const next = physical[i + 1];
      const tail = isRecipe && next.startsWith('\t') ? next.slice(1) : next;
      text = text.slice(0, -1) + ' ' + tail;
      i += 1;
    }
    out.push({ text, line: first + 1, isRecipe });
    i += 1;
  }
  return out;
}

/** Strip a Make comment (recipes are handled by the shell scanner instead). */
function stripComment(text) {
  const idx = text.indexOf('#');
  return idx === -1 ? text : text.slice(0, idx);
}

const ASSIGN_RE =
  /^\s*(?:export\s+|override\s+|unexport\s+)*([A-Za-z0-9_.%-]+)\s*(::?=|\?=|\+=|!=|=)\s*(.*)$/;

/**
 * Parse a Makefile into variables and rules.
 * Conditionals (ifeq/ifneq/...) are parsed as a union of all branches - the
 * audit is deliberately conservative: a tool used in ANY branch counts.
 */
function parseMakefile(sourceText, root) {
  const vars = new Map();
  const rules = new Map(); // name -> rule
  const targetOrder = [];
  const phony = new Set();

  const defineVar = (name, value, flavor) => {
    if (flavor === '?=') {
      if (!vars.has(name)) vars.set(name, { value, flavor });
    } else if (flavor === '+=') {
      const prev = vars.get(name);
      vars.set(name, {
        value: prev ? prev.value + ' ' + value : value,
        flavor: prev ? prev.flavor : '=',
      });
    } else {
      vars.set(name, { value, flavor });
    }
  };

  // Synthetic variables so expansion matches what make computes at parse time.
  vars.set('MAKE', { value: 'make', flavor: 'simple' });
  vars.set('ROOT', { value: root, flavor: 'simple' });
  vars.set('CURDIR', { value: root, flavor: 'simple' });
  vars.set('MAKEFILE_LIST', { value: path.join(root, 'Makefile'), flavor: 'simple' });

  let currentRule = null;
  let inDefine = null;

  for (const { text, line } of logicalLines(sourceText)) {
    if (inDefine) {
      if (/^endef\b/.test(text)) inDefine = null;
      else {
        const prev = vars.get(inDefine);
        vars.set(inDefine, {
          value: (prev ? prev.value + '\n' : '') + text,
          flavor: 'recursive',
        });
      }
      continue;
    }
    if (text.startsWith('\t')) {
      if (currentRule) currentRule.recipe.push({ text: text.slice(1), line });
      continue;
    }
    const bare = stripComment(text).trim();
    if (bare === '') continue;

    const defineMatch = /^define\s+([A-Za-z0-9_.%-]+)/.exec(bare);
    if (defineMatch) { inDefine = defineMatch[1]; continue; }
    if (/^(include|-include|sinclude)\b/.test(bare)) continue;
    if (/^(ifeq|ifneq|ifdef|ifndef|else|endif|vpath|undefine)\b/.test(bare)) continue;
    if (bare.startsWith('$(') || bare.startsWith('${')) continue; // $(error ...) etc.

    const assign = ASSIGN_RE.exec(bare);
    if (assign) {
      defineVar(assign[1], assign[3].trim(), assign[2]);
      currentRule = null;
      continue;
    }

    // Rule header: `targets : prerequisites` (no pattern/double-colon rules
    // exist in this Makefile; both would still parse through this path).
    const colon = bare.indexOf(':');
    if (colon === -1) { currentRule = null; continue; }
    const targetPart = bare.slice(0, colon).trim();
    const prereqPart = bare.slice(colon + 1).trim();

    // Target-specific variable (`target: VAR = value`)? Then no recipe attaches.
    const tsv = /^([A-Za-z0-9_.%-]+)\s*(::?=|\?=|\+=|!=|=)\s*(.*)$/.exec(prereqPart);
    if (tsv) {
      for (const t of targetPart.split(/\s+/).filter(Boolean)) {
        const rule = rules.get(t);
        if (rule) rule.recipeVars.push({ name: tsv[1], value: tsv[3].trim(), flavor: tsv[2] });
      }
      currentRule = null;
      continue;
    }

    const targets = targetPart.split(/\s+/).filter(Boolean);
    if (targets.length === 0) { currentRule = null; continue; }

    currentRule = null;
    for (const name of targets) {
      if (name === '.PHONY') {
        for (const p of prereqPart.split(/\s+/).filter(Boolean)) phony.add(p);
        continue;
      }
      if (SPECIAL_TARGET_RE.test(name)) continue; // make directives, not runnable targets
      if (!rules.has(name)) {
        rules.set(name, { name, line, prereqText: prereqPart, recipe: [], recipeVars: [] });
        targetOrder.push(name);
      }
      currentRule = rules.get(name);
    }
  }

  // The Makefile computes ROOT/CURDIR with `$(shell cd ... && pwd)`, which this
  // audit cannot (and need not) evaluate; the answer is the Makefile's own
  // directory, so pin the synthetic value over the unresolvable one.
  for (const n of ['ROOT', 'CURDIR']) {
    const entry = vars.get(n);
    if (entry && entry.value.includes('$')) vars.set(n, { value: root, flavor: 'simple' });
  }
  return { vars, rules, targetOrder, phony };
}

// -----------------------------------------------------------------------------
// Variable expansion (Make side; `$$` pairs are left for the shell scanner)
// -----------------------------------------------------------------------------

function expandMakeVars(text, vars, depth = 0) {
  if (depth > 6 || !text.includes('$')) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== '$') { out += c; i += 1; continue; }
    if (text[i + 1] === '$') { out += '$$'; i += 2; continue; } // shell dollar
    const open = text[i + 1];
    if (open !== '(' && open !== '{') { out += c; i += 1; continue; } // $@ $< etc.
    const close = open === '(' ? ')' : '}';
    // Find the balanced close (Make does not care about shell quotes).
    let level = 0;
    let end = -1;
    for (let p = i + 1; p < text.length; p += 1) {
      if (text[p] === open) level += 1;
      else if (text[p] === close) {
        level -= 1;
        if (level === 0) { end = p; break; }
      }
    }
    if (end === -1) { out += c; i += 1; continue; }
    const inner = text.slice(i + 2, end).trim();
    const funcMatch = /^([a-zA-Z-]+)\b/.exec(inner);
    if (funcMatch && MAKE_FUNCTIONS.has(funcMatch[1])) {
      out += `${UNRESOLVED_MARK}unresolved:${funcMatch[1]}\u00bb`;
      i = end + 1;
      continue;
    }
    // Variable reference (allow `$(VAR:substitution)` - use the base name).
    const name = inner.split(':')[0].trim();
    const entry = vars.get(name);
    if (entry === undefined) {
      i = end + 1; // undefined Make variables expand to nothing
      continue;
    }
    out += expandMakeVars(entry.value, vars, depth + 1);
    i = end + 1;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Shell scanning - split a (joined) shell line into command segments and
// command substitutions, then reduce each segment to its command word.
// -----------------------------------------------------------------------------

/**
 * Scan shell text. Returns command segments and the payload of every command
 * substitution. In Make recipes the shell sees `$$(` after Make expansion, so
 * that form is the substitution marker there; inside plain shell scripts
 * (singleDollarSub) a single `$( ... )` is a substitution too.
 */
function scanShell(text, singleDollarSub = false) {
  const segments = [];
  const substitutions = [];
  let cur = '';
  let subBuf = '';
  let btBuf = '';
  let sq = false;
  let dq = false;
  let bt = false;
  let sub = 0;
  let subSq = false;
  let subDq = false;
  const push = () => {
    const trimmed = cur.trim();
    if (trimmed !== '') segments.push(trimmed);
    cur = '';
  };
  const enterSub = (emit) => { sub = 1; subBuf = ''; cur += emit; };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (sub > 0) {
      // Inside $( ... ): parens only nest OUTSIDE quotes - a quoted '(' in an
      // argument (grep 'size: (small)') must not swallow the substitution.
      if (subSq) {
        if (c === "'") subSq = false;
        subBuf += c; i += 1; continue;
      }
      if (subDq) {
        if (c === '\\') { subBuf += c + (text[i + 1] ?? ''); i += 2; continue; }
        if (c === '"') subDq = false;
        subBuf += c; i += 1; continue;
      }
      if (c === "'") { subSq = true; subBuf += c; i += 1; continue; }
      if (c === '"') { subDq = true; subBuf += c; i += 1; continue; }
      if (c === '\\') { subBuf += c + (text[i + 1] ?? ''); i += 2; continue; }
      if (c === '(') { sub += 1; subBuf += c; }
      else if (c === ')') {
        sub -= 1;
        if (sub === 0) { substitutions.push(subBuf); cur += '$()'; subBuf = ''; }
        else subBuf += c;
      } else subBuf += c;
      i += 1;
      continue;
    }
    if (bt) {
      if (c === '`') { bt = false; substitutions.push(btBuf); cur += '``'; btBuf = ''; }
      else btBuf += c;
      i += 1;
      continue;
    }
    if (sq) {
      if (c === "'") sq = false;
      else cur += c;
      i += 1;
      continue;
    }
    if (dq) {
      if (c === '\\') { cur += c + (text[i + 1] ?? ''); i += 2; continue; }
      if (c === '"') { dq = false; cur += c; i += 1; continue; }
      if (c === '`') { bt = true; cur += c; i += 1; continue; }
      if (c === '$' && text[i + 1] === '$' && text[i + 2] === '(') { enterSub('$('); i += 3; continue; }
      if (singleDollarSub && c === '$' && text[i + 1] === '(') { enterSub('$('); i += 2; continue; }
      cur += c; i += 1; continue;
    }
    if (c === '\\') { cur += c + (text[i + 1] ?? ''); i += 2; continue; }
    if (c === "'") { sq = true; cur += c; i += 1; continue; }
    if (c === '"') { dq = true; cur += c; i += 1; continue; }
    if (c === '`') { bt = true; cur += c; i += 1; continue; }
    if (c === '$' && text[i + 1] === '$' && text[i + 2] === '(') { enterSub('$('); i += 3; continue; }
    if (singleDollarSub && c === '$' && text[i + 1] === '(') { enterSub('$('); i += 2; continue; }
    if (c === '#') break; // shell comment to end of line
    if (c === ';') { push(); i += 1; if (text[i] === ';') i += 1; continue; }
    if (c === '&') { push(); i += 1; if (text[i] === '&') i += 1; continue; }
    // `|`, `(` and `)` only separate commands when they stand alone. Attached
    // to a word (`dev)`, `dev|test)`) they are case-pattern text, not shell
    // operators - splitting them would read the pattern as a command.
    const standalone = cur === '' || /\s$/.test(cur) || cur.endsWith('$()') || cur.endsWith('``');
    if (c === '|') {
      if (standalone) { push(); i += 1; if (text[i] === '|' || text[i] === '&') i += 1; continue; }
      cur += c; i += 1; continue;
    }
    if (c === '(' || c === ')') {
      if (standalone) { push(); cur = c; push(); i += 1; continue; }
      cur += c; i += 1; continue;
    }
    if (c === '\n') { push(); i += 1; continue; }
    cur += c;
    i += 1;
  }
  push();
  // A genuinely unbalanced $( or ` is a defect in the text under scan; the
  // payload captured so far is still analysed rather than dropped silently.
  if (sub > 0 && subBuf.trim() !== '') substitutions.push(subBuf);
  if (bt && btBuf.trim() !== '') substitutions.push(btBuf);
  return { segments, substitutions };
}

/** Tokenise one command segment (quote-aware). */
function tokenize(segment) {
  const tokens = [];
  let cur = '';
  let quoted = false;
  let sq = false;
  let dq = false;
  const push = () => {
    if (cur !== '') {
      tokens.push({ raw: cur, text: stripQuotes(cur), quoted });
      cur = '';
    }
    quoted = false;
  };
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i];
    if (sq) {
      if (c === "'") sq = false;
      else cur += c;
      continue;
    }
    if (dq) {
      if (c === '\\') { cur += c + (segment[i + 1] ?? ''); i += 1; continue; }
      if (c === '"') dq = false;
      else cur += c;
      continue;
    }
    if (c === '\\') { cur += c + (segment[i + 1] ?? ''); i += 1; continue; }
    if (c === "'") { sq = true; quoted = true; continue; }
    if (c === '"') { dq = true; quoted = true; continue; }
    if (/\s/.test(c)) { push(); continue; }
    cur += c;
  }
  push();
  return tokens;
}

function stripQuotes(token) {
  let t = token;
  while ((t.startsWith('"') && t.endsWith('"') && t.length > 1) ||
         (t.startsWith("'") && t.endsWith("'") && t.length > 1)) {
    t = t.slice(1, -1);
  }
  return t;
}

const SKIP_SEGMENT_KEYWORDS = new Set(['for', 'case']);
const REDIRECT_RE = /^(>>?|<|\d*>&?\d*|>&|\d*>>?)$/;

/**
 * Command words of a segment: skipping redirections, leading `NAME=value`
 * assignments and leading keywords. Returns the first candidate command word
 * plus following argument words (up to three tokens, enough for the caller to
 * see `bash script.sh`), or {none}, or {skip} for constructs (`for x in ...`,
 * `case ... in`) whose remainder cannot contain a command before the next
 * separator.
 */
function commandWords(segment) {
  const tokens = tokenize(segment);
  const found = [];
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const tok = tokens[idx];
    if (REDIRECT_RE.test(tok.raw)) continue;
    if (!tok.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.raw)) continue; // assignment prefix
    if (SKIP_SEGMENT_KEYWORDS.has(tok.text)) return { skip: true };
    if (LEADING_KEYWORDS.has(tok.text)) continue;
    if (tok.text === 'in') return { skip: true }; // for-list residue
    if (/\)$/.test(tok.raw)) continue; // case pattern like `dev)`
    found.push({ word: tok.text, raw: tok.raw, quoted: tok.quoted, idx });
    if (found.length >= 3) break;
  }
  return found.length > 0 ? { words: found, tokens } : { none: true };
}

// -----------------------------------------------------------------------------
// Tool classification
// -----------------------------------------------------------------------------

/** A command word must look like an executable name; anything else is noise. */
function plausibleTool(word) {
  return /^[A-Za-z0-9_.\/][A-Za-z0-9_.\/@-]*$/.test(word) && /[A-Za-z]/.test(word);
}

/** Resolve a repo-local path named by a recipe, or null if none. */
function resolveRepoPath(word, root) {
  if (!word.includes('/') && !/\.(sh|mjs|js|py|swift)$/.test(word)) return null;
  const abs = path.isAbsolute(word) ? word : path.resolve(root, word);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // outside this checkout
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
}

/** Read a script's shebang and map it to the interpreter it requires. */
function shebangInterpreter(absPath) {
  const fd = fs.openSync(absPath, 'r');
  const buf = Buffer.alloc(160);
  const n = fs.readSync(fd, buf, 0, 160, 0);
  fs.closeSync(fd);
  const first = buf.toString('utf8', 0, n).split('\n')[0] ?? '';
  if (!first.startsWith('#!')) return null;
  const parts = first.slice(2).trim().split(/\s+/);
  let interp = parts[0].split('/').pop();
  if (interp === 'env' && parts[1]) interp = parts[1].split('/').pop(); // #!/usr/bin/env node
  return { interpreter: interp, line: first };
}

/**
 * Classify one command word against the worker tool set.
 * kind: 'builtin' | 'worker' | 'script' | 'missing' | 'unresolved' | 'noise'
 */
function classifyWord(word, root) {
  if (word.startsWith(UNRESOLVED_MARK)) return { kind: 'unresolved' };
  if (!plausibleTool(word)) return { kind: 'noise' };
  const base = word.includes('/') ? word.split('/').pop() : word;
  if (SHELL_BUILTINS.has(word) || SHELL_BUILTINS.has(base)) return { kind: 'builtin' };
  if (WORKER_TOOLS.has(word) || WORKER_TOOLS.has(base)) {
    return { kind: 'worker', base };
  }
  if (word.includes('/')) {
    if (NON_COMMAND_ABS.some((re) => re.test(word))) return { kind: 'noise' };
    const script = resolveRepoPath(word, root);
    if (script) {
      const sb = shebangInterpreter(script);
      if (sb) {
        if (WORKER_TOOLS.has(sb.interpreter)) {
          return { kind: 'script', script, interpreter: sb.interpreter };
        }
        return { kind: 'missing', tool: sb.interpreter, script };
      }
      return { kind: 'script', script, interpreter: null };
    }
    if (BIN_DIRS.some((re) => re.test(word))) return { kind: 'missing', tool: base };
  }
  return { kind: 'missing', tool: base };
}

// -----------------------------------------------------------------------------
// Recipe / script analysis
// -----------------------------------------------------------------------------

/**
 * Analyse one shell text (a recipe line, a script line or a substitution
 * payload). Collects missing tools, unresolved words and make recursion edges.
 * `ctx` carries { root, acc, localFunctions, scriptDepth, singleDollarSub }.
 */
function analyseShellText(text, where, ctx) {
  // Make prefixes (@ silence, - ignore errors, + always run) are not shell.
  const line = text.replace(/^[@+-]+/, '');
  const { segments, substitutions } = scanShell(line, ctx.singleDollarSub);
  for (const seg of segments) {
    const cw = commandWords(seg);
    if (cw.none || cw.skip) continue;
    const first = cw.words[0];
    const word = first.word;
    if (word.startsWith('$')) {
      ctx.acc.unresolved.push({ ...where, word, note: 'shell variable in command position' });
      continue;
    }
    if (ctx.localFunctions && ctx.localFunctions.has(word)) continue; // defined in-script
    const cls = classifyWord(word, ctx.root);
    if (cls.kind === 'missing') {
      ctx.acc.missing.push({
        ...where,
        tool: cls.tool,
        via: cls.script
          ? `${path.relative(ctx.root, cls.script)} (shebang needs '${cls.tool}')`
          : undefined,
        word,
      });
    } else if (cls.kind === 'unresolved') {
      ctx.acc.unresolved.push({ ...where, word });
    } else if (cls.kind === 'script') {
      followScript(cls.script, where, ctx);
    } else if (cls.kind === 'worker' && SCRIPT_LAUNCHERS.has(cls.base)) {
      // `bash script.sh`, `node tools/x.mjs`: the launcher is fine, but the
      // script BODY decides whether the target can actually run here.
      const args = cw.words.slice(1).map((w) => w.word);
      for (const arg of args) {
        const script = resolveRepoPath(arg, ctx.root);
        if (script) { followScript(script, where, ctx); break; }
      }
    }
    // make / $(MAKE) recursion: flag the tool and inherit the named target.
    if (word === 'make' || (word.includes('/') && word.split('/').pop() === 'make')) {
      for (const tok of tokenize(seg).map((t) => t.text)) {
        if (tok.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
        if (ctx.acc.knownTargets.has(tok)) ctx.acc.makeEdges.add(tok);
      }
    }
  }
  for (const sub of substitutions) {
    // $(( ... )) is arithmetic, not a command - its payload is not shell.
    if (sub.trim().startsWith('(')) continue;
    analyseShellText(sub, where, ctx);
  }
}

/** Follow a repo-local script (bounded by SCRIPT_FOLLOW_DEPTH). */
function followScript(absPath, where, ctx) {
  const rel = path.relative(ctx.root, absPath);
  if (ctx.acc.scriptsRead.has(rel)) return; // already followed for this target
  ctx.acc.scriptsRead.add(rel);
  if (ctx.scriptDepth >= SCRIPT_FOLLOW_DEPTH) {
    ctx.acc.unresolved.push({
      ...where,
      word: rel,
      note: `nested script beyond follow depth ${SCRIPT_FOLLOW_DEPTH}`,
    });
    return;
  }
  const source = fs.readFileSync(absPath, 'utf8');
  // Shell functions defined in this script are available to its later lines;
  // calling one is not invoking an external tool.
  const localFunctions = new Set();
  const lines = logicalLines(source);
  for (const { text } of lines) {
    const fn = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)/.exec(text.trimStart());
    if (fn) localFunctions.add(fn[1]);
  }
  const scriptCtx = {
    root: ctx.root,
    acc: ctx.acc,
    localFunctions,
    scriptDepth: ctx.scriptDepth + 1,
    singleDollarSub: true, // inside a script, $( ) is the shell's, not make's
  };
  for (const { text, line } of lines) {
    if (text.startsWith('#!')) continue;
    const body = text.startsWith('\t') ? text.slice(1) : text;
    if (body.trim() === '' || body.trim().startsWith('#')) continue;
    analyseShellText(body, { file: rel, line }, scriptCtx);
  }
}

/** Analyse a target's recipe with its target-specific variables layered in. */
function analyseRecipe(rule, vars, rules, root) {
  const acc = {
    missing: [],
    unresolved: [],
    scriptsRead: new Set(),
    makeEdges: new Set(),
    knownTargets: new Set(rules.keys()),
  };
  const layered = new Map(vars);
  for (const rv of rule.recipeVars) layered.set(rv.name, { value: rv.value, flavor: rv.flavor });
  // Shell functions defined inside the recipe itself (check-selftest defines
  // refuse(), sources-drift-selftest defines run()) are not external tools.
  const localFunctions = new Set();
  const joined = rule.recipe.map((r) => r.text).join('\n');
  for (const fn of joined.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/g)) {
    localFunctions.add(fn[1]);
  }
  for (const r of rule.recipe) {
    const expanded = expandMakeVars(r.text, layered);
    analyseShellText(
      expanded,
      { file: 'Makefile', line: r.line },
      { root, acc, localFunctions, scriptDepth: 0, singleDollarSub: false },
    );
  }
  return acc;
}

// -----------------------------------------------------------------------------
// Reachability (the core classifier)
// -----------------------------------------------------------------------------

/**
 * Classify one target:
 *   reachable    - every command word is a shell builtin or in WORKER_TOOL_SET,
 *                  and the same holds for every inherited target and script;
 *   unreachable  - a missing tool appears directly or through inheritance;
 *   undetermined - an unresolvable word, a nested script beyond follow depth,
 *                  or (FR-004) a chain longer than maxDepth.
 * `chain` carries the path for evidence printing; `depthLeft` enforces the
 * stated depth limit. Cycles are cut and noted, never assumed reachable.
 */
function targetReachability(name, rules, analyses, chain, depthLeft, maxDepth) {
  const rule = rules.get(name);
  if (!rule) return { status: 'unknown-target', chain: [...chain, name] };

  if (chain.includes(name)) {
    return { status: 'cycle', chain: [...chain, name], note: `cycle back to ${name}` };
  }
  if (depthLeft <= 0) {
    return {
      status: 'undetermined',
      chain: [...chain, name],
      note: `chain deeper than the stated limit (${maxDepth})`,
    };
  }

  const acc = analyses.get(name);
  const path = [...chain, name];

  if (acc.missing.length > 0) {
    return { status: 'unreachable', chain: path, direct: acc.missing };
  }

  // Inheritance: prerequisite targets, plus targets invoked via $(MAKE).
  const edges = [];
  const expandedPrereqs = expandMakeVars(rule.prereqText, analyses.vars)
    .split(/\s+/)
    .filter((p) => p && p !== '|' && rules.has(p));
  for (const p of expandedPrereqs) edges.push(p);
  for (const e of acc.makeEdges) if (!edges.includes(e)) edges.push(e);

  let inherited = null; // first unreachable chain (printed as evidence)
  let sawUndetermined = false;
  const notes = [];
  for (const edge of edges) {
    const sub = targetReachability(edge, rules, analyses, path, depthLeft - 1, maxDepth);
    if (sub.status === 'unreachable' && !inherited) inherited = sub;
    if (sub.status === 'undetermined') sawUndetermined = true;
    if (sub.status === 'cycle') notes.push(sub.note);
    if (sub.status === 'unknown-target') notes.push(`prerequisite '${edge}' has no rule`);
  }
  if (inherited) {
    return { status: 'unreachable', chain: inherited.chain, via: inherited.chain[1] };
  }
  if (sawUndetermined) {
    return { status: 'undetermined', chain: path, note: 'inherited undetermined prerequisite', notes };
  }
  if (acc.unresolved.length > 0) {
    return { status: 'undetermined', chain: path, unresolved: acc.unresolved, notes };
  }
  return { status: 'reachable', chain: path, notes };
}

// -----------------------------------------------------------------------------
// Recipe extraction (--recipe): the worker-side proof technique
// -----------------------------------------------------------------------------

/** Print a target's recipe body as shell-ready lines (the sh-proof technique). */
function printRecipe(name, rules, vars, out) {
  const rule = rules.get(name);
  if (!rule) {
    out(`no rule for target '${name}' in the audited Makefile`);
    return 1;
  }
  const layered = new Map(vars);
  for (const rv of rule.recipeVars) layered.set(rv.name, { value: rv.value, flavor: rv.flavor });
  out(`# Recipe for target '${name}' (rule at Makefile:${rule.line})`);
  out('# Extracted as make would pass it to the shell: strip the leading tab and');
  out('# any @ - + prefix, keep backslash continuations, replace $$ with $, and');
  out("# expand $(VARS) from the Makefile's := block. Then prove it from a");
  out('# worker by running the body with sh:   sh -c "<body>"');
  for (const r of rule.recipe) {
    let line = expandMakeVars(r.text, layered);
    line = line.replace(/^[@+-]+/, '');
    line = line.replace(/\$\$/g, '$');
    out(line);
  }
  return 0;
}

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------

function renderMissing(f) {
  const loc = `${f.file}:${f.line}`;
  if (f.via) return `    ${loc}: '${f.word}' -> ${f.via} - not in the worker tool set`;
  return `    ${loc}: invokes '${f.tool}' - not in the worker tool set`;
}

function main() {
  const args = process.argv.slice(2);
  const opts = { makefile: null, depth: MAX_CHAIN_DEPTH_DEFAULT, recipe: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--makefile') opts.makefile = args[++i];
    else if (args[i] === '--depth') opts.depth = Number(args[++i]);
    else if (args[i] === '--recipe') opts.recipe = args[++i];
    else {
      process.stderr.write(`unknown argument: ${args[i]}\n`);
      process.stderr.write('usage: node make-target-reachability.mjs [--makefile PATH] [--depth N] [--recipe TARGET]\n');
      process.exit(2);
    }
  }

  const makefilePath = opts.makefile ? path.resolve(opts.makefile) : path.join(DEFAULT_ROOT, 'Makefile');
  const root = path.dirname(makefilePath);
  const source = fs.readFileSync(makefilePath, 'utf8');

  const parsed = parseMakefile(source, root);
  const analyses = new Map();
  for (const [name, rule] of parsed.rules) {
    analyses.set(name, analyseRecipe(rule, parsed.vars, parsed.rules, root));
  }
  analyses.vars = parsed.vars; // used by targetReachability's prereq expansion

  if (opts.recipe) {
    const code = printRecipe(opts.recipe, parsed.rules, parsed.vars, (s) => console.log(s));
    process.exit(code);
  }

  const maxDepth = opts.depth;
  const results = new Map();
  for (const name of parsed.targetOrder) {
    results.set(name, targetReachability(name, parsed.rules, analyses, [], maxDepth, maxDepth));
  }

  const reachable = [];
  const unreachable = [];
  const undetermined = [];
  for (const name of parsed.targetOrder) {
    const res = results.get(name);
    if (res.status === 'reachable') reachable.push(name);
    else if (res.status === 'unreachable') unreachable.push(name);
    else if (res.status === 'undetermined') undetermined.push(name);
  }

  const scriptsRead = new Set();
  for (const acc of analyses.values()) for (const s of acc.scriptsRead) scriptsRead.add(s);

  const physicalLines = source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
  const relSelf = path.relative(root, path.join(SCRIPT_DIR, 'make-target-reachability.mjs'));

  const w = (s) => console.log(s);
  w('Make target reachability audit');
  w(`Makefile: ${makefilePath} (${physicalLines} lines, ${parsed.targetOrder.length} targets audited)`);
  w('');
  w(`Worker tool set (data in ${relSelf}, WORKER_TOOL_SET): ${WORKER_TOOL_SET.join(', ')}`);
  w('Measured in the running worker container: sh, bash, node, bun, git present;');
  w('python3, swift, make absent. Correct WORKER_TOOL_SET when the image changes.');
  w('Shell keywords and builtins (echo, cd, test, :, ...) pass: sh provides them.');
  w(`Repo-local scripts named by recipes are followed ${SCRIPT_FOLLOW_DEPTH} level deep: ${[...scriptsRead].sort().join(', ') || '(none referenced)'}`);
  w(`Chain depth limit: ${maxDepth} - deeper chains are reported 'undetermined', never assumed reachable`);
  w('');
  w(`Targets audited: ${parsed.targetOrder.length}`);
  w(`Reachable:    ${reachable.length}`);
  w(`Unreachable:  ${unreachable.length}`);
  w(`Undetermined: ${undetermined.length}`);
  w('');
  w('Reachable targets (recipes use only the worker tool set and shell builtins):');
  if (reachable.length === 0) w('  (none)');
  for (let i = 0; i < reachable.length; i += 6) {
    w('  ' + reachable.slice(i, i + 6).join(', '));
  }
  w('');
  w('Unreachable targets - each names the missing tool(s) and the line:');
  for (const name of unreachable) {
    const res = results.get(name);
    const acc = analyses.get(name);
    w(`  ${name} (rule at Makefile:${parsed.rules.get(name).line})`);
    // Distinct missing tools, first occurrence, capped for readability.
    const direct = res.direct ?? acc.missing;
    const seen = new Map();
    for (const f of direct) {
      const key = `${f.tool}@${f.file}:${f.line}`;
      if (!seen.has(key)) seen.set(key, f);
    }
    const findings = [...seen.values()];
    const cap = 8;
    for (const f of findings.slice(0, cap)) w(renderMissing(f));
    if (findings.length > cap) {
      w(`    ... and ${findings.length - cap} more distinct missing-tool findings for this target`);
    }
    if (res.via) {
      const chainStr = res.chain.join(' -> ');
      const leaf = res.chain[res.chain.length - 1];
      const leafAcc = analyses.get(leaf);
      if (leafAcc && leafAcc.missing.length > 0) {
        const f = leafAcc.missing[0];
        w(`    inherited: ${chainStr} -> missing '${f.tool}' (${f.file}:${f.line})`);
      } else {
        w(`    inherited: ${chainStr}`);
      }
    }
  }
  if (undetermined.length > 0) {
    w('');
    w("Undetermined targets - honest 'cannot tell', never counted as reachable:");
    for (const name of undetermined) {
      const res = results.get(name);
      const acc = analyses.get(name);
      w(`  ${name}: ${res.note ?? ''}`);
      for (const u of (res.unresolved ?? acc.unresolved).slice(0, 4)) {
        const note = u.note ? ` (${u.note})` : '';
        w(`    ${u.file}:${u.line}: unresolved command word '${u.word}'${note}`);
      }
    }
  }
  w('');
  w('How to prove a Makefile recipe from a worker (workers have no make):');
  w('  1. Take the tab-indented lines under `target:` in the Makefile.');
  w('  2. Strip the leading tab and any @ - + prefix; keep backslash continuations.');
  w('  3. Replace $$ with $ and expand $(VAR) from the := block at the top.');
  w('  4. Run the body with sh:  sh -c "<body>"   (or save it and: sh <file>).');
  w('  This tool prints the extracted body on demand:');
  w(`    node ${relSelf} --recipe <target>`);
  w('  Full technique and worked examples: docs/make-target-reachability.md');
}

main();
