#!/usr/bin/env node
/**
 * tree-to-briefs.mjs — turn the technology tree's blocked and planned nodes
 * into brief skeletons an operator can file mechanically.
 *
 * Refs: gHashTag/trios#1339 — the tree is read by /queen/tree, but no code
 * path turns a node into a task, so 13 blocked and 3 planned nodes sit as
 * named, evidenced work the Queen can never choose. A bee cannot file issues
 * (no push credential, by design); it can produce the briefs, in the shape
 * .claude/skills/queen-briefing and docs/issue-spec-template.md require, so
 * filing is a mechanical step rather than an authoring step.
 *
 * Reads:  .trinity/dashboard/tech-tree.json (the evidence-backed tree).
 * Writes: docs/tree-briefs/<node id>.md — exactly one file per node whose
 *         status is `blocked` or `planned`.
 *
 * Each brief carries the four required headings, in order — User Scenarios &
 * Testing, Requirements, Success Criteria, Boundary — quotes the node's
 * `evidence` (and `note`) verbatim after home-directory redaction, and lists
 * under ## Boundary every file path named in the evidence or note. A node
 * whose text names no path gets the single line
 * `UNKNOWN - the operator must name the files`, so an unfileable brief is
 * visibly unfileable rather than silently empty.
 *
 * Constraints (from the issue):
 *   FR-003  home directories are redacted to /Users/.../ and /home/.../ the
 *           same way queen-public-research.ts does it (its 1200-character
 *           cap is deliberately NOT applied — the evidence must travel
 *           verbatim, and only the redaction is required).
 *   FR-004  this script never contacts the network and never files anything.
 *   FR-005  Node standard library only.
 *
 * Usage: node trios/tools/tree-to-briefs.mjs   (paths resolve from this
 * file's location, so the current working directory does not matter).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

const TREE_PATH = path.join(REPO_ROOT, '.trinity', 'dashboard', 'tech-tree.json')
const OUTPUT_DIR = path.join(REPO_ROOT, 'docs', 'tree-briefs')

const TARGET_STATUSES = ['blocked', 'planned']

const FOUR_HEADINGS = [
  '## User Scenarios & Testing',
  '## Requirements',
  '## Success Criteria',
  '## Boundary',
]

const UNKNOWN_BOUNDARY = 'UNKNOWN - the operator must name the files'

// Any /Users/<name>/ or /home/<name>/ that survived redaction. The canonical
// redacted forms are /Users/.../ and /home/.../, which this rejects.
const UNREDACTED_HOME = /\/(?:Users|home)\/(?!\.\.\.\/)[^/\s'"]*\//

/**
 * Redact home-directory prefixes exactly as queen-public-research.ts does
 * (sans its length cap — see FR-002 vs FR-003 in the issue).
 */
function redactHomeDirectories(value) {
  return value
    .replace(/\/Users\/[^/\s]+\//g, '/Users/.../')
    .replace(/\/home\/[^/\s]+\//g, '/home/.../')
}

// A file reference: an optional leading slash (absolute paths), optional
// directory segments, a stem with a known source-file extension (or a bare
// Makefile/Dockerfile), and an optional :line or :line-line suffix that the
// Boundary does not carry. The stem is required, so globs such as *.sh or
// */*.md cannot match, and neither can a bare extension. Directory
// references (paths ending in / or with no file extension) are excluded on
// purpose: the boundary names files, not regions.
const FILE_TOKEN =
  /\/?(?:[\w.@+-]+\/)*(?:[\w.@+-]+\.(?:md|markdown|swift|rs|ts|tsx|js|mjs|cjs|json|toml|yaml|yml|sh|bash|py|t27)|Makefile|Dockerfile)(?::\d+(?:-\d+)?)?/g

/**
 * Collect a file path, de-duplicating. Two spellings where one extends the
 * other by whole leading directories (bash.ts and the full
 * agent-server/.../bash.ts) are the same file and the fuller path is kept —
 * but files that merely share a final segment are NOT merged:
 * rings/RUST-02/clade-e2e/src/main.rs and
 * rings/RUST-99/tmp-zero-gate/src/main.rs are different files.
 */
function addPath(list, filePath) {
  for (let i = 0; i < list.length; i += 1) {
    const known = list[i]
    if (known === filePath || known.endsWith(`/${filePath}`)) return
    if (filePath.endsWith(`/${known}`)) {
      list[i] = filePath
      return
    }
  }
  list.push(filePath)
}

/** Extract every file path named in one (already redacted) text. */
function extractPaths(text) {
  const found = []
  FILE_TOKEN.lastIndex = 0
  let match
  while ((match = FILE_TOKEN.exec(text)) !== null) {
    // Reject a match that starts inside a longer token (a mid-path fragment
    // or a glob): the character before a real reference is punctuation,
    // a quote, or whitespace.
    const before = match.index > 0 ? text[match.index - 1] : ''
    if (/[\w./@+*-]/.test(before)) continue
    addPath(found, match[0].replace(/:\d+(?:-\d+)?$/, ''))
  }
  return found
}

/** Every file path named in the node's evidence or note, first-seen order. */
function boundaryPathsFor(texts) {
  const paths = []
  for (const text of texts) {
    for (const filePath of extractPaths(text)) addPath(paths, filePath)
  }
  return paths
}

function quote(text) {
  return text.split('\n').map((line) => `> ${line}`)
}

function requirement(number, text) {
  return `- **FR-${String(number).padStart(3, '0')}**: ${text}`
}

/**
 * Build one brief skeleton from a technology-tree node.
 *
 * The skeleton is deliberately conservative: it carries the tree's own words
 * (label, status, blocker, evidence, note) and the boundary extracted from
 * them, marks every judgement the operator still owes as
 * [NEEDS CLARIFICATION: ...], and invents no plan.
 */
export function briefForNode(node) {
  const evidence = redactHomeDirectories(String(node.evidence ?? ''))
  const note = node.note ? redactHomeDirectories(String(node.note)) : ''
  const blockedBy = node.blockedBy
    ? redactHomeDirectories(String(node.blockedBy))
    : ''
  const filePaths = boundaryPathsFor([evidence, note])
  const isBlocked = node.status === 'blocked'

  const lines = []

  lines.push(`# ${node.id}`, '')
  lines.push(`- **Label**: ${node.label}`)
  lines.push(`- **Status**: ${node.status}`)
  lines.push(`- **Layer**: ${node.layer}`)
  if (blockedBy) lines.push(`- **Blocked by**: ${blockedBy}`)
  lines.push(
    '- **Generated from**: `.trinity/dashboard/tech-tree.json` by `tools/tree-to-briefs.mjs` — a skeleton the operator finishes and files; the generator itself files nothing.',
  )

  lines.push('', '> Evidence, verbatim from the tree (home directories redacted):', '>')
  lines.push(...quote(evidence || '(none recorded)'))
  if (note) {
    lines.push('', '> Note, verbatim from the tree (home directories redacted):', '>')
    lines.push(...quote(note))
  }

  lines.push('', '## User Scenarios & Testing', '')
  lines.push('### User Story 1 - Filing this node is mechanical, not authoring (P1)', '')
  lines.push(
    `**Why this priority**: the technology tree holds \`${node.id}\` as \`${node.status}\`, and the Queen's candidate list reads open GitHub issues only — no code path turns a tree node into work until this brief is filed.`,
  )
  lines.push(
    '',
    '**Independent Test**: the filed issue body carries the four headings below, in order, and its Boundary names files or the single `UNKNOWN` line.',
  )
  lines.push('', '**Acceptance Scenarios**:')
  lines.push('1. **Given** this brief as generated,')
  lines.push(
    '   **When** the operator pastes it into a new issue and trims the Boundary to the files the task may actually touch,',
  )
  lines.push(
    '   **Then** the issue is delegatable — it carries `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` and `## Boundary`, in that order.',
  )
  lines.push('', `### User Story 2 - ${node.id} itself is settled (P1)`, '')
  lines.push(
    `[NEEDS CLARIFICATION: the operator must write the Given/When/Then that settles \`${node.id}\`; this skeleton carries the evidence, not the plan.]`,
  )

  lines.push('', '## Requirements', '')
  let fr = 0
  if (isBlocked) {
    lines.push(
      requirement(
        ++fr,
        'The blocker recorded above MUST be resolved, or explicitly waived by the operator, before this task is worked.',
      ),
    )
  }
  lines.push(
    requirement(
      ++fr,
      'The operator MUST trim the Boundary below to exactly the files this task may touch, and MUST replace an `UNKNOWN` Boundary with named files before the issue is filed.',
    ),
  )
  lines.push(
    requirement(
      ++fr,
      'The evidence quoted above MUST travel with the issue unedited, in its redacted form.',
    ),
  )
  lines.push(requirement(++fr, 'The filed issue MUST be in English.'))

  lines.push('', '## Success Criteria', '')
  lines.push(
    '- The four required headings appear in the filed issue in this order: User Scenarios & Testing, Requirements, Success Criteria, Boundary.',
  )
  lines.push(
    `- The Boundary names files, one per line, or carries the single line \`${UNKNOWN_BOUNDARY}\`.`,
  )
  lines.push(
    `- [NEEDS CLARIFICATION: the operator must add the criterion that settles \`${node.id}\` — a command and its exit code, a count, or a log line to grep for.]`,
  )

  lines.push('', '## Boundary', '')
  if (filePaths.length === 0) {
    // An unfileable brief must be visibly unfileable, not silently empty.
    lines.push(UNKNOWN_BOUNDARY)
  } else {
    for (const filePath of filePaths) lines.push(`\`${filePath}\``)
  }

  return `${lines.join('\n')}\n`
}

/** True when the body carries the four required headings, in order. */
function hasFourHeadingsInOrder(body) {
  let from = 0
  for (const heading of FOUR_HEADINGS) {
    const at = body.indexOf(`\n${heading}\n`, from)
    if (at === -1) return false
    from = at + 1
  }
  return true
}

function main() {
  const tree = JSON.parse(readFileSync(TREE_PATH, 'utf8'))
  const nodes = Array.isArray(tree.nodes) ? tree.nodes : []
  const targets = nodes.filter((node) => TARGET_STATUSES.includes(node.status))
  const blocked = targets.filter((node) => node.status === 'blocked').length
  const planned = targets.length - blocked

  const ids = new Set()
  for (const node of targets) {
    if (ids.has(node.id)) {
      console.error(`tree-to-briefs: duplicate node id ${node.id} — refusing to overwrite`)
      process.exitCode = 1
      return
    }
    ids.add(node.id)
  }

  mkdirSync(OUTPUT_DIR, { recursive: true })
  for (const node of targets) {
    writeFileSync(path.join(OUTPUT_DIR, `${node.id}.md`), briefForNode(node), 'utf8')
  }

  // Prove what was written by reading it back — the proof is a count,
  // printed here, not a promise in a comment.
  const written = readdirSync(OUTPUT_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort()
  let headingsOk = 0
  let redactionLeaks = 0
  let unknownBoundary = 0
  for (const file of written) {
    const body = readFileSync(path.join(OUTPUT_DIR, file), 'utf8')
    if (hasFourHeadingsInOrder(body)) headingsOk += 1
    if (UNREDACTED_HOME.test(body)) redactionLeaks += 1
    if (new RegExp(`^${UNKNOWN_BOUNDARY}$`, 'm').test(body)) unknownBoundary += 1
  }

  const count = written.length
  console.log(
    `tree-to-briefs: ${nodes.length} nodes in .trinity/dashboard/tech-tree.json — ${blocked} blocked, ${planned} planned`,
  )
  console.log(
    `tree-to-briefs: wrote ${count} briefs into docs/tree-briefs/ (one per blocked or planned node):`,
  )
  for (const file of written) console.log(`  ${file}`)
  console.log(
    `tree-to-briefs: heading check — ${headingsOk} of ${count} briefs contain the four required headings in order`,
  )
  console.log(
    `tree-to-briefs: redaction check — ${redactionLeaks} of ${count} briefs contain an unredacted home directory (including '/Users/playra')`,
  )
  console.log(
    `tree-to-briefs: boundary check — ${count - unknownBoundary} briefs name file paths, ${unknownBoundary} carry '${UNKNOWN_BOUNDARY}'`,
  )

  if (
    count !== targets.length ||
    headingsOk !== count ||
    redactionLeaks !== 0
  ) {
    console.error(
      `tree-to-briefs: FAILED — wrote ${count} (expected ${targets.length}), ` +
        `${headingsOk}/${count} carry the four headings in order, ` +
        `${redactionLeaks} leak an unredacted home directory`,
    )
    process.exitCode = 1
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) main()
