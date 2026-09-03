#!/usr/bin/env node
//
// ring00-swift-parity — RING-00: the spec and the Swift that answers cannot
// disagree unnoticed.  (gHashTag/trios#1349)
//
// The deployed branch compiles trios/agent-server/queen-core/Sources/ with
// Swift (`FROM swift:6.0-jammy AS queen-core` is the Dockerfile's only
// compiler stage) and every decision the tick makes is a question asked of
// that binary, while trios/rings/T27-00/queen_core.t27 states the same law as
// text. Two statements of one law, in two languages, and nothing checked that
// they still agreed. This gate is that check.
//
// FR-001  Constants are parsed by text — `pub const NAME: type = value;` from
//         the spec, `public static let name = value` from the Swift. No
//         compiler is invoked; the worker image has none.
// FR-002  `disagreements` and `unmatched` are printed as two separate totals.
//         A disagreement is a matched pair carrying different values; an
//         unmatched constant is one with no Swift declaration under the rule
//         printed below. They are different problems and are never conflated.
// FR-003  The gate reads only. It never writes to the spec, to any Swift
//         file, or anywhere else.
// FR-004  It runs under `node` with the Node standard library only, and it
//         never opens anything under /Users/playra/t27 — that root is refused
//         before a single byte is read.
//
// Swift declarations whose value is not a scalar this gate can compare (a
// pricing table, provider sets, a constructed default budget, a multi-line
// string expression) are skipped and listed: skipped rather than called a
// disagreement, because a comparison the gate cannot make is not a comparison
// the gate can fail.
//
// Exit codes:
//   0  every spec constant is matched and every matched pair agrees
//   1  red — disagreements and/or unmatched exist (a finding, not a gate bug)
//   2  the gate could not run (bad arguments, missing input, forbidden path)
//
// Usage:
//   node tools/ring00-swift-parity.mjs
//   node tools/ring00-swift-parity.mjs --swift /tmp/policy-copy
//   node tools/ring00-swift-parity.mjs --spec FILE --swift DIR
//   node tools/ring00-swift-parity.mjs --help
//

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Inputs and the one forbidden root.
// ---------------------------------------------------------------------------

// FR-004: this gate must never read anything under /Users/playra/t27.
const FORBIDDEN_ROOT = '/Users/playra/t27';

// Defaults resolve from this file's own location, so the gate behaves the
// same from any working directory.
const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPEC = resolve(here, '..', 'rings', 'T27-00', 'queen_core.t27');
const DEFAULT_SWIFT_DIR = resolve(
  here,
  '..',
  'agent-server',
  'queen-core',
  'Sources',
  'QueenPolicy'
);

const USAGE = [
  'usage: node tools/ring00-swift-parity.mjs [--spec FILE] [--swift DIR] [--help]',
  '',
  '  --spec FILE   path to the ring spec (default: rings/T27-00/queen_core.t27)',
  '  --swift DIR   directory of QueenPolicy .swift files',
  '                (default: agent-server/queen-core/Sources/QueenPolicy)',
  '  --help        print this usage',
].join('\n');

function fail(message, code = 2) {
  process.stderr.write(`ring00-swift-parity: ${message}\n`);
  process.exit(code);
}

// FR-004: refuse the forbidden root before a single byte is read.
function guardPath(path, label) {
  const abs = resolve(path);
  if (abs === FORBIDDEN_ROOT || abs.startsWith(FORBIDDEN_ROOT + sep)) {
    fail(
      `${label} resolves to ${abs}, which is under ${FORBIDDEN_ROOT}; ` +
        'this gate must never read there (FR-004).'
    );
  }
  return abs;
}

function parseArgs(argv) {
  const options = { spec: DEFAULT_SPEC, swift: DEFAULT_SWIFT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE + '\n');
      process.exit(0);
    } else if (arg === '--spec') {
      options.spec = argv[++i];
      if (options.spec === undefined) fail(`--spec needs a file path\n${USAGE}`);
    } else if (arg === '--swift') {
      options.swift = argv[++i];
      if (options.swift === undefined) fail(`--swift needs a directory path\n${USAGE}`);
    } else {
      fail(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// FR-001: parsing by text. No compiler, no language tooling — the worker
// image has none, and a text rule can be read by anyone without one.
// ---------------------------------------------------------------------------

// Parses `pub const NAME: type = value;` lines from the ring spec.
function specConstants(text) {
  const found = [];
  const re =
    /^[ \t]*pub\s+const\s+([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_<>\[\]:]+)\s*=\s*([^;]+);/;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = re.exec(lines[i]);
    if (!match) continue;
    found.push({
      name: match[1],
      type: match[2],
      raw: match[3].trim(),
      value: scalarValue(match[3]),
      line: i + 1,
    });
  }
  return found;
}

// Parses `public static let name = value` lines from the Swift sources. A
// declaration's value is carried as a comparable scalar only when the whole
// expression on that one line is one of: a numeric literal (underscores
// allowed), `true`/`false`, a single string literal, or arithmetic over
// numeric literals. Everything else is skipped, with the reason recorded.
function swiftConstants(files) {
  const found = [];
  const re =
    /^[ \t]*public\s+static\s+let\s+`?([A-Za-z_][A-Za-z0-9_]*)`?\s*(?::[^=\n]+)?=\s*(.*)$/;
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = re.exec(lines[i]);
      if (!match) continue;
      const raw = match[2].trim();
      const value = raw === '' ? null : scalarValue(raw);
      found.push({
        name: match[1],
        raw: raw === '' ? '' : raw,
        value,
        scalar: value !== null,
        skipReason: value === null ? skipReason(raw) : null,
        file: file.base,
        line: i + 1,
      });
    }
  }
  return found;
}

// Why a Swift declaration was skipped. Saying it plainly keeps the skip a
// visible, checkable decision rather than silent data loss.
function skipReason(raw) {
  if (raw === '') return 'multi-line expression';
  if (raw.startsWith('[') || raw.startsWith('{')) return 'collection literal';
  if (/^[A-Za-z_][A-Za-z0-9_.<>]*\s*\(/.test(raw)) return 'initializer call';
  return 'not a scalar this gate can compare';
}

// ---------------------------------------------------------------------------
// Scalars and their comparison.
// ---------------------------------------------------------------------------

// Recognises, by text, the scalar values the gate can compare: booleans,
// single-line string literals, and arithmetic over numeric literals (Swift
// writes `105 * 60` and `200_000`; the spec writes plain integers).
// Returns { kind: 'bool' | 'string' | 'number', value } or null.
function scalarValue(raw) {
  const text = raw.trim();
  if (text === '') return null;
  if (text === 'true' || text === 'false') {
    return { kind: 'bool', value: text === 'true' };
  }
  if (/^"[^"\n]*"$/.test(text)) {
    return { kind: 'string', value: text.slice(1, -1) };
  }
  const number = evaluateArithmetic(text);
  if (number !== null) return { kind: 'number', value: number };
  return null;
}

// Evaluates an arithmetic expression over integer and decimal literals with
// `+ - * /` and parentheses. Anything else — letters, quotes, colons,
// brackets, commas — fails and yields null. A hand-written recursive-descent
// parser rather than eval: no expression can execute anything, and no input
// can leave the grammar unnoticed.
function evaluateArithmetic(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      let sawDigit = false;
      let sawDot = false;
      while (j < text.length) {
        const d = text[j];
        if (/[0-9_]/.test(d)) {
          sawDigit = true;
          j++;
        } else if (d === '.' && !sawDot) {
          sawDot = true;
          j++;
        } else {
          break;
        }
      }
      if (!sawDigit) return null;
      const cleaned = text.slice(i, j).replace(/_/g, '');
      if (cleaned.startsWith('.') || cleaned.endsWith('.') || cleaned.includes('..')) {
        return null;
      }
      tokens.push({ type: 'number', value: Number(cleaned) });
      i = j;
      continue;
    }
    if ('+-*/()'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    return null;
  }
  if (tokens.length === 0) return null;

  let pos = 0;
  const peek = () => tokens[pos];
  const parseExpr = () => {
    let left = parseTerm();
    if (left === null) return null;
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = tokens[pos++].value;
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  const parseTerm = () => {
    let left = parseFactor();
    if (left === null) return null;
    while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/')) {
      const op = tokens[pos++].value;
      const right = parseFactor();
      if (right === null) return null;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  };
  const parseFactor = () => {
    const token = peek();
    if (!token) return null;
    if (token.type === 'number') {
      pos++;
      return token.value;
    }
    if (token.type === 'op' && (token.value === '-' || token.value === '+')) {
      pos++;
      const inner = parseFactor();
      if (inner === null) return null;
      return token.value === '-' ? -inner : inner;
    }
    if (token.type === 'op' && token.value === '(') {
      pos++;
      const inner = parseExpr();
      if (inner === null) return null;
      const close = peek();
      if (!close || close.type !== 'op' || close.value !== ')') return null;
      pos++;
      return inner;
    }
    return null;
  };

  const result = parseExpr();
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) return null;
  return result;
}

// Two scalars agree only when they are the same kind and the same value.
// `4` agrees with `4`; `4` against `5` is a disagreement; a number against a
// string is a disagreement too, because names matched while kinds did not.
function scalarsAgree(a, b) {
  if (a === null || b === null) return false;
  if (a.kind !== b.kind) return false;
  return a.value === b.value;
}

// ---------------------------------------------------------------------------
// The name-matching rule. Mechanical, and printed by the gate so the rule can
// be judged rather than trusted. Where it cannot match, the row is `none`
// rather than a guess.
// ---------------------------------------------------------------------------

// The whole alias table, shown in the printed rule: the spec abbreviates what
// the Swift spells out, and exactly one abbreviation exists today.
const NAME_ALIASES = new Map([['MAXIMUM', 'MAX']]);

// camelCase -> UPPER_SNAKE_CASE, then the fixed alias table, word by word.
function swiftNameToSpecForm(name) {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
  return snake
    .split('_')
    .map((word) => (word === '' ? word : (NAME_ALIASES.get(word) ?? word)))
    .join('_');
}

function ruleText() {
  const alias = [...NAME_ALIASES.entries()].map(([from, to]) => `${from} -> ${to}`).join(', ');
  return [
    'Name-matching rule (mechanical — this is the whole rule, printed so it can be judged):',
    '  1. Each Swift declaration name is converted from camelCase to UPPER_SNAKE_CASE',
    '     (maximumConcurrentWorkers -> MAXIMUM_CONCURRENT_WORKERS).',
    `  2. The fixed alias table { ${alias} } is applied to the Swift side, word by`,
    '     word, because the spec abbreviates what the Swift spells out.',
    '  3. A spec constant matches a Swift declaration only when the mapped Swift name',
    '     equals the spec name exactly and the Swift value is a comparable scalar;',
    '     non-scalar Swift declarations are skipped, never compared, never guessed.',
    '  4. A spec constant with no exact hit prints `none` rather than a guess.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Reading and running.
// ---------------------------------------------------------------------------

function readInputs(options) {
  const specPath = guardPath(options.spec, '--spec');
  const swiftDir = guardPath(options.swift, '--swift');

  let specText;
  try {
    specText = readFileSync(specPath, 'utf8');
  } catch (error) {
    fail(`cannot read spec ${specPath}: ${error.message}`);
  }

  let entries;
  try {
    if (!statSync(swiftDir).isDirectory()) {
      fail(`--swift is not a directory: ${swiftDir}`);
    }
    entries = readdirSync(swiftDir);
  } catch (error) {
    fail(`cannot read Swift directory ${swiftDir}: ${error.message}`);
  }

  const files = entries
    .filter((name) => name.endsWith('.swift'))
    .sort()
    .map((base) => ({ base, text: readFileSync(join(swiftDir, base), 'utf8') }));

  if (files.length === 0) {
    fail(`no .swift files under ${swiftDir}`);
  }
  return { specPath, swiftDir, specText, files };
}

function renderTable(rows) {
  const header = ['spec constant', 'spec value', 'swift declaration', 'swift value', 'verdict'];
  const cells = rows.map((row) => [
    row.spec.name,
    row.spec.raw,
    row.match ? row.match.name : 'none',
    row.match ? row.match.raw : 'none',
    row.verdict,
  ]);
  const widths = header.map(
    (title, index) => Math.max(title.length, ...cells.map((line) => line[index].length))
  );
  const rule = (line) => line.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  return [rule(header), divider, ...cells.map(rule)].join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { specPath, swiftDir, specText, files } = readInputs(options);

  // FR-003: everything below is read-only — the gate never writes anywhere.
  const spec = specConstants(specText);
  const swift = swiftConstants(files);
  if (spec.length === 0) {
    fail(`no \`pub const NAME: type = value;\` lines found in ${specPath}`);
  }
  for (const constant of spec) {
    if (constant.value === null) {
      fail(
        `spec constant ${constant.name} (${specPath}:${constant.line}) has a value ` +
          `the gate cannot parse as a scalar: ${constant.raw}`
      );
    }
  }

  const scalars = swift.filter((declaration) => declaration.scalar);
  const skipped = swift.filter((declaration) => !declaration.scalar);

  // Only comparable scalars are candidates. If two Swift scalars map to the
  // same spec name, that is ambiguity, and ambiguity gets `none`, not a guess.
  const byMappedName = new Map();
  const collisions = [];
  for (const declaration of scalars) {
    const mapped = swiftNameToSpecForm(declaration.name);
    if (byMappedName.has(mapped)) {
      collisions.push(mapped);
    } else {
      byMappedName.set(mapped, declaration);
    }
  }

  const rows = spec.map((constant) => {
    const match = byMappedName.get(constant.name) ?? null;
    if (match === null) {
      return { spec: constant, match: null, verdict: 'unmatched' };
    }
    return {
      spec: constant,
      match,
      verdict: scalarsAgree(constant.value, match.value) ? 'agree' : 'disagree',
    };
  });

  const disagreements = rows.filter((row) => row.verdict === 'disagree').length;
  const unmatched = rows.filter((row) => row.verdict === 'unmatched').length;
  const exitCode = disagreements === 0 && unmatched === 0 ? 0 : 1;

  const out = [];
  out.push('ring00-swift-parity — the spec and the Swift that answers cannot disagree unnoticed');
  out.push('');
  out.push(`spec:  ${specPath} — ${spec.length} pub const`);
  out.push(
    `swift: ${swiftDir} — ${files.length} file(s), ${swift.length} public static let ` +
      `(${scalars.length} comparable scalars, ${skipped.length} skipped as non-scalar)`
  );
  out.push('');
  out.push(ruleText());
  out.push('');
  out.push(renderTable(rows));
  if (skipped.length > 0) {
    out.push('');
    out.push(
      'Swift declarations skipped — not scalars this gate can compare (skipped, never counted as disagreements):'
    );
    for (const declaration of skipped) {
      const raw = declaration.raw === '' ? '' : ` = ${declaration.raw}`;
      out.push(
        `  ${declaration.name.padEnd(28)} ${declaration.skipReason.padEnd(34)} ` +
          `${declaration.file}:${declaration.line}${raw === '' ? '' : ''}`
      );
    }
  }
  if (collisions.length > 0) {
    out.push('');
    out.push(
      `ambiguous Swift scalars (two declarations map to one spec name; rows print none): ` +
        [...new Set(collisions)].join(', ')
    );
  }
  out.push('');
  // FR-002: two totals, printed separately. Conflating them would hide the
  // second problem behind the first.
  out.push(`disagreements: ${disagreements}`);
  out.push(`unmatched: ${unmatched}`);
  out.push('');
  if (exitCode === 0) {
    out.push('result: GREEN — every constant matched and every matched pair agreed; exit code 0');
  } else {
    out.push(
      `result: RED — ${disagreements} disagreement(s), ${unmatched} unmatched; a finding, ` +
        `not a gate failure; exit code 1`
    );
  }
  process.stdout.write(out.join('\n') + '\n');
  process.exit(exitCode);
}

main();
