/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// ---------------------------------------------------------------------------
// Gate 1, continued: the column grammar and the statement-facts reader.
// ---------------------------------------------------------------------------

import {
  firstGroup,
  parseStatements,
  type Statement,
  splitTopLevel,
  tokenize,
} from './pg-migrate-sql-parser'

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
export function columnProblems(definition: string): string[] {
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

export type StatementFacts = {
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

export function describeStatement(statement: Statement): StatementFacts {
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

export function factsFor(sql: string): StatementFacts[] {
  return parseStatements(sql).statements.map(describeStatement)
}
