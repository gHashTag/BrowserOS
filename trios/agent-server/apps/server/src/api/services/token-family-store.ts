/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Persistent store for local-auth token families.
 *
 * Token families are durable across BrowserOS server restarts using SQLite
 * (bun:sqlite). Only SHA-256 hashes of tokens are stored; raw token values are
 * never persisted. Refresh-token rotation is performed inside an immediate
 * transaction so concurrent /auth/refresh requests cannot both win.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TokenFamily, TokenFamilyStatus } from './local-auth-service'

export interface FamilyAuditEvent {
  eventType: 'created' | 'rotated' | 'revoked' | 'revoked-all'
  familyId?: string
  refreshHash?: string
  timestamp: Date
  socketAddress?: string
}

export interface AuthAuditEvent {
  eventType:
    | 'local-token-issued'
    | 'refresh-attempt'
    | 'refresh-success'
    | 'refresh-revoked'
    | 'refresh-not-found'
    | 'rate-limited'
  familyId?: string
  refreshHash?: string
  socketAddress?: string
  timestamp: Date
  details?: string
}

export interface RateLimitResult {
  allowed: boolean
  retryAfterMs: number
}

export interface CleanupResult {
  familiesDeleted: number
  auditRowsDeleted: number
  rateLimitRowsDeleted: number
}

export interface ListFamiliesOptions {
  status?: TokenFamilyStatus
  limit?: number
  offset?: number
}

export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('Rate limit exceeded')
    this.name = 'RateLimitError'
  }
}

export interface TokenFamilyStore {
  createFamily(family: TokenFamily): void
  findFamilyById(familyId: string): TokenFamily | null
  getActiveFamily(): TokenFamily | null
  setActiveFamily(familyId: string | null): void
  /**
   * Atomically rotate a refresh token into a new access/refresh pair.
   * Returns:
   *   - 'rotated' if the refresh hash matched the current hash and the family was updated.
   *   - 'revoked' if the hash belonged to a revoked family or a rotated hash (reuse).
   *   - 'not-found' if no family matched the hash.
   */
  rotateRefreshToken(
    refreshHash: string,
    newAccessTokenHash: string,
    newRefreshTokenHash: string,
    issuedAt: Date,
    expiresAt: Date,
  ): 'rotated' | 'revoked' | 'not-found'
  revokeFamily(familyId: string): void
  revokeAllFamilies(): void
  listFamilies(options?: ListFamiliesOptions): TokenFamily[]
  cleanup(options: {
    familyRetentionMs: number
    auditRetentionMs: number
    rateLimitRetentionMs: number
    nowMs?: number
  }): CleanupResult
  appendAudit(event: FamilyAuditEvent): void
  recordAuthAudit(event: AuthAuditEvent): void
  checkRateLimit(
    key: string,
    windowMs: number,
    maxAttempts: number,
  ): RateLimitResult
  close(): void
}

export interface SqliteTokenFamilyStoreOptions {
  /** SQLite database path. Defaults to a file under the project trios state dir. */
  dbPath?: string
}

const DEFAULT_DB_PATH = ((): string => {
  // Persist token families alongside the rest of the trios state. The default
  // resolves to the current working directory's .trinity/state directory, which
  // is the server's execution directory in production (i.e. the trios repo root).
  return join(process.cwd(), '.trinity', 'state', 'local-auth.sqlite')
})()

function statusFromDb(value: string): TokenFamilyStatus {
  if (value === 'active' || value === 'rotated' || value === 'revoked') {
    return value
  }
  return 'revoked'
}

function familyFromRow(row: Record<string, unknown>): TokenFamily {
  let rotatedHashes: string[] = []
  const rotatedRaw = row.rotated_refresh_hashes
  if (typeof rotatedRaw === 'string' && rotatedRaw.length > 0) {
    try {
      rotatedHashes = JSON.parse(rotatedRaw)
      if (!Array.isArray(rotatedHashes)) rotatedHashes = []
    } catch {
      rotatedHashes = []
    }
  }
  return {
    familyId: String(row.family_id),
    status: statusFromDb(String(row.status)),
    accessTokenHash: String(row.access_token_hash),
    refreshTokenHash: String(row.refresh_token_hash),
    rotatedRefreshHashes: rotatedHashes,
    createdAt: new Date(Number(row.created_at)),
    rotatedAt: row.rotated_at == null ? null : new Date(Number(row.rotated_at)),
    accessTokenIssuedAt: new Date(Number(row.access_token_issued_at)),
    accessTokenExpiresAt: new Date(Number(row.access_token_expires_at)),
  }
}

export class SqliteTokenFamilyStore implements TokenFamilyStore {
  private readonly db: Database
  private readonly path: string

  constructor(options: SqliteTokenFamilyStoreOptions = {}) {
    this.path = options.dbPath ?? DEFAULT_DB_PATH
    if (this.path !== ':memory:') {
      const dir = dirname(this.path)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
    }
    this.db = new Database(this.path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.createTables()
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_auth_families (
        family_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        access_token_hash TEXT NOT NULL,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        rotated_refresh_hashes TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        rotated_at INTEGER,
        access_token_issued_at INTEGER NOT NULL,
        access_token_expires_at INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_local_auth_families_active
      ON local_auth_families(is_active)
      WHERE is_active = 1
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_auth_family_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        family_id TEXT,
        refresh_hash TEXT,
        timestamp INTEGER NOT NULL,
        socket_address TEXT
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_auth_rate_limits (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        attempts INTEGER NOT NULL
      )
    `)
  }

  private familyToParams(family: TokenFamily): SQLQueryBindings[] {
    return [
      family.familyId,
      family.status,
      family.accessTokenHash,
      family.refreshTokenHash,
      JSON.stringify(family.rotatedRefreshHashes),
      family.createdAt.getTime(),
      family.rotatedAt?.getTime() ?? null,
      family.accessTokenIssuedAt.getTime(),
      family.accessTokenExpiresAt.getTime(),
    ]
  }

  createFamily(family: TokenFamily): void {
    const stmt = this.db.prepare(`
      INSERT INTO local_auth_families (
        family_id, status, access_token_hash, refresh_token_hash,
        rotated_refresh_hashes, created_at, rotated_at,
        access_token_issued_at, access_token_expires_at, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `)
    stmt.run(...this.familyToParams(family))
    stmt.finalize()
  }

  findFamilyById(familyId: string): TokenFamily | null {
    const stmt = this.db.prepare(`
      SELECT * FROM local_auth_families WHERE family_id = ?
    `)
    const row = stmt.get(familyId) as Record<string, unknown> | undefined
    stmt.finalize()
    return row ? familyFromRow(row) : null
  }

  getActiveFamily(): TokenFamily | null {
    const stmt = this.db.prepare(`
      SELECT * FROM local_auth_families WHERE is_active = 1 LIMIT 1
    `)
    const row = stmt.get() as Record<string, unknown> | undefined
    stmt.finalize()
    return row ? familyFromRow(row) : null
  }

  setActiveFamily(familyId: string | null): void {
    const clear = this.db.prepare(
      'UPDATE local_auth_families SET is_active = 0 WHERE is_active = 1',
    )
    clear.run()
    clear.finalize()
    if (familyId) {
      const set = this.db.prepare(
        'UPDATE local_auth_families SET is_active = 1 WHERE family_id = ?',
      )
      set.run(familyId)
      set.finalize()
    }
  }

  rotateRefreshToken(
    refreshHash: string,
    newAccessTokenHash: string,
    newRefreshTokenHash: string,
    issuedAt: Date,
    expiresAt: Date,
  ): 'rotated' | 'revoked' | 'not-found' {
    const now = Date.now()
    const tx = this.db.transaction(() => {
      // First: does this hash belong to an active/rotated family as the current refresh token?
      const currentStmt = this.db.prepare(`
        SELECT * FROM local_auth_families
        WHERE refresh_token_hash = ? AND status IN ('active', 'rotated')
      `)
      const currentRow = currentStmt.get(refreshHash) as
        | Record<string, unknown>
        | undefined
      currentStmt.finalize()

      if (currentRow) {
        const family = familyFromRow(currentRow)
        const oldRefreshHash = family.refreshTokenHash
        const rotatedHashes = [...family.rotatedRefreshHashes, oldRefreshHash]
        const update = this.db.prepare(`
          UPDATE local_auth_families
          SET status = 'rotated',
              access_token_hash = ?,
              refresh_token_hash = ?,
              rotated_refresh_hashes = ?,
              rotated_at = ?,
              access_token_issued_at = ?,
              access_token_expires_at = ?
          WHERE family_id = ? AND refresh_token_hash = ?
        `)
        update.run(
          newAccessTokenHash,
          newRefreshTokenHash,
          JSON.stringify(rotatedHashes),
          now,
          issuedAt.getTime(),
          expiresAt.getTime(),
          family.familyId,
          refreshHash,
        )
        const changed = this.db.query('SELECT changes()').get() as {
          'changes()': number
        }
        update.finalize()
        if (changed['changes()'] === 0) {
          // Another transaction won the race; treat as reuse.
          return 'revoked'
        }
        return 'rotated'
      }

      // Second: does this hash belong to a rotated or revoked family (reuse)?
      const allStmt = this.db.prepare(`
        SELECT * FROM local_auth_families
        WHERE status IN ('rotated', 'revoked')
      `)
      const rows = allStmt.all() as Record<string, unknown>[]
      allStmt.finalize()
      for (const row of rows) {
        const family = familyFromRow(row)
        const isCurrent = family.refreshTokenHash === refreshHash
        const isRotated = family.rotatedRefreshHashes.includes(refreshHash)
        if (isCurrent || isRotated) {
          const revoke = this.db.prepare(
            "UPDATE local_auth_families SET status = 'revoked', is_active = 0 WHERE family_id = ?",
          )
          revoke.run(family.familyId)
          revoke.finalize()
          return 'revoked'
        }
      }

      return 'not-found'
    })
    return tx()
  }

  revokeFamily(familyId: string): void {
    const stmt = this.db.prepare(
      "UPDATE local_auth_families SET status = 'revoked', is_active = 0 WHERE family_id = ?",
    )
    stmt.run(familyId)
    stmt.finalize()
  }

  revokeAllFamilies(): void {
    const stmt = this.db.prepare(
      "UPDATE local_auth_families SET status = 'revoked', is_active = 0 WHERE status != 'revoked'",
    )
    stmt.run()
    stmt.finalize()
  }

  listFamilies(options: ListFamiliesOptions = {}): TokenFamily[] {
    const limit = Math.max(1, Math.min(100, options.limit ?? 50))
    const offset = Math.max(0, options.offset ?? 0)
    if (options.status) {
      const stmt = this.db.prepare(`
        SELECT * FROM local_auth_families
        WHERE status = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `)
      const rows = stmt.all(options.status, limit, offset) as Record<
        string,
        unknown
      >[]
      stmt.finalize()
      return rows.map(familyFromRow)
    }
    const stmt = this.db.prepare(`
      SELECT * FROM local_auth_families
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
    const rows = stmt.all(limit, offset) as Record<string, unknown>[]
    stmt.finalize()
    return rows.map(familyFromRow)
  }

  cleanup(options: {
    familyRetentionMs: number
    auditRetentionMs: number
    rateLimitRetentionMs: number
    nowMs?: number
  }): CleanupResult {
    const now = options.nowMs ?? Date.now()
    const tx = this.db.transaction(() => {
      // Delete revoked families whose rotated_at (or created_at if never rotated)
      // is older than the retention window.
      const familyStmt = this.db.prepare(`
        DELETE FROM local_auth_families
        WHERE status = 'revoked'
          AND COALESCE(rotated_at, created_at) < ?
      `)
      familyStmt.run(now - options.familyRetentionMs)
      const familiesDeleted = this.db.query('SELECT changes()').get() as {
        'changes()': number
      }
      familyStmt.finalize()

      // Delete audit rows older than the retention window.
      const auditStmt = this.db.prepare(`
        DELETE FROM local_auth_family_audit
        WHERE timestamp < ?
      `)
      auditStmt.run(now - options.auditRetentionMs)
      const auditRowsDeleted = this.db.query('SELECT changes()').get() as {
        'changes()': number
      }
      auditStmt.finalize()

      // Delete stale rate-limit buckets.
      const rateLimitStmt = this.db.prepare(`
        DELETE FROM local_auth_rate_limits
        WHERE window_start < ?
      `)
      rateLimitStmt.run(now - options.rateLimitRetentionMs)
      const rateLimitRowsDeleted = this.db.query('SELECT changes()').get() as {
        'changes()': number
      }
      rateLimitStmt.finalize()

      return {
        familiesDeleted: familiesDeleted['changes()'],
        auditRowsDeleted: auditRowsDeleted['changes()'],
        rateLimitRowsDeleted: rateLimitRowsDeleted['changes()'],
      }
    })
    return tx()
  }

  appendAudit(event: FamilyAuditEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO local_auth_family_audit
      (event_type, family_id, refresh_hash, timestamp, socket_address)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run(
      event.eventType,
      event.familyId ?? null,
      event.refreshHash ?? null,
      event.timestamp.getTime(),
      event.socketAddress ?? null,
    )
    stmt.finalize()
  }

  recordAuthAudit(event: AuthAuditEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO local_auth_family_audit
      (event_type, family_id, refresh_hash, timestamp, socket_address)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run(
      event.eventType,
      event.familyId ?? null,
      event.refreshHash ?? null,
      event.timestamp.getTime(),
      event.socketAddress ?? null,
    )
    stmt.finalize()
  }

  checkRateLimit(
    key: string,
    windowMs: number,
    maxAttempts: number,
  ): RateLimitResult {
    const now = Date.now()
    const tx = this.db.transaction(() => {
      const select = this.db.prepare(
        'SELECT window_start, attempts FROM local_auth_rate_limits WHERE key = ?',
      )
      const row = select.get(key) as
        | { window_start: number; attempts: number }
        | undefined
      select.finalize()

      if (!row || now > row.window_start + windowMs) {
        const insert = this.db.prepare(
          `INSERT INTO local_auth_rate_limits (key, window_start, attempts)
           VALUES (?, ?, 1)
           ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start, attempts=1`,
        )
        insert.run(key, now)
        insert.finalize()
        return { allowed: true, retryAfterMs: 0 }
      }

      const nextAttempts = row.attempts + 1
      const update = this.db.prepare(
        'UPDATE local_auth_rate_limits SET attempts = ? WHERE key = ?',
      )
      update.run(nextAttempts, key)
      update.finalize()

      const retryAfterMs = Math.max(0, row.window_start + windowMs - now)
      return { allowed: nextAttempts <= maxAttempts, retryAfterMs }
    })
    return tx()
  }

  close(): void {
    this.db.close()
  }
}
