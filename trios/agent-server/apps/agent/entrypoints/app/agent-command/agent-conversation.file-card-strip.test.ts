/**
 * Contract suite for the exports of agent-conversation.file-card-strip.tsx.
 *
 * The module exports exactly one symbol: `FileCardStrip`. The single case
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`FileCardStrip`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * No export was blocked by a live dependency. The strip's only sibling
 * with external reach is the preview Sheet, and on first paint that
 * Sheet is closed, so the react-query preview fetch behind its hook
 * never fires (the query is disabled until the sheet opens). The strip
 * is wrapped in a throwaway QueryClientProvider purely to satisfy that
 * hook's context requirement - rendering needs no network, no database
 * and no container.
 *
 * Not pinned, and why: the click semantics documented in the module
 * header (card click opens the preview Sheet; View and the +N chip call
 * `onOpenRail` with the turn id, falling back to null). Dispatching DOM
 * events needs a DOM environment, and `bun test` in this project has
 * none - `@testing-library`, `happy-dom` and `jsdom` are all absent from
 * the lockfile - so only first-paint markup is pinned. That is a gap in
 * interaction coverage, not an export left unexercised: the export
 * itself is rendered and asserted on, so no export belongs in the
 * blocked list above.
 */
import { describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileCardStrip } from './agent-conversation.file-card-strip'

const file = (id: string, path: string, size: number) => ({ id, path, size })

const noop = () => {}

// Fresh client per render: the strip mounts the preview Sheet, whose
// preview hook reads react-query context even while the sheet is closed.
const renderStrip = (
  files: ReadonlyArray<{ id: string; path: string; size: number }>,
  className?: string,
): string =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(FileCardStrip, {
        files,
        onOpenRail: noop,
        ...(className ? { className } : {}),
      }),
    ),
  )

describe('agentConversationFileCardStripTsxContract', () => {
  it('FileCardStrip: renders the produced-files strip (empty turn, single/multi header, path order, 4-card cap with +N overflow, per-card name/size/tooltip, image-vs-text icon, caller className)', () => {
    // A turn that produced no files shows no strip at all.
    expect(renderStrip([])).toBe('')

    // One file: singular header, basename on the card, the full path in
    // the hover tooltip, a human-readable size, the document icon, and
    // a View affordance pointing at the Outputs rail.
    const one = renderStrip([file('f1', '/tmp/report.md', 2048)])
    expect(one).toContain('File produced')
    expect(one).not.toContain('Files produced')
    expect(one).toContain('report.md')
    expect(one).toContain('title="/tmp/report.md"')
    expect(one).toContain('2.0 KB')
    expect(one).toContain('lucide-file-text')
    expect(one).not.toContain('lucide-image')
    expect(one).toContain('View')
    // No overflow chip when nothing was truncated.
    expect(one).not.toContain('+')

    // An image file swaps the document icon for the image icon, keeps
    // the sub-kilobyte size format, and a caller-supplied spacing class
    // lands on the strip container.
    const image = renderStrip([file('i1', '/tmp/shot.png', 700)], 'mt-2')
    expect(image).toContain('lucide-image')
    expect(image).not.toContain('lucide-file-text')
    expect(image).toContain('700 B')
    expect(image).toContain('py-2.5 mt-2')

    // Six files arrive out of order. The plural header carries the
    // total, cards come out in path order regardless of input order,
    // only the first four paths become cards, and the remaining two
    // surface as a +N chip whose tooltip names the hidden count.
    const many = renderStrip([
      file('z', '/out/zeta.txt', 11),
      file('a', '/out/alpha.md', 22),
      file('m', '/out/mike.png', 33),
      file('b', '/out/bravo.pdf', 44),
      file('e', '/out/echo.md', 55),
      file('d', '/out/delta.txt', 66),
    ])
    expect(many).toContain('Files produced (6)')
    const alphaAt = many.indexOf('alpha.md')
    const bravoAt = many.indexOf('bravo.pdf')
    const deltaAt = many.indexOf('delta.txt')
    const echoAt = many.indexOf('echo.md')
    expect(alphaAt).toBeGreaterThanOrEqual(0)
    expect(alphaAt).toBeLessThan(bravoAt)
    expect(bravoAt).toBeLessThan(deltaAt)
    expect(deltaAt).toBeLessThan(echoAt)
    // The fifth and sixth paths by sort order are folded into +N, not
    // rendered as cards.
    expect(many).not.toContain('mike.png')
    expect(many).not.toContain('zeta.txt')
    expect(many).toContain('title="See 2 more in the Outputs rail"')
    expect(many).toContain('+2')
  })
})
