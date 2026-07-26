-- Base schema for BrowserOS chat history (PostgreSQL).
-- Must run before migrate-chat-schema.ts because that migration assumes these
-- tables already exist.

CREATE TABLE IF NOT EXISTS conversations (
  "rowId" TEXT PRIMARY KEY,
  "profileId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lastMessagedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "title" TEXT,
  "metadata" JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_conversations_profile_id ON conversations("profileId");
CREATE INDEX IF NOT EXISTS idx_conversations_last_messaged_at ON conversations("lastMessagedAt" DESC);

CREATE TABLE IF NOT EXISTS "conversationMessages" (
  "rowId" TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "orderIndex" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "metadata" JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_id ON "conversationMessages"("conversationId");
CREATE INDEX IF NOT EXISTS idx_conversation_messages_order_index ON "conversationMessages"("conversationId", "orderIndex");
CREATE INDEX IF NOT EXISTS idx_conversation_messages_created_at ON "conversationMessages"("createdAt" DESC);

COMMENT ON TABLE conversations IS 'BrowserOS conversation history header rows';
COMMENT ON TABLE "conversationMessages" IS 'BrowserOS conversation message rows';
