/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// ---------------------------------------------------------------------------
// Gate 1: a parser, so the DDL can be judged with no server in the room.
// ---------------------------------------------------------------------------

export type Statement = {
  /** Comments replaced by spaces; string and identifier literals preserved. */
  clean: string
  /** 1-based line in MIGRATION_SQL where the statement starts. */
  line: number
}

export type ParsedSql = {
  statements: Statement[]
  problems: string[]
}

/**
 * Statement splitter that knows the four things that make a naive split wrong:
 * line comments, block comments, single-quoted literals and double-quoted
 * identifiers. This DDL is full of all four - the comments carry paragraphs of
 * prose, and half the chat tables are quoted camelCase identifiers.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a character scanner over four nesting states; splitting it would hide the states from each other
export function parseStatements(sql: string): ParsedSql {
  const problems: string[] = []
  const statements: Statement[] = []
  let clean = ''
  let line = 1
  let startLine = 0
  let depth = 0
  let index = 0

  const add = (text: string, atLine: number) => {
    if (startLine === 0 && text.trim() !== '') startLine = atLine
    clean += text
  }

  const flush = () => {
    if (clean.trim() !== '') {
      statements.push({ clean: clean.trim(), line: startLine })
    }
    clean = ''
    startLine = 0
  }

  while (index < sql.length) {
    const char = sql[index] as string
    const pair = sql.slice(index, index + 2)

    if (char === '\n') {
      line += 1
      clean += '\n'
      index += 1
      continue
    }

    if (pair === '--') {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end
      clean += ' '
      continue
    }

    if (pair === '/*') {
      const end = sql.indexOf('*/', index + 2)
      if (end === -1) {
        problems.push(`line ${line}: block comment is never closed`)
        index = sql.length
        break
      }
      line += (sql.slice(index, end).match(/\n/g) ?? []).length
      index = end + 2
      clean += ' '
      continue
    }

    if (char === "'" || char === '"') {
      const quote = char
      let cursor = index + 1
      let closed = false
      while (cursor < sql.length) {
        if (sql[cursor] === '\n') line += 1
        if (sql[cursor] === quote) {
          if (sql[cursor + 1] === quote) {
            cursor += 2
            continue
          }
          closed = true
          cursor += 1
          break
        }
        cursor += 1
      }
      if (!closed) {
        problems.push(
          `line ${line}: ${quote === "'" ? 'string literal' : 'quoted identifier'} is never closed`,
        )
        index = sql.length
        break
      }
      add(sql.slice(index, cursor), line)
      index = cursor
      continue
    }

    // A backtick would have ended the JavaScript template literal long before
    // PostgreSQL ever saw this. sql-template-literals.test.ts owns that rule;
    // this is the second net, because the string is right here.
    if (char === '`') {
      problems.push(`line ${line}: a backtick inside the SQL block`)
      index += 1
      continue
    }

    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth < 0) {
        problems.push(`line ${line}: a closing parenthesis with nothing open`)
        depth = 0
      }
    }

    if (char === ';' && depth === 0) {
      flush()
      index += 1
      continue
    }

    add(char, line)
    index += 1
  }

  if (depth !== 0) {
    problems.push(`${depth} parenthesis/parentheses left open at end of block`)
  }
  if (clean.trim() !== '') {
    problems.push(
      `line ${startLine}: the last statement is not terminated by a semicolon`,
    )
    flush()
  }

  return { statements, problems }
}

/** Tokens, with a parenthesised group and a quoted literal each one token. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one branch per token shape, and each one has to know where the previous ended
export function tokenize(text: string): string[] {
  const out: string[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index] as string
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      const quote = char
      let cursor = index + 1
      while (cursor < text.length) {
        if (text[cursor] === quote) {
          if (text[cursor + 1] === quote) {
            cursor += 2
            continue
          }
          cursor += 1
          break
        }
        cursor += 1
      }
      out.push(text.slice(index, cursor))
      index = cursor
      continue
    }
    if (char === '(') {
      let depth = 0
      let cursor = index
      while (cursor < text.length) {
        if (text[cursor] === '(') depth += 1
        if (text[cursor] === ')') {
          depth -= 1
          if (depth === 0) {
            cursor += 1
            break
          }
        }
        cursor += 1
      }
      out.push(text.slice(index, cursor))
      index = cursor
      continue
    }
    if (text.slice(index, index + 2) === '::') {
      out.push('::')
      index += 2
      continue
    }
    if (/[A-Za-z0-9_.$]/.test(char)) {
      let cursor = index
      while (
        cursor < text.length &&
        /[A-Za-z0-9_.$]/.test(text[cursor] as string)
      ) {
        cursor += 1
      }
      out.push(text.slice(index, cursor))
      index = cursor
      continue
    }
    out.push(char)
    index += 1
  }
  return out
}

/** Split on commas that are not inside parentheses or a literal. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  let index = 0
  while (index < text.length) {
    const char = text[index] as string
    if (char === "'" || char === '"') {
      const quote = char
      let cursor = index + 1
      while (cursor < text.length) {
        if (text[cursor] === quote) {
          if (text[cursor + 1] === quote) {
            cursor += 2
            continue
          }
          cursor += 1
          break
        }
        cursor += 1
      }
      current += text.slice(index, cursor)
      index = cursor
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      index += 1
      continue
    }
    current += char
    index += 1
  }
  if (current.trim() !== '') parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * Content of the first balanced parenthesised group, or null.
 *
 * Quote-aware, because a parenthesis inside a default literal is text and not
 * structure - the kind of shortcut that makes a checker disagree with the
 * server it is supposed to speak for.
 */
export function firstGroup(text: string): string | null {
  const open = text.indexOf('(')
  if (open === -1) return null
  let depth = 0
  let cursor = open
  while (cursor < text.length) {
    const char = text[cursor] as string
    if (char === "'" || char === '"') {
      const quote = char
      cursor += 1
      while (cursor < text.length) {
        if (text[cursor] === quote) {
          if (text[cursor + 1] === quote) {
            cursor += 2
            continue
          }
          break
        }
        cursor += 1
      }
      cursor += 1
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, cursor)
    }
    cursor += 1
  }
  return null
}
