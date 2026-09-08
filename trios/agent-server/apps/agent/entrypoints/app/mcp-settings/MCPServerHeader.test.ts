/**
 * Contract suite for the exports of MCPServerHeader.tsx.
 *
 * The module exports exactly one symbol: `MCPServerHeader`. The single
 * `it` below renders that export across its prop states and asserts on
 * the markup it emits, so the suite pins observable behaviour rather
 * than the shape of the implementation, and names the export it covers
 * so a reader can map assertions to exports.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`MCPServerHeader`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * `@/lib/messaging/server/serverMessages` is stubbed via `mock.module`
 * because the real module loads webextension-polyfill, which refuses to
 * load outside a browser extension. Nothing else is stubbed, so this
 * suite needs no network, no database and no container.
 *
 * Not pinned, and why: the click handlers (copying the URL to the
 * clipboard; restarting the server and polling for its health) dispatch
 * DOM events and lean on timers. There is no DOM environment available
 * to `bun test` in this project - `@testing-library`, `happy-dom` and
 * `jsdom` are all absent from the lockfile - so only the rendered
 * output is pinned. That is a gap in interaction coverage, not an
 * export left unexercised: the export itself is rendered and asserted
 * on, so no export belongs in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

mock.module('../../../lib/messaging/server/serverMessages', () => ({
  onServerMessage: () => {},
  sendServerMessage: async () => ({ healthy: true }),
}))

const { MCPServerHeader } = await import('./MCPServerHeader')

type HeaderProps = {
  serverUrl: string | null
  isLoading?: boolean
  error?: string | null
  onServerRestart?: () => void
}

const render = (props: HeaderProps): string =>
  renderToString(
    createElement(MCPServerHeader, {
      isLoading: false,
      error: null,
      ...props,
    }),
  )

/**
 * Opening tag of the rendered control carrying the given title
 * attribute, e.g. the copy and restart buttons. A control the user
 * cannot press carries the `disabled` attribute in the markup.
 */
const controlTag = (html: string, title: string): string => {
  const tag = [...html.matchAll(/<button[^>]*>/g)]
    .map((match) => match[0])
    .find((opening) => opening.includes(`title="${title}"`))
  if (tag === undefined) {
    throw new Error(`rendered markup has no button titled ${title}`)
  }
  return tag
}

describe('MCPServerHeaderTsxContract', () => {
  it('MCPServerHeader renders the server card, URL cell and controls for each prop state', () => {
    // Connected and settled: identity, docs link and URL are all
    // visible, and both controls can be pressed.
    const settled = render({ serverUrl: 'http://127.0.0.1:8117/mcp' })
    expect(settled).toContain('BrowserOS MCP Server')
    expect(settled).toContain(
      'Connect BrowserOS to MCP clients like Claude Code, Gemini CLI and others.',
    )
    expect(settled).toContain(
      'href="https://docs.browseros.com/features/use-with-claude-code"',
    )
    expect(settled).toContain('target="_blank"')
    expect(settled).toContain('rel="noopener noreferrer"')
    expect(settled).toContain('>Docs<')
    expect(settled).toContain('Server URL:')
    expect(settled).toContain('http://127.0.0.1:8117/mcp')
    expect(settled).not.toContain('Loading...')
    expect(controlTag(settled, 'Copy URL')).not.toContain('disabled=""')
    expect(controlTag(settled, 'Restart server')).not.toContain('disabled=""')

    // While the URL is still being fetched: a placeholder replaces the
    // URL and neither control can be pressed.
    const loading = render({
      serverUrl: 'http://127.0.0.1:8117/mcp',
      isLoading: true,
    })
    expect(loading).toContain('Loading...')
    expect(loading).not.toContain('http://127.0.0.1:8117/mcp')
    expect(controlTag(loading, 'Copy URL')).toContain('disabled=""')
    expect(controlTag(loading, 'Restart server')).toContain('disabled=""')

    // When the fetch failed: the error replaces the URL, the copy
    // control has nothing to copy, but a restart is still offered.
    const failed = render({
      serverUrl: null,
      error: 'agent server unreachable',
    })
    expect(failed).toContain('agent server unreachable')
    expect(failed).not.toContain('Loading...')
    expect(controlTag(failed, 'Copy URL')).toContain('disabled=""')
    expect(controlTag(failed, 'Restart server')).not.toContain('disabled=""')

    // Idle before any fetch: the URL cell is empty, copy stays inert
    // and a restart is still offered.
    const idle = render({ serverUrl: null })
    expect(idle).toContain('BrowserOS MCP Server')
    expect(idle).not.toContain('Loading...')
    expect(controlTag(idle, 'Copy URL')).toContain('disabled=""')
    expect(controlTag(idle, 'Restart server')).not.toContain('disabled=""')
  })
})
