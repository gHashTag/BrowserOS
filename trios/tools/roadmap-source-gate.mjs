#!/usr/bin/env node
/**
 * roadmap-source-gate - prove the roadmap index still matches its document.
 *
 * `trios/.trinity/dashboard/roadmap.json` is an extracted index of the MVP
 * architecture document: ids, titles, gates, and the definition-of-done lists
 * as checkbox text. Until commit 6d1d50656 (2026-09-01) the document lived
 * outside git, so the index could only assert its own numbers and nothing in
 * the repository could check them. The document is now tracked at
 * `trios/docs/architecture/Queen_T27_MVP_Architecture.md`, which makes every
 * number in the index checkable again.
 *
 * This gate re-derives those numbers from the document on disk and from git,
 * compares them with the index element by element, and fails - naming every
 * disagreement with both the declared and the measured value - when the two
 * drift. It also fails while the document is tracked if any dashboard JSON
 * still carries the stale claims that the document is unversioned or beyond a
 * gate's reach, so the same false story cannot return on a second page.
 *
 * Usage:
 *   node trios/tools/roadmap-source-gate.mjs [path-to-roadmap.json]
 *
 * Without an argument the committed index is checked. With an argument (for
 * example a copy of the pre-fix index piped out of `git show`) that copy is
 * checked instead, which keeps the original red result reproducible after the
 * fix has landed.
 *
 * Only node builtins, git and the shell are used; there is no install step.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Where the dashboard data lives, repository-relative. */
const DASHBOARD_DIR = 'trios/.trinity/dashboard'
/** The committed index, checked when no argument is given. */
const DEFAULT_ROADMAP = `${DASHBOARD_DIR}/roadmap.json`
/** Checkbox prefixes: six characters each, stripped before comparison. */
const OPEN_PREFIX = '- [ ] '
const DONE_PREFIX = '- [x] '
/**
 * Claims the dashboard JSONs carried while the document sat outside git.
 * While git tracks the document these are false, so any dashboard *.json
 * still containing one fails the gate.
 */
const STALE_CLAIMS = [
  'unversioned file in ~/Downloads',
  'no gate can read it',
  'outside the repository',
]

/** Run git, capturing the exit status and stdout. Never throws. */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { status: r.status ?? 1, stdout: typeof r.stdout === 'string' ? r.stdout : '' }
}

/** Render a value for a report line, keeping its type visible. */
function show(value) {
  return JSON.stringify(value) ?? String(value)
}

/**
 * Check a roadmap index against the document it claims to index. Every
 * disagreeing field is collected and reported with both values before the
 * result is decided; nothing measured is read out of the index on trust.
 *
 * @param {{roadmapPath?: string, cwd?: string}} [options]
 *   roadmapPath - index to check. Relative paths resolve against `cwd`.
 *                 Defaults to the committed index in the repository.
 *   cwd        - working directory for git; defaults to process.cwd().
 * @returns {{ok: boolean, failures: number, lines: string[]}}
 */
export function roadmapSourceGate({ roadmapPath, cwd = process.cwd() } = {}) {
  const lines = []
  let failures = 0
  const fail = (msg) => {
    failures += 1
    lines.push(`FAIL ${msg}`)
  }

  const root = git(['rev-parse', '--show-toplevel'], cwd)
  if (root.status !== 0) {
    fail(`git rev-parse --show-toplevel failed in ${cwd} - the gate needs a repository`)
    return { ok: false, failures, lines }
  }
  const toplevel = root.stdout.trim()

  const indexRel = roadmapPath ?? DEFAULT_ROADMAP
  const indexPath = isAbsolute(indexRel) ? indexRel : join(cwd, indexRel)
  let index
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'))
  } catch (err) {
    fail(`cannot read roadmap index ${indexRel}: ${err.message}`)
    return { ok: false, failures, lines }
  }

  // --- Locate the document the index summarises -----------------------------
  const declaredFile = index.source?.file
  let docRel = null
  if (
    typeof declaredFile === 'string' &&
    !declaredFile.startsWith('/') &&
    !declaredFile.startsWith('~') &&
    existsSync(join(toplevel, declaredFile))
  ) {
    // The declared repository-relative path resolves directly against the
    // repository root. This is the only resolution the current index needs:
    // no search, no guessing.
    docRel = declaredFile
  } else if (typeof declaredFile === 'string' && basename(declaredFile)) {
    // Legacy index (pre-6d1d50656): source.file was a bare basename from the
    // days when the document was not tracked. A single git index query - not
    // a filesystem walk - locates it, so the pre-fix red result stays
    // reproducible against old copies. Exactly one match is accepted.
    const matches = git(['ls-files', '-z', '--', `*${basename(declaredFile)}`], toplevel)
      .stdout.split('\0')
      .filter(Boolean)
    if (matches.length === 1) docRel = matches[0]
  }

  if (docRel !== null && docRel !== declaredFile) {
    fail(
      `source.file: declared ${show(declaredFile)}, measured ${show(docRel)} - ` +
        `the declared path does not resolve against the repository root; ` +
        `the document was located through the git index`,
    )
  }
  if (docRel === null) {
    fail(
      `source.file: declared ${show(declaredFile)}, measured: unresolvable - ` +
        `no such path under the repository root and no unique git-index match for the basename`,
    )
  }

  // --- Measure the document against git and the filesystem ------------------
  const docAbs = join(toplevel, docRel ?? String(declaredFile ?? ''))
  const tracked =
    docRel !== null && git(['ls-files', '--error-unmatch', '--', docRel], toplevel).status === 0

  if (index.source?.inGit !== tracked) {
    fail(
      `source.inGit: declared ${show(index.source?.inGit)}, measured ${show(tracked)} ` +
        `(git ls-files --error-unmatch ${docRel ?? declaredFile} exits ${tracked ? 0 : 1})`,
    )
  }

  let bytes = null
  let open = null
  let done = null
  try {
    bytes = statSync(docAbs).size
    open = []
    done = []
    for (const line of readFileSync(docAbs, 'utf8').split('\n')) {
      if (line.startsWith(OPEN_PREFIX)) open.push(line.slice(OPEN_PREFIX.length))
      else if (line.startsWith(DONE_PREFIX)) done.push(line.slice(DONE_PREFIX.length))
    }
  } catch (err) {
    fail(`document unreadable at ${docRel ?? declaredFile}: ${err.message}`)
  }

  if (bytes !== null && index.source?.bytes !== bytes) {
    fail(`source.bytes: declared ${index.source?.bytes}, measured ${bytes}`)
  }
  if (open !== null) {
    const total = open.length + done.length
    if (index.dod?.total !== total) {
      fail(`dod.total: declared ${index.dod?.total}, measured ${total}`)
    }
    compareList('dod.open', index.dod?.open, open, fail)
    compareList('dod.done', index.dod?.done, done, fail)
  }

  // --- Stale claims on the dashboard ----------------------------------------
  let scanned = 0
  if (tracked) {
    // These claims are only false while the document is tracked, so the scan
    // runs only then. *.jsonl and *.md files are excluded by extension.
    let names = []
    try {
      names = readdirSync(join(toplevel, DASHBOARD_DIR))
    } catch (err) {
      fail(`cannot read ${DASHBOARD_DIR} to scan for stale claims: ${err.message}`)
    }
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      scanned += 1
      const body = readFileSync(join(toplevel, DASHBOARD_DIR, name), 'utf8')
      for (const claim of STALE_CLAIMS) {
        if (body.includes(claim)) {
          fail(`${DASHBOARD_DIR}/${name} still carries the stale claim ${show(claim)}`)
        }
      }
    }
  }

  if (failures > 0) {
    lines.push(`     ${failures} disagreement${failures === 1 ? '' : 's'} found - exit 1`)
  } else {
    lines.push(`OK   ${indexRel} matches the document it indexes`)
    lines.push(`     document: ${docRel}`)
    lines.push(`     tracked: ${show(tracked)} - git ls-files --error-unmatch exits 0`)
    lines.push(`     source.bytes: ${bytes} declared and measured`)
    lines.push(`     dod.total: ${open.length + done.length} - dod.open ${open.length}, dod.done ${done.length}`)
    if (tracked) {
      lines.push(`     dashboard: ${scanned} JSON file${scanned === 1 ? '' : 's'} scanned, no stale claims`)
    }
  }
  return { ok: failures === 0, failures, lines }
}

/** Compare a declared list with the measured one, element by element. */
function compareList(name, declared, measured, fail) {
  if (!Array.isArray(declared)) {
    fail(`${name}: declared ${show(declared)}, measured a list of ${measured.length} items`)
    return
  }
  if (declared.length !== measured.length) {
    fail(`${name}.length: declared ${declared.length}, measured ${measured.length}`)
  }
  for (let i = 0; i < Math.min(declared.length, measured.length); i += 1) {
    if (declared[i] !== measured[i]) {
      fail(`${name}[${i}]: declared ${show(declared[i])}, measured ${show(measured[i])}`)
    }
  }
}

// --- Command line entry ------------------------------------------------------
const invokedAsScript = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()

if (invokedAsScript) {
  // Optional first argument: a roadmap.json to check instead of the committed one.
  const result = roadmapSourceGate({ roadmapPath: process.argv[2] })
  for (const line of result.lines) console.log(line)
  process.exit(result.ok ? 0 : 1)
}
