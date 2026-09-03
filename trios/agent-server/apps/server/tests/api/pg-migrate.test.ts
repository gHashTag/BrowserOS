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
 * Two gates, deliberately both. This file carries the first; the second,
 * pg-migrate-live.test.ts, carries the LIVE gate and the record of why it
 * refuses to skip silently:
 *
 *   1. PARSE. Split the block into statements without a server and check every
 *      one: quotes closed, parentheses balanced, every statement terminated,
 *      every column a name plus a real type plus known modifiers, and every
 *      CREATE and ALTER carrying IF NOT EXISTS - because re-running is what boot
 *      does. This runs everywhere, needs nothing, and catches the two failures
 *      the task names (a missing comma reads as a column definition with a
 *      stray trailing name; a bad type reads as an unknown type).
 */

import { describe, expect, it } from 'bun:test'
import { MIGRATION_SQL } from '../../src/lib/db/pg-migrate'
import {
  describeStatement,
  factsFor,
  type StatementFacts,
} from './pg-migrate-sql-facts'
import { parseStatements } from './pg-migrate-sql-parser'

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
