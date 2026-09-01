import { describe, expect, it } from 'bun:test'
import { createQueenPublicResearchRoute } from '../../src/api/routes/queen-public-research'

const tree = {
  nodes: [
    {
      id: 'compiler',
      label: 'Compiler',
      layer: 'seed',
      status: 'shipped' as const,
      evidence: '/Users/private/t27/compiler.rs:1',
    },
    {
      id: 'rings',
      label: 'Generated rings',
      layer: 'ring',
      status: 'partial' as const,
      evidence: 'rings/T27-00/queen_core.t27',
    },
    {
      id: 'silicon',
      label: 'Silicon proof',
      layer: 'silicon',
      status: 'planned' as const,
      evidence: 'No board run yet',
    },
  ],
  edges: [
    { from: 'compiler', to: 'rings' },
    { from: 'rings', to: 'silicon' },
  ],
  conflicts: [],
  staleSkills: [],
}

describe('GET /queen/public-research', () => {
  it('projects the evidence graph, unlocks and four worker slots without secrets', async () => {
    let ended = false
    const response = await createQueenPublicResearchRoute({
      loadTree: async () => tree,
      databaseUrl: () => 'postgres://configured',
      createPool: () => ({
        query: async () => ({
          rowCount: 2,
          rows: [{ key_index: 0 }, { key_index: 2 }],
        }),
        end: async () => {
          ended = true
        },
      }),
      workerCapacity: () => 4,
      publicOrigin: () => 'https://research.t27.test',
    }).request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.summary).toEqual({
      total: 3,
      researched: 1,
      researching: 1,
      available: 0,
      locked: 1,
      percentage: 33,
    })
    expect(body.workers).toEqual({
      capacity: 4,
      active: 2,
      idle: 2,
      utilization: 50,
      slots: [
        { slot: 1, state: 'busy' },
        { slot: 2, state: 'busy' },
        { slot: 3, state: 'idle' },
        { slot: 4, state: 'idle' },
      ],
    })
    expect(body.nodes[0].unlocks).toEqual(['rings'])
    expect(body.nodes[1].prerequisites).toEqual(['compiler'])
    expect(body.nodes[2].state).toBe('locked')
    expect(body.agentBootstrap.endpoints).toEqual({
      research: 'https://research.t27.test/queen/public-research',
      board: 'https://research.t27.test/queen/public-board',
      activity: 'https://research.t27.test/queen/public-activity',
    })
    expect(JSON.stringify(body)).not.toContain('/Users/private')
    expect(JSON.stringify(body)).not.toContain('postgres://configured')
    expect(ended).toBe(true)
  })

  it('counts two logical lanes on one credential as two active Bees', async () => {
    const response = await createQueenPublicResearchRoute({
      loadTree: async () => tree,
      databaseUrl: () => 'postgres://configured',
      createPool: () => ({
        query: async () => ({
          rowCount: 2,
          rows: [{ key_index: 0 }, { key_index: 0 }],
        }),
        end: async () => {},
      }),
      workerCapacity: () => 4,
    }).request('/')

    const body = await response.json()
    expect(body.workers).toEqual({
      capacity: 4,
      active: 2,
      idle: 2,
      utilization: 50,
      slots: [
        { slot: 1, state: 'busy' },
        { slot: 2, state: 'busy' },
        { slot: 3, state: 'idle' },
        { slot: 4, state: 'idle' },
      ],
    })
  })

  it('keeps the canonical graph available when runtime telemetry is offline', async () => {
    const response = await createQueenPublicResearchRoute({
      loadTree: async () => tree,
      databaseUrl: () => undefined,
      workerCapacity: () => 4,
    }).request('/')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.runtime).toEqual({ status: 'offline' })
    expect(body.workers.active).toBe(0)
    expect(body.nodes).toHaveLength(3)
  })

  it('fails explicitly when the canonical graph is missing', async () => {
    const response = await createQueenPublicResearchRoute({
      loadTree: async () => null,
    }).request('/')
    expect(response.status).toBe(503)
  })
})
