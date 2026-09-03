// spec-issue-ref-gate.mjs - forbid fake issue references in trios specs.
//
// Why this gate exists: `T27-EPIC-001` and friends are internal labels, not
// GitHub issue numbers. A label written as `#T27-EPIC-001` looks like an
// issue reference, and a closing keyword (Closes, Fixes, Resolves) placed in
// front of it makes a commit claim traceability GitHub can never grant,
// because GitHub resolves closing keywords only against numeric references.
// Six commits on feat/queen-supervisor carry such a dead string. This gate
// reads the spec library at run time and fails on every line that repeats
// the pattern, so the next placeholder is caught by one command instead of
// a repo-wide sweep.
//
// Contract (issue gHashTag/trios#1397):
// - FR-001: plain `node`, no dependencies, no network, no subprocesses.
// - FR-002: discovers every `*.md` in `trios/.trinity/specs` at run time and
//   prints how many files it read. No hard-coded file list.
// - FR-003: flags an `issue:` field (case-insensitive, line-leading) that
//   cites `#<token>` where <token> is not all digits.
// - FR-004: flags a closing keyword followed - across only `:`, `*`,
//   backticks and whitespace - by `#<token>` or `owner/repo#<token>` whose
//   <token> is not all digits.
// - FR-005: stays silent on prose ("resolves to black", "closes the chat",
//   "prefixes", "suffixes") and on numeric references, which are legal.
// - FR-006: prints `<file>:<line>` per violation, exits 1 on any, else 0.
// - FR-007: `--self-test` runs this same checker over in-script fixtures
//   and exits non-zero unless the counts are 1, 0 and 0.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_SPECS_DIR = path.resolve(
  path.dirname(SCRIPT_PATH),
  '..',
  '.trinity',
  'specs'
);

// A reference token: `123` is an issue number; anything else (T27-EPIC-001,
// TODO, ABC-2) is a label pretending to be one.
const TOKEN = '[A-Za-z0-9_-]+';
// Optional `owner/repo` prefix of a full reference.
const OWNER_REPO = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';
// An `issue:` field at the start of a line (YAML frontmatter or a heading).
const ISSUE_FIELD_RE = /^\s*issue\s*:/i;
// Any `#<token>` or `owner/repo#<token>` anywhere in a line.
const REF_SCAN_RE = new RegExp('(?:' + OWNER_REPO + ')?#(' + TOKEN + ')', 'g');
// A closing keyword at a word boundary: `prefixes` and `suffixes` contain
// `fixes` but have no boundary before it, so they never match.
const KEYWORD_RE = /\b(?:closes|fixes|resolves)\b/gi;
// What may sit between the keyword and its reference: only `:`, `*`,
// backticks and whitespace. Anything else ("closes the chat", "resolves to
// black") means the keyword is prose and the line is not a reference.
const AFTER_KEYWORD_RE = new RegExp(
  '^[:*`\\s]*((?:' + OWNER_REPO + ')?#(' + TOKEN + '))'
);

const isNumeric = (token) => /^\d+$/.test(token);

// Check one document (array of lines) and return its violations as
// { line, message } objects. This is the single checker used by the real
// run and by the self-test.
export function specIssueRefGate(lines) {
  const violations = [];
  lines.forEach((text, index) => {
    const lineNo = index + 1;

    // Rule 1: an issue field must not cite a non-numeric `#<token>`.
    if (ISSUE_FIELD_RE.test(text)) {
      for (const match of text.matchAll(REF_SCAN_RE)) {
        const token = match[1];
        if (!isNumeric(token)) {
          violations.push({
            line: lineNo,
            message: 'issue field cites ' + match[0],
          });
        }
      }
    }

    // Rule 2: a closing keyword must not point at a non-numeric reference.
    for (const match of text.matchAll(KEYWORD_RE)) {
      const rest = text.slice(match.index + match[0].length);
      const ref = AFTER_KEYWORD_RE.exec(rest);
      if (ref && !isNumeric(ref[2])) {
        violations.push({
          line: lineNo,
          message: match[0] + ' cites ' + ref[1],
        });
      }
    }
  });
  return violations;
}

function listSpecFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

function runGate(specsDir) {
  const dir = path.resolve(specsDir);
  let files;
  try {
    files = listSpecFiles(dir);
  } catch (error) {
    console.error('error: cannot read specs directory ' + dir + ': ' + error.message);
    return 2;
  }
  console.log('read ' + files.length + ' spec files');
  let count = 0;
  for (const name of files) {
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n');
    for (const violation of specIssueRefGate(lines)) {
      console.log(name + ':' + violation.line + ': ' + violation.message);
      count += 1;
    }
  }
  console.log('violations: ' + count);
  return count === 0 ? 0 : 1;
}

// FR-007 fixtures, held inside the script; nothing is written to disk.
const SELF_TEST_FIXTURES = [
  {
    name: 'closing keyword before a label',
    lines: ['5. Land with `Closes #T27-EPIC-001`.'],
    expected: 1,
  },
  {
    name: 'closing keyword before a number',
    lines: ['5. Land with `Closes #1336`.', '**Closes:** gHashTag/trios#1086'],
    expected: 0,
  },
  {
    name: 'keywords used as prose',
    lines: [
      'The loading layout resolves to black.',
      'The composer closes the chat when the tab is torn.',
      'It prefixes and suffixes each token.',
      'issue: "T27-EPIC-001"',
    ],
    expected: 0,
  },
];

function runSelfTest() {
  let ok = true;
  for (const fixture of SELF_TEST_FIXTURES) {
    const got = specIssueRefGate(fixture.lines).length;
    const pass = got === fixture.expected;
    if (!pass) {
      ok = false;
    }
    console.log(
      'self-test "' + fixture.name + '": ' +
      got + ' violation(s), expected ' + fixture.expected +
      ' - ' + (pass ? 'ok' : 'FAIL')
    );
  }
  console.log('self-test ' + (ok ? 'passed' : 'FAILED'));
  return ok ? 0 : 1;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return fs.realpathSync(entry) === fs.realpathSync(SCRIPT_PATH);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    process.exit(runSelfTest());
  }
  // Optional positional argument overrides the specs directory (defaults to
  // the `trios/.trinity/specs` next to this script, whatever the CWD is).
  const override = args.find((arg) => !arg.startsWith('--'));
  process.exit(runGate(override === undefined ? DEFAULT_SPECS_DIR : override));
}
