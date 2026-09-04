/**
 * Contract suite for useOpenClaw.ts.
 *
 * Every export of the subject is exercised below. None of them needed a
 * live dependency, so the blocked list is empty:
 *
 *   blocked exports: (none)
 *
 * The React hooks run against a real QueryClient and a real react-dom root;
 * only the two true boundaries are stubbed. The agent-server URL provider
 * (extension land, chrome APIs) is mocked at the module boundary, and global
 * fetch is mocked at the network boundary. No network, no database, no
 * container.
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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import type { AgentEntry, OpenClawStatus } from './useOpenClaw'

/* ------------------------------------------------------------------ *
 * Minimal DOM host for react-dom/client. The suite renders hook probes
 * that produce no host markup, so a small node/element/document shim is
 * all the renderer ever touches.
 * ------------------------------------------------------------------ */

class FakeNode {
  childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
  ) {}
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? []
    const index = siblings.indexOf(this)
    return index >= 0 ? (siblings[index + 1] ?? null) : null
  }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child)
    this.childNodes.push(child)
    child.parentNode = this
    return child
  }
  insertBefore(child: FakeNode, reference: FakeNode | null): FakeNode {
    if (reference === null) return this.appendChild(child)
    const index = this.childNodes.indexOf(reference)
    if (index < 0) this.childNodes.push(child)
    else this.childNodes.splice(index, 0, child)
    child.parentNode = this
    return child
  }
  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true
  }
}

class FakeText extends FakeNode {
  constructor(public data: string) {
    super(3, '#text')
  }
  get textContent(): string {
    return this.data
  }
  set textContent(value: string) {
    this.data = value
  }
  get nodeValue(): string {
    return this.data
  }
  set nodeValue(value: string) {
    this.data = value
  }
}

class FakeElement extends FakeNode {
  attributes: Record<string, string> = {}
  ownerDocument: FakeDocument | null = null
  style: Record<string, string> = {}
  constructor(tagName: string) {
    super(1, tagName.toUpperCase())
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value
  }
  get tagName(): string {
    return this.nodeName
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }
  removeAttribute(name: string): void {
    delete this.attributes[name]
  }
  get textContent(): string {
    return this.childNodes.map((child) => child.textContent ?? '').join('')
  }
  set textContent(value: string) {
    this.childNodes = []
    if (value !== '') this.appendChild(new FakeText(value))
  }
  contains(): boolean {
    return false
  }
}

class FakeDocument extends FakeNode {
  body: FakeElement
  documentElement: FakeElement
  activeElement: FakeElement | null = null
  implementation = { hasFeature: (): boolean => true }
  constructor() {
    super(9, '#document')
    this.body = this.createElement('body')
    this.documentElement = this.createElement('html')
  }
  createElement(tagName: string): FakeElement {
    const element = new FakeElement(tagName)
    element.ownerDocument = this
    return element
  }
  createTextNode(data: string): FakeText {
    return new FakeText(data)
  }
  createDocumentFragment(): FakeNode {
    return new FakeNode(11, '#document-fragment')
  }
  createComment(data: string): FakeNode {
    return new FakeNode(8, `#comment ${data}`)
  }
}

const originalDocument = (globalThis as { document?: unknown }).document
const originalWindow = (globalThis as { window?: unknown }).window
const originalActEnvironment = (
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT
const fakeDocument = new FakeDocument()
const fakeWindow = {
  event: undefined,
  document: fakeDocument,
  HTMLIFrameElement: class FakeHTMLIFrameElement {},
  addEventListener(): void {},
  removeEventListener(): void {},
}
;(globalThis as { document?: unknown }).document = fakeDocument
;(globalThis as { window?: unknown }).window = fakeWindow
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/* ------------------------------------------------------------------ *
 * Boundaries under mock: the extension-side URL provider, and fetch.
 * ------------------------------------------------------------------ */

const providerState = {
  baseUrl: null as string | null,
  isLoading: true,
  error: null as Error | null,
}

mock.module('../../../lib/browseros/useBrowserOSProviders', () => ({
  useAgentServerUrl: () => ({
    baseUrl: providerState.baseUrl,
    isLoading: providerState.isLoading,
    error: providerState.error,
  }),
}))

const {
  OPENCLAW_QUERY_KEYS,
  buildChatHistoryFromTurns,
  getModelDisplayName,
  useOpenClawAgents,
  useOpenClawMutations,
  useOpenClawStatus,
} = await import('./useOpenClaw')

const { createRoot } = await import('react-dom/client')

type FetchResult = { ok: boolean; status: number; json: () => Promise<unknown> }
type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => FetchResult | Promise<FetchResult>

const jsonResponse = (payload: unknown, status = 200): FetchResult => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(payload),
})

const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = []
let fetchHandler: FetchHandler = () => jsonResponse({})
const fetchMock = mock(
  async (input: unknown, init?: RequestInit): Promise<FetchResult> => {
    const url = typeof input === 'string' ? input : String(input)
    fetchCalls.push({ url, init })
    return await fetchHandler(url, init)
  },
)
const originalFetch = globalThis.fetch
globalThis.fetch = fetchMock as unknown as typeof fetch

/* ------------------------------------------------------------------ *
 * Hook harness: renders probe functions inside a QueryClientProvider.
 * ------------------------------------------------------------------ */

interface Mounted {
  values(): unknown[]
  rerender(): void
  unmount(): void
}

const mountedHarnesses: Mounted[] = []
const mountedClients: QueryClient[] = []

function freshClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  mountedClients.push(client)
  return client
}

function mount(client: QueryClient, probes: Array<() => unknown>): Mounted {
  const store: unknown[] = []
  function Probe(): null {
    for (let index = 0; index < probes.length; index += 1) {
      store[index] = probes[index]()
    }
    return null
  }
  const container = fakeDocument.createElement('div')
  const root = createRoot(container)
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Probe)),
    )
  })
  const harness: Mounted = {
    values: () => store.slice(),
    rerender: () => {
      act(() => {
        root.render(
          createElement(QueryClientProvider, { client }, createElement(Probe)),
        )
      })
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
    },
  }
  mountedHarnesses.push(harness)
  return harness
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

/* ------------------------------------------------------------------ *
 * Shared fixtures.
 * ------------------------------------------------------------------ */

const BASE = 'http://127.0.0.1:5151'

const statusPayload: OpenClawStatus = {
  status: 'running',
  podmanAvailable: true,
  machineReady: true,
  port: 5151,
  agentCount: 1,
  error: null,
  controlPlaneStatus: 'connected',
  lastGatewayError: null,
  lastRecoveryReason: null,
}

const rawAgent = {
  agentId: 'a-1',
  name: 'Helper',
  workspace: '/tmp/review',
} satisfies AgentEntry

type StatusResult = {
  status: OpenClawStatus | null
  loading: boolean
  error: Error | null
  refetch: unknown
}

type AgentsResult = {
  agents: AgentEntry[]
  loading: boolean
  error: Error | null
  refetch: unknown
}

type MutationsResult = {
  setupOpenClaw: (input: Record<string, unknown>) => Promise<unknown>
  createAgent: (input: Record<string, unknown>) => Promise<unknown>
  deleteAgent: (id: string) => Promise<unknown>
  startOpenClaw: () => Promise<unknown>
  stopOpenClaw: () => Promise<unknown>
  restartOpenClaw: () => Promise<unknown>
  reconnectOpenClaw: () => Promise<unknown>
  actionInProgress: boolean
  settingUp: boolean
  creating: boolean
  deleting: boolean
  reconnecting: boolean
  pendingGatewayAction: string | null
}

const callsFor = (
  method: string,
  path: string,
): Array<{ url: string; init: RequestInit | undefined }> =>
  fetchCalls.filter(
    (call) =>
      call.url === `${BASE}${path}` && (call.init?.method ?? 'GET') === method,
  )

beforeEach(() => {
  providerState.baseUrl = null
  providerState.isLoading = true
  providerState.error = null
  fetchCalls.length = 0
  fetchHandler = () => jsonResponse({})
})

afterEach(() => {
  for (const harness of mountedHarnesses.splice(0)) harness.unmount()
  for (const client of mountedClients.splice(0)) client.clear()
})

afterAll(async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
  globalThis.fetch = originalFetch
  const globals = globalThis as {
    document?: unknown
    window?: unknown
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
  if (originalDocument === undefined) delete globals.document
  else globals.document = originalDocument
  if (originalWindow === undefined) delete globals.window
  else globals.window = originalWindow
  if (originalActEnvironment === undefined) {
    delete globals.IS_REACT_ACT_ENVIRONMENT
  } else {
    globals.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  }
})

describe('useOpenClawContract', () => {
  it('getModelDisplayName returns the last path segment of a model string and undefined for anything else', () => {
    expect(getModelDisplayName('openai/gpt-4o')).toBe('gpt-4o')
    expect(getModelDisplayName('bedrock/anthropic/claude-3')).toBe('claude-3')
    expect(getModelDisplayName('local-model')).toBe('local-model')
    expect(getModelDisplayName(42)).toBeUndefined()
    expect(getModelDisplayName(null)).toBeUndefined()
    expect(getModelDisplayName(undefined)).toBeUndefined()
    expect(getModelDisplayName({ nested: true })).toBeUndefined()
  })

  it('OPENCLAW_QUERY_KEYS keeps the status cache and the agents cache apart', async () => {
    expect(typeof OPENCLAW_QUERY_KEYS.status).toBe('string')
    expect(OPENCLAW_QUERY_KEYS.status.length).toBeGreaterThan(0)
    expect(typeof OPENCLAW_QUERY_KEYS.agents).toBe('string')
    expect(OPENCLAW_QUERY_KEYS.agents.length).toBeGreaterThan(0)
    expect(OPENCLAW_QUERY_KEYS.status).not.toBe(OPENCLAW_QUERY_KEYS.agents)

    providerState.baseUrl = BASE
    providerState.isLoading = false
    fetchHandler = (url) =>
      jsonResponse(
        url.endsWith('/claw/status') ? statusPayload : { agents: [rawAgent] },
      )
    const harness = mount(freshClient(), [useOpenClawStatus, useOpenClawAgents])
    await settle()
    const [statusResult, agentsResult] = harness.values() as [
      StatusResult,
      AgentsResult,
    ]
    expect(statusResult.status).toEqual(statusPayload)
    expect(agentsResult.agents).toEqual([{ ...rawAgent, source: 'openclaw' }])
  })

  it('useOpenClawStatus stays idle while the server URL loads, then reads the status route and surfaces server errors', async () => {
    const harness = mount(freshClient(), [useOpenClawStatus])
    await settle()
    const pending = harness.values()[0] as StatusResult
    expect(pending.loading).toBe(true)
    expect(pending.status).toBe(null)
    expect(pending.error).toBe(null)
    expect(fetchCalls).toHaveLength(0)

    providerState.baseUrl = BASE
    providerState.isLoading = false
    fetchHandler = () => jsonResponse(statusPayload)
    harness.rerender()
    await settle()
    const ready = harness.values()[0] as StatusResult
    expect(ready.loading).toBe(false)
    expect(ready.error).toBe(null)
    expect(ready.status).toEqual(statusPayload)
    const statusCalls = callsFor('GET', '/claw/status')
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0]?.init).toBeUndefined()

    fetchHandler = () => jsonResponse({ error: 'podman machine is gone' }, 503)
    const failing = mount(freshClient(), [useOpenClawStatus])
    await settle()
    const errored = failing.values()[0] as StatusResult
    expect(errored.loading).toBe(false)
    expect(errored.status).toBe(null)
    expect(errored.error).toBeInstanceOf(Error)
    expect((errored.error as Error).message).toBe('podman machine is gone')
  })

  it('useOpenClawAgents stays silent while disabled, then lists tagged openclaw agents once enabled', async () => {
    providerState.baseUrl = BASE
    providerState.isLoading = false
    fetchHandler = () => jsonResponse({ agents: [rawAgent] })
    const scenario = { agentsEnabled: false }
    const harness = mount(freshClient(), [
      () => useOpenClawAgents(scenario.agentsEnabled),
    ])
    await settle()
    const disabled = harness.values()[0] as AgentsResult
    expect(fetchCalls).toHaveLength(0)
    expect(disabled.agents).toEqual([])
    expect(disabled.loading).toBe(false)

    scenario.agentsEnabled = true
    harness.rerender()
    await settle()
    const enabled = harness.values()[0] as AgentsResult
    expect(enabled.loading).toBe(false)
    expect(enabled.error).toBe(null)
    expect(enabled.agents).toEqual([{ ...rawAgent, source: 'openclaw' }])
    expect(callsFor('GET', '/claw/agents')).toHaveLength(1)

    fetchHandler = () => jsonResponse({})
    const empty = mount(freshClient(), [useOpenClawAgents])
    await settle()
    expect((empty.values()[0] as AgentsResult).agents).toEqual([])
  })

  it('useOpenClawMutations posts to the claw routes, invalidates both queries on success and refuses to run before the server URL is ready', async () => {
    providerState.baseUrl = BASE
    providerState.isLoading = false
    const routes: Record<string, unknown> = {
      'GET /claw/status': statusPayload,
      'GET /claw/agents': { agents: [rawAgent] },
      'POST /claw/setup': { status: 'starting' },
      'POST /claw/agents': {
        agent: { ...rawAgent, agentId: 'a-2', name: 'Bot' },
      },
      'DELETE /claw/agents/a-1': { success: true },
      'POST /claw/start': { status: 'running' },
      'POST /claw/restart': { status: 'restarting' },
    }
    let releaseSetup: (() => void) | null = null
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve
    })
    fetchHandler = (url, init) => {
      const method = init?.method ?? 'GET'
      const route = `${method} ${url.slice(BASE.length)}`
      if (route === 'POST /claw/setup') {
        return setupGate.then(() => jsonResponse(routes[route] ?? {}))
      }
      return jsonResponse(routes[route] ?? {})
    }
    const harness = mount(freshClient(), [
      useOpenClawStatus,
      useOpenClawAgents,
      useOpenClawMutations,
    ])
    await settle()
    const mutations = () => harness.values()[2] as MutationsResult
    expect(callsFor('GET', '/claw/status')).toHaveLength(1)
    expect(callsFor('GET', '/claw/agents')).toHaveLength(1)

    let setupPromise: Promise<unknown> = Promise.resolve(null)
    await act(async () => {
      setupPromise = mutations().setupOpenClaw({ providerType: 'openai' })
    })
    await settle()
    expect(mutations().pendingGatewayAction).toBe('setup')
    expect(mutations().actionInProgress).toBe(true)
    expect(mutations().settingUp).toBe(true)
    expect(callsFor('POST', '/claw/setup')).toHaveLength(1)

    let setupResult: unknown = null
    await act(async () => {
      releaseSetup?.()
      setupResult = await setupPromise
    })
    await settle()
    expect(setupResult).toEqual({ status: 'starting' })
    expect(mutations().pendingGatewayAction).toBe(null)
    expect(mutations().actionInProgress).toBe(false)
    expect(callsFor('GET', '/claw/status')).toHaveLength(2)
    expect(callsFor('GET', '/claw/agents')).toHaveLength(2)

    let created: unknown = null
    await act(async () => {
      created = await mutations().createAgent({
        name: 'Bot',
        providerType: 'openai',
        providerName: 'OpenAI',
        modelId: 'gpt-5',
      })
    })
    await settle()
    expect(created).toEqual({
      agent: { agentId: 'a-2', name: 'Bot', workspace: '/tmp/review' },
    })
    const createCalls = callsFor('POST', '/claw/agents')
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.init?.method).toBe('POST')
    expect(createCalls[0]?.init?.headers).toEqual({
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(createCalls[0]?.init?.body))).toEqual({
      name: 'Bot',
      providerType: 'openai',
      providerName: 'OpenAI',
      modelId: 'gpt-5',
    })

    let deleted: unknown = null
    await act(async () => {
      deleted = await mutations().deleteAgent('a-1')
    })
    await settle()
    expect(deleted).toEqual({ success: true })
    const deleteCalls = callsFor('DELETE', '/claw/agents/a-1')
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0]?.init?.method).toBe('DELETE')

    let started: unknown = null
    await act(async () => {
      started = await mutations().startOpenClaw()
    })
    await settle()
    expect(started).toEqual({ status: 'running' })
    const startCalls = callsFor('POST', '/claw/start')
    expect(startCalls).toHaveLength(1)
    expect(startCalls[0]?.init?.body).toBeUndefined()

    let restarted: unknown = null
    await act(async () => {
      restarted = await mutations().restartOpenClaw()
    })
    await settle()
    expect(restarted).toEqual({ status: 'restarting' })

    providerState.baseUrl = null
    providerState.isLoading = true
    const fetchCountBeforeColdRun = fetchCalls.length
    const coldHarness = mount(freshClient(), [useOpenClawMutations])
    const coldMutations = () => coldHarness.values()[0] as MutationsResult
    let guardError: unknown = null
    await act(async () => {
      try {
        await coldMutations().setupOpenClaw({ providerType: 'openai' })
      } catch (error) {
        guardError = error
      }
    })
    await settle()
    expect(guardError).toBeInstanceOf(Error)
    expect((guardError as Error).message).toBe(
      'BrowserOS agent server URL is not ready',
    )
    expect(fetchCalls.length).toBe(fetchCountBeforeColdRun)
  })

  it('buildChatHistoryFromTurns folds turns into trimmed user and assistant messages', () => {
    expect(
      buildChatHistoryFromTurns([
        {
          userText: '  Fix the login page  ',
          parts: [
            { kind: 'text', text: '  Reading the routes.  ' },
            { kind: 'tool-start', text: 'ignored' },
            { kind: 'text', text: 'Done.' },
            { kind: 'text', text: '   ' },
            { kind: 'text' },
          ],
        },
        { userText: '', parts: [{ kind: 'text', text: ' Orphan answer ' }] },
        { userText: 'One more', parts: [] },
      ]),
    ).toEqual([
      { role: 'user', content: 'Fix the login page' },
      { role: 'assistant', content: 'Reading the routes.\n\nDone.' },
      { role: 'assistant', content: 'Orphan answer' },
      { role: 'user', content: 'One more' },
    ])

    expect(buildChatHistoryFromTurns([])).toEqual([])
  })
})
