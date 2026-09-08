/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Contract suite for the PostgreSQL agent store.
 *
 * Export inventory of src/api/services/a2a/pg-agent-store.ts, and what this
 * suite does with each:
 *
 *   - PgAgentStore (the only runtime export): exercised throughout, one
 *     describe per public method, so a reader can map assertions to the
 *     export's surface.
 *   - AgentRow is a type-only export, erased at runtime. It is exercised as
 *     the shape listAgents reads from the database and listMatrix hands back.
 *
 *   Exports not exercised: none. Nothing here needed a live Postgres: the one
 *   external dependency, pg's Pool, is faked at the module boundary.
 *
 * The fake is a small Postgres, not a string matcher. It holds an agents
 * table behind a clock the tests can advance, and speaks just enough of the
 * dialect this store uses - one INSERT ... ON CONFLICT, three UPDATEs, one
 * DELETE, two SELECTs, three DDL statements - to give each statement its
 * meaning: which rows a WHERE admits, what ON CONFLICT merges, who RETURNING
 * reports. Assertions are therefore about outcomes - which agents are
 * visible, who got pruned, which errors surface - never about the SQL text
 * itself: a query string can be right while its semantics are wrong, which
 * is the failure mode that matters (the same stance tests/api/queen-lease.test.ts
 * takes and explains). A statement outside the store's current vocabulary is
 * refused loudly rather than answered wrongly, so a change to the queries
 * fails here for a human to look at instead of passing against a guess.
 *
 * The mocks are registered before the subject is imported and restored after
 * this file's tests: bun's mock.restore() does not undo mock.module, and a
 * 'pg' mock left in place has broken sibling files in full-suite runs before
 * (see tests/api/routes/queen-lease.test.ts).
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { A2aAgentCard } from '../../src/api/services/a2a/a2a-registry-service'
import type { PgAgentStore as PgAgentStoreInstance } from '../../src/api/services/a2a/pg-agent-store'

const DSN = 'postgres://registry:none@db.internal:5432/agents'
const BASE = new Date('2026-09-05T12:00:00.000Z')

// Captured before anything is mocked, as plain-object copies: bun 1.3 hands
// `import()` back a LIVE namespace that mock.module overwrites in place, so
// restoring "from the namespace" would reinstall the mock onto itself and
// leave every later file in the run holding a fake (see queen-roadmap tests).
const realPg = { ...(await import('pg')) } as typeof import('pg')
const realLogger = {
  ...(await import('../../src/lib/logger')),
} as typeof import('../../src/lib/logger')

/** One row of the agents table, as the fake Postgres keeps it. */
interface StoredAgent {
  id: string
  name: string
  capabilities: string[]
  status: string
  metadata: Record<string, unknown>
  last_heartbeat: Date
  created_at: Date
  updated_at: Date
}

/** What pg hands back: enough of the real QueryResult for this store. */
interface QueryResponse {
  rows: unknown[]
  rowCount: number
}

/** Every pool the store has constructed, in order. */
let pools: FakePool[] = []

/** Every statement any pool was handed, in order, failed attempts included. */
let statements: Array<{ sql: string; values?: unknown[] }> = []

/** The one database every pool in a test talks to, with Postgres's NOW(). */
let database: {
  now: Date
  agents: StoredAgent[]
  tables: Set<string>
  views: Set<string>
  failures: Array<Error>
}

/**
 * A stand-in for pg.Pool that executes SQL the way Postgres would.
 *
 * Constructor options are kept (which database), `end` calls are counted
 * (disconnect must end the pool), 'error' listeners are collected (an
 * idle-client failure must be absorbed), and every query is logged and
 * executed against the table above - an Error in `failures` is what the
 * database failing looks like to the caller.
 */
class FakePool {
  readonly options: unknown
  endCalls = 0
  readonly errorListeners: Array<(err: unknown) => void> = []

  constructor(options: unknown) {
    this.options = options
    pools.push(this)
  }

  on(event: string, listener: (err: unknown) => void): this {
    if (event === 'error') this.errorListeners.push(listener)
    return this
  }

  async end(): Promise<void> {
    this.endCalls++
  }

  query(text: unknown, values?: unknown[]): Promise<QueryResponse> {
    const sql = String(text).trim()
    statements.push({ sql, values })
    const failure = database.failures.shift()
    if (failure) return Promise.reject(failure)
    return Promise.resolve(execute(sql, values))
  }
}

/** Postgres's answer to reading a relation that was never created. */
function requireRelation(name: string): void {
  if (!database.tables.has(name) && !database.views.has(name)) {
    throw new Error(`relation "${name}" does not exist`)
  }
}

/** The rows of the agents table, most recently updated first. */
function agentsByRecency(): StoredAgent[] {
  return [...database.agents].sort(
    (a, b) => b.updated_at.getTime() - a.updated_at.getTime(),
  )
}

/** Execute one statement the way Postgres would. Throws what Postgres would. */
function execute(sql: string, values: unknown[] = []): QueryResponse {
  // DDL: the relations only exist once the store has ensured its schema,
  // which is what makes a pre-schema read fail the way it would on a real
  // server (and what makes ensureSchema observable at all).
  if (sql.startsWith('CREATE TABLE IF NOT EXISTS agents')) {
    database.tables.add('agents')
    return { rows: [], rowCount: 0 }
  }
  if (sql.startsWith('CREATE INDEX')) {
    return { rows: [], rowCount: 0 }
  }
  if (sql.startsWith('CREATE OR REPLACE VIEW agent_matrix')) {
    database.views.add('agent_matrix')
    return { rows: [], rowCount: 0 }
  }

  if (sql.startsWith('INSERT INTO agents')) {
    const [id, name, capabilities, status, metadataJson] = values as [
      string,
      string,
      string[],
      string,
      string,
    ]
    const incoming = JSON.parse(metadataJson) as Record<string, unknown>
    const existing = database.agents.find((a) => a.id === id)
    if (existing) {
      // ON CONFLICT: the new card wins on the columns it sets, metadata is
      // the JSONB merge (old keys kept where the new document omits them).
      existing.name = name
      existing.capabilities = capabilities
      existing.status = status
      existing.metadata = { ...existing.metadata, ...incoming }
      existing.updated_at = database.now
    } else {
      database.agents.push({
        id,
        name,
        capabilities,
        status,
        metadata: incoming,
        last_heartbeat: database.now,
        created_at: database.now,
        updated_at: database.now,
      })
    }
    return { rows: [], rowCount: 1 }
  }

  if (sql.startsWith('UPDATE agents SET last_heartbeat')) {
    const agent = database.agents.find((a) => a.id === values[0])
    if (!agent) return { rows: [], rowCount: 0 }
    agent.status = 'online'
    agent.last_heartbeat = database.now
    return { rows: [], rowCount: 1 }
  }

  // The prune is the only UPDATE ... RETURNING the store issues.
  if (
    sql.startsWith("UPDATE agents SET status = 'offline'") &&
    sql.includes('RETURNING id')
  ) {
    const thresholdSeconds = Number(/INTERVAL '(\d+) seconds'/.exec(sql)?.[1])
    if (!Number.isFinite(thresholdSeconds)) {
      throw new Error('fake Postgres could not read the prune interval')
    }
    const staleMillis = thresholdSeconds * 1000
    const stale = database.agents.filter(
      (a) =>
        a.status === 'online' &&
        database.now.getTime() - a.last_heartbeat.getTime() > staleMillis,
    )
    for (const agent of stale) {
      agent.status = 'offline'
      agent.updated_at = database.now
    }
    return { rows: stale.map((a) => ({ id: a.id })), rowCount: stale.length }
  }

  if (sql.startsWith("UPDATE agents SET status = 'offline'")) {
    const agent = database.agents.find((a) => a.id === values[0])
    if (!agent) return { rows: [], rowCount: 0 }
    agent.status = 'offline'
    agent.updated_at = database.now
    return { rows: [], rowCount: 1 }
  }

  if (sql.startsWith('DELETE FROM agents')) {
    const index = database.agents.findIndex((a) => a.id === values[0])
    if (index === -1) return { rows: [], rowCount: 0 }
    database.agents.splice(index, 1)
    return { rows: [], rowCount: 1 }
  }

  if (sql.startsWith('SELECT') && sql.includes('FROM agent_matrix')) {
    requireRelation('agent_matrix')
    const rows = agentsByRecency().map((a) => ({
      ...a,
      seconds_since_heartbeat: Math.floor(
        (database.now.getTime() - a.last_heartbeat.getTime()) / 1000,
      ),
    }))
    return { rows, rowCount: rows.length }
  }

  if (sql.startsWith('SELECT') && sql.includes('FROM agents')) {
    requireRelation('agents')
    const onlineOnly = sql.includes("WHERE status = 'online'")
    const rows = agentsByRecency()
      .filter((a) => (onlineOnly ? a.status === 'online' : true))
      .map((a) => ({
        id: a.id,
        name: a.name,
        capabilities: a.capabilities,
        status: a.status,
        metadata: a.metadata,
      }))
    return { rows, rowCount: rows.length }
  }

  throw new Error(
    `fake Postgres refuses a statement it cannot execute: ${sql.slice(0, 60)}`,
  )
}

mock.module('pg', () => ({ ...realPg, Pool: FakePool }))

// The real logger writes to console and disk; neither belongs in a unit run.
mock.module('../../src/lib/logger', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}))

const { PgAgentStore } = await import(
  '../../src/api/services/a2a/pg-agent-store'
)

/** An agent card with test-friendly defaults. */
function card(overrides: Partial<A2aAgentCard> = {}): A2aAgentCard {
  return {
    id: 'agent-1',
    name: 'Agent One',
    description: 'does the first thing',
    capabilities: ['crawl', 'summarise'],
    version: '1.0.0',
    ...overrides,
  }
}

describe('pgAgentStoreContract', () => {
  let store: PgAgentStoreInstance

  beforeEach(() => {
    pools = []
    statements = []
    database = {
      now: BASE,
      agents: [],
      tables: new Set(),
      views: new Set(),
      failures: [],
    }
    store = new PgAgentStore(DSN)
  })

  afterAll(() => {
    // Put the real modules back before sibling files import them.
    mock.module('pg', () => realPg)
    mock.module('../../src/lib/logger', () => realLogger)
    mock.restore()
  })

  /** A store that has connected and ensured its schema, ready to be used. */
  async function ready(): Promise<PgAgentStoreInstance> {
    await store.connect()
    await store.ensureSchema()
    return store
  }

  describe('PgAgentStore.connect', () => {
    it('creates its pool against the database it was configured with', async () => {
      await store.connect()
      expect(pools).toHaveLength(1)
      expect(
        (pools[0].options as { connectionString?: string }).connectionString,
      ).toBe(DSN)
    })

    it('is idempotent: connecting again keeps the one pool', async () => {
      await store.connect()
      await store.connect()
      expect(pools).toHaveLength(1)
    })

    it('absorbs an error the pool emits, as an idle-client failure would', async () => {
      await store.connect()
      const listener = pools[0].errorListeners[0]
      expect(listener).toBeDefined()
      expect(() => listener(new Error('idle client terminated'))).not.toThrow()
    })
  })

  describe('PgAgentStore.disconnect', () => {
    it('ends the pool it created', async () => {
      await store.connect()
      await store.disconnect()
      expect(pools[0].endCalls).toBe(1)
    })

    it('is a no-op when it was never connected', async () => {
      await store.disconnect()
      expect(pools).toHaveLength(0)
    })

    it('allows connecting again after a disconnect, on a fresh pool', async () => {
      await store.connect()
      await store.disconnect()
      await store.connect()
      expect(pools).toHaveLength(2)
      expect(pools[0].endCalls).toBe(1)
      expect(pools[1].endCalls).toBe(0)
    })
  })

  describe('PgAgentStore.ensureSchema', () => {
    it('creates what the registry needs: before it the tables are missing, after it the whole API answers', async () => {
      await store.connect()
      await expect(store.listAgents()).rejects.toThrow(
        'relation "agents" does not exist',
      )
      await expect(store.listMatrix()).rejects.toThrow(
        'relation "agent_matrix" does not exist',
      )
      await store.ensureSchema()
      await expect(store.listAgents()).resolves.toEqual([])
      await expect(store.listMatrix()).resolves.toEqual([])
    })

    it('is safe to run again once the schema is already there', async () => {
      const s = await ready()
      await s.ensureSchema()
      await expect(s.listAgents()).resolves.toEqual([])
    })
  })

  describe('PgAgentStore.upsertAgent', () => {
    it('registers an agent that is visible to online listings at once', async () => {
      const s = await ready()
      await s.upsertAgent(card())
      const listed = await s.listAgents()
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({
        id: 'agent-1',
        name: 'Agent One',
        capabilities: ['crawl', 'summarise'],
      })
    })

    it('merges a re-registration over what it already holds, keeping fields the new card omits', async () => {
      const s = await ready()
      await s.upsertAgent(card({ description: 'the old description' }))
      // A re-registration with no description: JSON.stringify drops the key,
      // exactly as a caller registering from partial data would produce.
      await s.upsertAgent(card({ description: undefined, version: '2.0.0' }))
      const listed = await s.listAgents()
      expect(listed[0].description).toBe('the old description')
      expect(listed[0].version).toBe('2.0.0')
    })

    it('refreshes recency on re-registration, so the latest change leads the listing', async () => {
      const s = await ready()
      await s.upsertAgent(card({ id: 'a' }))
      database.now = new Date(BASE.getTime() + 60_000)
      await s.upsertAgent(card({ id: 'b' }))
      database.now = new Date(BASE.getTime() + 120_000)
      await s.upsertAgent(card({ id: 'a', name: 'Agent One again' }))
      const listed = await s.listAgents()
      expect(listed.map((c) => c.id)).toEqual(['a', 'b'])
      expect(listed[0].name).toBe('Agent One again')
    })
  })

  describe('PgAgentStore.heartbeat', () => {
    it('reports true for a registered agent and brings it back online', async () => {
      const s = await ready()
      await s.upsertAgent(card())
      await s.markOffline('agent-1')
      expect(await s.listAgents()).toEqual([])
      await expect(s.heartbeat('agent-1')).resolves.toBe(true)
      expect((await s.listAgents()).map((c) => c.id)).toEqual(['agent-1'])
    })

    it('reports false for an agent it has never seen', async () => {
      const s = await ready()
      await expect(s.heartbeat('ghost')).resolves.toBe(false)
    })
  })

  describe('PgAgentStore.markOffline', () => {
    it('hides an agent from online-only listings while full listings keep it', async () => {
      const s = await ready()
      await s.upsertAgent(card())
      await s.markOffline('agent-1')
      expect(await s.listAgents()).toEqual([])
      const full = await s.listAgents(false)
      expect(full.map((c) => c.id)).toEqual(['agent-1'])
    })
  })

  describe('PgAgentStore.removeAgent', () => {
    it('deletes the agent outright: no listing shows it and its heartbeat stops being true', async () => {
      const s = await ready()
      await s.upsertAgent(card())
      await s.removeAgent('agent-1')
      expect(await s.listAgents(false)).toEqual([])
      await expect(s.heartbeat('agent-1')).resolves.toBe(false)
    })
  })

  describe('PgAgentStore.listAgents', () => {
    it('maps a stored row back into a full agent card', async () => {
      const s = await ready()
      await s.upsertAgent(card({ endpoint: 'https://agent-1.internal/a2a' }))
      await expect(s.listAgents()).resolves.toEqual([
        {
          id: 'agent-1',
          name: 'Agent One',
          description: 'does the first thing',
          capabilities: ['crawl', 'summarise'],
          version: '1.0.0',
          endpoint: 'https://agent-1.internal/a2a',
        },
      ])
    })

    it('leaves the endpoint unset when the stored card never had one', async () => {
      const s = await ready()
      await s.upsertAgent(card())
      const [listed] = await s.listAgents()
      expect(listed.endpoint).toBeUndefined()
    })
  })

  describe('PgAgentStore.listMatrix', () => {
    it('returns every agent with its heartbeat age in seconds', async () => {
      const s = await ready()
      await s.upsertAgent(card({ id: 'a' }))
      database.now = new Date(BASE.getTime() + 45_000)
      const rows = await s.listMatrix()
      expect(rows).toHaveLength(1)
      const row = rows[0] as StoredAgent & { seconds_since_heartbeat: number }
      expect(row.id).toBe('a')
      expect(row.status).toBe('online')
      expect(row.seconds_since_heartbeat).toBe(45)
      expect(row.metadata).toMatchObject({
        description: 'does the first thing',
        version: '1.0.0',
      })
    })
  })

  describe('PgAgentStore.pruneOffline', () => {
    it('prunes online agents whose heartbeat is older than the threshold, and only those', async () => {
      const s = await ready()
      await s.upsertAgent(card({ id: 'stale' }))
      database.now = new Date(BASE.getTime() + 20_000)
      await s.upsertAgent(card({ id: 'fresh' }))
      database.now = new Date(BASE.getTime() + 100_000)
      // The stale agent's heartbeat is 100s old, the fresh one's 80s; the
      // default threshold is 90s.
      await expect(s.pruneOffline()).resolves.toEqual(['stale'])
      expect((await s.listAgents()).map((c) => c.id)).toEqual(['fresh'])
      const full = await s.listAgents(false)
      expect(full.map((c) => c.id).sort()).toEqual(['fresh', 'stale'])
    })

    it('reports nothing to prune when every heartbeat is fresh', async () => {
      const s = await ready()
      await s.upsertAgent(card())
      database.now = new Date(BASE.getTime() + 10_000)
      await expect(s.pruneOffline()).resolves.toEqual([])
      expect((await s.listAgents()).map((c) => c.id)).toEqual(['agent-1'])
    })

    it('honours a tighter threshold than the default', async () => {
      const s = await ready()
      await s.upsertAgent(card())
      database.now = new Date(BASE.getTime() + 30_000)
      await expect(s.pruneOffline()).resolves.toEqual([])
      await expect(s.pruneOffline(20)).resolves.toEqual(['agent-1'])
    })
  })

  describe('PgAgentStore failure handling', () => {
    it('refuses queries until it has connected', async () => {
      await expect(store.listAgents()).rejects.toThrow(
        'PgAgentStore not connected',
      )
    })

    it('rides out a transient connection failure and completes the write', async () => {
      const s = await ready()
      database.failures.push(new Error('connection terminated unexpectedly'))
      await s.upsertAgent(card())
      expect((await s.listAgents()).map((c) => c.id)).toEqual(['agent-1'])
    })

    it('surfaces a non-transient database error without retrying it', async () => {
      const s = await ready()
      database.failures.push(
        new Error('duplicate key value violates unique constraint'),
      )
      await expect(s.upsertAgent(card())).rejects.toThrow('duplicate key')
      // One statement reached the database. The count is not an internal of
      // the store - it is what the database sees: a non-transient error
      // retried three times would trip the same constraint three times
      // before surfacing.
      expect(
        statements.filter((st) => st.sql.startsWith('INSERT INTO agents')),
      ).toHaveLength(1)
    })

    it('gives up on a connection that keeps failing, surfacing the last error', async () => {
      const s = await ready()
      database.failures.push(
        new Error('connection refused'),
        new Error('connection refused'),
        new Error('connection refused'),
      )
      await expect(s.listAgents()).rejects.toThrow('connection refused')
      // Three attempts then the error, not one attempt then silence: to a
      // caller these differ in whether the store kept trying at all.
      expect(
        statements.filter((st) => st.sql.startsWith('SELECT')),
      ).toHaveLength(3)
    })
  })
})
