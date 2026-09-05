/**
 * @license
 * Copyright 2025 BrowserOS
 *
 * Contract suite for `SoulExamples.tsx` - the first tests this module has.
 *
 * The module's single export, `SoulExamples`, is pinned exactly as it exists
 * today: its initial render surface (intro copy, the three canned examples
 * each with a "Try it" button, the reset row) plus the guarantee that a
 * render with both dialogs closed stays inert - no reset RPC, no side-panel
 * open request, no dialog markup.
 *
 * Two browser-only collaborators are stubbed at the module boundary so the
 * suite runs under `bun test` with no network, database or container:
 * - `@/lib/rpc/RpcClientProvider` resolves a live BrowserOS RPC client at
 *   import time through `chrome.*` capabilities that do not exist here.
 * - `@/lib/messaging/sidepanel/openSidepanelWithSearch` loads
 *   `webextension-polyfill`, which refuses to import outside an extension.
 *
 * The interactive flows behind the buttons (opening the edit dialog, sending
 * the query to the side panel, the preset reset round-trip) are not
 * exercised: driving React state transitions needs a DOM host renderer, and
 * this repository carries no dependency for one. That gap is about depth of
 * interaction, not coverage of exports - the one exported symbol is fully
 * pinned by the assertions below.
 */

import { describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/** Every `soul.$put` request observed by the stubbed RPC client. */
const soulResetRequests: Array<{ json: { content: string } }> = []

/** Every side-panel open request observed by the stubbed messaging module. */
const sidePanelOpenRequests: Array<{
  action: string
  payload: unknown
}> = []

mock.module('@/lib/rpc/RpcClientProvider', () => ({
  useRpcClient: () => ({
    soul: {
      $put: async (request: { json: { content: string } }) => {
        soulResetRequests.push(request)
        return { ok: true }
      },
    },
  }),
}))

mock.module('@/lib/messaging/sidepanel/openSidepanelWithSearch', () => ({
  openSidePanelWithSearch: (
    action: string,
    payload: { query: string; mode: string },
  ) => {
    sidePanelOpenRequests.push({ action, payload })
  },
  onOpenSidePanelWithSearch: {
    addListener: () => {},
    removeListener: () => {},
  },
}))

const { SoulExamples } = await import('./SoulExamples')

function renderSoulExamples(): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SoulExamples),
    ),
  )
}

describe('SoulExamplesTsxContract', () => {
  it('SoulExamples - the only export - renders its full initial surface and stays inert while both dialogs are closed', () => {
    const html = renderSoulExamples()

    // The section introduces itself with its heading and helper copy.
    expect(html).toContain('Shape your agent&#x27;s soul')
    expect(html).toContain(
      'Try these prompts to customize how your agent behaves. Edit the message before sending.',
    )

    // Each canned example renders its label and its full query text.
    expect(html).toContain('Set your tone')
    expect(html).toContain(
      'Be more casual and direct with me. Skip formalities and just get to the point.',
    )
    expect(html).toContain('Add a boundary')
    expect(html).toContain(
      'Never auto-close my tabs without asking first. Add this to your soul.',
    )
    expect(html).toContain('Change personality')
    expect(html).toContain(
      'I want you to be witty and slightly sarcastic, like a smart coworker who enjoys their job.',
    )

    // One "Try it" button per example - exactly three, no more, no less.
    expect(html.match(/>Try it</g)).toHaveLength(3)

    // The reset row renders once, with its own helper copy and button.
    expect(html.match(/>Reset your soul</g)).toHaveLength(1)
    expect(html).toContain('Start fresh with one of the preset personalities')
    expect(html.match(/>Reset</g)).toHaveLength(1)

    // Both dialogs start closed: none of their markup may leak into the
    // initial render - not the edit dialog, not the preset picker, and not
    // the confirm button whose label differs from the row button above.
    expect(html).not.toContain('Edit message')
    expect(html).not.toContain('Customize the prompt before sending')
    expect(html).not.toContain('Pick a personality preset')
    expect(html).not.toContain('This will replace your current soul')
    expect(html).not.toContain('Reset Soul')
    expect(html).not.toContain('Balanced')
    expect(html).not.toContain('Professional')
    expect(html).not.toContain('Friendly')
    expect(html).not.toContain('Minimal')

    // A closed-dialog render stays quiet on every outbound channel.
    expect(soulResetRequests).toHaveLength(0)
    expect(sidePanelOpenRequests).toHaveLength(0)
  })
})
