import { describe, expect, it } from 'bun:test'
import type { HarnessAgent } from '@/entrypoints/app/agents/agent-harness-types'
import { orderHomeAgents } from './home-agent-card.helpers'

function agent(overrides: Partial<HarnessAgent>): HarnessAgent {
  return {
    id: overrides.id ?? 'agent-x',
    name: overrides.name ?? overrides.id ?? 'agent-x',
    adapter: overrides.adapter ?? 'codex',
    permissionMode: 'approve-all',
    sessionKey: `agent:${overrides.id ?? 'agent-x'}:main`,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe('orderHomeAgents', () => {
  it('places active-turn agents before everyone else', () => {
    const sorted = orderHomeAgents([
      agent({ id: 'a', lastUsedAt: 5000 }),
      agent({ id: 'b', lastUsedAt: 9000, activeTurnId: 'turn-1' }),
      agent({ id: 'c', lastUsedAt: 7000 }),
    ])
    expect(sorted.map((a) => a.id)).toEqual(['b', 'c', 'a'])
  })

  it('orders non-active agents by lastUsedAt desc', () => {
    const sorted = orderHomeAgents([
      agent({ id: 'old', lastUsedAt: 1000 }),
      agent({ id: 'new', lastUsedAt: 9000 }),
      agent({ id: 'mid', lastUsedAt: 5000 }),
    ])
    expect(sorted.map((a) => a.id)).toEqual(['new', 'mid', 'old'])
  })

  it('puts the gateway `main` seed agent above other never-used agents', () => {
    const sorted = orderHomeAgents([
      agent({ id: 'oc-aaaaaa', lastUsedAt: null }),
      agent({ id: 'main', lastUsedAt: null }),
      agent({ id: 'oc-bbbbbb', lastUsedAt: null }),
    ])
    expect(sorted.map((a) => a.id)).toEqual(['main', 'oc-aaaaaa', 'oc-bbbbbb'])
  })

  it('sends never-used agents to the bottom even when `main` is among them', () => {
    const sorted = orderHomeAgents([
      agent({ id: 'main', lastUsedAt: null }),
      agent({ id: 'used', lastUsedAt: 5000 }),
    ])
    expect(sorted.map((a) => a.id)).toEqual(['used', 'main'])
  })

  it('does NOT sort by pinned — pinned agents are treated like any other', () => {
    const sorted = orderHomeAgents([
      agent({ id: 'unpinned-recent', lastUsedAt: 9000, pinned: false }),
      agent({ id: 'pinned-old', lastUsedAt: 1000, pinned: true }),
    ])
    expect(sorted.map((a) => a.id)).toEqual(['unpinned-recent', 'pinned-old'])
  })

  it('falls back to id-stable ordering when lastUsedAt ties', () => {
    const sorted = orderHomeAgents([
      agent({ id: 'b', lastUsedAt: 5000 }),
      agent({ id: 'a', lastUsedAt: 5000 }),
    ])
    expect(sorted.map((a) => a.id)).toEqual(['a', 'b'])
  })
})
