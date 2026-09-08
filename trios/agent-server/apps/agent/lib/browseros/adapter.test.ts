// First suite for the browseros adapter exports (#1505).
//
// Coverage map, one block per exported symbol:
//   SCREENSHOT_SIZES    - pinned as the table of capture widths
//   BrowserOSAdapter    - pinned as the shared wrapper over chrome.browserOS
//   getBrowserOSAdapter - pinned as the accessor for the shared wrapper
//
// No exported symbol needs a live dependency to be exercised: the adapter
// reads the global `chrome` object at call time, so a fake platform
// installed on globalThis drives the whole contract with no network, no
// database and no container. Nothing was left untested, so no export is
// listed here as blocked by a missing dependency.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  BrowserOSAdapter,
  getBrowserOSAdapter,
  SCREENSHOT_SIZES,
} from './adapter'

const ALL_PLATFORM_APIS = [
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
] as const

type FakePlatform = {
  calls: Record<string, unknown[][]>
  fail: (api: string, message?: string) => void
  succeed: (api: string, ...results: unknown[]) => void
}

// Installs a global chrome object whose browserOS table answers every call
// by recording it and handing the adapter callback whatever outcome was last
// configured for that entry. `releaseChannel` is a non-function entry, so
// the availability checks below can pin how the adapter treats such keys.
function installFakePlatform(
  apis: readonly string[] = ALL_PLATFORM_APIS,
): FakePlatform {
  const calls: Record<string, unknown[][]> = {}
  const outcomes = new Map<
    string,
    { error?: { message?: string }; results?: unknown[] }
  >()
  const runtime: { lastError?: { message?: string } } = {}
  const browserOS: Record<string, unknown> = { releaseChannel: 'stable' }
  for (const api of apis) {
    browserOS[api] = (...args: unknown[]) => {
      const recorded = calls[api] ?? []
      recorded.push(args)
      calls[api] = recorded
      const outcome = outcomes.get(api)
      runtime.lastError = outcome?.error
      const callback = args[args.length - 1]
      if (typeof callback === 'function') {
        callback(...(outcome?.results ?? []))
      }
      runtime.lastError = undefined
    }
  }
  ;(globalThis as Record<string, unknown>).chrome = { runtime, browserOS }
  return {
    calls,
    fail: (api, message) => outcomes.set(api, { error: { message } }),
    succeed: (api, ...results) => outcomes.set(api, { results }),
  }
}

// Returns the arguments of one recorded platform call, failing loudly when
// the adapter never made the call the assertion is about.
function recordedCall(
  platform: FakePlatform,
  api: string,
  index = 0,
): unknown[] {
  const entry = platform.calls[api]?.[index]
  if (!entry) {
    throw new Error(`expected a recorded ${api} call at index ${index}`)
  }
  return entry
}

describe('adapterContract', () => {
  let platform: FakePlatform

  beforeEach(() => {
    platform = installFakePlatform()
  })

  // The subject reads `chrome` from globalThis at call time, so the fake is
  // removed after every block to keep it invisible to other suites.
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome
  })

  it('SCREENSHOT_SIZES offers the capture widths the adapter forwards', async () => {
    expect(SCREENSHOT_SIZES).toEqual({ small: 512, medium: 768, large: 1028 })

    // Each named size is accepted by a capture request and crosses to the
    // platform as exactly the pixel width the table promises.
    const adapter = BrowserOSAdapter.getInstance()
    const keys = Object.keys(SCREENSHOT_SIZES) as Array<
      keyof typeof SCREENSHOT_SIZES
    >
    let index = 0
    for (const key of keys) {
      const dataUrl = `data:image/png;width=${SCREENSHOT_SIZES[key]}`
      platform.succeed('captureScreenshot', dataUrl)
      await expect(adapter.captureScreenshot(7, key)).resolves.toBe(dataUrl)
      const call = recordedCall(platform, 'captureScreenshot', index)
      expect(call.slice(0, 1)).toEqual([7])
      expect(call[1]).toBe(SCREENSHOT_SIZES[key])
      expect(call).toHaveLength(3)
      index += 1
    }
  })

  it('BrowserOSAdapter shares one instance and turns platform callbacks into promises', async () => {
    const adapter = BrowserOSAdapter.getInstance()
    expect(adapter).toBeInstanceOf(BrowserOSAdapter)
    expect(BrowserOSAdapter.getInstance()).toBe(adapter)

    // Reads resolve with whatever the platform hands back...
    platform.succeed('getInteractiveSnapshot', {
      snapshotId: 11,
      timestamp: 5,
      elements: [],
      processingTimeMs: 1,
    })
    await expect(adapter.getInteractiveSnapshot(5)).resolves.toEqual({
      snapshotId: 11,
      timestamp: 5,
      elements: [],
      processingTimeMs: 1,
    })
    const firstSnapshotCall = recordedCall(platform, 'getInteractiveSnapshot')
    expect(firstSnapshotCall.slice(0, 1)).toEqual([5])
    expect(firstSnapshotCall).toHaveLength(2)

    await adapter.getInteractiveSnapshot(5, { viewportOnly: true })
    const secondSnapshotCall = recordedCall(
      platform,
      'getInteractiveSnapshot',
      1,
    )
    expect(secondSnapshotCall.slice(0, 2)).toEqual([5, { viewportOnly: true }])
    expect(secondSnapshotCall).toHaveLength(3)

    platform.succeed('getSnapshot', { items: [] })
    await expect(adapter.getSnapshot(5)).resolves.toEqual({ items: [] })
    await adapter.getSnapshot(5, { context: 'full' })
    expect(recordedCall(platform, 'getSnapshot', 1).slice(0, 2)).toEqual([
      5,
      { context: 'full' },
    ])

    platform.succeed('getPageLoadStatus', {
      isResourcesLoading: true,
      isDOMContentLoaded: false,
      isPageComplete: false,
    })
    await expect(adapter.getPageLoadStatus(5)).resolves.toEqual({
      isResourcesLoading: true,
      isDOMContentLoaded: false,
      isPageComplete: false,
    })

    platform.succeed('getAccessibilityTree', { rootId: 1, nodes: {} })
    await expect(adapter.getAccessibilityTree(5)).resolves.toEqual({
      rootId: 1,
      nodes: {},
    })

    // ...and interaction relays tab, node and text unchanged.
    await adapter.click(5, 9)
    expect(recordedCall(platform, 'click').slice(0, 2)).toEqual([5, 9])

    await adapter.inputText(5, 9, 'hello')
    expect(recordedCall(platform, 'inputText').slice(0, 3)).toEqual([
      5,
      9,
      'hello',
    ])

    await adapter.clear(5, 9)
    expect(recordedCall(platform, 'clear').slice(0, 2)).toEqual([5, 9])

    await adapter.sendKeys(5, 'Enter')
    expect(recordedCall(platform, 'sendKeys').slice(0, 2)).toEqual([5, 'Enter'])

    platform.succeed('scrollToNode', true)
    await expect(adapter.scrollToNode(5, 9)).resolves.toBe(true)
    platform.succeed('scrollToNode', false)
    await expect(adapter.scrollToNode(5, 9)).resolves.toBe(false)

    // A bare capture request sends the platform only the tab and callback.
    platform.succeed('captureScreenshot', 'data:image/png;base64,AAA')
    await expect(adapter.captureScreenshot(5)).resolves.toBe(
      'data:image/png;base64,AAA',
    )
    expect(recordedCall(platform, 'captureScreenshot')).toHaveLength(2)

    await adapter.captureScreenshot(5, 'large')
    expect(recordedCall(platform, 'captureScreenshot', 1).slice(0, 2)).toEqual([
      5,
      SCREENSHOT_SIZES.large,
    ])

    await adapter.captureScreenshot(5, 'small', true)
    expect(recordedCall(platform, 'captureScreenshot', 2).slice(0, 3)).toEqual([
      5,
      SCREENSHOT_SIZES.small,
      true,
    ])

    // Highlights without a named size fall back to width 0.
    await adapter.captureScreenshot(5, undefined, true)
    expect(recordedCall(platform, 'captureScreenshot', 3).slice(0, 3)).toEqual([
      5,
      0,
      true,
    ])

    // Explicit dimensions override the named sizes and default the
    // highlight flag to false.
    await adapter.captureScreenshot(5, undefined, undefined, 640, 480)
    expect(recordedCall(platform, 'captureScreenshot', 4).slice(0, 5)).toEqual([
      5,
      0,
      false,
      640,
      480,
    ])

    platform.succeed('getVersionNumber', '137.0.7100.0')
    await expect(adapter.getVersion()).resolves.toBe('137.0.7100.0')
    platform.succeed('getBrowserosVersionNumber', '1.5.0')
    await expect(adapter.getBrowserosVersion()).resolves.toBe('1.5.0')

    await adapter.logMetric('page_opened', { source: 'suite' })
    expect(recordedCall(platform, 'logMetric').slice(0, 2)).toEqual([
      'page_opened',
      { source: 'suite' },
    ])
    await adapter.logMetric('page_opened')
    expect(recordedCall(platform, 'logMetric', 1)).toHaveLength(2)

    platform.succeed('executeJavaScript', 2)
    await expect(adapter.executeJavaScript(5, '1 + 1')).resolves.toBe(2)
    expect(recordedCall(platform, 'executeJavaScript').slice(0, 2)).toEqual([
      5,
      '1 + 1',
    ])

    await adapter.clickCoordinates(5, 12, 34)
    expect(recordedCall(platform, 'clickCoordinates').slice(0, 3)).toEqual([
      5, 12, 34,
    ])

    await adapter.typeAtCoordinates(5, 12, 34, 'hi')
    expect(recordedCall(platform, 'typeAtCoordinates').slice(0, 4)).toEqual([
      5,
      12,
      34,
      'hi',
    ])

    platform.succeed('getPref', {
      key: 'browseros.server.version',
      type: 'string',
      value: 'v1',
    })
    await expect(adapter.getPref('browseros.server.version')).resolves.toEqual({
      key: 'browseros.server.version',
      type: 'string',
      value: 'v1',
    })

    platform.succeed('setPref', true)
    await expect(
      adapter.setPref('browseros.server.version', 'v2'),
    ).resolves.toBe(true)
    expect(recordedCall(platform, 'setPref').slice(0, 2)).toEqual([
      'browseros.server.version',
      'v2',
    ])
    platform.succeed('setPref', false)
    await expect(
      adapter.setPref('browseros.server.version', 'v3', 'page-1'),
    ).resolves.toBe(false)
    expect(recordedCall(platform, 'setPref', 1).slice(0, 3)).toEqual([
      'browseros.server.version',
      'v3',
      'page-1',
    ])

    platform.succeed('getAllPrefs', [{ key: 'a', type: 'string', value: 'b' }])
    await expect(adapter.getAllPrefs()).resolves.toEqual([
      { key: 'a', type: 'string', value: 'b' },
    ])

    platform.succeed('choosePath', { path: '/tmp/report.pdf', name: 'r.pdf' })
    await expect(
      adapter.choosePath({ type: 'file', title: 'Pick' }),
    ).resolves.toEqual({ path: '/tmp/report.pdf', name: 'r.pdf' })
    platform.succeed('choosePath')
    await expect(adapter.choosePath()).resolves.toBeUndefined()

    // A platform error surfaces as a rejection carrying the platform
    // message, or the fallback wording when the platform gives none.
    platform.fail('click', 'Tab 5 is gone')
    await expect(adapter.click(5, 9)).rejects.toThrow('Tab 5 is gone')
    platform.fail('click', '')
    await expect(adapter.click(5, 9)).rejects.toThrow('Unknown error')
    platform.fail('getInteractiveSnapshot')
    await expect(adapter.getInteractiveSnapshot(5)).rejects.toThrow(
      'Unknown error',
    )
    platform.fail('captureScreenshot', 'No capture for you')
    await expect(adapter.captureScreenshot(5)).rejects.toThrow(
      'No capture for you',
    )

    // Availability reflects the platform table: presence of a key for the
    // boolean check, callability for the listed names.
    expect(adapter.isAPIAvailable('click')).toBe(true)
    expect(adapter.isAPIAvailable('neverHeardOfThat')).toBe(false)
    expect(adapter.isAPIAvailable('releaseChannel')).toBe(true)
    const available = adapter.getAvailableAPIs()
    expect(available).toContain('click')
    expect(available).not.toContain('releaseChannel')
    expect([...available].sort()).toEqual([...ALL_PLATFORM_APIS].sort())

    // On a platform without the optional entries the version probes answer
    // null, the silent metric call resolves, and the guarded calls reject
    // with their availability message.
    platform = installFakePlatform([])
    await expect(adapter.getVersion()).resolves.toBeNull()
    await expect(adapter.getBrowserosVersion()).resolves.toBeNull()
    await expect(adapter.logMetric('page_opened')).resolves.toBeUndefined()
    await expect(adapter.executeJavaScript(5, '1 + 1')).rejects.toThrow(
      'executeJavaScript API not available',
    )
    await expect(adapter.clickCoordinates(5, 1, 2)).rejects.toThrow(
      'clickCoordinates API not available',
    )
    await expect(adapter.typeAtCoordinates(5, 1, 2, 'hi')).rejects.toThrow(
      'typeAtCoordinates API not available',
    )
    await expect(adapter.getPref('any')).rejects.toThrow(
      'getPref API not available',
    )
    await expect(adapter.setPref('any', 1)).rejects.toThrow(
      'setPref API not available',
    )
    await expect(adapter.getAllPrefs()).rejects.toThrow(
      'getAllPrefs API not available',
    )
    await expect(adapter.choosePath()).rejects.toThrow(
      'choosePath API not available',
    )
    expect(adapter.isAPIAvailable('click')).toBe(false)
    expect(adapter.getAvailableAPIs()).toEqual([])
  })

  it('getBrowserOSAdapter hands back the same shared adapter on every call', () => {
    const adapter = getBrowserOSAdapter()
    expect(adapter).toBeInstanceOf(BrowserOSAdapter)
    expect(getBrowserOSAdapter()).toBe(adapter)
    expect(BrowserOSAdapter.getInstance()).toBe(adapter)
  })
})
