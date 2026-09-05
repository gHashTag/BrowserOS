/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The first suite for
 * entrypoints/app/agent-command/agent-conversation.file-preview-sheet.tsx
 * (trios#1543). The module exports one symbol and, until this file, no test
 * anywhere named it. This is not a rewrite and the subject is not touched:
 * the behaviour that already exists is pinned, so the next change to the
 * file has something to fail against.
 *
 * EXPORTS THIS SUITE COULD NOT PIN: none (0 of 1). The one export,
 * FilePreviewSheet, is exercised throughout the `FilePreviewSheet`
 * describe below, so every assertion maps to that symbol.
 *
 * The sheet is a browser-side React component, so the suite runs it in a
 * happy-dom window registered on globalThis — no browser, no network, no
 * container, nothing leaves the process. The subject's two live data
 * sources are stood in for, the same convention as
 * tests/api/routes/queen-lease.test.ts:
 *
 *  - `useAgentServerUrl` (which reads extension capabilities) returns a
 *    controllable base URL, so the "server unreachable" paths are reachable
 *    without disconnecting anything real.
 *  - `useFilePreview` (which fetches over HTTP through react-query) returns
 *    a controllable { preview, loading, error } triple, so every branch of
 *    the FilePreview union is decidable by what a test plants there.
 *
 * Everything else is real: the Radix sheet stack, the size/path formatting
 * helpers, the download URL builder, and sonner's toast store (observed
 * through useSonner, not mocked).
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import { Window } from 'happy-dom'
import type { ReactNode } from 'react'

// ---------------------------------------------------------------------------
// A real DOM, registered on globalThis.
//
// The happy-dom Window is a realm of its own: it carries the ECMAScript
// intrinsics (Object, Array, Promise, ...) alongside the DOM classes.
// Installing its intrinsics onto this process's globalThis would replace
// the very machinery the test runner runs on, so those stay out. Bun's own
// runtime essentials (console, crypto, performance, process, timers,
// encoders, streams) stay too. Everything else — the DOM-shaped classes —
// is installed OVERRIDING any web-API global bun already defined, so that
// `instanceof` checks inside happy-dom, React and Radix all agree on one
// Event/Node/Element realm. Without the override, Radix dispatches bun
// Events into happy-dom listeners and every one is rejected.
// ---------------------------------------------------------------------------

const win = new Window()
const ES_INTRINSICS = new Set([
  'globalThis',
  'eval',
  'isFinite',
  'isNaN',
  'parseInt',
  'parseFloat',
  'Infinity',
  'NaN',
  'undefined',
  'Object',
  'Function',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'BigInt',
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'JSON',
  'Math',
  'Date',
  'RegExp',
  'Promise',
  'Proxy',
  'Reflect',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'FinalizationRegistry',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Atomics',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
  'BigInt64Array',
  'BigUint64Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'AsyncFunction',
  'GeneratorFunction',
  'WebAssembly',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'unescape',
])
const KEEP_BUN = new Set([
  'window',
  'self',
  'document',
  'location',
  'top',
  'parent',
  'frames',
  'console',
  'crypto',
  'performance',
  'process',
  'Buffer',
  'fetch',
  'navigator',
  'queueMicrotask',
  'structuredClone',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'TextEncoder',
  'TextDecoder',
  'MessageChannel',
  'MessagePort',
  'AbortController',
  'AbortSignal',
  'URL',
  'URLSearchParams',
  'Blob',
  'File',
  'FormData',
  'Headers',
  'Request',
  'Response',
  'WebSocket',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'ByteLengthQueuingStrategy',
  'CountQueuingStrategy',
  'CompressionStream',
  'DecompressionStream',
  'atob',
  'btoa',
])

for (const key of Object.getOwnPropertyNames(win)) {
  if (ES_INTRINSICS.has(key) || KEEP_BUN.has(key)) continue
  try {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: (win as unknown as Record<string, unknown>)[key],
    })
  } catch {
    /* accessor-only property on the window instance — skip */
  }
}
for (const key of ['window', 'document']) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === 'window' ? win : win.document,
  })
}

// React only warns-and-recovers without this flag; the suite drives every
// update through act(), so the warnings would all be false alarms.
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Data sources, stood in for.
//
// Both real modules are snapshotted before the mock and put back by hand in
// afterAll: `mock.restore()` does NOT undo `mock.module` in bun 1.3, and a
// live namespace would be overwritten in place by the mock — the same two
// facts recorded in tests/api/queen-roadmap.test.ts.
// ---------------------------------------------------------------------------

const realAgentFiles = { ...(await import('@/lib/agent-files')) }
const realProviders = {
  ...(await import('@/lib/browseros/useBrowserOSProviders')),
}

type PreviewState = {
  preview: (typeof realAgentFiles)['FilePreview'] | null
  loading: boolean
  error: Error | null
}

let agentBaseUrl: string | null = 'http://agent.local:1'
let previewState: PreviewState = {
  preview: null,
  loading: false,
  error: null,
}

mock.module('@/lib/browseros/useBrowserOSProviders', () => ({
  ...realProviders,
  useAgentServerUrl: () => ({
    baseUrl: agentBaseUrl,
    isLoading: false,
    error: null,
  }),
}))
mock.module('@/lib/agent-files', () => ({
  ...realAgentFiles,
  useFilePreview: () => previewState,
}))

// Imported only after the stand-ins are in place, so the subject's
// `@/lib/...` imports resolve against them.
const { FilePreviewSheet } = await import(
  './agent-conversation.file-preview-sheet'
)
const { useSonner } = await import('sonner')
const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
type Root = import('react-dom/client').Root

// ---------------------------------------------------------------------------
// Toast observation.
//
// sonner's store is module-level, so toasts fired by the subject land there
// even with no <Toaster> mounted. useSonner() subscribes to that store; a
// null-rendering probe next to the subject records every toast it sees, by
// id, so a test can count how many were fired (not just how many are
// currently on screen).
// ---------------------------------------------------------------------------

type ObservedToast = {
  id: number | string
  title: ReactNode
  description: unknown
}
const observedToasts: ObservedToast[] = []

function ToastProbe() {
  const { toasts } = useSonner()
  for (const t of toasts) {
    if (!observedToasts.some((seen) => seen.id === t.id)) {
      observedToasts.push({
        id: t.id,
        title: t.title,
        description: (t as { description?: unknown }).description,
      })
    }
  }
  return null
}

// sonner defers every store update through a setTimeout (its own
// batching workaround), so the store only settles a macrotask after the
// subject fires a toast. The suite awaits exactly that.
async function settleToaster() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

// ---------------------------------------------------------------------------
// Render harness.
// ---------------------------------------------------------------------------

type SheetProps = {
  fileId: string | null
  filePath: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

let mountedCleanups: Array<() => void> = []

function mountSubject(initial: SheetProps) {
  let props = initial
  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  let root: Root | undefined
  const renderTree = () =>
    createElement(
      'div',
      null,
      createElement(ToastProbe),
      createElement(FilePreviewSheet, props),
    )
  act(() => {
    root = createRoot(container)
    root.render(renderTree())
  })
  const rerenderWith = (next: SheetProps) => {
    props = next
    act(() => {
      root.render(renderTree())
    })
  }
  mountedCleanups.push(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })
  return { rerenderWith }
}

/** The rendered sheet dialog, or null when the sheet is closed. */
function dialog(): Element | null {
  return win.document.querySelector('[role="dialog"]')
}

/** Deep text of the open sheet body — everything below the header. */
function dialogText(): string {
  return dialog()?.textContent ?? ''
}

function findButton(label: string): HTMLButtonElement | undefined {
  return (
    Array.from(
      dialog()?.querySelectorAll('button') ?? [],
    ) as HTMLButtonElement[]
  ).find((b) => b.textContent?.trim() === label)
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }),
    )
  })
}

beforeEach(() => {
  agentBaseUrl = 'http://agent.local:1'
  previewState = { preview: null, loading: false, error: null }
  observedToasts.length = 0
})

afterEach(() => {
  for (const cleanup of mountedCleanups) cleanup()
  mountedCleanups = []
})

afterAll(() => {
  mock.module('@/lib/agent-files', () => realAgentFiles)
  mock.module('@/lib/browseros/useBrowserOSProviders', () => realProviders)
  // The DOM globals deliberately stay installed for the life of the
  // process: Radix's unmount path schedules `setTimeout(() => new
  // CustomEvent(...))` cleanups that can fire after this file finishes,
  // and tearing the classes out from under them turns harmless timers
  // into unhandled errors that bleed into sibling test files.
})

// ---------------------------------------------------------------------------

describe('agentConversationFilePreviewSheetTsxContract', () => {
  describe('FilePreviewSheet', () => {
    it('titles the sheet with the basename and describes it with the full path', () => {
      previewState = {
        preview: {
          kind: 'text',
          mimeType: 'text/plain',
          size: 8,
          mtimeMs: 1,
          snippet: 'contents',
          truncated: false,
        },
        loading: false,
        error: null,
      }
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/nested/report.txt',
        open: true,
        onOpenChange: () => {},
      })

      const heading = dialog()?.querySelector('h2')
      expect(heading?.textContent).toBe('report.txt')
      const described = win.document.querySelector(
        '[role="dialog"] p',
      )
      expect(described?.textContent).toBe('ws/nested/report.txt')
    })

    it('falls back to the generic title and an empty description when the path is unknown', () => {
      previewState = {
        preview: {
          kind: 'text',
          mimeType: 'text/plain',
          size: 8,
          mtimeMs: 1,
          snippet: 'contents',
          truncated: false,
        },
        loading: false,
        error: null,
      }
      mountSubject({
        fileId: 'f-1',
        filePath: null,
        open: true,
        onOpenChange: () => {},
      })

      expect(dialog()?.querySelector('h2')?.textContent).toBe(
        'File preview',
      )
      expect(
        win.document.querySelector('[role="dialog"] p')?.textContent,
      ).toBe('')
    })

    it('renders no dialog while closed', () => {
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/report.txt',
        open: false,
        onOpenChange: () => {},
      })
      expect(dialog()).toBeNull()
    })

    it('shows the loading skeleton while the preview loads', () => {
      previewState = {
        preview: null,
        loading: true,
        error: null,
      }
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/report.txt',
        open: true,
        onOpenChange: () => {},
      })
      expect(dialogText()).toContain('Loading preview...')
      expect(dialog()?.querySelector('img')).toBeNull()
      expect(dialog()?.querySelector('pre')).toBeNull()
    })

    it('shows the failure inline in the sheet body when the preview errors', () => {
      previewState = {
        preview: null,
        loading: false,
        error: new Error('workspace vanished'),
      }
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/report.txt',
        open: true,
        onOpenChange: () => {},
      })
      expect(dialogText()).toContain('Could not load preview')
      expect(dialogText()).toContain('workspace vanished')
    })

    it('raises one failure toast per file while the sheet stays open, and re-arms after close/reopen', async () => {
      const failing: PreviewState = {
        preview: null,
        loading: false,
        error: new Error('workspace vanished'),
      }
      const props = (open: boolean): SheetProps => ({
        fileId: 'f-1',
        filePath: 'ws/report.txt',
        open,
        onOpenChange: () => {},
      })
      const { rerenderWith } = mountSubject(props(true))
      previewState = failing
      rerenderWith(props(true)) // error lands while open
      await settleToaster()
      expect(observedToasts.length).toBe(1)
      expect(String(observedToasts[0]?.title)).toBe('Could not load preview')
      expect(String(observedToasts[0]?.description)).toBe(
        'workspace vanished',
      )

      // Same file, same error, sheet still open: no second toast.
      previewState = { ...failing }
      rerenderWith(props(true))
      await settleToaster()
      expect(observedToasts.length).toBe(1)

      // Close (parent drops `open`), then reopen: the failure toasts again.
      rerenderWith(props(false))
      rerenderWith(props(true))
      await settleToaster()
      expect(observedToasts.length).toBe(2)
    })

    it('renders the missing-workspace notice when the file is gone', () => {
      previewState = {
        preview: { kind: 'missing' },
        loading: false,
        error: null,
      }
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/gone.txt',
        open: true,
        onOpenChange: () => {},
      })
      expect(dialogText()).toContain(
        'This file is no longer in the workspace',
      )
    })

    it('renders an image preview from the data URL with the path as alt text', () => {
      previewState = {
        preview: {
          kind: 'image',
          mimeType: 'image/png',
          size: 2048,
          mtimeMs: 1,
          dataUrl: 'data:image/png;base64,AAAA',
        },
        loading: false,
        error: null,
      }
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/shot.png',
        open: true,
        onOpenChange: () => {},
      })
      const img = dialog()?.querySelector('img')
      expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
      expect(img?.getAttribute('alt')).toBe('ws/shot.png')
      // The metadata row shows the real formatted size and the MIME type.
      expect(dialogText()).toContain('2.0 KB')
      expect(dialogText()).toContain('image/png')
    })

    it('renders the no-inline-PDF notice for PDFs', () => {
      previewState = {
        preview: {
          kind: 'pdf',
          mimeType: 'application/pdf',
          size: 1024 * 1024,
          mtimeMs: 1,
        },
        loading: false,
        error: null,
      }
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/paper.pdf',
        open: true,
        onOpenChange: () => {},
      })
      expect(dialogText()).toContain(
        "PDF previews aren't supported inline yet",
      )
    })

    it('renders the no-inline-preview notice with a download hint while the server is reachable', () => {
      previewState = {
        preview: {
          kind: 'binary',
          mimeType: 'application/zip',
          size: 5 * 1024 * 1024,
          mtimeMs: 1,
        },
        loading: false,
        error: null,
      }
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/archive.zip',
        open: true,
        onOpenChange: () => {},
      })
      expect(dialogText()).toContain('No inline preview for this file type.')
      expect(dialogText()).toContain('Use Download to save it locally.')
    })

    it('omits the download hint when the agent server is unreachable', () => {
      agentBaseUrl = null
      previewState = {
        preview: {
          kind: 'binary',
          mimeType: 'application/zip',
          size: 5 * 1024 * 1024,
          mtimeMs: 1,
        },
        loading: false,
        error: null,
      }
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/archive.zip',
        open: true,
        onOpenChange: () => {},
      })
      expect(dialogText()).toContain('No inline preview for this file type.')
      expect(dialogText()).not.toContain('Use Download to save it locally.')
    })

    it('renders a text preview as a code block with its metadata', () => {
      previewState = {
        preview: {
          kind: 'text',
          mimeType: 'text/plain',
          size: 4096,
          mtimeMs: 1,
          snippet: 'line one\nline two',
          truncated: false,
        },
        loading: false,
        error: null,
      }
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/notes.txt',
        open: true,
        onOpenChange: () => {},
      })
      expect(
        dialog()?.querySelector('pre code')?.textContent,
      ).toBe('line one\nline two')
      expect(dialogText()).toContain('4.0 KB')
      expect(dialogText()).not.toContain(
        'Showing the first part of this file',
      )
    })

    it('notes when a text preview was truncated', () => {
      previewState = {
        preview: {
          kind: 'text',
          mimeType: 'text/plain',
          size: 4096,
          mtimeMs: 1,
          snippet: 'line one',
          truncated: true,
        },
        loading: false,
        error: null,
      }
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/notes.txt',
        open: true,
        onOpenChange: () => {},
      })
      expect(dialogText()).toContain('Showing the first part of this file')
    })

    it('renders markdown files through the markdown renderer, not a code block', () => {
      previewState = {
        preview: {
          kind: 'text',
          mimeType: 'text/markdown',
          size: 2048,
          mtimeMs: 1,
          snippet: '# Title\n\n**bold move**',
          truncated: false,
        },
        loading: false,
        error: null,
      }
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/readme.md',
        open: true,
        onOpenChange: () => {},
      })
      // The markdown renderer interprets the snippet: the heading text
      // arrives rendered, the emphasis markers are consumed, and the
      // raw-snippet code block the plain-text path uses is absent.
      expect(dialog()?.querySelector('pre')).toBeNull()
      expect(dialogText()).toContain('Title')
      expect(dialogText()).toContain('bold move')
      expect(dialogText()).not.toContain('**')
    })

    it('offers Download only when a file is selected', () => {
      const { rerenderWith } = mountSubject({
        fileId: null,
        filePath: 'ws/orphan.txt',
        open: true,
        onOpenChange: () => {},
      })
      expect(findButton('Download')).toBeUndefined()

      rerenderWith({
        fileId: 'f-1',
        filePath: 'ws/orphan.txt',
        open: true,
        onOpenChange: () => {},
      })
      expect(findButton('Download')).toBeDefined()
    })

    it('downloads through the agent-server URL, named by the basename', () => {
      previewState = {
        preview: {
          kind: 'binary',
          mimeType: 'application/zip',
          size: 5,
          mtimeMs: 1,
        },
        loading: false,
        error: null,
      }
      mountSubject({
        fileId: 'file/1',
        filePath: 'ws/archive.zip',
        open: true,
        onOpenChange: () => {},
      })

      // The subject downloads by appending an <a> and clicking it. happy-dom
      // would swallow that click, so it is recorded at the anchor itself —
      // the observable effect of pressing Download.
      const clicks: Array<{ href: string | null; download: string | null }> =
        []
      const anchorProto = (
        win as unknown as { HTMLAnchorElement: { prototype: { click: () => void } } }
      ).HTMLAnchorElement.prototype
      const realClick = anchorProto.click
      anchorProto.click = function (this: HTMLAnchorElement) {
        clicks.push({
          href: this.getAttribute('href'),
          download: this.getAttribute('download'),
        })
      }
      try {
        click(findButton('Download') as HTMLButtonElement)
        expect(clicks.length).toBe(1)
        // buildFileDownloadUrl (real) + encodeURIComponent on the id.
        expect(clicks[0]?.href).toBe(
          'http://agent.local:1/agents/files/file%2F1/download',
        )
        expect(clicks[0]?.download).toBe('archive.zip')
      } finally {
        anchorProto.click = realClick
      }
    })

    it('warns instead of downloading when the agent server is unreachable', async () => {
      agentBaseUrl = null
      const { rerenderWith } = mountSubject({
        fileId: 'f-1',
        filePath: 'ws/report.txt',
        open: true,
        onOpenChange: () => {},
      })
      rerenderWith({
        fileId: 'f-1',
        filePath: 'ws/report.txt',
        open: true,
        onOpenChange: () => {},
      })

      const clicks: Array<{ href: string | null }> = []
      const anchorProto = (
        win as unknown as { HTMLAnchorElement: { prototype: { click: () => void } } }
      ).HTMLAnchorElement.prototype
      const realClick = anchorProto.click
      anchorProto.click = function (this: HTMLAnchorElement) {
        clicks.push({ href: this.getAttribute('href') })
      }
      try {
        click(findButton('Download') as HTMLButtonElement)
      } finally {
        anchorProto.click = realClick
      }
      await settleToaster()

      expect(clicks.length).toBe(0)
      expect(observedToasts.length).toBe(1)
      expect(String(observedToasts[0]?.title)).toBe(
        "Couldn't reach the agent server",
      )
    })

    it('hands the close back to the parent through onOpenChange', () => {
      const opened: boolean[] = []
      mountSubject({
        fileId: 'f-1',
        filePath: 'ws/report.txt',
        open: true,
        onOpenChange: (open) => opened.push(open),
      })
      act(() => {
        win.document.dispatchEvent(
          new win.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
          }),
        )
      })
      expect(opened).toEqual([false])
    })
  })
})
