/**
 * Contract suite for the exports of MemoryViewer.tsx.
 *
 * The module exports exactly one symbol: `MemoryViewer`. Every assertion
 * below renders that export with `renderToString` and asserts on the
 * markup it emits, so the suite pins observable behaviour rather than the
 * shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`MemoryViewer`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's only live dependency is the agent server that
 * `./useMemoryContent` fetches from and saves to over HTTP. The hook is
 * swapped for an in-memory stub via `mock.module`, so this suite needs no
 * network, no database and no container.
 *
 * Not pinned, and why:
 * - The editing flow (entering the editor via Edit or Add memory, typing,
 *   saving, cancelling, the inline save-failure message and the disabled
 *   Save/Cancel buttons while a save is in flight) and the mouse-enter
 *   background refetch all require dispatching DOM events. There is no DOM
 *   environment available to `bun test` in this project - `@testing-library`,
 *   `happy-dom` and `jsdom` are all absent from the lockfile - and server
 *   rendering always starts from the closed, viewing state, so those
 *   states cannot be reached.
 * - The memory text itself does not appear in server-rendered markup: the
 *   document body is rendered through Streamdown, which defers markdown
 *   parsing to the client, so the suite pins the viewing branch's document
 *   container rather than the parsed content.
 *
 * Both are gaps in interaction coverage, not exports left unexercised:
 * the export itself is rendered and asserted on, so no export belongs in
 * the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

type UseMemoryContentResult = {
  content: string | null
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<unknown>
  save: (content: string) => Promise<void>
  isSaving: boolean
  saveError: Error | null
  resetSaveError: () => void
}

let hookResult: UseMemoryContentResult

mock.module('./useMemoryContent', () => ({
  useMemoryContent: () => hookResult,
}))

const { MemoryViewer } = await import('./MemoryViewer')

const settledHook: UseMemoryContentResult = {
  content: null,
  isLoading: false,
  error: null,
  refetch: () => Promise.resolve(undefined),
  save: () => Promise.resolve(undefined),
  isSaving: false,
  saveError: null,
  resetSaveError: () => undefined,
}

const render = (overrides: Partial<UseMemoryContentResult>): string => {
  hookResult = { ...settledHook, ...overrides }
  return renderToString(createElement(MemoryViewer))
}

describe('MemoryViewerTsxContract', () => {
  it('renders a spinner placeholder while memory is still loading', () => {
    const html = render({ isLoading: true })

    expect(html).toContain('animate-spin')
    // While loading, neither the document view nor the empty or failure
    // states may leak through.
    expect(html).not.toContain('CORE.md')
    expect(html).not.toContain('No memories yet')
    expect(html).not.toContain('Could not load memory')
  })

  it('renders a load-failure card when fetching memory errors', () => {
    const html = render({ error: new Error('HTTP 500') })

    expect(html).toContain(
      'Could not load memory. Make sure BrowserOS server is running.',
    )
    expect(html).not.toContain('CORE.md')
    expect(html).not.toContain('No memories yet')
    expect(html).not.toContain('animate-spin')
  })

  it('renders an empty-state card inviting creation when no memories exist', () => {
    const html = render({ content: null })

    expect(html).toContain('No memories yet')
    expect(html).toContain('your agent will learn about you')
    expect(html).toContain('Add memory')
    // The empty state is a standalone card: no document header, no edit
    // affordance.
    expect(html).not.toContain('CORE.md')
    expect(html).not.toContain('>Edit<')
  })

  it('treats an empty string of memory content as no memories', () => {
    const html = render({ content: '' })

    expect(html).toContain('No memories yet')
    expect(html).toContain('Add memory')
    expect(html).not.toContain('CORE.md')
  })

  it('renders the memory document view once content has loaded', () => {
    const html = render({ content: 'Prefers concise replies.' })

    expect(html).toContain('CORE.md')
    expect(html).toContain('>editable<')
    expect(html).toContain('>Edit<')
    // The viewing branch renders the document body container produced by
    // the markdown viewer, exactly once.
    expect(html.match(/space-y-4/g) ?? []).toHaveLength(1)
    expect(html).not.toContain('No memories yet')
    expect(html).not.toContain('Could not load memory')
    expect(html).not.toContain('animate-spin')
    // The header announces the viewing state, not the editing one.
    expect(html).not.toContain('editing')
  })
})
