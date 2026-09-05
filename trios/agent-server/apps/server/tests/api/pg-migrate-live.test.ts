/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The second of the two gates for MIGRATION_SQL - the LIVE one. The first,
 * PARSE, is pg-migrate.test.ts; the helpers both files lean on are
 * pg-migrate-sql-parser.ts and pg-migrate-sql-facts.ts.
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
import { factsFor } from './pg-migrate-sql-facts'

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

    // A MOCKED `pg` LOOKS EXACTLY LIKE A BROKEN MIGRATION, AND SAID SO FOR DAYS.
    //
    // `mock.module` is process-global and bun evaluates every test file's module
    // scope in one run. `queen-roadmap.test.ts` and `task-queue-service.test.ts`
    // both install `mock.module('pg', ...)` with a FakePool, so THIS file's
    // `import { Pool } from 'pg'` can bind to that fake - the migration then
    // goes nowhere, the catalog query returns nothing, and the first assertion
    // below reads `Received: undefined`, which is indistinguishable from
    // MIGRATION_SQL being wrong.
    //
    // Measured 2026-09-06: this file passes alone (3 pass) and fails beside
    // either of those two, IDENTICALLY whether it runs before or after them -
    // which is what says the cause is module scope rather than order. Their
    // `afterAll` re-mocks with the real namespace and it does not help; a
    // binding already made is not revisited. Two of the nine red assertions on
    // the branch were this.
    //
    // So the empty catalog is named for what it is. A gate that dies on
    // `undefined` sends its reader to the migration; this one sends them here.
    if (columns.length === 0) {
      throw new Error(
        [
          'The catalog is EMPTY after two migration runs against a database this',
          'test reached successfully, which almost always means `pg` is mocked in',
          'this process rather than that MIGRATION_SQL is wrong.',
          '',
          '  `mock.module` is process-global in bun and is not undone by a later',
          '  re-mock; `queen-roadmap.test.ts` and `task-queue-service.test.ts`',
          '  both install a FakePool at module scope.',
          '',
          '  This file passes when run on its own. Run it in its own bun process',
          '  to check the migration; do not read this as a broken migration.',
        ].join('\n'),
      )
    }

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
