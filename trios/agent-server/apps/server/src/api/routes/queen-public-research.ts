/**
 * Public native research graph for t27.ai.
 *
 * The canonical graph is the evidence-backed file used by /queen/tree. This
 * route adds directionally-correct prerequisites/unlocks and a secret-free
 * view of paid worker-slot utilisation. It deliberately keeps graph state and
 * worker activity separate: "partial" means the repository has incomplete
 * evidence, not that a model is currently spending tokens on it. The `billing`
 * block explains, in the same closed vocabulary /queen/status publishes,
 * which quota gate those paid workers answer to - without which an idle
 * subscription swarm reads as broken capacity.
 */

import { Hono } from 'hono'
import { Pool } from 'pg'
import { logger } from '../../lib/logger'
import { configuredWorkerCapacity } from '../services/queen-dispatch'
import { configuredBillingMode } from './queen-public-status'
import { loadTree as loadCanonicalTree, type Tree } from './queen-tree'

/**
 * The closed billing vocabulary, derived from the one resolver both public
 * pages share. Deriving it instead of re-declaring it means this route can
 * never drift from /queen/status even if the vocabulary grows.
 */
type BillingMode = ReturnType<typeof configuredBillingMode>

/**
 * Every value `quotaAuthority` can carry.
 *
 *   provider_quota      a Coding Plan spends a provider-side subscription
 *                       quota; its resets and refusals belong to the
 *                       provider and are observed, never computed locally
 *   estimated_usd_gate  metered API work is gated by the Queen's own
 *                       estimated USD cap, which can refuse a new Bee
 */
type QuotaAuthority = 'provider_quota' | 'estimated_usd_gate'

interface QueryResult {
  rowCount: number | null
  rows: Array<Record<string, unknown>>
}

interface ResearchPool {
  query(sql: string, values?: unknown[]): Promise<QueryResult>
  end(): Promise<void>
}

interface QueenPublicResearchDeps {
  loadTree?: () => Promise<Tree | null>
  databaseUrl?: () => string | undefined
  createPool?: (url: string) => ResearchPool
  workerCapacity?: () => number
  billingMode?: () => BillingMode
  publicOrigin?: (requestUrl: string) => string
}

type ResearchState = 'researched' | 'researching' | 'available' | 'locked'

function configuredDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || undefined
}

function configuredPublicOrigin(requestUrl: string): string {
  const configured =
    process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN
  if (!configured) return new URL(requestUrl).origin

  const absolute = /^https?:\/\//i.test(configured)
    ? configured
    : `https://${configured}`
  return new URL(absolute).origin
}

function sanitizeEvidence(value: string): string {
  return value
    .replace(/\/Users\/[^/\s]+\//g, '/Users/…/')
    .replace(/\/home\/[^/\s]+\//g, '/home/…/')
    .slice(0, 1200)
}

function projectTree(tree: Tree) {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]))
  const prerequisites = new Map<string, string[]>()
  const unlocks = new Map<string, string[]>()

  for (const edge of tree.edges) {
    prerequisites.set(edge.to, [
      ...(prerequisites.get(edge.to) ?? []),
      edge.from,
    ])
    unlocks.set(edge.from, [...(unlocks.get(edge.from) ?? []), edge.to])
  }

  const stateFor = (id: string): ResearchState => {
    const node = byId.get(id)
    if (!node) return 'locked'
    if (node.status === 'shipped') return 'researched'
    if (node.status === 'partial') return 'researching'
    if (node.status === 'blocked') return 'locked'
    const needs = prerequisites.get(id) ?? []
    return needs.every((need) => byId.get(need)?.status === 'shipped')
      ? 'available'
      : 'locked'
  }

  const nodes = tree.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    layer: node.layer,
    maturity: node.status,
    state: stateFor(node.id),
    evidence: sanitizeEvidence(node.evidence),
    blockedBy: node.blockedBy ? sanitizeEvidence(node.blockedBy) : undefined,
    note: node.note ? sanitizeEvidence(node.note) : undefined,
    prerequisites: prerequisites.get(node.id) ?? [],
    unlocks: unlocks.get(node.id) ?? [],
  }))
  const count = (state: ResearchState) =>
    nodes.filter((node) => node.state === state).length
  const researched = count('researched')

  return {
    nodes,
    edges: tree.edges,
    layers: [...new Set(nodes.map((node) => node.layer))],
    summary: {
      total: nodes.length,
      researched,
      researching: count('researching'),
      available: count('available'),
      locked: count('locked'),
      percentage:
        nodes.length > 0 ? Math.round((researched / nodes.length) * 100) : 0,
    },
  }
}

function workerProjection(capacity: number, busyIndices: number[]) {
  const safeCapacity = Math.max(0, Math.floor(capacity))
  const busy = new Set(
    busyIndices.filter(
      (index) => Number.isInteger(index) && index >= 0 && index < safeCapacity,
    ),
  )
  const active = busy.size
  return {
    capacity: safeCapacity,
    active,
    idle: Math.max(0, safeCapacity - active),
    utilization:
      safeCapacity > 0 ? Math.round((active / safeCapacity) * 100) : 0,
    slots: Array.from({ length: safeCapacity }, (_, index) => ({
      slot: index + 1,
      state: busy.has(index) ? 'busy' : 'idle',
    })),
  }
}

/**
 * The closed billing explanation behind the worker panel.
 *
 * This is an explanation, not a decision: queend owns whether a Bee starts,
 * and no value here can make one run. The mode comes from the exact
 * resolver /queen/status publishes, so the two pages can never disagree
 * about the same swarm. `quotaAuthority` names which gate actually refuses
 * work under that mode. Only these two closed words leave this file - never
 * credentials, never provider response bodies, never balances or quota
 * telemetry, all of which this route never reads in the first place.
 */
function billingProjection(mode: BillingMode): {
  billingMode: BillingMode
  quotaAuthority: QuotaAuthority
} {
  return {
    billingMode: mode,
    quotaAuthority:
      mode === 'coding_plan' ? 'provider_quota' : 'estimated_usd_gate',
  }
}

export function createQueenPublicResearchRoute(
  deps: QueenPublicResearchDeps = {},
) {
  const loadTree = deps.loadTree ?? loadCanonicalTree
  const databaseUrl = deps.databaseUrl ?? configuredDatabaseUrl
  const createPool =
    deps.createPool ??
    ((url: string) => new Pool({ connectionString: url }) as ResearchPool)
  const workerCapacity = deps.workerCapacity ?? configuredWorkerCapacity
  const billingMode = deps.billingMode ?? configuredBillingMode
  const publicOrigin = deps.publicOrigin ?? configuredPublicOrigin

  return new Hono().get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const tree = await loadTree()
    if (!tree)
      return c.json({ error: 'Canonical research graph is unavailable' }, 503)

    const graph = projectTree(tree)
    const url = databaseUrl()
    let runtime: { status: 'live' | 'offline' } = { status: 'offline' }
    let busyIndices: number[] = []

    if (url) {
      const pool = createPool(url)
      try {
        const active = await pool.query(
          `SELECT key_index
             FROM queen_dispatch
            WHERE started = true
              AND finished_at IS NULL
              AND key_index IS NOT NULL`,
        )
        busyIndices = active.rows.map((row) => Number(row.key_index))
        runtime = { status: 'live' }
      } catch (error) {
        logger.warn('Queen public research telemetry query failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        await pool.end()
      }
    }

    // Railway terminates TLS at the edge, so c.req.url is HTTP inside the
    // container. Build copyable A2A links from Railway's trusted public domain
    // rather than leaking the internal scheme into the bootstrap contract.
    const origin = publicOrigin(c.req.url)
    return c.json({
      ...graph,
      runtime,
      billing: billingProjection(billingMode()),
      workers: workerProjection(workerCapacity(), busyIndices),
      agentBootstrap: {
        version: 'trinity-research-a2a/v1',
        mode: 'public-read-only',
        protocol: 'A2A',
        endpoints: {
          research: `${origin}/queen/public-research`,
          board: `${origin}/queen/public-board`,
          activity: `${origin}/queen/public-activity`,
        },
        repositories: [
          'https://github.com/gHashTag/trinity',
          'https://github.com/gHashTag/BrowserOS/tree/feat/queen-supervisor/trios',
        ],
        skills: [
          'spec-first acceptance criteria',
          'evidence labels: OBSERVED / CLAIM / INFERENCE / TARGET / UNKNOWN',
          'dependency-aware research: finish prerequisites before unlocks',
          'adversarial review before acceptance',
          'append-only experience and checkpoints',
        ],
        adaptation: {
          read: ['research graph', 'public board', 'public activity'],
          write:
            'Submit work through a scoped repository issue or authenticated A2A session; public endpoints never grant mutation authority.',
        },
      },
    })
  })
}
