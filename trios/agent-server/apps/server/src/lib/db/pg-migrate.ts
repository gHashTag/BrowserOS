/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Best-effort PostgreSQL migrations for chat/task tables used by
 * ChatHistoryService and TaskQueueService.
 */

import { Pool } from 'pg'
import { logger } from '../logger'

function getDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || undefined
}

function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('neon.tech')
      ? { rejectUnauthorized: false }
      : undefined,
  })
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS agent_tasks (
  id uuid PRIMARY KEY,
  agent_id text NOT NULL,
  task_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  retry_count int NOT NULL DEFAULT 0,
  max_retries int NOT NULL DEFAULT 3,
  assigned_by text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  result jsonb
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_status_priority_created
  ON agent_tasks (agent_id, status, priority DESC, created_at ASC);

ALTER TABLE agent_tasks
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_owner text;

CREATE INDEX IF NOT EXISTS idx_agent_tasks_lease_expires_at
  ON agent_tasks (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversations (
  "rowId" text PRIMARY KEY,
  "profileId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "lastMessagedAt" timestamptz NOT NULL DEFAULT now(),
  title text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_conversations_profile_lastmessaged
  ON conversations ("profileId", "lastMessagedAt" DESC);

CREATE TABLE IF NOT EXISTS "conversationMessages" (
  "rowId" text PRIMARY KEY,
  "conversationId" text NOT NULL REFERENCES conversations("rowId") ON DELETE CASCADE,
  message text NOT NULL,
  role text NOT NULL,
  "orderIndex" int NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_order
  ON "conversationMessages" ("conversationId", "orderIndex");
`

export async function runPgMigrations(): Promise<void> {
  const databaseUrl = getDatabaseUrl()
  if (!databaseUrl) {
    logger.warn(
      'PostgreSQL migrations skipped: DATABASE_URL and RAILWAY_SSOT_URL are unset',
    )
    return
  }

  const pool = createPool(databaseUrl)
  try {
    await pool.query(MIGRATION_SQL)
    logger.info('PostgreSQL migrations completed successfully')
  } catch (error) {
    logger.error('PostgreSQL migrations failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await pool.end()
  }
}
