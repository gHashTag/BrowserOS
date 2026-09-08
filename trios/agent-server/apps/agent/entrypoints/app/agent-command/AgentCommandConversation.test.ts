import { afterAll, describe, expect, it, mock } from 'bun:test'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type FC, createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router'

/**
 * Contract suite for the single export of
 * `AgentCommandConversation.tsx` — the route-mounted agent chat
 * screen. That export, `AgentCommandConversation`, is exercised
 * directly by the assertions below; nothing is left uncovered, so no
 * export is blocked on a live dependency.
 *
 * The component is pinned through its observable rendered output.
 * `renderToString` renders the real component tree — the real
 * `AgentCommandLayout` (whose outlet context feeds the screen its
 * agent registry), the rail, the header, the chat surface and the
 * composer — to HTML, and assertions are made on that HTML only.
 *
 * Three seam modules whose real implementations need a live agent
 * server (harness listing / chat transport / history fetch) are
 * replaced with in-memory fakes via `mock.module`, so the suite
 * needs no network, no database and no container; the fake fetchers
 * throw if anything ever tries to reach a server.
 *
 * Bun resolves the app's `@/*` tsconfig alias relative to the
 * directory `bun test` was invoked from, not relative to this file.
 * The suite pins the working directory to the app root for the
 * duration of the subject import (and puts it back afterwards), so
 * the identical command passes from any directory.
 *
 * Effects never run under a server render, so purely
 * interaction-driven flows (sending a typed message, stop / retry
 * clicks, `?q=` initial-message consumption, opening the outputs
 * rail) are outside what a render-level suite can observe; the
 * render contract below is pinned without them.
 */

// ---------------------------------------------------------------------------
// Fake backend. The mocked hooks read from this object, so each
// scenario below can stage a different world and render against it.
// ---------------------------------------------------------------------------

interface FakeQueuedMessage {
  id: string
  createdAt: number
  message: string
}

interface FakeHarnessAgent {
  id: string
  name: string
  adapter: 'claude' | 'codex' | 'openclaw' | 'hermes'
  permissionMode: 'approve-all'
  sessionKey: string
  createdAt: number
  updatedAt: number
  status?: 'working' | 'idle' | 'asleep' | 'error'
  pinned?: boolean
  activeTurnId?: string | null
  queue?: FakeQueuedMessage[]
}

interface FakeHistoryPage {
  agentId: string
  sessionKey: string | null
  session: null
  items: Array<{
    id: string
    role: 'user' | 'assistant'
    text: string
    timestamp?: number
    messageSeq: number
    sessionKey: string
    source: 'user-chat'
  }>
  page: { hasMore: boolean; limit: number }
}

const emptyHistoryPage: FakeHistoryPage = {
  agentId: 'agent-1',
  sessionKey: 'main',
  session: null,
  items: [],
  page: { hasMore: false, limit: 50 },
}

const backend = {
  /** Agents returned by the harness listing hook (`useHarnessAgents`). */
  harnessAgents: [] as FakeHarnessAgent[],
  history: {
    kind: 'fetched' as 'fetched' | 'loading' | 'error',
    data: emptyHistoryPage as FakeHistoryPage | null,
    error: null as Error | null,
  },
  conversation: {
    streaming: false,
  },
}

const noop = () => {}
const networkRefuses = async () => {
  throw new Error('network access is disabled in this suite')
}

// ---------------------------------------------------------------------------
// Browser-global shim. Modules in the subject's import graph
// (wxt-backed storage items) read the extension `browser` global at
// import time. The suite provides an inert in-memory stand-in — the
// same approach wxt's own testing guide prescribes — so nothing in
// the graph depends on a live extension runtime. The previous value
// of the global is restored once the file's work is done.
// ---------------------------------------------------------------------------

const memoryArea = new Map<string, unknown>()
const previousBrowserGlobal = (globalThis as Record<string, unknown>).browser
;(globalThis as Record<string, unknown>).browser = {
  runtime: { id: 'agent-command-conversation-contract-suite' },
  storage: {
    local: {
      get: async (keys: string | string[] | null) => {
        if (keys === null || keys === undefined) {
          return Object.fromEntries(memoryArea)
        }
        const keyList = Array.isArray(keys) ? keys : [keys]
        return Object.fromEntries(
          keyList.map((key) => [key, memoryArea.get(key) ?? null]),
        )
      },
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) {
          memoryArea.set(key, value)
        }
      },
      remove: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          memoryArea.delete(key)
        }
      },
    },
    onChanged: {
      addListener: () => {},
      removeListener: () => {},
    },
  },
}

afterAll(() => {
  ;(globalThis as Record<string, unknown>).browser = previousBrowserGlobal
})

// ---------------------------------------------------------------------------
// Module seams. Every hook that would call the agent server over HTTP
// is replaced by an in-memory fake reading from `backend`.
// ---------------------------------------------------------------------------

mock.module('@/entrypoints/app/agents/useAgents', () => ({
  // Consumed at link time by `@/lib/agent-files`, which is real here.
  AGENT_QUERY_KEYS: {
    adapters: 'agent-harness-adapters',
    agents: 'agent-harness-agents',
    agentOutputs: 'agent-harness-agent-outputs',
    agentTurnFiles: 'agent-harness-agent-turn-files',
    filePreview: 'agent-harness-file-preview',
  },
  agentsFetch: networkRefuses,
  cancelHarnessTurn: networkRefuses,
  useHarnessAgents: () => ({
    agents: backend.harnessAgents.map((entry) => ({
      agentId: entry.id,
      name: entry.name,
      workspace: '',
      source: 'agent-harness' as const,
    })),
    harnessAgents: backend.harnessAgents,
    gateway: null,
    loading: false,
    error: null,
    refetch: noop,
  }),
  useAgentAdapters: () => ({
    adapters: [],
    loading: false,
    error: null,
    refetch: noop,
  }),
  useUpdateHarnessAgent: () => ({ mutate: noop }),
  useEnqueueHarnessMessage: () => ({ mutate: noop }),
  useRemoveHarnessQueuedMessage: () => ({ mutate: noop }),
}))

mock.module('./useHarnessChatHistory', () => ({
  useHarnessChatHistory: () => {
    const state = backend.history
    if (state.kind === 'loading') {
      return {
        data: undefined,
        isLoading: true,
        isError: false,
        isFetched: false,
        error: null,
        refetch: noop,
      }
    }
    if (state.kind === 'error') {
      return {
        data: undefined,
        isLoading: false,
        isError: true,
        isFetched: false,
        error: state.error,
        refetch: noop,
      }
    }
    return {
      data: state.data,
      isLoading: false,
      isError: false,
      isFetched: true,
      error: null,
      refetch: noop,
    }
  },
}))

mock.module('./useAgentConversation', () => ({
  useAgentConversation: () => ({
    turns: [],
    streaming: backend.conversation.streaming,
    send: noop,
  }),
}))

// ---------------------------------------------------------------------------
// Subject import. The working directory is pinned to the app root
// while the module graph loads (see the header comment), then
// restored so sibling suites in the same process are unaffected.
// ---------------------------------------------------------------------------

const appRoot = resolve(import.meta.dir, '../../..')
const invocationDir = process.cwd()
process.chdir(appRoot)
let conversationModule: typeof import('./AgentCommandConversation')
try {
  conversationModule = await import('./AgentCommandConversation')
} finally {
  process.chdir(invocationDir)
}
const { AgentCommandConversation } = conversationModule
const { AgentCommandLayout } = await import('./agent-command-layout')

// ---------------------------------------------------------------------------
// Rendering harness. Mirrors the app mount: the real layout route
// provides the outlet context `useAgentCommandData` reads, with the
// subject mounted both at the index (no :agentId) and at :agentId.
// ---------------------------------------------------------------------------

function renderAt(
  path: string,
  props: {
    variant?: 'command' | 'page'
    backPath?: string
    agentPathPrefix?: string
    createAgentPath?: string
  } = {},
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const Layout: FC = () => h(AgentCommandLayout)
  return renderToString(
    h(
      QueryClientProvider,
      { client: queryClient },
      h(
        MemoryRouter,
        { initialEntries: [path] },
        h(
          Routes,
          null,
          h(Route, { path: '/home', element: h('div', null, 'home_stub') }),
          h(
            Route,
            { path: '/home/agents', element: h(Layout) },
            h(Route, {
              index: true,
              element: h(AgentCommandConversation, props),
            }),
            h(Route, {
              path: ':agentId',
              element: h(AgentCommandConversation, props),
            }),
          ),
        ),
      ),
    ),
  )
}

function resetBackend(): void {
  backend.harnessAgents = []
  backend.history = { kind: 'fetched', data: emptyHistoryPage, error: null }
  backend.conversation.streaming = false
}

const openClawAgent: FakeHarnessAgent = {
  id: 'agent-1',
  name: 'Harness Prime',
  adapter: 'openclaw',
  permissionMode: 'approve-all',
  sessionKey: 'main',
  createdAt: 1_000,
  updatedAt: 2_000,
  status: 'idle',
  pinned: false,
  activeTurnId: null,
  queue: [],
}

describe('AgentCommandConversationTsxContract', () => {
  it('AgentCommandConversation pins the mounted render contract of the exported chat screen', () => {
    // -- A route without an agentId renders no conversation UI.
    // The screen's guard answers by rendering the redirect sentinel,
    // which produces no markup of its own, so the whole chrome —
    // rail band, header, chat, composer — is absent from the page.
    resetBackend()
    expect(renderAt('/home/agents')).toBe('')

    // -- A registered openclaw agent gets the full screen: the shared
    // rail band, the header carrying the harness record's name, the
    // empty-conversation state addressed to that same agent, and the
    // composer placeholder naming the agent. With the outputs rail
    // closed the body grid is the two-column layout.
    resetBackend()
    backend.harnessAgents = [openClawAgent]
    const idleHtml = renderAt('/home/agents/agent-1')
    expect(idleHtml).toContain('>Agents<')
    expect(idleHtml).toContain('title="Back to home"')
    expect(idleHtml).toContain('Harness Prime')
    // The empty-conversation state addresses the agent by name; the
    // server renderer splits interpolated text with HTML comments, so
    // the sentence is asserted by its stable fragments.
    expect(idleHtml).toContain('Ask ')
    expect(idleHtml).toContain('to start a task.')
    expect(idleHtml).toContain('placeholder="Message Harness Prime..."')
    // Only an openclaw agent gets the outputs-rail toggle in the
    // header, and with the rail closed the grid carries no third
    // column for it.
    expect(idleHtml).toContain('title="Show outputs"')
    expect(idleHtml).toContain('lg:grid-cols-[288px_minmax(0,1fr)]"')
    expect(idleHtml).not.toContain('lg:grid-cols-[288px_minmax(0,1fr)_320px]')

    // -- The page variant relabels the header's back affordance.
    resetBackend()
    backend.harnessAgents = [openClawAgent]
    const pageHtml = renderAt('/home/agents/agent-1', { variant: 'page' })
    expect(pageHtml).toContain('title="Back to agents"')

    // -- An in-flight turn reroutes the composer to the queue: the
    // queued message is surfaced in the panel above the input and the
    // placeholder switches to queueing copy.
    resetBackend()
    backend.harnessAgents = [
      {
        ...openClawAgent,
        activeTurnId: 'turn-9',
        queue: [
          {
            id: 'qm-1',
            createdAt: 3_000,
            message: 'stage the release notes after the run',
          },
        ],
      },
    ]
    backend.conversation.streaming = true
    const queuedHtml = renderAt('/home/agents/agent-1')
    expect(queuedHtml).toContain('queued message')
    expect(queuedHtml).toContain('stage the release notes after the run')
    expect(queuedHtml).toContain(
      'placeholder="Type to queue another message for Harness Prime..."',
    )

    // -- An agentId with no record anywhere still renders a usable
    // screen: the header falls back to the id itself, the composer
    // addresses that fallback name, and the openclaw-only outputs
    // toggle is withheld.
    resetBackend()
    const fallbackHtml = renderAt('/home/agents/ghost-7')
    expect(fallbackHtml).toContain('>ghost-7<')
    expect(fallbackHtml).toContain('Ask ')
    expect(fallbackHtml).toContain('to start a task.')
    expect(fallbackHtml).toContain('placeholder="Message ghost-7..."')
    expect(fallbackHtml).not.toContain('title="Show outputs"')

    // -- Persisted history replaces the empty state with the
    // conversation's own messages.
    resetBackend()
    backend.harnessAgents = [openClawAgent]
    backend.history = {
      kind: 'fetched',
      error: null,
      data: {
        agentId: 'agent-1',
        sessionKey: 'main',
        session: null,
        items: [
          {
            id: 'agent:agent-1:main:1',
            role: 'user',
            text: 'kick off the nightly export',
            timestamp: 1_000,
            messageSeq: 1,
            sessionKey: 'main',
            source: 'user-chat',
          },
          {
            id: 'agent:agent-1:main:2',
            role: 'assistant',
            text: 'Export finished; three files staged.',
            timestamp: 2_000,
            messageSeq: 2,
            sessionKey: 'main',
            source: 'user-chat',
          },
        ],
        page: { hasMore: false, limit: 50 },
      },
    }
    const historyHtml = renderAt('/home/agents/agent-1')
    expect(historyHtml).toContain('kick off the nightly export')
    expect(historyHtml).toContain('Export finished; three files staged.')
    expect(historyHtml).not.toContain('to start a task.')

    // -- While history has not resolved yet, the chat surface shows
    // its loading state rather than an empty conversation.
    resetBackend()
    backend.harnessAgents = [openClawAgent]
    backend.history = { kind: 'loading', data: null, error: null }
    const loadingHtml = renderAt('/home/agents/agent-1')
    expect(loadingHtml).toContain('Loading conversation...')
    expect(loadingHtml).not.toContain('to start a task.')

    // -- A failed history fetch surfaces the error and a retry affordance.
    resetBackend()
    backend.harnessAgents = [openClawAgent]
    backend.history = {
      kind: 'error',
      data: null,
      error: new Error('harness history is unreachable'),
    }
    const errorHtml = renderAt('/home/agents/agent-1')
    expect(errorHtml).toContain('harness history is unreachable')
    expect(errorHtml).toContain('Retry')
  })
})
