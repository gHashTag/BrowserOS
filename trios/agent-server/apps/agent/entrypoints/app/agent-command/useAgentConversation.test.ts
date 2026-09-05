/**
 * Contract suite for the exports of useAgentConversation.ts.
 *
 * The module exports exactly one runtime symbol: `useAgentConversation`
 * (`SendInput` is a type-only export, erased at runtime). Every assertion
 * below drives that export through the public hook surface it hands back
 * (`turns`, `streaming`, `sessionKey`, `send`, `stop`, `resetConversation`),
 * so the suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`useAgentConversation`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The hook's only live dependency is the agent server that
 * `@/entrypoints/app/agents/useAgents` speaks to over HTTP. Those four
 * helpers are swapped for in-memory fakes via `mock.module`, and the
 * React-Query-backed `useInvalidateAgentOutputs` is stubbed the same way,
 * so this suite needs no network, no database and no container. The SSE
 * parser (`@/lib/sse`), the tool-label mapper and the tool-status mapper
 * all run for real against synthetic `Response` objects.
 *
 * There is no DOM environment available to `bun test` in this project
 * (`@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile), so this file brings its own minimal in-memory DOM: just
 * enough surface for `react-dom/client`'s `createRoot` to commit a
 * component that renders nothing. That is enough to run the hook's
 * effects, replay state updates, and unmount it.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AgentHarnessStreamEvent } from '@/entrypoints/app/agents/useAgents'

// ---------------------------------------------------------------------------
// In-memory DOM shim (see header comment). react-dom only touches `window`
// for event-priority bookkeeping and active-element probing, neither of
// which a null-rendering tree exercises beyond the property lookups below.
// Both globals are removed again in `afterAll`.
// ---------------------------------------------------------------------------

interface FakeElement {
  nodeType: number
  nodeName: string
  tagName: string
  childNodes: unknown[]
  parentNode: FakeElement | null
  firstChild: FakeElement | null
  nextSibling: FakeElement | null
  style: unknown
  isConnected: boolean
  ownerDocument: unknown
  appendChild(child: FakeElement): FakeElement
  removeChild(child: FakeElement): FakeElement
  insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement
  setAttribute(): void
  removeAttribute(): void
  setAttributeNS(): void
  removeAttributeNS(): void
  addEventListener(): void
  removeEventListener(): void
  contains(): boolean
  textContent: string
  innerHTML: string
}

function makeElement(tag: string): FakeElement {
  const element: FakeElement = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    childNodes: [],
    parentNode: null,
    firstChild: null,
    nextSibling: null,
    style: {},
    isConnected: true,
    ownerDocument: null,
    appendChild(child) {
      element.childNodes.push(child)
      child.parentNode = element
      return child
    },
    removeChild(child) {
      const index = element.childNodes.indexOf(child)
      if (index >= 0) element.childNodes.splice(index, 1)
      child.parentNode = null
      return child
    },
    insertBefore(child, ref) {
      const index = ref ? element.childNodes.indexOf(ref) : -1
      if (index < 0) element.childNodes.push(child)
      else element.childNodes.splice(index, 0, child)
      child.parentNode = element
      return child
    },
    setAttribute() {},
    removeAttribute() {},
    setAttributeNS() {},
    removeAttributeNS() {},
    addEventListener() {},
    removeEventListener() {},
    contains() {
      return false
    },
    get textContent() {
      return ''
    },
    set textContent(_value: string) {},
    get innerHTML() {
      return ''
    },
    set innerHTML(_value: string) {},
  }
  return element
}

const fakeDocument = {
  nodeType: 9,
  nodeName: '#document',
  activeElement: null,
  createElement: makeElement,
  createTextNode: (text: string) => ({
    nodeType: 3,
    nodeName: '#text',
    textContent: text,
    childNodes: [],
    parentNode: null,
    nextSibling: null,
  }),
  createComment: (text: string) => ({
    nodeType: 8,
    nodeName: '#comment',
    textContent: text,
    childNodes: [],
    parentNode: null,
    nextSibling: null,
  }),
  createDocumentFragment: () => makeElement('#document-fragment'),
  addEventListener() {},
  removeEventListener() {},
  documentElement: makeElement('html'),
  body: makeElement('body'),
  defaultView: null as unknown,
}

const fakeWindow = {
  document: fakeDocument,
  HTMLIFrameElement: class FakeHTMLIFrameElement {},
  event: undefined,
  addEventListener() {},
  removeEventListener() {},
}
fakeDocument.defaultView = fakeWindow

const globalScope = globalThis as {
  window?: unknown
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
globalScope.window = fakeWindow
globalScope.IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Network-boundary fakes for @/entrypoints/app/agents/useAgents and the
// React-Query-backed outputs invalidation.
// ---------------------------------------------------------------------------

interface ChatCall {
  agentId: string
  message: string
  signal?: AbortSignal
  attachments: unknown[]
}

const chatCalls: ChatCall[] = []
const attachCalls: Array<{
  agentId: string
  options: { turnId?: string; lastSeq?: number; signal?: AbortSignal }
}> = []
const cancelCalls: Array<{
  agentId: string
  options: { turnId?: string; reason?: string }
}> = []
const invalidateCalls: Array<{ agentId: string; turnId?: string }> = []

let chatResponder: (() => Promise<Response>) | null = null
let attachResponder: (() => Promise<Response>) | null = null
let activeTurnResult: {
  turnId: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  prompt: string | null
} | null = null

mock.module('@/entrypoints/app/agents/useAgents', () => ({
  chatWithHarnessAgent: async (
    agentId: string,
    message: string,
    signal?: AbortSignal,
    attachments?: ReadonlyArray<unknown>,
  ): Promise<Response> => {
    chatCalls.push({
      agentId,
      message,
      signal,
      attachments: [...(attachments ?? [])],
    })
    if (!chatResponder) throw new Error('no chat responder configured')
    return chatResponder()
  },
  attachToHarnessTurn: async (
    agentId: string,
    options: { turnId?: string; lastSeq?: number; signal?: AbortSignal },
  ): Promise<Response> => {
    attachCalls.push({ agentId, options: { ...options } })
    if (!attachResponder) throw new Error('no attach responder configured')
    return attachResponder()
  },
  cancelHarnessTurn: async (
    agentId: string,
    options: { turnId?: string; reason?: string },
  ): Promise<{ cancelled: boolean }> => {
    cancelCalls.push({ agentId, options: { ...options } })
    return { cancelled: true }
  },
  fetchActiveHarnessTurn: async (_agentId: string): Promise<unknown> =>
    activeTurnResult,
}))

mock.module('@/lib/agent-files', () => ({
  useInvalidateAgentOutputs: () => (agentId: string, turnId?: string) => {
    invalidateCalls.push({ agentId, turnId })
  },
}))

// Imported only after the module mocks above are registered, so the
// subject's `@/` dependencies resolve to the in-memory fakes.
const { useAgentConversation } = await import('./useAgentConversation')

// ---------------------------------------------------------------------------
// SSE plumbing: build real `Response` objects whose bodies carry genuine
// `id:`/`data:` framing, so the hook consumes them through the real
// `consumeSSEStream` parser.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

function sseFrame(event: AgentHarnessStreamEvent, seq?: number): string {
  const id = seq === undefined ? '' : `id: ${seq}\n`
  return `${id}data: ${JSON.stringify(event)}\n\n`
}

function sseResponse(
  events: AgentHarnessStreamEvent[],
  headers: Record<string, string> = {},
): Response {
  const body = events.map((event) => sseFrame(event)).join('')
  return new Response(body, { status: 200, headers })
}

/** A 200 stream that delivers `firstChunk`, then stays open until `tail`. */
function gatedSseResponse(
  firstChunk: string,
  tail: Promise<void>,
  headers: Record<string, string> = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(firstChunk))
      await tail
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers })
}

// ---------------------------------------------------------------------------
// Hook driver: render the hook under a component that commits nothing,
// capture whatever the hook returns on each render.
// ---------------------------------------------------------------------------

type HookResult = ReturnType<typeof useAgentConversation>

interface HookOptions {
  sessionKey?: string | null
  onComplete?: () => void
  onSessionKeyChange?: (sessionKey: string) => void
  activeTurnId?: string | null
}

const mountedRoots: Root[] = []

async function renderHook(
  agentId: string,
  options: HookOptions = {},
): Promise<{ get result(): HookResult }> {
  let captured: HookResult | null = null
  const Probe = () => {
    captured = useAgentConversation(agentId, options)
    return null
  }
  const container = makeElement('div')
  container.ownerDocument = fakeDocument
  const root = createRoot(container as unknown as HTMLElement)
  mountedRoots.push(root)
  await act(async () => {
    root.render(createElement(Probe))
    // Give the mount effects' async continuations (the resume probe) a
    // macrotask to settle inside this act scope.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  if (!captured) throw new Error('hook never rendered')
  return {
    get result(): HookResult {
      if (!captured) throw new Error('hook captured nothing')
      return captured
    },
  }
}

afterEach(async () => {
  while (mountedRoots.length > 0) {
    const root = mountedRoots.pop()
    if (!root) continue
    await act(async () => {
      root.unmount()
    })
  }
  chatCalls.length = 0
  attachCalls.length = 0
  cancelCalls.length = 0
  invalidateCalls.length = 0
  chatResponder = null
  attachResponder = null
  activeTurnResult = null
})

afterAll(() => {
  delete globalScope.window
  delete globalScope.IS_REACT_ACT_ENVIRONMENT
})

describe('useAgentConversationContract', () => {
  it('send appends the optimistic user turn, folds text deltas into it and completes the turn', async () => {
    const onCompleteCalls: number[] = []
    chatResponder = () =>
      Promise.resolve(
        sseResponse(
          [
            { type: 'text_delta', text: 'Hel', stream: 'output' },
            { type: 'text_delta', text: 'lo!', stream: 'output' },
            { type: 'done' },
          ],
          { 'X-Turn-Id': 'turn-1' },
        ),
      )
    const hook = await renderHook('agent-1', {
      onComplete: () => onCompleteCalls.push(1),
    })

    expect(hook.result.streaming).toBe(false)
    await act(async () => {
      await hook.result.send('  hello  ')
    })

    // Outgoing message is the trimmed text; nothing else goes over the wire.
    expect(chatCalls).toHaveLength(1)
    expect(chatCalls[0]?.agentId).toBe('agent-1')
    expect(chatCalls[0]?.message).toBe('hello')
    expect(chatCalls[0]?.attachments).toEqual([])

    expect(hook.result.streaming).toBe(false)
    expect(hook.result.turns).toHaveLength(1)
    expect(hook.result.turns[0]).toMatchObject({
      userText: 'hello',
      turnId: 'turn-1',
      done: true,
      parts: [{ kind: 'text', text: 'Hello!' }],
    })
    expect(onCompleteCalls).toHaveLength(1)
  })

  it('send accepts a SendInput with attachments, forwarding payloads and rendering staged previews', async () => {
    const attachments = [
      {
        kind: 'image',
        mediaType: 'image/png',
        name: 'shot.png',
        dataUrl: 'data:image/png;base64,QUJD',
      },
    ]
    const previews = [
      {
        id: 'shot.png',
        kind: 'image' as const,
        mediaType: 'image/png',
        name: 'shot.png',
        dataUrl: 'data:image/png;base64,QUJD',
      },
    ]
    chatResponder = () => Promise.resolve(sseResponse([{ type: 'done' }]))
    const hook = await renderHook('agent-1')

    await act(async () => {
      await hook.result.send({
        text: '  look at this  ',
        attachments,
        attachmentPreviews: previews,
      })
    })

    expect(chatCalls[0]?.message).toBe('look at this')
    expect(chatCalls[0]?.attachments).toEqual(attachments)
    expect(hook.result.turns[0]).toMatchObject({
      userText: 'look at this',
      userAttachments: previews,
      done: true,
    })
  })

  it('send reports streaming state while the stream is open, and drops it when the stream ends', async () => {
    let releaseTail!: () => void
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve
    })
    chatResponder = () =>
      Promise.resolve(
        gatedSseResponse(
          sseFrame({ type: 'text_delta', text: 'Par', stream: 'output' }, 1),
          tail,
          { 'X-Turn-Id': 'turn-stream' },
        ),
      )
    const hook = await renderHook('agent-1')

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = hook.result.send('stream me')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Mid-stream: optimistic turn already visible, partial text folded in,
    // streaming flag up.
    expect(hook.result.streaming).toBe(true)
    expect(hook.result.turns[0]).toMatchObject({
      userText: 'stream me',
      done: false,
      parts: [{ kind: 'text', text: 'Par' }],
    })

    await act(async () => {
      releaseTail()
      await sendPromise
    })

    expect(hook.result.streaming).toBe(false)
  })

  it('send ignores a second send while one turn is still streaming', async () => {
    let releaseTail!: () => void
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve
    })
    chatResponder = () =>
      Promise.resolve(
        gatedSseResponse(sseFrame({ type: 'status', text: 'working' }), tail),
      )
    const hook = await renderHook('agent-1')

    let firstSend!: Promise<void>
    await act(async () => {
      firstSend = hook.result.send('first')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await act(async () => {
      await hook.result.send('second')
    })

    expect(chatCalls).toHaveLength(1)
    expect(chatCalls[0]?.message).toBe('first')
    expect(hook.result.turns).toHaveLength(1)
    expect(hook.result.turns[0]?.userText).toBe('first')

    await act(async () => {
      releaseTail()
      await firstSend
    })
  })

  it('send ignores input that is blank with no attachments', async () => {
    const hook = await renderHook('agent-1')

    await act(async () => {
      await hook.result.send('   ')
      await hook.result.send('')
    })

    expect(chatCalls).toHaveLength(0)
    expect(hook.result.turns).toEqual([])
    expect(hook.result.streaming).toBe(false)
  })

  it('send follows a 409 onto the already-active turn via attach instead of double-sending', async () => {
    chatResponder = () =>
      Promise.resolve(
        new Response(JSON.stringify({ turnId: 'turn-409' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    attachResponder = () =>
      Promise.resolve(
        sseResponse(
          [
            { type: 'text_delta', text: 'already running', stream: 'output' },
            { type: 'done' },
          ],
          { 'X-Turn-Id': 'turn-409' },
        ),
      )
    const hook = await renderHook('agent-1')

    await act(async () => {
      await hook.result.send('hello')
    })

    expect(chatCalls).toHaveLength(1)
    expect(attachCalls).toHaveLength(1)
    expect(attachCalls[0]?.agentId).toBe('agent-1')
    expect(attachCalls[0]?.options.turnId).toBe('turn-409')
    expect(hook.result.turns).toHaveLength(1)
    expect(hook.result.turns[0]).toMatchObject({
      userText: 'hello',
      turnId: 'turn-409',
      done: true,
      parts: [{ kind: 'text', text: 'already running' }],
    })
  })

  it('send surfaces an error stream event as an error text part without completing the turn', async () => {
    const onCompleteCalls: number[] = []
    chatResponder = () =>
      Promise.resolve(
        sseResponse(
          [
            { type: 'text_delta', text: 'partial', stream: 'output' },
            { type: 'error', message: 'boom' },
          ],
          { 'X-Turn-Id': 'turn-err' },
        ),
      )
    const hook = await renderHook('agent-1', {
      onComplete: () => onCompleteCalls.push(1),
    })

    await act(async () => {
      await hook.result.send('hello')
    })

    expect(hook.result.streaming).toBe(false)
    expect(hook.result.turns[0]).toMatchObject({
      done: false,
      parts: [
        { kind: 'text', text: 'partial' },
        { kind: 'text', text: 'Error: boom' },
      ],
    })
    // The local stream ended, so completion callbacks still fire.
    expect(onCompleteCalls).toHaveLength(1)
  })

  it('send surfaces a failed HTTP response as an error text part', async () => {
    chatResponder = () =>
      Promise.resolve(new Response('gateway exploded', { status: 500 }))
    const hook = await renderHook('agent-1')

    await act(async () => {
      await hook.result.send('hello')
    })

    expect(hook.result.streaming).toBe(false)
    expect(hook.result.turns).toHaveLength(1)
    expect(hook.result.turns[0]?.parts).toEqual([
      { kind: 'text', text: 'Error: gateway exploded' },
    ])
  })

  it('send renders thought deltas as a thinking part that is sealed when the turn is done', async () => {
    chatResponder = () =>
      Promise.resolve(
        sseResponse([
          { type: 'text_delta', text: 'weighing options', stream: 'thought' },
          { type: 'text_delta', text: 'Answer', stream: 'output' },
          { type: 'done' },
        ]),
      )
    const hook = await renderHook('agent-1')

    await act(async () => {
      await hook.result.send('hello')
    })

    expect(hook.result.turns[0]).toMatchObject({
      done: true,
      parts: [
        { kind: 'thinking', text: 'weighing options', done: true },
        { kind: 'text', text: 'Answer' },
      ],
    })
  })

  it('send folds tool calls into a labelled batch, updating status in place', async () => {
    chatResponder = () =>
      Promise.resolve(
        sseResponse([
          {
            type: 'tool_call',
            title: 'navigate_page',
            text: 'opening example.com',
            id: 'tool-1',
          },
          {
            type: 'tool_call',
            title: 'navigate_page',
            text: 'opening example.com',
            id: 'tool-1',
            status: 'completed',
          },
          {
            type: 'tool_call',
            title: 'get_page_content',
            text: '',
            id: 'tool-2',
            status: 'running',
          },
          { type: 'done' },
        ]),
      )
    const hook = await renderHook('agent-1')

    await act(async () => {
      await hook.result.send('hello')
    })

    expect(hook.result.turns[0]?.parts).toEqual([
      {
        kind: 'tool-batch',
        tools: [
          {
            id: 'tool-1',
            name: 'navigate_page',
            label: 'Navigated to',
            subject: undefined,
            status: 'completed',
          },
          {
            id: 'tool-2',
            name: 'get_page_content',
            label: 'Read page content',
            subject: undefined,
            status: 'running',
          },
        ],
      },
    ])
  })

  it('produced_files events replace the file list on the current turn', async () => {
    const firstFiles = [
      { id: 'f1', path: 'out/report.md', size: 10, mtimeMs: 1 },
    ]
    const secondFiles = [
      { id: 'f2', path: 'out/report.md', size: 42, mtimeMs: 2 },
      { id: 'f3', path: 'out/chart.png', size: 99, mtimeMs: 3 },
    ]
    chatResponder = () =>
      Promise.resolve(
        sseResponse([
          { type: 'produced_files', files: firstFiles },
          { type: 'produced_files', files: secondFiles },
          { type: 'done' },
        ]),
      )
    const hook = await renderHook('agent-1')

    await act(async () => {
      await hook.result.send('hello')
    })

    expect(hook.result.turns[0]).toMatchObject({
      done: true,
      producedFiles: secondFiles,
    })
  })

  it('the session key on the response headers is surfaced and propagated to onSessionKeyChange', async () => {
    const sessionKeys: string[] = []
    chatResponder = () =>
      Promise.resolve(
        sseResponse([{ type: 'done' }], {
          'X-Session-Key': 'agent:agent-1:main',
          'X-Turn-Id': 'turn-sk',
        }),
      )
    const hook = await renderHook('agent-1', {
      onSessionKeyChange: (key) => sessionKeys.push(key),
    })

    await act(async () => {
      await hook.result.send('hello')
    })

    expect(sessionKeys).toEqual(['agent:agent-1:main'])
    expect(hook.result.sessionKey).toBe('agent:agent-1:main')
  })

  it('stop cancels the server-side turn, aborts the request and unwinds the stream', async () => {
    let releaseTail!: () => void
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve
    })
    chatResponder = () =>
      Promise.resolve(
        gatedSseResponse(
          sseFrame({ type: 'text_delta', text: 'working', stream: 'output' }),
          tail,
          { 'X-Turn-Id': 'turn-stop' },
        ),
      )
    const hook = await renderHook('agent-1')

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = hook.result.send('hello')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(hook.result.streaming).toBe(true)

    await act(async () => {
      await hook.result.stop()
    })
    await act(async () => {
      releaseTail()
      await sendPromise
    })

    expect(cancelCalls).toEqual([
      {
        agentId: 'agent-1',
        options: { turnId: 'turn-stop', reason: 'user pressed stop' },
      },
    ])
    expect(chatCalls[0]?.signal?.aborted).toBe(true)
    expect(hook.result.streaming).toBe(false)
    // The turn that was already on screen stays on screen.
    expect(hook.result.turns[0]?.parts).toEqual([
      { kind: 'text', text: 'working' },
    ])
  })

  it('resetConversation drops the turns immediately and cancels the in-flight turn', async () => {
    let releaseTail!: () => void
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve
    })
    chatResponder = () =>
      Promise.resolve(
        gatedSseResponse(
          sseFrame({ type: 'text_delta', text: 'working', stream: 'output' }),
          tail,
          { 'X-Turn-Id': 'turn-reset' },
        ),
      )
    const hook = await renderHook('agent-1')

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = hook.result.send('hello')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await act(async () => {
      hook.result.resetConversation()
    })
    await act(async () => {
      releaseTail()
      await sendPromise
    })

    expect(hook.result.turns).toEqual([])
    expect(hook.result.streaming).toBe(false)
    expect(cancelCalls).toEqual([
      {
        agentId: 'agent-1',
        options: { turnId: 'turn-reset', reason: 'user pressed stop' },
      },
    ])
  })

  it('unmounting the hook aborts the in-flight request', async () => {
    let releaseTail!: () => void
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve
    })
    chatResponder = () =>
      Promise.resolve(
        gatedSseResponse(sseFrame({ type: 'status', text: 'x' }), tail),
      )
    const hook = await renderHook('agent-1')

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = hook.result.send('hello')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // `result` was captured from the last pre-unmount render.
    const chatSignal = chatCalls[0]?.signal
    const root = mountedRoots[mountedRoots.length - 1]
    await act(async () => {
      root?.unmount()
    })
    await act(async () => {
      releaseTail()
      await sendPromise
    })

    expect(chatSignal?.aborted).toBe(true)
  })

  it('a running server turn found on mount is reattached and streamed into a placeholder user turn', async () => {
    activeTurnResult = {
      turnId: 'turn-resume',
      status: 'running',
      startedAt: 4242,
      prompt: 'kicked off in another tab',
    }
    attachResponder = () =>
      Promise.resolve(
        sseResponse(
          [
            { type: 'text_delta', text: 'resumed answer', stream: 'output' },
            { type: 'done' },
          ],
          { 'X-Turn-Id': 'turn-resume' },
        ),
      )
    const hook = await renderHook('agent-1')

    expect(attachCalls).toHaveLength(1)
    expect(attachCalls[0]?.agentId).toBe('agent-1')
    expect(attachCalls[0]?.options.turnId).toBe('turn-resume')
    expect(hook.result.turns).toHaveLength(1)
    expect(hook.result.turns[0]).toMatchObject({
      userText: 'kicked off in another tab',
      turnId: 'turn-resume',
      timestamp: 4242,
      done: true,
      parts: [{ kind: 'text', text: 'resumed answer' }],
    })
    expect(hook.result.streaming).toBe(false)
  })

  it('a mount with no running server turn stays empty', async () => {
    const hook = await renderHook('agent-1')

    expect(chatCalls).toHaveLength(0)
    expect(attachCalls).toHaveLength(0)
    expect(hook.result.turns).toEqual([])
    expect(hook.result.streaming).toBe(false)
  })
})
