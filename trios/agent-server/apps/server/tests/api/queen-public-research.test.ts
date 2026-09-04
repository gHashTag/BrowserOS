import { describe, expect, it } from 'bun:test'
import { createQueenPublicResearchRoute } from '../../src/api/routes/queen-public-research'
import { configuredBillingMode } from '../../src/api/routes/queen-public-status'

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

describe('GET /queen/public-research billing projection', () => {
  type ResearchDeps = Parameters<typeof createQueenPublicResearchRoute>[0]

  const read = async (overrides: Partial<ResearchDeps> = {}) => {
    const response = await createQueenPublicResearchRoute({
      loadTree: async () => tree,
      databaseUrl: () => undefined,
      workerCapacity: () => 4,
      ...overrides,
    }).request('/')
    expect(response.status).toBe(200)
    return (await response.json()) as {
      billing: Record<string, unknown>
      workers: Record<string, unknown>
    }
  }

  it('reports Coding Plan with provider quota as the authority, and nothing else', async () => {
    const body = await read({ billingMode: () => 'coding_plan' })
    // Closed contract: exactly two fields, both closed words. No key, no
    // balance, no provider response body has anywhere to hide in this shape.
    expect(Object.keys(body.billing).sort()).toEqual([
      'billingMode',
      'quotaAuthority',
    ])
    expect(body.billing).toEqual({
      billingMode: 'coding_plan',
      quotaAuthority: 'provider_quota',
    })
  })

  it('resolves an explicit Coding Plan environment value by itself', async () => {
    const previous = process.env.TRIOS_SWARM_BILLING_MODE
    try {
      process.env.TRIOS_SWARM_BILLING_MODE = 'coding_plan'
      const body = await read()
      expect(body.billing).toEqual({
        billingMode: 'coding_plan',
        quotaAuthority: 'provider_quota',
      })
    } finally {
      if (previous === undefined) delete process.env.TRIOS_SWARM_BILLING_MODE
      else process.env.TRIOS_SWARM_BILLING_MODE = previous
    }
  })

  it('stays conservatively metered when the configuration is missing, empty, or unknown', async () => {
    const previous = process.env.TRIOS_SWARM_BILLING_MODE
    try {
      for (const raw of [undefined, '', 'subscription', 'coding-plan']) {
        if (raw === undefined) delete process.env.TRIOS_SWARM_BILLING_MODE
        else process.env.TRIOS_SWARM_BILLING_MODE = raw

        const body = await read()
        expect(body.billing).toEqual({
          billingMode: 'api_metered',
          quotaAuthority: 'estimated_usd_gate',
        })
      }
    } finally {
      if (previous === undefined) delete process.env.TRIOS_SWARM_BILLING_MODE
      else process.env.TRIOS_SWARM_BILLING_MODE = previous
    }
  })

  it('agrees with the public status contract for every raw configuration', async () => {
    const previous = process.env.TRIOS_SWARM_BILLING_MODE
    try {
      for (const raw of [
        'coding_plan',
        ' CODING_PLAN ',
        'api_metered',
        undefined,
        '',
        'subscription',
      ]) {
        if (raw === undefined) delete process.env.TRIOS_SWARM_BILLING_MODE
        else process.env.TRIOS_SWARM_BILLING_MODE = raw

        // /queen/status publishes this exact resolver's verdict. The worker
        // panel must never tell a different story about the same swarm.
        const statusMode = configuredBillingMode()
        const body = await read()
        expect(body.billing.billingMode).toBe(statusMode)
        // The named authority and the status gate boolean are the same fact:
        // the estimated USD gate refuses work exactly when it is the
        // authority, and only then.
        expect(body.billing.quotaAuthority).toBe(
          statusMode === 'coding_plan'
            ? 'provider_quota'
            : 'estimated_usd_gate',
        )
      }
    } finally {
      if (previous === undefined) delete process.env.TRIOS_SWARM_BILLING_MODE
      else process.env.TRIOS_SWARM_BILLING_MODE = previous
    }
  })

  it('cannot fabricate an active worker when capacity is zero or idle', async () => {
    const readTelemetry = async (capacity: number, busyIndices: number[]) => {
      const response = await createQueenPublicResearchRoute({
        loadTree: async () => tree,
        databaseUrl: () => 'postgres://configured',
        createPool: () => ({
          query: async () => ({
            rowCount: busyIndices.length,
            rows: busyIndices.map((key_index) => ({ key_index })),
          }),
          end: async () => {},
        }),
        workerCapacity: () => capacity,
        // The most generous billing story: a Coding Plan that may run
        // subscription workers. It still starts none.
        billingMode: () => 'coding_plan',
      }).request('/')
      return (await response.json()) as {
        billing: Record<string, unknown>
        workers: {
          capacity: number
          active: number
          idle: number
          utilization: number
          slots: Array<{ slot: number; state: string }>
        }
      }
    }

    const zero = await readTelemetry(0, [])
    expect(zero.workers).toEqual({
      capacity: 0,
      active: 0,
      idle: 0,
      utilization: 0,
      slots: [],
    })
    expect(zero.billing).toEqual({
      billingMode: 'coding_plan',
      quotaAuthority: 'provider_quota',
    })

    const idle = await readTelemetry(2, [])
    expect(idle.workers.active).toBe(0)
    expect(idle.workers.utilization).toBe(0)
    expect(idle.workers.slots.every((slot) => slot.state === 'idle')).toBe(true)

    // The billing words are labels about a gate, never an activity claim:
    // neither closed field can be read as "a worker is running".
    for (const body of [zero, idle]) {
      expect(JSON.stringify(body.billing)).not.toMatch(
        /busy|active|running|worker/i,
      )
    }
  })
})
