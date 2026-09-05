/**
 * First contract suite for StepsLayout.tsx.
 *
 * StepsLayout.tsx exports exactly one symbol - the StepsLayout component -
 * and every assertion below exercises that one export through its rendered
 * output. The component is rendered server-side (react-dom/server renderToString)
 * inside a MemoryRouter, so the suite needs no DOM, no browser, no network,
 * no database and no container.
 *
 * Two pieces of surrounding infrastructure are stubbed so the module graph
 * can load and render without a live dependency:
 *
 * - lib/rpc/getClient: on import it eagerly resolves the agent-server port,
 *   which only exists inside the running BrowserOS extension host. The mock
 *   keeps RpcClientProvider usable without that live agent server. (Steps 2
 *   and 3 consume the client through useRpcClient and suspend on the pending
 *   promise, so their bodies are not server-renderable at all; the suite pins
 *   the first, last and out-of-range steps, which cover the layout contract.)
 * - the `browser`/`chrome` globals: @wxt-dev/storage, pulled in by the step
 *   components, requires a web-extension environment at module load. An
 *   inert in-memory stub satisfies it.
 *
 * Interactions (the Continue button navigating to the next step or
 * /onboarding/demo, and the analytics effect) need a DOM event environment
 * the repository does not provide (no jsdom/happy-dom), so they are outside
 * this suite; nothing about the subject had to change to write it.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router'

type StorageAreaStub = {
  get: (keys: unknown) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
  remove: (keys: unknown) => Promise<void>
}

type BrowserStub = {
  runtime: { id: string; getManifest: () => { version: string } }
  storage: Record<'local' | 'managed' | 'session' | 'sync', StorageAreaStub>
}

const storageAreaStub = (): StorageAreaStub => ({
  get: async () => ({}),
  set: async () => {},
  remove: async () => {},
})

const browserStub: BrowserStub = {
  runtime: {
    id: 'steps-layout-test-extension',
    getManifest: () => ({ version: '0.0.0-test' }),
  },
  storage: {
    local: storageAreaStub(),
    managed: storageAreaStub(),
    session: storageAreaStub(),
    sync: storageAreaStub(),
  },
}

const globals = globalThis as unknown as Record<string, unknown>
globals.browser = browserStub
globals.chrome = browserStub

// Must run before the subject is imported: the real module kicks off a port
// lookup on load, which rejects without the live agent server.
mock.module('../../../lib/rpc/getClient', () => ({
  getClient: () => Promise.resolve({} as never),
}))

const { StepsLayout } = await import('./StepsLayout')

const renderAtRoute = (entry: string): string =>
  renderToString(
    createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/onboarding/steps/:stepId',
          element: createElement(StepsLayout),
        }),
      ),
    ),
  )

/** Step names in wizard order, as rendered by the progress header. */
const stepNames = ['About You', 'Personality', 'Connect Apps', 'Sign In']

describe('StepsLayoutTsxContract', () => {
  it('covers the exported StepsLayout component: progress header, active step choice, and Back target for the first, last, and an out-of-range step', () => {
    expect(typeof StepsLayout).toBe('function')

    const first = renderAtRoute('/onboarding/steps/1')

    // The progress header lists every step name, in wizard order.
    const positions = stepNames.map((name) => first.indexOf(name))
    for (const position of positions) {
      expect(position).toBeGreaterThanOrEqual(0)
    }
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeGreaterThan(positions[index - 1])
    }

    // Nothing is completed on the first step, so every circle still shows
    // its own step number rather than a check mark.
    expect(first).toContain('>1<')
    expect(first).toContain('>2<')
    expect(first).toContain('>3<')
    expect(first).toContain('>4<')

    // The step-1 body is the mounted active step, and no other step body is.
    expect(first).toContain('Tell us about yourself')
    expect(first).not.toContain('Sign in to BrowserOS')

    // There is no previous step, so Back exits the wizard instead of
    // targeting a step route.
    expect(first).toContain('href="/onboarding"')
    expect(first).not.toContain('/onboarding/steps/')

    const last = renderAtRoute('/onboarding/steps/4')

    // Steps 1-3 are completed: their numbers are replaced by check marks,
    // while the active step keeps its number.
    expect(last).not.toContain('>1<')
    expect(last).not.toContain('>2<')
    expect(last).not.toContain('>3<')
    expect(last).toContain('>4<')

    // The step-4 body is the mounted active step, and no other step body is.
    expect(last).toContain('Sign in to BrowserOS')
    expect(last).not.toContain('Tell us about yourself')

    // From a later step, Back targets the previous step.
    expect(last).toContain('href="/onboarding/steps/3"')

    const outOfRange = renderAtRoute('/onboarding/steps/9')

    // An unknown step id still renders the shell with the full progress
    // header (every step shown as completed), no step body, and a Back
    // target derived from the step id.
    const outOfRangePositions = stepNames.map((name) =>
      outOfRange.indexOf(name),
    )
    for (const position of outOfRangePositions) {
      expect(position).toBeGreaterThanOrEqual(0)
    }
    expect(outOfRange).not.toContain('>1<')
    expect(outOfRange).not.toContain('Tell us about yourself')
    expect(outOfRange).not.toContain('Sign in to BrowserOS')
    expect(outOfRange).toContain('href="/onboarding/steps/8"')
  })
})
