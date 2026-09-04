#!/usr/bin/env node
// -----------------------------------------------------------------------------
// trios/tools/doc-only-boundary-audit.mjs
//
// Which open issues can only produce prose?
//
// A task whose whole boundary is documentation is counted as delegatable by
// the tick, because `delegatable` is derived from `boundary.length > 0` and a
// boundary of one .md file has length 1. Nothing distinguishes "this task
// will change the system" from "this task will describe the system", so an
// issue that should have changed behaviour can be satisfied, accepted and
// closed by a document. Measured on the live backlog (see #1358): 17 of 61
// open issues had a boundary consisting only of markdown, and twelve of
// those seventeen were about the Queen's own autonomy. #1333 - "there is no
// target queue depth" - was accepted with a document as its whole output
// while the defect it names stayed in the code.
//
// A document is sometimes the right deliverable - a survey, an inventory, a
// decision record. This audit does not judge that. It makes the shape of the
// backlog legible: which issues, if worked exactly as written, change no
// behaviour.
//
// How to run (workers have node):
//   node trios/tools/doc-only-boundary-audit.mjs <backlog.json>
//
// where <backlog.json> is a JSON array of objects carrying `number` and
// `body` - the shape GitHub's issue objects have, and the shape
// `openIssues()` in queen-tick.ts already produces.
//
// Constraints honoured (issue gHashTag/trios#1358):
//   FR-004  reads the backlog from the file the caller supplies and never
//          calls the network - the worker container holds no GitHub
//          credential, and a silent failure of that call would report every
//          issue as fine. No fetch exists in this file;
//   FR-005  runs under node with the Node standard library only, and never
//          edits any issue - nothing is written anywhere, output goes to
//          stdout;
//   FR-006  deterministic: two runs over the same input produce identical
//          bytes, so outputs can be diffed and archived.
//
// THE SHARED RULE. `boundaryReachesSource` below is the one definition of
// what counts as documentation, exported so the server can be held to it.
// `queen-tick.ts` carries a pinned twin (not an import - the agent-server
// image is built from `agent-server/` alone and cannot reach this file at
// runtime) and stores the twin's answer as `boundary_reaches_source`;
// `tests/api/boundary-reach.test.ts` imports THIS export and fails unless
// the two agree on every boundary shape. Two copies that drift are the
// defect this repository keeps finding in itself; a copy that cannot drift
// silently is the compromise the deployment allows.
// -----------------------------------------------------------------------------

import fs from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// =============================================================================
// THE RULE - the single place to disagree with (FR-003: it is printed by
// every run, so a reader can disagree without reading this source)
// =============================================================================

// The suffixes that make a boundary path count as documentation. Nothing
// else qualifies: not .markdown, not .mdx, not "anything under docs/" - a
// boundary path is documentation exactly when its file name ends with one
// of these.
export const DOC_FILE_SUFFIXES = ['.md']

/**
 * Whether one boundary path is documentation.
 *
 * The FILE NAME decides, not the directory: `trios/docs/x.md` is
 * documentation, and `docs/diagram.png` is not. Case-insensitive, so
 * `README.MD` is documentation.
 */
export function isDocumentationPath(path) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return DOC_FILE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix))
}

/**
 * Whether a boundary reaches beyond documentation: true when at least one
 * of its paths is NOT documentation. One real path is enough - a mixed
 * boundary is not the audit's subject.
 *
 * An empty boundary returns false, but that is a different condition with a
 * different repair ("no boundary"), and the audit reports it separately
 * rather than folding it into either side.
 */
export function boundaryReachesSource(paths) {
  return paths.some((path) => !isDocumentationPath(path))
}

/**
 * The declared boundary of one issue body.
 *
 * A twin of `boundaryPathsOf` in
 * trios/agent-server/apps/server/src/api/services/queen-tick.ts - the same
 * two headings (`## Boundary`, `## Границы`), the same token cleaning, the
 * same file-shaped test, so the audit and the tick cannot disagree about
 * which paths an issue claims. The twin-ness is pinned by
 * tests/api/boundary-reach.test.ts, which runs both against the same bodies.
 * Kept here rather than imported for the reason the header records: the
 * agent-server image carries no repository-root file to import.
 */
export function boundaryPathsOf(body) {
  const lines = body.split('\n')
  let inside = false
  const paths = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('## ')) {
      if (inside) break
      inside = line.startsWith('## Boundary') || line.startsWith('## Границы')
      continue
    }
    if (!inside || line.length === 0) continue
    for (const token of line.split(/\s+/)) {
      const cleaned = token
        .replace(/^[`"'(]+/, '')
        .replace(/[`"'.,;:!?)]+$/, '')
      if (cleaned.includes('/') || /\.\w{1,10}$/.test(cleaned)) {
        paths.push(cleaned)
        break
      }
    }
  }
  return paths
}

// =============================================================================
// THE RULE, IN WORDS - what every run prints (FR-003)
// =============================================================================

function ruleInWords() {
  return [
    'Rule applied (a reader may disagree with any part of it):',
    `  - a boundary path is documentation when its FILE NAME ends with one of: ${DOC_FILE_SUFFIXES.join(', ')} (case-insensitive; the directory is irrelevant - trios/docs/x.md is documentation, docs/diagram.png is not);`,
    '  - nothing else is documentation: not .markdown, not .mdx, not a docs/ directory holding non-markdown files;',
    '  - an issue is doc-only when its ## Boundary section parsed to at least one path AND every path is documentation - such an issue, worked exactly as written, produces prose and changes no behaviour;',
    '  - one path outside documentation is enough for the issue to reach source; mixed boundaries are NOT reported;',
    '  - an issue whose ## Boundary section is missing or empty is reported separately as "no boundary" - a different condition with a different repair - and never counts as doc-only.',
    'Boundary paths are read from the ## Boundary section by the same parser the queen tick uses (boundaryPathsOf, the pinned twin in this file).',
    'The classification is the exported function boundaryReachesSource in this file; queen-tick.ts stores the same value as boundary_reaches_source, and tests/api/boundary-reach.test.ts fails if the two drift.',
  ].join('\n')
}

// =============================================================================
// THE AUDIT
// =============================================================================

/** Read and validate the caller's backlog. Malformed input exits loudly:
 * a backlog that parses to nothing would report every issue as fine, which
 * is the silent failure FR-004 exists to prevent. */
function readBacklog(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`)
  }
  if (!Array.isArray(parsed)) {
    fail(`${file} must be a JSON array of issue objects, got ${typeof parsed}`)
  }
  parsed.forEach((issue, index) => {
    if (issue === null || typeof issue !== 'object' || Array.isArray(issue)) {
      fail(`${file}[${index}] is not an object`)
    }
    if (typeof issue.number !== 'number' || !Number.isInteger(issue.number)) {
      fail(`${file}[${index}] has no integer "number"`)
    }
    if (issue.body === null || issue.body === undefined) issue.body = ''
    if (typeof issue.body !== 'string') {
      fail(`${file}[${index}] has a "body" that is not a string`)
    }
  })
  return parsed
}

function fail(message) {
  process.stderr.write(`doc-only-boundary-audit: ${message}\n`)
  process.exit(1)
}

function run(file) {
  const issues = readBacklog(file)
  const docOnly = []
  const noBoundary = []
  let hasSource = 0
  for (const issue of issues) {
    const paths = boundaryPathsOf(issue.body)
    if (paths.length === 0) {
      noBoundary.push({ number: issue.number })
    } else if (boundaryReachesSource(paths)) {
      hasSource += 1
    } else {
      docOnly.push({ number: issue.number, paths })
    }
  }
  // Sorted by number, so two runs - or two callers with the same backlog in
  // a different order - produce identical bytes.
  docOnly.sort((a, b) => a.number - b.number)
  noBoundary.sort((a, b) => a.number - b.number)

  const lines = []
  lines.push(`doc-only boundary audit of ${file} (${issues.length} issues)`)
  lines.push('')
  lines.push(ruleInWords())
  lines.push('')
  lines.push(`doc-only: ${docOnly.length} of ${issues.length}`)
  for (const issue of docOnly) {
    lines.push(`  #${issue.number}  ${issue.paths.join(', ')}`)
  }
  lines.push('')
  lines.push(`no boundary: ${noBoundary.length} of ${issues.length}`)
  for (const issue of noBoundary) {
    lines.push(`  #${issue.number}  (no paths parsed from any ## Boundary section)`)
  }
  lines.push('')
  lines.push(`has source: ${hasSource} of ${issues.length}`)
  lines.push('  (not listed: each has at least one path outside documentation, which is enough)')
  lines.push('')
  lines.push(
    `totals: doc-only ${docOnly.length}, no boundary ${noBoundary.length}, has source ${hasSource}, total ${issues.length}`,
  )
  process.stdout.write(lines.join('\n') + '\n')
}

// The CLI runs only when invoked as a script; importing this module (as
// tests/api/boundary-reach.test.ts does) yields the rule and nothing else.
const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedAsScript) {
  const file = process.argv[2]
  if (!file) {
    fail('usage: node trios/tools/doc-only-boundary-audit.mjs <backlog.json>')
  }
  run(file)
}
