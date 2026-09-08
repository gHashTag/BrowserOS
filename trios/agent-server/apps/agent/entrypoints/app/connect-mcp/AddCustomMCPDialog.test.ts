/**
 * Contract suite for the exports of AddCustomMCPDialog.tsx.
 *
 * The module exports exactly one symbol: `AddCustomMCPDialog`. Every test
 * below mounts that export in a real DOM and asserts on what a user can
 * observe - the rendered copy, the validation verdicts, the payload handed
 * to `onAddServer`, the close requests handed to `onOpenChange`, and the
 * state of the fields after a submit or a cancel - so the suite pins the
 * contract rather than the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`AddCustomMCPDialog`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component has no live dependency of its own: it reaches the world
 * only through its `onOpenChange` and `onAddServer` props, both captured
 * by recorders below. What it does need is a DOM, because its surface is a
 * Radix dialog that mounts through a portal around an interactive
 * react-hook-form form. `bun test` ships with no DOM and this project has
 * no jsdom, happy-dom or testing-library anywhere in its lockfile, so this
 * suite builds the page from `linkedom` - already in the lockfile as a
 * dependency of `wxt`, located through bun's install store - and drives it
 * with `react-dom/client`. Everything runs in-process and in-memory: no
 * network, no database, no container.
 *
 * Not pinned, and why: Radix's focus trap and scroll lock are inert in
 * this DOM (focus is a no-op and nothing scrolls), so focus order and
 * scroll-lock side effects are not asserted. That is a gap in interaction
 * coverage, not an export left unexercised: the export itself is mounted,
 * driven and asserted on, so no export belongs in the blocked list above.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Root } from 'react-dom/client'

// ---------------------------------------------------------------------------
// A DOM for the suite
//
// linkedom is a transitive dependency of wxt, so no workspace package
// re-exports it; the only stable address it has is bun's install store.
// The store is found by walking up from this file, so the suite does not
// depend on the directory it was invoked from.
// ---------------------------------------------------------------------------
const locateLinkedom = (): string => {
  let directory = import.meta.dir
  for (let depth = 0; depth < 10; depth += 1) {
    const store = resolve(directory, 'node_modules/.bun')
    try {
      const entry = readdirSync(store).find((name) =>
        name.startsWith('linkedom@'),
      )
      if (entry) return resolve(store, entry, 'node_modules', 'linkedom')
    } catch {
      // no install store at this level; keep walking up
    }
    const parent = resolve(directory, '..')
    if (parent === directory) break
    directory = parent
  }
  throw new Error('linkedom not found in the bun install store')
}

const { parseHTML } = await import(locateLinkedom())

// The parsed page and its classes become the page globals for the duration
// of this file; afterAll puts every one of them back.
const ABSENT = Symbol('absent')
const savedGlobals: Array<[string, unknown]> = []
const setGlobal = (name: string, value: unknown): void => {
  const scope = globalThis as Record<string, unknown>
  savedGlobals.push([name, name in scope ? scope[name] : ABSENT])
  scope[name] = value
}

const { document, window } = parseHTML(
  '<!doctype html><html><body></body></html>',
)
const windowScope = window as unknown as Record<string, unknown>

setGlobal('window', window)
setGlobal('document', document)
for (const className of [
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
  'InputEvent',
  'PointerEvent',
  'UIEvent',
  'WheelEvent',
  'Node',
  'NodeList',
  'NodeFilter',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'HTMLFormElement',
  'HTMLSelectElement',
  'HTMLOptionElement',
  'HTMLFieldSetElement',
  'HTMLAnchorElement',
  'SVGElement',
  'HTMLCollection',
  'DOMTokenList',
]) {
  const domClass = windowScope[className]
  if (domClass) setGlobal(className, domClass)
}
// linkedom's event constructors must win over Node's: Radix dispatches
// custom events through the global constructor, and Node's frozen event
// phase fields cannot be mutated by linkedom's dispatcher.
if (windowScope.Event) setGlobal('Event', windowScope.Event)
if (windowScope.CustomEvent) setGlobal('CustomEvent', windowScope.CustomEvent)
// linkedom exposes no NodeFilter of its own; Radix's focus scope walks the
// tree with one, so a spec-shaped constant object stands in for it.
if (!(globalThis as Record<string, unknown>).NodeFilter) {
  setGlobal('NodeFilter', {
    SHOW_ELEMENT: 1,
    SHOW_TEXT: 4,
    SHOW_ALL: -1,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
  })
}

if (!(globalThis as Record<string, unknown>).MutationObserver) {
  class MutationObserverStub {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return []
    }
  }
  setGlobal('MutationObserver', MutationObserverStub)
}
if (!(globalThis as Record<string, unknown>).requestAnimationFrame) {
  setGlobal(
    'requestAnimationFrame',
    (callback: FrameRequestCallback): number =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number,
  )
}
if (!(globalThis as Record<string, unknown>).cancelAnimationFrame) {
  setGlobal(
    'cancelAnimationFrame',
    (handle: number): void => {
      clearTimeout(handle)
    },
  )
}
if (!(globalThis as Record<string, unknown>).getComputedStyle) {
  setGlobal('getComputedStyle', () => ({
    getPropertyValue: () => '',
    removeProperty(): void {},
    setProperty(): void {},
  }))
}
if (!(globalThis as Record<string, unknown>).getSelection) {
  setGlobal('getSelection', () => ({
    rangeCount: 0,
    addRange(): void {},
    removeAllRanges(): void {},
  }))
}
if (!windowScope.getSelection) {
  windowScope.getSelection = () => ({
    rangeCount: 0,
    addRange(): void {},
    removeAllRanges(): void {},
  })
}

// Two DOM-conformance shims on the linkedom classes themselves (they touch
// only this file's throwaway document):
//
// 1. Browsers report a typeless input's `type` as 'text'; linkedom reports
//    ''. react-dom classifies inputs by that property and silently drops
//    change events for inputs it does not consider text inputs, so the
//    browser default is restored here.
{
  const inputPrototype = Object.getPrototypeOf(
    document.createElement('input'),
  ) as Record<string, unknown>
  const typeDescriptor = Object.getOwnPropertyDescriptor(
    inputPrototype,
    'type',
  )
  if (typeDescriptor?.get) {
    const originalGet = typeDescriptor.get
    Object.defineProperty(inputPrototype, 'type', {
      ...typeDescriptor,
      get(this: unknown) {
        const reported = originalGet.call(this)
        return reported === '' || reported == null ? 'text' : reported
      },
    })
  }
}
// 2. react-dom probes `"oninput" in document` while it loads to decide
//    whether dispatched `input` events can reach onChange at all; linkedom
//    has no on* handler properties, so the probe needs one declared before
//    react-dom/client is imported below.
{
  const documentPrototype = Object.getPrototypeOf(document)
  if (!('oninput' in document)) {
    Object.defineProperty(documentPrototype, 'oninput', {
      value: null,
      configurable: true,
    })
  }
}

const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { AddCustomMCPDialog } = await import('./AddCustomMCPDialog')

// ---------------------------------------------------------------------------
// Mounting and driving the dialog
// ---------------------------------------------------------------------------
type ServerConfig = {
  name: string
  url: string
  description: string
}

type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAddServer: (config: ServerConfig) => void
}

type Recording = {
  openChanges: boolean[]
  addedServers: ServerConfig[]
}

const newRecording = (): Recording => ({ openChanges: [], addedServers: [] })

const propsFrom = (recording: Recording, open: boolean): DialogProps => ({
  open,
  onOpenChange: (next: boolean) => {
    recording.openChanges.push(next)
  },
  onAddServer: (config: ServerConfig) => {
    recording.addedServers.push(config)
  },
})

const settle = (ms = 30): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms)
  })

let mountedRoot: Root | null = null
let mountedContainer: unknown = null

const mountDialog = async (open: boolean, recording: Recording) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(createElement(AddCustomMCPDialog, propsFrom(recording, open)))
  await settle()
  mountedRoot = root
  mountedContainer = container
}

afterEach(async () => {
  if (mountedRoot) {
    mountedRoot.unmount()
    await settle(10)
    mountedRoot = null
  }
  const container = mountedContainer as { parentNode: { removeChild: (node: unknown) => void } | null } | null
  if (container?.parentNode) {
    container.parentNode.removeChild(container)
  }
  mountedContainer = null
})

afterAll(() => {
  const scope = globalThis as Record<string, unknown>
  for (const [name, previous] of savedGlobals.reverse()) {
    if (previous === ABSENT) {
      delete scope[name]
    } else {
      scope[name] = previous
    }
  }
})

// Radix portals the dialog into the document body, so the assertions below
// read the whole page rather than the mount container.
const pageMarkup = (): string => document.body.innerHTML
const formElement = (): unknown => document.querySelector('form')
const nameField = (): unknown => document.querySelectorAll('input')[0]
const urlField = (): unknown => document.querySelectorAll('input')[1]
const descriptionField = (): unknown =>
  document.querySelector('textarea')
const buttonByText = (text: string): { dispatchEvent: (event: unknown) => boolean } | undefined =>
  [...document.querySelectorAll('button')].find(
    (button) => (button as unknown as { textContent: string }).textContent === text,
  ) as { dispatchEvent: (event: unknown) => boolean } | undefined

// Set the field's value through the prototype setter - the route a real
// browser takes - and let React hear it through an input event.
const typeInto = (element: unknown, value: string): void => {
  const target = element as Record<string, unknown>
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    'value',
  )
  if (descriptor?.set) {
    ;(descriptor.set as (receiver: unknown, next: string) => void).call(
      element,
      value,
    )
  } else {
    target.value = value
  }
  ;(element as { dispatchEvent: (event: unknown) => boolean }).dispatchEvent(
    new (window as unknown as { Event: new (type: string, init: { bubbles: boolean; cancelable?: boolean }) => unknown }).Event(
      'input',
      { bubbles: true },
    ),
  )
}

const fireEvent = (element: unknown, type: string): void => {
  ;(element as { dispatchEvent: (event: unknown) => boolean }).dispatchEvent(
    new (window as unknown as { Event: new (type: string, init: { bubbles: boolean; cancelable?: boolean }) => unknown }).Event(
      type,
      { bubbles: true, cancelable: true },
    ),
  )
}

const sendForm = async (): Promise<void> => {
  fireEvent(formElement(), 'submit')
  await settle(60)
}

const fieldValue = (element: unknown): string =>
  (element as { value: string }).value

const NAME = 'My MCP'
const SERVER_URL = 'https://mcp.example.com/sse'
const DESCRIPTION = 'does things'

describe('AddCustomMCPDialogTsxContract', () => {
  it('AddCustomMCPDialog renders no form surface while closed', async () => {
    await mountDialog(false, newRecording())

    expect(formElement()).toBeNull()
    expect(pageMarkup()).not.toContain('Add Custom App')
    expect(pageMarkup()).not.toContain('Add Server')
  })

  it('AddCustomMCPDialog opens with a titled three-field form', async () => {
    await mountDialog(true, newRecording())

    expect(pageMarkup()).toContain('Add Custom App')
    expect(pageMarkup()).toContain('Configure your custom app connection')
    expect(pageMarkup()).toContain('Server Name')
    expect(pageMarkup()).toContain('MCP Server URL')
    expect(pageMarkup()).toContain('(only supports HTTP)')
    expect(pageMarkup()).toContain('Description (Optional)')
    expect(pageMarkup()).toContain('How do I find the URL?')

    expect(document.querySelectorAll('input').length).toBe(2)
    expect(document.querySelectorAll('textarea').length).toBe(1)
    // The URL field asks the browser for URL input.
    expect(
      (urlField() as { getAttribute: (name: string) => string | null }).getAttribute('type'),
    ).toBe('url')

    expect(buttonByText('Cancel')).toBeDefined()
    expect(buttonByText('Add Server')).toBeDefined()
  })

  it('AddCustomMCPDialog blocks an empty submission with per-field errors', async () => {
    const recording = newRecording()
    await mountDialog(true, recording)

    await sendForm()

    expect(pageMarkup()).toContain('Server name is required')
    expect(pageMarkup()).toContain('Please enter a valid URL')
    expect(recording.addedServers).toEqual([])
    expect(recording.openChanges).toEqual([])
    // A rejected submission keeps the dialog open for corrections.
    expect(formElement()).not.toBeNull()
  })

  it('AddCustomMCPDialog blocks a malformed URL once a name is given', async () => {
    const recording = newRecording()
    await mountDialog(true, recording)

    typeInto(nameField(), NAME)
    typeInto(urlField(), 'not-a-url')
    await settle()
    await sendForm()

    expect(pageMarkup()).toContain('Please enter a valid URL')
    // The name passes, so only the URL error remains.
    expect(pageMarkup()).not.toContain('Server name is required')
    expect(recording.addedServers).toEqual([])
    expect(recording.openChanges).toEqual([])
  })

  it('AddCustomMCPDialog delivers a complete config, closes and clears the fields', async () => {
    const recording = newRecording()
    await mountDialog(true, recording)

    typeInto(nameField(), NAME)
    typeInto(urlField(), SERVER_URL)
    typeInto(descriptionField(), DESCRIPTION)
    await settle()
    await sendForm()

    expect(recording.addedServers).toEqual([
      { name: NAME, url: SERVER_URL, description: DESCRIPTION },
    ])
    expect(recording.openChanges).toEqual([false])
    expect(fieldValue(nameField())).toBe('')
    expect(fieldValue(urlField())).toBe('')
    expect(fieldValue(descriptionField())).toBe('')
  })

  it('AddCustomMCPDialog submits without a description as an empty string', async () => {
    const recording = newRecording()
    await mountDialog(true, recording)

    typeInto(nameField(), NAME)
    typeInto(urlField(), SERVER_URL)
    await settle()
    await sendForm()

    expect(recording.addedServers).toEqual([
      { name: NAME, url: SERVER_URL, description: '' },
    ])
    expect(recording.openChanges).toEqual([false])
  })

  it('AddCustomMCPDialog cancels a draft: closes, adds nothing, clears fields', async () => {
    const recording = newRecording()
    await mountDialog(true, recording)

    typeInto(nameField(), 'Draft name')
    await settle()
    fireEvent(buttonByText('Cancel'), 'click')
    await settle()

    expect(recording.openChanges).toEqual([false])
    expect(recording.addedServers).toEqual([])
    expect(fieldValue(nameField())).toBe('')
  })
})
