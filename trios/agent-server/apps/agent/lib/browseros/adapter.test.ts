// Contract suite for the BrowserOS adapter (./adapter).
//
// The subject is thin glue between the callback-style chrome.browserOS API
// and promise-based callers, so the contract pinned here is settle
// behaviour: the value each method resolves with, the rejection that
// carries the browser's error message, and how capability gaps surface.
// The chrome namespace is faked in-process, so the suite needs no browser,
// no network, no database and no container.
//
// Exports left unpinned by an assertion: none. SCREENSHOT_SIZES,
// BrowserOSAdapter and getBrowserOSAdapter are all exercised below against
// the faked namespace, so no live dependency blocks any of them.

import { afterEach, describe, expect, it } from 'bun:test'
import {
  BrowserOSAdapter,
  SCREENSHOT_SIZES,
  getBrowserOSAdapter,
} from './adapter'

type FakeCall = { method: string; args: unknown[] }

interface Harness {
  /** Every browser API invocation seen so far, arguments in call order. */
  calls: FakeCall[]
  /** Scripts the arguments the faked API hands to the next callback. */
  outcome: (method: string, ...callbackArgs: unknown[]) => void
  /** Arms a chrome.runtime.lastError for the next browser API call. */
  failNext: (message: string) => void
}

const ALL_METHODS = [
  'getInteractiveSnapshot',
  'click',
  'inputText',
  'clear',
  'scrollToNode',
  'sendKeys',
  'getPageLoadStatus',
  'getAccessibilityTree',
  'captureScreenshot',
  'getSnapshot',
  'getVersionNumber',
  'getBrowserosVersionNumber',
  'logMetric',
  'executeJavaScript',
  'clickCoordinates',
  'typeAtCoordinates',
  'getPref',
  'setPref',
  'getAllPrefs',
  'choosePath',
]

const TAB = 7

/**
 * Replaces the global chrome namespace with a fake whose browserOS methods
 * record their arguments, surface an armed lastError, and answer with the
 * scripted outcome for their callback.
 */
function installChrome(
  methodNames: readonly string[],
  extraProps: Record<string, unknown> = {},
): Harness {
  const calls: FakeCall[] = []
  const scripted = new Map<string, unknown[]>()
  let pendingMessage: string | undefined

  const runtime: { lastError?: { message?: string } } = { lastError: undefined }
  const browserOS: Record<string, unknown> = { ...extraProps }

  for (const name of methodNames) {
    browserOS[name] = (...args: unknown[]) => {
      calls.push({ method: name, args })
      const callback = args[args.length - 1] as (
        ...callbackArgs: unknown[]
      ) => void
      runtime.lastError =
        pendingMessage === undefined ? undefined : { message: pendingMessage }
      pendingMessage = undefined
      callback(...(scripted.get(name) ?? []))
    }
  }

  ;(globalThis as { chrome?: unknown }).chrome = { runtime, browserOS }

  return {
    calls,
    outcome: (method, ...callbackArgs) => {
      scripted.set(method, callbackArgs)
    },
    failNext: (message) => {
      pendingMessage = message
    },
  }
}

describe('adapterContract', () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome
  })

  describe('SCREENSHOT_SIZES', () => {
    it('maps each advertised size key to its pixel width', () => {
      expect(SCREENSHOT_SIZES.small).toBe(512)
      expect(SCREENSHOT_SIZES.medium).toBe(768)
      expect(SCREENSHOT_SIZES.large).toBe(1028)
      expect(Object.keys(SCREENSHOT_SIZES).sort()).toEqual([
        'large',
        'medium',
        'small',
      ])
    })
  })

  describe('BrowserOSAdapter', () => {
    it(
      'shares one instance and settles every method against the browser API',
      async () => {
      const harness = installChrome(ALL_METHODS)
      const adapter = BrowserOSAdapter.getInstance()

      // The class hands out one shared instance.
      expect(adapter).toBeInstanceOf(BrowserOSAdapter)
      expect(BrowserOSAdapter.getInstance()).toBe(adapter)

      // Readers resolve with exactly what the browser produced.
      const snapshot = { items: [{ nodeId: 3, type: 'button' }] }
      harness.outcome('getInteractiveSnapshot', snapshot)
      await expect(adapter.getInteractiveSnapshot(TAB)).resolves.toBe(snapshot)
      await expect(
        adapter.getInteractiveSnapshot(TAB, { viewportOnly: true }),
      ).resolves.toBe(snapshot)

      const tree = { nodes: [{ id: 1, role: 'root' }] }
      harness.outcome('getAccessibilityTree', tree)
      await expect(adapter.getAccessibilityTree(TAB)).resolves.toBe(tree)

      const plainSnapshot = { url: 'https://example.test/' }
      harness.outcome('getSnapshot', plainSnapshot)
      await expect(adapter.getSnapshot(TAB)).resolves.toBe(plainSnapshot)
      await expect(adapter.getSnapshot(TAB, { context: 'full' })).resolves.toBe(
        plainSnapshot,
      )

      harness.outcome('getPageLoadStatus', 'complete')
      await expect(adapter.getPageLoadStatus(TAB)).resolves.toBe('complete')

      harness.outcome('getVersionNumber', '137.0.1')
      await expect(adapter.getVersion()).resolves.toBe('137.0.1')
      harness.outcome('getBrowserosVersionNumber', '2025.09')
      await expect(adapter.getBrowserosVersion()).resolves.toBe('2025.09')

      harness.outcome('executeJavaScript', 42)
      await expect(adapter.executeJavaScript(TAB, '6 * 7')).resolves.toBe(42)

      // Fire-and-forget actions settle once the browser acknowledges them.
      for (const acknowledge of [
        () => adapter.click(TAB, 3),
        () => adapter.inputText(TAB, 3, 'hello'),
        () => adapter.clear(TAB, 3),
        () => adapter.sendKeys(TAB, 'Enter'),
        () => adapter.clickCoordinates(TAB, 10, 20),
        () => adapter.typeAtCoordinates(TAB, 10, 20, 'hi'),
        () => adapter.logMetric('agent.session.start'),
        () => adapter.logMetric('agent.session.start', { source: 'suite' }),
      ]) {
        await expect(acknowledge()).resolves.toBeUndefined()
      }

      // scrollToNode reports whether the browser actually scrolled.
      harness.outcome('scrollToNode', true)
      await expect(adapter.scrollToNode(TAB, 3)).resolves.toBe(true)
      harness.outcome('scrollToNode', false)
      await expect(adapter.scrollToNode(TAB, 4)).resolves.toBe(false)

      // A size key reaches the browser as the advertised pixel width,
      // highlights travel alongside, and explicit dimensions win over both.
      const dataUrl = 'data:image/png;base64,AAA='
      harness.outcome('captureScreenshot', dataUrl)
      await expect(adapter.captureScreenshot(TAB)).resolves.toBe(dataUrl)
      expect(harness.calls[harness.calls.length - 1]?.args.slice(0, 1)).toEqual(
        [TAB],
      )
      await expect(adapter.captureScreenshot(TAB, 'small')).resolves.toBe(
        dataUrl,
      )
      expect(harness.calls[harness.calls.length - 1]?.args.slice(0, 2)).toEqual(
        [TAB, 512],
      )
      await expect(
        adapter.captureScreenshot(TAB, 'medium', true),
      ).resolves.toBe(dataUrl)
      expect(harness.calls[harness.calls.length - 1]?.args.slice(0, 3)).toEqual(
        [TAB, 768, true],
      )
      await expect(
        adapter.captureScreenshot(TAB, 'large', false, 640, 480),
      ).resolves.toBe(dataUrl)
      expect(harness.calls[harness.calls.length - 1]?.args.slice(0, 5)).toEqual(
        [TAB, 0, false, 640, 480],
      )

      // Preferences round-trip through the adapter.
      const pref = { key: 'agent.fontSize', type: 'number', value: 14 }
      harness.outcome('getPref', pref)
      await expect(adapter.getPref('agent.fontSize')).resolves.toBe(pref)
      harness.outcome('setPref', true)
      await expect(adapter.setPref('agent.fontSize', 16)).resolves.toBe(true)
      await expect(
        adapter.setPref('agent.fontSize', 16, 'options-page'),
      ).resolves.toBe(true)
      harness.outcome('setPref', false)
      await expect(adapter.setPref('agent.fontSize', 16)).resolves.toBe(false)
      const allPrefs = [pref]
      harness.outcome('getAllPrefs', allPrefs)
      await expect(adapter.getAllPrefs()).resolves.toBe(allPrefs)

      // A cancelled path selection comes back as null, not as an error.
      const selection = { path: '/tmp/report.md', name: 'report.md' }
      harness.outcome('choosePath', selection)
      await expect(
        adapter.choosePath({ type: 'file' }),
      ).resolves.toBe(selection)
      harness.outcome('choosePath', null)
      await expect(adapter.choosePath()).resolves.toBeNull()

      // A browser-side failure rejects with the message chrome reported.
      for (const invoke of [
        () => adapter.getInteractiveSnapshot(TAB),
        () => adapter.click(TAB, 3),
        () => adapter.inputText(TAB, 3, 'x'),
        () => adapter.clear(TAB, 3),
        () => adapter.scrollToNode(TAB, 3),
        () => adapter.sendKeys(TAB, 'Tab'),
        () => adapter.getPageLoadStatus(TAB),
        () => adapter.getAccessibilityTree(TAB),
        () => adapter.captureScreenshot(TAB),
        () => adapter.getSnapshot(TAB),
        () => adapter.getVersion(),
        () => adapter.getBrowserosVersion(),
        () => adapter.logMetric('agent.session.start'),
        () => adapter.executeJavaScript(TAB, '1'),
        () => adapter.clickCoordinates(TAB, 1, 2),
        () => adapter.typeAtCoordinates(TAB, 1, 2, 'x'),
        () => adapter.getPref('agent.fontSize'),
        () => adapter.setPref('agent.fontSize', 16),
        () => adapter.getAllPrefs(),
        () => adapter.choosePath(),
      ]) {
        harness.failNext('tab closed')
        await expect(invoke()).rejects.toThrow('tab closed')
      }

      // A failure with no message still names itself.
      harness.failNext('')
      await expect(adapter.click(TAB, 3)).rejects.toThrow('Unknown error')

      // Capability reporting mirrors the faked namespace.
      expect(adapter.isAPIAvailable('click')).toBe(true)
      expect(adapter.isAPIAvailable('notAnAPIToday')).toBe(false)
      expect(adapter.getAvailableAPIs()).toContain('click')
      expect(adapter.getAvailableAPIs()).toContain('choosePath')

      // An empty namespace reports no capabilities, soft-degrades the
      // optional readers to null, and turns the hard dependencies into
      // named rejections.
      installChrome([])
      expect(adapter.isAPIAvailable('click')).toBe(false)
      expect(adapter.getAvailableAPIs()).toEqual([])
      await expect(adapter.getVersion()).resolves.toBeNull()
      await expect(adapter.getBrowserosVersion()).resolves.toBeNull()
      await expect(
        adapter.logMetric('agent.session.start'),
      ).resolves.toBeUndefined()
      await expect(adapter.executeJavaScript(TAB, '1')).rejects.toThrow(
        'executeJavaScript API not available',
      )
      await expect(adapter.clickCoordinates(TAB, 1, 2)).rejects.toThrow(
        'clickCoordinates API not available',
      )
      await expect(adapter.typeAtCoordinates(TAB, 1, 2, 'x')).rejects.toThrow(
        'typeAtCoordinates API not available',
      )
      await expect(adapter.getPref('agent.fontSize')).rejects.toThrow(
        'getPref API not available',
      )
      await expect(adapter.setPref('agent.fontSize', 16)).rejects.toThrow(
        'setPref API not available',
      )
      await expect(adapter.getAllPrefs()).rejects.toThrow(
        'getAllPrefs API not available',
      )
      await expect(adapter.choosePath()).rejects.toThrow(
        'choosePath API not available',
      )

      // Non-function entries in the namespace are not capabilities.
      installChrome(ALL_METHODS, { releaseChannel: 'dev' })
      expect(adapter.getAvailableAPIs()).not.toContain('releaseChannel')
      expect(adapter.getAvailableAPIs()).toContain('sendKeys')
      },
    )
  })

  describe('getBrowserOSAdapter', () => {
    it('hands out the one shared BrowserOSAdapter instance', () => {
      installChrome(ALL_METHODS)
      const adapter = getBrowserOSAdapter()
      expect(adapter).toBeInstanceOf(BrowserOSAdapter)
      expect(adapter).toBe(BrowserOSAdapter.getInstance())
      expect(getBrowserOSAdapter()).toBe(adapter)
    })
  })
})
