/**
 * Contract suite for the exports of AgentCommandHome.tsx.
 *
 * The module exports exactly one symbol: `AgentCommandHome`. Every
 * assertion below renders that export with React's server renderer and
 * asserts on the markup it emits plus the callbacks it hands to its
 * children, so the suite pins observable behaviour rather than the
 * shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`AgentCommandHome`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * Live dependencies are swapped for in-memory stubs via `mock.module`,
 * so this suite needs no network, no database and no container:
 *   - `react-router` provides `useNavigate`, which throws outside a
 *     Router tree; the stub records navigation targets.
 *   - `@/entrypoints/app/agents/useAgents` backs its hooks with
 *     react-query HTTP polling of the agent server; the stub serves
 *     in-memory agent and adapter lists.
 *   - `./agent-command-layout` exposes an outlet-context hook that
 *     only returns data when the layout above has mounted; the stub
 *     returns the context value directly.
 *   - `@/entrypoints/newtab/index/useActiveHint` reads browser
 *     extension storage (auth session + onboarding dismissals); the
 *     stub returns a plain value.
 *   - `./ConversationInput`, `./AgentCardDock`, `SignInHint` and
 *     `ImportDataHint` are real components whose own graphs need a
 *     live extension runtime (browser storage, MCP integrations over
 *     HTTP, query providers). They are replaced by stubs that render
 *     the props they receive, which is exactly the surface the home
 *     screen's contract with them lives on.
 *
 * The pure modules the subject composes stay real: `orderHomeAgents`
 * orders the recent-agents list for real inside this suite's renders,
 * and `./pending-initial-message` is the genuine registry the send
 * handler would stash into.
 *
 * Not pinned, and why: React's server renderer never commits effects
 * and `bun test` has no DOM environment in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so behaviour that only exists after the component's
 * `useEffect` runs is out of reach: the auto-selection of the first
 * agent (and with it the agent-naming placeholder and the enabled
 * composer), and the stash-then-navigate path of a send issued while
 * an agent is selected. What is pinned instead is the pre-effect
 * render (composer disabled with the not-running placeholder) and the
 * drop of a send that arrives before any selection. Those are gaps in
 * interaction coverage, not an export left unexercised: the export
 * itself is rendered and asserted on, so no export belongs in the
 * blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement, type FC } from 'react'
import { renderToString } from 'react-dom/server'
import type {
  HarnessAdapterDescriptor,
  HarnessAgent,
} from '@/entrypoints/app/agents/agent-harness-types'
import type {
  AgentEntry,
  OpenClawStatus,
} from '@/entrypoints/app/agents/useOpenClaw'
import { peekPendingInitialMessage } from './pending-initial-message'

// ---------------------------------------------------------------------------
// Mock-module state, consumed by the stubs below.
// ---------------------------------------------------------------------------

const navigations: string[] = []
const navigate = (to: string) => {
  navigations.push(to)
}

let layoutData: {
  agents: AgentEntry[]
  agentsLoading: boolean
  status: OpenClawStatus | null
  statusLoading: boolean
} = { agents: [], agentsLoading: false, status: null, statusLoading: false }

let harnessAgents: HarnessAgent[] = []
let adapters: HarnessAdapterDescriptor[] = []
let activeHint: 'signin' | 'import' | null = null

type ConversationInputStubProps = {
  variant?: 'home' | 'conversation'
  agents: AgentEntry[]
  selectedAgentId: string | null
  onSelectAgent: (agent: AgentEntry) => void
  onSend: (input: { text: string; attachments: unknown[] }) => void
  onCreateAgent?: () => void
  streaming: boolean
  disabled?: boolean
  status?: string
  placeholder?: string
  attachmentsEnabled?: boolean
}

type AgentCardDockStubProps = {
  agents: HarnessAgent[]
  adapters: HarnessAdapterDescriptor[]
  activeAgentId?: string
  onSelectAgent: (agentId: string) => void
  onCreateAgent?: () => void
}

let inputProps: ConversationInputStubProps | undefined
let dockProps: AgentCardDockStubProps | undefined

/** Renders every prop a reader needs to trace into markup, so the
 * assertions below can target the home screen's contract directly. */
const ConversationInputStub: FC<ConversationInputStubProps> = (props) => {
  inputProps = props
  return createElement(
    'div',
    {
      'data-testid': 'conversation-input',
      'data-variant': String(props.variant),
      'data-disabled': props.disabled === true ? 'true' : 'false',
      'data-status': props.status ?? 'unset',
      'data-selected-agent-id': props.selectedAgentId ?? 'null',
      'data-streaming': String(props.streaming),
      'data-placeholder': props.placeholder ?? '',
    },
    props.agents.map((agent) =>
      createElement(
        'span',
        { key: agent.agentId },
        `${agent.agentId}:${agent.name}`,
      ),
    ),
  )
}

/** Same idea for the recent-agents dock: child order in the markup is
 * the order the home screen handed over. */
const AgentCardDockStub: FC<AgentCardDockStubProps> = (props) => {
  dockProps = props
  return createElement(
    'div',
    {
      'data-testid': 'agent-card-dock',
      'data-active-agent-id': props.activeAgentId ?? 'null',
      'data-adapters': props.adapters.map((a) => a.id).join(','),
    },
    props.agents.map((agent) =>
      createElement('div', { key: agent.id }, `${agent.id}:${agent.name}`),
    ),
  )
}

mock.module('react-router', () => ({
  useNavigate: () => navigate,
}))

mock.module('./agent-command-layout', () => ({
  useAgentCommandData: () => layoutData,
}))

mock.module('@/entrypoints/app/agents/useAgents', () => ({
  useHarnessAgents: () => ({ harnessAgents, loading: false }),
  useAgentAdapters: () => ({ adapters, loading: false }),
}))

mock.module('@/entrypoints/newtab/index/useActiveHint', () => ({
  useActiveHint: () => activeHint,
}))

mock.module('@/entrypoints/newtab/index/SignInHint', () => ({
  SignInHint: () =>
    createElement('div', { 'data-testid': 'signin-hint' }, 'mounted'),
}))

mock.module('@/entrypoints/newtab/index/ImportDataHint', () => ({
  ImportDataHint: () =>
    createElement('div', { 'data-testid': 'import-hint' }, 'mounted'),
}))

mock.module('./ConversationInput', () => ({
  ConversationInput: ConversationInputStub,
}))

mock.module('./AgentCardDock', () => ({
  AgentCardDock: AgentCardDockStub,
}))

const { AgentCommandHome } = await import('./AgentCommandHome')

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function clawStatus(overrides: Partial<OpenClawStatus>): OpenClawStatus {
  return {
    status: 'running',
    podmanAvailable: true,
    machineReady: true,
    port: 4141,
    agentCount: 0,
    error: null,
    controlPlaneStatus: 'connected',
    lastGatewayError: null,
    ...overrides,
  }
}

function legacyAgent(overrides: Partial<AgentEntry>): AgentEntry {
  return {
    agentId: overrides.agentId ?? 'agent-x',
    name: overrides.name ?? overrides.agentId ?? 'agent-x',
    workspace: 'main',
    source: 'agent-harness',
    ...overrides,
  }
}

function harnessAgent(overrides: Partial<HarnessAgent>): HarnessAgent {
  return {
    id: overrides.id ?? 'oc-x',
    name: overrides.name ?? overrides.id ?? 'oc-x',
    adapter: 'codex',
    permissionMode: 'approve-all',
    sessionKey: `agent:${overrides.id ?? 'oc-x'}:main`,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function adapterDescriptor(
  id: HarnessAdapterDescriptor['id'],
): HarnessAdapterDescriptor {
  return {
    id,
    name: `${id} adapter`,
    defaultModelId: 'gpt-5',
    defaultReasoningEffort: 'medium',
    modelControl: 'runtime-supported',
    models: [],
    reasoningEfforts: [],
  }
}

function renderHome(): string {
  navigations.length = 0
  inputProps = undefined
  dockProps = undefined
  return renderToString(createElement(AgentCommandHome))
}

// ---------------------------------------------------------------------------
// The pinned contract.
// ---------------------------------------------------------------------------

describe('AgentCommandHomeTsxContract', () => {
  it('pins the exported AgentCommandHome component: home hero with wired composer and ordered recent agents, empty state, runtime-status pass-through, onboarding hints, and the callbacks it hands to its children', () => {
    // -- With agents: the home hero, the composer wiring, and the
    //    recent-agents section ordered by the real ordering helper.
    //    The server render happens before effects commit, so the
    //    composer still shows its not-selected state.
    layoutData = {
      agents: [
        legacyAgent({ agentId: 'legacy-a', name: 'Legacy A' }),
        legacyAgent({ agentId: 'legacy-b', name: 'Legacy B' }),
      ],
      agentsLoading: false,
      status: clawStatus({ status: 'running' }),
      statusLoading: false,
    }
    harnessAgents = [
      harnessAgent({ id: 'oc-a', name: 'Agent A', lastUsedAt: 5000 }),
      harnessAgent({
        id: 'oc-b',
        name: 'Agent B',
        lastUsedAt: 9000,
        activeTurnId: 'turn-1',
      }),
      harnessAgent({ id: 'oc-c', name: 'Agent C', lastUsedAt: 7000 }),
    ]
    adapters = [adapterDescriptor('codex')]
    activeHint = null

    const withAgents = renderHome()

    // Hero copy.
    expect(withAgents).toContain('What should your agent')
    expect(withAgents).toContain('>work on</span>')
    expect(withAgents).toContain('next?</h1>')
    expect(withAgents).toContain('all without leaving this tab.')

    // The composer receives the merged agent list, the home variant,
    // and - before its selection effect has committed - a disabled
    // composer with the not-running placeholder. The runtime status
    // from the layout context is passed straight through.
    expect(withAgents).toContain('data-testid="conversation-input"')
    expect(withAgents).toContain('data-variant="home"')
    expect(withAgents).toContain('data-disabled="true"')
    expect(withAgents).toContain('data-status="running"')
    expect(withAgents).toContain('data-selected-agent-id="null"')
    expect(withAgents).toContain('data-streaming="false"')
    expect(withAgents).toContain(
      'data-placeholder="Agent runtime is not running..."',
    )
    expect(withAgents).toContain('legacy-a:Legacy A')
    expect(withAgents).toContain('legacy-b:Legacy B')

    // Recent-agents section, with the dock receiving the adapters and
    // the harness agents already ordered by the real ordering helper
    // (active turn first, then most recently used).
    expect(withAgents).toContain('Recent agents')
    expect(withAgents).toContain('Continue from where you left off.')
    expect(withAgents).toContain('Manage agents')
    expect(withAgents).toContain('data-slot="separator"')
    expect(withAgents).toContain('data-testid="agent-card-dock"')
    expect(withAgents).toContain('data-adapters="codex"')
    expect(withAgents).toContain('data-active-agent-id="null"')
    const activeTurnAt = withAgents.indexOf('oc-b:Agent B')
    const midUseAt = withAgents.indexOf('oc-c:Agent C')
    const leastUseAt = withAgents.indexOf('oc-a:Agent A')
    expect(activeTurnAt).toBeGreaterThanOrEqual(0)
    expect(midUseAt).toBeGreaterThan(activeTurnAt)
    expect(leastUseAt).toBeGreaterThan(midUseAt)

    // No empty-state copy while agents exist.
    expect(withAgents).not.toContain('No agents yet')

    // -- The callback contract the home screen hands to its children.
    //    Each is the subject's own handler, invoked through the prop
    //    it was passed; the stubs merely recorded them.
    expect(inputProps).toBeDefined()
    expect(dockProps).toBeDefined()
    if (!inputProps || !dockProps) throw new Error('child stubs did not mount')

    inputProps.onCreateAgent?.()
    dockProps.onCreateAgent?.()
    dockProps.onSelectAgent('oc-zz')
    expect(navigations).toEqual(['/agents', '/agents', '/home/agents/oc-zz'])

    // A send issued before any agent is selected is dropped: no
    // navigation happens and nothing reaches the pending-message
    // registry.
    inputProps.onSend({ text: 'no recipient yet', attachments: [] })
    expect(navigations).toHaveLength(3)
    expect(peekPendingInitialMessage()).toBeNull()

    // -- No agents at all: the empty state replaces the hero.
    layoutData = {
      agents: [],
      agentsLoading: false,
      status: null,
      statusLoading: false,
    }
    harnessAgents = []
    adapters = []
    activeHint = null

    const empty = renderHome()

    expect(empty).toContain('No agents yet')
    expect(empty).toContain(
      'Create an agent to start using BrowserOS as an agent-first new tab.',
    )
    expect(empty).toContain('Create agent')
    expect(empty).not.toContain('What should your agent')
    expect(empty).not.toContain('Recent agents')
    expect(empty).not.toContain('data-testid="conversation-input"')
    expect(empty).not.toContain('data-testid="agent-card-dock"')
    expect(empty).not.toContain('data-testid="signin-hint"')
    expect(empty).not.toContain('data-testid="import-hint"')

    // -- A stopped runtime reaches the composer through the status
    //    pass-through, and the composer stays closed for business.
    layoutData = {
      agents: [legacyAgent({ agentId: 'legacy-a', name: 'Legacy A' })],
      agentsLoading: false,
      status: clawStatus({ status: 'stopped' }),
      statusLoading: false,
    }
    harnessAgents = []
    adapters = []
    activeHint = null

    const stopped = renderHome()

    expect(stopped).toContain('data-testid="conversation-input"')
    expect(stopped).toContain('data-status="stopped"')
    expect(stopped).toContain('data-disabled="true"')
    expect(stopped).toContain(
      'data-placeholder="Agent runtime is not running..."',
    )

    // -- Onboarding hints: exactly one renders, matching the active
    //    hint, and none render when there is no hint.
    layoutData = {
      agents: [legacyAgent({ agentId: 'legacy-a', name: 'Legacy A' })],
      agentsLoading: false,
      status: clawStatus({ status: 'running' }),
      statusLoading: false,
    }

    activeHint = 'signin'
    const signIn = renderHome()
    expect(signIn).toContain('data-testid="signin-hint"')
    expect(signIn).not.toContain('data-testid="import-hint"')

    activeHint = 'import'
    const importData = renderHome()
    expect(importData).toContain('data-testid="import-hint"')
    expect(importData).not.toContain('data-testid="signin-hint"')

    activeHint = null
    const noHint = renderHome()
    expect(noHint).not.toContain('data-testid="signin-hint"')
    expect(noHint).not.toContain('data-testid="import-hint"')
  })
})
