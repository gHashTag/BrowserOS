import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A backtick inside a template literal ends it.
 *
 * That sentence is obvious and it has now cost this deployment three outages
 * and a red typecheck, all in one file, all on the same day:
 *
 *   1. `awaitingReview` inside a SQL comment -> the server 502'd on deploy with
 *      "ReferenceError: awaitingReview is not defined"
 *   2. a function name quoted the same way, thirty minutes after I wrote a
 *      comment in that file saying never to do it
 *   3. inside the sentence telling myself not to do it
 *
 * The third one is the argument for this file. A comment cannot enforce itself,
 * and the author of the warning was the person who broke it twice. So the rule
 * moves from prose into a check.
 *
 * Scope is deliberately narrow: template literals that carry SQL. A backtick in
 * an ordinary template literal is usually intentional (markdown, shell, nested
 * template) and flagging those would produce a check people learn to ignore.
 * SQL strings never legitimately contain one.
 */

const SRC = join(import.meta.dir, '../../src')

function everyTsFile(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...everyTsFile(path))
    else if (name.endsWith('.ts')) out.push(path)
  }
  return out
}

/**
 * Backticks inside a SQL template block, found line by line.
 *
 * A first version tried to be clever - walk the literal, honour escapes, judge
 * what follows the close - and its own negative test caught it doing nothing.
 * That failure is the reason this version is dumb: these literals are written
 * as an assignment ending in a backtick, a block of SQL, and a closing backtick
 * alone on a line. Scanning that block for a backtick is the whole check, and a
 * check simple enough to be obviously right beats one that needs its own tests
 * to be trusted.
 *
 * `bun run typecheck` also catches this, and is the gate I should have run
 * before deploying. This exists because the failure is silent in review and
 * loud in production, and one more cheap net is worth having.
 */
function sqlBlockOffences(source: string): string[] {
  const lines = source.split('\n')
  const offences: string[] = []
  let inBlock = false
  let looksLikeSql = false
  let opened = 0
  let block: string[] = []
  lines.forEach((line, index) => {
    if (!inBlock) {
      if (/=\s*(String\.raw)?`\s*$/.test(line)) {
        inBlock = true
        looksLikeSql = false
        opened = index + 1
        block = []
      }
      return
    }
    if (/^\s*`/.test(line)) {
      if (looksLikeSql) {
        block.forEach((text, offset) => {
          if (text.includes('`')) {
            offences.push(
              `line ${opened + offset + 1}: ${text.trim().slice(0, 70)}`,
            )
          }
        })
      }
      inBlock = false
      return
    }
    if (
      /\b(CREATE TABLE|ALTER TABLE|INSERT INTO|CREATE INDEX|UPDATE |DELETE FROM)\b/i.test(
        line,
      )
    ) {
      looksLikeSql = true
    }
    block.push(line)
  })
  return offences
}

/**
 * The same scan, for template literals that open an HTML document.
 *
 * The SQL-only version above missed a backtick in a CSS comment inside a page
 * shell, which is the fourth time in one day and the second class of literal.
 * A page shell is hand-written prose wrapped in a template literal - exactly
 * where an author reaches for backticks out of habit - and it never needs one.
 */
function shellOffences(source: string): string[] {
  const lines = source.split('\n')
  const offences: string[] = []
  let inShell = false
  let opened = 0
  lines.forEach((line, index) => {
    if (!inShell) {
      if (/=\s*`<!doctype html>/i.test(line)) {
        inShell = true
        opened = index + 1
      }
      return
    }
    // The literal closes either on its own line or at the END of the last
    // markup line - `</body></html>` followed by the backtick is the common
    // shape here. A detector that only knew the first spelling reported three
    // closing backticks as offences, which is the kind of noise that gets a
    // check switched off.
    if (/^\s*`/.test(line) || /`\s*$/.test(line)) {
      inShell = false
      return
    }
    if (line.includes('`')) {
      offences.push(`line ${opened + index}: ${line.trim().slice(0, 70)}`)
    }
  })
  return offences
}

describe('SQL template literals', () => {
  it('contain no backticks, in any source file', () => {
    const offenders: string[] = []
    for (const file of everyTsFile(SRC)) {
      for (const hit of sqlBlockOffences(readFileSync(file, 'utf8'))) {
        offenders.push(`${file.replace(SRC, 'src')} ${hit}`)
      }
    }
    expect(offenders).toEqual([])
  })

  // The check has to fail on the real shape or it proves nothing. This is the
  // 2026-08-31 outage, reduced to five lines.
  it('catches the shape that took the server down', () => {
    const broken = [
      'const SQL = `',
      'CREATE TABLE t (a int);',
      '-- see `awaitingReview`: a state that is not terminal',
      'ALTER TABLE t ADD COLUMN b text;',
      '`',
    ].join('\n')
    const hits = sqlBlockOffences(broken)
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('awaitingReview')
  })

  it('does not flag a SQL block that is clean', () => {
    const fine = [
      'const SQL = `',
      'CREATE TABLE t (a int);',
      '-- see awaitingReview: a state that is not terminal',
      '`',
    ].join('\n')
    expect(sqlBlockOffences(fine)).toEqual([])
  })

  it('ignores a template literal that is not SQL', () => {
    const markdown = [
      'const DOC = `',
      'Run `make check` before landing anything.',
      '`',
    ].join('\n')
    expect(sqlBlockOffences(markdown)).toEqual([])
  })
  // FOURTH occurrence, same day, and the SQL-only scope let it through: a
  // backtick in a CSS comment inside a page SHELL. 16 typecheck errors from
  // four files at once.
  //
  // The scope widens to any template literal that opens an HTML document,
  // because those carry no legitimate backticks either - and they are, in this
  // codebase, exactly where long hand-written prose ends up.
  it('finds backticks in a page shell, not only in SQL', () => {
    const broken = [
      'const SHELL = `<!doctype html>',
      '<style>',
      '/* the `hidden` attribute loses to an author rule */',
      '</style>',
      '`',
    ].join('\n')
    expect(shellOffences(broken).length).toBe(1)
  })

  it('does not flag a shell that is clean', () => {
    const fine = [
      'const SHELL = `<!doctype html>',
      '<style>',
      '/* the hidden attribute loses to an author rule */',
      '</style>',
      '`',
    ].join('\n')
    expect(shellOffences(fine)).toEqual([])
  })

  // The false positive this detector had: the literal closes at the end of the
  // last markup line, not on a line of its own.
  it('does not flag the closing backtick of a shell', () => {
    const fine = [
      'const SHELL = `<!doctype html>',
      '<style>/* fine */</style>',
      '</body></html>`',
    ].join('\n')
    expect(shellOffences(fine)).toEqual([])
  })

  it('every page shell in the tree is clean', () => {
    const offenders: string[] = []
    for (const file of everyTsFile(SRC)) {
      for (const hit of shellOffences(readFileSync(file, 'utf8'))) {
        offenders.push(`${file.replace(SRC, 'src')} ${hit}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
