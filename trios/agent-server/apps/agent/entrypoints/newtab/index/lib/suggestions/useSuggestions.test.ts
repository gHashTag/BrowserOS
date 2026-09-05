/**
 * Contract suite for the exports of useSuggestions.ts.
 *
 * The module exports exactly two symbols: `useSuggestions` and
 * `getSuggestionLabel`. Every assertion below drives those exports and
 * asserts on the values they produce, so the suite pins observable
 * behaviour rather than the shape of the implementation. The subject is
 * used as it stands today; nothing about it was changed to make this
 * suite pass.
 *
 * Export accounting (the module has 2 exports in total):
 *   - exercised by assertions below: 2 (`useSuggestions`, `getSuggestionLabel`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 2 + 0 = 2, matching the export count of the module.
 *
 * Live dependencies, stubbed via `mock.module` so the suite needs no
 * network, no database and no container:
 *   - `useSearchProvider` (@/lib/search-provider/search-provider-storage)
 *     reads the active engine from extension storage (`@wxt-dev/storage`
 *     over chrome.storage), which does not exist under `bun test`. The
 *     stub serves a controlled provider per scenario. The real
 *     `getProviderConfig` stays in play, so the provider-to-config flow
 *     through the subject is still pinned for real.
 *   - `useSearchSuggestions` (../searchSuggestions/useSearchSuggestions)
 *     fetches engine suggestion endpoints over HTTP through SWR. The
 *     stub serves a controlled result list per scenario.
 *   - `useAITabSuggestions` (../aiTabSuggestions/useAITabSuggestions) is
 *     pure and needs no stub, but one is installed anyway so the AI
 *     section can be driven deterministically - including the
 *     tabs-selected-but-no-actions state, which the real catalogue can
 *     never produce - without pinning that catalogue here.
 *
 * `useBrowserOSSuggestions` and `getProviderConfig` run for real: both
 * are pure, and keeping them live lets the suite observe the subject
 * through genuine inputs (the browserOS message is the trimmed query,
 * the section title carries the configured engine name).
 *
 * The hook itself is exercised through `renderToString` with a probe
 * component that records what the hook returns, so the full React
 * render path runs under a real renderer with no DOM required.
 */
import { describe, expect, it, mock } from 'bun:test'
import { Bot, type LucideIcon } from 'lucide-react'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { SearchProviders } from '../searchSuggestions/SearchProviders'
import type { SuggestionSection } from './types'

let providerFromStorage: SearchProviders = 'google'
let searchResultsFromApi: string[] | undefined
let aiTabResults: Array<{
  name: string
  icon: LucideIcon
  description: string
  minTabs: number
  maxTabs: number
}> = []

mock.module('@/lib/search-provider/search-provider-storage', () => ({
  useSearchProvider: () => ({
    provider: providerFromStorage,
    setProvider: async () => {},
  }),
}))

mock.module('../searchSuggestions/useSearchSuggestions', () => ({
  useSearchSuggestions: () => ({ data: searchResultsFromApi }),
}))

mock.module('../aiTabSuggestions/useAITabSuggestions', () => ({
  useAITabSuggestions: () => aiTabResults,
}))

const { useSuggestions, getSuggestionLabel } = await import('./useSuggestions')

type UseSuggestionsResult = ReturnType<typeof useSuggestions>

let captured: UseSuggestionsResult | undefined

function Probe({
  args,
}: {
  args: { query: string; selectedTabs: chrome.tabs.Tab[] }
}) {
  captured = useSuggestions(args)
  return null
}

function renderSubject(args: {
  query: string
  selectedTabs: chrome.tabs.Tab[]
}): UseSuggestionsResult {
  captured = undefined
  renderToString(createElement(Probe, { args }))
  if (!captured) {
    throw new Error('the probe component never ran')
  }
  return captured
}

const twoTabs = [{ id: 1 }, { id: 2 }] as unknown as chrome.tabs.Tab[]
const noTabs: chrome.tabs.Tab[] = []

const sectionIds = (sections: SuggestionSection[]) => sections.map((s) => s.id)

describe('useSuggestionsContract', () => {
  it('useSuggestions builds suggestion sections from query, tabs and provider', () => {
    // A padded query with duplicates and blanks in the engine results:
    // the trimmed query comes first, then the engine results, case
    // folded for de-duplication, blanks dropped. Both a browserOS
    // section (message = trimmed query) and a search section appear.
    providerFromStorage = 'google'
    searchResultsFromApi = [
      'weather forecast',
      ' Weather ',
      '',
      'weather radar',
      'weather',
    ]
    aiTabResults = []

    const padded = renderSubject({
      query: '  weather  ',
      selectedTabs: noTabs,
    })

    expect(padded.providerConfig.name).toBe('Google')
    expect(sectionIds(padded.sections)).toEqual(['browseros', 'search'])

    const [browserOsSection, searchSection] = padded.sections
    expect(browserOsSection.id).toBe('browseros')
    expect(browserOsSection.title).toBe('')
    expect(browserOsSection.items).toEqual([
      {
        id: 'browseros-0',
        type: 'browseros',
        mode: 'agent',
        message: 'weather',
      },
    ])
    expect(searchSection.id).toBe('search')
    expect(searchSection.title).toBe('Google Search')
    expect(searchSection.items).toEqual([
      { id: 'search-0', type: 'search', query: 'weather' },
      { id: 'search-1', type: 'search', query: 'weather forecast' },
      { id: 'search-2', type: 'search', query: 'weather radar' },
    ])
    expect(padded.flatItems).toEqual([
      ...browserOsSection.items,
      ...searchSection.items,
    ])

    // Tabs selected with an available AI action: the AI Actions section
    // replaces the search section even though engine results exist, the
    // engine name in the returned config follows the stored provider,
    // and every action field is carried through.
    providerFromStorage = 'duckduckgo'
    searchResultsFromApi = ['compare notes ideas']
    aiTabResults = [
      {
        name: 'Summarize selected tabs',
        icon: Bot,
        description: 'Summarise the content from all selected tabs.',
        minTabs: 2,
        maxTabs: 5,
      },
    ]

    const withTabs = renderSubject({
      query: 'compare notes',
      selectedTabs: twoTabs,
    })

    expect(withTabs.providerConfig.name).toBe('DuckDuckGo')
    expect(sectionIds(withTabs.sections)).toEqual(['browseros', 'ai-actions'])

    const [browserOsAgain, aiSection] = withTabs.sections
    expect(browserOsAgain.items).toEqual([
      {
        id: 'browseros-0',
        type: 'browseros',
        mode: 'agent',
        message: 'compare notes',
      },
    ])
    expect(aiSection.id).toBe('ai-actions')
    expect(aiSection.title).toBe('AI Actions')
    expect(aiSection.items).toEqual([
      {
        id: 'ai-tab-0',
        type: 'ai-tab',
        name: 'Summarize selected tabs',
        icon: Bot,
        description: 'Summarise the content from all selected tabs.',
        minTabs: 2,
        maxTabs: 5,
      },
    ])
    expect(withTabs.flatItems).toEqual([
      ...browserOsAgain.items,
      ...aiSection.items,
    ])
    expect(withTabs.sections.some((s) => s.id === 'search')).toBe(false)

    // Tabs selected but no AI action available: the search section
    // comes back, seeded with the query itself.
    providerFromStorage = 'google'
    searchResultsFromApi = ['plan trip']
    aiTabResults = []

    const withoutActions = renderSubject({
      query: 'plan trip',
      selectedTabs: [{ id: 7 }] as unknown as chrome.tabs.Tab[],
    })

    expect(sectionIds(withoutActions.sections)).toEqual(['browseros', 'search'])
    expect(withoutActions.sections[1].items).toEqual([
      { id: 'search-0', type: 'search', query: 'plan trip' },
    ])

    // A query of nothing but whitespace gates every section off, even
    // with engine results waiting.
    searchResultsFromApi = ['leftover']

    const blank = renderSubject({ query: '   ', selectedTabs: noTabs })

    expect(blank.sections).toEqual([])
    expect(blank.flatItems).toEqual([])
  })

  it('getSuggestionLabel returns the display text of each suggestion kind', () => {
    expect(
      getSuggestionLabel({
        id: 'search-0',
        type: 'search',
        query: 'weather radar',
      }),
    ).toBe('weather radar')

    expect(
      getSuggestionLabel({
        id: 'ai-tab-0',
        type: 'ai-tab',
        name: 'Summarize selected tabs',
        icon: Bot,
        description: 'Summarise the content from all selected tabs.',
        minTabs: 2,
        maxTabs: 5,
      }),
    ).toBe('Summarize selected tabs')

    expect(
      getSuggestionLabel({
        id: 'browseros-0',
        type: 'browseros',
        mode: 'chat',
        message: 'hello there',
      }),
    ).toBe('hello there')
  })
})
