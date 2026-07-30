/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * PostgreSQL Agent Store — persistent A2A agent registry backend.
 */

import { Pool, type QueryResult, type QueryResultRow } from 'pg'
import { logger } from '../../../lib/logger'
import type { A2aAgentCard } from './a2a-registry-service'

export interface AgentRow {
  id: string
  name: string
  capabilities: string[]
  last_heartbeat: Date
  status: string
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

export class PgAgentStore {
  private pool: Pool | null = null

  constructor(private dsn: string) {}

  async connect(): Promise<void> {
    if (this.pool) return
    this.pool = new Pool({
      connectionString: this.dsn,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
    this.pool.on('error', (err) => {
      logger.warn('PgAgentStore pool client error', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
    logger.info('PgAgentStore pool connected')
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => {})
      this.pool = null
    }
  }

  async ensureSchema(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        capabilities TEXT[] DEFAULT '{}',
        last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
        status TEXT DEFAULT 'online',
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await this.query(`
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status)
    `)
    await this.query(`
      CREATE OR REPLACE VIEW agent_matrix AS
      SELECT
        id,
        name,
        capabilities,
        last_heartbeat,
        status,
        metadata,
        created_at,
        updated_at,
        EXTRACT(EPOCH FROM (NOW() - last_heartbeat))::INT AS seconds_since_heartbeat
      FROM agents
      ORDER BY updated_at DESC
    `)
    logger.info('PgAgentStore schema ensured')
  }

  async upsertAgent(card: A2aAgentCard, status = 'online'): Promise<void> {
    await this.query(
      `
      INSERT INTO agents (id, name, capabilities, status, metadata, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        capabilities = EXCLUDED.capabilities,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata || agents.metadata,
        updated_at = NOW()
      `,
      [
        card.id,
        card.name,
        card.capabilities,
        status,
        JSON.stringify({
          description: card.description,
          version: card.version,
          endpoint: card.endpoint,
        }),
      ],
    )
  }

  async heartbeat(agentId: string): Promise<boolean> {
    const rowCount = await this.exec(
      `UPDATE agents SET last_heartbeat = NOW(), status = 'online' WHERE id = $1`,
      [agentId],
    )
    return rowCount > 0
  }

  async markOffline(agentId: string): Promise<void> {
    await this.exec(
      `UPDATE agents SET status = 'offline', updated_at = NOW() WHERE id = $1`,
      [agentId],
    )
  }

  async removeAgent(agentId: string): Promise<void> {
    await this.exec(`DELETE FROM agents WHERE id = $1`, [agentId])
  }

  async listAgents(onlyOnline = true): Promise<A2aAgentCard[]> {
    const where = onlyOnline ? "WHERE status = 'online'" : ''
    const rows = await this.query<AgentRow>(
      `SELECT id, name, capabilities, status, metadata FROM agents ${where} ORDER BY updated_at DESC`,
    )
    return (rows ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      capabilities: r.capabilities,
      description: (r.metadata?.description as string) ?? '',
      version: (r.metadata?.version as string) ?? '',
      endpoint: (r.metadata?.endpoint as string) ?? undefined,
    }))
  }

  async listMatrix(): Promise<AgentRow[]> {
    const rows = await this.query<AgentRow>(`SELECT * FROM agent_matrix`)
    return rows ?? []
  }

  async pruneOffline(thresholdSeconds = 90): Promise<string[]> {
    const rows = await this.query<{ id: string }>(
      `UPDATE agents SET status = 'offline', updated_at = NOW()
       WHERE status = 'online' AND last_heartbeat < NOW() - INTERVAL '${thresholdSeconds.toString()} seconds'
       RETURNING id`,
    )
    // Note: thresholdSeconds is controlled internally (default 90). If exposed externally,
    // switch to parameterized query to avoid SQL injection.
    return (rows ?? []).map((r) => r.id)
  }

  private isRetryableDbError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err)
    return /connection terminated|connection refused|timeout|ECONNRESET|ETIMEDOUT|socket/i.test(
      message,
    )
  }

  private async queryWithRetry<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    if (!this.pool) throw new Error('PgAgentStore not connected')
    let lastError: unknown
    const attempts = 3
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.pool.query<T>(sql, params)
      } catch (err) {
        lastError = err
        if (!this.isRetryableDbError(err) || attempt === attempts - 1) {
          break
        }
        logger.warn('PgAgentStore query failed, retrying', {
          attempt: attempt + 1,
          error: err instanceof Error ? err.message : String(err),
        })
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
      }
    }
    throw lastError
  }

  private async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const result = await this.queryWithRetry<T>(sql, params)
    return result.rows as T[]
  }

  private async exec(sql: string, params?: unknown[]): Promise<number> {
    const result = await this.queryWithRetry(sql, params)
    return result.rowCount ?? 0
  }
}
