/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Database as BunDatabase } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from './schema'

export type BrowserOsDatabase = BunSQLiteDatabase<typeof schema>

export interface DbHandle {
  path: string
  migrationsDir: string
  sqlite: BunDatabase
  db: BrowserOsDatabase
}

export interface OpenDbOptions {
  dbPath: string
  resourcesDir?: string
  migrationsDir?: string
  runMigrations?: boolean
}

const sourceMigrationsDir = fileURLToPath(
  new URL('./migrations', import.meta.url),
)

/** Opens BrowserOS SQLite and applies checked-in Drizzle migrations before callers use the DB. */
export function openBrowserOsDatabase(options: OpenDbOptions): DbHandle {
  const migrationsDir = resolveMigrationsDir(options)
  mkdirSync(dirname(options.dbPath), { recursive: true })

  const sqlite = new BunDatabase(options.dbPath)
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA foreign_keys = ON')

  const db = drizzle(sqlite, { schema })
  if (options.runMigrations !== false) {
    migrate(db, { migrationsFolder: migrationsDir })
  }

  return {
    path: options.dbPath,
    migrationsDir,
    sqlite,
    db,
  }
}

/** Resolves migrations from explicit test paths, packaged resources, or the source tree. */
export function resolveMigrationsDir(
  options: Pick<OpenDbOptions, 'migrationsDir' | 'resourcesDir'> = {},
): string {
  if (options.migrationsDir) {
    if (existsSync(options.migrationsDir)) return options.migrationsDir
    throw new Error(
      `Drizzle migrations directory not found. Checked: ${options.migrationsDir}`,
    )
  }

  const candidates = [
    options.resourcesDir
      ? join(options.resourcesDir, 'db', 'migrations')
      : null,
    sourceMigrationsDir,
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error(
    `Drizzle migrations directory not found. Checked: ${candidates.join(', ')}`,
  )
}
