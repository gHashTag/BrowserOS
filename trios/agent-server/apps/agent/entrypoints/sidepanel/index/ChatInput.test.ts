/* Prototype v2: harness + interactions */
import { describe, expect, it } from 'bun:test'
import { act, createElement, type RefObject } from 'react'
import { ChatInput, type ChatInputHandle } from './ChatInput'

const anyDoc: any = {}

class Node_ {
  parentNode: any = null
  childNodes: any[] = []
  ownerDocument: any = anyDoc
  listeners = new Map<string, { cap: Set<Function>; bub: Set<Function> }>()
  addEventListener(type: string, fn: any, opts?: unknown) {
    const capture = opts === true || (opts as any)?.capture === true
    let entry = this.listeners.get(type)
    if (!entry) {
      entry = { cap: new Set(), bub: new Set() }
      this.listeners.set(type, entry)
    }
    ;(capture ? entry.cap : entry.bub).add(fn)
  }
  removeEventListener(type: string, fn: any, opts?: unknown) {
    const capture = opts === true || (opts as any)?.capture === true
    const entry = this.listeners.get(type)
    if (!entry) return
    ;(capture ? entry.cap : entry.bub).delete(fn)
  }
  get firstChild() {
    return this.childNodes[0] ?? null
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }
  get nextSibling() {
    const sibs = this.parentNode?.childNodes ?? []
    const i = sibs.indexOf(this)
    return i >= 0 ? (sibs[i + 1] ?? null) : null
  }
  get previousSibling() {
    const sibs = this.parentNode?.childNodes ?? []
    const i = sibs.indexOf(this)
    return i > 0 ? (sibs[i - 1] ?? null) : null
  }
  appendChild(n: any) {
    if (n.parentNode) n.parentNode.removeChild(n)
    n.parentNode = this
    this.childNodes.push(n)
    return n
  }
  insertBefore(n: any, ref: any) {
    if (ref == null) return this.appendChild(n)
    if (n.parentNode) n.parentNode.removeChild(n)
    n.parentNode = this
    const i = this.childNodes.indexOf(ref)
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n)
    return n
  }
  removeChild(n: any) {
    const i = this.childNodes.indexOf(n)
    if (i >= 0) {
      this.childNodes.splice(i, 1)
      n.parentNode = null
    }
    return n
  }
  contains(n: any): boolean {
    let cur = n
    while (cur) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
  }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue
    return this.childNodes.map((c) => c.textContent).join('')
  }
  set textContent(v: string) {
    this.childNodes = []
    if (v) this.appendChild(anyDoc.createTextNode(v))
  }
}

class TextNode_ extends Node_ {
  constructor(public nodeValue: string) {
    super()
  }
}
TextNode_.prototype.nodeType = 3

class CommentNode_ extends Node_ {
  constructor(public nodeValue: string) {
    super()
  }
}
CommentNode_.prototype.nodeType = 8

function selectorMatches(el: any, selector: string): boolean {
  if (!el || el.nodeType !== 1) return false
  const attrMatch = selector.match(/^\[([a-zA-Z0-9_:.-]+)(?:="([^"]*)")?\]$/)
  if (attrMatch) {
    const [, name, value] = attrMatch
    if (value === undefined) return el.hasAttribute(name)
    return el.getAttribute(name) === value
  }
  if (selector.startsWith('.')) {
    const cls = el.getAttribute('class') ?? ''
    const parts: string[] = []
    for (const p of cls.split(' ')) if (p) parts.push(p)
    return parts.includes(selector.slice(1))
  }
  return el.tagName === selector.toUpperCase()
}

class Element_ extends Node_ {
  tagName: string
  attributes: Record<string, string> = {}
  style: any = { setProperty: () => {} }
  dataset: Record<string, string> = {}
  constructor(tag: string) {
    super()
    this.tagName = tag.toUpperCase()
  }
  get nodeName() {
    return this.tagName
  }
  get className() {
    return this.getAttribute('class') ?? ''
  }
  set className(v: string) {
    this.setAttribute('class', v)
  }
  get id() {
    return this.getAttribute('id') ?? ''
  }
  set id(v: string) {
    this.setAttribute('id', v)
  }
  setAttribute(n: string, v: unknown) {
    this.attributes[n] = String(v)
    if (n === 'value') (this as any)._value = String(v)
  }
  getAttribute(n: string) {
    return this.attributes[n] ?? null
  }
  removeAttribute(n: string) {
    delete this.attributes[n]
  }
  hasAttribute(n: string) {
    return this.attributes[n] !== undefined
  }
  closest(selector: string) {
    let cur: any = this
    while (cur && cur.nodeType === 1) {
      if (selectorMatches(cur, selector)) return cur
      cur = cur.parentNode
    }
    return null
  }
  querySelectorAll(selector: string) {
    const out: any[] = []
    const walk = (n: any) => {
      for (const c of n.childNodes) {
        if (selectorMatches(c, selector)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
  getBoundingClientRect() {
    return {
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
    }
  }
  focus() {
    anyDoc.activeElement = this
  }
  blur() {
    if (anyDoc.activeElement === this) anyDoc.activeElement = anyDoc.body
  }
  scrollIntoView() {}
}

Object.defineProperty(Element_.prototype, 'form', {
  get(this: any) {
    let n = this.parentNode
    while (n) {
      if (n.tagName === 'FORM') return n
      n = n.parentNode
    }
    return null
  },
  configurable: true,
})

class FormElement_ extends Element_ {}
Element_.prototype.nodeType = 1

class TextAreaElement_ extends Element_ {
  selectionStart = 0
  selectionEnd = 0
  setSelectionRange(a: number, b: number) {
    this.selectionStart = a
    this.selectionEnd = b
  }
}
class InputElement_ extends Element_ {
  selectionStart = 0
  selectionEnd = 0
  setSelectionRange(a: number, b: number) {
    this.selectionStart = a
    this.selectionEnd = b
  }
  checked = false
}

for (const cls of [TextAreaElement_, InputElement_]) {
  Object.defineProperty(cls.prototype, 'value', {
    get(this: any) {
      return this._value ?? ''
    },
    set(this: any, v: string) {
      this._value = String(v)
    },
    configurable: true,
  })
}

function makeEvent(type: string, target: any, extra: Record<string, unknown> = {}) {
  const ev: any = {
    type,
    target,
    currentTarget: null,
    timeStamp: 0,
    isTrusted: true,
    defaultPrevented: false,
    eventPhase: 0,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {
      this._stopped = true
    },
    isPropagationStopped() {
      return this._stopped === true
    },
  }
  return Object.assign(ev, extra)
}

function fire(target: any, type: string, extra: Record<string, unknown> = {}) {
  const ev = makeEvent(type, target, extra)
  const chain: any[] = []
  for (let n = target; n; n = n.parentNode) chain.push(n)
  if (type === 'input' || type === 'keydown') {
    console.log(
      `FIRE ${type}: chain=${chain.map((n) => n.tagName).join('>')}`,
      chain.map((n) => n.listeners?.get(type)).map((e) => (e ? `${e.cap.size}/${e.bub.size}` : '-')),
    )
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    if (ev._stopped) break
    const entry = chain[i].listeners?.get(type)
    if (!entry) continue
    ev.eventPhase = 1
    for (const fn of [...entry.cap]) fn(ev)
  }
  for (let i = 0; i < chain.length; i++) {
    if (ev._stopped) break
    const entry = chain[i].listeners?.get(type)
    if (!entry) continue
    ev.eventPhase = 3
    for (const fn of [...entry.bub]) fn(ev)
  }
  ev.eventPhase = 0
  return ev
}

const docListeners = new Map<string, Set<Function>>()
const anyDocBody = new Element_('BODY')

anyDoc.nodeType = 9
anyDoc.nodeName = '#document'
anyDoc.oninput = null
anyDoc.childNodes = []
anyDoc.parentNode = null
anyDoc.body = anyDocBody
anyDoc.documentElement = new Element_('HTML')
anyDoc.activeElement = anyDocBody
anyDoc.createElement = (tag: string) => {
  const lower = tag.toLowerCase()
  if (lower === 'form') return new FormElement_(tag)
  if (lower === 'textarea') return new TextAreaElement_(tag)
  if (lower === 'input') return new InputElement_(tag)
  return new Element_(tag)
}
anyDoc.createTextNode = (t: string) => new TextNode_(t)
anyDoc.createComment = (t: string) => new CommentNode_(t)
anyDoc.createElementNS = (_ns: string, tag: string) => anyDoc.createElement(tag)
anyDoc.addEventListener = (t: string, fn: Function) => {
  if (!docListeners.has(t)) docListeners.set(t, new Set())
  docListeners.get(t)!.add(fn)
}
anyDoc.removeEventListener = (t: string, fn: Function) => {
  docListeners.get(t)?.delete(fn)
}
anyDoc.contains = (n: any) =>
  anyDoc.documentElement === n || (anyDoc.documentElement.contains?.(n) ?? false)

const fakeWindow: any = {
  document: anyDoc,
  addEventListener: anyDoc.addEventListener,
  removeEventListener: anyDoc.removeEventListener,
  HTMLIFrameElement: class HTMLIFrameElement {},
  HTMLTextAreaElement: TextAreaElement_,
  HTMLInputElement: InputElement_,
  HTMLSelectElement: class HTMLSelectElement {},
  scrollX: 0,
  scrollY: 0,
  innerWidth: 1024,
  innerHeight: 768,
  visualViewport: null,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
}
anyDoc.defaultView = fakeWindow

;(globalThis as any).document = anyDoc
;(globalThis as any).chrome = { tabs: { query: async () => [] } }
;(globalThis as any).window = fakeWindow
;(globalThis as any).navigator = { userAgent: 'bun-test' }
;(globalThis as any).requestAnimationFrame = (cb: Function) => {
  cb(0)
  return 0
}
;(globalThis as any).cancelAnimationFrame = () => {}
;(globalThis as any).getComputedStyle = fakeWindow.getComputedStyle
;(globalThis as any).matchMedia = fakeWindow.matchMedia
;(globalThis as any).ResizeObserver = fakeWindow.ResizeObserver
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

FormElement_.prototype.requestSubmit = function (this: any) {
  fire(this, 'submit')
}

/* react-dom computes DOM feature flags at import time, so the fake DOM globals
   must be in place before it is loaded. */
const { createRoot } = await import('react-dom/client')
type Root = Awaited<ReturnType<typeof createRoot>>

/* --- harness --- */

function findAll(root: any, pred: (el: any) => boolean): any[] {
  const out: any[] = []
  const walk = (n: any) => {
    if (!n) return
    if (n.nodeType === 1 && pred(n)) out.push(n)
    for (const c of n.childNodes ?? []) walk(c)
  }
  walk(root)
  return out
}

const byTag = (root: any, tag: string) =>
  findAll(root, (el) => el.tagName === tag.toUpperCase())

const buttonByText = (root: any, text: string) =>
  byTag(root, 'button').find((b) => b.textContent === text) ?? null

interface MountApi {
  container: any
  root: Root
  ref: RefObject<ChatInputHandle | null>
  textarea: () => any
  form: () => any
  setProps: (patch: Record<string, unknown>) => Promise<void>
  unmount: () => Promise<void>
}

async function mountChatInput(overrides: Record<string, unknown> = {}): Promise<MountApi> {
  const state: Record<string, unknown> = {
    input: '',
    status: 'ready',
    mode: 'chat',
    onInputChange: () => {},
    onSubmit: () => {},
    onStop: () => {},
    selectedTabs: [],
    onToggleTab: () => {},
    ...overrides,
  }
  const container = new Element_('DIV')
  const rootEl = createRoot(container as any)
  const ref: RefObject<ChatInputHandle | null> = { current: null }
  const render = () =>
    rootEl.render(createElement(ChatInput, { ...(state as any), ref } as any))
  await act(async () => {
    render()
  })
  return {
    container,
    root: rootEl,
    ref,
    textarea: () => byTag(container, 'textarea')[0] ?? null,
    form: () => byTag(container, 'form')[0] ?? null,
    setProps: async (patch) => {
      Object.assign(state, patch)
      await act(async () => {
        render()
      })
    },
    unmount: async () => {
      await act(async () => {
        rootEl.unmount()
      })
    },
  }
}

async function typeInto(api: MountApi, nextValue: string, caret?: number) {
  const ta = api.textarea()
  const protoSetter = Object.getOwnPropertyDescriptor(
    TextAreaElement_.prototype,
    'value',
  )!.set!
  await act(async () => {
    protoSetter.call(ta, nextValue)
    ta.selectionStart = caret ?? nextValue.length
    ta.selectionEnd = caret ?? nextValue.length
    fire(ta, 'input')
  })
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5))
  })
}

describe('ChatInputTsxContract', () => {
  it('interactions probe', async () => {
    // minimal controlled textarea repro
    const minContainer = new Element_('DIV')
    const minRoot = createRoot(minContainer as any)
    let minCalls = 0
    let minV = ''
    const MinComp2 = () =>
      createElement('textarea', {
        value: minV,
        onChange: (e: any) => {
          minCalls++
          minV = e.target.value
        },
      })
    await act(async () => {
      minRoot.render(createElement(MinComp2 as any))
    })
    const minTa = byTag(minContainer, 'textarea')[0]
    console.log('MIN mounted, value=', JSON.stringify(minTa?.value), 'tracker=', !!minTa?._valueTracker)
    const minSetter = Object.getOwnPropertyDescriptor(TextAreaElement_.prototype, 'value')!.set!
    await act(async () => {
      minSetter.call(minTa, 'abc')
      fire(minTa, 'input')
    })
    console.log('MIN after input: calls=', minCalls, 'value=', JSON.stringify(minTa?.value), 'tracker=', minTa?._valueTracker?.getValue?.())
    let walkN: any = minTa
    let walkReport = 'none in chain'
    while (walkN) {
      const found = Object.keys(walkN).filter((k) => k.startsWith('__react'))
      if (found.length) {
        walkReport = `found ${found.join(',')} on ${walkN.tagName}`
        break
      }
      walkN = walkN.parentNode
    }
    console.log('MIN react-key walk:', walkReport)
    await act(async () => {
      minRoot.unmount()
    })
    expect(minCalls).toBe(1)
    const calls: string[] = []
    const api = await mountChatInput({
      onInputChange: (v: string) => {
        calls.push(`change:${v}`)
        return api?.setProps({ input: v })
      },
    })
    console.log('MOUNTED. buttons:', byTag(api.container, 'button').map((b) => b.textContent))
    console.log('listener types on container:', [...api.container.listeners.keys()])
    const ta0 = api.textarea()
    console.log('tracker:', JSON.stringify(ta0?._valueTracker), '| ta disabled:', ta0?.disabled, '| send attrs:', JSON.stringify(buttonByText(api.container, 'Send')?.attributes))
    console.log('placeholder:', api.textarea()?.getAttribute('placeholder'))
    console.log('send disabled (empty):', buttonByText(api.container, 'Send')?.disabled)

    await typeInto(api, 'hello')
    console.log('after typing:', JSON.stringify(calls), 'value:', api.textarea()?.value)
    const taProbe = api.textarea()
    console.log('probe: value=', taProbe?.value,
      'tracker.getValue=', taProbe?._valueTracker?.getValue?.(),
      'ownKeys=', Object.keys(taProbe ?? {}).slice(0, 12),
      'ownSyms=', Object.getOwnPropertySymbols(taProbe ?? {}).map(String),
    )
    const entry = api.container.listeners.get('input')
    if (entry) {
      for (const k of ['cap', 'bub'] as const) {
        const fns = [...entry[k]]
        entry[k].clear()
        for (const fn of fns) {
          entry[k].add((ev: any) => {
            console.log(`listener[${k}] CALLED type=${ev.type}`)
            try {
              const r = fn(ev)
              console.log(`listener[${k}] RETURNED`, String(r))
            } catch (err) {
              console.log(`listener[${k}] THREW`, String(err))
            }
          })
        }
      }
    }
    await typeInto(api, 'hello!')
    console.log('after wrapped dispatch:', JSON.stringify(calls), 'tracker=', api.textarea()?._valueTracker?.getValue?.())
    console.log('send disabled (hello):', buttonByText(api.container, 'Send')?.disabled)

    // type '@' at end
    await typeInto(api, 'hello @')
    console.log('after @:', JSON.stringify(calls))
    console.log('body text has popover:', anyDocBody.textContent.includes('Attach Tabs'))
    console.log('body text:', JSON.stringify(anyDocBody.textContent.slice(0, 300)))

    // keydown Enter with mention open
    const enterEv = fire(api.textarea(), 'keydown', {
      key: 'Enter',
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      nativeEvent: { isComposing: false },
    })
    console.log('enter-mention-open prevented:', enterEv.defaultPrevented)

    await api.unmount()
  })
})
