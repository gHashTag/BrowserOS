/**
 * Contract suite for the exports of ToolbarSettingsCard.tsx.
 *
 * The module exports exactly one symbol: `ToolbarSettingsCard`. The test
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ToolbarSettingsCard`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * How the export is pinned with no live dependency at all: the component
 * is rendered with `renderToString` from `react-dom/server`. React never
 * runs `useEffect` during server rendering, so the effect that reads
 * toolbar preferences through the chrome BrowserOS adapter never fires,
 * and no adapter, network, database or container is touched. What is
 * pinned is therefore the first paint a user sees: a titled card, three
 * always-present setting rows wired label-to-switch, every switch
 * defaulting to on, every switch inert while preferences are still
 * loading, and no vertical-tabs row until capability support is known.
 *
 * Not pinned, and why: the preference-loading effect itself, the
 * vertical-tabs row appearing once `Capabilities.supports` reports
 * support, switch toggles persisting through the adapter, and the
 * failure toast on a rejected update. Reaching any of those needs
 * effects to run and DOM events to be dispatched, and there is no DOM
 * environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile, and `react-test-renderer` does not support React 19. That
 * is a gap in interaction coverage, not an export left unexercised:
 * the single export is rendered and asserted on above, so no export
 * belongs in the blocked list.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import { ToolbarSettingsCard } from './ToolbarSettingsCard'

const renderCard = (): string =>
  renderToString(createElement(ToolbarSettingsCard))

describe('ToolbarSettingsCardTsxContract', () => {
  it('ToolbarSettingsCard paints every switch on and inert until preferences load', () => {
    const html = renderCard()

    // The card is a titled section.
    expect(html).toContain('>Toolbar Settings</h3>')

    // Three always-present rows, each with a name, a helper line, and a
    // switch wired to its label through matching for/id attributes.
    const rows = [
      {
        id: 'show-llm-chat',
        name: 'Show Chat Button',
        helper: 'Display the Chat button in the browser toolbar',
      },
      {
        id: 'show-llm-hub',
        name: 'Show Hub Button',
        helper: 'Display the Hub button in the browser toolbar',
      },
      {
        id: 'show-toolbar-labels',
        name: 'Show Button Labels',
        helper: 'Display text labels next to toolbar button icons',
      },
    ]
    for (const { id, name, helper } of rows) {
      expect(html).toContain(`for="${id}"`)
      expect(html).toContain(`id="${id}"`)
      expect(html).toContain(`>${name}</label>`)
      expect(html).toContain(helper)
    }

    // Rows are presented in the order chat, hub, labels.
    const chatAt = html.indexOf('Show Chat Button')
    const hubAt = html.indexOf('Show Hub Button')
    const labelsAt = html.indexOf('Show Button Labels')
    expect(chatAt).toBeGreaterThanOrEqual(0)
    expect(hubAt).toBeGreaterThan(chatAt)
    expect(labelsAt).toBeGreaterThan(hubAt)

    // Exactly three switches exist, and each one is on.
    expect(html.match(/role="switch"/g)?.length).toBe(3)
    expect(html.match(/aria-checked="true"/g)?.length).toBe(3)
    expect(html).not.toContain('aria-checked="false"')

    // Every switch is inert while preferences are still loading.
    expect(html.match(/data-disabled="" disabled=""/g)?.length).toBe(3)

    // No vertical-tabs row is painted until capability support is known.
    expect(html).not.toContain('Use Vertical Tabs')
    expect(html).not.toContain('vertical-tabs-enabled')
  })
})
