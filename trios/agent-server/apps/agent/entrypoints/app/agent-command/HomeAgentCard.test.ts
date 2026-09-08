import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type {
  HarnessAdapterHealth,
  HarnessAgent,
} from '@/entrypoints/app/agents/agent-harness-types'
import { HomeAgentCard } from './HomeAgentCard'

/**
 * Contract suite for HomeAgentCard.tsx, the grid tile shown in the
 * /home "Recent agents" section.
 *
 * Exports of the subject: `HomeAgentCard` (one symbol total).
 *
 * Exports blocked from testing by a live dependency: NONE. The
 * component is a pure render function of its props and renders fully
 * under `react-dom/server`, so the single export is exercised
 * directly by the assertions below.
 *
 * Two behaviours are interaction-time only and cannot appear in
 * server-rendered markup, so they are pinned at the affordance level
 * rather than the dispatch level:
 * - Hover-card reveals (the adapter "Unavailable" reason and the
 *   `lastError` detail) mount only when Radix opens the card on
 *   hover; the chips that trigger them are asserted instead.
 * - The `onClick` callback fires on click; the card root renders as
 *   a real `<button type="button">`, which is what static markup can
 *   and does pin. Neither caveat hides an untested export.
 *
 * Rendered output is asserted as observable behaviour (the text,
 * chips and control semantics a user sees), never the internal
 * helper structure of the module.
 */

type HomeAgentCardProps = Parameters<typeof HomeAgentCard>[0]

const baseAgent: HarnessAgent = {
  id: 'agent-1',
  name: 'Research Bot',
  adapter: 'codex',
  permissionMode: 'approve-all',
  sessionKey: 'agent:agent-1:main',
  createdAt: 1_000,
  updatedAt: 1_000,
  status: 'idle',
  lastUsedAt: Date.now() - 5_000,
  lastUserMessage: 'hello world',
}

function agentWith(overrides: Partial<HarnessAgent>): HarnessAgent {
  return { ...baseAgent, ...overrides }
}

function renderCard(overrides: Partial<HomeAgentCardProps> = {}): string {
  const props: HomeAgentCardProps = {
    agent: baseAgent,
    adapter: 'codex',
    adapterHealth: null,
    onClick: () => {},
    ...overrides,
  }
  return renderToString(createElement(HomeAgentCard, props))
}

describe('HomeAgentCardTsxContract', () => {
  it('HomeAgentCard renders the card contract: name, summary line, message preview, status footnote and state chips', () => {
    const idle = renderCard()

    // Root affordance: the whole card is one keyboard-focusable button.
    expect(idle.startsWith('<button type="button"')).toBe(true)

    // Display name: the trimmed agent name, or shortened id fallbacks.
    expect(idle).toContain('>Research Bot<')
    expect(
      renderCard({ agent: agentWith({ name: '  Padded Name  ' }) }),
    ).toContain('>Padded Name<')
    const ocId = 'oc-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(
      renderCard({ agent: agentWith({ id: ocId, name: ocId }) }),
    ).toContain(`>${ocId.slice(0, 11)}<`)
    const uuid = '11111111-2222-3333-4444-555555555555'
    expect(
      renderCard({ agent: agentWith({ id: uuid, name: uuid }) }),
    ).toContain(`>${uuid.slice(0, 8)}<`)
    expect(
      renderCard({ agent: agentWith({ id: 'plain-id', name: '   ' }) }),
    ).toContain('>plain-id<')

    // Summary line: adapter label, optional model and effort, dot-joined.
    expect(idle).toContain('>Codex</span>')
    expect(
      renderCard({
        agent: agentWith({ modelId: 'gpt-5.5', reasoningEffort: 'high' }),
      }),
    ).toContain('Codex · gpt-5.5 · high')
    expect(renderCard({ adapter: 'unknown' })).toContain('>Agent</span>')

    // Message preview: first non-blank line, capped at the preview length.
    expect(
      renderCard({ agent: agentWith({ lastUserMessage: null }) }),
    ).toContain('No messages yet — start a chat')
    expect(idle).toContain('>hello world<')
    expect(
      renderCard({
        agent: agentWith({ lastUserMessage: 'first line\n\nsecond line' }),
      }),
    ).toContain('>first line<')
    const preview = renderCard({
      agent: agentWith({ lastUserMessage: 'y'.repeat(150) }),
    })
    expect(preview).toContain(`>${'y'.repeat(99)}…<`)

    // Status footnote: recency copy, except working always says "now".
    expect(idle).toContain('>just now<')
    expect(renderCard({ agent: agentWith({ lastUsedAt: null }) })).toContain(
      '>never<',
    )
    expect(
      renderCard({
        agent: agentWith({ lastUsedAt: Date.now() - 26 * 3_600_000 }),
      }),
    ).toContain('>1 day ago<')
    const working = renderCard({
      agent: agentWith({
        status: 'working',
        lastUsedAt: Date.now() - 3_600_000,
      }),
    })
    expect(working).toContain('>now<')
    expect(working).not.toContain('1 hr ago')

    // State chips: working badge, resume chip, asleep badge, error badge.
    expect(working).toContain('>Working<')
    expect(idle).not.toContain('>Working<')
    expect(
      renderCard({ agent: agentWith({ activeTurnId: 'turn-9' }) }),
    ).toContain('>Resume<')
    expect(idle).not.toContain('>Resume<')
    expect(
      renderCard({
        agent: agentWith({
          status: 'asleep',
          lastUsedAt: Date.now() - 7_200_000,
        }),
      }),
    ).toContain('>Asleep<')
    expect(
      renderCard({
        agent: agentWith({
          status: 'error',
          lastError: 'CLI exited 127',
          lastUsedAt: Date.now() - 3_600_000,
        }),
      }),
    ).toContain('>Attention<')
    expect(
      renderCard({ agent: agentWith({ status: 'error', lastError: null }) }),
    ).toContain('>Attention<')
    expect(idle).not.toContain('>Attention<')

    // Adapter health: the Unavailable chip appears only when unhealthy.
    const unhealthy: HarnessAdapterHealth = {
      healthy: false,
      reason: 'adapter binary not on PATH',
      checkedAt: Date.now(),
    }
    expect(renderCard({ adapterHealth: unhealthy })).toContain('>Unavailable<')
    const healthy: HarnessAdapterHealth = {
      healthy: true,
      checkedAt: Date.now(),
    }
    expect(renderCard({ adapterHealth: healthy })).not.toContain(
      '>Unavailable<',
    )
    expect(idle).not.toContain('>Unavailable<')

    // Active card: the accent ring marks the bound conversation target.
    expect(renderCard({ active: true })).toContain(
      'ring-1 ring-[var(--accent-orange)]/30',
    )
    expect(idle).not.toContain('ring-1')
  })
})
