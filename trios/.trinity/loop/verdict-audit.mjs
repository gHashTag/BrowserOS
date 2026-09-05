#!/usr/bin/env node
// Check a bee's claimed verdict against the diff it actually produced.
//
// WHY THIS IS NEEDED. The Queen accepts on the strength of the bee's own
// `## VERDICT` block. From the diff she reads only two things: whether any file
// was committed at all, and whether any committed path fell outside the
// boundary. Nothing anywhere asks whether the change supports the criterion the
// bee says it met. That is a self-reported score, and the field it belongs to
// has already learned what self-reported scores are worth: on Terminal-Bench
// 1.0 and 2.0 the number one slot was permanently held by vendor self-reports
// sitting 13.5 and 2.5 points above the best independently re-run entry, and
// the maintainers' answer was to stop accepting self-reports at all and to have
// a judge read every successful trajectory.
//
// THE CHECK THIS TOOL CAN MAKE MECHANICALLY. Most briefs in this backlog end
// their Success Criteria with a promise of the form:
//
//     The script defines a function named `foo`; that identifier appears
//     nowhere in the tree today.
//
// That is unfakeable. If `foo` does not appear in the branch's diff, the
// criterion cannot have been met, whatever the VERDICT block says. This is not
// a judgement about quality - it is arithmetic, and it needs no model.
//
// It became possible only on 2026-09-04, when 100 bee branches were pushed for
// the first time. Before that the diff existed nowhere a checker could read it.
//
// Usage:
//   node verdict-audit.mjs 1349 1353 1372
//   node verdict-audit.mjs --accepted        # every issue with an accept verdict

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// IMPORT-SAFE. This module ran its production query and called process.exit at
// import time, so importing it hit the live database and killed the importer -
// the calibration harness could not test it and died mid-run trying. A module
// that does work merely by being imported cannot be tested, and cannot be
// reused. Everything below the guard runs only when this file IS the program.
const isMain = process.argv[1] && process.argv[1].endsWith('/verdict-audit.mjs')


const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.TRIOS_ROOT || '/Users/playra/BrowserOS'
const REPO = process.env.TRIOS_ISSUE_REPO || 'gHashTag/trios'

const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim()

const tryShell = (cmd) => { try { return sh(cmd) } catch { return null } }

/**
 * Identifiers a brief promised the bee would introduce.
 *
 * The first version took every backticked word in the body that looked like an
 * identifier, and duly accused a bee of failing to define `node_modules`. The
 * promise is not "this word appears in backticks" - it is a Success Criteria
 * line asserting the identifier does not exist yet, which is the same rule
 * brief-gate uses to decide a brief is auditable at all. Read it the same way,
 * or the two disagree about what was even promised.
 */
/**
 * The text under a `## Heading`, ending at the next `## ` heading.
 *
 * WHY THIS IS NOT `body.split(heading)[1]`, WHICH IS WHAT IT WAS.
 *
 * `split` cuts on EVERY occurrence, so `[1]` is the text between the first and
 * the second - not the text after the heading. A brief that MENTIONS the
 * heading in prose therefore hands the extractor a fragment of some earlier
 * section and hides the real one completely.
 *
 * That is not hypothetical. #1090 is a brief about checking brief shape, so its
 * acceptance scenario reads "Given an issue body with a `## Boundary` but no
 * `## Success Criteria`". The first occurrence is inside that sentence, `[1]`
 * was 931 characters of User Scenarios, and the criterion two sections below -
 * `briefShape` "appears nowhere in the tree today", exactly the phrase this
 * tool exists to find - was never read. The audit reported NO MECHANICAL CLAIM
 * and was confident about it.
 *
 * A heading is a heading only at the start of a line. Prose mentions are inside
 * backticks and mid-sentence, so anchoring is the whole fix.
 */
export function sectionOf(body, heading) {
  const lines = body.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^#{1,3}\\s+${heading}\\b`).test(l))
  if (start < 0) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^#{1,2}\s+\S/.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

/**
 * The criteria of a brief: the bullets and numbered items under the heading,
 * each one JOINED WITH ITS CONTINUATION LINES.
 *
 * A criterion is a sentence, and a sentence in a markdown bullet wraps. Reading
 * only the first physical line loses whatever came after the wrap - which for
 * #1396 and #1394 is the entire promise, because both open with a bolded label
 * ("**SC-1 (new identifier, absent today).**") and put the identifier on the
 * line below. Both audited as "states nothing checkable" while stating it
 * plainly, one line further down.
 */
export function criteriaOf(body) {
  const out = []
  for (const line of sectionOf(body, 'Success Criteria').split('\n')) {
    if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) { out.push(line); continue }
    // A continuation is indented, non-empty, and not a bullet of its own.
    if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += ' ' + line.trim()
  }
  return out
}

/**
 * Words that are backticked in a criterion and are not a promise.
 *
 * The extractor once harvested `node_modules` from a brief and accused a bee of
 * failing to define it. The same shape came back the moment the absence
 * vocabulary widened: #1399 reads "exists and is exported from a new file", and
 * `export` came out as a promised identifier. A keyword is not something anyone
 * undertakes to write.
 */
export const NOT_IDENTIFIERS = new Set([
  'export', 'exports', 'import', 'default', 'function', 'const', 'let', 'var',
  'class', 'interface', 'type', 'enum', 'return', 'async', 'await', 'true',
  'false', 'null', 'undefined', 'string', 'number', 'boolean', 'object',
  'node_modules', 'package', 'json', 'true0', 'main', 'origin',
])

export function promisedIdentifiers(body) {
  const out = new Set()
  for (const line of criteriaOf(body)) {
    // A CRITERION, not any sentence in the section. The absence phrase appears
    // in prose too: #1387 has a paragraph reading "a section she is publicly
    // telling the author does not exist", from which this harvested four
    // identifiers nobody had promised and then accused the bee of not
    // defining them. A criterion in these briefs is a bullet or a numbered
    // item; a paragraph is background.
    if (!/^\s*(?:[-*]|\d+\.)\s/.test(line)) continue
    // THE ABSENCE PHRASE HAS MORE THAN ONE SPELLING, and the tool knew one.
    //
    // Sampled the unchecked briefs on 2026-09-05. They are not vague. #1399
    // says "Verified absent today", #1396 says "(new identifier, absent
    // today)", #1394 says "The tool defines a constant `X`" - every one of them
    // the same promise as "appears nowhere in the tree today", written by a
    // different hand. A vocabulary of one phrase is not a rule about briefs, it
    // is a rule about the phrase.
    if (!/appears (nowhere|anywhere)|does not (exist|appear)|no such identifier|(?:verified |confirmed )?absent(?: today| from the tree)?|not present (?:today|in the tree)|absent today/i.test(line)) continue
    for (const m of line.matchAll(/`([A-Za-z_][A-Za-z0-9_]{2,})`/g)) {
      if (!NOT_IDENTIFIERS.has(m[1]) && !NOT_IDENTIFIERS.has(m[1].toLowerCase())) out.add(m[1])
    }
  }
  return [...out]
}


/**
 * Criteria that are COMMANDS, and can be run instead of read.
 *
 * 127 of 200 accepted verdicts audited as "no mechanical claim" on 2026-09-05.
 * Reading the briefs, that was false about most of them. They do carry a
 * mechanical claim - just not the one shape this tool knew:
 *
 *   `test -f docs/what-a-bee-can-verify.md` exits `0`.
 *   `grep -c 'Dockerfile' docs/what-a-bee-can-verify.md` prints at least `1`.
 *   `docs/queen-choice.md` exists and contains at least 30 non-empty lines.
 *
 * These are better than an identifier promise, not worse: an identifier has to
 * be pattern-matched out of a diff and argued about, while a criterion that is
 * already a command with an expected output can simply be RUN against the
 * branch. So it is, from `git show <branch>:<path>` - no checkout, no tree
 * mutation, nothing that depends on which worktree the auditor sits in.
 *
 * WHAT IS DELIBERATELY NOT RUN. `bun test ...` exits 0 is also a criterion and
 * also a command, and this will not touch it: running a branch's tests means
 * checking that branch out and installing its dependencies, which is a job for
 * CI and not for an auditor that must stay read-only. It counts as unchecked
 * rather than as passed.
 */

/**
 * WHEN a criterion is supposed to be true, which is not always "after".
 *
 * These briefs are written test-first, so many of them RECORD the red state as
 * evidence that the defect is real: "`grep -c '[^ -~]' <file>` prints 13
 * today", "the pre-edit run stays red, and that red result is the finding, not
 * a failure". That is a BASELINE, not a target.
 *
 * Read as a target it inverts the audit completely. #1390's baseline was 13 at
 * the fork point and 12 on the branch - the bee had removed one - and the audit
 * called it a REGRESSION for no longer printing 13. The bee did the work and
 * was convicted for it.
 *
 * So a criterion carrying a before-marker is checked at the FORK POINT and
 * never counted against the branch.
 */
export function whenOf(line) {
  return /\btoday\b|\bcurrently\b|before (?:the |any )?edit|pre-edit|before writing|on the current tree|as it stands|stays red|at the fork|is true now/i.test(line)
    ? 'before'
    : 'after'
}

export function promisedCommands(body) {
  const out = []
  for (const line of criteriaOf(body)) {
    // `grep -c 'pattern' path` prints/reports at least N.
    //
    // The command may carry leading environment assignments and any bundle of
    // count flags - the L3 briefs this swarm files most often open with
    // `LC_ALL=C grep -cP '[^\\x00-\\x7F]' <file>` - so both are tolerated. A
    // grep whose FILE argument is missing, as in `... | grep -c foo`, is a
    // pipeline this cannot reproduce read-only and is deliberately not matched.
    const GREP = "`(?:[A-Z_]+=\\S+\\s+)*grep\\s+(-[a-zA-Z]*c[a-zA-Z]*)\\s+(['\"])(.+?)\\2\\s+([^\\s`]+)`"
    const g = line.match(new RegExp(GREP + "[^.]*?at least\\s+`?(\\d+)`?", 'i'))
    if (g) { out.push({ kind: 'grep', dialect: dialectOf(g[1]), pattern: g[3], path: g[4], atLeast: Number(g[5]), when: whenOf(line), line }); continue }

    // A SEARCH OVER A DIRECTORY IS STILL A CHECKABLE CLAIM.
    //
    // Sampled the unauditable briefs on 2026-09-05. They are not vague:
    //
    //   `grep -rn '#T27-EPIC-001' trios/.trinity/specs` prints nothing
    //   `git grep -w agent-roster-audit -- . | grep -v worktrees` returns 0 lines
    //
    // Both state exactly what done looks like, and the extractor could not read
    // either, because it only knew `grep -c <pattern> <file>`. Recursive search
    // over a path is the form a brief reaches for when the claim is about the
    // whole tree - which is most of the time when the claim is "this is gone".
    //
    // The count is asked of git rather than of a file, and the boundary is
    // decided here rather than in a shell: the dialect belongs where it is known.
    // TWO GUARDS, BOTH LEARNED THE HARD WAY.
    //
    // The gap between the command and its assertion is bounded to 40 characters.
    // Unbounded, the match walked past the backtick that closed one command and
    // took the phrase belonging to a later sentence - #1397 yielded the pattern
    // `gh`, which matches most files in this repository and would have convicted
    // the bee of every one of them.
    //
    // And a pattern shorter than four characters is refused outright. A brief
    // asserting that a SHORT string is absent from a whole tree is not a claim
    // any tree can satisfy, so reading one is always a misparse.
    const tree = line.match(
      /`(git grep|grep)\s+(?:-[a-zA-Z]+\s+)*['"]?([^'"`\s]{4,})['"]?\s+(?:--\s+)?([^`\s|]+)[^`]*`.{0,40}?(prints nothing|returns 0 lines|returns no lines|finds nothing)/i,
    )
    if (tree) {
      out.push({
        kind: 'grep-tree',
        pattern: tree[2],
        path: tree[3] === '.' ? '' : tree[3],
        exactly: 0,
        when: whenOf(line),
        line,
      })
      continue
    }

    // The same command with a count and a QUALIFIER AFTER IT.
    //
    // #1326 says "prints `2` or more". Read as "exactly 2" it convicted a bee
    // whose file had 3 - which is what the criterion asked for. The number is
    // not the whole criterion; the words on either side of it are the rest, and
    // reading only the number is how a checker becomes confidently wrong.
    const x = line.match(new RegExp(GREP + "[^.]*?prints\\s+(?:exactly\\s+)?`?(\\d+)`?\\s*(or more|or greater|or higher|or fewer|or less)?", 'i'))
    if (x) {
      const n = Number(x[5])
      const qualifier = (x[6] || '').toLowerCase()
      const bound = /more|greater|higher/.test(qualifier) ? { atLeast: n }
        : /fewer|less/.test(qualifier) ? { atMost: n }
          : { exactly: n }
      out.push({ kind: 'grep', dialect: dialectOf(x[1]), pattern: x[3], path: x[4], ...bound, when: whenOf(line), line })
      continue
    }

    // `test -f path` exits 0
    const f = line.match(/`test\s+-f\s+([^\s`]+)`[^.]*?exits\s+`?0`?/i)
    if (f) { out.push({ kind: 'exists', path: f[1], when: whenOf(line), line }); continue }

    // `path` exists and contains at least N non-empty lines
    const c = line.match(/`([^\s`]*\/[^\s`]+)`\s+exists[^.]*?at least\s+`?(\d+)`?\s+non-empty lines/i)
    if (c) { out.push({ kind: 'lines', path: c[1], atLeast: Number(c[2]), when: whenOf(line), line }); continue }

    // `path` exists (plain)
    const e = line.match(/`([^\s`]*\/[^\s`]+)`\s+exists\b/i)
    if (e) { out.push({ kind: 'exists', path: e[1], when: whenOf(line), line }); continue }
  }
  return out
}

/**
 * Read a path out of a branch, trying the prefixes briefs actually write.
 *
 * A brief may name `docs/x.md`, `trios/docs/x.md` or `apps/server/src/x.ts`
 * depending on which directory its author had in mind, and all three are the
 * same file. Accusing a bee because the auditor guessed the wrong root would be
 * exactly the class of false accusation this file already carries three scars
 * from, so every plausible root is tried and only a path that resolves under
 * NONE of them counts as absent.
 */
export function readFromBranch(branch, p, run = tryShell) {
  const roots = ['', 'trios/', 'trios/agent-server/', 'agent-server/']
  for (const r of roots) {
    const got = run(`git show ${branch}:${r}${p.replace(/^\.\//, '')} 2>/dev/null`)
    if (got !== null && got !== undefined) return got
  }
  return null
}


/**
 * Which regular-expression language the criterion was written in.
 *
 * grep speaks three, and they disagree about the commonest characters in a
 * test-file pattern. `grep -P` is PCRE and reads like JavaScript. `grep -E` is
 * ERE and also reads like JavaScript. Plain `grep` is BRE, where `( ) { } | + ?`
 * are ORDINARY characters unless backslashed - the exact opposite of JavaScript.
 */
export function dialectOf(flags) {
  if (/P/.test(flags)) return 'pcre'
  if (/E/.test(flags)) return 'ere'
  return 'bre'
}

/**
 * A BRE read as JavaScript reads it.
 *
 * #1324's criterion is `grep -c '^  it(' <test file>`, which in BRE asks for
 * lines beginning with two spaces and the literal text `it(`. Handed to
 * `new RegExp` it throws on the unclosed group, and the first version of this
 * fell back to a literal substring search, counted 0, and accused a bee whose
 * test file was full of exactly that. A checker that convicts on its own
 * inability to read the question is the worst thing in this file's history and
 * it had just been reintroduced.
 */
export function breToJs(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]
      // In BRE the backslash is what MAKES these special, so it comes off.
      out += '(){}|+?'.includes(next) ? next : '\\' + next
      i++
      continue
    }
    // ...and a bare one is an ordinary character, so it goes on.
    out += '(){}|+?'.includes(ch) ? '\\' + ch : ch
  }
  return out
}

/** The criterion's pattern as a JavaScript regex, or null if it cannot be read. */
export function patternRegex(c) {
  const source = c.dialect === 'bre' ? breToJs(c.pattern) : c.pattern
  try { return new RegExp(source) } catch { /* fall through */ }
  try { return new RegExp(c.pattern) } catch { return null }
}

/** Run one command-criterion against a branch. Returns {ok, why}: ok===null means it could not be read. */
export function runCommandCriterion(branch, c, read = readFromBranch) {
  if (c.kind === 'grep-tree') {
    // `git grep` over the ref, so the answer is about that commit and not about
    // whatever the working tree happens to hold. A count of zero is the claim
    // these briefs make, and git exits 1 when it finds nothing - which is the
    // answer, not a failure.
    const scope = c.path ? ` -- ${JSON.stringify(c.path)}` : ''
    const raw = tryShell(`git grep -c -e ${JSON.stringify(c.pattern)} ${branch}${scope} | wc -l`)
    if (raw === null) return { ok: false, why: `could not search ${branch} for ${c.pattern}` }
    const n = Number(String(raw).trim()) || 0
    return {
      ok: n === 0,
      why: `git grep ${JSON.stringify(c.pattern)}${c.path ? ` in ${c.path}` : ' across the tree'} matched ${n} file(s), criterion asked for none`,
    }
  }
  const text = read(branch, c.path)
  if (text === null) return { ok: false, why: `${c.path} does not exist on the branch` }
  if (c.kind === 'exists') return { ok: true, why: `${c.path} exists` }
  if (c.kind === 'lines') {
    const n = text.split('\n').filter((l) => l.trim()).length
    return { ok: n >= c.atLeast, why: `${c.path} has ${n} non-empty lines, criterion asked for ${c.atLeast}` }
  }
  // grep -c counts LINES that match, not matches.
  //
  // Counted two ways and the LARGER taken. The criterion writes a POSIX basic
  // regex; reading it as a literal substring can only UNDER-count, and an
  // under-count is a false accusation. Where the two disagree the generous
  // reading is the honest one.
  const rx = patternRegex(c)
  if (!rx) {
    // UNREADABLE IS NOT FAILED. A pattern this cannot compile is a question it
    // cannot ask, and a checker that answers anyway is the whole disease.
    return { ok: null, why: `grep -c '${c.pattern}' ${c.path}: the pattern could not be read as a ${c.dialect || 'bre'} regex, so this was not checked` }
  }
  const lines = text.split('\n')
  const literal = lines.filter((l) => l.includes(c.pattern)).length
  const regex = lines.filter((l) => rx.test(l)).length

  // WHICH READING TO BELIEVE DEPENDS ON WHICH WAY A WRONG ANSWER HURTS.
  //
  // For "at least N" the larger count is the generous one, and an under-count
  // would convict a bee that did the work - so the larger is taken.
  //
  // For an exact count, usually "prints 0", generosity would run the other way
  // and let a real violation through, which is the failure mode this whole file
  // exists to avoid. So the faithful reading wins: the compiled regex if the
  // pattern compiles, the literal only when it does not - and the answer says
  // which was used, rather than quietly picking the convenient number.
  // A miss that a capital letter explains is worth saying out loud. grep is
  // case-sensitive and so is this, but "0 matches" and "0 matches, 2 ignoring
  // case" send a reader to two completely different places.
  let hint = ''
  const want = c.exactly !== undefined ? c.exactly : c.atMost !== undefined ? c.atMost : c.atLeast
  const got = c.exactly !== undefined ? regex : Math.max(literal, regex)
  if (got !== want) {
    try {
      const ci = new RegExp(rx.source, 'i')
      const n = lines.filter((l) => ci.test(l)).length
      if (n !== got) hint = `; ${n} ignoring case, so this is a capitalisation mismatch`
    } catch { /* no hint is fine */ }
  }
  if (c.exactly !== undefined) {
    // The reading is named. For an exact count the regex reading is the
    // faithful one and the literal is not consulted; saying so is what lets a
    // reader argue with the number instead of guessing how it was produced.
    return { ok: regex === c.exactly, why: `grep -c '${c.pattern}' ${c.path} = ${regex} (as a regex), criterion asked for exactly ${c.exactly}${hint}` }
  }
  if (c.atMost !== undefined) {
    return { ok: regex <= c.atMost, why: `grep -c '${c.pattern}' ${c.path} = ${regex}, criterion asked for at most ${c.atMost}${hint}` }
  }
  const n = Math.max(literal, regex)
  return { ok: n >= c.atLeast, why: `grep -c '${c.pattern}' ${c.path} = ${n}, criterion asked for at least ${c.atLeast}${hint}` }
}

/** Files a brief named in its Boundary, by the server's own rule. */
export function boundaryPathsOf(body) {
  const paths = []
  let inside = false
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('## ')) { if (inside) break; inside = line.startsWith('## Boundary'); continue }
    if (!inside || !line) continue
    for (const token of line.split(/\s+/)) {
      const c = token.replace(/^[`"'(]+/, '').replace(/[`"'.,;:!?)]+$/, '')
      if (c.includes('/') || /\.\w{1,10}$/.test(c)) { paths.push(c); break }
    }
  }
  return paths
}


// ------------------------------------------------------------------- the cache

// WHY THE AUDIT REMEMBERS, AND EXACTLY WHAT IT REMEMBERS.
//
// Measured 2026-09-05: 0.92 seconds per branch, 207 branches, so a full pass is
// about three minutes - against a per-step cap of five in the heal chain. It
// fits today. It will not fit at four hundred branches, and the way it will
// stop fitting is the way steps in this chain always stop: killed mid-way,
// reported as "timed out part-way", with half an answer that looks like a whole
// one.
//
// The dominant cost is `gh issue view`, not git, so the cache has to spare the
// network call - which means it cannot key on the issue body, because reading
// the body IS the expensive part. It keys on the branch tip and the fork point.
//
// THE TRADE, STATED PLAINLY: a brief edited while its branch stands still is
// served from cache and not re-read. That is a real hole, and `--fresh` is the
// way through it. It is the right trade only because briefs are written once
// and branches move constantly; if that ever stops being true this is wrong.
const CACHE = path.join(DIR, 'state', 'verdict-audit-cache.json')

export function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')) } catch { return {} }
}

export function saveCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true })
    fs.writeFileSync(CACHE, JSON.stringify(c))
  } catch { /* a cache that cannot be written is a slow audit, not a wrong one */ }
}

/**
 * THE AUDITOR'S OWN VERSION IS PART OF THE KEY.
 *
 * The first cache keyed on the branch tip and the fork point only. Then the
 * absence vocabulary widened, a fresh pass found 6 unsupported claims where
 * there had been 2 - and the very next cached pass served the old 2 back,
 * confidently, from verdicts a different program had reached.
 *
 * That is this round's whole lesson wearing a new hat: a measure that answers
 * is not a measure that is right. So the key carries a digest of this file. Any
 * edit to the rules invalidates every verdict reached under the old ones, with
 * no discipline required from whoever makes the edit - which is the only kind
 * of invalidation that survives being forgotten.
 */
let SELF_DIGEST = null
export function selfDigest() {
  if (SELF_DIGEST) return SELF_DIGEST
  try {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    SELF_DIGEST = createHash('sha256').update(src).digest('hex').slice(0, 12)
  } catch {
    // Unreadable source means an unknown ruleset, and an unknown ruleset must
    // never match a remembered one.
    SELF_DIGEST = `unknown-${Date.now()}`
  }
  return SELF_DIGEST
}

/** The key that decides whether a remembered verdict is still about this work. */
export function cacheKey(head, base, digest = selfDigest()) {
  return `${head || '-'}:${base || '-'}:${digest}`
}


/**
 * Is this identifier anywhere in the tree at this ref?
 *
 * WHY THIS REPLACED A PATTERN THAT GUESSED AT DEFINITION SYNTAX.
 *
 * The old check scanned the added lines of the diff for a declaration shape.
 * It produced false accusations in every round it survived - first three
 * (`onReconnected`, a describe title, an identifier nobody promised), then
 * three more on 2026-09-05:
 *
 *   #1389  `connectionFailed`             a Swift enum CASE
 *   #1380  `pressCombo`, `dispatchDrag`   methods on an object literal
 *   #1374  `isTerminalProviderError`      in a new file, reached by import
 *
 * Every one of them was really there, in 6 to 17 added lines. The bee did the
 * work; the checker did not know that language's word for "define". Swift,
 * TypeScript, markdown and shell all spell it differently and the list has no
 * end.
 *
 * So stop guessing. The criterion says the identifier "appears nowhere in the
 * tree today" - which makes ABSENCE the claim, and absence is checkable without
 * knowing any language at all. Present on the branch and absent at the fork
 * point is exactly the promise, measured rather than pattern-matched.
 *
 * The old pattern is kept, but only to STRENGTHEN a note: an identifier that
 * also appears in a declaration-shaped line is better evidence than one that
 * appears only in a comment. It no longer convicts anybody.
 */
export function inTree(ref, id, run = tryShell) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return false
  const hit = run(`git grep -l -w -e ${id} ${ref} -- . | head -1`)
  return Boolean(hit && hit.trim())
}

export function auditIssue(number, cache = null) {
  const branch = `origin/queen-${number}`
  const res = { number, branch, verdict: 'UNKNOWN', notes: [] }

  const head = tryShell(`git rev-parse --verify --quiet ${branch}`)
  if (!head) {
    res.verdict = 'NO BRANCH'
    res.notes.push('no pushed branch - the work is not auditable from here')
    return res
  }

  // The fork point is computed BEFORE the body is fetched, because it is cheap
  // and it is half the cache key. Fetching the body first would spend the
  // expensive call the cache exists to avoid.
  const base = tryShell(`git merge-base origin/feat/queen-supervisor ${branch}`)
    || tryShell('git rev-parse --verify --quiet origin/feat/queen-supervisor')
  const key = cacheKey(head, base)
  if (cache && cache[number] && cache[number].key === key) {
    return { ...cache[number].result, cached: true }
  }

  const body = tryShell(`gh issue view ${number} --repo ${REPO} --json body -q .body`)
  if (body === null) { res.verdict = 'NO ISSUE'; res.notes.push('issue body unreadable'); return res }


// THE FORK POINT, NOT THE CURRENT TIP.
//
// A branch is compared against where it FORKED, not against where the base has
// since moved to. Comparing against the tip reports everything merged into the
// base after the branch was cut as if the branch had DELETED it. Measured
// 2026-09-04 on queen-1351: against the tip, "3 files changed, 94 insertions,
// 234 deletions" - it looked as though the bee had removed a fix and its whole
// test file. Against the merge base: "1 file changed, 90 insertions", which is
// what the bee actually did. A judge handed the first version would have
// convicted an innocent worker.
  const names = tryShell(`git diff --name-only ${base}..${branch}`) || ''
  const files = names.split('\n').filter(Boolean)
  res.files = files.length
  if (!files.length) {
    res.verdict = 'EMPTY DIFF'
    res.notes.push('branch exists and changes nothing')
    return res
  }

  // The added lines of the diff. An identifier only counts if the bee ADDED it.
  const added = (tryShell(`git diff ${base}..${branch} -- . | grep '^+' | head -20000`) || '')

  const promised = promisedIdentifiers(body)
  res.promised = promised

  // A MENTION IS NOT A DEFINITION.
  //
  // The first version of this asked only whether the identifier appeared
  // anywhere among the added lines, which a comment, a string or a test name
  // would satisfy. That is precisely the shape of check a determined agent
  // games, and the field has the receipts: Terminal-Bench removed three agents
  // for storing solutions in the binary, uploading the tests folder, and
  // curling answers from the internet.
  //
  // So the identifier must appear in a DEFINITION among the added lines. This
  // is still not proof the implementation is any good - only a judge reading
  // the diff can say that - but it cannot be satisfied by writing the name in
  // a comment.
  //
  // Checked against all 38 supported results when it was tightened: none
  // changed, so the weakness was real but had not yet been exploited.
  // WHAT COUNTS AS DEFINING IT, and what tightening this cost.
  //
  // Requiring a definition rather than a mention is right - a comment or a
  // string should not satisfy a criterion - but the first pattern was too
  // narrow and produced three accusations, every one of them false:
  //
  //   #1368  `onReconnected(handler: () => void): () => void {`  a class method
  //          whose return-type annotation sits between the parens and the brace
  //   #1407  `describe('taskQueueServiceContract', () => {`      a criterion that
  //          asked for a describe NAME, which is legitimately a string literal
  //   #1376  `node_modules`                                      never promised at
  //          all; the extractor invented it
  //
  // A checker that falsely accuses is worse than a loose one, so all three
  // shapes are accepted now. This still cannot judge whether the code is any
  // good - only a reader of the diff can - but it cannot be passed by writing
  // the name in a comment.
  const defines = (id) => {
    const patterns = [
      // declaration: function foo, const foo, class Foo, type Foo
      `^\\+.*\\b(?:function|const|let|var|class|type|interface|enum)\\s+${id}\\b`,
      // object or class property: foo: ..., foo = ...
      `^\\+\\s*(?:public |private |static |readonly |export )*${id}\\s*[:=]`,
      // method or call-shaped definition, tolerating a return-type annotation
      `^\\+.*\\b${id}\\s*\\([^)]*\\).*\\{\\s*$`,
      // a name the criterion asked to REGISTER rather than declare, such as a
      // describe or test title
      `^\\+.*(?:describe|it|test|suite)\\s*\\(\\s*['"\`]${id}['"\`]`,
    ]
    return patterns.some((p) => new RegExp(p, 'm').test(added))
  }
  // Measured in the tree, not guessed from the diff.
  const identifierChecks = promised.map((id) => {
    const onBranch = inTree(branch, id)
    const atBase = onBranch ? inTree(base, id) : false
    return {
      id,
      onBranch,
      atBase,
      declared: defines(id),
      transition: !onBranch ? 'unsupported' : atBase ? 'vacuous' : 'proven',
    }
  })
  const missing = identifierChecks.filter((c) => !c.onBranch).map((c) => c.id)
  const provenIds = identifierChecks.filter((c) => c.transition === 'proven')
  const vacuousIds = identifierChecks.filter((c) => c.transition === 'vacuous')
  res.missingIdentifiers = missing
  res.identifiers = identifierChecks

  // The command-criteria, run against the branch rather than read.
  const commands = promisedCommands(body)
  //
  // FAIL_TO_PASS, which is the load-bearing idea in SWE-bench and the one thing
  // this audit did not have. A criterion checked only AFTER the work is the
  // PASS_TO_PASS half, and SWE-bench's own note on it is the whole argument:
  // pass-to-pass alone can be satisfied by an EMPTY PATCH. An instance with no
  // fail-to-pass transition is excluded from that benchmark entirely, because
  // nothing about it demonstrates that the work did anything.
  //
  // So each criterion is run twice and the TRANSITION is the verdict:
  //
  //   fail -> pass   PROVEN       the branch caused it
  //   pass -> pass   VACUOUS      true before the bee arrived; proves nothing
  //   pass -> fail   REGRESSION   the branch broke what it used to satisfy
  //   fail -> fail   UNSUPPORTED  claimed and not delivered
  //
  // Checked by hand first, on #1485: 3 non-ASCII lines at the fork point, 0 on
  // the branch. That criterion has teeth. Whether the other 153 did was, until
  // now, unknown - and "unknown" was being reported as "supported".
  const all = commands.map((c) => {
    // A BASELINE IS CHECKED WHERE IT CLAIMS TO BE TRUE, and nowhere else.
    if (c.when === 'before') {
      const at = runCommandCriterion(base, c)
      // Its truth or falsehood is about the BRIEF's premise, never about the
      // bee, so it is reported and never counted against the branch.
      return { ...c, ok: true, transition: 'baseline', why: `baseline at the fork point: ${at.why}`, baselineHeld: at.ok }
    }
    const after = runCommandCriterion(branch, c)
    const before = after.ok === null ? { ok: null } : runCommandCriterion(base, c)
    const transition = after.ok === null ? 'unreadable'
      : before.ok === null ? 'unknown-before'
        : before.ok && after.ok ? 'vacuous'
          : !before.ok && after.ok ? 'proven'
            : before.ok && !after.ok ? 'regression'
              : 'unsupported'
    return { ...c, ...after, before: before.ok, transition }
  })
  const ran = all.filter((r) => r.ok !== null)
  const unreadable = all.filter((r) => r.ok === null)
  const failedCommands = ran.filter((r) => !r.ok)
  const proven = ran.filter((r) => r.transition === 'proven')
  const baselines = ran.filter((r) => r.transition === 'baseline')
  const brokenPremise = baselines.filter((r) => r.baselineHeld === false)
  const vacuous = ran.filter((r) => r.transition === 'vacuous')
  res.commands = ran.length
  res.unreadable = unreadable.length
  res.proven = proven.length
  res.baselines = baselines.length
  res.vacuous = vacuous.length
  res.failedCommands = failedCommands.map((r) => (r.transition === 'regression'
    ? `REGRESSION: ${r.why} - and it PASSED at the fork point`
    : r.why))

  const boundary = boundaryPathsOf(body).map((p) => p.replace(/^trios\//, ''))
  const touched = files.map((f) => f.replace(/^trios\//, ''))
  const strays = touched.filter((f) => !boundary.some((b) => f === b || f.startsWith(b.replace(/\/$/, '') + '/')))
  res.strays = strays

  if ((promised.length && missing.length) || failedCommands.length) {
    res.verdict = 'CLAIM UNSUPPORTED'
    if (missing.length) res.notes.push(`promised ${promised.length} new identifier(s); ${missing.length} never appear in the diff: ${missing.join(', ')}`)
    for (const why of res.failedCommands) res.notes.push(why)
  } else if (promised.length || ran.length) {
    // PROVEN outranks SUPPORTED, and the difference is the whole point. A
    // verdict whose every criterion was already true at the fork point is
    // reported as VACUOUS rather than quietly counted as a pass.
    // ONE RULE FOR BOTH KINDS OF EVIDENCE.
    //
    // A verdict is SUPPORTED when something it claimed was false at the fork
    // point and is true on the branch. Anything less is named for what it is:
    // VACUOUS when every claim was already true before the bee arrived - which
    // is not an accusation, it is the audit saying it cannot tell - and NO
    // MECHANICAL CLAIM when nothing survives that is about the branch at all.
    const aboutTheBranch = (ran.length - baselines.length) + promised.length
    const anythingProven = proven.length + provenIds.length
    res.verdict = aboutTheBranch === 0
      ? 'NO MECHANICAL CLAIM'
      : anythingProven === 0
        ? 'VACUOUS CLAIM'
        : 'SUPPORTED'
    const parts = []
    if (provenIds.length) {
      const declared = provenIds.filter((c) => c.declared).length
      parts.push(`${provenIds.length} promised identifier(s) absent at the fork point and present on the branch` +
        (declared ? `, ${declared} in a declaration` : ''))
    }
    if (vacuousIds.length) parts.push(`${vacuousIds.length} identifier(s) the brief called absent were already in the tree`)
    if (proven.length) parts.push(`${proven.length} criterion(s) failed at the fork point and pass on the branch`)
    if (vacuous.length) parts.push(`${vacuous.length} already true before the work`)
    res.notes.push(parts.join('; '))
  } else {
    res.verdict = 'NO MECHANICAL CLAIM'
    res.notes.push('the brief states nothing this can check without a judge')
  }
  if (brokenPremise.length) res.notes.push(`${brokenPremise.length} baseline(s) did not hold at the fork point - the BRIEF's premise, not the bee's work`)
  if (unreadable.length) res.notes.push(`${unreadable.length} criterion(s) could not be reproduced and were not checked`)
  if (strays.length) res.notes.push(`${strays.length} file(s) outside the declared boundary`)
  return res
}

// ------------------------------------------------------------------------ cli

if (!isMain) { /* imported for calibration or reuse: do nothing */ } else {
let numbers = process.argv.slice(2).filter((a) => /^\d+$/.test(a))
if (process.argv.includes('--accepted')) {
  // THE FLOOR WAS A NUMBER NOBODY EXPLAINED, IN A FILE THAT EXPLAINS EVERYTHING.
  //
  // `select(.number>=1347)` appeared exactly once, with no comment, in a file
  // where the merge-base choice, the mention-versus-definition rule, the three
  // false accusations and the import guard each carry a multi-paragraph
  // justification. Audited 2026-09-05: it excluded 63 of the 189 pushed
  // `queen-*` branches - a third of the swarm's whole output. 57 of those 63
  // briefs carry a Success Criteria section, 15 yield a promised identifier this
  // tool's own extractor accepts, and running `auditIssue` on eight of them by
  // hand returned SUPPORTED for all eight.
  //
  // Both defences failed against measurement. The criteria convention is not the
  // boundary: it reaches down to #1062. Nor is it a date boundary: 34 below-floor
  // branches were committed on 2026-09-03, the same day as 44 above-floor ones.
  //
  // So the data decides instead of a constant. Every issue with a PUSHED branch
  // is auditable, because a pushed branch is exactly what this tool compares a
  // claim against - and an issue without one has nothing to audit. The set
  // justifies itself and cannot drift out of date.
  //
  // The `--limit 200` went with it. There are 189 branches today; a cap two
  // percent above the live number is a silent truncation waiting for next week.
  const branches = tryShell(`git branch -r --list 'origin/queen-*'`) || ''
  numbers = [...new Set(
    branches.split('\n')
      .map((b) => (b.match(/queen-(\d+)\s*$/) || [])[1])
      .filter(Boolean),
  )].sort((a, b) => Number(b) - Number(a))
}
if (!numbers.length) {
  console.log('usage: verdict-audit.mjs <issue> [issue ...] | --accepted')
  process.exit(1)
}

const FRESH = process.argv.includes('--fresh')
const cache = FRESH ? {} : loadCache()
let reused = 0
const tally = {}
for (const n of numbers) {
  const r = auditIssue(n, cache)
  if (r.cached) reused++
  else {
    const head = tryShell(`git rev-parse --verify --quiet origin/queen-${n}`)
    const base = tryShell(`git merge-base origin/feat/queen-supervisor origin/queen-${n}`)
      || tryShell('git rev-parse --verify --quiet origin/feat/queen-supervisor')
    // Only a verdict about real work is worth remembering. NO ISSUE means the
    // network or gh failed, and caching that would turn one bad minute into a
    // permanent answer.
    if (r.verdict !== 'NO ISSUE' && r.verdict !== 'UNKNOWN') {
      cache[n] = { key: cacheKey(head, base), result: r }
    }
  }
  tally[r.verdict] = (tally[r.verdict] || 0) + 1
  const mark = { 'CLAIM UNSUPPORTED': '!!', SUPPORTED: 'ok', 'EMPTY DIFF': '!!', 'NO BRANCH': '??' }[r.verdict] || '  '
  console.log(`${mark} #${r.number}  ${r.verdict.padEnd(20)} files=${r.files ?? '-'}  ${r.notes.join('; ').slice(0, 90)}`)
}
if (!FRESH) saveCache(cache)
console.log('\n' + Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('   '))
if (reused) console.log(`${reused} of ${numbers.length} served from cache - branch tip and fork point unchanged; --fresh re-reads every brief`)

// COVERAGE, which is the number that says whether this tool is worth running.
//
// An audit that can check a third of what the swarm accepts and reports the
// other two thirds as "no mechanical claim" is not measuring the swarm - it is
// measuring its own vocabulary. Printing the fraction makes that visible
// instead of leaving it to be inferred from two counts nobody adds up.
const checkable = (tally.SUPPORTED || 0) + (tally['CLAIM UNSUPPORTED'] || 0) + (tally['VACUOUS CLAIM'] || 0)
const total = numbers.length
console.log(`coverage: ${checkable}/${total} (${Math.round((100 * checkable) / total)}%) of accepted verdicts carry a claim this can check without a judge`)
if (tally['VACUOUS CLAIM']) {
  console.log(`${tally['VACUOUS CLAIM']} passed their own criteria at the FORK POINT too - satisfiable by an empty patch, which is why SWE-bench excludes such instances`)
}
if (tally['NO MECHANICAL CLAIM']) {
  console.log(`${tally['NO MECHANICAL CLAIM']} state nothing checkable - that is a property of how the BRIEF was written, not of the work`)
}
}
