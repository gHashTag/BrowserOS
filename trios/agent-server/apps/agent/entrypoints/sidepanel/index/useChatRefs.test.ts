/**
 * Contract suite for the exports of useChatRefs.ts.
 *
 * The module exports exactly one symbol: `useChatRefs`. The assertions
 * below render that export through a probe component and assert on the
 * values it hands back, so the suite pins observable behaviour rather
 * than the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`useChatRefs`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * Dependency swaps, all via `mock.module`, so this suite needs no
 * network, no database and no container:
 *   - `@/lib/mcp/mcpServerStorage`, `@/lib/llm-providers/useLlmProviders`,
 *     `@/entrypoints/app/agents/useAgents` and
 *     `@/lib/personalization/personalizationStorage` read browser
 *     extension storage (`@wxt-dev/storage`) or poll the agent server
 *     over HTTP (`@tanstack/react-query`). Each is swapped for an
 *     in-memory stand-in whose state the suite controls between
 *     renders.
 *   - `@wxt-dev/storage` itself is swapped for an in-memory driver
 *     keyed like the real one, so every line of the subject and of its
 *     local collaborator `./sidepanel-chat-targets` runs for real -
 *     only the browser-storage backend is fake.
 *
 * Not pinned, and why: the hook's mount effects - loading a previously
 * persisted target selection, and re-syncing the refs after a
 * dependency changes - require a mounted component with a live effect
 * loop. `@testing-library`, `happy-dom`, `jsdom` and
 * `react-test-renderer` are all absent from the lockfile, and
 * `react-dom/server` (the only renderer available) cannot run effects,
 * so only first-render seeding, the derived values, and the
 * synchronous part of `selectChatTarget` are pinned. That is a gap in
 * effect coverage, not an export left unexercised: the export itself
 * is rendered and asserted on, so no export belongs in the blocked
 * list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type {
  HarnessAdapterDescriptor,
  HarnessAgent,
} from '@/entrypoints/app/agents/agent-harness-types'
import type { LlmProviderConfig } from '@/lib/llm-providers/types'
import type { McpServer } from '@/lib/mcp/mcpServerStorage'

/**
 * In-memory stand-in for the `@wxt-dev/storage` driver. Items are keyed
 * like the real driver ("local:<name>"), `getValue` honours the
 * declared fallback, and the raw values written through `setValue` are
 * kept so the suite can assert on exactly what the subject asked to
 * have stored.
 */
const storedValues = new Map<string, unknown>()

const fakeStorage = {
  defineItem: <T>(key: string, options?: { fallback?: T }) => ({
    getValue: async (): Promise<T | null> =>
      storedValues.has(key)
        ? ((storedValues.get(key) as T) ?? null)
        : (options?.fallback ?? null),
    setValue: async (value: T): Promise<void> => {
      storedValues.set(key, value)
    },
    watch: (_callback: (newValue: T | null) => void) => () => {},
  }),
}

mock.module('@wxt-dev/storage', () => ({ storage: fakeStorage }))

/**
 * Mutable in-memory state backing the four swapped storage/network
 * hooks. The suite assigns these before each probe render.
 */
const mcpState: { servers: McpServer[] } = { servers: [] }
const llmState: {
  providers: LlmProviderConfig[]
  selectedProvider: LlmProviderConfig | null
  setDefaultProvider: (providerId: string) => Promise<void>
  isLoading: boolean
} = {
  providers: [],
  selectedProvider: null,
  setDefaultProvider: () => Promise.resolve(),
  isLoading: false,
}
const adaptersState: {
  adapters: HarnessAdapterDescriptor[]
  loading: boolean
} = { adapters: [], loading: false }
const agentsState: { harnessAgents: HarnessAgent[]; loading: boolean } = {
  harnessAgents: [],
  loading: false,
}
const personalizationState: { personalization: string } = {
  personalization: '',
}

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  useMcpServers: () => ({ servers: mcpState.servers }),
}))

mock.module('@/lib/llm-providers/useLlmProviders', () => ({
  useLlmProviders: () => llmState,
}))

mock.module('@/entrypoints/app/agents/useAgents', () => ({
  useAgentAdapters: () => adaptersState,
  useHarnessAgents: () => agentsState,
}))

mock.module('@/lib/personalization/personalizationStorage', () => ({
  usePersonalization: () => personalizationState,
}))

const { useChatRefs } = await import('./useChatRefs')

type ChatRefsResult = ReturnType<typeof useChatRefs>

/**
 * Render the hook once through a probe component and capture what it
 * returned. `react-dom/server` runs the hook body (state seeding,
 * memoised derivation, callback creation) but not its effects, which
 * is exactly the first-render contract pinned below.
 */
const renderHookOnce = (): ChatRefsResult => {
  let captured: ChatRefsResult | undefined
  const Probe = () => {
    captured = useChatRefs()
    return null
  }
  renderToString(createElement(Probe))
  if (captured === undefined) throw new Error('probe component never ran')
  return captured
}

const timestamp = 1000

const browserosProvider: LlmProviderConfig = {
  id: 'browseros',
  type: 'browseros',
  name: 'BrowserOS',
  modelId: 'browseros-auto',
  supportsImages: true,
  contextWindow: 200000,
  temperature: 0.2,
  createdAt: timestamp,
  updatedAt: timestamp,
}

const anthropicProvider: LlmProviderConfig = {
  id: 'anthropic-sonnet',
  type: 'anthropic',
  name: 'Anthropic Sonnet',
  modelId: 'claude-sonnet-4-6',
  supportsImages: true,
  contextWindow: 200000,
  temperature: 0.2,
  createdAt: timestamp,
  updatedAt: timestamp,
}

const codexAdapter: HarnessAdapterDescriptor = {
  id: 'codex',
  name: 'Codex',
  defaultModelId: 'gpt-5.5',
  defaultReasoningEffort: 'medium',
  modelControl: 'runtime-supported',
  models: [{ id: 'gpt-5.5', label: 'GPT-5.5', recommended: true }],
  reasoningEfforts: [
    { id: 'medium', label: 'Medium', recommended: true },
    { id: 'high', label: 'High' },
  ],
}

const codexAgent: HarnessAgent = {
  id: 'agent-codex',
  name: 'Review Bot',
  adapter: 'codex',
  modelId: 'gpt-5.5',
  reasoningEffort: 'medium',
  permissionMode: 'approve-all',
  sessionKey: 'agent:agent-codex:main',
  createdAt: timestamp,
  updatedAt: timestamp,
}

const mcpServers: McpServer[] = [
  {
    id: 'mcp-managed-1',
    displayName: 'Slack',
    type: 'managed',
    managedServerName: 'slack',
  },
  {
    id: 'mcp-custom-1',
    displayName: 'GitHub',
    type: 'custom',
    config: { url: 'https://mcp.github.com/sse' },
  },
  { id: 'mcp-custom-2', displayName: 'Notes', type: 'custom' },
]

const setDefaultProviderFromStore = (providerId: string) => {
  void providerId
  return Promise.resolve()
}

const selectionStorageKey = 'local:sidepanel-chat-target-selection'

describe('useChatRefsContract', () => {
  it('pins what useChatRefs returns: seeded refs, built targets, resolved selection, combined loading, and selection handoff', async () => {
    // --- Scenario A: busy providers, agent still loading, rich state.
    llmState.providers = [browserosProvider, anthropicProvider]
    llmState.selectedProvider = anthropicProvider
    llmState.setDefaultProvider = setDefaultProviderFromStore
    llmState.isLoading = true
    adaptersState.adapters = [codexAdapter]
    adaptersState.loading = false
    agentsState.harnessAgents = [codexAgent]
    agentsState.loading = true
    mcpState.servers = mcpServers
    personalizationState.personalization = 'Be terse.'

    const busy = renderHookOnce()

    // The provider list and the selected provider config are handed
    // back unchanged, and the store's default-provider setter is the
    // very function on the returned surface.
    expect(busy.llmProviders).toEqual([browserosProvider, anthropicProvider])
    expect(busy.selectedLlmProvider).toEqual(anthropicProvider)
    expect(busy.setDefaultProvider).toBe(setDefaultProviderFromStore)

    // Targets are built from the providers plus the persisted harness
    // agents, LLM targets first, with adapter metadata resolved for the
    // agent target (real buildSidepanelChatTargets runs here).
    expect(busy.chatTargets).toEqual([
      {
        kind: 'llm',
        id: 'browseros',
        name: 'BrowserOS',
        type: 'browseros',
        provider: browserosProvider,
      },
      {
        kind: 'llm',
        id: 'anthropic-sonnet',
        name: 'Anthropic Sonnet',
        type: 'anthropic',
        provider: anthropicProvider,
      },
      {
        kind: 'acp',
        id: 'agent-codex',
        name: 'Review Bot',
        type: 'acp',
        agentId: 'agent-codex',
        adapter: 'codex',
        adapterName: 'Codex',
        modelId: 'gpt-5.5',
        modelLabel: 'GPT-5.5',
        modelControl: 'runtime-supported',
        recommended: true,
        reasoningEffort: 'medium',
        reasoningEffortLabel: 'Medium',
      },
    ])
    expect(busy.chatTargets).toHaveLength(3)

    // Before any persisted selection has loaded, the target for the
    // selected provider is the resolved one.
    expect(busy.selectedChatTarget).toEqual({
      kind: 'llm',
      id: 'anthropic-sonnet',
      name: 'Anthropic Sonnet',
      type: 'anthropic',
      provider: anthropicProvider,
    })

    // Every ref is seeded with the value current at first render:
    // the selected provider, the resolved target, managed MCP server
    // names only, custom MCP servers as name/url pairs only, and the
    // personalization text.
    expect(busy.selectedLlmProviderRef.current).toEqual(anthropicProvider)
    expect(busy.selectedChatTargetRef.current).toEqual({
      kind: 'llm',
      id: 'anthropic-sonnet',
      name: 'Anthropic Sonnet',
      type: 'anthropic',
      provider: anthropicProvider,
    })
    expect(busy.enabledMcpServersRef.current).toEqual(['slack'])
    expect(busy.enabledMcpServersRef.current).toHaveLength(1)
    expect(busy.enabledCustomServersRef.current).toEqual([
      { name: 'GitHub', url: 'https://mcp.github.com/sse' },
      { name: 'Notes', url: undefined },
    ])
    // Length pins that only managed servers land in the MCP-server ref
    // and only custom ones in the custom-server ref; `toEqual` alone
    // cannot see extra `undefined` entries.
    expect(busy.enabledCustomServersRef.current).toHaveLength(2)
    expect(busy.personalizationRef.current).toBe('Be terse.')

    // Loading stays true while any of the three sources is loading.
    expect(busy.isLoadingProviders).toBe(true)

    // --- Scenario B: every source settled, no provider selected.
    llmState.selectedProvider = null
    llmState.isLoading = false
    agentsState.loading = false

    const settled = renderHookOnce()

    // Loading clears only when providers, adapters and agents are all
    // done, and with no selected provider the first configured
    // provider's target is the resolved one.
    expect(settled.isLoadingProviders).toBe(false)
    expect(settled.selectedChatTarget).toEqual({
      kind: 'llm',
      id: 'browseros',
      name: 'BrowserOS',
      type: 'browseros',
      provider: browserosProvider,
    })
    expect(settled.selectedChatTargetRef.current).toEqual({
      kind: 'llm',
      id: 'browseros',
      name: 'BrowserOS',
      type: 'browseros',
      provider: browserosProvider,
    })

    // --- Scenario C: handing a selection to selectChatTarget.
    const acpTarget = settled.chatTargets.find(
      (target) => target.kind === 'acp',
    )
    expect(acpTarget).toBeDefined()

    await settled.selectChatTarget(acpTarget)

    // The selected-target ref follows the new choice immediately, and
    // the real persist call stores the target's identity - kind and id
    // only, never the whole provider config.
    expect(settled.selectedChatTargetRef.current).toEqual(acpTarget)
    expect(storedValues.get(selectionStorageKey)).toEqual({
      kind: 'acp',
      id: 'agent-codex',
    })

    // Clearing the selection stores a null and empties the ref.
    await settled.selectChatTarget(undefined)
    expect(settled.selectedChatTargetRef.current).toBeUndefined()
    expect(storedValues.get(selectionStorageKey)).toBeNull()
  })
})
