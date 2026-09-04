import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * Contract suite for the single export of ServerSettingsCard.tsx:
 * `ServerSettingsCard`.
 *
 * Scope note (P2). The export itself IS exercised below: its initial render is
 * pinned by the assertions in this suite, which observe the real markup the
 * component produces. What this first suite could NOT pin are the component's
 * interactive flows - opening either confirmation dialog, flipping the remote
 * access preference, the restart handshake with the local MCP server, and the
 * success/error feedback that follows. Exercising those requires dispatching
 * real DOM events and running effects, and this repository's agent test group
 * runs under plain `bun test` with no DOM event harness available: jsdom,
 * happy-dom and testing-library are absent from the dependency tree and cannot
 * be added from a test file. Those flows are named here rather than silently
 * omitted. No export was left unexercised, and the subject source was not
 * modified in any way.
 *
 * The alias bridges below are NOT fakes. `bun test` resolves the `@/` path
 * alias only when invoked from the app package directory, so each aliased
 * specifier the subject (transitively) imports is bridged, via mock.module,
 * to the very same real module that the alias points at. The components,
 * helpers and constants under test are therefore the genuine article in every
 * invocation context.
 */

// The subject's dependency graph transitively imports webextension-polyfill,
// which throws at import time unless a chrome runtime global is present. The
// stub satisfies the guard; every browserOS API probe the adapter performs
// reports "not available" and resolves to a harmless default.
const chromeStub = {
  runtime: { id: 'server-settings-card-contract-suite' },
  browserOS: {} as Record<string, unknown>,
}
;(globalThis as unknown as { chrome?: typeof chromeStub }).chrome = chromeStub

// Bridge the `@/` aliases to the real modules. The real module for an alias is
// imported first and the bridge registered immediately afterwards, in
// dependency order, so every real module's own aliased imports already have
// their bridges in place by the time it loads.
const realUtils = await import('../../../lib/utils')
mock.module('@/lib/utils', () => realUtils)

const realButton = await import('../../../components/ui/button')
const realAlert = await import('../../../components/ui/alert')
const realLabel = await import('../../../components/ui/label')
const realSwitch = await import('../../../components/ui/switch')
mock.module('@/components/ui/button', () => realButton)
mock.module('@/components/ui/alert', () => realAlert)
mock.module('@/components/ui/label', () => realLabel)
mock.module('@/components/ui/switch', () => realSwitch)

const realAlertDialog = await import('../../../components/ui/alert-dialog')
mock.module('@/components/ui/alert-dialog', () => realAlertDialog)

const realAdapter = await import('../../../lib/browseros/adapter')
mock.module('@/lib/browseros/adapter', () => realAdapter)

const realPrefs = await import('../../../lib/browseros/prefs')
const realAnalyticsEvents = await import(
  '../../../lib/constants/analyticsEvents'
)
const realServerMessages = await import(
  '../../../lib/messaging/server/serverMessages'
)
const realTrack = await import('../../../lib/metrics/track')
mock.module('@/lib/browseros/prefs', () => realPrefs)
mock.module('@/lib/constants/analyticsEvents', () => realAnalyticsEvents)
mock.module('@/lib/messaging/server/serverMessages', () => realServerMessages)
mock.module('@/lib/metrics/track', () => realTrack)

const { ServerSettingsCard } = await import('./ServerSettingsCard')

function renderCard(): string {
  return renderToStaticMarkup(React.createElement(ServerSettingsCard))
}

describe('ServerSettingsCardTsxContract', () => {
  it('ServerSettingsCard renders its initial settings state: titled card, wired remote-access switch and restart control, both disabled while the stored preference loads, with no dialog or error surface', () => {
    const markup = renderCard()

    // Card identity and descriptive copy.
    expect(markup).toContain(
      '<h2 class="mb-1 font-semibold text-xl">MCP Server Settings</h2>',
    )
    expect(markup).toContain('Configure local MCP server options')
    expect(markup).toContain('Allow MCP clients from other devices to connect')

    // The remote-access control is a real switch, correctly wired to its
    // label, starting unchecked and disabled until the stored preference
    // has been read (the initial isLoading state).
    const label = markup.match(/<label[^>]*for="allow-remote"[^>]*>/)
    expect(label).not.toBeNull()
    expect(markup).toContain('Allow External Access</label>')
    const switchButton = markup.match(/<button[^>]*role="switch"[^>]*>/)
    expect(switchButton).not.toBeNull()
    expect(switchButton?.[0]).toContain('id="allow-remote"')
    expect(switchButton?.[0]).toContain('aria-checked="false"')
    expect(switchButton?.[0]).toContain('data-state="unchecked"')
    expect(switchButton?.[0]).toContain('data-disabled=""')
    expect(switchButton?.[0]).toContain('disabled')

    // The restart control is labeled, described, and likewise disabled
    // during the initial load.
    expect(markup).toContain('Restart MCP Server</span>')
    expect(markup).toContain('Restart local MCP server')
    expect(markup).toContain('>Restart</button>')
    const restartButton = markup.match(/<button[^>]*data-slot="button"[^>]*>/)
    expect(restartButton).not.toBeNull()
    expect(restartButton?.[0]).toContain('disabled')

    // Nothing interactive is pre-opened and nothing has failed yet: both
    // confirmation dialogs stay closed (their question-form titles are
    // absent), the restart overlay is not shown, and no error alert is
    // rendered before any user action.
    expect(markup).not.toContain('Allow External Access?')
    expect(markup).not.toContain('Restart MCP Server?')
    expect(markup).not.toContain('Restarting server...')
    expect(markup).not.toContain('Server Error')
  })
})
