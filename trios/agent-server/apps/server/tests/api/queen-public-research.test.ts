import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createQueenPublicResearchRoute } from '../../src/api/routes/queen-public-research'
import type { WorkerCapacityBreakdown } from '../../src/api/services/queen-dispatch'

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

// #1308 plants environment-shaped credential slots and reads the DEFAULT
// capacity authority, so a real secret sitting in the runner's environment
// must be cleared before the first case and after every case: a failure that
// printed one would be worse than the failure, and a leftover one would
// silently change which provider the first case factors.
const KEYS = [
  'ZAI_API_KEY',
  'ZAI_API_KEY_2',
  'ZAI_API_KEY_3',
  'ZAI_API_KEY_4',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_API_KEY',
  'TRIOS_ZAI_CONCURRENCY_PER_KEY',
]

beforeAll(() => {
  for (const key of KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
})

/** The breakdown of the capacity-4 fixtures above: two credentials, two lanes. */
const twoCredentialsTwoLanes = (): WorkerCapacityBreakdown => ({
  connectedCredentials: 2,
  lanesPerCredential: 2,
  effectiveCapacity: 4,
})

/** Every property name anywhere in a parsed response. */
const propertyNames = (value: unknown, into: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) propertyNames(item, into)
  } else if (value && typeof value === 'object') {
    for (const [name, inner] of Object.entries(value)) {
      into.push(name)
      propertyNames(inner, into)
    }
  }
  return into
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
      workerCapacityBreakdown: twoCredentialsTwoLanes,
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
      connectedCredentials: 2,
      lanesPerCredential: 2,
      effectiveCapacity: 4,
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
      workerCapacityBreakdown: twoCredentialsTwoLanes,
    }).request('/')

    const body = await response.json()
    expect(body.workers).toEqual({
      capacity: 4,
      active: 2,
      idle: 2,
      utilization: 50,
      connectedCredentials: 2,
      lanesPerCredential: 2,
      effectiveCapacity: 4,
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
      workerCapacityBreakdown: twoCredentialsTwoLanes,
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

/**
 * #1308. `workers.capacity` answering 4 does not say WHICH 4. These cases
 * plant environment-shaped credential slots and read the DEFAULT capacity
 * authority - the same one dispatch allocates against - then assert the
 * response explains the total as anonymous factors while carrying none of the
 * material that produced them: no planted value, no provider variable name,
 * no credential slot index.
 */
describe('worker capacity breakdown on /queen/public-research', () => {
  const assertClosed = (body: unknown) => {
    const serialized = JSON.stringify(body)
    // None of the planted key values, in full or in part.
    for (const planted of [
      'planted-zai-alpha-7f3a',
      'planted-zai-beta-9c2d',
      'planted-anthropic-gamma-5e1f',
      'planted-duplicate-zeta-4b8e',
      'planted-distinct-eta-1a6b',
    ]) {
      expect(serialized).not.toContain(planted)
    }
    // No provider variable name, unsuffixed or suffixed.
    for (const name of [
      'ZAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'MOONSHOT_API_KEY',
      'OPENAI_API_KEY',
      'TRIOS_ZAI_CONCURRENCY_PER_KEY',
    ]) {
      expect(serialized).not.toContain(name)
    }
    // No credential slot index field: the anonymous `slot` numbers of the
    // public slots contract are lane slots, and key_index must never be one
    // of them by another name.
    const names = propertyNames(body)
    expect(names.some((name) => /key_?index/i.test(name))).toBe(false)
    expect(names.filter((name) => /credential/i.test(name)).sort()).toEqual([
      'connectedCredentials',
      'lanesPerCredential',
    ])
  }

  // Scenario 1: two distinct configured Z.ai credentials, two lanes each.
  // ANTHROPIC is planted too, to prove a variable name that IS configured
  // still never appears in what leaves.
  it('explains capacity 4 as two credentials at two lanes', async () => {
    process.env.ZAI_API_KEY = 'planted-zai-alpha-7f3a'
    process.env.ZAI_API_KEY_2 = 'planted-zai-beta-9c2d'
    process.env.TRIOS_ZAI_CONCURRENCY_PER_KEY = '2'
    process.env.ANTHROPIC_API_KEY = 'planted-anthropic-gamma-5e1f'
    const response = await createQueenPublicResearchRoute({
      loadTree: async () => tree,
      databaseUrl: () => 'postgres://configured',
      createPool: () => ({
        query: async () => ({
          rowCount: 2,
          rows: [{ key_index: 0 }, { key_index: 1 }],
        }),
        end: async () => {},
      }),
    }).request('/')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.workers).toEqual({
      capacity: 4,
      active: 2,
      idle: 2,
      utilization: 50,
      connectedCredentials: 2,
      lanesPerCredential: 2,
      effectiveCapacity: 4,
      slots: [
        { slot: 1, state: 'busy' },
        { slot: 2, state: 'busy' },
        { slot: 3, state: 'idle' },
        { slot: 4, state: 'idle' },
      ],
    })
    assertClosed(body)
  })

  // Scenario 2: the same credential duplicated across slots is one account
  // with one rate limit; neither connected credentials nor capacity inflates.
  it('does not inflate when duplicate credentials sit in several slots', async () => {
    process.env.ZAI_API_KEY = 'planted-duplicate-zeta-4b8e'
    process.env.ZAI_API_KEY_2 = 'planted-duplicate-zeta-4b8e'
    process.env.ZAI_API_KEY_3 = 'planted-distinct-eta-1a6b'
    const response = await createQueenPublicResearchRoute({
      loadTree: async () => tree,
      databaseUrl: () => undefined,
    }).request('/')

    const body = await response.json()
    expect(body.workers).toEqual({
      capacity: 2,
      active: 0,
      idle: 2,
      utilization: 0,
      connectedCredentials: 2,
      lanesPerCredential: 1,
      effectiveCapacity: 2,
      slots: [
        { slot: 1, state: 'idle' },
        { slot: 2, state: 'idle' },
      ],
    })
    assertClosed(body)
  })

  // Scenario 3: no supported provider credentials anywhere. Every factor is
  // zero or its safe default, and no secret metadata leaves with them.
  it('reports zeros and safe defaults when no provider is connected', async () => {
    const response = await createQueenPublicResearchRoute({
      loadTree: async () => tree,
      databaseUrl: () => undefined,
    }).request('/')

    const body = await response.json()
    expect(body.workers).toEqual({
      capacity: 0,
      active: 0,
      idle: 0,
      utilization: 0,
      connectedCredentials: 0,
      lanesPerCredential: 1,
      effectiveCapacity: 0,
      slots: [],
    })
    assertClosed(body)
  })
})
