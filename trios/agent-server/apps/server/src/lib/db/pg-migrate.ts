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

-- A mirror of the Queen's delegation registry, not its source of truth.
--
-- The registry is a JSON file on the operator's Mac and stays that way: it is
-- the record of every task the swarm has done, and moving it wholesale is a
-- migration, not a mirror. What a cloud-resident tick needs first is to SEE
-- it, and a write-through copy gives that without putting the record at risk -
-- if this write fails the file is untouched and the Queen carries on.
--
-- One row, replaced whole. The registry is read and written as a unit by the
-- app, and a schema that decomposed it here would be a second model of the
-- same thing, free to disagree with the first.
CREATE TABLE IF NOT EXISTS queen_registry (
  variant text PRIMARY KEY,
  tasks jsonb NOT NULL,
  task_count int NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS queen_lease (
  name text PRIMARY KEY,
  holder text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Monotonic term counter. Never reset, not even on release: a stale writer
  -- from term 5 must lose to term 6, and a counter that restarts at 1 makes it
  -- win instead.
  fence bigint NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS queen_dispatch (
  issue int PRIMARY KEY,
  branch text NOT NULL,
  started boolean NOT NULL,
  detail text NOT NULL,
  conversation_id text,
  -- The boundary the bee was given. Without it the container's own in-flight
  -- work cannot hold a path against the next round, and a task that holds
  -- nothing is a task the boundary system cannot see.
  owned_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  dispatched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS queen_tick (
  name text PRIMARY KEY,
  holder text NOT NULL,
  fence bigint NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  decision jsonb NOT NULL
);

ALTER TABLE queen_dispatch
  ADD COLUMN IF NOT EXISTS owned_paths jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A dispatch that cannot END is a boundary nobody can ever release. That is
-- the defect this repository already carries in awaitingReview: a state that
-- is not terminal, held by a task nobody is looking at, blocking every issue
-- that overlaps its paths. #1286 held one for five days.
--
-- No backticks in this string, ever. It is a JS template literal, so a
-- backtick in a SQL COMMENT ends the literal. That is how a note about a stuck
-- boundary became ReferenceError: awaitingReview is not defined and took the
-- whole server to 502 on deploy. Prose punctuation in here is code.
ALTER TABLE queen_dispatch
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;
ALTER TABLE queen_dispatch
  ADD COLUMN IF NOT EXISTS outcome text;
-- Which provider key carried this bee. Stored so a retry returns to the same
-- one and a key that keeps failing is visible as a key rather than as several
-- unlucky tasks.
ALTER TABLE queen_dispatch
  ADD COLUMN IF NOT EXISTS key_index int;

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
