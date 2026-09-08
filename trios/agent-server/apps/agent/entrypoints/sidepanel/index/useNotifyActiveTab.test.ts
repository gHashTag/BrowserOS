/**
 * Contract suite for the exports of useNotifyActiveTab.tsx.
 *
 * The module exports exactly one symbol: `useNotifyActiveTab`. It is a React
 * hook, so the suite renders it inside a real React tree and asserts on the
 * glow messages the hook hands to the browser - the observable protocol
 * between the sidepanel and the content scripts - rather than on any
 * internal call shape.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`useNotifyActiveTab`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The hook's only live dependencies are the `chrome.tabs` extension API and
 * the onboarding storage item that gates the first-run confetti. Both are
 * replaced with in-memory fakes (`chrome.tabs` is captured message-by-message
 * in `sentGlows`; the storage item flips an in-process boolean), so this
 * suite needs no network, no database and no container.
 *
 * React itself runs for real: there is no DOM environment in this project's
 * bun test setup (`@testing-library`, `happy-dom` and `jsdom` are all absent
 * from the lockfile), so the suite mounts the hook through
 * `react-dom/client`'s `createRoot` against a minimal fake element. The
 * component under test renders `null`, so React performs no host mutations;
 * the fake only needs to satisfy the handful of properties the renderer
 * touches (nodeType, tagName, namespaceURI, addEventListener and the
 * active-element walk it performs during commit). Effects, effect cleanup
 * and dependency-driven re-runs therefore run under genuine React
 * semantics, driven with `act`.
 */
import { afterAll, describe, expect, it, mock } from 'bun:test'
import type { ChatStatus, UIMessage } from 'ai'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// --- fake for `@/lib/onboarding/onboardingStorage` -------------------------
// In-memory stand-in for the wxt storage item that remembers whether the
// first-run confetti has already been shown.
let confettiAlreadyShown = false
let confettiSetValueCalls = 0

mock.module('@/lib/onboarding/onboardingStorage', () => ({
  firstRunConfettiShownStorage: {
    getValue: async () => confettiAlreadyShown,
    setValue: async (value: boolean) => {
      confettiAlreadyShown = value
      confettiSetValueCalls++
    },
  },
}))

const { useNotifyActiveTab } = await import('./useNotifyActiveTab')

// --- fake for the `chrome.tabs` extension API -------------------------------
type GlowSent = { tabId: number; message: Record<string, unknown> }
const sentGlows: GlowSent[] = []
// What chrome.tabs.query({ active: true, currentWindow: true }) resolves to.
// Swappable per scenario; may return a never-resolving promise.
let activeTabQueryResult: () => Promise<Array<{ id: number }>> = async () => [
  { id: 55 },
]

const savedChrome = (globalThis as { chrome?: unknown }).chrome
;(globalThis as { chrome?: unknown }).chrome = {
  tabs: {
    sendMessage: (tabId: number, message: Record<string, unknown>) => {
      sentGlows.push({ tabId, message })
      return Promise.resolve()
    },
    query: () => activeTabQueryResult(),
  },
}

// --- minimal DOM stand-ins ---------------------------------------------------
// See the header comment: react-dom reads a few window/document properties
// even when nothing host-side is rendered.
class FakeHTMLIFrameElement {}
const fakeWindow = {
  event: undefined,
  addEventListener: () => {},
  removeEventListener: () => {},
  HTMLIFrameElement: FakeHTMLIFrameElement,
  document: null as unknown,
}
const fakeDocument = {
  nodeType: 9,
  nodeName: '#document',
  addEventListener: () => {},
  removeEventListener: () => {},
  activeElement: null,
  defaultView: fakeWindow,
}
;(fakeDocument as { ownerDocument?: unknown }).ownerDocument = fakeDocument
fakeWindow.document = fakeDocument
const savedDocument = (globalThis as { document?: unknown }).document
const savedWindow = (globalThis as { window?: unknown }).window
;(globalThis as { document?: unknown }).document = fakeDocument
;(globalThis as { window?: unknown }).window = fakeWindow
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

afterAll(() => {
  ;(globalThis as { chrome?: unknown }).chrome = savedChrome
  ;(globalThis as { document?: unknown }).document = savedDocument
  ;(globalThis as { window?: unknown }).window = savedWindow
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = false
})

const conversationId = '00000000-0000-4000-8000-000000000001'

// --- test message builders ---------------------------------------------------
// A message whose last tool part carries the given tab id in its CDP tool
// output metadata.
const messageWithCdpTabId = (tabId: number): UIMessage =>
  ({
    id: `m-${tabId}`,
    role: 'assistant',
    parts: [
      { type: 'text', text: 'working on the page' },
      {
        type: 'tool-navigate',
        toolCallId: `call-${tabId}`,
        state: 'output-available',
        output: { metadata: { tabId } },
      },
    ],
  }) as unknown as UIMessage

// A message whose last tool part carries the given tab id in its input, the
// legacy controller convention.
const messageWithLegacyTabId = (tabId: number): UIMessage =>
  ({
    id: `m-legacy-${tabId}`,
    role: 'assistant',
    parts: [
      {
        type: 'tool-legacyNavigate',
        toolCallId: `legacy-call-${tabId}`,
        state: 'input-available',
        input: { tabId },
      },
    ],
  }) as unknown as UIMessage

// A message whose last tool part carries no tab id at all.
const messageWithToolWithoutTabId = (): UIMessage =>
  ({
    id: 'm-no-tab',
    role: 'assistant',
    parts: [
      {
        type: 'tool-search',
        toolCallId: 'call-no-tab',
        state: 'output-available',
        output: {},
      },
    ],
  }) as unknown as UIMessage

const messageWithoutTools = (): UIMessage =>
  ({
    id: 'm-plain',
    role: 'assistant',
    parts: [{ type: 'text', text: 'just talking' }],
  }) as unknown as UIMessage

// --- hook driver --------------------------------------------------------------
type HookProps = {
  messages: UIMessage[]
  status: ChatStatus
  conversationId: string
}

let hookProps: HookProps

function HookHarness() {
  useNotifyActiveTab(hookProps)
  return null
}

// Renders the hook through a real React root and flushes the effects.
async function mountHook(): Promise<void> {
  await act(async () => {
    const root = createRoot(makeFakeElement())
    activeRoot = root
    root.render(createElement(HookHarness))
  })
}

// Re-renders with new props; effects whose dependencies changed re-run and
// previous cleanups fire, exactly as during a live stream.
async function updateHook(next: Partial<HookProps>): Promise<void> {
  hookProps = { ...hookProps, ...next }
  await act(async () => {
    activeRoot?.render(createElement(HookHarness))
  })
}

async function unmountHook(): Promise<void> {
  await act(async () => {
    activeRoot?.unmount()
  })
  activeRoot = null
}

let activeRoot: Root | null = null

function makeFakeElement() {
  return {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'div',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    addEventListener: () => {},
    removeEventListener: () => {},
    ownerDocument: fakeDocument,
  }
}

const activation = (tabId: number): GlowSent => ({
  tabId,
  message: { conversationId, isActive: true },
})
const deactivation = (tabId: number): GlowSent => ({
  tabId,
  message: { conversationId, isActive: false },
})
const endOfStream = (tabId: number, showConfetti: boolean): GlowSent => ({
  tabId,
  message: { conversationId, isActive: false, showConfetti },
})

describe('useNotifyActiveTabTsxContract', () => {
  it('useNotifyActiveTab glows each tab the agent works in during a stream and clears every glow, with confetti only once, when the stream ends', async () => {
    // -- while streaming: activate the tab named by the tool's output metadata
    hookProps = {
      messages: [messageWithCdpTabId(7)],
      status: 'streaming',
      conversationId,
    }
    await mountHook()
    expect(sentGlows).toEqual([activation(7)])

    // -- a later tool part naming a different tab moves the glow: the old
    //    tab is deactivated, the new one activated
    await updateHook({ messages: [messageWithCdpTabId(9)] })
    expect(sentGlows).toEqual([activation(7), deactivation(7), activation(9)])

    // -- the legacy controller convention (tab id in the tool input) also
    //    moves the glow
    await updateHook({ messages: [messageWithLegacyTabId(11)] })
    expect(sentGlows).toEqual([
      activation(7),
      deactivation(7),
      activation(9),
      deactivation(9),
      activation(11),
    ])

    // -- a tool part carrying no tab id while a tab is already glowed keeps
    //    the glow where it is: the same tab is activated again and nothing
    //    is deactivated
    await updateHook({ messages: [messageWithToolWithoutTabId()] })
    expect(sentGlows).toEqual([
      activation(7),
      deactivation(7),
      activation(9),
      deactivation(9),
      activation(11),
      activation(11),
    ])

    // -- end of the stream: every tab glowed during it is deactivated, in
    //    the order they were first glowed; the confetti flag is offered to
    //    exactly the first of them, and the fact it was shown is persisted
    expect(confettiAlreadyShown).toBe(false)
    expect(confettiSetValueCalls).toBe(0)
    await updateHook({ status: 'ready' })
    expect(sentGlows).toEqual([
      activation(7),
      deactivation(7),
      activation(9),
      deactivation(9),
      activation(11),
      activation(11),
      endOfStream(7, true),
      endOfStream(9, false),
      endOfStream(11, false),
    ])
    expect(confettiAlreadyShown).toBe(true)
    expect(confettiSetValueCalls).toBe(1)

    await unmountHook()

    // -- a second stream whose first tool part carries no tab id falls back
    //    to the tab the browser reports as active (chrome.tabs.query, which
    //    resolves to tab 55 here), and its end gets no confetti: the first
    //    run was persisted
    hookProps = {
      messages: [messageWithToolWithoutTabId()],
      status: 'streaming',
      conversationId,
    }
    await mountHook()
    await updateHook({ status: 'ready' })
    expect(sentGlows).toEqual([
      activation(7),
      deactivation(7),
      activation(9),
      deactivation(9),
      activation(11),
      activation(11),
      endOfStream(7, true),
      endOfStream(9, false),
      endOfStream(11, false),
      activation(55),
      endOfStream(55, false),
    ])
    expect(confettiSetValueCalls).toBe(1)

    await unmountHook()

    // -- a stream that never has tool parts never glows anything, and its
    //    end sends no deactivations and reads no confetti state
    hookProps = {
      messages: [messageWithoutTools()],
      status: 'streaming',
      conversationId,
    }
    const glowsBefore = sentGlows.length
    await mountHook()
    await updateHook({ status: 'ready' })
    expect(sentGlows.length).toBe(glowsBefore)
    await unmountHook()

    // -- a session that is already over when the hook first runs sends
    //    nothing at all
    hookProps = { messages: [], status: 'ready', conversationId }
    await mountHook()
    expect(sentGlows.length).toBe(glowsBefore)
    await unmountHook()

    // -- an activation still waiting on chrome.tabs.query when the stream
    //    ends is abandoned: resolving the query afterwards must not glow a
    //    tab that was never glowed, nor deactivate anything
    let resolveQuery: (tabs: Array<{ id: number }>) => void = () => {}
    activeTabQueryResult = () =>
      new Promise((resolve) => {
        resolveQuery = resolve
      })
    hookProps = {
      messages: [messageWithToolWithoutTabId()],
      status: 'streaming',
      conversationId,
    }
    await mountHook()
    await updateHook({ status: 'ready' })
    resolveQuery([{ id: 99 }])
    await act(async () => {})
    expect(sentGlows.length).toBe(glowsBefore)
    expect(confettiSetValueCalls).toBe(1)

    await unmountHook()
  })
})
