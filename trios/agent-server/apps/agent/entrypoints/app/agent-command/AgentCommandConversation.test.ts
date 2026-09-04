/**
 * Contract suite for `AgentCommandConversation`, the single export of
 * ./AgentCommandConversation.tsx.
 *
 * Approach: the component is rendered for real through
 * `react-dom/server` inside a `StaticRouter` route match, and every
 * assertion reads the resulting markup. This repo has no DOM test
 * environment (no jsdom / happy-dom / testing-library anywhere in the
 * tree), so server rendering is the only harness that can mount the
 * component under plain `bun test` with no network, no database and
 * no container.
 *
 * The collaborators that carry live dependencies are replaced with
 * deterministic doubles registered via `mock.module` BEFORE the
 * subject is imported, so the subject itself is loaded unmodified and
 * binds against the doubles:
 *
 *  - `@/entrypoints/app/agents/useAgents` (HTTP queries + mutations
 *    against the agent server) -> in-memory state.
 *  - `./agent-command-layout` -> in-memory agent entry list.
 *  - `./useHarnessChatHistory` (HTTP history query) -> in-memory page.
 *  - `./useAgentConversation` (SSE streaming) -> in-memory turn list.
 *  - `@/lib/agent-files` (HTTP outputs query) -> in-memory groups.
 *  - `./agent-conversation.outputs-rail`, `./AgentRail`, `./ClawChat`,
 *    `./ConversationHeader`, `./ConversationInput`, `./QueuePanel` ->
 *    marker components that surface the props they receive into the
 *    markup, mirroring what the real surfaces show the user (the
 *    header title, the back-button label, the composer placeholder,
 *    queued message text, the outputs toggle).
 *
 * Pure derivation modules the subject depends on (`./claw-chat-types`,
 * `./pending-initial-message`, `@/lib/utils`, `@/components/ui/button`,
 * `lucide-react`, `react-router`) are left real, so history data flows
 * through the genuine mapping code on its way to the rendered output.
 *
 * Exports of the subject that could not be exercised by an assertion:
 * none. The one export is fully rendered and asserted below. What this
 * render-level harness genuinely cannot observe are the effect- and
 * event-driven behaviours INSIDE that export (the `?q=` initial send
 * effect, the outputs-rail toggle click, back/agent navigation, and
 * the queue mutation callbacks), because server rendering runs no
 * effects and dispatches no events; those are behaviours of the same
 * already-exercised export, not separate exports.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Route, Routes, StaticRouter } from 'react-router'
import type {
  HarnessAdapterDescriptor,
  HarnessAgent,
  HarnessQueuedMessage,
} from '@/entrypoints/app/agents/agent-harness-types'
import type { AgentEntry } from '@/entrypoints/app/agents/useOpenClaw'

interface HistoryItem {
  id: string
  role: 'user' | 'assistant'
  text: string
  messageSeq: number
  sessionKey: string
  source: 'user-chat'
  timestamp?: number
}

interface HistoryPage {
  agentId: string
  sessionKey: string | null
  session: null
  items: HistoryItem[]
  page: { hasMore: boolean; limit: number }
}

interface ConversationTurnLike {
  id: string
  turnId?: string | null
  userText: string
  parts: Array<Record<string, unknown>>
  done: boolean
  timestamp: number
}

/**
 * Mutable stand-in for everything the mocked hooks return. Each
 * assertion block below sets the slice of world state it cares about,
 * renders, and reads the markup.
 */
const world = {
  agentEntries: [] as AgentEntry[],
  harnessAgents: [] as HarnessAgent[],
  adapters: [] as HarnessAdapterDescriptor[],
  history: {
    data: undefined as HistoryPage | undefined,
    isLoading: false,
    isFetched: true,
    isError: false,
    error: null as Error | null,
    refetch: (): Promise<unknown> => Promise.resolve(undefined),
  },
  conversation: {
    turns: [] as ConversationTurnLike[],
    streaming: false,
    send: (_input: unknown): void => {},
  },
  outputGroups: [] as Array<Record<string, unknown>>,
}

function resetWorld(): void {
  world.agentEntries = []
  world.harnessAgents = []
  world.adapters = []
  world.history = {
    data: undefined,
    isLoading: false,
    isFetched: true,
    isError: false,
    error: null,
    refetch: (): Promise<unknown> => Promise.resolve(undefined),
  }
  world.conversation = {
    turns: [],
    streaming: false,
    send: (_input: unknown): void => {},
  }
  world.outputGroups = []
}

function harnessAgent(
  id: string,
  name: string,
  adapter: HarnessAgent['adapter'],
  extra: Partial<HarnessAgent> = {},
): HarnessAgent {
  return {
    id,
    name,
    adapter,
    permissionMode: 'approve-all',
    sessionKey: `agent:${id}:main`,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...extra,
  }
}

function emptyHistoryPage(agentId: string): HistoryPage {
  return {
    agentId,
    sessionKey: `agent:${agentId}:main`,
    session: null,
    items: [],
    page: { hasMore: false, limit: 50 },
  }
}

// ---------------------------------------------------------------------------
// Marker components standing in for the presentation surfaces. Each one
// renders, into visible markup, exactly what the real surface shows the
// user, so assertions below stay on observable output.
// ---------------------------------------------------------------------------

const ConversationHeaderStub = (props: {
  agent: HarnessAgent | null
  fallbackName: string
  fallbackAdapter: string
  adapterHealth: { healthy: boolean; reason?: string } | null
  backLabel: string
  headerExtra?: unknown
}) =>
  createElement(
    'div',
    { 'data-stub': 'conversation-header' },
    createElement(
      'button',
      { type: 'button', title: props.backLabel },
      props.backLabel,
    ),
    createElement(
      'span',
      { 'data-stub': 'header-agent-name' },
      props.agent?.name || props.fallbackName,
    ),
    createElement(
      'span',
      { 'data-stub': 'header-adapter' },
      props.agent?.adapter ?? props.fallbackAdapter,
    ),
    props.adapterHealth
      ? createElement(
          'span',
          { 'data-stub': 'adapter-health' },
          `health:${props.adapterHealth.healthy}:${props.adapterHealth.reason ?? ''}`,
        )
      : null,
    props.headerExtra ?? null,
  )

const ConversationInputStub = (props: {
  placeholder?: string
  streaming: boolean
  disabled: boolean
}) =>
  createElement(
    'div',
    { 'data-stub': 'conversation-input' },
    createElement('textarea', {
      placeholder: props.placeholder,
      disabled: props.disabled ? true : undefined,
    }),
    props.streaming
      ? createElement('span', { 'data-stub': 'composer-streaming' })
      : null,
  )

const ClawChatStub = (props: {
  agentName: string
  historyMessages: Array<{
    id: string
    parts: Array<{ type: string; text?: string }>
  }>
  streaming: boolean
  isInitialLoading: boolean
  error: Error | null
}) =>
  createElement(
    'div',
    { 'data-stub': 'claw-chat' },
    createElement('h2', { 'data-stub': 'chat-agent-name' }, props.agentName),
    props.isInitialLoading
      ? createElement(
          'p',
          { 'data-stub': 'chat-loading' },
          'Loading conversation...',
        )
      : null,
    props.error
      ? createElement('p', { 'data-stub': 'chat-error' }, props.error.message)
      : null,
    props.historyMessages.map((message) =>
      createElement(
        'div',
        { key: message.id, 'data-stub': 'chat-history-message' },
        message.parts.map((part, index) =>
          part.type === 'text'
            ? createElement('span', { key: index }, part.text)
            : null,
        ),
      ),
    ),
  )

const QueuePanelStub = (props: { queue: HarnessQueuedMessage[] }) =>
  createElement(
    'div',
    { 'data-stub': 'queue-panel' },
    props.queue.map((entry) =>
      createElement(
        'div',
        { key: entry.id, 'data-stub': 'queued-message' },
        entry.message,
      ),
    ),
  )

const AgentRailStub = () =>
  createElement('nav', { 'data-stub': 'agent-rail' }, 'Agents')

const OutputsRailStub = (props: { agentId: string }) =>
  createElement(
    'aside',
    { 'data-stub': 'outputs-rail' },
    `outputs:${props.agentId}`,
  )

// ---------------------------------------------------------------------------
// Replace the live-dependency collaborators before the subject loads.
// ---------------------------------------------------------------------------

mock.module('@/entrypoints/app/agents/useAgents', () => ({
  cancelHarnessTurn: (): void => {},
  useAgentAdapters: () => ({ adapters: world.adapters }),
  useEnqueueHarnessMessage: () => ({ mutate: (): void => {} }),
  useHarnessAgents: () => ({ harnessAgents: world.harnessAgents }),
  useRemoveHarnessQueuedMessage: () => ({ mutate: (): void => {} }),
  useUpdateHarnessAgent: () => ({ mutate: (): void => {} }),
}))

mock.module('./agent-command-layout', () => ({
  useAgentCommandData: () => ({ agents: world.agentEntries }),
}))

mock.module('./useHarnessChatHistory', () => ({
  useHarnessChatHistory: () => world.history,
}))

mock.module('@/lib/agent-files', () => ({
  useAgentOutputs: () => ({
    groups: world.outputGroups,
    loading: false,
    error: null,
  }),
}))

mock.module('./useAgentConversation', () => ({
  useAgentConversation: () => world.conversation,
}))

mock.module('./agent-conversation.outputs-rail', () => ({
  OutputsRail: OutputsRailStub,
  // The real hook starts closed and only opens from localStorage in a
  // client effect, which server rendering never runs; the double
  // mirrors that first-paint state.
  useOutputsRailOpen: (): [boolean, () => void] => [false, () => {}],
}))

mock.module('./AgentRail', () => ({ AgentRail: AgentRailStub }))
mock.module('./ClawChat', () => ({ ClawChat: ClawChatStub }))
mock.module('./ConversationHeader', () => ({
  ConversationHeader: ConversationHeaderStub,
}))
mock.module('./ConversationInput', () => ({
  ConversationInput: ConversationInputStub,
}))
mock.module('./QueuePanel', () => ({ QueuePanel: QueuePanelStub }))

const { AgentCommandConversation } = await import('./AgentCommandConversation')

interface ConversationProps {
  variant?: 'command' | 'page'
  backPath?: string
  agentPathPrefix?: string
  createAgentPath?: string
}

/** Mount the subject at a URL the way the app's router would. */
function renderAt(location: string, props: ConversationProps = {}): string {
  const element = createElement(AgentCommandConversation, props)
  return renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/home/agents/:agentId',
          element,
        }),
        createElement(Route, { path: '/home/agents', element }),
      ),
    ),
  )
}

function baseWorld(): void {
  resetWorld()
  world.agentEntries = [
    {
      agentId: 'agent-7',
      name: 'Entry name',
      workspace: 'codex:main',
      source: 'agent-harness',
    },
  ]
  world.harnessAgents = [
    harnessAgent('agent-7', 'Harness record name', 'codex'),
  ]
  world.history.data = emptyHistoryPage('agent-7')
}

describe('AgentCommandConversationTsxContract', () => {
  it('AgentCommandConversation: renders the routed conversation surface and its derived chrome from agent data', () => {
    // -- No agent id in the route: the surface redirects home and
    //    renders nothing.
    baseWorld()
    expect(
      renderAt('/home/agents'),
      'a route without an agent id renders no conversation surface (early Navigate to /home)',
    ).toBe('')

    // -- Default (command) variant for a known agent.
    const base = renderAt('/home/agents/agent-7')
    expect(base, 'the shared top band names the rail "Agents"').toContain(
      '>Agents<',
    )
    expect(base, 'the left agent rail band renders').toContain(
      'data-stub="agent-rail"',
    )
    expect(base, 'the conversation header band renders').toContain(
      'data-stub="conversation-header"',
    )
    expect(
      base,
      'the header names the agent from its harness record',
    ).toContain('data-stub="header-agent-name">Harness record name<')
    expect(
      base,
      'the header back button offers "Back to home" in the command variant',
    ).toContain('title="Back to home"')
    expect(base, 'the chat panel renders for the routed agent').toContain(
      'data-stub="claw-chat"',
    )
    expect(
      base,
      'the chat panel names the agent from the entry list (a different derivation path than the header)',
    ).toContain('data-stub="chat-agent-name">Entry name<')
    expect(
      base,
      'the composer prompt addresses the agent by its entry name when idle',
    ).toContain('placeholder="Message Entry name..."')
    expect(base, 'an empty queue renders no queue panel').not.toContain(
      'data-stub="queue-panel"',
    )
    expect(
      base,
      'a non-openclaw agent gets no outputs-rail toggle',
    ).not.toContain('Show outputs')
    expect(
      base,
      'the outputs rail is not mounted on first paint',
    ).not.toContain('data-stub="outputs-rail"')
    expect(base, 'the composer stays enabled for a known agent').not.toContain(
      'disabled=""',
    )
    expect(
      base,
      'a fetched (empty) history shows no loading shimmer',
    ).not.toContain('data-stub="chat-loading"')

    // -- Page variant flips the back label.
    const page = renderAt('/home/agents/agent-7', { variant: 'page' })
    expect(
      page,
      'the page variant relabels the header back button "Back to agents"',
    ).toContain('title="Back to agents"')

    // -- A streaming turn switches the composer to queue-mode copy.
    world.conversation.streaming = true
    const streaming = renderAt('/home/agents/agent-7')
    world.conversation.streaming = false
    expect(
      streaming,
      'while streaming, the composer asks the user to queue another message',
    ).toContain('placeholder="Type to queue another message for Entry name..."')

    // -- History states flow through to the chat panel.
    world.history.isLoading = true
    expect(
      renderAt('/home/agents/agent-7'),
      'a loading history shows the loading state',
    ).toContain('Loading conversation...')
    world.history.isLoading = false

    world.history.isError = true
    world.history.error = new Error('history backend down')
    expect(
      renderAt('/home/agents/agent-7'),
      'a failed history surfaces its error message',
    ).toContain('history backend down')
    world.history.isError = false
    world.history.error = null

    world.history.data = {
      ...emptyHistoryPage('agent-7'),
      items: [
        {
          id: 'h-1',
          role: 'user',
          text: 'persisted question',
          messageSeq: 1,
          sessionKey: 'agent:agent-7:main',
          source: 'user-chat',
          timestamp: 1_000,
        },
        {
          id: 'h-2',
          role: 'assistant',
          text: 'persisted answer',
          messageSeq: 2,
          sessionKey: 'agent:agent-7:main',
          source: 'user-chat',
          timestamp: 1_001,
        },
      ],
    }
    const withHistory = renderAt('/home/agents/agent-7')
    expect(
      withHistory,
      'persisted history text reaches the chat panel through the real page-flattening code',
    ).toContain('persisted question')
    expect(withHistory).toContain('persisted answer')

    // -- The queue panel only shows this agent's queued messages.
    world.history.data = emptyHistoryPage('agent-7')
    world.harnessAgents = [
      harnessAgent('agent-7', 'Harness record name', 'codex', {
        queue: [
          {
            id: 'qm-1',
            createdAt: 2_000,
            message: 'queued follow-up task',
          },
        ],
      }),
      harnessAgent('agent-8', 'Other agent', 'codex', {
        queue: [
          {
            id: 'qm-8',
            createdAt: 2_001,
            message: 'other agent task',
          },
        ],
      }),
    ]
    const withQueue = renderAt('/home/agents/agent-7')
    expect(
      withQueue,
      'a queued message for the routed agent renders in the queue panel',
    ).toContain('queued follow-up task')
    expect(
      withQueue,
      "another agent's queue does not leak into this conversation",
    ).not.toContain('other agent task')

    // -- Adapter health is derived from the adapter descriptor list.
    world.adapters = [
      {
        id: 'codex',
        name: 'Codex',
        defaultModelId: 'gpt-5.5',
        defaultReasoningEffort: 'medium',
        modelControl: 'runtime-supported',
        models: [],
        reasoningEfforts: [],
        health: {
          healthy: false,
          reason: 'CLI not installed',
          checkedAt: 3_000,
        },
      },
    ]
    expect(
      renderAt('/home/agents/agent-7'),
      'a matching unhealthy adapter descriptor surfaces its reason',
    ).toContain('CLI not installed')
    world.adapters = []
    expect(
      renderAt('/home/agents/agent-7'),
      'no matching adapter descriptor yields no health readout',
    ).not.toContain('data-stub="adapter-health"')

    // -- The outputs-rail toggle appears only for openclaw agents.
    world.harnessAgents = [
      harnessAgent('agent-7', 'Harness record name', 'openclaw'),
    ]
    const openclaw = renderAt('/home/agents/agent-7')
    expect(
      openclaw,
      'an openclaw agent gets the outputs toggle, starting closed',
    ).toContain('title="Show outputs"')
    expect(
      openclaw,
      'the rail itself still mounts closed on first paint',
    ).not.toContain('data-stub="outputs-rail"')
    expect(openclaw, 'the header reflects the openclaw adapter').toContain(
      'data-stub="header-adapter">openclaw<',
    )

    // -- Unknown agent id: names fall back to the raw id and the
    //    composer is disabled.
    resetWorld()
    const ghost = renderAt('/home/agents/ghost')
    expect(
      ghost,
      'an unknown agent id falls back to the raw id in the header',
    ).toContain('data-stub="header-agent-name">ghost<')
    expect(
      ghost,
      'an unknown agent id falls back to the raw id in the chat panel',
    ).toContain('data-stub="chat-agent-name">ghost<')
    expect(
      ghost,
      'the composer still addresses the unknown agent by id',
    ).toContain('placeholder="Message ghost..."')
    expect(ghost, 'the composer is disabled for an unknown agent').toContain(
      'disabled=""',
    )
  })
})
