import { describe, expect, it } from 'bun:test'
import { createQueenPublicAgentsRoute } from '../../src/api/routes/queen-public-agents'

/**
 * Postgres, answering the way the route reads it.
 *
 * The fake rows deliberately carry MORE than the projection may ever emit:
 * name, capabilities, metadata, endpoint, status and a planted token column.
 * The contract under test is not that the query selects little - it is that
 * the route emits little even when handed much.
 */
function fakePool(rows: Array<Record<string, unknown>>) {
  let ended = false
  let sql: string | undefined
  return {
    query: async (text: string) => {
      sql = text
      return { rowCount: rows.length, rows }
    },
    end: async () => {
      ended = true
    },
    wasEnded: () => ended,
    sql: () => sql,
  }
}

const FROZEN_NOW = Date.parse('2026-09-03T12:05:30.000Z')

describe('GET /queen/public-agents', () => {
  /**
   * The 2026-05-24 alert, reduced to the one number it should have been:
   * the trios-agent beat for the last time 330 seconds before the read, and
   * the projection must say 330 - floored, so latency never rounds the
   * outage up, and measured from the heartbeat to one instant.
   */
  it('gives the 330-second silence from the alert a number', async () => {
    const pool = fakePool([
      {
        id: 'trios-agent',
        last_heartbeat: '2026-09-03T12:00:00.000Z',
      },
      {
        // A livelier agent: silent for 45 seconds.
        id: 'queen-autonomous-test',
        last_heartbeat: new Date('2026-09-03T12:04:45.000Z'),
      },
    ])

    const response = await createQueenPublicAgentsRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      now: () => FROZEN_NOW,
    }).request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.agents).toHaveLength(2)
    // Longest silence first: the number an alert reads is the first entry.
    expect(body.agents[0]).toEqual({
      id: 'trios-agent',
      kind: 'trios',
      lastHeartbeatAt: '2026-09-03T12:00:00.000Z',
      silentSeconds: 330,
    })
    expect(body.agents[1]).toEqual({
      id: 'queen-autonomous-test',
      kind: 'queen',
      lastHeartbeatAt: '2026-09-03T12:04:45.000Z',
      silentSeconds: 45,
    })
    expect(pool.wasEnded()).toBe(true)
  })

  /**
   * FR-002/FR-004: exactly four fields per agent, and a planted token column
   * never appears. The registry row knows a free-text name, capabilities, a
   * metadata blob with an endpoint (a host) and - planted for this test - a
   * token column. None of those may survive the projection, not even as a
   * null: a present-but-null key is still a key a public consumer learns to
   * expect, and one a future writer fills in.
   */
  it('emits exactly the four public fields and never a token', async () => {
    const pool = fakePool([
      {
        id: 'trios-agent',
        name: 'trios',
        capabilities: ['shell', 'git'],
        status: 'online',
        metadata: {
          description: 'Trinity A2A agent embedded in the trios macOS chat app',
          endpoint: 'https://private-mac.local:9105',
        },
        token: 'a2a-local-auth-token-5f3a91',
        last_heartbeat: '2026-09-03T12:05:29.000Z',
      },
      {
        id: 'worker-relay',
        token: 'worker-relay-token-9c2b',
        name: 'ops laptop',
        last_heartbeat: '2026-09-03T12:05:00.000Z',
      },
    ])

    const response = await createQueenPublicAgentsRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      now: () => FROZEN_NOW,
    }).request('/')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.agents).toHaveLength(2)
    for (const agent of body.agents) {
      expect(Object.keys(agent).sort()).toEqual([
        'id',
        'kind',
        'lastHeartbeatAt',
        'silentSeconds',
      ])
    }
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('a2a-local-auth-token-5f3a91')
    expect(serialized).not.toContain('worker-relay-token-9c2b')
    expect(serialized).not.toContain('private-mac.local')
    expect(serialized).not.toContain('Trinity A2A agent')
    expect(serialized).not.toContain('ops laptop')
    // The registry's own columns stay where they belong.
    expect(serialized).not.toContain('"name"')
    expect(serialized).not.toContain('"capabilities"')
    expect(serialized).not.toContain('"metadata"')
    expect(serialized).not.toContain('"status"')
  })

  /**
   * User story 1, scenario 2: an empty registry is a healthy, answerable
   * state - the swarm simply has nothing registered - and must read as an
   * empty list, not an error a monitoring pipeline would page on.
   */
  it('returns an empty list and 200 when no agent is registered', async () => {
    const pool = fakePool([])

    const response = await createQueenPublicAgentsRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      now: () => FROZEN_NOW,
    }).request('/')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ agents: [] })
    expect(pool.wasEnded()).toBe(true)
  })

  /**
   * `kind` is a closed vocabulary derived from the id this response already
   * publishes. Anything the swarm does not recognize is `external` - an
   * unknown agent that has gone silent is still silence worth a number, so
   * it is classified, never dropped and never echoed as free text.
   */
  it('derives kind from the id over a closed vocabulary', async () => {
    const pool = fakePool([
      { id: 'bee-1062', last_heartbeat: '2026-09-03T12:05:00.000Z' },
      { id: 'drone-relay-7', last_heartbeat: '2026-09-03T12:05:00.000Z' },
    ])

    const response = await createQueenPublicAgentsRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      now: () => FROZEN_NOW,
    }).request('/')

    const body = await response.json()
    expect(
      body.agents.map((agent: { id: string; kind: string }) => agent.kind),
    ).toEqual(['worker', 'external'])
  })

  it('returns 503 when no Queen database is configured', async () => {
    const response = await createQueenPublicAgentsRoute({
      databaseUrl: () => undefined,
    }).request('/')

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error).toBe('Queen database is not configured')
  })
})
