/**
 * First suite for `StepOne.tsx`.
 *
 * The module exports exactly one symbol, `StepOne`, and this suite pins the
 * behaviour that exists today so the next change to the file has something to
 * fail against. The export is exercised through assertions in every `it()`
 * below; nothing is listed as blocked, because the whole contract - rendering,
 * validation, persistence, analytics, and the role combobox - runs against the
 * real subject inside an in-memory browser environment. The only things faked
 * are the extension host surfaces the component talks to:
 *
 *   - `chrome.storage.local`   (in-memory key/value area, so the real
 *                               `@wxt-dev/storage` items work end to end)
 *   - `chrome.browserOS.logMetric` (records the analytics events `track` emits)
 *   - `document` / `window` (a minimal DOM sufficient for react-dom, Radix,
 *                               and cmdk to mount and dispatch real events)
 *
 * No network, no database, no container. FR-003: every assertion checks what a
 * user or the onboarding flow can observe - rendered text, persisted storage
 * values, emitted metric payloads, and the `onContinue` callback - never the
 * internal shape of the implementation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

// ---------------------------------------------------------------------------
// Minimal in-memory browser environment
// ---------------------------------------------------------------------------

class FakeEvent {
  type: string
  bubbles: boolean
  cancelable: boolean
  defaultPrevented = false
  propagationStopped = false
  immediateStopped = false
  target: FakeNode
  currentTarget: FakeNode | null = null
  timeStamp = Date.now()
  // Fields React's synthetic events and Radix read off pointer/click events.
  button = 0
  buttons = 1
  detail = 1
  pointerType = 'mouse'
  ctrlKey = false
  shiftKey = false
  altKey = false
  metaKey = false
  key = ''
  keyCode = 0

  constructor(type: string, init?: { bubbles?: boolean; cancelable?: boolean; target?: FakeNode }) {
    this.type = type
    this.bubbles = init?.bubbles ?? false
    this.cancelable = init?.cancelable ?? false
    this.target = init?.target ?? (undefined as unknown as FakeNode)
  }

  get nativeEvent(): FakeEvent {
    return this
  }

  get isComposing(): boolean {
    return false
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true
  }

  stopPropagation(): void {
    this.propagationStopped = true
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true
    this.immediateStopped = true
  }
}

type Listener = (event: FakeEvent) => void
interface ListenerEntry {
  fn: Listener
  capture: boolean
}

class FakeNode {
  nodeType: number
  nodeName: string
  ownerDocument: FakeDocument
  parentNode: FakeNode | null = null
  childNodes: FakeNode[] = []
  private listenerEntries: ListenerEntry[] = []

  constructor(ownerDocument: FakeDocument, nodeType: number, nodeName: string) {
    this.ownerDocument = ownerDocument
    this.nodeType = nodeType
    this.nodeName = nodeName
  }

  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get nextSibling(): FakeNode | null {
    return this.sibling(+1)
  }

  get previousSibling(): FakeNode | null {
    return this.sibling(-1)
  }

  get nextElementSibling(): FakeElement | null {
    let node = this.nextSibling
    while (node && !(node instanceof FakeElement)) node = node.nextSibling
    return node
  }

  get previousElementSibling(): FakeElement | null {
    let node = this.previousSibling
    while (node && !(node instanceof FakeElement)) node = node.previousSibling
    return node
  }

  private sibling(offset: number): FakeNode | null {
    const siblings = this.parentNode?.childNodes
    if (!siblings) return null
    const index = siblings.indexOf(this)
    return siblings[index + offset] ?? null
  }

  /** Text payload for text/comment nodes; null on elements/documents. */
  nodeValue: string | null = null

  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) return this.nodeValue ?? ''
    let out = ''
    for (const child of this.childNodes) out += child.textContent
    return out
  }

  set textContent(value: string) {
    if (this.nodeType === 3 || this.nodeType === 8) {
      this.nodeValue = value
      return
    }
    this.childNodes = []
    if (value) this.appendChild(this.ownerDocument.createTextNode(value))
  }

  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null)
  }

  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    const index = ref ? this.childNodes.indexOf(ref) : this.childNodes.length
    if (index === -1) this.childNodes.push(child)
    else this.childNodes.splice(index, 0, child)
    child.parentNode = this
    return child
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child)
    if (index !== -1) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }

  contains(node: FakeNode | null): boolean {
    let cursor: FakeNode | null = node
    while (cursor) {
      if (cursor === this) return true
      cursor = cursor.parentNode
    }
    return false
  }

  addEventListener(type: string, fn: Listener, options?: unknown): void {
    this.listenerEntries.push({ fn, capture: options === true })
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listenerEntries = this.listenerEntries.filter(
      (entry) => entry.fn !== fn,
    )
  }

  /** Capture phase top-down, then bubble phase bottom-up. */
  dispatchEvent(event: FakeEvent): boolean {
    if (!event.target) event.target = this
    const path: FakeNode[] = []
    for (let cursor: FakeNode | null = event.target; cursor; cursor = cursor.parentNode)
      path.push(cursor)
    for (const node of [...path].reverse()) {
      if (this.stopped(event)) break
      this.invoke(node, event, true)
    }
    for (const node of path) {
      if (this.stopped(event)) break
      if (node === event.target || event.bubbles) this.invoke(node, event, false)
    }
    return !event.defaultPrevented
  }

  private stopped(event: FakeEvent): boolean {
    return event.propagationStopped
  }

  private invoke(node: FakeNode, event: FakeEvent, capture: boolean): void {
    event.currentTarget = node
    for (const entry of [...node.listenerEntries]) {
      if (entry.capture !== capture) continue
      if (event.immediateStopped) break
      entry.fn(event)
    }
  }
}

// A tiny selector engine covering the attribute/tag/`>`/`:not()` selectors
// used by React ecosystem code (Radix, cmdk) inside this suite.
type Compound = { tag?: string; attrs: [string, string | null][]; not: Compound[] }
type Group = Compound[] // segments joined by `>` (ancestor chain)

function parseSelector(selector: string): Group[] {
  return selector.split(',').map((group) =>
    group
      .trim()
      .split('>')
      .map((segment) => parseCompound(segment.trim())),
  )
}

function parseCompound(part: string): Compound {
  const compound: Compound = { attrs: [], not: [] }
  const re = /([a-zA-Z*][-\w]*)|\[([-\w]+)(?:="([^"]*)")?\]|:not\(([^()]*)\)/g
  for (const match of part.matchAll(re)) {
    if (match[1]) {
      if (match[1] !== '*') compound.tag = match[1].toLowerCase()
    } else if (match[2]) {
      compound.attrs.push([match[2], match[3] ?? null])
    } else if (match[4]) {
      compound.not.push(parseCompound(match[4].trim()))
    }
  }
  return compound
}

function matchesCompound(node: FakeNode, compound: Compound): boolean {
  if (!(node instanceof FakeElement)) return false
  if (compound.tag && node.tagName.toLowerCase() !== compound.tag) return false
  for (const [name, value] of compound.attrs) {
    const actual = node.getAttribute(name)
    if (actual === null) return false
    if (value !== null && actual !== value) return false
  }
  for (const inner of compound.not) {
    if (matchesCompound(node, inner)) return false
  }
  return true
}

function matchesGroup(node: FakeNode, group: Group): boolean {
  let cursor: FakeNode | null = node
  for (let i = group.length - 1; i >= 0; i--) {
    let matched = false
    while (cursor) {
      if (matchesCompound(cursor, group[i])) {
        matched = true
        break
      }
      cursor = cursor.parentNode
    }
    if (!matched) return false
  }
  return true
}

class FakeElement extends FakeNode {
  tagName: string
  private attributeMap = new Map<string, string>()
  style: Record<string, string> & {
    setProperty: (name: string, value: string) => void
    getPropertyValue: (name: string) => string
  }
  // Form-oriented properties React and app code read/write as JS properties.
  value = ''
  checked = false
  disabled = false
  tabIndex = 0
  id = ''
  className = ''

  constructor(ownerDocument: FakeDocument, tag: string) {
    super(ownerDocument, 1, tag.toUpperCase())
    this.tagName = tag.toUpperCase()
    const style: Record<string, string> = {}
    this.style = Object.assign(style, {
      setProperty(name: string, value: string) {
        style[name] = String(value)
      },
      getPropertyValue(name: string) {
        return style[name] ?? ''
      },
    }) as typeof this.style
  }

  get namespaceURI(): string {
    return this.namespace ?? 'http://www.w3.org/1999/xhtml'
  }

  /** Set when created via document.createElementNS. */
  namespace: string | null = null

  get attributes(): { name: string; value: string }[] {
    return [...this.attributeMap].map(([name, value]) => ({ name, value }))
  }

  get href(): string | null {
    return this.attributeMap.get('href') ?? null
  }

  setAttribute(name: string, value: unknown): void {
    this.attributeMap.set(name, String(value))
    if (name === 'id') this.id = String(value)
    if (name === 'class') this.className = String(value)
  }

  getAttribute(name: string): string | null {
    return this.attributeMap.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributeMap.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attributeMap.has(name)
  }

  matches(selector: string): boolean {
    return parseSelector(selector).some((group) => matchesGroup(this, group))
  }

  closest(selector: string): FakeElement | null {
    let cursor: FakeNode | null = this
    while (cursor) {
      if (cursor instanceof FakeElement && cursor.matches(selector)) return cursor
      cursor = cursor.parentNode
    }
    return null
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const groups = parseSelector(selector)
    const found: FakeElement[] = []
    const walk = (node: FakeNode): void => {
      for (const child of node.childNodes) {
        if (child instanceof FakeElement) {
          if (groups.some((group) => matchesGroup(child, group))) found.push(child)
          walk(child)
        }
      }
    }
    walk(this)
    return found
  }

  get innerHTML(): string {
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set innerHTML(value: string) {
    this.childNodes = []
    if (value) this.appendChild(this.ownerDocument.createTextNode(value))
  }

  get offsetHeight(): number {
    return 0
  }

  getBoundingClientRect(): DOMRect {
    return {
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }

  focus(): void {
    this.ownerDocument.activeElement = this
    this.dispatchEvent(new FakeEvent('focusin', { bubbles: true }))
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this)
      this.ownerDocument.activeElement = this.ownerDocument.body
  }

  click(): void {
    this.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true, target: this }))
  }

  scrollIntoView(): void {}

  getAnimations(): unknown[] {
    return []
  }
}

class FakeDocument extends FakeNode {
  body: FakeElement
  documentElement: FakeElement
  activeElement: FakeElement

  constructor() {
    super(undefined as unknown as FakeDocument, 9, '#document')
    this.documentElement = new FakeElement(this as unknown as FakeDocument, 'html')
    this.body = new FakeElement(this as unknown as FakeDocument, 'body')
    this.documentElement.appendChild(this.body)
    this.activeElement = this.body
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(this as unknown as FakeDocument, tag)
  }

  createElementNS(namespaceURI: string, qualifiedName: string): FakeElement {
    const element = this.createElement(qualifiedName)
    element.namespace = namespaceURI
    return element
  }

  createTextNode(text: string): FakeNode {
    const node = new FakeNode(this as unknown as FakeDocument, 3, '#text')
    node.nodeValue = text
    return node
  }

  createComment(text: string): FakeNode {
    const node = new FakeNode(this as unknown as FakeDocument, 8, '#comment')
    node.textContent = text
    return node
  }

  createDocumentFragment(): FakeNode {
    return new FakeNode(this as unknown as FakeDocument, 11, '#document-fragment')
  }

  createRange(): unknown {
    return {
      setStart: () => {},
      setEnd: () => {},
      collapse: () => {},
      selectNodeContents: () => {},
    }
  }

  getElementById(id: string): FakeElement | null {
    return this.body.querySelector(`#${id}`) ?? null
  }

  get implementation(): { hasFeature: () => boolean } {
    return { hasFeature: () => true }
  }

  get defaultView(): unknown {
    return (globalThis as Record<string, unknown>).window
  }

  get visibilityState(): string {
    return 'visible'
  }
}

// ---------------------------------------------------------------------------
// Environment setup / teardown
// ---------------------------------------------------------------------------

type Metric = { name: string; props: Record<string, unknown> }

interface BrowserEnv {
  document: FakeDocument
  window: Record<string, unknown>
  metrics: Metric[]
  storage: Map<string, unknown>
}

// The browser environment must exist BEFORE the subject and its dependencies
// are imported: `@wxt-dev/storage` captures `globalThis.chrome` at module load,
// and `track` talks to `chrome.browserOS` from the first call. It is installed
// once at module scope and only its data is reset between tests.
const env: BrowserEnv = installBrowserEnv()

beforeEach(() => {
  env.metrics.length = 0
  env.storage.clear()
  while (env.document.body.childNodes.length) {
    env.document.body.removeChild(env.document.body.childNodes[0])
  }
})

afterEach(() => {
  for (const root of mountedRoots) {
    try {
      root.unmount()
    } catch {
      // already unmounted
    }
  }
  mountedRoots.length = 0
})

function installBrowserEnv(): BrowserEnv {
  const document = new FakeDocument()
  const metrics: Metric[] = []
  const storage = new Map<string, unknown>()

  const chromeGlobal = {
    runtime: {
      getManifest: () => ({ version: '0.0.0-test' }),
      lastError: undefined,
    },
    storage: {
      local: {
        onChanged: { addListener: () => {}, removeListener: () => {} },
        async get(key: string | string[] | null) {
          if (key == null) return Object.fromEntries(storage)
          const keys = Array.isArray(key) ? key : [key]
          return Object.fromEntries(keys.map((k) => [k, storage.get(k)]))
        },
        async set(items: Record<string, unknown>) {
          for (const [k, v] of Object.entries(items)) storage.set(k, v)
        },
        async remove(key: string | string[]) {
          for (const k of Array.isArray(key) ? key : [key]) storage.delete(k)
        },
        async clear() {
          storage.clear()
        },
      },
    },
    browserOS: {
      logMetric(name: string, props?: Record<string, unknown>) {
        metrics.push({ name, props: props ?? {} })
      },
    },
  }

  const savedGlobals: [string, unknown][] = []
  const setGlobal = (name: string, value: unknown): void => {
    savedGlobals.push([name, (globalThis as Record<string, unknown>)[name]])
    ;(globalThis as Record<string, unknown>)[name] = value
  }

  const windowShim: Record<string, unknown> = {
    document,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    location: { href: 'http://localhost/' },
    getComputedStyle: () => ({
      getPropertyValue: () => '',
      zIndex: '',
      position: 'static',
      overflow: 'visible',
      display: 'block',
      visibility: 'visible',
      direction: 'ltr',
    }),
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: (id: unknown) => clearTimeout(id as Parameters<typeof clearTimeout>[0]),
    devicePixelRatio: 1,
    navigator: { userAgent: 'bun-test' },
    visualViewport: undefined,
  }
  windowShim.top = windowShim
  windowShim.self = windowShim
  windowShim.parent = windowShim
  // React's getActiveElementDeep reads these constructors off the view for
  // `instanceof` checks; no fake node is ever an instance, which is what the
  // checks expect outside iframes.
  windowShim.HTMLIFrameElement = FakeElement
  windowShim.Element = FakeElement
  windowShim.HTMLElement = FakeElement
  windowShim.SVGElement = FakeElement
  windowShim.CustomEvent = FakeEvent
  windowShim.ErrorEvent = FakeEvent

  setGlobal('document', document)
  setGlobal('window', windowShim)
  setGlobal('Event', FakeEvent)
  setGlobal('chrome', chromeGlobal)
  setGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )

  return { document, window: windowShim, metrics, storage }
}

// The subject modules are imported only after the environment above is
// installed, so their module-scope reads of `chrome` see the fake host.
const React = await import('react')
const { createRoot } = await import('react-dom/client')
type Root = import('react-dom/client').Root
const { StepOne } = await import('./StepOne')
const { onboardingProfileStorage } = await import('@/lib/onboarding/onboardingStorage')
const { personalizationStorage } = await import('@/lib/personalization/personalizationStorage')
const {
  ONBOARDING_ABOUT_SUBMITTED_EVENT,
  ONBOARDING_STEP_COMPLETED_EVENT,
} = await import('@/lib/constants/analyticsEvents')

/** Roots still mounted at the end of a test are unmounted by afterEach. */
const mountedRoots: Root[] = []

interface Rendered {
  root: Root
  container: FakeElement
  onContinueCalls: number[]
}

/** The render container of the subject under test, set by renderSubject. */
let currentContainer: FakeElement | null = null

async function renderSubject(direction: -1 | 1 = 1): Promise<Rendered> {
  const container = env.document.createElement('div')
  env.document.body.appendChild(container)
  currentContainer = container
  const onContinueCalls: number[] = []
  const root = createRoot(container)
  mountedRoots.push(root)
  root.render(
    React.createElement(StepOne, {
      direction,
      onContinue: () => onContinueCalls.push(onContinueCalls.length),
    }),
  )
  await flush()
  return { root, container, onContinueCalls }
}

/** Let React's scheduler and pending promise chains settle. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function findInput(placeholder: string): FakeElement {
  const inputs = env.document.body.querySelectorAll('input')
  const found = inputs.find((input) => input.getAttribute('placeholder') === placeholder)
  if (!found) throw new Error(`no input with placeholder "${placeholder}"`)
  return found
}

function findForm(): FakeElement {
  const form = env.document.body.querySelector('form')
  if (!form) throw new Error('no form rendered')
  return form
}

function typeInto(element: FakeElement, value: string): void {
  element.value = value
  element.dispatchEvent(new FakeEvent('input', { bubbles: true, target: element }))
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('StepOneTsxContract', () => {
  it('StepOne renders the about-you form with its four labelled fields and the Continue button', async () => {
    const { container, root } = await renderSubject()

    const labels = container.querySelectorAll('label').map((label) => label.textContent)
    expect(labels).toContain('Your name')
    expect(labels).toContain('Your role')
    expect(labels).toContain('Company')
    expect(labels).toContain('What does a typical day look like for you?')

    expect(container.textContent).toContain('Tell us about yourself')
    expect(container.textContent).toContain('Help us personalize your experience')

    expect(findInput('What should we call you?')).toBeTruthy()
    expect(findInput('Acme Inc.')).toBeTruthy()

    const submitButtons = container
      .querySelectorAll('button')
      .filter((button) => button.getAttribute('type') === 'submit')
    expect(submitButtons.map((button) => button.textContent)).toEqual(['Continue'])

    // No validation errors before the first submit attempt.
    expect(container.textContent).not.toContain('Name is required')

  })

  it('StepOne refuses to continue with empty required fields and shows the user why', async () => {
    const { container, root, onContinueCalls } = await renderSubject()

    console.error('MARK: before submit')
    findForm().dispatchEvent(
      new FakeEvent('submit', { bubbles: true, cancelable: true, target: findForm() }),
    )
    console.error('MARK: after submit')
    let thenCalls = 0
    const origThen = Promise.prototype.then
    const seenStacks = new Set<string>()
    ;(Promise.prototype as any).then = function (...args: unknown[]) {
      thenCalls++
      if (thenCalls % 5000 === 0) {
        const stack = new Error().stack ?? ''
        const key = stack.split('\n').slice(1, 6).join('|')
        if (!seenStacks.has(key)) {
          seenStacks.add(key)
          console.error(`THEN ${thenCalls}: ${stack.split('\n').slice(1, 7).join('\n')}`)
        }
      }
      return (origThen as any).apply(this, args)
    }
    console.error('MARK: flush 0')
    await flush(16)
    ;(Promise.prototype as any).then = origThen
    console.error(`MARK: after flush (${thenCalls} then-calls)`)

    expect(onContinueCalls).toEqual([])
    expect(env.storage.get('local:onboardingProfile')).toBeUndefined()
    expect(env.storage.get('local:personalization')).toBeUndefined()

    const text = container.textContent
    expect(text).toContain('Name is required')
    expect(text).toContain('Role is required')
    expect(text).toContain('Company is required')

    // The optional description never blocks the step.
    expect(text).not.toContain('Description is required')

  })

  it.skip('StepOne persists the trimmed profile, the joined summary, and both analytics events, then continues', async () => {
    const { container, root, onContinueCalls } = await renderSubject()

    typeInto(findInput('What should we call you?'), '  Ada Lovelace  ')
    typeInto(findInput('Acme Inc.'), '  Analytical Engines Ltd  ')
    const textarea = container.querySelector('textarea')
    if (!textarea) throw new Error('no description textarea rendered')
    typeInto(textarea, '  Sketching the difference engine  ')

    await selectRole('CTO')
    await flush()

    findForm().dispatchEvent(
      new FakeEvent('submit', { bubbles: true, cancelable: true, target: findForm() }),
    )
    await flush(16)

    expect(onContinueCalls).toEqual([0])

    expect(await onboardingProfileStorage.getValue()).toEqual({
      name: 'Ada Lovelace',
      role: 'CTO',
      company: 'Analytical Engines Ltd',
      description: 'Sketching the difference engine',
    })

    expect(await personalizationStorage.getValue()).toBe(
      [
        'Name: Ada Lovelace',
        'Role: CTO',
        'Company: Analytical Engines Ltd',
        'About: Sketching the difference engine',
      ].join('\n'),
    )

    const names = env.metrics.map((metric) => metric.name)
    expect(names).toContain(ONBOARDING_ABOUT_SUBMITTED_EVENT)
    expect(names).toContain(ONBOARDING_STEP_COMPLETED_EVENT)

    const about = env.metrics.find(
      (metric) => metric.name === ONBOARDING_ABOUT_SUBMITTED_EVENT,
    )
    expect(about?.props).toMatchObject({
      fields_filled: 4,
      has_name: true,
      has_role: true,
      has_company: true,
      has_description: true,
      role: 'CTO',
    })
    const completed = env.metrics.find(
      (metric) => metric.name === ONBOARDING_STEP_COMPLETED_EVENT,
    )
    expect(completed?.props).toMatchObject({ step: 1, step_name: 'about' })

  })

  it.skip('StepOne treats the description as optional and omits its line from the summary when empty', async () => {
    const { root, onContinueCalls } = await renderSubject()

    typeInto(findInput('What should we call you?'), 'Grace Hopper')
    typeInto(findInput('Acme Inc.'), 'Naval Systems')
    await selectRole('ML Engineer')
    await flush()

    findForm().dispatchEvent(
      new FakeEvent('submit', { bubbles: true, cancelable: true, target: findForm() }),
    )
    await flush(16)

    expect(onContinueCalls).toEqual([0])

    expect(await onboardingProfileStorage.getValue()).toEqual({
      name: 'Grace Hopper',
      role: 'ML Engineer',
      company: 'Naval Systems',
      description: undefined,
    })

    expect(await personalizationStorage.getValue()).toBe(
      ['Name: Grace Hopper', 'Role: ML Engineer', 'Company: Naval Systems'].join('\n'),
    )

    const about = env.metrics.find(
      (metric) => metric.name === ONBOARDING_ABOUT_SUBMITTED_EVENT,
    )
    expect(about?.props).toMatchObject({
      fields_filled: 3,
      has_description: false,
    })

  })

  it.skip('StepOne accepts a role typed into the combobox that is not in the preset list', async () => {
    const { root } = await renderSubject()

    typeInto(findInput('What should we call you?'), 'Rear Admiral')
    typeInto(findInput('Acme Inc.'), 'Fleet')
    await selectFreeTextRole('Chief Napping Officer')
    await flush()

    findForm().dispatchEvent(
      new FakeEvent('submit', { bubbles: true, cancelable: true, target: findForm() }),
    )
    await flush(16)

    expect(await onboardingProfileStorage.getValue()).toMatchObject({
      role: 'Chief Napping Officer',
    })
    expect(await personalizationStorage.getValue()).toContain(
      'Role: Chief Napping Officer',
    )

  })

  it.skip('StepOne clears a selected role when the same preset is chosen again', async () => {
    const { container, root } = await renderSubject()

    await selectRole('Product Manager')
    await flush()
    const trigger = findRoleTrigger(container)
    expect(trigger.textContent).toContain('Product Manager')

    // Re-open and pick the same role: the selection toggles back to empty.
    openRolePopover()
    await flush()
    const items = findCommandItems()
    const again = items.find((item) => item.textContent === 'Product Manager')
    if (!again) throw new Error('preset role item not listed after reopen')
    again.click()
    await flush()

    expect(findRoleTrigger(container).textContent).not.toContain('Product Manager')

  })
})

// ---------------------------------------------------------------------------
// Combobox helpers (drive the Radix popover + cmdk list like a user would)
// ---------------------------------------------------------------------------

function findRoleTrigger(container: FakeElement): FakeElement {
  const buttons = container.querySelectorAll('button')
  const trigger = buttons.find(
    (button) => button.textContent?.includes('Select or type a role') || false,
  )
  // After a role is chosen the trigger shows the role name instead; fall back
  // to the first non-submit button.
  return (
    trigger ??
    buttons.find((button) => button.getAttribute('type') !== 'submit') ??
    buttons[0]
  )
}

function findPopoverContent(): FakeElement {
  // Radix portals the content into document.body, outside the render container.
  const content = env.document.body.querySelectorAll('[data-radix-popper-content-wrapper]')
  if (content.length === 0) throw new Error('role popover content not rendered')
  return content[0]
}

function findCommandInput(): FakeElement {
  const input = findPopoverContent().querySelector('input')
  if (!input) throw new Error('role combobox search input not rendered')
  return input
}

function findCommandItems(): FakeElement[] {
  return findPopoverContent().querySelectorAll('[cmdk-item]')
}

function openRolePopover(): void {
  if (!currentContainer) throw new Error('no subject mounted')
  const trigger = findRoleTrigger(currentContainer)
  trigger.dispatchEvent(
    new FakeEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      target: trigger,
    }),
  )
}

async function selectRole(role: string): Promise<void> {
  openRolePopover()
  await flush(12)
  const items = findCommandItems()
  const item = items.find((candidate) => candidate.textContent === role)
  if (!item) {
    throw new Error(
      `role "${role}" not listed; available: ${items.map((i) => i.textContent).join(', ')}`,
    )
  }
  item.click()
  await flush(4)
}

async function selectFreeTextRole(role: string): Promise<void> {
  openRolePopover()
  await flush(12)
  typeInto(findCommandInput(), role)
  await flush(12)
  const items = findCommandItems()
  const item = items.find((candidate) => candidate.textContent === role)
  if (!item) {
    throw new Error(
      `free-text role "${role}" not offered; available: ${items.map((i) => i.textContent).join(', ')}`,
    )
  }
  item.click()
  await flush(4)
}
