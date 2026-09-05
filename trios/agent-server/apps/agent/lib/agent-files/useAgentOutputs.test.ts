/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Contract suite for the exports of useAgentOutputs.ts.
 *
 * The module exports exactly four symbols: `useAgentOutputs`,
 * `useAgentTurnFiles`, `useInvalidateAgentOutputs` and
 * `useRefreshAgentOutputs`.
 *
 * Export accounting (the module has 4 exports in total):
 *   - exercised by assertions below: 4, one block per export, each named
 *     after the export it covers
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 4 + 0 = 4, matching the export count of the module.
 *
 * The module's only live dependencies are the agent server itself, reached
 * through the HTTP transport `agentsFetch` from
 * '@/entrypoints/app/agents/useAgents', and the browser capabilities layer
 * that resolves the server base URL, `useAgentServerUrl` from
 * '@/lib/browseros/useBrowserOSProviders'. Both are swapped for in-memory
 * stand-ins via `mock.module`, so this suite needs no network, no database
 * and no container. Everything else runs real: a real QueryClient, the
 * real react-query hooks and real React rendering.
 *
 * Rendering happens through react-dom/client against a hand-rolled
 * minimal root container, because the lockfile carries no jsdom,
 * happy-dom, react-test-renderer or @testing-library. The probes below
 * render null, so react-dom only ever exercises the root-container member
 * set the fake implements; no DOM instance is ever created.
 *
 * AGENT_QUERY_KEYS is snapshotted from the real useAgents module before
 * the transport is stubbed, so the cache-key assertion below pins the
 * application's real key object, not a local copy.
 */
// biome-ignore-all lint/suspicious/noExplicitAny: the fake DOM below is a structural stand-in; react-dom only ever sees the handful of members it implements.
// biome-ignore-all lint/suspicious/noNonNullAssertion: probe state is assigned by the first render, which every assertion here waits for.

import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import type { QueryClient } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type {
  ProducedFile,
  ProducedFilesRailGroup,
} from './types'

/* ------------------------------------------------------------------ *
 * Module-under-test wiring: stub the two agent-local dependencies.
 * ------------------------------------------------------------------ */

const serverUrl = {
  baseUrl: null as string | null,
  isLoading: false,
  error: null as Error | null,
}

mock.module('@/lib/browseros/useBrowserOSProviders', () => ({
  useAgentServerUrl: () => ({ ...serverUrl }),
}))

// Snapshot the real exports before the transport is stubbed: bun swaps
// the module namespace in place, so only this copy is guaranteed to hold
// the pre-mock values while the suite runs.
import * as loadedUseAgents from '@/entrypoints/app/agents/useAgents'

const realUseAgentsExports = { ...loadedUseAgents }

type FetchCall = { baseUrl: string; path: string }
const fetchCalls: FetchCall[] = []
let transport: (call: FetchCall) => Promise<unknown> = () =>
  Promise.reject(new Error('no transport installed'))

mock.module('@/entrypoints/app/agents/useAgents', () => ({
  ...realUseAgentsExports,
  agentsFetch: (baseUrl: string, path: string) => {
    const call = { baseUrl, path }
    fetchCalls.push(call)
    return transport(call)
  },
}))

const {
  useAgentOutputs,
  useAgentTurnFiles,
  useInvalidateAgentOutputs,
  useRefreshAgentOutputs,
} = await import('./useAgentOutputs')

/* ------------------------------------------------------------------ *
 * Minimal DOM + React client rendering
 * ------------------------------------------------------------------ */

function makeNode(
  nodeType: number,
  name: string,
  nodeValue: string | null = null,
) {
  const node: any = {
    nodeType,
    nodeName: name,
    tagName: nodeType === 1 ? name : undefined,
    nodeValue,
    childNodes: [] as any[],
    parentNode: null as any,
    ownerDocument: null as any,
    addEventListener: (_type: string, _listener: () => void) => {},
    removeEventListener: (_type: string, _listener: () => void) => {},
    dispatchEvent: () => true,
    appendChild(child: any) {
      child.parentNode = node
      node.childNodes.push(child)
      return child
    },
    insertBefore(child: any, before: any) {
      child.parentNode = node
      const at = before ? node.childNodes.indexOf(before) : -1
      if (at === -1) {
        node.childNodes.push(child)
      } else {
        node.childNodes.splice(at, 0, child)
      }
      return child
    },
    removeChild(child: any) {
      const at = node.childNodes.indexOf(child)
      if (at !== -1) {
        node.childNodes.splice(at, 1)
      }
      child.parentNode = null
      return child
    },
    contains(candidate: any): boolean {
      let walk: any = candidate
      while (walk !== null && walk !== undefined) {
        if (walk === node) {
          return true
        }
        walk = walk.parentNode
      }
      return false
    },
    setAttribute: () => {},
    removeAttribute: () => {},
    getAttribute: () => null,
    hasAttribute: () => false,
    style: {},
    textContent: '',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
  }
  Object.defineProperties(node, {
    firstChild: { get: () => node.childNodes[0] ?? null },
    lastChild: {
      get: () => node.childNodes[node.childNodes.length - 1] ?? null,
    },
    nextSibling: {
      get: () => {
        const parent = node.parentNode
        if (!parent) {
          return null
        }
        const at = parent.childNodes.indexOf(node)
        return parent.childNodes[at + 1] ?? null
      },
    },
    previousSibling: {
      get: () => {
        const parent = node.parentNode
        if (!parent) {
          return null
        }
        const at = parent.childNodes.indexOf(node)
        return parent.childNodes[at - 1] ?? null
      },
    },
  })
  return node
}

const fakeDocument: any = makeNode(9, '#document')
fakeDocument.createElement = (tag: string) => makeNode(1, tag.toUpperCase())
fakeDocument.createTextNode = (text: string) => makeNode(3, '#text', text)
fakeDocument.createComment = (text: string) => makeNode(8, '#comment', text)
fakeDocument.createDocumentFragment = () => makeNode(11, '#document-fragment')
fakeDocument.documentElement = makeNode(1, 'HTML')
fakeDocument.body = makeNode(1, 'BODY')
fakeDocument.defaultView = globalThis
fakeDocument.implementation = { hasFeature: () => true }
fakeDocument.activeElement = fakeDocument.body
class FakeHTMLIFrameElement {}
fakeDocument.HTMLIFrameElement = FakeHTMLIFrameElement

const installedGlobals: Array<[string, any]> = []
function installRendererGlobals() {
  const globals = globalThis as any
  const toInstall: Array<[string, any]> = [
    ['document', fakeDocument],
    ['window', globalThis],
    ['HTMLIFrameElement', FakeHTMLIFrameElement],
  ]
  for (const [key, value] of toInstall) {
    installedGlobals.push([key, globals[key]])
    globals[key] = value
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true
}

installRendererGlobals()

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const reactQuery = await import('@tanstack/react-query')

/* ------------------------------------------------------------------ *
 * Probe + harness helpers
 * ------------------------------------------------------------------ */

type Probe<T> = {
  element: (key: string) => ReactElement
  current: () => T | undefined
}

function makeProbe<T>(useHook: () => T): Probe<T> {
  let latest: T | undefined
  function ProbeComponent() {
    latest = useHook()
    return null
  }
  return {
    element: (key: string) => createElement(ProbeComponent, { key }),
    current: () => latest,
  }
}

class ClientHarness {
  readonly queryClient: QueryClient
  private readonly root: any
  private readonly container: any

  constructor() {
    this.queryClient = new reactQuery.QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    // Each harness owns its container so concurrent harnesses never stack
    // roots on the same node.
    this.container = fakeDocument.createElement('div')
    this.container.ownerDocument = fakeDocument
    fakeDocument.documentElement.appendChild(this.container)
    this.root = createRoot(this.container)
    openHarnesses.push(this)
  }

  async render(probes: Array<Probe<unknown>>) {
    await act(async () => {
      this.root.render(
        createElement(
          reactQuery.QueryClientProvider,
          { client: this.queryClient },
          probes.map((probe, index) => probe.element(`probe-${index}`)),
        ),
      )
    })
  }

  async unmount() {
    await act(async () => {
      this.root.unmount()
    })
    this.queryClient.clear()
    fakeDocument.documentElement.removeChild(this.container)
  }
}

const openHarnesses: ClientHarness[] = []

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()
    await harness?.unmount()
  }
})

afterAll(() => {
  const globals = globalThis as any
  for (const [key, previous] of installedGlobals) {
    if (previous === undefined) {
      delete globals[key]
    } else {
      globals[key] = previous
    }
  }
  delete globals.IS_REACT_ACT_ENVIRONMENT
})

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const file = (id: string, path: string): ProducedFile => ({
  id,
  path,
  size: 10,
  mtimeMs: 5,
  createdAt: 1,
  detectedBy: 'diff',
})

const fileOne = file('file-one', 'report/one.md')
const fileTwo = file('file-two', 'report/two.md')
const fileThree = file('file-three', 'report/three.md')
const fileFour = file('file-four', 'report/four.md')

const railGroup = (
  turnId: string,
  prompt: string,
  entries: ProducedFile[],
): ProducedFilesRailGroup => ({
  turnId,
  turnPrompt: prompt,
  createdAt: 100,
  files: entries,
})

const groupSevenA = railGroup('turn-1', 'Summarize the run', [fileOne])
const groupSevenB = railGroup('turn-2', 'Summarize the rerun', [fileTwo])
const groupEight = railGroup('turn-9', 'Unrelated work', [fileThree])
const groupNineA = railGroup('turn-1', 'Other agent work', [fileFour])

const baseUrlForTest = 'http://agent.local:9001'
const agentOutputsKey = realUseAgentsExports.AGENT_QUERY_KEYS.agentOutputs

async function pollUntil(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the state under test')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function startWithUrlReady() {
  serverUrl.baseUrl = baseUrlForTest
  serverUrl.isLoading = false
  serverUrl.error = null
  fetchCalls.length = 0
}

function routeByPath(payloads: Record<string, unknown>) {
  transport = ({ path }) =>
    Promise.resolve(path in payloads ? payloads[path] : {})
}

/* ------------------------------------------------------------------ *
 * The contract
 * ------------------------------------------------------------------ */

describe('useAgentOutputsContract', () => {
  it('useAgentOutputs serves the rail groups fetched for one agent', async () => {
    startWithUrlReady()
    const payloads: Record<string, unknown> = {
      '/agent-7/files': { groups: [groupSevenA] },
    }
    routeByPath(payloads)

    const rail = makeProbe(() => useAgentOutputs('agent-7'))
    const harness = new ClientHarness()
    await harness.render([rail])
    await act(async () => {
      await pollUntil(() => rail.current()?.loading === false)
    })

    // The rail fetched the agent's outputs endpoint and mapped its groups.
    expect(fetchCalls).toEqual([
      { baseUrl: baseUrlForTest, path: '/agent-7/files' },
    ])
    expect(rail.current()?.groups).toEqual([groupSevenA])
    expect(rail.current()?.error).toBeNull()
    // The query lands in the cache under the documented key shape
    // [agentOutputs, baseUrl, agentId], using the real key constant.
    expect(
      harness.queryClient
        .getQueryCache()
        .find([agentOutputsKey, baseUrlForTest, 'agent-7']),
    ).toBeDefined()

    // A payload without a groups field renders an empty rail.
    payloads['/agent-7/files'] = {}
    await act(async () => {
      await rail.current()?.refetch()
      await pollUntil(
        () =>
          rail.current()?.groups.length === 0 &&
          rail.current()?.loading === false,
      )
    })
    expect(rail.current()?.groups).toEqual([])
    expect(rail.current()?.error).toBeNull()

    // A failing transport surfaces as `error` while groups fall back to [].
    transport = () => Promise.reject(new Error('server exploded'))
    await act(async () => {
      await rail.current()?.refetch()
      await pollUntil(
        () =>
          rail.current()?.error !== null &&
          rail.current()?.loading === false,
      )
    })
    expect(rail.current()?.error).toBeInstanceOf(Error)
    expect((rail.current()?.error as Error).message).toBe('server exploded')
    expect(rail.current()?.groups).toEqual([])

    // While the server URL is still resolving, no request leaves and the
    // rail reports loading with no data.
    serverUrl.baseUrl = null
    serverUrl.isLoading = true
    fetchCalls.length = 0
    const waitingRail = makeProbe(() => useAgentOutputs('agent-8'))
    const waitingHarness = new ClientHarness()
    await waitingHarness.render([waitingRail])
    expect(fetchCalls).toHaveLength(0)
    expect(waitingRail.current()).toMatchObject({
      groups: [],
      loading: true,
      error: null,
    })
  })

  it('useAgentTurnFiles serves the per-turn files and stays idle without a turn', async () => {
    startWithUrlReady()
    const payloads: Record<string, unknown> = {
      '/agent-7/files/turn/turn-1': { files: [fileOne, fileTwo] },
    }
    routeByPath(payloads)

    const harness = new ClientHarness()
    const idleCard = makeProbe(() => useAgentTurnFiles('agent-7', null))
    await harness.render([idleCard])
    // No turn selected: no request leaves and nothing is in flight.
    expect(fetchCalls).toHaveLength(0)
    expect(idleCard.current()).toMatchObject({
      files: [],
      loading: false,
      error: null,
    })

    const card = makeProbe(() => useAgentTurnFiles('agent-7', 'turn-1'))
    await harness.render([idleCard, card])
    await act(async () => {
      await pollUntil(() => card.current()?.loading === false)
    })
    expect(fetchCalls).toEqual([
      { baseUrl: baseUrlForTest, path: '/agent-7/files/turn/turn-1' },
    ])
    expect(card.current()?.files).toEqual([fileOne, fileTwo])
    expect(card.current()?.error).toBeNull()

    // A payload without a files field renders an empty card.
    payloads['/agent-7/files/turn/turn-1'] = {}
    await act(async () => {
      await card.current()?.refetch()
      await pollUntil(
        () =>
          card.current()?.files.length === 0 &&
          card.current()?.loading === false,
      )
    })
    expect(card.current()?.files).toEqual([])

    // Agent and turn ids are encoded into the request path.
    const encodedPath = '/agent%207/files/turn/turn%2F1'
    const encodedCard = makeProbe(() => useAgentTurnFiles('agent 7', 'turn/1'))
    await harness.render([idleCard, card, encodedCard])
    await act(async () => {
      await pollUntil(() => encodedCard.current()?.loading === false)
    })
    expect(
      fetchCalls.find((call) => call.path === encodedPath),
    ).toMatchObject({ baseUrl: baseUrlForTest })
  })

  it('useInvalidateAgentOutputs refetches the agent outputs and turn files', async () => {
    startWithUrlReady()
    const payloads: Record<string, unknown> = {
      '/agent-7/files': { groups: [groupSevenA] },
      '/agent-7/files/turn/turn-1': { files: [fileOne] },
      '/agent-7/files/turn/turn-2': { files: [fileTwo] },
      '/agent-8/files': { groups: [groupEight] },
    }
    routeByPath(payloads)

    const harness = new ClientHarness()
    const railSeven = makeProbe(() => useAgentOutputs('agent-7'))
    const cardOne = makeProbe(() => useAgentTurnFiles('agent-7', 'turn-1'))
    const cardTwo = makeProbe(() => useAgentTurnFiles('agent-7', 'turn-2'))
    const railEight = makeProbe(() => useAgentOutputs('agent-8'))
    const invalidator = makeProbe(() => useInvalidateAgentOutputs())
    await harness.render([
      railSeven,
      cardOne,
      cardTwo,
      railEight,
      invalidator,
    ])
    await act(async () => {
      await pollUntil(
        () =>
          railSeven.current()?.loading === false &&
          cardOne.current()?.loading === false &&
          cardTwo.current()?.loading === false &&
          railEight.current()?.loading === false,
      )
    })
    expect(railSeven.current()?.groups).toEqual([groupSevenA])
    expect(cardOne.current()?.files).toEqual([fileOne])
    expect(cardTwo.current()?.files).toEqual([fileTwo])
    expect(railEight.current()?.groups).toEqual([groupEight])

    const fetchCount = (path: string) =>
      fetchCalls.filter((call) => call.path === path).length

    // New data the server attributed during a turn...
    payloads['/agent-7/files'] = { groups: [groupSevenA, groupSevenB] }
    payloads['/agent-7/files/turn/turn-1'] = { files: [fileOne, fileThree] }

    // ...is picked up by invalidating the agent's whole query family,
    // without touching another agent's cached outputs. This exercises the
    // predicate the module uses to sidestep react-query's positional
    // partial-match over the baseUrl slot.
    await act(async () => {
      await invalidator.current()?.('agent-7')
      await pollUntil(
        () =>
          railSeven.current()?.groups.length === 2 &&
          cardOne.current()?.files.length === 2 &&
          cardTwo.current()?.loading === false &&
          railSeven.current()?.loading === false,
      )
    })
    expect(railSeven.current()?.groups).toEqual([groupSevenA, groupSevenB])
    expect(cardOne.current()?.files).toEqual([fileOne, fileThree])
    expect(cardTwo.current()?.files).toEqual([fileTwo])
    expect(railEight.current()?.groups).toEqual([groupEight])
    expect(fetchCount('/agent-7/files')).toBe(2)
    expect(fetchCount('/agent-7/files/turn/turn-1')).toBe(2)
    expect(fetchCount('/agent-7/files/turn/turn-2')).toBe(2)
    expect(fetchCount('/agent-8/files')).toBe(1)

    // Supplying a turn id scopes the turn-files invalidation to that turn.
    payloads['/agent-7/files/turn/turn-2'] = { files: [fileTwo, fileFour] }
    await act(async () => {
      await invalidator.current()?.('agent-7', 'turn-2')
      await pollUntil(
        () =>
          cardTwo.current()?.files.length === 2 &&
          cardTwo.current()?.loading === false &&
          railSeven.current()?.loading === false,
      )
    })
    expect(cardTwo.current()?.files).toEqual([fileTwo, fileFour])
    expect(cardOne.current()?.files).toEqual([fileOne, fileThree])
    expect(fetchCount('/agent-7/files/turn/turn-2')).toBe(3)
    expect(fetchCount('/agent-7/files/turn/turn-1')).toBe(2)
    expect(fetchCount('/agent-7/files')).toBe(3)
    expect(fetchCount('/agent-8/files')).toBe(1)
  })

  it('useRefreshAgentOutputs refetches exactly the given agent outputs', async () => {
    startWithUrlReady()
    const payloads: Record<string, unknown> = {
      '/agent-7/files': { groups: [groupSevenA] },
      '/agent-9/files': { groups: [groupNineA] },
    }
    const secondPayload = { groups: [groupSevenA, groupSevenB] }
    let gate: Promise<unknown> = Promise.resolve(null)
    let releaseGate: ((payload: typeof secondPayload) => void) | undefined
    let gateArmed = false
    transport = ({ path }) => {
      if (path === '/agent-7/files' && gateArmed) {
        return gate
      }
      return Promise.resolve(path in payloads ? payloads[path] : {})
    }

    const harness = new ClientHarness()
    const railSeven = makeProbe(() => useAgentOutputs('agent-7'))
    const railNine = makeProbe(() => useAgentOutputs('agent-9'))
    const refresh = makeProbe(() => useRefreshAgentOutputs('agent-7'))
    await harness.render([railSeven, railNine, refresh])
    await act(async () => {
      await pollUntil(
        () =>
          railSeven.current()?.loading === false &&
          railNine.current()?.loading === false,
      )
    })
    expect(railSeven.current()?.groups).toEqual([groupSevenA])
    expect(railNine.current()?.groups).toEqual([groupNineA])
    // The refresh button starts idle.
    expect(refresh.current()?.isPending).toBe(false)

    const fetchCount = (path: string) =>
      fetchCalls.filter((call) => call.path === path).length

    // Arm a gate so the refreshed request can be observed in flight.
    gate = new Promise((resolve) => {
      releaseGate = resolve
    })
    gateArmed = true

    let settled: Promise<unknown> = Promise.resolve(null)
    await act(async () => {
      settled = refresh.current()?.mutateAsync() ?? Promise.resolve(null)
      await pollUntil(() => refresh.current()?.isPending === true)
      // While the refetch is in flight the rail keeps serving the
      // previous data, and the button reports pending.
      expect(railSeven.current()?.groups).toEqual([groupSevenA])
      releaseGate?.(secondPayload)
      await settled
    })
    await act(async () => {
      await pollUntil(
        () =>
          railSeven.current()?.groups.length === 2 &&
          railSeven.current()?.loading === false,
      )
    })
    expect(refresh.current()?.isPending).toBe(false)
    expect(refresh.current()?.isSuccess).toBe(true)
    expect(railSeven.current()?.groups).toEqual(secondPayload.groups)
    // The other agent's outputs were not refetched.
    expect(railNine.current()?.groups).toEqual([groupNineA])
    expect(fetchCount('/agent-7/files')).toBe(2)
    expect(fetchCount('/agent-9/files')).toBe(1)
  })
})
