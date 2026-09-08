/**
 * Contract suite for the exports of agent-conversation.artifact-card.tsx.
 *
 * The module exports exactly one symbol: `ArtifactCard`. Every assertion
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation. (`ProducedFileLike` is exported too, but it is a
 * type-only export that vanishes at runtime and exists only to type the
 * `files` prop; the fixtures below use it as exactly that.)
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ArtifactCard`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The card's only live dependency is the preview sheet it hosts: the real
 * `FilePreviewSheet` resolves the agent server's base URL and fetches
 * previews from it over HTTP through react-query, which needs both a
 * provider tree and a reachable server. The sheet module is swapped for a
 * marker stub via `mock.module`, so this suite pins what the card hands
 * to the sheet — hosted, closed, no file selected, until a row is opened
 * — without any network, database or container.
 *
 * Not pinned, and why: user interactions (opening a row to surface the
 * preview sheet, pressing the expand control) dispatch DOM events. There
 * is no DOM environment available to `bun test` in this project —
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile — so only rendered output is pinned, via
 * `renderToStaticMarkup` (chosen over `renderToString` because the latter
 * splices `<!-- -->` markers between adjacent text children, which would
 * make contiguous strings unassertable). That is a gap in interaction
 * coverage, not an export left unexercised: the export itself is rendered
 * and asserted on, so no export belongs in the blocked list above.
 *
 * `ARTIFACT_CARD_SUBJECT_OVERRIDE` points the suite at an alternative
 * copy of the subject module, resolved relative to this file. It exists
 * so a deliberately broken copy can be shown failing this suite; unset,
 * the suite loads the unmodified module it guards.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProducedFileLike } from './agent-conversation.artifact-card'

type StubSheetProps = {
  fileId: string | null
  filePath: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Marker stand-in for the preview sheet: echoes the props the card passed
 * straight into the markup, so the suite can assert on what the card
 * hands over without any provider tree or server.
 */
const FilePreviewSheetStub = ({ fileId, filePath, open }: StubSheetProps) =>
  createElement('aside', {
    'data-sheet': 'file-preview',
    'data-file-id': fileId ?? '',
    'data-file-path': filePath ?? '',
    'data-open': open ? 'true' : 'false',
  })

mock.module('./agent-conversation.file-preview-sheet', () => ({
  FilePreviewSheet: FilePreviewSheetStub,
}))

const { ArtifactCard } = await import(
  // biome-ignore lint/style/noProcessEnv: test-only switch for the broken-copy demonstration
  process.env.ARTIFACT_CARD_SUBJECT_OVERRIDE ??
    './agent-conversation.artifact-card'
)

// Deliberately out of path order, so a passing suite proves the card
// sorts by path rather than echoing the order it was given.
const files: ProducedFileLike[] = [
  { id: 'file-zeta', path: '/run/zeta/archive.zip', size: 3072 },
  { id: 'file-alpha', path: '/run/alpha/report.txt', size: 340 },
  { id: 'file-epsilon', path: '/run/epsilon/figure.png', size: 0 },
  { id: 'file-beta', path: '/run/beta/logo.png', size: 2048 },
  { id: 'file-gamma', path: '/run/gamma/data.csv', size: 1 },
  { id: 'file-delta', path: '/run/delta/notes.md', size: 5242880 },
]

// Path order: alpha, beta, delta, epsilon, gamma, zeta. The first four
// rows render inline; gamma and zeta wait behind the expand control.
const firstShown = 'report.txt'
const secondShown = 'logo.png'
const thirdShown = 'notes.md'
const fourthShown = 'figure.png'
const firstHidden = 'data.csv'
const secondHidden = 'archive.zip'

const render = (props: { files: ProducedFileLike[]; className?: string }) =>
  renderToStaticMarkup(createElement(ArtifactCard, props))

describe('agentConversationArtifactCardTsxContract', () => {
  it('renders sorted rows labelled with names and sizes under a count heading, holds rows past the fourth behind an expand control, and hosts a closed preview sheet', () => {
    // A turn with no produced files renders no card at all.
    expect(render({ files: [] })).toBe('')

    const html = render({ files, className: 'queen-artifact-probe' })

    // The heading counts every file, pluralised, and the caller's
    // className reaches the card's root element.
    expect(html).toContain('6 files produced')
    expect(html).toContain('queen-artifact-probe')

    // Rows appear in path order, not in the order given...
    const firstAt = html.indexOf(firstShown)
    const secondAt = html.indexOf(secondShown)
    const thirdAt = html.indexOf(thirdShown)
    const fourthAt = html.indexOf(fourthShown)
    expect(firstAt).toBeGreaterThanOrEqual(0)
    expect(secondAt).toBeGreaterThan(firstAt)
    expect(thirdAt).toBeGreaterThan(secondAt)
    expect(fourthAt).toBeGreaterThan(thirdAt)

    // ...and each visible row shows its bare file name and a
    // human-readable size.
    expect(html).toContain('340 B')
    expect(html).toContain('2.0 KB')
    expect(html).toContain('5.0 MB')

    // Only the first four rows are inline; the rest hide behind a button
    // that names how many are held back.
    expect(html).not.toContain(firstHidden)
    expect(html).not.toContain(secondHidden)
    expect(html).toContain('>Show 2 more</button>')

    // The preview sheet is hosted but starts closed with nothing
    // selected — state the card owns until a row is opened.
    expect(html).toContain('data-sheet="file-preview"')
    expect(html).toContain('data-open="false"')
    expect(html).toContain('data-file-id=""')

    // At four rows the list fits inline, so every row shows — even the
    // one hidden in the six-file render — and no expand control appears.
    const fourHtml = render({ files: files.slice(0, 4) })
    expect(fourHtml).toContain('4 files produced')
    expect(fourHtml).toContain(fourthShown)
    expect(fourHtml).toContain(secondHidden)
    expect(fourHtml).not.toContain('Show ')

    // A single file gets the singular heading and no expand control.
    const oneHtml = render({ files: [files[1]] })
    expect(oneHtml).toContain('1 file produced')
    expect(oneHtml).toContain(firstShown)
    expect(oneHtml).not.toContain('1 files produced')
    expect(oneHtml).not.toContain('Show ')
  })
})
