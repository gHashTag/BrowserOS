#!/usr/bin/env node
/**
 * worktree-reaper - propose (and, only with an explicit flag, remove) bee
 * worktrees whose issue has closed and whose tree is clean.
 *
 * Why this exists. queen-dispatch.ts cuts `${root}/.worktrees/queen-<N>` for
 * every bee, and nothing in the tree ever removes one - a grep for
 * `worktree remove` / `worktree prune` in the server source finds no caller.
 * Measured on the production volume: /workspace/BrowserOS/.worktrees held 41
 * directories, 45 GB, 2.98 million inodes, 99% of a 46 GB volume. The
 * entrypoint's unconditional `chown -R bee /workspace` then outran the
 * 300-second healthcheck, Railway reported the deploy a SUCCESS while PID 1
 * was still walking the tree, and the edge answered 502 on every route for
 * ten minutes. Twenty-one closed, clean trees were removed by hand: 45 GB
 * became 12 GB, inodes 99% became 21%. The next morning there were 45
 * directories again. The hand cleanup bought one day.
 *
 * The rule that hand cleanup used, and the only rule this tool applies:
 * remove a worktree when BOTH hold -
 *   1. its issue is closed, and
 *   2. `git status --porcelain` in that tree is empty.
 * One of the 41 was closed but dirty - queen-1318, one uncommitted file - and
 * it was kept. The container holds no push credential by design, so a dirty
 * tree may hold the ONLY copy of work that was never pushed. A reaper that
 * ignores the dirty check deletes that work forever.
 *
 * Safety contract (each clause is a failure someone already lived through):
 *   - Default mode reports and removes nothing. Removal requires --remove.
 *   - --remove without issue-state input refuses to remove anything at all:
 *     issue state comes from the caller (--issues FILE or --closed LIST),
 *     never from the network. This image holds no GitHub credential, and a
 *     reaper whose state lookup silently failed would classify every tree
 *     closed. An issue the input does not mention reads as unknown, and
 *     unknown is NEVER closed.
 *   - The dirty check runs before the closed check for every directory, and
 *     a directory that cannot be inspected is classified KEEP, never removed.
 *   - Removal is one `git worktree remove` per directory - never rm -rf - so
 *     git's own bookkeeping is not left dangling, then `git worktree prune`.
 *   - Node standard library only; no dependencies, no network.
 *
 * Usage:
 *   node trios/tools/worktree-reaper.mjs [options]
 *
 * Options:
 *   --root DIR     worktrees root. Default: the same root queen-dispatch.ts
 *                  cuts under, ${WORKSPACE_DIR:-/workspace}/BrowserOS/.worktrees
 *   --issues FILE  issue states supplied by the caller, as JSON - either an
 *                  object {"1347":"closed","1350":"open"} or a GitHub-shaped
 *                  array [{"number":1347,"state":"closed"},...].
 *                  Anything the file does not say is treated as NOT closed.
 *   --closed LIST  comma-separated issue numbers the caller knows are closed
 *                  (an alternative to --issues), e.g. --closed 1340,1341
 *   --remove       actually remove the trees classified `REMOVE - closed and
 *                  clean`. Without it the run is report-only.
 *   --selftest     build a throwaway fixture with three worktrees
 *                  (closed-clean, closed-dirty, open), assert the three
 *                  classifications and the removal rules, tear it down,
 *                  exit 0.
 *   -h, --help     show this text
 *
 * Output: one line per worktree - name, size, classification, note - with
 * one of exactly three classifications:
 *   REMOVE - closed and clean   issue closed AND tree clean (a proposal)
 *   KEEP - uncommitted work     tree dirty, or not provably clean
 *   KEEP - issue open           issue open, or its state unknown
 *
 * Exit codes: 0 report/remove/selftest succeeded; 2 refused or bad usage;
 * 1 selftest assertion failed.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROG = 'worktree-reaper'

// The three classifications. These exact strings are load-bearing: the
// self-test asserts them and an operator scanning a crowded volume reads them.
const CLASS_REMOVE = 'REMOVE - closed and clean'
const CLASS_DIRTY = 'KEEP - uncommitted work'
const CLASS_OPEN = 'KEEP - issue open'

function out(s) {
  process.stdout.write(s + '\n')
}

function errOut(s) {
  process.stderr.write(`${PROG}: ${s}\n`)
}

/** Print to stderr and exit 2: a refusal or bad usage, never a silent default. */
function fail(s) {
  errOut(s)
  process.exit(2)
}

/** Run git; never throws. Returns {ok, out, err}. */
function git(args, opts = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 120_000,
      env: opts.env,
    })
    return { ok: true, out: stdout, err: '' }
  } catch (e) {
    return {
      ok: false,
      out: typeof e.stdout === 'string' ? e.stdout : '',
      err: (typeof e.stderr === 'string' ? e.stderr : String(e.message ?? e)).trim(),
    }
  }
}

/**
 * `git status --porcelain` output for a directory, or null when the tree
 * cannot be inspected (not a worktree, git error, permission, ...).
 */
function porcelainStatus(dir) {
  const r = git(['status', '--porcelain'], { cwd: dir })
  return r.ok ? r.out : null
}

/** queen-1318 -> 1318. Any other shape -> null (no issue number to look up). */
function issueNumberOf(name) {
  const m = /^queen-(\d+)$/.exec(name)
  return m ? Number(m[1]) : null
}

/**
 * Read the caller-supplied issue-state file. JSON, either an object keyed by
 * issue number or a GitHub-shaped array. Values other than "open"/"closed"
 * are ignored - unknown is never closed.
 */
function parseIssueStatesFile(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    fail(`cannot read --issues file ${file}: ${e.message}`)
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch (e) {
    fail(`--issues file ${file} is not valid JSON: ${e.message}`)
  }
  const states = new Map()
  const put = (num, state) => {
    const s = String(state).toLowerCase()
    if (s === 'open' || s === 'closed') states.set(num, s)
  }
  if (Array.isArray(json)) {
    for (const entry of json) {
      if (entry && typeof entry === 'object' && Number.isFinite(Number(entry.number))) {
        put(Number(entry.number), entry.state)
      }
    }
  } else if (json && typeof json === 'object') {
    for (const [k, v] of Object.entries(json)) {
      if (/^\d+$/.test(k)) put(Number(k), v)
    }
  } else {
    fail(`--issues file ${file}: expected a JSON object or array, got ${typeof json}`)
  }
  return states
}

/**
 * Classify one worktree directory against the hand rule.
 *
 * The order of the checks is the safety contract, not a style choice:
 * inspect the tree FIRST, then the issue state. A tree that cannot be
 * inspected, or is not provably clean, lands in the uncommitted-work bucket
 * and is never proposed for removal - it may hold the only copy of unpushed
 * work. An issue whose state the caller did not supply is NOT closed: a
 * missing lookup must never read as closed.
 *
 * @param {string} dir absolute path of the worktree directory
 * @param {string} name the directory's name, e.g. queen-1318
 * @param {Map<number, 'open'|'closed'>} states issue states supplied by the caller
 * @returns {{classification: string, note: string, dirtyLines: number, issueState: string}}
 */
function classifyWorktree(dir, name, states) {
  // 1. Inspect the tree. Always first, for every directory.
  const status = porcelainStatus(dir)
  if (status === null) {
    return {
      classification: CLASS_DIRTY,
      note: 'cannot inspect this tree (git status failed) - treated as possibly dirty, never removed',
      dirtyLines: -1,
      issueState: 'unknown',
    }
  }
  const dirtyLines = status.split('\n').filter((l) => l.length > 0).length
  if (dirtyLines > 0) {
    const num = issueNumberOf(name)
    const closed = num !== null && states.get(num) === 'closed'
    const count = dirtyLines === 1 ? '1 uncommitted file' : `${dirtyLines} uncommitted files`
    const why = closed ? ` - issue #${num} is closed but this tree may be the only copy` : ''
    return {
      classification: CLASS_DIRTY,
      note: `${count}${why}`,
      dirtyLines,
      issueState: closed ? 'closed' : 'unknown',
    }
  }

  // 2. Only a provably clean tree may be judged on its issue state.
  const num = issueNumberOf(name)
  const state = num === null ? 'unknown' : (states.get(num) ?? 'unknown')
  if (state !== 'closed') {
    const note =
      num === null
        ? 'name is not queen-<issue>, so no state can be looked up - treated as open'
        : state === 'open'
          ? ''
          : `no state for issue #${num} in the caller's input - treated as open, never removed`
    return { classification: CLASS_OPEN, note, dirtyLines: 0, issueState: state }
  }
  return { classification: CLASS_REMOVE, note: '', dirtyLines: 0, issueState: 'closed' }
}

/** Byte size of a directory tree, best effort (du -sb in spirit, stdlib only).
 * Symlinks are counted as their link, never followed. */
function treeSize(start) {
  let total = 0
  const stack = [start]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue // unreadable subtree: report what we could see
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name)
      let st
      try {
        st = fs.lstatSync(full)
      } catch {
        continue
      }
      total += st.size
      if (entry.isDirectory()) stack.push(full)
    }
  }
  return total
}

function human(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = bytes
  let u = -1
  do {
    v /= 1024
    u++
  } while (v >= 1024 && u < units.length - 1)
  return `${v.toFixed(1)} ${units[u]}`
}

/** Default root mirrors workspaceRoot() in queen-dispatch.ts: the same
 * .worktrees directory the dispatcher cuts worktrees under. */
function defaultRoot() {
  const workspace = process.env.WORKSPACE_DIR || '/workspace'
  return path.join(workspace, 'BrowserOS', '.worktrees')
}

function parseArgs(argv) {
  const args = {
    root: null,
    issues: null,
    closed: null,
    remove: false,
    selftest: false,
    help: false,
  }
  const value = (i, flag) => {
    const v = argv[i + 1]
    if (v === undefined) fail(`${flag} needs a value (see --help)`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--remove') args.remove = true
    else if (t === '--selftest') args.selftest = true
    else if (t === '-h' || t === '--help') args.help = true
    else if (t === '--root') args.root = value(i++, t)
    else if (t === '--issues') args.issues = value(i++, t)
    else if (t === '--closed') args.closed = value(i++, t)
    else fail(`unknown argument ${JSON.stringify(t)} (see --help)`)
  }
  return args
}

function usage() {
  out(`worktree-reaper - list (and with --remove, reap) closed, clean bee worktrees

Usage: node trios/tools/worktree-reaper.mjs [options]

Options:
  --root DIR     worktrees root (default: $WORKSPACE_DIR or /workspace, plus
                 /BrowserOS/.worktrees - the root queen-dispatch.ts uses)
  --issues FILE  caller-supplied JSON issue states: {"1347":"closed"} or
                 [{"number":1347,"state":"closed"},...]. Unmentioned issues
                 are treated as NOT closed.
  --closed LIST  comma-separated issue numbers known closed, e.g. --closed 1340,1341
  --remove       remove the trees classified "REMOVE - closed and clean"
                 (default mode reports and removes nothing)
  --selftest     build a fixture, assert the three classifications, tear it down
  -h, --help     this text

Removal rule: issue closed AND git status --porcelain empty, nothing else.
Dirty or uninspectable trees, and issues with unknown state, are always KEEP.`)
}

function reportLine(row, nameWidth) {
  const name = row.name.padEnd(nameWidth)
  const size = human(row.size).padStart(10)
  const note = row.note ? ` (${row.note})` : ''
  return `${name} ${size}  ${row.classification}${note}`
}

/** The default report/remove run. Returns a process exit code. */
function reap(args) {
  const root = args.root ?? defaultRoot()
  const removing = args.remove

  // Issue state comes from the caller, never the network (FR-003).
  const states = new Map()
  let haveStateInput = false
  if (args.issues) {
    for (const [k, v] of parseIssueStatesFile(args.issues)) states.set(k, v)
    haveStateInput = true
  }
  if (args.closed) {
    for (const token of args.closed.split(',')) {
      const t = token.trim()
      if (!/^\d+$/.test(t)) fail(`--closed expects comma-separated issue numbers, got ${JSON.stringify(token)}`)
      states.set(Number(t), 'closed')
    }
    haveStateInput = true
  }

  if (removing && !haveStateInput) {
    out(`${PROG}: refusing to remove anything: no issue-state input was supplied.`)
    out(`${PROG}:   pass --issues FILE (JSON object or GitHub-shaped array) or --closed N,N,...`)
    out(`${PROG}:   issue state must come from the caller: this image holds no GitHub credential,`)
    out(`${PROG}:   and a reaper whose state lookup silently failed would classify every tree`)
    out(`${PROG}:   closed - and delete the only copy of work that was never pushed.`)
    out(`${PROG}: nothing was scanned and nothing was removed.`)
    return 2
  }

  let names
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name)
      .sort()
  } catch (e) {
    fail(`cannot read worktrees root ${root}: ${e.message}`)
  }

  out(`${PROG}: scanning ${root} (${removing ? 'REMOVE MODE' : 'report mode - will remove nothing'})`)
  if (!haveStateInput) {
    out(`${PROG}: note: no issue-state input supplied - every issue reads as unknown, so every tree is kept`)
  }

  const rows = names.map((name) => {
    const dir = path.join(root, name)
    const verdict = classifyWorktree(dir, name, states)
    return { name, dir, size: treeSize(dir), ...verdict }
  })
  const nameWidth = Math.max(12, ...rows.map((r) => r.name.length))
  for (const row of rows) out(reportLine(row, nameWidth))

  const proposed = rows.filter((r) => r.classification === CLASS_REMOVE)
  const kept = rows.length - proposed.length
  const proposedBytes = proposed.reduce((a, r) => a + r.size, 0)
  const totalBytes = rows.reduce((a, r) => a + r.size, 0)
  out(
    `-- ${rows.length} worktree(s), ${human(totalBytes)} total; ` +
      `${proposed.length} ${CLASS_REMOVE} (${human(proposedBytes)}), ${kept} kept`,
  )

  if (!removing) {
    out(`${PROG}: report mode - nothing was removed; rerun with --remove to remove the ${proposed.length} tree(s) above`)
    return 0
  }
  if (proposed.length === 0) {
    out(`${PROG}: nothing classified ${CLASS_REMOVE}; nothing to remove`)
    return 0
  }

  // One `git worktree remove` per directory, run from the owning repository,
  // never rm -rf (FR-004).
  const before = treeSize(root)
  const mainRepos = new Set()
  let removed = 0
  for (const row of proposed) {
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: row.dir })
    const mainRepo = common.ok ? path.dirname(common.out.trim()) : null
    if (mainRepo) mainRepos.add(mainRepo)
    out(`${PROG}: removing ${row.name} (${human(row.size)}) - git worktree remove`)
    const r = mainRepo
      ? git(['worktree', 'remove', row.dir], { cwd: mainRepo })
      : git(['worktree', 'remove', row.dir], { cwd: root })
    if (!r.ok) {
      out(`${PROG}: FAILED to remove ${row.name}: ${(r.err || r.out).slice(0, 300)} - left in place`)
      continue
    }
    out(`${PROG}: removed ${row.name}`)
    removed++
  }

  for (const repo of mainRepos) {
    const p = git(['worktree', 'prune'], { cwd: repo })
    out(`${PROG}: git worktree prune (${repo}): ${p.ok ? 'ok' : `failed - ${(p.err || p.out).slice(0, 200)}`}`)
  }

  const after = treeSize(root)
  out(`${PROG}: removed ${removed} of ${proposed.length} proposed tree(s)`)
  out(`${PROG}: space before: ${human(before)}, after: ${human(after)}, freed: ${human(Math.max(0, before - after))}`)
  return 0
}

/**
 * Build a fixture of three real worktrees, run the tool against it as a
 * subprocess, assert every rule from the issue, tear the fixture down.
 * Prints each assertion; exits 0 only if all pass.
 */
function selftest() {
  const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : new URL(import.meta.url).pathname
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-reaper-selftest-'))
  // Hermetic git: no user or system config leaks into the fixture.
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  const g = (gitArgs, opts = {}) => git(gitArgs, { ...opts, env: gitEnv })
  const ident = ['-c', 'user.email=reaper@example.invalid', '-c', 'user.name=worktree-reaper']
  let passed = 0
  const check = (label, cond, detail = '') => {
    const ok = Boolean(cond)
    out(`${ok ? 'ok' : 'FAIL'}   ${label}`)
    if (!ok) throw new Error(`${label}${detail ? ` - ${detail}` : ''}`)
    passed++
  }
  out(`${PROG}: selftest fixture at ${tmp}`)
  try {
    // ---- fixture: one repo, three worktrees (closed-clean, closed-dirty, open)
    const main = path.join(tmp, 'main')
    const root = path.join(tmp, 'worktrees')
    fs.mkdirSync(root, { recursive: true })
    let r = g(['init', '-b', 'main', main])
    check('fixture: git init main repo', r.ok, r.err)
    r = g([...ident, '-C', main, 'commit', '--allow-empty', '-m', 'fixture base'])
    check('fixture: base commit', r.ok, r.err)
    for (const n of [9001, 9002, 9003]) {
      r = g(['-C', main, 'worktree', 'add', '-b', `queen-${n}`, path.join(root, `queen-${n}`), 'HEAD'])
      check(`fixture: git worktree add queen-${n}`, r.ok, r.err)
    }
    fs.writeFileSync(
      path.join(root, 'queen-9002', 'uncommitted.txt'),
      'the only copy of work that was never pushed\n',
    )
    const issuesFile = path.join(tmp, 'issues.json')
    fs.writeFileSync(issuesFile, JSON.stringify({ 9001: 'closed', 9002: 'closed', 9003: 'open' }))
    const exists = (n) => fs.existsSync(path.join(root, `queen-${n}`))
    check('fixture: all three worktrees present', exists(9001) && exists(9002) && exists(9003))

    const run = (argv) => {
      try {
        return { code: 0, stdout: execFileSync(process.execPath, [scriptPath, ...argv], { encoding: 'utf8', env: gitEnv }) }
      } catch (e) {
        return { code: e.status ?? 1, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` }
      }
    }

    // ---- 1. no --remove flag: report only, three classifications, removes nothing
    const report = run(['--root', root, '--issues', issuesFile])
    check('report run exits 0', report.code === 0, `code=${report.code} ${report.stdout}`)
    out('---- report-mode output against the fixture ----')
    for (const line of report.stdout.split('\n')) if (line.trim()) out(`| ${line}`)
    out('--------------------------------------------------')
    const lineOf = (n) => report.stdout.split('\n').find((l) => l.startsWith(`queen-${n}`)) ?? '(no line)'
    check('report: queen-9001 is REMOVE - closed and clean', lineOf(9001).includes(CLASS_REMOVE), lineOf(9001))
    check('report: queen-9002 is KEEP - uncommitted work', lineOf(9002).includes(CLASS_DIRTY), lineOf(9002))
    check('report: queen-9003 is KEEP - issue open', lineOf(9003).includes(CLASS_OPEN), lineOf(9003))
    check(
      'report: every worktree line carries a size',
      [9001, 9002, 9003].every((n) => /\d+(\.\d+)? (B|KiB|MiB|GiB|TiB)/.test(lineOf(n))),
    )
    check('report: says it removed nothing', /nothing was removed/.test(report.stdout))
    check('report: removed nothing - all three trees still exist', exists(9001) && exists(9002) && exists(9003))

    // ---- 2. --remove with issue state: takes only the closed-and-clean tree
    const removal = run(['--root', root, '--issues', issuesFile, '--remove'])
    check('remove run exits 0', removal.code === 0, `code=${removal.code} ${removal.stdout}`)
    check('remove: queen-9001 (closed, clean) is gone', !exists(9001))
    check('remove: queen-9002 (closed, dirty) is kept', exists(9002))
    check('remove: queen-9003 (open) is kept', exists(9003))
    const listed = g(['-C', main, 'worktree', 'list', '--porcelain']).out
    check('remove: git bookkeeping no longer lists queen-9001', !listed.includes('queen-9001'), listed)
    check('remove: prints what it removed', /removed queen-9001/.test(removal.stdout))
    check(
      'remove: prints space before and after',
      /before:/.test(removal.stdout) && /after:/.test(removal.stdout),
    )
    check(
      'remove: exactly one git worktree remove invocation',
      (removal.stdout.match(/git worktree remove/g) ?? []).length === 1,
      removal.stdout,
    )
    check('remove: pruned afterwards', /git worktree prune/.test(removal.stdout))

    // ---- 3. --remove with no issue-state input: refuses, removes nothing
    const refusal = run(['--root', root, '--remove'])
    check('refusal: exits 2', refusal.code === 2, `code=${refusal.code}`)
    check('refusal: says it refuses to remove', /refusing to remove anything/.test(refusal.stdout))
    check('refusal: removed nothing', exists(9002) && exists(9003))

    out(`${PROG}: selftest passed - ${passed} assertions, all green`)
    return 0
  } catch (e) {
    errOut(`selftest FAILED after ${passed} passing assertion(s): ${e.message}`)
    return 1
  } finally {
    // Teardown: release the fixture's worktree links, then delete the tree.
    try {
      g(['-C', path.join(tmp, 'main'), 'worktree', 'prune'])
    } catch {
      /* best effort - rmSync below removes everything regardless */
    }
    fs.rmSync(tmp, { recursive: true, force: true })
    if (fs.existsSync(tmp)) errOut(`fixture could not be torn down: ${tmp}`)
    else out(`${PROG}: fixture torn down (${tmp})`)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return 0
  }
  if (args.selftest) return selftest()
  return reap(args)
}

process.exit(main())
