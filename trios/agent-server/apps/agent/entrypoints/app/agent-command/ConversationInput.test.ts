import { describe, expect, it, mock } from 'bun:test'
import { createElement as h } from 'react'
import type { AgentEntry } from '@/entrypoints/app/agents/useOpenClaw'

const voice = {
  isRecording: false,
  isTranscribing: false,
  transcript: '',
  error: null as string | null,
}

mock.module('@/lib/voice/useVoiceInput', () => ({
  useVoiceInput: () => ({
    isRecording: voice.isRecording,
    isTranscribing: voice.isTranscribing,
    transcript: voice.transcript,
    error: voice.error,
    audioLevel: 0,
    audioLevels: [0, 0, 0, 0, 0],
    startRecording: async () => true,
    stopRecording: async () => {},
    clearTranscript: () => {},
  }),
}))

const supported = new Set<string>()

mock.module('@/lib/browseros/capabilities', () => ({
  Capabilities: {
    getStaticSupport: () => null,
    supports: async () => false,
    initialize: async () => {},
    reset: () => {},
  },
  Feature: {
    MANAGED_MCP_SUPPORT: 'MANAGED_MCP_SUPPORT',
    WORKSPACE_FOLDER_SUPPORT: 'WORKSPACE_FOLDER_SUPPORT',
  },
}))

mock.module('@/lib/browseros/useCapabilities', () => ({
  useCapabilities: () => ({
    supports: (feature: string) => supported.has(feature),
    isLoading: false,
    browserOSVersion: null,
    serverVersion: null,
  }),
}))

mock.module('@/entrypoints/app/connect-mcp/useGetUserMCPIntegrations', () => ({
  useGetUserMCPIntegrations: () => ({ data: undefined, isLoading: false }),
  INTEGRATIONS_QUERY_KEY: 'klavis-user-integrations',
}))

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  mcpServerStorage: {
    getValue: async () => [],
    setValue: async () => {},
    removeValue: async () => {},
    watch: () => () => {},
  },
  useMcpServers: () => ({
    servers: [],
    addServer: async () => {},
    removeServer: async () => {},
  }),
}))

mock.module('@/lib/workspace/use-workspace', () => ({
  useWorkspace: () => ({
    recentFolders: [],
    selectedFolder: null,
    selectFolder: async () => {},
    addFolder: async () => {},
    removeFolder: async () => {},
    clearSelection: async () => {},
  }),
}))

// ---------------------------------------------------------------------------
// Minimal DOM shim: no DOM library is installed in this workspace and the
// suite must not reach the network, so here is just enough document for
// react-dom/client to mount, commit and delegate events.
// ---------------------------------------------------------------------------

type Listener = { fn: (event: any) => void; capture: boolean }

class MiniEventTarget {
  listeners: Record<string, Listener[]> = {}
  addEventListener(type: string, fn: (event: any) => void, opts?: unknown) {
    const capture =
      typeof opts === 'object' && opts !== null && (opts as any).capture
    ;(this.listeners[type] ??= []).push({ fn, capture: !!capture })
  }
  removeEventListener(type: string, fn: (event: any) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(
      (l) => l.fn !== fn,
    )
  }
}

class MiniNode extends MiniEventTarget {
  nodeType = 1
  tagName: string
  childNodes: MiniNode[] = []
  parentNode: MiniNode | null = null
  attributes: Record<string, string> = {}
  style: Record<string, string> = {}
  namespaceURI: string | null = null
  value = ''
  checked = false
  disabled = false
  ownerDocument: MiniDocument
  constructor(tagName: string, ownerDocument: MiniDocument) {
    super()
    this.tagName = tagName.toUpperCase()
    this.ownerDocument = ownerDocument
  }
  get firstChild() {
    return this.childNodes[0] ?? null
  }
  get parentNodeElement() {
    return this.parentNode
  }
  appendChild(child: MiniNode) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }
  insertBefore(child: MiniNode, ref: MiniNode | null) {
    if (ref === null) return this.appendChild(child)
    const i = this.childNodes.indexOf(ref)
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.splice(i === -1 ? this.childNodes.length : i, 0, child)
    return child
  }
  removeChild(child: MiniNode) {
    const i = this.childNodes.indexOf(child)
    if (i !== -1) this.childNodes.splice(i, 1)
    child.parentNode = null
    return child
  }
  contains(node: unknown): boolean {
    let cur = node as MiniNode | null
    while (cur) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
  }
  setAttribute(name: string, value: unknown) {
    this.attributes[name] = String(value)
  }
  getAttribute(name: string) {
    return name in this.attributes ? this.attributes[name] : null
  }
  removeAttribute(name: string) {
    delete this.attributes[name]
  }
  hasAttribute(name: string) {
    return name in this.attributes
  }
  get className() {
    return this.attributes['class'] ?? ''
  }
  set className(v: string) {
    this.attributes['class'] = v
  }
  get id() {
    return this.attributes['id'] ?? ''
  }
  set id(v: string) {
    this.attributes['id'] = v
  }
  get scrollHeight() {
    return 40
  }
  #text = ''
  get textContent() {
    return this.childNodes.length > 0
      ? this.childNodes
          .map((c) => ('data' in c ? c.data : c.textContent))
          .join('')
      : this.#text
  }
  set textContent(value: string) {
    this.#text = value
    for (const child of [...this.childNodes]) this.removeChild(child)
    if (value !== '') {
      const text = this.ownerDocument.createTextNode(value)
      text.parentNode = this
      this.childNodes.push(text)
    }
  }
  focus() {}
  blur() {}
}

class MiniTextNode extends MiniEventTarget {
  nodeType = 3
  data: string
  parentNode: MiniNode | null = null
  listeners: Record<string, Listener[]> = {}
  constructor(data: string) {
    super()
    this.data = data
  }
}

class MiniDocument {
  body: MiniNode
  documentElement: MiniNode
  head: MiniNode
  constructor() {
    this.body = new MiniNode('body', this)
    this.documentElement = new MiniNode('html', this)
    this.head = new MiniNode('head', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
  }
  getElementsByTagName(tag: string) {
    return tag === 'head' ? [this.head] : [this.body]
  }
  createElement(tag: string) {
    return new MiniNode(tag, this)
  }
  createElementNS(ns: string, tag: string) {
    const n = new MiniNode(tag, this)
    n.namespaceURI = ns
    return n
  }
  createTextNode(data: string) {
    return new MiniTextNode(data)
  }
  createDocumentFragment() {
    return new MiniNode('#document-fragment', this)
  }
  get activeElement() {
    return this.body
  }
  addEventListener() {}
  removeEventListener() {}
}

const miniDocument = new MiniDocument()
// react-dom probes `('oninput' in document)` once to decide whether
// native input events map to change events; without this it silently
// falls back to an IE-era polyfill that never sees our events.
;(miniDocument as any).oninput = null
const miniWindow = {
  document: miniDocument,
  addEventListener: () => {},
  removeEventListener: () => {},
  // react-dom probes these constructors when walking the active-element
  // chain; bare classes are enough because no node ever matches them.
  HTMLIFrameElement: class HTMLIFrameElement {},
  HTMLElement: class HTMLElement {},
  SVGElement: class SVGElement {},
  Element: class Element {},
  Node: class Node {},
  Window: class Window {},
}
;(miniDocument as any).defaultView = miniWindow
;(globalThis as any).document = miniDocument
;(globalThis as any).window = miniWindow
;(globalThis as any).navigator ??= { userAgent: 'bun-test' }
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function dispatchEvent(target: MiniNode, type: string, init: any = {}) {
  const path: MiniNode[] = []
  for (let n: MiniNode | null = target; n; n = n.parentNode as MiniNode) {
    path.unshift(n)
  }
  const event = {
    type,
    target,
    currentTarget: target,
    bubbles: true,
    cancelable: true,
    composed: true,
    defaultPrevented: false,
    propagationStopped: false,
    eventPhase: 0,
    timeStamp: Date.now(),
    ...init,
    preventDefault() {
      ;(this as any).defaultPrevented = true
    },
    stopPropagation() {
      ;(this as any).propagationStopped = true
    },
    stopImmediatePropagation() {
      ;(this as any).propagationStopped = true
    },
  }
  for (const node of path) {
    event.eventPhase = 1
    event.currentTarget = node
    for (const l of [...(node.listeners[type] ?? [])]) {
      if (l.capture) l.fn(event)
    }
    if (event.propagationStopped) return event
  }
  for (let i = path.length - 1; i >= 0; i--) {
    event.eventPhase = 3
    event.currentTarget = path[i]
    for (const l of [...(path[i].listeners[type] ?? [])]) {
      if (!l.capture) l.fn(event)
    }
    if (event.propagationStopped) return event
  }
  return event
}

function setTypeValue(node: MiniNode, value: string) {
  node.value = value
  dispatchEvent(node, 'input', { target: node })
}
function pressKey(node: MiniNode, key: string, shiftKey = false) {
  return dispatchEvent(node, 'keydown', { key, shiftKey, target: node })
}
function click(node: MiniNode) {
  return dispatchEvent(node, 'click', { detail: 1, target: node })
}

function findAll(
  root: MiniNode,
  tagName: string,
  pred?: (n: MiniNode) => boolean,
): MiniNode[] {
  const out: MiniNode[] = []
  const walk = (n: MiniNode | MiniTextNode) => {
    if ('tagName' in n && n.tagName === tagName.toUpperCase() && (!pred || pred(n))) {
      out.push(n)
    }
    if ('childNodes' in n) {
      for (const c of n.childNodes) walk(c as MiniNode)
    }
  }
  walk(root)
  return out
}

const subjectHref = new URL(
  process.env.CONVERSATION_INPUT_SUBJECT ?? './ConversationInput.tsx',
  import.meta.url,
).href
const { ConversationInput } = await import(subjectHref)
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')

const agent: AgentEntry = { agentId: 'claw-1', name: 'Claw', workspace: '/ws' }

function mount(props: Record<string, unknown> = {}) {
  const container = miniDocument.createElement('div')
  const root = createRoot(container)
  const onSend = mock(() => {})
  const all = () => ({
    agents: [agent],
    selectedAgentId: 'claw-1',
    onSelectAgent: () => {},
    onSend,
    streaming: false,
    ...props,
  })
  try {
    act(() => {
      root.render(h(ConversationInput as any, all()))
    })
  } catch (e: any) {
    console.log('ACT THREW:', e?.message, '| errors:', JSON.stringify(e?.errors?.map((x: any) => x?.stack)))
    console.log('ACT STACK:', e?.stack)
  }
  return {
    container,
    onSend,
    rerender(next: Record<string, unknown> = {}) {
      act(() => {
        root.render(h(ConversationInput as any, { ...all(), ...next }))
      })
    },
    unmount() {
      act(() => {
        root.unmount()
      })
    },
  }
}

describe('ConversationInputTsxContract', () => {
  it('spike: typing and sending', () => {
    const view = mount()
    console.log('ROOT LISTENERS:', Object.keys(view.container.listeners))
    const textarea = findAll(view.container, 'textarea')[0]!
    expect(textarea.getAttribute('placeholder')).toBe('Message Claw...')

    console.log(
      'CHECK oninput-in-doc:',
      'oninput' in miniDocument,
      'createElement:',
      typeof miniDocument.createElement,
      'windowdoc:',
      typeof (globalThis as any).window?.document?.createElement,
    )
    for (const key of ['input', 'keydown']) {
      for (const l of view.container.listeners[key] ?? []) {
        const orig = l.fn
        l.fn = (...a: any[]) => {
          console.log(`LISTENER ${key} fired`)
          try {
            return orig(...a)
          } catch (e: any) {
            console.log(`LISTENER ${key} THREW:`, e?.stack ?? e)
            throw e
          }
        }
      }
    }
    console.log('TRACKER before type:', JSON.stringify((textarea as any)._valueTracker))
    act(() => setTypeValue(textarea, '  hello world  '))
    console.log('TRACKER after type:', JSON.stringify((textarea as any)._valueTracker))
    expect(textarea.value).toBe('  hello world  ')

    const enter = pressKey(textarea, 'Enter')
    expect(enter.defaultPrevented).toBe(true)
    expect(view.onSend.mock.calls.length).toBe(1)
    expect(view.onSend.mock.calls[0][0]).toEqual({
      text: 'hello world',
      attachments: [],
    })
    expect(textarea.value).toBe('')

    const shiftEnter = pressKey(textarea, 'Enter', true)
    expect(shiftEnter.defaultPrevented).toBe(false)
    expect(view.onSend.mock.calls.length).toBe(1)
    view.unmount()
  })
})
