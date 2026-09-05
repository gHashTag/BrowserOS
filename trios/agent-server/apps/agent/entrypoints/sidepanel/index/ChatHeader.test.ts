/**
 * Contract suite for the exports of ChatHeader.tsx.
 *
 * The module exports exactly one symbol: `ChatHeader`. The single test
 * below names that symbol and renders it through a real in-memory
 * router, asserting on the markup a user of the sidepanel can observe:
 * window titles, link destinations and the provider trigger label.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ChatHeader`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * What the suite needs and does not need: the component is a
 * presentational header, so no dependency of the scenarios below is
 * live. The one non-pure import in the component's graph is the
 * web-extension storage item that `@/lib/theme/theme-storage` defines
 * at module scope; the storage driver reads eagerly and demands a
 * `browser` global that `bun test` does not provide, so the driver is
 * swapped for an in-memory stub via `mock.module` before the subject
 * loads. No network, no database and no container is touched.
 *
 * Not pinned, and why: click handlers (`onNewConversation`,
 * `onSelectProvider`, the from-history navigation) cannot be fired,
 * because `bun test` in this project has no DOM environment -
 * `@testing-library`, `happy-dom` and `jsdom` are absent from the
 * lockfile - so only the server-rendered output is asserted. That is
 * a gap in interaction coverage, not an export left unexercised: the
 * export itself is rendered and asserted on, so no export belongs in
 * the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import type { Provider } from '@/components/chat/chatComponentTypes'

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string) => ({
      key,
      getValue: () => Promise.resolve(null),
      setValue: () => Promise.resolve(),
      watch: () => () => undefined,
    }),
  },
}))

const { ChatHeader } = await import('./ChatHeader')

const llmProvider: Provider = {
  id: 'anthropic-sonnet',
  name: 'Anthropic Sonnet',
  type: 'anthropic',
  kind: 'llm',
}

const acpProvider: Provider = {
  id: 'agent-codex',
  name: 'Codex Agent',
  type: 'acp',
  kind: 'acp',
  agentId: 'agent-codex',
}

const renderHeader = (props: {
  selectedProvider: Provider
  hasMessages: boolean
  hideHistory?: boolean
  route?: string
}): string =>
  renderToString(
    createElement(
      MemoryRouter,
      { initialEntries: [props.route ?? '/'] },
      createElement(ChatHeader, {
        selectedProvider: props.selectedProvider,
        providers: [props.selectedProvider],
        onSelectProvider: () => undefined,
        onNewConversation: () => undefined,
        hasMessages: props.hasMessages,
        hideHistory: props.hideHistory,
      }),
    ),
  )

const countMatches = (html: string, pattern: RegExp): number =>
  (html.match(pattern) ?? []).length

describe('ChatHeaderTsxContract', () => {
  it('ChatHeader renders the provider trigger and window controls that follow the route and the props', () => {
    // --- on the chat page, during an ongoing conversation ---
    const chatHtml = renderHeader({
      selectedProvider: llmProvider,
      hasMessages: true,
    })

    // The provider trigger names the selected provider and says what it does.
    expect(chatHtml).toContain('title="Change AI Provider"')
    expect(chatHtml).toContain('>Anthropic Sonnet</span>')

    // An ongoing conversation offers exactly one fresh-start control...
    expect(countMatches(chatHtml, /title="New conversation"/g)).toBe(1)
    // ...and the history affordance is a link to the history page.
    expect(chatHtml).toContain('title="Chat history"')
    expect(chatHtml).toContain('href="/history"')

    // The repository and the settings both open in their own tab.
    expect(chatHtml).toContain('title="Star on Github"')
    expect(chatHtml).toContain(
      'href="https://github.com/browseros-ai/BrowserOS"',
    )
    expect(chatHtml).toContain('title="Settings"')
    expect(chatHtml).toContain('href="/app.html#/settings"')
    expect(chatHtml).toContain('target="_blank"')

    // --- on the history page ---
    const historyHtml = renderHeader({
      selectedProvider: llmProvider,
      hasMessages: true,
      route: '/history',
    })

    // The history link is gone; a single control starts a new
    // conversation instead of navigating to history again.
    expect(historyHtml).not.toContain('title="Chat history"')
    expect(historyHtml).not.toContain('href="/history"')
    expect(countMatches(historyHtml, /title="New conversation"/g)).toBe(1)

    // --- on the chat page, with no messages yet ---
    const emptyHtml = renderHeader({
      selectedProvider: llmProvider,
      hasMessages: false,
    })

    // Nothing to start over from, so the control is absent...
    expect(countMatches(emptyHtml, /title="New conversation"/g)).toBe(0)
    // ...but history remains reachable.
    expect(emptyHtml).toContain('title="Chat history"')

    // --- on the chat page, with the history control hidden ---
    const hiddenHtml = renderHeader({
      selectedProvider: llmProvider,
      hasMessages: true,
      hideHistory: true,
    })

    expect(hiddenHtml).not.toContain('title="Chat history"')
    // The fresh-start control for an ongoing conversation stays.
    expect(countMatches(hiddenHtml, /title="New conversation"/g)).toBe(1)

    // --- an agent (ACP) provider is selected ---
    const acpHtml = renderHeader({
      selectedProvider: acpProvider,
      hasMessages: false,
    })

    // The trigger names the agent and marks it with the generic bot
    // glyph rather than a vendor logo.
    expect(acpHtml).toContain('title="Change AI Provider"')
    expect(acpHtml).toContain('>Codex Agent</span>')
    expect(acpHtml).toContain('lucide-bot')
  })
})
