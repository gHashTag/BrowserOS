/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { describe, expect, it } from 'bun:test'
import type { Page } from 'puppeteer-core'

import { WaitForHelper } from '../../src/lib/wait-for-helper'

/*
 * Export accounting for this module.
 *
 *   WaitForHelper  exercised below. The constructor and all four public
 *                 methods are driven against a fake CDP page: quiet-DOM
 *                 settling, mutation restarts, the stability cutoff, the
 *                 navigation grace window and its event classification, the
 *                 plain timer, and every branch of the action wrapper.
 *
 * No export is listed as dependency-blocked. The only live dependency the
 * module has is a real browser page; the fake page below stands in for it,
 * so there is nothing on the blocked list. Exercised (1) + blocked (0)
 * equals the 1 export this module ships.
 *
 * HOW THE FAKE PAGE WORKS. The helper talks to its page through three
 * surfaces: evaluateHandle (to install a page-side DOM observer),
 * _client() (to hear CDP navigation events), and waitForNavigation (to
 * wait out a cross-document navigation). The fake implements all three
 * and records what happened, so every assertion below is about what the
 * helper does to a page - never about how the helper is built.
 *
 * Page-side timers are captured rather than run: the DOM-stability window
 * only elapses when this suite says the page has gone quiet, which keeps
 * the timing assertions deterministic. Host-side timers (the grace window,
 * the stability cutoff, the plain timeout) run for real.
 */

/** One scheduled page-side timer. Cancelled or already-run timers are inert. */
type FakeTimer = {
  ran: boolean
  cancelled: boolean
  fire: () => void
}

/** The page-side MutationObserver the helper installs. */
class FakeMutationObserver {
  disconnected = false
  observedOn: unknown = null

  constructor(readonly callback: () => void) {}

  observe(target: unknown): void {
    this.observedOn = target
  }

  disconnect(): void {
    this.disconnected = true
  }
}

/**
 * The "inside the page" environment: a document with a body, a
 * MutationObserver, and timers that this suite fires by hand.
 */
class FakeInPageWorld {
  readonly document = { body: { tag: 'fake-body' } }
  readonly observers: FakeMutationObserver[] = []
  readonly timers: FakeTimer[] = []
  readonly MutationObserver: new (
    callback: () => void,
  ) => FakeMutationObserver

  constructor() {
    const world = this
    class WorldMutationObserver extends FakeMutationObserver {
      constructor(callback: () => void) {
        super(callback)
        world.observers.push(this)
      }
    }
    this.MutationObserver = WorldMutationObserver
  }

  /**
   * Installs the world's globals, so page code that the helper injects sees
   * the fake document, observer and timers. Returns the restore function.
   */
  install(): () => void {
    const globals = globalThis as unknown as Record<string, unknown>
    const saved = {
      document: globals.document,
      MutationObserver: globals.MutationObserver,
      setTimeout: globals.setTimeout,
      clearTimeout: globals.clearTimeout,
    }
    globals.document = this.document
    globals.MutationObserver = this.MutationObserver
    globals.setTimeout = ((callback: () => void) => {
      const timer: FakeTimer = {
        ran: false,
        cancelled: false,
        fire: () => {
          if (timer.cancelled || timer.ran) return
          timer.ran = true
          this.run(callback)
        },
      }
      this.timers.push(timer)
      return timer
    }) as typeof setTimeout
    globals.clearTimeout = ((id: unknown) => {
      const timer = this.timers.find((candidate) => candidate === id)
      if (timer) timer.cancelled = true
    }) as typeof clearTimeout
    return () => {
      Object.assign(globals, saved)
    }
  }

  /** Runs a piece of page code with the world's globals in place. */
  run(pageCode: () => void): void {
    const restore = this.install()
    try {
      pageCode()
    } finally {
      restore()
    }
  }

  /** Timers that are neither cancelled nor fired yet. */
  pendingTimers(): FakeTimer[] {
    return this.timers.filter((timer) => !timer.cancelled && !timer.ran)
  }
}

/** The CDP session underneath the page, reduced to on/off/dispatch. */
class FakeCdpClient {
  #listeners = new Map<string, Array<(event: unknown) => void>>()

  on(event: string, listener: (event: unknown) => void): void {
    const existing = this.#listeners.get(event) ?? []
    existing.push(listener)
    this.#listeners.set(event, existing)
  }

  off(event: string, listener: (event: unknown) => void): void {
    const existing = this.#listeners.get(event) ?? []
    this.#listeners.set(
      event,
      existing.filter((candidate) => candidate !== listener),
    )
  }

  dispatch(event: string, payload: unknown): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      listener(payload)
    }
  }
}

/** The handle evaluateHandle hands back: evaluate and dispose. */
class FakeHandle {
  disposed = false

  constructor(readonly value: unknown) {}

  async evaluate(fn: (value: unknown) => unknown): Promise<unknown> {
    return fn(this.value)
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

type NavigationWaiter = (options: {
  timeout: number
  signal: AbortSignal
}) => Promise<void>

/**
 * A stand-in for the Puppeteer page: records every interaction in the
 * order it happened, so sequencing can be asserted.
 */
class FakePage {
  readonly world = new FakeInPageWorld()
  readonly client = new FakeCdpClient()
  readonly handles: FakeHandle[] = []
  /** Page interactions in the order they happened. */
  readonly trace: string[] = []
  /** What waitForNavigation does; each scenario wires its own outcome. */
  navigationWaiter: NavigationWaiter = () => new Promise(() => {})

  asPage(): Page {
    return this as unknown as Page
  }

  async evaluateHandle(
    pageFunction: (arg: unknown) => unknown,
    arg: unknown,
  ): Promise<FakeHandle> {
    this.trace.push('stable-dom-observation-begins')
    const world = this.world
    let value: unknown
    const restore = world.install()
    try {
      value = pageFunction(arg)
    } finally {
      restore()
    }
    const handle = new FakeHandle(value)
    this.handles.push(handle)
    return handle
  }

  waitForNavigation(options: {
    timeout: number
    signal: AbortSignal
  }): Promise<void> {
    this.trace.push('waits-for-navigation-to-finish')
    return this.navigationWaiter(options)
  }

  _client(): FakeCdpClient {
    return this.client
  }
}

/** Watches a promise and remembers whether it has settled, by any route. */
function tracker(promise: Promise<unknown>): { finished: boolean } {
  const state = { finished: false }
  void promise.then(
    () => {
      state.finished = true
    },
    () => {
      state.finished = true
    },
  )
  return state
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** Polls until the condition holds, failing the scenario if it never does. */
async function until(
  condition: () => boolean,
  label: string,
  budgetMs = 300,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`)
    }
    await pause(5)
  }
}

/** The page-side observer the helper installed, or the scenario fails. */
function theObserver(world: FakeInPageWorld): FakeMutationObserver {
  const observer = world.observers[0]
  if (observer === undefined) {
    throw new Error('no page-side observer was installed')
  }
  return observer
}

/** The most recent pending page-side timer, or the scenario fails. */
function latestPendingTimer(world: FakeInPageWorld): FakeTimer {
  const timer = world.pendingTimers().at(-1)
  if (timer === undefined) {
    throw new Error('no pending page-side timer')
  }
  return timer
}

/** Fails the scenario unless the promise settles (either way) in time. */
async function settledWithin<T>(
  promise: Promise<T>,
  budgetMs: number,
): Promise<T> {
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    pause(budgetMs).then(() => null),
  ])
  if (outcome === null) {
    throw new Error(`promise did not settle within ${budgetMs}ms`)
  }
  if (!outcome.ok) {
    throw outcome.error
  }
  return outcome.value
}

describe('waitForHelperContract', () => {
  it('WaitForHelper - the observable contract, held against the module as it stands', async () => {
    // ------------------------------------------------------------------
    // timeout(): resolves on its own once the requested delay has passed.
    {
      const page = new FakePage()
      const helper = new WaitForHelper(page.asPage(), 0.5, 0.5)
      const before = Date.now()
      const value = await settledWithin(helper.timeout(25), 2000)
      expect(value).toBeUndefined()
      expect(Date.now() - before).toBeGreaterThanOrEqual(24)
    }

    // ------------------------------------------------------------------
    // An action on a quiet page: the action runs, the grace window passes
    // with no navigation, the DOM observation starts only after the action,
    // the page goes quiet, and the whole sequence settles.
    {
      const page = new FakePage()
      const helper = new WaitForHelper(page.asPage(), 0.5, 0.5)
      let actions = 0
      const done = helper.waitForEventsAfterAction(async () => {
        actions += 1
        page.trace.push('action-ran')
      })
      const progress = tracker(done)
      await until(
        () => page.world.pendingTimers().length > 0,
        'the stability window on a quiet page',
      )
      expect(actions).toBe(1)
      expect(page.trace.indexOf('action-ran')).toBeLessThan(
        page.trace.indexOf('stable-dom-observation-begins'),
      )
      expect(progress.finished).toBe(false)
      latestPendingTimer(page.world).fire()
      await settledWithin(done, 2000)
      // Settling detaches the page-side observer and, once the helper
      // finishes, disposes the handle it was reached through.
      expect(theObserver(page.world).disconnected).toBe(true)
      await until(
        () => page.handles.every((handle) => handle.disposed),
        'observer handle disposal',
      )
    }

    // ------------------------------------------------------------------
    // A mutation restarts the stability clock: the window that was open
    // before the mutation is dead, and only the post-mutation window can
    // settle the sequence.
    {
      const page = new FakePage()
      const helper = new WaitForHelper(page.asPage(), 0.5, 0.5)
      const done = helper.waitForEventsAfterAction(async () => {
        page.trace.push('action-ran')
      })
      const progress = tracker(done)
      await until(
        () => page.world.pendingTimers().length > 0,
        'the initial stability window',
      )
      const initial = latestPendingTimer(page.world)
      page.world.run(() => theObserver(page.world).callback())
      await until(
        () => page.world.pendingTimers().length > 0,
        'the post-mutation stability window',
      )
      initial.fire()
      expect(progress.finished).toBe(false)
      latestPendingTimer(page.world).fire()
      await settledWithin(done, 2000)
    }

    // ------------------------------------------------------------------
    // A page that never goes quiet is cut off: waitForStableDom rejects
    // with 'Timeout' once the stability cutoff elapses. (cpu multiplier
    // 0.05 puts the cutoff at TIMEOUTS.STABLE_DOM * 0.05 = 150ms.)
    {
      const page = new FakePage()
      const helper = new WaitForHelper(page.asPage(), 0.05, 0.05)
      const settled = helper.waitForStableDom()
      await until(
        () => page.world.pendingTimers().length > 0,
        'the stability window that will never elapse',
      )
      const captured: { rejection?: unknown } = {}
      await settledWithin(
        settled.then(
          () => {
            throw new Error('expected waitForStableDom to reject')
          },
          (error: unknown) => {
            captured.rejection = error
          },
        ),
        2000,
      )
      expect((captured.rejection as Error).message).toBe('Timeout')
    }

    // ------------------------------------------------------------------
    // The navigation grace window: with no navigation at all, the answer
    // is false, and the grace period really elapsed before it was given.
    {
      const page = new FakePage()
      const helper = new WaitForHelper(page.asPage(), 0.5, 0.5)
      const before = Date.now()
      const started = await settledWithin(
        helper.waitForNavigationStarted(),
        2000,
      )
      expect(started).toBe(false)
      expect(Date.now() - before).toBeGreaterThanOrEqual(45)
    }

    // ------------------------------------------------------------------
    // Navigation classification: different-document navigations count as
    // started; the same-document kinds do not.
    for (const navigationType of ['regular', 'reload']) {
      const page = new FakePage()
      const helper = new WaitForHelper(page.asPage(), 0.5, 0.5)
      const answer = helper.waitForNavigationStarted()
      page.client.dispatch('Page.frameStartedNavigating', { navigationType })
      expect(await settledWithin(answer, 2000)).toBe(true)
    }
    for (const navigationType of [
      'sameDocument',
      'historySameDocument',
      'historyDifferentDocument',
    ]) {
      const page = new FakePage()
      const helper = new WaitForHelper(page.asPage(), 0.5, 0.5)
      const answer = helper.waitForNavigationStarted()
      page.client.dispatch('Page.frameStartedNavigating', { navigationType })
      expect(await settledWithin(answer, 2000)).toBe(false)
    }

    // ------------------------------------------------------------------
    // A cross-document navigation is waited out: while the navigation is
    // in flight the sequence cannot finish, and the DOM observation starts
    // only after the navigation finished.
    {
      const page = new FakePage()
      let finishNavigation: () => void = () => {}
      page.navigationWaiter = () =>
        new Promise<void>((resolve) => {
          finishNavigation = resolve
        })
      const helper = new WaitForHelper(page.asPage(), 0.5, 0.5)
      const done = helper.waitForEventsAfterAction(async () => {
        page.client.dispatch('Page.frameStartedNavigating', {
          navigationType: 'regular',
        })
        page.trace.push('action-ran')
      })
      const progress = tracker(done)
      await until(
        () => page.trace.includes('waits-for-navigation-to-finish'),
        'the page navigation wait',
      )
      await pause(25)
      expect(progress.finished).toBe(false)
      finishNavigation()
      page.trace.push('navigation-finished')
      await until(
        () => page.world.pendingTimers().length > 0,
        'the stability window after navigation',
      )
      expect(page.trace.indexOf('navigation-finished')).toBeLessThan(
        page.trace.indexOf('stable-dom-observation-begins'),
      )
      latestPendingTimer(page.world).fire()
      await settledWithin(done, 2000)
    }

    // ------------------------------------------------------------------
    // An action that fails is rethrown, not swallowed, and the sequence
    // never reaches the DOM observation.
    {
      const page = new FakePage()
      const helper = new WaitForHelper(page.asPage(), 0.5, 0.5)
      const captured: { failure?: unknown } = {}
      await settledWithin(
        helper
          .waitForEventsAfterAction(async () => {
            throw new Error('the click never landed')
          })
          .then(
            () => {
              throw new Error('expected waitForEventsAfterAction to reject')
            },
            (error: unknown) => {
              captured.failure = error
            },
          ),
        2000,
      )
      expect((captured.failure as Error).message).toBe('the click never landed')
      expect(page.trace.includes('stable-dom-observation-begins')).toBe(false)
    }

    // ------------------------------------------------------------------
    // A navigation that fails to finish does not fail the action: the
    // failure is contained, the DOM observation still runs, and the
    // sequence settles.
    {
      const page = new FakePage()
      page.navigationWaiter = () =>
        Promise.reject(new Error('net::ERR_CONNECTION_RESET'))
      const helper = new WaitForHelper(page.asPage(), 0.5, 0.5)
      const done = helper.waitForEventsAfterAction(async () => {
        page.client.dispatch('Page.frameStartedNavigating', {
          navigationType: 'regular',
        })
      })
      await until(
        () => page.world.pendingTimers().length > 0,
        'the stability window after the failed navigation',
      )
      latestPendingTimer(page.world).fire()
      await settledWithin(done, 2000)
      expect(page.trace.includes('stable-dom-observation-begins')).toBe(true)
    }
  })
})
