/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { Database } from 'bun:sqlite'

const IDENTITY_TABLE = `
CREATE TABLE IF NOT EXISTS identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  trios_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`

const OAUTH_TOKENS_TABLE = `
CREATE TABLE IF NOT EXISTS oauth_tokens (
  trios_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  email TEXT,
  account_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trios_id, provider)
)`

export function initSchema(db: Database): void {
  db.exec(IDENTITY_TABLE)
  db.exec(OAUTH_TOKENS_TABLE)
}
