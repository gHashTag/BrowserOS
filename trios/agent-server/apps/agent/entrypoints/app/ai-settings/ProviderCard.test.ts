/**
 * Contract suite for the exports of ProviderCard.tsx.
 *
 * The module exports exactly one symbol: `ProviderCard`. Every assertion
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ProviderCard`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component is purely presentational: it makes no requests and touches
 * no storage, so nothing is mocked and the suite needs no network, no
 * database and no container.
 *
 * Not pinned, and why: the callback props (`onSelect`, `onTest`, `onEdit`,
 * `onDelete`) fire on DOM events - a radio change and button clicks. There
 * is no DOM environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so only the rendered markup is pinned. That is a gap in
 * interaction coverage, not an export left unexercised: the export itself
 * is rendered and asserted on, so no export belongs in the blocked list
 * above.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { LlmProviderConfig } from '@/lib/llm-providers/types'
import { ProviderCard } from './ProviderCard'

interface RenderProps {
  provider: LlmProviderConfig
  isSelected: boolean
  isBuiltIn: boolean
  onSelect: () => void
  onTest?: () => void
  onEdit?: () => void
  onDelete?: () => void
  isTesting?: boolean
}

const anthropicProvider: LlmProviderConfig = {
  id: 'anthropic-1',
  type: 'anthropic',
  name: 'Claude Sonnet',
  baseUrl: 'https://api.anthropic.com',
  modelId: 'claude-sonnet-4',
  supportsImages: true,
  contextWindow: 200000,
  temperature: 0.7,
  createdAt: 0,
  updatedAt: 0,
}

const bareModelProvider: LlmProviderConfig = {
  ...anthropicProvider,
  id: 'openai-1',
  type: 'openai',
  name: 'OpenAI',
  baseUrl: undefined,
  modelId: 'gpt-4o',
}

const builtInProvider: LlmProviderConfig = {
  ...anthropicProvider,
  id: 'browseros-1',
  type: 'browseros',
  name: 'BrowserOS',
  baseUrl: undefined,
  modelId: 'browseros-hosted',
}

/** Renders `ProviderCard`, the module's only export, and returns its markup. */
const render = (overrides: Partial<RenderProps> = {}): string => {
  const props: RenderProps = {
    provider: anthropicProvider,
    isSelected: false,
    isBuiltIn: false,
    onSelect: () => {},
    ...overrides,
  }
  return renderToString(createElement(ProviderCard, props))
}

describe('ProviderCardTsxContract', () => {
  it('renders the card as a labelled default-provider radio control', () => {
    const html = render()

    // The whole card is a <label> wired to the radio inside it, so the
    // provider's id is the link between the two.
    expect(html).toContain('<label for="provider-anthropic-1"')
    expect(html).toContain('<input type="radio" id="provider-anthropic-1"')
    expect(html).toContain('name="default-provider"')
    // The provider's display name is shown.
    expect(html).toContain('>Claude Sonnet</span>')
  })

  it('reflects selection in the radio, the check mark and the DEFAULT badge', () => {
    const selected = render({ isSelected: true })
    const unselected = render({ isSelected: false })

    expect(selected).toContain('checked=""')
    expect(selected).toContain('lucide-check')
    expect(selected).toContain('>DEFAULT</span>')

    expect(unselected).not.toContain('checked=')
    expect(unselected).not.toContain('lucide-check')
    expect(unselected).not.toContain('>DEFAULT<')
  })

  it('describes a custom provider as its model id joined to its base url', () => {
    const html = render()

    expect(html).toContain('>claude-sonnet-4 • https://api.anthropic.com</p>')
  })

  it('falls back to the bare model id when the provider has no base url', () => {
    const html = render({ provider: bareModelProvider })

    expect(html).toContain('>gpt-4o</p>')
    expect(html).not.toContain('•')
  })

  it('renders the icon for the provider type, and the branded logo for built-in providers', () => {
    const custom = render()
    const builtIn = render({ provider: builtInProvider, isBuiltIn: true })

    // A custom provider shows the icon for its own type.
    expect(custom).toContain('<title>Anthropic</title>')
    expect(custom).not.toContain('alt="BrowserOS"')

    // A built-in provider shows the BrowserOS logo instead.
    expect(builtIn).toContain('alt="BrowserOS"')
    expect(builtIn).not.toContain('<title>Anthropic</title>')
  })

  it('shows the built-in card with its hosted-model note and bring-your-own-key link', () => {
    const html = render({ provider: builtInProvider, isBuiltIn: true })

    expect(html).toContain('BrowserOS-hosted model with strict rate limits.')
    expect(html).toContain('for better performance.')
    expect(html).toContain(
      'href="https://docs.browseros.com/features/bring-your-own-llm"',
    )
    expect(html).toContain('>Bring your own key</a>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('offers Test, Edit and delete actions only to custom providers', () => {
    const custom = render()
    const builtIn = render({ provider: builtInProvider, isBuiltIn: true })

    expect(custom).toContain('>Test</button>')
    expect(custom).toContain('>Edit</button>')
    expect(custom).toContain('lucide-trash-2')

    // A built-in provider has no action buttons at all.
    expect(builtIn).not.toContain('<button')
  })

  it('disables the Test action and swaps its label while a test run is in flight', () => {
    const idle = render()
    const testing = render({ isTesting: true })

    expect(idle).toContain('>Test</button>')
    expect(idle).not.toContain('disabled=""')
    expect(idle).not.toContain('animate-spin')

    expect(testing).toContain('>Testing...</button>')
    expect(testing).toContain('disabled=""')
    expect(testing).toContain('animate-spin')
    // Only the Test action is disabled; Edit and delete stay usable.
    expect((testing.match(/disabled=""/g) ?? []).length).toBe(1)
  })
})
