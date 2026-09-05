/**
 * Contract suite for the exports of ConversationHeader.tsx.
 *
 * The module exports exactly one symbol: `ConversationHeader`. Every
 * assertion below renders that export via `react-dom/server` and
 * asserts on the markup it emits, so the suite pins observable
 * behaviour rather than the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ConversationHeader`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component has no live dependency: it renders synchronously from
 * props alone, so no module is mocked and the suite needs no network,
 * no database and no container.
 *
 * Not pinned, and why: the `onGoHome` / `onPinToggle` callbacks are
 * props, not exports, but their wiring cannot be asserted either -
 * dispatching clicks needs a DOM event loop and `bun test` in this
 * project has none (`@testing-library`, `happy-dom` and `jsdom` are
 * all absent from the lockfile). Only the rendered output is pinned.
 * That is a gap in interaction coverage, not an export left
 * unexercised: the export itself is rendered and asserted on, so no
 * export belongs in the blocked list above.
 */
import { describe, expect, it } from 'bun:test'
import { type ComponentProps, createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import type { HarnessAgent } from '../agents/agent-harness-types'
import { ConversationHeader } from './ConversationHeader'

type ConversationHeaderProps = ComponentProps<typeof ConversationHeader>

/** Minimal agent; tests spread only the fields they care about. */
const makeAgent = (overrides: Partial<HarnessAgent> = {}): HarnessAgent => ({
  id: 'agent-1',
  name: 'Research Helper',
  adapter: 'claude',
  permissionMode: 'approve-all',
  sessionKey: 'main',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...overrides,
})

const renderHeader = (
  overrides: Partial<ConversationHeaderProps> = {},
): string => {
  const props: ConversationHeaderProps = {
    agent: makeAgent(),
    fallbackName: 'Fallback Agent',
    fallbackAdapter: 'unknown',
    adapterHealth: null,
    backLabel: 'Back to agents',
    backTarget: 'page',
    onGoHome: () => {},
    onPinToggle: () => {},
    ...overrides,
  }
  return renderToString(createElement(ConversationHeader, props))
}

/** The meta line is the only `<span class="truncate">` in a fixed-height row. */
const metaLine = (html: string): string => {
  const match = html.match(
    /<div class="flex h-4[^>]*><span class="truncate">(.*)<\/span>/,
  )
  if (!match) throw new Error('meta line not found in rendered output')
  return match[1]
}

describe('ConversationHeaderTsxContract', () => {
  it('ConversationHeader titles the strip with the agent name, falling back to fallbackName', () => {
    expect(renderHeader({ agent: makeAgent() })).toContain(
      '>Research Helper</span>',
    )

    // No agent loaded: the fallback name stands in.
    expect(renderHeader({ agent: null })).toContain('>Fallback Agent</span>')

    // An agent whose name is the empty string also falls back.
    expect(renderHeader({ agent: makeAgent({ name: '' }) })).toContain(
      '>Fallback Agent</span>',
    )
  })

  it('ConversationHeader swaps the back icon with backTarget and keeps the button mobile-only', () => {
    // 'page' navigation points deeper into the app: an arrow.
    const pageHtml = renderHeader({ backTarget: 'page' })
    expect(pageHtml).toContain('lucide-arrow-left')
    expect(pageHtml).not.toContain('lucide-house')

    // 'home' navigation goes back to the start: a house.
    const homeHtml = renderHeader({ backTarget: 'home' })
    expect(homeHtml).toContain('lucide-house')
    expect(homeHtml).not.toContain('lucide-arrow-left')

    // Both variants stay hidden on large screens and carry the label.
    for (const html of [pageHtml, homeHtml]) {
      expect(html).toContain('lg:hidden')
      expect(html).toContain('title="Back to agents"')
    }
  })

  it('ConversationHeader shows the pin toggle only for a loaded agent, tracking its pinned state', () => {
    expect(renderHeader({ agent: makeAgent() })).toContain(
      'aria-label="Pin agent"',
    )
    expect(renderHeader({ agent: makeAgent({ pinned: true }) })).toContain(
      'aria-label="Unpin agent"',
    )
    // With no agent there is nothing to pin - no star button at all.
    const html = renderHeader({ agent: null })
    expect(html).not.toContain('aria-label="Pin agent"')
    expect(html).not.toContain('aria-label="Unpin agent"')
  })

  it('ConversationHeader summarises adapter, model and effort, preferring the agent over the fallback adapter', () => {
    expect(
      renderHeader({
        agent: makeAgent({
          adapter: 'codex',
          modelId: 'gpt-5.2',
          reasoningEffort: 'high',
        }),
      }),
    ).toContain('>Codex · gpt-5.2 · high</span>')

    // No agent: the fallback adapter drives the chip ('unknown' reads as 'Agent').
    expect(renderHeader({ agent: null })).toContain('>Agent</span>')
    expect(renderHeader({ agent: null, fallbackAdapter: 'claude' })).toContain(
      '>Claude Code</span>',
    )
  })

  it('ConversationHeader flags an unhealthy adapter and stays silent while healthy', () => {
    expect(
      renderHeader({
        adapterHealth: { healthy: false, reason: 'CLI missing' },
      }),
    ).toContain('>Unavailable<')

    // Healthy and absent adapter health both keep the row calm.
    expect(renderHeader({ adapterHealth: { healthy: true } })).not.toContain(
      'Unavailable',
    )
    expect(renderHeader()).not.toContain('Unavailable')
  })

  it('ConversationHeader labels each liveness state with its own pill', () => {
    expect(renderHeader({ agent: makeAgent({ status: 'working' }) })).toContain(
      '>Working<',
    )
    expect(renderHeader({ agent: makeAgent({ status: 'idle' }) })).toContain(
      '>Ready<',
    )
    expect(renderHeader({ agent: makeAgent({ status: 'asleep' }) })).toContain(
      '>Asleep<',
    )
    expect(renderHeader({ agent: makeAgent({ status: 'error' }) })).toContain(
      '>Attention<',
    )

    // No status from the server (or no agent at all) reads as still setting up.
    expect(renderHeader({ agent: makeAgent() })).toContain('>Setup<')
    expect(renderHeader({ agent: null })).toContain('>Setup<')

    // Working and Ready are the two calm/active extremes users scan
    // for, and they stay visually distinct in the markup.
    expect(renderHeader({ agent: makeAgent({ status: 'working' }) })).toContain(
      'border-amber-200',
    )
    expect(renderHeader({ agent: makeAgent({ status: 'idle' }) })).toContain(
      'border-emerald-200',
    )
  })

  it('ConversationHeader treats an idle agent with an in-flight turn as working', () => {
    expect(
      renderHeader({
        agent: makeAgent({ status: 'idle', activeTurnId: 'turn-9' }),
      }),
    ).toContain('>Working<')
    expect(
      renderHeader({
        agent: makeAgent({ status: 'idle', activeTurnId: null }),
      }),
    ).toContain('>Ready<')
  })

  it('ConversationHeader joins last-used, lifetime tokens and queue depth into one meta line', () => {
    const twoMinutesAgo = Date.now() - 2 * 60_000
    const tokens = {
      last7d: { input: 0, output: 0, requestCount: 0 },
      cumulative: { input: 700_000, output: 120_000 },
    }

    // All three parts present, in order, separated by ' · '.
    expect(
      metaLine(
        renderHeader({
          agent: makeAgent({
            lastUsedAt: twoMinutesAgo,
            tokens,
            queue: [{ id: 'q1', createdAt: 1, message: 'queued message' }],
          }),
        }),
      ),
    ).toBe('2 min ago · 820K tokens · 1 queued')

    // Two queued messages pluralise.
    expect(
      metaLine(
        renderHeader({
          agent: makeAgent({
            queue: [
              { id: 'q1', createdAt: 1, message: 'one' },
              { id: 'q2', createdAt: 2, message: 'two' },
            ],
          }),
        }),
      ),
    ).toBe('2 queued')

    // Small token totals render without a suffix.
    expect(
      metaLine(
        renderHeader({
          agent: makeAgent({
            tokens: {
              last7d: { input: 0, output: 0, requestCount: 0 },
              cumulative: { input: 142, output: 58 },
            },
          }),
        }),
      ),
    ).toBe('200 tokens')

    // Absent parts drop out instead of leaving dangling separators.
    expect(
      metaLine(
        renderHeader({
          agent: makeAgent({ lastUsedAt: Date.now() - 25 * 3_600_000 }),
        }),
      ),
    ).toBe('1 day ago')
    expect(
      metaLine(
        renderHeader({
          agent: makeAgent({ queue: [], lastUsedAt: Date.now() - 90_000 }),
        }),
      ),
    ).toBe('1 min ago')

    // Nothing to report at all: a non-breaking space keeps the row's height.
    expect(metaLine(renderHeader({ agent: makeAgent() }))).toBe('\u00A0')
    expect(metaLine(renderHeader({ agent: null }))).toBe('\u00A0')
  })

  it('ConversationHeader renders the headerExtra slot only when one is provided', () => {
    const outputsToggle: ReactNode = createElement(
      'button',
      { type: 'button' },
      'Outputs rail',
    )

    expect(renderHeader({ headerExtra: outputsToggle })).toContain(
      '>Outputs rail</button>',
    )
    expect(renderHeader()).not.toContain('Outputs rail')
  })
})
