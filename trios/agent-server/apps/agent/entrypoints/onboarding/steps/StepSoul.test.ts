/**
 * The first suite for StepSoul.tsx (gHashTag/trios#1655): the step's existing
 * behaviour, pinned as it stands, so the next change to this file has
 * something to fail against. The subject is not modified.
 *
 * The subject lives inside the extension UI: it needs a browser DOM, an RPC
 * client bound to a live agent server, the extension-only metrics adapter
 * (chrome.runtime), and a frame-loop animation library. None of that exists
 * under `bun test`, and no live dependency may be required, so the suite
 * brings its own:
 *
 * - DOM: linkedom, already materialised in this checkout's lockfile store
 *   (pulled in by wxt, the extension framework this app builds with). It
 *   provides the element tree, attributes, and bubbling event dispatch that
 *   react-dom's root-level delegation needs, so clicks below are dispatched
 *   DOM events and state changes are observed as re-renders. linkedom is not
 *   a direct dependency of any workspace, so it cannot be imported by name;
 *   the path into the store is pinned by bun.lock (wxt -> linkedom@0.18.12).
 * - Seams (mock.module, registered before the subject loads): useRpcClient,
 *   track, sentry, and StepTransition. The first three reach for a live
 *   server or extension globals at import or call time; the fourth drives a
 *   motion/react animation that needs a real browser frame loop, and is
 *   replaced by a wrapper that only surfaces the direction it was handed.
 *   Assertions target what crosses each seam and what lands in the DOM,
 *   never the wiring inside the subject.
 *
 * P2, exports that could not be pinned: the module exports exactly one
 * symbol, StepSoul, and all of its behaviour is exercised below through the
 * seams. No export is blocked by a live dependency; nothing is omitted.
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
import { act, createElement as h, type ReactNode } from 'react'
import type { StepDirection } from './StepTransition'

const LINKEDOM =
  '../../../../../node_modules/.bun/linkedom@0.18.12/node_modules/linkedom'

// The structural slice of the DOM this suite reads or drives. linkedom is
// fully typed, but react-dom's own Element type does not accept it, so the
// harness talks to its own narrow shape and casts only at the render call.
interface DomElement {
  className: string
  textContent: string
  dispatchEvent(event: unknown): boolean
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  querySelector(selector: string): DomElement | null
  querySelectorAll(selector: string): ArrayLike<DomElement>
  remove(): void
}

interface DomDocument {
  body: { appendChild(element: DomElement): unknown }
  createElement(tag: string): DomElement
  querySelector(selector: string): DomElement | null
  defaultView: unknown
}

interface DomWindow {
  Event: new (type: string, init?: { bubbles?: boolean }) => unknown
}

const { parseHTML } = await import(LINKEDOM)
const domDocument = parseHTML('<!doctype html><html><body></body></html>')
  .document as unknown as DomDocument
const domWindow = domDocument.defaultView as unknown as DomWindow

// The DOM globals are installed for this file only, and put back afterwards:
// bun test keeps mocks and globals across files within one run.
const globalScope = globalThis as unknown as Record<string, unknown>
const savedGlobals = {
  document: globalScope.document,
  window: globalScope.window,
}
globalScope.document = domDocument
globalScope.window = domWindow
globalScope.IS_REACT_ACT_ENVIRONMENT = true

afterAll(() => {
  globalScope.document = savedGlobals.document
  globalScope.window = savedGlobals.window
  globalScope.IS_REACT_ACT_ENVIRONMENT = false
})

const { createRoot } = await import('react-dom/client')

// ---- seams -----------------------------------------------------------------

type PutCall = { json: { content: string } }

let putImpl: (call: PutCall) => Promise<unknown>
const putCalls: PutCall[] = []
const trackCalls: Array<[string, Record<string, unknown> | undefined]> = []
const sentryCaptures: Array<{ error: unknown; options: unknown }> = []

mock.module('@/lib/rpc/RpcClientProvider', () => ({
  useRpcClient: () => ({
    soul: {
      $put: (call: PutCall) => {
        putCalls.push(call)
        return putImpl(call)
      },
    },
  }),
}))

mock.module('@/lib/metrics/track', () => ({
  track: (eventName: string, properties?: Record<string, unknown>) => {
    trackCalls.push([eventName, properties])
  },
}))

mock.module('@/lib/sentry/sentry', () => ({
  sentry: {
    captureException: (error: unknown, options: unknown) => {
      sentryCaptures.push({ error, options })
    },
  },
}))

mock.module('./StepTransition', () => ({
  StepTransition: ({
    children,
    direction,
  }: {
    children: ReactNode
    direction: StepDirection
  }) => h('div', { 'data-direction': String(direction) }, children),
}))

// The subject is imported only after every seam above is in place: its
// dependency chain touches extension globals while loading.
const { StepSoul } = await import('./StepSoul')
const { soulPresets } = await import('@/lib/onboarding/soulPresets')

// ---- harness ----------------------------------------------------------------

const PRESETS = [
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Helpful, clear, and adapts to context',
  },
  {
    id: 'professional',
    name: 'Professional',
    description: 'Formal, precise, and structured',
  },
  {
    id: 'friendly',
    name: 'Friendly',
    description: 'Warm, casual, and conversational',
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Terse, no-nonsense, action-first',
  },
] as const

const SELECTED_CLASSES =
  'border-[var(--accent-orange)] bg-[var(--accent-orange)]/5'
const RESTING_CLASSES =
  'border-border bg-card hover:border-[var(--accent-orange)]/50'

let container: DomElement
let root: ReturnType<typeof createRoot>
let continues = 0

function fireClick(element: DomElement): void {
  element.dispatchEvent(new domWindow.Event('click', { bubbles: true }))
}

function renderStep(direction: StepDirection = 1): void {
  container = domDocument.createElement('div')
  domDocument.body.appendChild(container)
  root = createRoot(container as unknown as Parameters<typeof createRoot>[0])
  act(() => {
    root.render(
      h(StepSoul, {
        direction,
        onContinue: () => {
          continues += 1
        },
      }),
    )
  })
}

function allButtons(): DomElement[] {
  return Array.from(container.querySelectorAll('button'))
}

// The ui Button marks itself with data-slot="button"; the preset cards are
// plain <button> elements, so this stays stable while the label is swapped
// for the spinner during a save.
function continueButton(): DomElement {
  return container.querySelector('button[data-slot="button"]') as DomElement
}

function presetCard(name: string): DomElement {
  const card = allButtons().find(
    (b) => !b.hasAttribute('data-slot') && b.textContent.includes(name),
  )
  return card as DomElement
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  putCalls.length = 0
  trackCalls.length = 0
  sentryCaptures.length = 0
  continues = 0
  putImpl = async () => ({})
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

// ---- the contract ------------------------------------------------------------

describe('StepSoulTsxContract', () => {
  it('renders the four soul presets with Balanced selected by default, plus an enabled Continue action', () => {
    renderStep()

    const heading = domDocument.querySelector('h2') as DomElement
    expect(heading.textContent).toBe("Choose your agent's personality")
    const subtitle = domDocument.querySelector('p') as DomElement
    expect(subtitle.textContent).toBe(
      'This sets the starting tone — you can always evolve it later',
    )

    for (const preset of PRESETS) {
      const card = presetCard(preset.name)
      expect(card).toBeTruthy()
      expect(card.textContent).toContain(preset.name)
      expect(card.textContent).toContain(preset.description)
    }

    expect(presetCard('Balanced').className).toContain(SELECTED_CLASSES)
    expect(presetCard('Professional').className).toContain(RESTING_CLASSES)
    expect(presetCard('Friendly').className).toContain(RESTING_CLASSES)
    expect(presetCard('Minimal').className).toContain(RESTING_CLASSES)

    const button = continueButton()
    expect(button.textContent).toBe('Continue')
    expect(button.hasAttribute('disabled')).toBe(false)
    const wrapper = container.querySelector('[data-direction]') as DomElement
    expect(wrapper.getAttribute('data-direction')).toBe('1')
  })

  it('carries the travel direction it is given into its transition wrapper', () => {
    renderStep(-1)
    const wrapper = container.querySelector('[data-direction]') as DomElement
    expect(wrapper.getAttribute('data-direction')).toBe('-1')
  })

  it('moves the highlight to the preset card the user clicks', () => {
    renderStep()

    act(() => {
      fireClick(presetCard('Friendly'))
    })

    expect(presetCard('Friendly').className).toContain(SELECTED_CLASSES)
    expect(presetCard('Balanced').className).toContain(RESTING_CLASSES)
    expect(continueButton().hasAttribute('disabled')).toBe(false)
  })

  it('locks Continue while the write is in flight, then persists the preset, reports both analytics events, and advances', async () => {
    let release!: () => void
    putImpl = () =>
      new Promise((resolve) => {
        release = resolve
      })

    renderStep()
    await act(async () => {
      fireClick(continueButton())
    })

    // In flight: the write has started, the action is locked and shows a
    // spinner instead of its label, and nothing has advanced yet.
    expect(putCalls.length).toBe(1)
    const inFlight = continueButton()
    expect(inFlight.hasAttribute('disabled')).toBe(true)
    expect(inFlight.textContent).not.toBe('Continue')
    expect(trackCalls.length).toBe(0)
    expect(continues).toBe(0)

    await act(async () => {
      release()
      await drainMicrotasks()
    })

    const balanced = soulPresets.find((p) => p.id === 'balanced')
    expect(putCalls[0].json.content).toBe(balanced?.content)
    expect(putCalls[0].json.content.startsWith('# SOUL.md')).toBe(true)
    expect(trackCalls).toEqual([
      ['onboarding.soul.selected', { preset: 'balanced' }],
      ['onboarding.step.completed', { step: 2, step_name: 'soul' }],
    ])
    expect(continues).toBe(1)

    const settled = continueButton()
    expect(settled.hasAttribute('disabled')).toBe(false)
    expect(settled.textContent).toBe('Continue')
  })

  it('sends the content of whichever preset the user picked, not the default', async () => {
    renderStep()

    act(() => {
      fireClick(presetCard('Professional'))
    })
    await act(async () => {
      fireClick(continueButton())
      await drainMicrotasks()
    })

    const professional = soulPresets.find((p) => p.id === 'professional')
    expect(putCalls.length).toBe(1)
    expect(putCalls[0].json.content).toBe(professional?.content)
    expect(trackCalls).toEqual([
      ['onboarding.soul.selected', { preset: 'professional' }],
      ['onboarding.step.completed', { step: 2, step_name: 'soul' }],
    ])
    expect(continues).toBe(1)
  })

  it('reports a failed write to Sentry and still completes the step', async () => {
    const failure = new Error('the soul vault is closed')
    putImpl = () => Promise.reject(failure)

    renderStep()
    await act(async () => {
      fireClick(continueButton())
      await drainMicrotasks()
    })

    expect(sentryCaptures.length).toBe(1)
    expect(sentryCaptures[0].error).toBe(failure)
    const reported = sentryCaptures[0].options as {
      extra: { message: string }
    }
    expect(reported.extra).toEqual({
      message: 'Failed to write soul during onboarding',
    })
    expect(trackCalls).toEqual([
      ['onboarding.soul.selected', { preset: 'balanced' }],
      ['onboarding.step.completed', { step: 2, step_name: 'soul' }],
    ])
    expect(continues).toBe(1)
    expect(continueButton().hasAttribute('disabled')).toBe(false)
  })
})
