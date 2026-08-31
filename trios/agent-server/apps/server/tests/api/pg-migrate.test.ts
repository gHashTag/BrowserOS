/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A gate for the one statement in this repository that no test executed.
 *
 * MIGRATION_SQL runs once, at container boot, against a real PostgreSQL. Until
 * this file existed the only test of pg-migrate.ts was the no-DATABASE_URL case,
 * which returns before it touches a database - so a missing comma or a bad type
 * anywhere in the DDL was green here, green in typecheck, green in review, and a
 * failed deployment in production. The block grew four tables and six ALTERs
 * that way.
 *
 * Two gates, deliberately both:
 *
 *   1. PARSE. Split the block into statements without a server and check every
 *      one: quotes closed, parentheses balanced, every statement terminated,
 *      every column a name plus a real type plus known modifiers, and every
 *      CREATE and ALTER carrying IF NOT EXISTS - because re-running is what boot
 *      does. This runs everywhere, needs nothing, and catches the two failures
 *      the task names (a missing comma reads as a column definition with a
 *      stray trailing name; a bad type reads as an unknown type).
 *
 *   2. LIVE. Apply the whole block to a scratch database, TWICE, and read the
 *      catalog back. Only PostgreSQL knows whether PostgreSQL accepts this.
 *
 * The live gate FAILS when no server is reachable. It does not skip. A silent
 * skip is how a gate comes to report a success it never earned - this codebase
 * has already shipped one gate that never found its compiler and said nothing.
 * If a machine genuinely has no PostgreSQL, TRIOS_PG_MIGRATE_GATE=offline turns
 * the failure into a skip that is printed loudly and counted by the last test in
 * this file, so the absence is in the output rather than in nobody's head.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { Pool } from 'pg'
import { MIGRATION_SQL, runPgMigrations } from '../../src/lib/db/pg-migrate'
import { logger } from '../../src/lib/logger'

// ---------------------------------------------------------------------------
// Gate 1: a parser, so the DDL can be judged with no server in the room.
// ---------------------------------------------------------------------------

type Statement = {
  /** Comments replaced by spaces; string and identifier literals preserved. */
  clean: string
  /** 1-based line in MIGRATION_SQL where the statement starts. */
  line: number
}

type ParsedSql = {
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
function parseStatements(sql: string): ParsedSql {
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
function tokenize(text: string): string[] {
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
function splitTopLevel(text: string): string[] {
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
function firstGroup(text: string): string | null {
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

const SIMPLE_TYPES = new Set([
  'bigint',
  'bigserial',
  'boolean',
  'bool',
  'bytea',
  'date',
  'float4',
  'float8',
  'inet',
  'int',
  'int2',
  'int4',
  'int8',
  'integer',
  'json',
  'jsonb',
  'numeric',
  'real',
  'serial',
  'smallint',
  'smallserial',
  'text',
  'time',
  'timestamp',
  'timestamptz',
  'timetz',
  'uuid',
  'varchar',
])

const TABLE_CONSTRAINT_STARTS = new Set([
  'primary',
  'unique',
  'foreign',
  'check',
  'constraint',
  'exclude',
])

const CONSTRAINT_STARTS = new Set([
  'not',
  'null',
  'primary',
  'unique',
  'default',
  'references',
  'check',
  'collate',
  'generated',
  'deferrable',
])

function isIdentifier(token: string | undefined): boolean {
  if (!token) return false
  if (token.startsWith('"')) return token.length > 2
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token)
}

/**
 * Read a type off the front of a token list, returning how many tokens it ate.
 *
 * 0 means the token is not a type this DDL is allowed to use - which is exactly
 * how "bigint" mistyped, or a column name left stranded by a missing comma,
 * gets caught.
 *
 * The vocabulary is a closed list on purpose: a checker that accepted any word
 * as a type would pass the defect this file exists for. A migration that needs
 * a type not listed adds it to SIMPLE_TYPES, which is a deliberate act and
 * leaves a diff.
 */
function readType(tokens: string[], at: number): number {
  const first = (tokens[at] ?? '').toLowerCase()
  if (
    first === 'double' &&
    (tokens[at + 1] ?? '').toLowerCase() === 'precision'
  ) {
    return 2
  }
  if (
    first === 'character' &&
    (tokens[at + 1] ?? '').toLowerCase() === 'varying'
  ) {
    return 2 + (tokens[at + 2]?.startsWith('(') ? 1 : 0)
  }
  if (!SIMPLE_TYPES.has(first)) return 0
  let eaten = 1
  if (tokens[at + eaten]?.startsWith('(')) eaten += 1
  const withOrWithout = (tokens[at + eaten] ?? '').toLowerCase()
  if (
    (first === 'timestamp' || first === 'time') &&
    (withOrWithout === 'with' || withOrWithout === 'without') &&
    (tokens[at + eaten + 1] ?? '').toLowerCase() === 'time' &&
    (tokens[at + eaten + 2] ?? '').toLowerCase() === 'zone'
  ) {
    eaten += 3
  }
  // An array of a known type is still a known type: text[] tokenizes as the
  // type, then a bracket pair, and rejecting it would be a false red the first
  // time somebody stores a list.
  while (tokens[at + eaten] === '[' && tokens[at + eaten + 1] === ']') {
    eaten += 2
  }
  return eaten
}

/**
 * name + type + a sequence of modifiers this DDL actually uses.
 *
 * Anything else is reported rather than tolerated. A permissive column checker
 * would pass the two defects this gate exists for.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the column grammar itself, one clause per branch; a table of handlers would be the same rules with a lookup between them
function columnProblems(definition: string): string[] {
  const tokens = tokenize(definition)
  if (tokens.length === 0) return ['empty column definition']

  if (TABLE_CONSTRAINT_STARTS.has((tokens[0] as string).toLowerCase())) {
    // A table-level constraint: PRIMARY KEY (a, b), REFERENCES ..., CHECK (...).
    // Its shape is carried by the parenthesised group, which the splitter has
    // already proven balanced.
    return []
  }

  if (!isIdentifier(tokens[0])) {
    return [`"${tokens[0]}" is not a column name`]
  }

  const typeLength = readType(tokens, 1)
  if (typeLength === 0) {
    return [
      `column ${tokens[0]}: "${tokens[1] ?? '(nothing)'}" is not a type this migration may use`,
    ]
  }

  let at = 1 + typeLength
  while (at < tokens.length) {
    const word = (tokens[at] as string).toLowerCase()
    if (word === 'not' && (tokens[at + 1] ?? '').toLowerCase() === 'null') {
      at += 2
      continue
    }
    if (word === 'null' || word === 'unique') {
      at += 1
      continue
    }
    if (word === 'primary' && (tokens[at + 1] ?? '').toLowerCase() === 'key') {
      at += 2
      continue
    }
    if (word === 'check' && tokens[at + 1]?.startsWith('(')) {
      at += 2
      continue
    }
    if (word === 'references') {
      at += 1
      if (!isIdentifier(tokens[at])) {
        return [`column ${tokens[0]}: REFERENCES without a table`]
      }
      at += 1
      if (tokens[at]?.startsWith('(')) at += 1
      while ((tokens[at] ?? '').toLowerCase() === 'on') {
        at += 2 // ON DELETE / ON UPDATE
        const action = (tokens[at] ?? '').toLowerCase()
        at += 1
        if (action === 'set' || action === 'no') at += 1
      }
      continue
    }
    if (word === 'default') {
      at += 1
      if (at >= tokens.length) {
        return [`column ${tokens[0]}: DEFAULT with no value`]
      }
      // One expression: a literal or an identifier, optionally a call, then any
      // number of ::casts. NULL right after DEFAULT is a value, not a modifier.
      if ((tokens[at] as string).toLowerCase() === 'null') at += 1
      else {
        at += 1
        if (tokens[at]?.startsWith('(')) at += 1
      }
      while (tokens[at] === '::') at += 2
      while (
        at < tokens.length &&
        !CONSTRAINT_STARTS.has((tokens[at] as string).toLowerCase())
      ) {
        // Arithmetic or an interval inside a default: consume it, but only
        // while it is plainly still part of the expression.
        if (!/^[-+*/]$/.test(tokens[at] as string)) break
        at += 2
        while (tokens[at] === '::') at += 2
      }
      continue
    }
    return [
      `column ${tokens[0]}: unexpected "${tokens[at]}" after the definition (a missing comma reads exactly like this)`,
    ]
  }
  return []
}

type StatementFacts = {
  kind: 'create table' | 'create index' | 'alter table' | 'unknown'
  table: string
  name: string
  columns: { name: string; type: string }[]
  problems: string[]
}

const CREATE_TABLE =
  /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s*\(/i
const CREATE_INDEX =
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s+ON\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s*\(/i
const ALTER_TABLE = /^ALTER\s+TABLE\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s+(.*)$/is
const ADD_COLUMN = /^ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(.*)$/is

function unquote(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1) : name
}

function describeStatement(statement: Statement): StatementFacts {
  const text = statement.clean.replace(/\s+/g, ' ').trim()
  const facts: StatementFacts = {
    kind: 'unknown',
    table: '',
    name: '',
    columns: [],
    problems: [],
  }

  const createTable = CREATE_TABLE.exec(text)
  if (createTable) {
    facts.kind = 'create table'
    facts.table = unquote(createTable[1] as string)
    facts.name = facts.table
    const body = firstGroup(text)
    if (body === null) {
      facts.problems.push('CREATE TABLE with no column list')
      return facts
    }
    for (const definition of splitTopLevel(body)) {
      const tokens = tokenize(definition)
      const head = (tokens[0] ?? '').toLowerCase()
      if (!TABLE_CONSTRAINT_STARTS.has(head)) {
        const typeLength = readType(tokens, 1)
        facts.columns.push({
          name: unquote(tokens[0] ?? ''),
          type: tokens
            .slice(1, 1 + Math.max(typeLength, 1))
            .join(' ')
            .toLowerCase(),
        })
      }
      facts.problems.push(...columnProblems(definition))
    }
    return facts
  }

  const createIndex = CREATE_INDEX.exec(text)
  if (createIndex) {
    facts.kind = 'create index'
    facts.name = createIndex[1] as string
    facts.table = unquote(createIndex[2] as string)
    if (firstGroup(text) === null) {
      facts.problems.push('CREATE INDEX with no column list')
    }
    return facts
  }

  const alterTable = ALTER_TABLE.exec(text)
  if (alterTable) {
    facts.kind = 'alter table'
    facts.table = unquote(alterTable[1] as string)
    facts.name = facts.table
    for (const clause of splitTopLevel(alterTable[2] as string)) {
      const addColumn = ADD_COLUMN.exec(clause)
      if (!addColumn) {
        facts.problems.push(
          `ALTER TABLE ${facts.table}: "${clause.slice(0, 60)}" is not ADD COLUMN IF NOT EXISTS - boot re-runs this block, so every clause must survive a second run`,
        )
        continue
      }
      const definition = addColumn[1] as string
      const tokens = tokenize(definition)
      const typeLength = readType(tokens, 1)
      facts.columns.push({
        name: unquote(tokens[0] ?? ''),
        type: tokens
          .slice(1, 1 + Math.max(typeLength, 1))
          .join(' ')
          .toLowerCase(),
      })
      facts.problems.push(...columnProblems(definition))
    }
    return facts
  }

  facts.problems.push(
    `not a form this migration may take (every statement must be CREATE TABLE / CREATE INDEX / ALTER TABLE, each with IF NOT EXISTS): "${text.slice(0, 80)}"`,
  )
  return facts
}

export function migrationOffences(sql: string): string[] {
  const parsed = parseStatements(sql)
  const offences = [...parsed.problems]
  for (const statement of parsed.statements) {
    const facts = describeStatement(statement)
    for (const problem of facts.problems) {
      // Numbered from the start of the SQL string, not the start of the file,
      // and said so - a line number that silently means something else is how
      // a person ends up staring at the wrong statement.
      offences.push(`MIGRATION_SQL line ${statement.line}: ${problem}`)
    }
  }
  return offences
}

function factsFor(sql: string): StatementFacts[] {
  return parseStatements(sql).statements.map(describeStatement)
}

describe('the migration block, parsed', () => {
  const facts = factsFor(MIGRATION_SQL)

  it('is syntactically well-formed, statement by statement', () => {
    expect(migrationOffences(MIGRATION_SQL)).toEqual([])
  })

  it('is idempotent: every CREATE and ALTER survives a second boot', () => {
    // The check lives in describeStatement - a CREATE without IF NOT EXISTS
    // matches none of the three forms and is reported as "not a form this
    // migration may take". This test states the rule in the open so that
    // deleting it from the parser is a visible act.
    for (const statement of parseStatements(MIGRATION_SQL).statements) {
      const head = statement.clean.replace(/\s+/g, ' ').trim().slice(0, 60)
      expect(head).toMatch(/IF NOT EXISTS/i)
    }
    expect(facts.every((fact) => fact.kind !== 'unknown')).toBe(true)
  })

  it('has statements at all, so an empty parse cannot pass for a clean one', () => {
    // A parser that returned nothing would satisfy every assertion above it.
    expect(facts.length).toBeGreaterThan(20)
  })

  // The DDL this file was opened for: added 2026-08-31, executed by no test.
  it('creates queen_dispatch_history with the four columns the archive needs', () => {
    const table = facts.find(
      (fact) =>
        fact.kind === 'create table' && fact.name === 'queen_dispatch_history',
    )
    expect(table).toBeDefined()
    const columns = new Map(
      (table as StatementFacts).columns.map((column) => [
        column.name,
        column.type,
      ]),
    )
    expect(columns.get('id')).toBe('bigserial')
    expect(columns.get('issue')).toBe('int')
    expect(columns.get('archived_at')).toBe('timestamptz')
    expect(columns.get('snapshot')).toBe('jsonb')
  })

  it('indexes the archive by issue, or the board reads every attempt ever', () => {
    const index = facts.find(
      (fact) => fact.name === 'idx_queen_dispatch_history_issue',
    )
    expect(index?.kind).toBe('create index')
    expect(index?.table).toBe('queen_dispatch_history')
  })

  it('adds input_tokens and output_tokens to queen_dispatch as bigint', () => {
    const added = new Map<string, string>()
    for (const fact of facts) {
      if (fact.kind !== 'alter table' || fact.table !== 'queen_dispatch') {
        continue
      }
      for (const column of fact.columns) added.set(column.name, column.type)
    }
    expect(added.get('input_tokens')).toBe('bigint')
    expect(added.get('output_tokens')).toBe('bigint')
  })
})

/**
 * The parser has to go red on the real shapes or it proves nothing. These are
 * the two failures the task names, reduced to a table each.
 */
describe('the parser itself', () => {
  const clean = [
    'CREATE TABLE IF NOT EXISTS t (',
    '  id bigserial PRIMARY KEY,',
    '  issue int NOT NULL,',
    "  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,",
    '  archived_at timestamptz NOT NULL DEFAULT now()',
    ');',
  ].join('\n')

  it('passes DDL that is fine', () => {
    expect(migrationOffences(clean)).toEqual([])
  })

  it('catches a missing comma', () => {
    const broken = clean.replace('issue int NOT NULL,', 'issue int NOT NULL')
    const hits = migrationOffences(broken)
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('missing comma')
  })

  it('catches a bad type', () => {
    const broken = clean.replace('issue int NOT NULL', 'issue intt NOT NULL')
    const hits = migrationOffences(broken)
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('is not a type')
  })

  it('catches an unclosed parenthesis', () => {
    const broken = clean.replace(');', ';')
    expect(migrationOffences(broken).length).toBeGreaterThan(0)
  })

  it('catches an unterminated statement', () => {
    const broken = clean.replace(');', ')')
    expect(migrationOffences(broken).join(' ')).toContain('not terminated')
  })

  it('catches an unclosed string literal', () => {
    const broken = clean.replace("'{}'::jsonb", "'{}::jsonb")
    expect(migrationOffences(broken).join(' ')).toContain('never closed')
  })

  it('catches a CREATE TABLE that boot cannot re-run', () => {
    const broken = clean.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE')
    expect(migrationOffences(broken).join(' ')).toContain(
      'not a form this migration may take',
    )
  })

  it('catches an ALTER that boot cannot re-run', () => {
    const broken = 'ALTER TABLE t ADD COLUMN input_tokens bigint;'
    expect(migrationOffences(broken).join(' ')).toContain(
      'must survive a second run',
    )
  })

  it('accepts an ALTER that boot can re-run, including several clauses', () => {
    const fine = [
      'ALTER TABLE t',
      '  ADD COLUMN IF NOT EXISTS input_tokens bigint,',
      '  ADD COLUMN IF NOT EXISTS output_tokens bigint;',
    ].join('\n')
    expect(migrationOffences(fine)).toEqual([])
  })

  it('is not fooled by a comma or a semicolon inside prose', () => {
    const fine = [
      '-- One row, replaced whole; the registry is read as a unit.',
      '/* A block comment; with a semicolon, a comma and a (paren. */',
      'CREATE TABLE IF NOT EXISTS t (',
      '  variant text PRIMARY KEY, -- the key; nothing else',
      "  note text NOT NULL DEFAULT 'a, b; c'",
      ');',
    ].join('\n')
    expect(migrationOffences(fine)).toEqual([])
  })

  it('accepts an array of a known type but still refuses an unknown one', () => {
    const fine = 'CREATE TABLE IF NOT EXISTS t (tags text[] NOT NULL);'
    expect(migrationOffences(fine)).toEqual([])
    const broken = 'CREATE TABLE IF NOT EXISTS t (tags texts[] NOT NULL);'
    expect(migrationOffences(broken).join(' ')).toContain('is not a type')
  })

  it('reads quoted camelCase identifiers as columns', () => {
    const fine = [
      'CREATE TABLE IF NOT EXISTS "conversationMessages" (',
      '  "rowId" text PRIMARY KEY,',
      '  "conversationId" text NOT NULL REFERENCES conversations("rowId") ON DELETE CASCADE,',
      '  "orderIndex" int NOT NULL',
      ');',
    ].join('\n')
    expect(migrationOffences(fine)).toEqual([])
    const [facts] = factsFor(fine)
    expect(facts?.table).toBe('conversationMessages')
    expect(facts?.columns.map((column) => column.name)).toEqual([
      'rowId',
      'conversationId',
      'orderIndex',
    ])
  })
})

// ---------------------------------------------------------------------------
// Gate 2: the same block, applied twice to a real PostgreSQL.
// ---------------------------------------------------------------------------

const OFFLINE_KEY = 'TRIOS_PG_MIGRATE_GATE'
const URL_KEY = 'TRIOS_PG_TEST_URL'

/** Set by the live test; read by the last test in this file. */
const liveGate = { ran: false, skipped: false, reason: '' }

function offlineRequested(): boolean {
  return (process.env[OFFLINE_KEY] ?? '').toLowerCase() === 'offline'
}

/**
 * Where the scratch database is created. NEVER process.env.DATABASE_URL - that
 * is the deployment's own database on the machine this runs on, and this test
 * creates and drops databases.
 */
function adminUrl(): string {
  const configured = process.env[URL_KEY]
  if (configured) return configured
  return `postgres://${userInfo().username}@127.0.0.1:5432/postgres`
}

/** Host and database only. A configured URL may carry a password. */
function redact(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`
  } catch {
    return '(unparseable URL)'
  }
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

async function reach(url: string): Promise<string | null> {
  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 4000,
  })
  try {
    await pool.query('SELECT 1')
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    await pool.end().catch(() => {})
  }
}

const UNREACHABLE = (where: string, why: string) =>
  [
    '',
    '  THE LIVE MIGRATION GATE COULD NOT REACH A POSTGRESQL.',
    '',
    `  Tried: ${where}`,
    `  Why:   ${why}`,
    '',
    '  This is a FAILURE and not a skip on purpose. MIGRATION_SQL runs at',
    '  container boot; if it throws there the deployment is broken, and a gate',
    '  that quietly passes when it cannot check is worse than no gate.',
    '',
    `  Point it at a server with ${URL_KEY}, or, if this machine genuinely has`,
    `  none, set ${OFFLINE_KEY}=offline - the skip is then printed and counted`,
    '  by the last test in this file rather than being invisible.',
    '',
  ].join('\n')

describe('the migration block, applied to a real PostgreSQL', () => {
  let savedDatabaseUrl: string | undefined
  let savedRailwayUrl: string | undefined

  beforeEach(() => {
    savedDatabaseUrl = process.env.DATABASE_URL
    savedRailwayUrl = process.env.RAILWAY_SSOT_URL
  })

  afterEach(() => {
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = savedDatabaseUrl
    if (savedRailwayUrl === undefined) delete process.env.RAILWAY_SSOT_URL
    else process.env.RAILWAY_SSOT_URL = savedRailwayUrl
  })

  it('creates every object it promises, and survives a second boot', async () => {
    const admin = adminUrl()
    if (!isLocal(admin) && process.env.TRIOS_PG_TEST_ALLOW_REMOTE !== '1') {
      throw new Error(
        `${URL_KEY} points at ${redact(admin)}, which is not local. This test CREATEs and DROPs databases; set TRIOS_PG_TEST_ALLOW_REMOTE=1 only if that server is disposable.`,
      )
    }

    const failure = await reach(admin)
    if (failure) {
      if (offlineRequested()) {
        liveGate.skipped = true
        liveGate.reason = `${redact(admin)}: ${failure}`
        console.error(UNREACHABLE(redact(admin), failure))
        console.error(
          `  ${OFFLINE_KEY}=offline is set, so this is recorded as a SKIP.\n`,
        )
        return
      }
      throw new Error(UNREACHABLE(redact(admin), failure))
    }

    const name = `trios_pg_gate_${process.pid}_${randomBytes(4).toString('hex')}`
    const adminPool = new Pool({ connectionString: admin, max: 1 })
    await adminPool.query(`CREATE DATABASE ${name}`)

    const scratch = new URL(admin)
    scratch.pathname = `/${name}`
    const scratchUrl = scratch.toString()

    const errors: unknown[][] = []
    const originalError = logger.error.bind(logger)
    logger.error = (...args: unknown[]) => {
      errors.push(args)
    }

    let inspection: Record<string, unknown> = {}
    try {
      process.env.DATABASE_URL = scratchUrl
      delete process.env.RAILWAY_SSOT_URL

      // Twice. Boot re-runs this block on every deploy, and the second run is
      // the one an ALTER without IF NOT EXISTS breaks.
      await runPgMigrations()
      await runPgMigrations()

      const pool = new Pool({ connectionString: scratchUrl, max: 1 })
      try {
        const columns = await pool.query(
          "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'",
        )
        const indexes = await pool.query(
          "SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'",
        )
        inspection = {
          columns: columns.rows as Record<string, string>[],
          indexes: indexes.rows as Record<string, string>[],
        }
      } finally {
        await pool.end()
      }
    } finally {
      logger.error = originalError
      if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = savedDatabaseUrl
      await adminPool
        .query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        .catch(() => {})
      await adminPool.end().catch(() => {})
    }

    // runPgMigrations swallows its own failure into logger.error and returns
    // normally, so a green call proves nothing by itself. This is the line that
    // turns a broken migration into a red test.
    expect(errors.map((args) => JSON.stringify(args)).join('\n')).toBe('')

    const columns = inspection.columns as {
      table_name: string
      column_name: string
      data_type: string
    }[]
    const indexes = inspection.indexes as {
      indexname: string
      tablename: string
      indexdef: string
    }[]

    const typeOf = (table: string, column: string) =>
      columns.find(
        (row) => row.table_name === table && row.column_name === column,
      )?.data_type

    expect(typeOf('queen_dispatch_history', 'id')).toBe('bigint')
    expect(typeOf('queen_dispatch_history', 'issue')).toBe('integer')
    expect(typeOf('queen_dispatch_history', 'archived_at')).toBe(
      'timestamp with time zone',
    )
    expect(typeOf('queen_dispatch_history', 'snapshot')).toBe('jsonb')
    expect(typeOf('queen_dispatch', 'input_tokens')).toBe('bigint')
    expect(typeOf('queen_dispatch', 'output_tokens')).toBe('bigint')

    const archiveIndex = indexes.find(
      (row) => row.indexname === 'idx_queen_dispatch_history_issue',
    )
    expect(archiveIndex?.tablename).toBe('queen_dispatch_history')
    expect(archiveIndex?.indexdef).toContain('issue')

    // Every table the parser said would exist, exists.
    const created = new Set(columns.map((row) => row.table_name))
    for (const fact of factsFor(MIGRATION_SQL)) {
      if (fact.kind === 'create table') expect(created).toContain(fact.name)
    }

    liveGate.ran = true
  }, 60_000)

  it('skips and says so when there is no database to migrate', async () => {
    const warnings: unknown[][] = []
    const originalWarn = logger.warn.bind(logger)
    logger.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    delete process.env.DATABASE_URL
    delete process.env.RAILWAY_SSOT_URL
    try {
      await runPgMigrations()
    } finally {
      logger.warn = originalWarn
    }
    expect(
      warnings.some((args) => String(args[0]).includes('DATABASE_URL')),
    ).toBe(true)
  })
})

describe('the live gate', () => {
  it('ran, or its absence is on the record', () => {
    if (liveGate.ran) {
      console.error('  PG LIVE GATE: RAN against a real PostgreSQL.')
      expect(liveGate.skipped).toBe(false)
      return
    }
    if (liveGate.skipped) {
      console.error(
        `  PG LIVE GATE: SKIPPED, because ${OFFLINE_KEY}=offline was set. Reason: ${liveGate.reason}`,
      )
      // The skip is legitimate only because somebody asked for it out loud.
      expect(offlineRequested()).toBe(true)
      return
    }
    // Neither ran nor skipped: the live test failed. It has already reported
    // why; this exists so the count of migrations actually applied cannot be
    // mistaken for one.
    console.error(
      '  PG LIVE GATE: DID NOT RUN. The live test above failed - the migration was never applied to a database in this run.',
    )
    expect('the live gate to have run or been skipped on purpose').toBe(
      'it did neither',
    )
  })
})
