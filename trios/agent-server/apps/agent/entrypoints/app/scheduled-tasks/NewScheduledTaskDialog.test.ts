/**
 * Contract suite for NewScheduledTaskDialog.tsx.
 *
 * The module exports one symbol, `NewScheduledTaskDialog`: the dialog used to
 * create and edit scheduled tasks. This suite pins the behaviour that exists
 * today, observed purely from the rendered output and the props the component
 * calls back:
 *
 * - it renders nothing while closed;
 * - create mode shows the create copy, create defaults (daily at 09:00,
 *   enabled) and a disabled "Rewrite with AI" until a prompt is typed;
 * - submitting an empty form is blocked by validation and saves nothing;
 * - a valid create passes trimmed values to onSave and closes the dialog;
 * - edit mode pre-fills from initialValues, swaps the time field for an
 *   interval field when the schedule is not daily, and maps both schedule
 *   shapes back onto the save payload;
 * - the cancel button closes without saving;
 * - with providers in storage and none selected, the AI provider section
 *   falls back to the first stored provider.
 *
 * Environment: this app ships no jsdom/happy-dom, so the DOM here is
 * linkedom — a transitive dependency of wxt (a direct devDependency of this
 * app; both pinned by bun.lock), resolved through wxt's package so nothing
 * new is installed. No network, database or container is touched:
 *
 * - `@/lib/llm-providers/storage` (wxt extension storage) is stubbed,
 * - `@/lib/metrics/track` (chrome.runtime/posthog) is stubbed,
 * - `@/lib/llm-providers/providerIcons` (imports an SVG asset) is stubbed,
 * - `@/lib/schedules/refine-prompt` (calls the agent server) is stubbed.
 *
 * No other test file in this suite imports those four modules, and bun 1.3
 * cannot undo `mock.module`, so the stubs stay for the rest of the process
 * (same pattern as apps/server/tests/api/routes/queen-lease.test.ts).
 */

import { afterAll, describe, expect, it, mock } from 'bun:test'
import type { LlmProviderConfig } from '../../../lib/llm-providers/types'
import type { ScheduledJob } from '../../../lib/schedules/scheduleTypes'

// --- DOM bootstrap ---------------------------------------------------------

let linkedomUrl: string
try {
  linkedomUrl = import.meta.resolve('linkedom')
} catch {
  // linkedom is not a direct dependency of this workspace; reach it through
  // wxt, whose package.json pins it for the whole closure.
  const wxtEntry = new URL(import.meta.resolve('wxt'))
  linkedomUrl = new URL('../../linkedom/esm/index.js', wxtEntry).href
}

interface LinkedomWindow {
  document: LinkedomDocument
  Event: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => unknown
  HTMLInputElement: { prototype: Record<string, unknown> }
  HTMLTextAreaElement: { prototype: Record<string, unknown> }
}

interface LinkedomNode {
  textContent: string | null
  value: string
  disabled: boolean
  dispatchEvent(event: unknown): boolean
  getAttribute(name: string): string | null
  appendChild(node: LinkedomNode): LinkedomNode
}

interface LinkedomDocument {
  body: LinkedomNode & {
    querySelector(selector: string): LinkedomNode | null
  }
  createElement(tag: string): LinkedomNode & { querySelector(selector: string): LinkedomNode | null }
  createDocumentFragment(): LinkedomNode & { constructor: new (ownerDocument: unknown) => LinkedomNode }
  querySelector(selector: string): LinkedomNode | null
}

interface LinkedomModule {
  parseHTML(html: string): LinkedomWindow
  NodeFilter: unknown
}

const linkedom = (await import(linkedomUrl)) as unknown as LinkedomModule
const win = linkedom.parseHTML('<!doctype html><html><body></body></html>')

const g = globalThis as unknown as Record<string, unknown>
const globalBackups = new Map<string, { existed: boolean; value: unknown }>()
function setGlobal(key: string, value: unknown): void {
  if (!globalBackups.has(key)) {
    globalBackups.set(key, { existed: key in g, value: g[key] })
  }
  g[key] = value
}

setGlobal('window', win)
setGlobal('global', win)
setGlobal('document', win.document)
// The linkedom window is a Proxy that resolves many globals on access
// (MutationObserver, DOMParser, ...). Bun also ships its own Event/CustomEvent
// globals whose readonly internals are incompatible with linkedom's event
// dispatcher, so the DOM family must be replaced, not merely filled in.
for (const key of [
  'Event',
  'CustomEvent',
  'InputEvent',
  'KeyboardEvent',
  'Node',
  'NodeList',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'HTMLFormElement',
  'MutationObserver',
  'DocumentFragment',
]) {
  const value = (win as unknown as Record<string, unknown>)[key]
  if (value !== undefined) setGlobal(key, value)
}
for (const key of ['DOMParser', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  const value = (win as unknown as Record<string, unknown>)[key]
  if (value !== undefined && !(key in g)) setGlobal(key, value)
}
// linkedom's html-classes facade refuses `new DocumentFragment()`; the real
// class takes the owner document as a constructor argument (Radix portals
// closed SelectContent into such a fragment), so hand out a subclass that
// supplies it.
const RealDocumentFragment = win.document.createDocumentFragment()
  .constructor as new (ownerDocument: unknown) => LinkedomNode
class PortaledDocumentFragment extends RealDocumentFragment {
  constructor() {
    super(win.document)
  }
}
setGlobal('DocumentFragment', PortaledDocumentFragment)
setGlobal('NodeFilter', linkedom.NodeFilter)

// linkedom has no layout engine: computed styles report "no padding, no
// animation" — exactly what Radix's scroll-lock and presence helpers need to
// conclude "nothing to animate, nothing to compensate".
const computedStyleStub = () =>
  new Proxy(
    {},
    {
      get:
        (_target, prop) =>
          prop === 'getPropertyValue'
            ? () => ''
            : '',
    },
  ) as unknown as CSSStyleDeclaration
;(win as unknown as Record<string, unknown>).getComputedStyle = computedStyleStub
setGlobal('getComputedStyle', computedStyleStub)

// Radix Checkbox (and React's controlled-input tracking) look up the native
// value/checked accessors on HTMLInputElement.prototype /
// HTMLTextAreaElement.prototype; linkedom keeps these as instance state, so
// surface them on the prototypes.
function mirrorProperty(
  proto: Record<string, unknown>,
  key: string,
  symbol: symbol,
): void {
  if (Object.getOwnPropertyDescriptor(proto, key)) return
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      return (this as unknown as Record<symbol, unknown>)[symbol] ?? ''
    },
    set(next: unknown) {
      ;(this as unknown as Record<symbol, unknown>)[symbol] = next
    },
  })
}
const inputValue = Symbol('inputValue')
const inputChecked = Symbol('inputChecked')
mirrorProperty(win.HTMLInputElement.prototype, 'value', inputValue)
mirrorProperty(win.HTMLInputElement.prototype, 'checked', inputChecked)
mirrorProperty(win.HTMLTextAreaElement.prototype, 'value', inputValue)

// linkedom has no layout engine, so nothing can ever resize.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
setGlobal('ResizeObserver', ResizeObserverStub)

// React probes `document` for an "oninput" property (at react-dom load time)
// to decide whether the platform delivers input events. linkedom has no
// event-handler properties, so React would fall back to an IE-era
// property-change polyfill and never fire onChange; declaring the property
// keeps React on the modern path.
Object.defineProperty(win.document, 'oninput', {
  value: null,
  writable: true,
  configurable: true,
})

// --- React + subject bootstrap --------------------------------------------

const React = await import('react')
const { createRoot } = await import('react-dom/client')
setGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const storedProviders: LlmProviderConfig[] = []
const storedDefaultProviderId = { value: '' }

mock.module('../../../lib/metrics/track', () => ({ track: () => undefined }))
mock.module('../../../lib/llm-providers/storage', () => ({
  providersStorage: { getValue: async () => storedProviders },
  defaultProviderIdStorage: {
    getValue: async () => storedDefaultProviderId.value,
  },
}))
mock.module('../../../lib/llm-providers/providerIcons', () => ({
  BrowserOSIcon: () => null,
  ProviderIcon: () => null,
}))
mock.module('../../../lib/schedules/refine-prompt', () => ({
  refinePrompt: async () => '',
}))

const { NewScheduledTaskDialog } = await import('./NewScheduledTaskDialog')

// --- helpers ---------------------------------------------------------------

type SavePayload = Omit<ScheduledJob, 'id' | 'createdAt' | 'updatedAt'>

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialValues?: ScheduledJob | null
  onSave: (data: SavePayload) => void
}

const saves: SavePayload[] = []
const openChanges: boolean[] = []
const onSave = (data: SavePayload): void => {
  saves.push(data)
}
const onOpenChange = (open: boolean): void => {
  openChanges.push(open)
}

type Root = { unmount(): void; render(node: unknown): void }
let activeRoot: Root | null = null

async function mountDialog(props: DialogProps): Promise<void> {
  if (activeRoot) {
    const previous = activeRoot
    await React.act(async () => {
      previous.unmount()
    })
    activeRoot = null
  }
  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  const root = createRoot(container as never) as unknown as Root
  activeRoot = root
  await React.act(async () => {
    root.render(React.createElement(NewScheduledTaskDialog, props))
  })
}

function requireElement(selector: string): LinkedomNode {
  const found = win.document.querySelector(selector)
  if (!found) throw new Error(`no element matches ${selector}`)
  return found
}

function textButton(label: string): LinkedomNode {
  const buttons = win.document.body.querySelectorAll('button')
  for (const button of Array.from(buttons)) {
    if ((button.textContent ?? '').trim() === label) return button
  }
  throw new Error(`no button labelled "${label}"`)
}

function sendFormEvent(element: LinkedomNode, type: string): void {
  element.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }))
}

// Write text through the prototype's native-style value setter rather than a
// plain property assignment: React tracks the value with an own property on
// the node, and an assignment through that tracker makes the following
// "input" event look like a no-change (React then skips onChange). Calling
// the prototype accessor directly leaves the tracker stale, exactly like a
// real keystroke would.
function typeInto(element: LinkedomNode, text: string): void {
  const prototype = Object.getPrototypeOf(element) as Record<string, unknown>
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value') as
    | { set: (next: string) => void }
    | undefined
  if (!descriptor?.set) throw new Error('element exposes no native value setter')
  descriptor.set.call(element, text)
  element.dispatchEvent(new win.Event('input', { bubbles: true }))
}

function bodyText(): string {
  return win.document.body.textContent ?? ''
}

const job: ScheduledJob = {
  id: 'job-1',
  name: 'Morning Briefing',
  query: 'Check my email and summarize important messages',
  scheduleType: 'hourly',
  scheduleInterval: 3,
  enabled: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
}

// --- the suite -------------------------------------------------------------

describe('NewScheduledTaskDialogTsxContract', () => {
  afterAll(() => {
    for (const [key, backup] of globalBackups) {
      if (backup.existed) g[key] = backup.value
      else delete g[key]
    }
  })

  it('NewScheduledTaskDialog: closed renders nothing; create/edit modes render, validate and save the scheduled-task contract', async () => {
    // Closed: nothing renders and no callback fires.
    await mountDialog({ open: false, onOpenChange, onSave, initialValues: null })
    expect(win.document.querySelector('[role="dialog"]')).toBeNull()
    expect(saves.length).toBe(0)
    expect(openChanges.length).toBe(0)

    // Create mode: copy, defaults and disabled rewrite button.
    await mountDialog({ open: true, onOpenChange, onSave, initialValues: null })
    expect(requireElement('[data-slot="dialog-title"]').textContent).toBe(
      'Create Scheduled Task',
    )
    expect(bodyText()).toContain(
      'Create a new task that runs automatically on a schedule.',
    )
    expect(requireElement('input[name="name"]').value).toBe('')
    expect(requireElement('input[type="time"]').value).toBe('09:00')
    expect(requireElement('button[role="checkbox"]').getAttribute('data-state')).toBe('checked')
    expect(textButton('Rewrite with AI').disabled).toBe(true)
    expect(textButton('Create')).toBeTruthy()
    expect(textButton('Cancel')).toBeTruthy()

    // Typing a prompt is what enables "Rewrite with AI".
    await React.act(async () => {
      typeInto(requireElement('textarea[name="query"]'), 'Check my email')
    })
    expect(textButton('Rewrite with AI').disabled).toBe(false)

    // Empty fields are rejected before onSave: both messages, no save, no close.
    await React.act(async () => {
      typeInto(requireElement('textarea[name="query"]'), '')
    })
    await React.act(async () => {
      sendFormEvent(requireElement('form'), 'submit')
    })
    expect(bodyText()).toContain('Name is required')
    expect(bodyText()).toContain('Prompt is required')
    expect(saves.length).toBe(0)
    expect(openChanges.length).toBe(0)

    // A valid create trims the text, keeps the daily time, drops the
    // interval, saves once and asks to close.
    await React.act(async () => {
      typeInto(requireElement('input[name="name"]'), '  Morning Briefing  ')
      typeInto(requireElement('textarea[name="query"]'), '  Summarize my email  ')
    })
    await React.act(async () => {
      sendFormEvent(requireElement('form'), 'submit')
    })
    expect(saves.length).toBe(1)
    expect(saves[0]).toEqual({
      name: 'Morning Briefing',
      query: 'Summarize my email',
      scheduleType: 'daily',
      scheduleTime: '09:00',
      scheduleInterval: undefined,
      providerId: undefined,
      enabled: true,
    })
    expect(openChanges).toEqual([false])

    // Edit mode: prefilled from initialValues, interval field instead of the
    // time field, update copy, and the edited values saved back.
    await mountDialog({ open: true, onOpenChange, onSave, initialValues: job })
    expect(requireElement('[data-slot="dialog-title"]').textContent).toBe(
      'Edit Scheduled Task',
    )
    expect(bodyText()).toContain('Update your scheduled task configuration.')
    expect(requireElement('input[name="name"]').value).toBe('Morning Briefing')
    expect(requireElement('textarea[name="query"]').value).toBe(job.query)
    expect(win.document.querySelector('input[type="time"]')).toBeNull()
    expect(requireElement('input[type="number"]').value).toBe('3')
    expect(requireElement('button[role="checkbox"]').getAttribute('data-state')).toBe('unchecked')
    expect(textButton('Update')).toBeTruthy()
    await React.act(async () => {
      typeInto(requireElement('input[name="name"]'), '  Renamed Briefing  ')
    })
    await React.act(async () => {
      sendFormEvent(requireElement('form'), 'submit')
    })
    expect(saves.length).toBe(2)
    expect(saves[1]).toEqual({
      name: 'Renamed Briefing',
      query: job.query,
      scheduleType: 'hourly',
      scheduleTime: undefined,
      scheduleInterval: 3,
      enabled: false,
    })
    expect(openChanges).toEqual([false, false])

    // Cancel closes without saving.
    await mountDialog({ open: true, onOpenChange, onSave, initialValues: null })
    await React.act(async () => {
      textButton('Cancel').dispatchEvent(
        new win.Event('click', { bubbles: true, cancelable: true }),
      )
    })
    expect(openChanges).toEqual([false, false, false])
    expect(saves.length).toBe(2)

    // With providers in storage and none selected, the provider section
    // falls back to the first stored provider.
    storedProviders.push(
      {
        id: 'prov-first',
        type: 'openai',
        name: 'First Provider',
        modelId: 'gpt-test',
        supportsImages: false,
        contextWindow: 128000,
        temperature: 0.7,
        createdAt: 0,
      },
      {
        id: 'prov-second',
        type: 'anthropic',
        name: 'Second Provider',
        modelId: 'claude-test',
        supportsImages: false,
        contextWindow: 200000,
        temperature: 0.7,
        createdAt: 0,
      },
    )
    await mountDialog({ open: true, onOpenChange, onSave, initialValues: null })
    expect(bodyText()).toContain('AI Provider')
    expect(bodyText()).toContain('First Provider')

    if (activeRoot) {
      const last = activeRoot
      await React.act(async () => {
        last.unmount()
      })
      activeRoot = null
    }
  })
})
