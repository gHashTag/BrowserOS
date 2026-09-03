#!/usr/bin/env node
//
// Skill frontmatter gate for trios (issue 1398).
//
// The deployed skill loader (trios/agent-server/apps/server/src/skills/loader.ts)
// runs every SKILL.md through gray-matter, which parses the frontmatter block
// as real YAML, and then checks isValidFrontmatter: a non-empty string `name`
// and a non-empty string `description`. A file that fails either step returns
// null and the skill is silently dropped. The tree shipped a large share of
// skill files that violate that contract, and nothing read those files, so the
// breakage was invisible: the Swift-side SkillCatalog hand-parses and falls
// back to the directory name and the first heading, which painted every skill
// as healthy.
//
// This gate is a structural reader over the raw lines. It is deliberately NOT
// built on a YAML parser:
//   - Node has no YAML parser built in, so a parser would drag node_modules
//     into a check that must run on a bare checkout.
//   - Bun ships Bun.YAML, but it disagrees with gray-matter on the exact shape
//     at the center of this issue: for a duplicated `description` key,
//     gray-matter throws while Bun.YAML silently keeps the last value. A gate
//     built on Bun.YAML would pass a file the shipped loader drops.
// So the rules below encode what the loader's parser does to the four defect
// shapes actually measured in the tree, line by line:
//
//   missing-frontmatter       the file does not open with a `---` block
//   unclosed-frontmatter      the opening `---` has no closing `---`
//   missing-required-key      `name` or `description` absent, or value empty
//   duplicate-key             the same column-0 key appears twice in the block
//   indent-under-valued-key   an indented line whose nearest preceding
//                             column-0 key already has a value, so a YAML
//                             reader folds the line into that value (this is
//                             what killed clade-guard and its siblings)
//   not-single-flow-sequence  a value that opens with `[` but is not exactly
//                             one complete flow sequence, so the parser reads
//                             a sequence and then trips on the trailing
//                             content (this is what killed the argument-hint
//                             lines)
//
// Indentation itself is not a defect: `parameters:` with an empty value opens
// a block, and everything indented under it is legal. phi-loop is the live
// regression case for that distinction and may not be edited to suit this
// gate, so the rule must be precise: an indented line is legal only when the
// nearest preceding column-0 key had an empty value.
//
// Exit status: 0 when every audited skill is clean (or deferred, see below),
// 1 when at least one non-deferred skill has findings, 2 on a usage error.
//
// Usage:
//   node tools/skill-frontmatter-gate.mjs [dir] [--self-test]
//
// `dir` defaults to trios/.claude/skills resolved from the repository root,
// which is located relative to THIS FILE, not to the caller's cwd. The
// --self-test mode copies the skills tree into a directory under $TMPDIR and
// mutates only the copy; it never writes to, truncates, or checks out any
// tracked file. This repository has already had a self-test truncate a
// shipped file to zero bytes, so that property is the point.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Skills owned by issue 1356 ("Five skills instruct an agent to run a builder
// that defaults to replacing the running app"). That issue lists these four
// directories in its own boundary and will edit them. This gate still audits
// them and reports their findings in a section of their own, but they never
// affect the exit code here, so two workers never collide over the same files
// and neither branch stays red waiting on the other.
const DEFERRED_ISSUE_1356 = new Set([
  'doctor',
  'clade-seal',
  't27-phi-loop',
  't27-tri-pipeline',
])

const DEFERRED_ISSUE = 1356

// A column-0 frontmatter key: word characters and dashes, then a colon.
const TOP_KEY_RE = /^([A-Za-z0-9][A-Za-z0-9_-]*):[ \t]*(.*)$/

// Exactly one complete flow sequence: opens with `[`, closes with `]`, no
// nested brackets, nothing outside the group. This is the whole value.
const SINGLE_FLOW_SEQ_RE = /^\[[^\[\]]*\]$/

function makeFinding(dirName, line, rule, message) {
  return {
    dir: dirName,
    file: dirName + '/SKILL.md',
    line,
    rule,
    message,
  }
}

// Audit one SKILL.md. Returns an array of findings; an empty array means the
// file satisfies every rule this gate knows.
function auditOne(dirName, filePath) {
  const findings = []
  let text
  try {
    text = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return [
      makeFinding(
        dirName,
        0,
        'missing-skill-md',
        'no SKILL.md in this directory; the loader only reads SKILL.md',
      ),
    ]
  }

  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))

  if (lines.length === 0 || lines[0] !== '---') {
    findings.push(
      makeFinding(
        dirName,
        1,
        'missing-frontmatter',
        'first line is not ---, so the file has no frontmatter block; ' +
          'the loader sees no keys at all',
      ),
    )
    return findings
  }

  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) {
    findings.push(
      makeFinding(
        dirName,
        lines.length,
        'unclosed-frontmatter',
        'opening --- has no closing ---',
      ),
    )
    return findings
  }

  // Walk the block. Track every column-0 key (for duplicates) and remember
  // whether the nearest preceding column-0 key opened a block (empty value),
  // because that is the only case where an indented line is legal.
  const seenKeys = new Map()
  let lastKey = null
  let lastKeyHasValue = false

  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i]
    const lineNo = i + 1
    if (line.trim() === '') continue

    const indented = line[0] === ' ' || line[0] === '\t'
    const m = !indented ? TOP_KEY_RE.exec(line) : null

    if (m) {
      const key = m[1]
      const value = m[2].trim()
      if (seenKeys.has(key)) {
        findings.push(
          makeFinding(
            dirName,
            lineNo,
            'duplicate-key',
            'key ' + key + ' appears again at line ' + lineNo +
              '; first defined at line ' + seenKeys.get(key) +
              '; a YAML reader throws on a duplicated mapping key',
          ),
        )
      } else {
        seenKeys.set(key, lineNo)
      }
      lastKey = key
      lastKeyHasValue = value.length > 0

      if ((key === 'name' || key === 'description') && value === '') {
        findings.push(
          makeFinding(
            dirName,
            lineNo,
            'missing-required-key',
            'required key ' + key + ' is present but its value is empty',
          ),
        )
      }

      if (value.startsWith('[') && !SINGLE_FLOW_SEQ_RE.test(value)) {
        const groups = (value.match(/\[/g) || []).length
        findings.push(
          makeFinding(
            dirName,
            lineNo,
            'not-single-flow-sequence',
            'key ' + key + ' value must be a single flow sequence like [a|b]; ' +
              'found ' + groups + ' bracket groups, and a YAML reader trips on ' +
              'the trailing content; quote the value to keep the text verbatim',
          ),
        )
      }
    } else if (indented) {
      if (lastKey === null) {
        findings.push(
          makeFinding(
            dirName,
            lineNo,
            'indent-without-key',
            'indented content before any column-0 key',
          ),
        )
      } else if (lastKeyHasValue) {
        findings.push(
          makeFinding(
            dirName,
            lineNo,
            'indent-under-valued-key',
            'indented line sits under top-level key ' + lastKey +
              ', which already has a value; a YAML reader folds this line into ' +
              'that value instead of reading it as a key (legal only under a ' +
              'key with an empty value, such as parameters:)',
          ),
        )
      }
      // Otherwise: indented content under an empty-valued column-0 key, which
      // is exactly the shape phi-loop uses for its parameters block. Legal.
    } else if (line === '-' || line.startsWith('- ')) {
      if (lastKey === null || lastKeyHasValue) {
        findings.push(
          makeFinding(
            dirName,
            lineNo,
            'stray-sequence',
            'block sequence item outside a block opened by an empty-valued key',
          ),
        )
      }
      // A column-0 `- item` directly under an empty-valued key is valid YAML
      // (the sequence may sit at the parent's indentation), so it is legal.
    } else {
      findings.push(
        makeFinding(
          dirName,
          lineNo,
          'stray-line',
          'line is neither a column-0 key, indented content, nor a sequence item',
        ),
      )
    }
  }

  // The loader's own contract: name and description must exist as non-empty
  // strings. Emptiness was already checked inline; absent keys land here.
  for (const required of ['name', 'description']) {
    if (!seenKeys.has(required)) {
      findings.push(
        makeFinding(
          dirName,
          1,
          'missing-required-key',
          'required key ' + required + ' is missing from the frontmatter block',
        ),
      )
    }
  }

  return findings
}

// Audit every skill directory under `dir`. Counts come from the filesystem:
// nothing about the population of the tree is hard-coded here, so a directory
// added or removed tomorrow changes the report without an edit to this file.
export function auditSkillFrontmatter(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    throw new Error('cannot read skills directory ' + dir + ': ' + err.message)
  }

  const names = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  const result = {
    dir,
    scanned: 0,
    clean: [],
    offending: [],
    deferred: [],
    findings: [],
  }

  for (const name of names) {
    if (DEFERRED_ISSUE_1356.has(name)) {
      const findings = auditOne(name, path.join(dir, name, 'SKILL.md'))
      result.scanned++
      result.findings.push(...findings)
      result.deferred.push({ name, findings })
      continue
    }
    const findings = auditOne(name, path.join(dir, name, 'SKILL.md'))
    result.scanned++
    if (findings.length === 0) {
      result.clean.push(name)
      continue
    }
    result.findings.push(...findings)
    result.offending.push({ name, findings })
  }

  return result
}

// A canonical, path-free digest of a report, so the self-test can prove a
// copied tree audits identically to the original.
function digest(result) {
  return JSON.stringify({
    scanned: result.scanned,
    clean: result.clean,
    offending: result.offending.map((o) => [o.name, o.findings.map((f) => f.rule)]),
    deferred: result.deferred.map((d) => [d.name, d.findings.map((f) => f.rule)]),
  })
}

function printReport(result) {
  console.log('skill-frontmatter gate: ' + result.dir)

  console.log('offending (' + result.offending.length + '):')
  for (const entry of result.offending) {
    for (const f of entry.findings) {
      console.log(
        '  ' + f.file + ':' + f.line + ' ' + f.rule + ': ' + f.message,
      )
    }
  }

  const deferredNames = [...DEFERRED_ISSUE_1356].sort().join(', ')
  console.log(
    'deferred to issue ' + DEFERRED_ISSUE + ' (' + deferredNames + '): ' +
      'owned by that issue, audited here, never counted here',
  )
  for (const entry of result.deferred) {
    if (entry.findings.length === 0) {
      console.log('  ' + entry.name + '/SKILL.md: clean')
      continue
    }
    for (const f of entry.findings) {
      console.log(
        '  ' + f.file + ':' + f.line + ' ' + f.rule + ': ' + f.message,
      )
    }
  }

  console.log('clean (' + result.clean.length + '):')
  for (const name of result.clean) {
    console.log('  ' + name)
  }

  console.log(
    'summary: ' + result.clean.length + ' clean, ' +
      result.offending.length + ' offending, ' +
      result.deferred.length + ' deferred out of ' +
      result.scanned + ' scanned',
  )
}

// Locate the repository root by walking up from THIS FILE's directory until a
// directory containing .git is found. The gate lives at <root>/trios/tools/,
// so the default skills directory is <root>/trios/.claude/skills no matter
// what directory the caller stood in.
function thisFilePath() {
  let p = import.meta.url
  if (p.startsWith('file://')) {
    p = decodeURIComponent(p.slice('file://'.length))
  }
  return path.resolve(p)
}

function scriptDir() {
  return path.dirname(thisFilePath())
}

// Run the CLI only when this file is the executed entry point, never when
// another module imports auditSkillFrontmatter. An import that audited the
// tree and called process.exit as a side effect would make the export
// unusable to any caller.
function invokedAsMain() {
  if (process.argv.length < 2) return false
  return path.resolve(process.argv[1]) === thisFilePath()
}

function repoRootFrom(startDir) {
  let dir = path.resolve(startDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function defaultSkillsDir() {
  const root = repoRootFrom(scriptDir())
  if (root === null) {
    throw new Error('could not locate the repository root above ' + scriptDir())
  }
  return path.join(root, 'trios', '.claude', 'skills')
}

// Self-test. Copies the real skills tree into a fresh directory under $TMPDIR
// and mutates ONLY the copy: this repository has already had a self-test
// truncate a shipped file, and that failure mode is what this design exists
// to make impossible. Each case mutates one dynamically chosen clean skill
// (never a hard-coded name) and asserts the audit finds the expected rule on
// that skill and that skill only.
function runSelfTest(skillsDir) {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'skill-frontmatter-gate-'),
  )
  const copyDir = path.join(tmpRoot, 'skills')
  fs.cpSync(skillsDir, copyDir, { recursive: true })

  let ok = true
  const check = (label, passed) => {
    console.log(
      'self-test: ' + label + ': ' + (passed ? 'PASS' : 'FAIL'),
    )
    if (!passed) ok = false
  }

  try {
    const original = auditSkillFrontmatter(skillsDir)
    const baseline = auditSkillFrontmatter(copyDir)
    console.log(
      'self-test: copied ' + baseline.scanned + ' skills to ' + copyDir +
        ' under $TMPDIR; the tracked tree is never written',
    )
    check('copy audits identically to the source', digest(original) === digest(baseline))

    const subject = baseline.clean[0]
    if (!subject) {
      check('a clean skill exists to mutate', false)
      return ok
    }
    console.log('self-test: mutating ' + subject + '/SKILL.md in the copy only')

    const targetFile = path.join(copyDir, subject, 'SKILL.md')
    const pristine = fs.readFileSync(targetFile, 'utf-8')

    const cases = [
      {
        label: 'remove the name line -> missing-required-key',
        rule: 'missing-required-key',
        mutate: (t) =>
          t
            .split('\n')
            .filter((l) => !/^name:/.test(l))
            .join('\n'),
      },
      {
        label: 'multi-group argument-hint -> not-single-flow-sequence',
        rule: 'not-single-flow-sequence',
        mutate: (t) =>
          /^argument-hint:/m.test(t)
            ? t.replace(/^argument-hint:.*$/m, 'argument-hint: [a] [b]')
            : t.replace(/^---$/m, '---\nargument-hint: [a] [b]'),
      },
      {
        label: 'indent description under a valued name -> indent-under-valued-key',
        rule: 'indent-under-valued-key',
        mutate: (t) => t.replace(/^description:/m, ' description:'),
      },
      {
        label: 'duplicate the description line -> duplicate-key',
        rule: 'duplicate-key',
        mutate: (t) =>
          t.replace(/^description:.*$/m, (l) => l + '\n' + l),
      },
      {
        label: 'drop the opening --- -> missing-frontmatter',
        rule: 'missing-frontmatter',
        mutate: (t) => t.split('\n').slice(1).join('\n'),
      },
    ]

    for (const c of cases) {
      const mutated = c.mutate(pristine)
      // A mutation that silently changes nothing would make the case below
      // pass for the wrong reason (no new findings), so prove the write
      // differs from the pristine bytes first.
      check(c.label + ' [mutation changed the file]', mutated !== pristine)
      fs.writeFileSync(targetFile, mutated, 'utf-8')
      const after = auditSkillFrontmatter(copyDir)
      const hits = after.findings.filter(
        (f) => f.dir === subject && f.rule === c.rule,
      )
      check(c.label, hits.length > 0)
    }

    fs.writeFileSync(targetFile, pristine, 'utf-8')
    const restored = auditSkillFrontmatter(copyDir)
    check('restoring the copy returns to the baseline', digest(restored) === digest(baseline))
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }

  return ok
}

function main() {
  const args = process.argv.slice(2)
  if (args.length > 1) {
    console.error('usage: node skill-frontmatter-gate.mjs [dir] [--self-test]')
    process.exit(2)
  }

  const flag = args.find((a) => a === '--self-test' || a === 'self-test')
  const dirArg = args.find((a) => a !== '--self-test' && a !== 'self-test')

  let skillsDir
  try {
    skillsDir = dirArg !== undefined ? path.resolve(dirArg) : defaultSkillsDir()
  } catch (err) {
    console.error(String(err.message))
    process.exit(2)
  }

  if (flag) {
    process.exit(runSelfTest(skillsDir) ? 0 : 1)
  }

  let result
  try {
    result = auditSkillFrontmatter(skillsDir)
  } catch (err) {
    console.error(String(err.message))
    process.exit(2)
  }

  printReport(result)
  process.exit(result.offending.length > 0 ? 1 : 0)
}

if (invokedAsMain()) {
  main()
}
