/**
 * Contract suite for the exports of workspace-selector.tsx.
 *
 * The module exports exactly one symbol: `WorkspaceSelector`. Every
 * assertion below renders that export and asserts on the markup it
 * emits, so the suite pins observable behaviour rather than the shape
 * of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`WorkspaceSelector`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's live dependencies are stubbed with `mock.module`:
 * `@/lib/workspace/use-workspace` reads and writes the extension's
 * workspace storage (`@wxt-dev/storage`, a browser-API-backed store
 * whose state this suite could not otherwise reach), so the hook is
 * swapped for an in-memory stub whose state the suite controls. The
 * Radix `@/components/ui/popover` primitives mount their panel through
 * a portal that only a live DOM can drive, so they are swapped for
 * pass-through components that render the panel inline; every string
 * asserted on below is markup the component itself authors. The suite
 * therefore needs no network, no database and no container.
 *
 * Not pinned, and why: the panel starts closed, and every interaction
 * - opening it, typing a filter into the search field, choosing a
 * folder, clearing the selection, removing a recent, picking a new
 * folder - dispatches DOM events through Radix and cmdk widgets. There
 * is no DOM environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so only the rendered output is pinned. That is a gap in
 * interaction coverage, not an export left unexercised: the export
 * itself is rendered and asserted on, so no export belongs in the
 * blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { createElement, Fragment } from 'react'
import { renderToString } from 'react-dom/server'

type WorkspaceFolderLike = {
  id: string
  name: string
  path: string
  addedAt: number
}

type HookStub = {
  recentFolders: WorkspaceFolderLike[]
  selectedFolder: WorkspaceFolderLike | null
  // Only ever reached from DOM event handlers, which this suite cannot
  // dispatch; they exist so the hook's shape is complete.
  selectFolder: (folder: WorkspaceFolderLike) => Promise<void>
  addFolder: (folder: WorkspaceFolderLike) => Promise<void>
  removeFolder: (id: string) => Promise<void>
  clearSelection: () => Promise<void>
}

let hookStub: HookStub = freshHookStub()

function freshHookStub(): HookStub {
  return {
    recentFolders: [],
    selectedFolder: null,
    selectFolder: () => Promise.resolve(),
    addFolder: () => Promise.resolve(),
    removeFolder: () => Promise.resolve(),
    clearSelection: () => Promise.resolve(),
  }
}

mock.module('@/lib/workspace/use-workspace', () => ({
  useWorkspace: () => hookStub,
}))

type PopoverMockProps = { children?: ReactNode }

// The panel renders inline instead of through a Radix portal, so its
// content is observable to renderToString.
const panelShell = ({ children }: PopoverMockProps) =>
  createElement(Fragment, null, children)
const triggerShell = ({ children }: PopoverMockProps) => children

mock.module('@/components/ui/popover', () => ({
  Popover: panelShell,
  PopoverTrigger: triggerShell,
  PopoverContent: panelShell,
}))

const { WorkspaceSelector } = await import('./workspace-selector')

const alphaFolder: WorkspaceFolderLike = {
  id: 'folder-alpha',
  name: 'Alpha',
  path: '/tmp/alpha',
  addedAt: 1,
}

const betaFolder: WorkspaceFolderLike = {
  id: 'folder-beta',
  name: 'Beta',
  path: '/tmp/beta',
  addedAt: 2,
}

const render = (stub: Partial<HookStub>): string => {
  hookStub = { ...freshHookStub(), ...stub }
  return renderToString(
    createElement(
      WorkspaceSelector,
      null,
      createElement('button', { type: 'button' }, 'Pick a workspace'),
    ),
  )
}

// A chosen mark is the check icon the panel puts next to the option
// that is currently in force. Counting them pins "exactly one option
// is marked as chosen" without depending on which row renders it.
const chosenMarkCount = (html: string): number =>
  (html.match(/lucide-check/g) ?? []).length

// The two rows mark themselves with distinguishable check styling: the
// no-workspace default adds a shrink-0 utility class the folder rows
// omit, so the two class strings never occur inside one another.
const noSelectionMark =
  'class="lucide lucide-check h-4 w-4 shrink-0 text-[var(--accent-orange)]"'
const selectedFolderMark =
  'class="lucide lucide-check h-4 w-4 text-[var(--accent-orange)]"'

describe('workspaceSelectorTsxContract', () => {
  it('WorkspaceSelector renders the caller-supplied children as its trigger, ahead of the panel', () => {
    const html = render({})

    const triggerAt = html.indexOf('Pick a workspace')
    const panelAt = html.indexOf('No workspace')
    expect(triggerAt).toBeGreaterThanOrEqual(0)
    expect(panelAt).toBeGreaterThan(triggerAt)
  })

  it('WorkspaceSelector marks the no-workspace default as chosen while nothing is selected and nothing is recent', () => {
    const html = render({ recentFolders: [], selectedFolder: null })

    expect(html).toContain('placeholder="Search folders..."')
    expect(html).toContain('No workspace')
    expect(html).toContain('AI works with tabs only')
    // The default row carries the one chosen mark in the panel.
    expect(chosenMarkCount(html)).toBe(1)
    expect(html).toContain(noSelectionMark)
    expect(html).not.toContain(selectedFolderMark)
    // No recent folders means no Recent group and nothing to remove.
    expect(html).not.toContain('>Recent</div>')
    expect(html).not.toContain('from recents')
    expect(html).toContain('Choose a different folder')
  })

  it('WorkspaceSelector lists every recent folder with its path and a per-folder remove control', () => {
    const html = render({ recentFolders: [alphaFolder, betaFolder] })

    expect(html).toContain('Alpha')
    expect(html).toContain('/tmp/alpha')
    expect(html).toContain('Beta')
    expect(html).toContain('/tmp/beta')
    expect(html).toContain('aria-label="Remove Alpha from recents"')
    expect(html).toContain('aria-label="Remove Beta from recents"')
    // Recents follow the no-workspace default and precede the chooser.
    const defaultAt = html.indexOf('No workspace')
    const recentAt = html.indexOf('>Recent</div>')
    const chooserAt = html.indexOf('Choose a different folder')
    expect(defaultAt).toBeGreaterThanOrEqual(0)
    expect(recentAt).toBeGreaterThan(defaultAt)
    expect(chooserAt).toBeGreaterThan(recentAt)
  })

  it('WorkspaceSelector moves the chosen mark from the default to the selected folder only', () => {
    const html = render({
      recentFolders: [alphaFolder, betaFolder],
      selectedFolder: alphaFolder,
    })

    // The default row stays available but is no longer marked chosen.
    expect(html).toContain('No workspace')
    expect(html).not.toContain(noSelectionMark)
    expect(html).toContain(selectedFolderMark)
    // Exactly one chosen mark in the whole panel: Alpha's, not Beta's.
    expect(chosenMarkCount(html)).toBe(1)
  })
})
