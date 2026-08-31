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

-- The open issues as GitHub last showed them, so a board can be drawn without
-- spending the anonymous rate limit (60/hour) on every page load. The tick
-- already fetches this list each round; storing it costs nothing and turns a
-- transient read into something a dashboard can render.
-- What the bee actually said, kept so a person can watch.
--
-- The turn already streams through /chat and the container was reading those
-- bytes and throwing them away: drain() destructured only the done flag from
-- the reader and never touched the value. So there was nothing to click on -
-- the work happened, and the only trace was a commit at the end.
--
-- Coalesced rather than one row per token: a turn emits thousands of text
-- deltas and a row each would make the table the expensive part of watching.
--
-- NO BACKTICKS IN THIS STRING. The warning is already written further down
-- this same file and I broke it twice in thirty minutes anyway - once quoting
-- a function name, and once inside the sentence telling myself not to. A
-- backtick ends the template literal and the SQL after it becomes code. The
-- rule is now enforced by make ts-template-backticks instead of by memory,
-- because two violations of a comment by the person who wrote it is the
-- clearest evidence there is that a comment was the wrong instrument.
CREATE TABLE IF NOT EXISTS queen_transcript (
  conversation_id text NOT NULL,
  seq int NOT NULL,
  issue int,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  text text NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_queen_transcript_issue
  ON queen_transcript (issue, at DESC);

CREATE TABLE IF NOT EXISTS queen_issues (
  number int PRIMARY KEY,
  title text NOT NULL,
  state text NOT NULL,
  owned_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  seen_at timestamptz NOT NULL DEFAULT now()
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

-- Whether an issue is a specification, judged by the Queen's own rule and
-- stored so a board can say WHAT each one is missing instead of only that it
-- was skipped. Measured the day this landed: 0 of 40 open issues passed, and
-- requirements were missing from all 40.
ALTER TABLE queen_issues
  ADD COLUMN IF NOT EXISTS is_spec boolean NOT NULL DEFAULT false;
ALTER TABLE queen_issues
  ADD COLUMN IF NOT EXISTS delegatable boolean NOT NULL DEFAULT false;
ALTER TABLE queen_issues
  ADD COLUMN IF NOT EXISTS missing jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The Queen's own verdict on a finished turn. She works autonomously and is
-- told afterwards, so a finished turn cannot wait for a person: only an
-- escalation reaches one. Without this the hold that stopped the six-times
-- loop would have become a different starvation - every issue she finished
-- locked out of the pool for ever.
ALTER TABLE queen_dispatch ADD COLUMN IF NOT EXISTS review_state text;
ALTER TABLE queen_dispatch ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE queen_dispatch ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

-- What she did, in her own words, once per round.
--
-- The operator gives direction and is told afterwards. That obligation needs a
-- place to live: a log line is not a report, because reading it means knowing
-- which lines matter. One row per round, written whether the round did
-- anything or not - a round that found nothing to do is the most important
-- thing to say when somebody asks why nothing happened.
CREATE TABLE IF NOT EXISTS queen_report (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  headline text NOT NULL,
  body text NOT NULL,
  needs_you boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_queen_report_at ON queen_report (at DESC);

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
