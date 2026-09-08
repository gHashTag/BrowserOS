/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * First contract suite for the per-agent Outputs rail
 * (agent-conversation.outputs-rail.tsx). The behaviour that exists
 * today, pinned: the rail's data states, its controls, and the
 * per-agent localStorage memory behind open/closed state.
 *
 * Export coverage — the module exports exactly two symbols and both
 * are exercised by assertions below, one `it` block per symbol so a
 * reader can map assertions to exports:
 *
 *  - `useOutputsRailOpen` — driven through a probe component that
 *    consumes the returned tuple the way the parent page does.
 *  - `OutputsRail` — rendered across every data state the rail
 *    distinguishes (empty, loading, error, populated) plus its
 *    interactive surface: hide button, refresh-pending button,
 *    collapsible turn groups, the focusTurnId deep link, and the
 *    shared preview sheet opening from a file row.
 *
 * No exported symbol was blocked by a live dependency, so nothing is
 * listed here as unpinnable. The server-backed data hooks
 * (`useAgentOutputs`, `useRefreshAgentOutputs`, `useFilePreview`)
 * and the server-URL provider are stubbed at their module boundary —
 * the only way to keep this suite off the network while still
 * rendering the real component tree. The pure helpers re-exported by
 * the same module (`basenameOf`, `formatFileSize`, `inferFileKind`,
 * ...) stay real, so the rendered output reflects them.
 *
 * The suite needs no database, no container and no network: the DOM
 * is a small in-file implementation sized for React 19 plus the
 * Radix primitives the rail uses, and every React root is torn down
 * afterwards so later suites in the same run start clean.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import * as fileHelpers from '@/lib/agent-files/file-helpers'
import type {
  ProducedFile,
  ProducedFilesRailGroup,
} from '@/lib/agent-files/types'

// --------------------------------------------------------------------------
// Module-boundary stubs for the server-backed dependencies.
// --------------------------------------------------------------------------

interface RailDataState {
  groups: ProducedFilesRailGroup[]
  loading: boolean
  error: Error | null
  refreshPending: boolean
}

let railData: RailDataState = {
  groups: [],
  loading: false,
  error: null,
  refreshPending: false,
}

mock.module('@/lib/agent-files', () => ({
  ...fileHelpers,
  useAgentOutputs: () => ({
    groups: railData.groups,
    loading: railData.loading,
    error: railData.error,
    refetch: async () => undefined,
  }),
  useRefreshAgentOutputs: () => ({
    isPending: railData.refreshPending,
    mutate: () => undefined,
  }),
  useFilePreview: () => ({
    preview: null,
    loading: false,
    error: null,
    refetch: async () => undefined,
  }),
}))

mock.module('@/lib/browseros/useBrowserOSProviders', () => ({
  useAgentServerUrl: () => ({
    baseUrl: 'http://agent.test',
    isLoading: false,
    error: null,
  }),
}))

// --------------------------------------------------------------------------
// A small in-memory DOM. No DOM library resolves from this package,
// so the suite carries its own: enough of the Node / Element /
// Document / Event surface for React 19, Radix collapsible + dialog,
// and the rail's own querying needs.
// --------------------------------------------------------------------------

type FakeEventListener = (event: FakeEvent) => void

class FakeEvent {
  readonly type: string
  target: FakeNode | null = null
  currentTarget: FakeNode | null = null
  readonly bubbles: boolean
  readonly cancelable = true
  readonly timeStamp = Date.now()
  defaultPrevented = false
  propagationStopped = false
  immediateStopped = false
  // Fields React's synthetic-event layer may read off the native event.
  readonly view = fakeWindow
  readonly detail = 0
  readonly button = 0
  readonly buttons = 0
  readonly pointerId = 1
  readonly ctrlKey = false
  readonly shiftKey = false
  readonly altKey = false
  readonly metaKey = false
  readonly relatedTarget: unknown = null
  readonly screenX = 0
  readonly screenY = 0
  readonly clientX = 0
  readonly clientY = 0
  readonly pageX = 0
  readonly pageY = 0
  readonly x = 0
  readonly y = 0

  constructor(type: string, init?: { bubbles?: boolean }) {
    this.type = type
    this.bubbles = init?.bubbles ?? false
  }

  preventDefault(): void {
    this.defaultPrevented = true
  }

  stopPropagation(): void {
    this.propagationStopped = true
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true
    this.immediateStopped = true
  }

  composedPath(): FakeNode[] {
    const path: FakeNode[] = []
    let cursor: FakeNode | null = this.target
    while (cursor) {
      path.push(cursor)
      cursor = cursor.parentNode
    }
    return path
  }
}

class FakeNode {
  nodeType = 0
  childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null
  ownerDocument: FakeDocument | null = null
  readonly listeners = new Map<
    string,
    Array<{ fn: FakeEventListener; capture: boolean; once: boolean }>
  >()

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }

  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes
    if (!siblings) return null
    return siblings[siblings.indexOf(this) + 1] ?? null
  }

  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null
  }

  get children(): FakeElement[] {
    return this.childNodes.filter(
      (child): child is FakeElement => child instanceof FakeElement,
    )
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent ?? '').join('')
  }

  set textContent(value: string) {
    for (const child of [...this.childNodes]) this.removeChild(child)
    if (value !== '')
      this.appendChild(
        this.ownerDocument?.createTextNode(value) ?? new FakeText(value),
      )
  }

  hasChildNodes(): boolean {
    return this.childNodes.length > 0
  }

  contains(node: FakeNode | null): boolean {
    let cursor: FakeNode | null = node
    while (cursor) {
      if (cursor === this) return true
      cursor = cursor.parentNode
    }
    return false
  }

  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode?.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore<T extends FakeNode>(child: T, ref: FakeNode | null): T {
    if (!ref) return this.appendChild(child)
    child.parentNode?.removeChild(child)
    const index = this.childNodes.indexOf(ref)
    child.parentNode = this
    this.childNodes.splice(
      index === -1 ? this.childNodes.length : index,
      0,
      child,
    )
    return child
  }

  removeChild<T extends FakeNode>(child: T): T {
    const index = this.childNodes.indexOf(child)
    if (index !== -1) {
      this.childNodes.splice(index, 1)
      child.parentNode = null
    }
    return child
  }

  addEventListener(
    type: string,
    fn: FakeEventListener,
    options?: unknown,
  ): void {
    const flags = parseListenerOptions(options)
    const list = this.listeners.get(type) ?? []
    list.push({ fn, capture: flags.capture, once: flags.once })
    this.listeners.set(type, list)
  }

  removeEventListener(
    type: string,
    fn: FakeEventListener,
    options?: unknown,
  ): void {
    const capture = parseListenerOptions(options).capture
    const list = this.listeners.get(type)
    if (!list) return
    this.listeners.set(
      type,
      list.filter((entry) => !(entry.fn === fn && entry.capture === capture)),
    )
  }

  /**
   * Accepts both the suite's own events and native CustomEvents that
   * Radix dispatches at nodes; readonly fields on the latter are
   * shadowed via defineProperty instead of assignment.
   */
  dispatchEvent(event: FakeEvent | Event): boolean {
    if (event.target == null) {
      safeDefine(event, 'target', this)
    }
    const path: FakeNode[] = []
    let cursor: FakeNode | null = this
    while (cursor) {
      path.push(cursor)
      cursor = cursor.parentNode
    }
    // Capture phase: root towards target (target itself included).
    for (let index = path.length - 1; index >= 0; index -= 1) {
      runListeners(path[index], event, true)
      if (isPropagationHalted(event)) return !event.defaultPrevented
    }
    // Bubble phase: target towards root.
    for (const node of path) {
      safeDefine(event, 'currentTarget', node)
      runListeners(node, event, false)
      if (isPropagationHalted(event)) break
    }
    safeDefine(event, 'currentTarget', null)
    return !event.defaultPrevented
  }
}

function parseListenerOptions(options: unknown): {
  capture: boolean
  once: boolean
} {
  if (typeof options === 'boolean') return { capture: options, once: false }
  const flags = options as { capture?: boolean; once?: boolean } | undefined
  return {
    capture: Boolean(flags?.capture),
    once: Boolean(flags?.once),
  }
}

function safeDefine(
  event: FakeEvent | Event,
  key: string,
  value: unknown,
): void {
  try {
    Object.defineProperty(event, key, {
      value,
      configurable: true,
      writable: true,
    })
  } catch {
    // Some hosts freeze events; the field then keeps its native value.
  }
}

function isPropagationHalted(event: FakeEvent | Event): boolean {
  const flagged = event as {
    propagationStopped?: boolean
    cancelBubble?: boolean
  }
  return flagged.propagationStopped === true || flagged.cancelBubble === true
}

function runListeners(
  node: FakeNode,
  event: FakeEvent | Event,
  capture: boolean,
): void {
  const list = node.listeners.get(event.type)
  if (!list) return
  for (const entry of [...list]) {
    if (entry.capture !== capture) continue
    if (entry.once) {
      node.removeEventListener(event.type, entry.fn, { capture: entry.capture })
    }
    const halted = isPropagationHalted(event)
    if (halted) return
    entry.fn(event as FakeEvent)
  }
}

class FakeText extends FakeNode {
  data: string

  constructor(data: string) {
    super()
    this.nodeType = 3
    this.data = data
  }

  get nodeValue(): string {
    return this.data
  }

  set nodeValue(value: string) {
    this.data = value
  }

  get textContent(): string {
    return this.data
  }

  set textContent(value: string) {
    this.data = value
  }
}

class FakeComment extends FakeNode {
  constructor(data: string) {
    super()
    this.nodeType = 8
    this.data = data
  }

  data: string = ''
}

/**
 * Minimal CSS-selector matching for the selectors Radix and the
 * suite itself need: `tag`, `[attr]`, `[attr="value"]` and a single
 * `:not(...)` wrapper around an attribute selector. Anything richer
 * matches nothing, which is safe for the components rendered here.
 */
function selectorMatches(element: FakeElement, selector: string): boolean {
  const notIndex = selector.indexOf(':not(')
  if (notIndex !== -1) {
    const base = selector.slice(0, notIndex).trim()
    const inner = selector.slice(notIndex + 5).replace(/\)\s*$/, '')
    return selectorMatches(element, base) && !selectorMatches(element, inner)
  }
  const attributeMatch = /^\[([A-Za-z-]+)(?:="([^"]*)")?\]$/.exec(selector)
  if (attributeMatch) {
    const [, name, value] = attributeMatch
    if (value === undefined) return element.hasAttribute(name)
    return element.getAttribute(name) === value
  }
  return element.tagName === selector.toUpperCase()
}

/** Just enough of CSSStyleDeclaration for React's style diffing. */
class FakeStyle {
  setProperty(name: string, value: string): void {
    this[name] = value
  }

  getPropertyValue(name: string): string {
    return typeof this[name] === 'string' ? (this[name] as string) : ''
  }

  removeProperty(name: string): string {
    const previous = this[name]
    delete this[name]
    return typeof previous === 'string' ? previous : ''
  }

  get length(): number {
    return 0
  }

  get cssText(): string {
    return ''
  }

  set cssText(_value: string) {}

  [key: string]: unknown
}

class FakeElement extends FakeNode {
  readonly tagName: string
  readonly namespaceURI: string | null
  readonly attributes = new Map<string, string>()
  readonly style = new FakeStyle()
  readonly dataset: Record<string, string> = {}
  scrollIntoViewCalls = 0

  constructor(
    tag: string,
    owner: FakeDocument | null,
    ns: string | null = null,
  ) {
    super()
    this.nodeType = 1
    this.tagName = tag.toUpperCase()
    this.ownerDocument = owner
    this.namespaceURI = ns
  }

  get className(): string {
    return this.attributes.get('class') ?? ''
  }

  set className(value: string) {
    this.setAttribute('class', value)
  }

  get id(): string {
    return this.attributes.get('id') ?? ''
  }

  set id(value: string) {
    this.setAttribute('id', value)
  }

  getAttribute(name: string): string | null {
    const value = this.attributes.get(name)
    return value === undefined ? null : value
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value))
  }

  setAttributeNS(_ns: string | null, name: string, value: unknown): void {
    this.setAttribute(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  getBoundingClientRect(): Record<string, number> {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    }
  }

  scrollIntoView(options?: unknown): void {
    this.scrollIntoViewCalls += 1
    this.lastScrollIntoViewOptions = options
  }

  lastScrollIntoViewOptions: unknown = null

  focus(): void {}

  blur(): void {}

  click(): void {
    this.dispatchEvent(new FakeEvent('click', { bubbles: true }))
  }

  remove(): void {
    this.parentNode?.removeChild(this)
  }

  insertAdjacentElement(
    position: string,
    element: FakeElement,
  ): FakeElement | null {
    const parent = this.parentNode
    switch (position) {
      case 'beforebegin': {
        if (!parent) return null
        parent.insertBefore(element, this)
        return element
      }
      case 'afterbegin': {
        this.insertBefore(element, this.childNodes[0] ?? null)
        return element
      }
      case 'beforeend': {
        this.appendChild(element)
        return element
      }
      case 'afterend': {
        if (!parent) return null
        parent.insertBefore(element, this.nextSibling)
        return element
      }
      default:
        return null
    }
  }

  matches(selector: string): boolean {
    return selectorMatches(this, selector)
  }

  closest(selector: string): FakeElement | null {
    let cursor: FakeNode | null = this
    while (cursor) {
      if (cursor instanceof FakeElement && cursor.matches(selector))
        return cursor
      cursor = cursor.parentNode
    }
    return null
  }

  querySelectorAll(selector: string): FakeElement[] {
    return descendantElements(this).filter(
      (element) =>
        selector
          .match(/[^,]+/g)
          ?.some((part) => selectorMatches(element, part.trim())) === true,
    )
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

class FakeDocumentFragment extends FakeNode {
  constructor() {
    super()
    this.nodeType = 11
  }
}

const NODE_FILTER = {
  SHOW_ELEMENT: 1,
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3,
} as const

/** Document-order element walker, enough for Radix's tabbable scan. */
class FakeTreeWalker {
  readonly #ordered: FakeElement[]
  readonly #filter?: { acceptNode?: (node: FakeNode) => number }
  #index = -1
  currentNode: FakeNode | null = null

  constructor(
    root: FakeNode,
    filter?: { acceptNode?: (node: FakeNode) => number },
  ) {
    this.#ordered = descendantElements(root)
    this.#filter = filter
  }

  nextNode(): FakeNode | null {
    while (this.#index + 1 < this.#ordered.length) {
      this.#index += 1
      const node = this.#ordered[this.#index]
      this.currentNode = node
      const verdict = this.#filter?.acceptNode?.(node)
      if (verdict === undefined || verdict === NODE_FILTER.FILTER_ACCEPT) {
        return node
      }
      if (verdict === NODE_FILTER.FILTER_REJECT) {
        while (
          this.#index + 1 < this.#ordered.length &&
          node.contains(this.#ordered[this.#index + 1])
        ) {
          this.#index += 1
        }
      }
    }
    this.currentNode = null
    return null
  }
}

class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement
  readonly head: FakeElement
  readonly body: FakeElement
  defaultView: unknown = null
  /** React's active-element scan instanceof-checks this constructor. */
  readonly HTMLIFrameElement = class FakeHTMLIFrameElement {}
  readonly compatMode = 'CSS1Compat'
  readonly doctype = { name: 'html', publicId: '', systemId: '' }

  constructor() {
    super()
    this.nodeType = 9
    this.documentElement = new FakeElement('html', this)
    this.head = new FakeElement('head', this)
    this.body = new FakeElement('body', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
  }

  getElementsByTagName(tag: string): FakeElement[] {
    const wanted = tag.toUpperCase()
    return descendantElements(this).filter(
      (element) => element.tagName === wanted,
    )
  }

  getElementById(id: string): FakeElement | null {
    return (
      descendantElements(this).find(
        (element) => element.getAttribute('id') === id,
      ) ?? null
    )
  }

  querySelectorAll(selector: string): FakeElement[] {
    return descendantElements(this).filter(
      (element) =>
        selector
          .match(/[^,]+/g)
          ?.some((part) => selectorMatches(element, part.trim())) === true,
    )
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  createTreeWalker(
    root: FakeNode,
    _whatToShow: number,
    filter?: { acceptNode?: (node: FakeNode) => number },
  ): FakeTreeWalker {
    return new FakeTreeWalker(root, filter)
  }

  get activeElement(): FakeElement {
    return this.body
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this)
  }

  createElementNS(ns: string | null, tag: string): FakeElement {
    return new FakeElement(tag, this, ns)
  }

  createTextNode(data: string): FakeText {
    const node = new FakeText(data)
    node.ownerDocument = this
    return node
  }

  createComment(data: string): FakeComment {
    const node = new FakeComment(data)
    node.ownerDocument = this
    return node
  }

  createDocumentFragment(): FakeDocumentFragment {
    const node = new FakeDocumentFragment()
    node.ownerDocument = this
    return node
  }
}

const fakeDocument = new FakeDocument()

const fakeWindow = {
  document: fakeDocument,
  navigator: { userAgent: 'bun-contract-suite' },
  localStorage: makeStorage(),
  /** React's active-element scan instanceof-checks this constructor. */
  HTMLIFrameElement: class FakeHTMLIFrameElement {},
  getComputedStyle: () => ({
    getPropertyValue: () => '',
    getPropertyPriority: () => '',
  }),
  matchMedia: () => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  requestAnimationFrame: (callback: FrameRequestCallback): number =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (handle: number): void => {
    clearTimeout(handle)
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  scrollX: 0,
  scrollY: 0,
  pageXOffset: 0,
  pageYOffset: 0,
  innerWidth: 1024,
  innerHeight: 768,
  location: { href: 'http://agent.test/' },
}
fakeDocument.defaultView = fakeWindow

function makeStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, String(value))
    },
    removeItem: (key: string): void => {
      store.delete(key)
    },
    clear: (): void => {
      store.clear()
    },
    key: (index: number): string | null => [...store.keys()][index] ?? null,
    get length(): number {
      return store.size
    },
  }
}

/** A storage whose reads (mode 'read') or writes (mode 'write') always throw. */
function makeThrowingStorage(mode: 'read' | 'write') {
  const base = makeStorage()
  return {
    ...base,
    getItem:
      mode === 'read'
        ? () => {
            throw new Error('storage sealed')
          }
        : base.getItem,
    setItem:
      mode === 'write'
        ? () => {
            throw new Error('storage sealed')
          }
        : base.setItem,
  }
}

// --------------------------------------------------------------------------
// Globals: installed for the duration of this file, restored after.
// --------------------------------------------------------------------------

const ABSENT = Symbol('global-was-absent')
const savedGlobals = new Map<string | symbol, unknown>()
const globalsHost = globalThis as Record<string | symbol, unknown>

function stashGlobal(name: string, value: unknown): void {
  savedGlobals.set(name, name in globalsHost ? globalsHost[name] : ABSENT)
  globalsHost[name] = value
}

stashGlobal('window', fakeWindow)
stashGlobal('document', fakeDocument)
stashGlobal('getComputedStyle', fakeWindow.getComputedStyle)
stashGlobal('requestAnimationFrame', fakeWindow.requestAnimationFrame)
stashGlobal('cancelAnimationFrame', fakeWindow.cancelAnimationFrame)
stashGlobal('IS_REACT_ACT_ENVIRONMENT', true)
stashGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
)
stashGlobal(
  'MutationObserver',
  class {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return []
    }
  },
)
stashGlobal('NodeFilter', NODE_FILTER)
stashGlobal('HTMLInputElement', class FakeHTMLInputElement {})

afterAll(async () => {
  for (const scene of [...mountedScenes].reverse()) {
    await dismissScene(scene)
  }
  for (const [name, value] of savedGlobals) {
    if (value === ABSENT) delete globalsHost[name]
    else globalsHost[name] = value
  }
  savedGlobals.clear()
})

// --------------------------------------------------------------------------
// Subject + renderer, imported only after the globals and the module
// mocks above are in place.
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Subject + renderer, imported only after the globals and the module
// mocks above are in place.
// --------------------------------------------------------------------------

const { useOutputsRailOpen, OutputsRail } = await import(
  './agent-conversation.outputs-rail'
)
const { createRoot } = await import('react-dom/client')

type RootHandle = ReturnType<typeof createRoot>
interface MountedScene {
  root: RootHandle
  container: FakeElement
}

const mountedScenes: MountedScene[] = []
const act = React.act

async function renderElement(
  element: React.ReactElement,
): Promise<MountedScene> {
  const container = fakeDocument.createElement('div')
  fakeDocument.body.appendChild(container)
  const root = createRoot(container)
  const scene = { root, container }
  mountedScenes.push(scene)
  await act(async () => {
    root.render(element)
  })
  return scene
}

async function rerenderScene(
  scene: MountedScene,
  element: React.ReactElement,
): Promise<void> {
  await act(async () => {
    scene.root.render(element)
  })
}

async function clickNode(node: FakeElement): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new FakeEvent('click', { bubbles: true }))
  })
}

async function dismissScene(scene: MountedScene): Promise<void> {
  const index = mountedScenes.indexOf(scene)
  if (index !== -1) mountedScenes.splice(index, 1)
  await act(async () => {
    scene.root.unmount()
  })
  scene.container.parentNode?.removeChild(scene.container)
}

// --------------------------------------------------------------------------
// Query helpers over the fake DOM.
// --------------------------------------------------------------------------

function descendantElements(node: FakeNode): FakeElement[] {
  const found: FakeElement[] = []
  for (const child of node.childNodes) {
    if (child instanceof FakeElement) found.push(child)
    found.push(...descendantElements(child))
  }
  return found
}

function findByAttr(
  root: FakeNode,
  name: string,
  value: string,
): FakeElement | null {
  return (
    descendantElements(root).find(
      (element) => element.getAttribute(name) === value,
    ) ?? null
  )
}

function countByAttr(root: FakeNode, name: string, value: string): number {
  return descendantElements(root).filter(
    (element) => element.getAttribute(name) === value,
  ).length
}

function findIncludingText(root: FakeNode, text: string): FakeElement | null {
  return (
    descendantElements(root).find((element) => element.textContent === text) ??
    null
  )
}

function findButtonByTitle(root: FakeNode, title: string): FakeElement {
  const button = findByAttr(root, 'title', title)
  if (!button) throw new Error(`no element titled ${title}`)
  return button
}

// --------------------------------------------------------------------------
// Fixtures.
// --------------------------------------------------------------------------

function makeFile(id: string, path: string, size: number): ProducedFile {
  return { id, path, size, mtimeMs: 1, createdAt: 1, detectedBy: 'diff' }
}

const GROUP_REPORT: ProducedFilesRailGroup = {
  turnId: 'turn-report',
  turnPrompt: '  Draft the quarterly report',
  createdAt: 10,
  files: [
    makeFile('file-report', 'reports/q3/report.md', 2457600),
    makeFile('file-notes', 'reports/q3/notes.txt', 42),
  ],
}

const GROUP_CHART: ProducedFilesRailGroup = {
  turnId: 'turn-chart',
  turnPrompt: '',
  createdAt: 20,
  files: [makeFile('file-chart', 'art/chart.png', 512)],
}

function resetRailData(): void {
  railData = {
    groups: [],
    loading: false,
    error: null,
    refreshPending: false,
  }
}

async function renderRail(
  props: Partial<{
    agentId: string
    onClose: () => void
    focusTurnId: string | null
    onFocusTurnConsumed: () => void
  }> = {},
): Promise<MountedScene> {
  return renderElement(
    React.createElement(OutputsRail, {
      agentId: props.agentId ?? 'rail-agent',
      onClose: props.onClose ?? (() => undefined),
      focusTurnId: props.focusTurnId ?? null,
      onFocusTurnConsumed: props.onFocusTurnConsumed,
    }),
  )
}

/**
 * Consumes the hook exactly the way the conversation page does: the
 * first tuple slot feeds rendering, the second is fired from
 * controls. The probe's own markup is deliberately free of the words
 * "open" and "closed" so text assertions can target the state span.
 */
function RailOpenProbe({ agentId }: { agentId: string }) {
  const [open, update] = useOutputsRailOpen(agentId)
  return React.createElement(
    'div',
    {},
    React.createElement('span', { 'data-open': open ? 'yes' : 'no' }, 'state'),
    React.createElement(
      'button',
      { type: 'button', 'data-act': 'flip-on', onClick: () => update(true) },
      'flip on',
    ),
    React.createElement(
      'button',
      { type: 'button', 'data-act': 'flip-off', onClick: () => update(false) },
      'flip off',
    ),
  )
}

function probeState(scene: MountedScene): string {
  return findByAttr(scene.container, 'data-open', 'yes') ? 'yes' : 'no'
}

// --------------------------------------------------------------------------
// The contract.
// --------------------------------------------------------------------------

describe('agentConversationOutputsRailTsxContract', () => {
  describe('useOutputsRailOpen', () => {
    it('persists per-agent open state through localStorage, rehydrates on mount, and survives sealed storage', async () => {
      // A fresh agent starts closed and stores nothing.
      fakeWindow.localStorage = makeStorage()
      const fresh = await renderElement(
        React.createElement(RailOpenProbe, { agentId: 'probe-fresh' }),
      )
      expect(probeState(fresh)).toBe('no')
      expect(
        fakeWindow.localStorage.getItem('browseros:outputs-rail:probe-fresh'),
      ).toBeNull()

      // Flipping on both updates state and persists '1' under the
      // agent-scoped key.
      await clickNode(findByAttr(fresh.container, 'data-act', 'flip-on'))
      expect(probeState(fresh)).toBe('yes')
      expect(
        fakeWindow.localStorage.getItem('browseros:outputs-rail:probe-fresh'),
      ).toBe('1')

      // Flipping off persists '0'.
      await clickNode(findByAttr(fresh.container, 'data-act', 'flip-off'))
      expect(probeState(fresh)).toBe('no')
      expect(
        fakeWindow.localStorage.getItem('browseros:outputs-rail:probe-fresh'),
      ).toBe('0')
      await dismissScene(fresh)

      // A remount restores the stored preference: '1' means open.
      fakeWindow.localStorage = makeStorage({
        'browseros:outputs-rail:probe-restore': '1',
      })
      const restored = await renderElement(
        React.createElement(RailOpenProbe, { agentId: 'probe-restore' }),
      )
      expect(probeState(restored)).toBe('yes')
      await dismissScene(restored)

      // Anything but '1' stays closed - both '0' and garbage.
      fakeWindow.localStorage = makeStorage({
        'browseros:outputs-rail:probe-zero': '0',
        'browseros:outputs-rail:probe-junk': 'junk',
      })
      const zero = await renderElement(
        React.createElement(RailOpenProbe, { agentId: 'probe-zero' }),
      )
      expect(probeState(zero)).toBe('no')
      await dismissScene(zero)
      const junk = await renderElement(
        React.createElement(RailOpenProbe, { agentId: 'probe-junk' }),
      )
      expect(probeState(junk)).toBe('no')
      await dismissScene(junk)

      // Agents remember independently: switching the same mounted
      // probe to another agent re-reads that agent's memory.
      fakeWindow.localStorage = makeStorage({
        'browseros:outputs-rail:probe-alpha': '1',
        'browseros:outputs-rail:probe-beta': '0',
      })
      const switching = await renderElement(
        React.createElement(RailOpenProbe, { agentId: 'probe-alpha' }),
      )
      expect(probeState(switching)).toBe('yes')
      await rerenderScene(
        switching,
        React.createElement(RailOpenProbe, { agentId: 'probe-beta' }),
      )
      expect(probeState(switching)).toBe('no')
      await dismissScene(switching)

      // Sealed reads fall back to closed without crashing.
      fakeWindow.localStorage = makeThrowingStorage('read')
      const sealedRead = await renderElement(
        React.createElement(RailOpenProbe, { agentId: 'probe-sealed' }),
      )
      expect(probeState(sealedRead)).toBe('no')

      // Sealed writes are best-effort: the state still flips.
      fakeWindow.localStorage = makeThrowingStorage('write')
      const sealedWrite = await renderElement(
        React.createElement(RailOpenProbe, { agentId: 'probe-sealed' }),
      )
      await clickNode(findByAttr(sealedWrite.container, 'data-act', 'flip-on'))
      expect(probeState(sealedWrite)).toBe('yes')
      await dismissScene(sealedRead)
      await dismissScene(sealedWrite)
    }, 20000)
  })

  describe('OutputsRail', () => {
    it('renders every data state and wires its controls: hide, refresh, collapsible turns, deep link, and preview sheet', async () => {
      // --- Empty state: header, no count badge, empty copy.
      resetRailData()
      const empty = await renderRail()
      const emptyHeader = descendantElements(empty.container).find(
        (element) => element.tagName === 'HEADER',
      )
      expect(emptyHeader?.textContent).toBe('Outputs')
      expect(
        findIncludingText(empty.container, 'No outputs yet'),
      ).not.toBeNull()
      expect(countByAttr(empty.container, 'data-slot', 'skeleton')).toBe(0)
      await dismissScene(empty)

      // --- Loading state: skeleton rows, no empty copy yet.
      resetRailData()
      railData = { ...railData, loading: true }
      const loading = await renderRail()
      expect(countByAttr(loading.container, 'data-slot', 'skeleton')).toBe(4)
      expect(findIncludingText(loading.container, 'No outputs yet')).toBeNull()
      await dismissScene(loading)

      // --- Error state: the fetch error message is surfaced.
      resetRailData()
      railData = { ...railData, error: new Error('outputs fetch exploded') }
      const failed = await renderRail()
      expect(failed.container.textContent).toContain('outputs fetch exploded')
      expect(findIncludingText(failed.container, 'No outputs yet')).toBeNull()
      await dismissScene(failed)

      // --- Populated state: total badge, turn labels (trimmed,
      // 'Turn' fallback), basenames, human sizes, per-group counts,
      // and full paths on row tooltips.
      resetRailData()
      railData = { ...railData, groups: [GROUP_REPORT, GROUP_CHART] }
      const populated = await renderRail()
      const populatedHeader = descendantElements(populated.container).find(
        (element) => element.tagName === 'HEADER',
      )
      expect(populatedHeader?.textContent).toBe('Outputs3')
      for (const expected of [
        'Draft the quarterly report',
        'Turn',
        'report.md',
        'notes.txt',
        'chart.png',
        '2.3 MB',
        '42 B',
        '512 B',
      ]) {
        expect(populated.container.textContent).toContain(expected)
      }
      expect(
        findByAttr(populated.container, 'title', 'reports/q3/report.md'),
      ).not.toBeNull()
      expect(
        findByAttr(populated.container, 'title', 'art/chart.png'),
      ).not.toBeNull()
      const triggerButtons = descendantElements(populated.container).filter(
        (element) =>
          element.tagName === 'BUTTON' && element.hasAttribute('data-state'),
      )
      expect(triggerButtons.map((button) => button.textContent)).toEqual([
        'Draft the quarterly report2',
        'Turn1',
      ])
      await dismissScene(populated)

      // --- Refresh button reflects the pending state.
      resetRailData()
      railData = { ...railData, refreshPending: true }
      const pending = await renderRail()
      expect(
        findButtonByTitle(pending.container, 'Refresh').hasAttribute(
          'disabled',
        ),
      ).toBe(true)
      await dismissScene(pending)
      resetRailData()
      const idle = await renderRail()
      expect(
        findButtonByTitle(idle.container, 'Refresh').hasAttribute('disabled'),
      ).toBe(false)
      await dismissScene(idle)

      // --- Hide button reports back to the parent.
      resetRailData()
      const onClose = mock(() => undefined)
      const closable = await renderRail({ onClose })
      await clickNode(findButtonByTitle(closable.container, 'Hide outputs'))
      expect(onClose).toHaveBeenCalledTimes(1)
      await dismissScene(closable)

      // --- Turn groups collapse and expand on their triggers: a
      // collapsed turn stops presenting its file rows.
      resetRailData()
      railData = { ...railData, groups: [GROUP_REPORT] }
      const collapsible = await renderRail()
      expect(
        findByAttr(collapsible.container, 'title', 'reports/q3/report.md'),
      ).not.toBeNull()
      const reportTrigger = descendantElements(collapsible.container).find(
        (element) =>
          element.tagName === 'BUTTON' &&
          element.getAttribute('data-state') === 'open',
      )
      await clickNode(reportTrigger as FakeElement)
      expect(reportTrigger?.getAttribute('data-state')).toBe('closed')
      expect(
        findByAttr(collapsible.container, 'title', 'reports/q3/report.md'),
      ).toBeNull()
      await clickNode(reportTrigger as FakeElement)
      expect(reportTrigger?.getAttribute('data-state')).toBe('open')
      expect(
        findByAttr(collapsible.container, 'title', 'reports/q3/report.md'),
      ).not.toBeNull()
      await dismissScene(collapsible)

      // --- Deep link: focusing a collapsed turn force-reopens the
      // group, scrolls the rail to reveal the row, and acks the
      // parent exactly once; clearing the focus does neither again.
      resetRailData()
      railData = { ...railData, groups: [GROUP_REPORT, GROUP_CHART] }
      const deepLink = await renderRail()
      const chartTrigger = descendantElements(deepLink.container).find(
        (element) =>
          element.tagName === 'BUTTON' && element.textContent.includes('Turn'),
      )
      await clickNode(chartTrigger as FakeElement)
      expect(chartTrigger?.getAttribute('data-state')).toBe('closed')
      expect(
        findByAttr(deepLink.container, 'title', 'art/chart.png'),
      ).toBeNull()

      const onFocusTurnConsumed = mock(() => undefined)
      await rerenderScene(
        deepLink,
        React.createElement(OutputsRail, {
          agentId: 'rail-agent',
          onClose: () => undefined,
          focusTurnId: 'turn-chart',
          onFocusTurnConsumed,
        }),
      )
      expect(chartTrigger?.getAttribute('data-state')).toBe('open')
      expect(
        findByAttr(deepLink.container, 'title', 'art/chart.png'),
      ).not.toBeNull()
      expect(onFocusTurnConsumed).toHaveBeenCalledTimes(1)
      const scrolled = descendantElements(deepLink.container).filter(
        (element) => element.scrollIntoViewCalls > 0,
      )
      expect(scrolled).toHaveLength(1)
      expect(scrolled[0].textContent).toContain('chart.png')
      expect(scrolled[0].textContent).not.toContain('report.md')

      await rerenderScene(
        deepLink,
        React.createElement(OutputsRail, {
          agentId: 'rail-agent',
          onClose: () => undefined,
          focusTurnId: null,
          onFocusTurnConsumed,
        }),
      )
      expect(onFocusTurnConsumed).toHaveBeenCalledTimes(1)
      expect(
        descendantElements(deepLink.container).filter(
          (element) => element.scrollIntoViewCalls > 1,
        ),
      ).toHaveLength(0)
      await dismissScene(deepLink)

      // --- Clicking a file row opens the shared preview sheet on
      // top of the rail, titled with the file's basename.
      resetRailData()
      railData = { ...railData, groups: [GROUP_CHART] }
      const previewing = await renderRail()
      await clickNode(findButtonByTitle(previewing.container, 'art/chart.png'))
      const dialog = findByAttr(fakeDocument.body, 'role', 'dialog')
      expect(dialog).not.toBeNull()
      expect(dialog?.textContent).toContain('chart.png')
      expect(dialog?.textContent).toContain('art/chart.png')
      await dismissScene(previewing)
      expect(findByAttr(fakeDocument.body, 'role', 'dialog')).toBeNull()
    }, 20000)
  })
})
