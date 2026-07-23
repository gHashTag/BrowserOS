import { describe, it } from 'bun:test'
import assert from 'node:assert'
import type { Browser } from '../../src/browser/browser'
import { ToolResponse } from '../../src/tools/response'

function textOf(result: {
  content: { type: string; text?: string }[]
}): string {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
}

describe('ToolResponse', () => {
  it('accumulates structured content from data()', () => {
    const response = new ToolResponse()
    response.data('action', 'click')
    response.data({ page: 1, element: 42 })

    const result = response.toResult()
    assert.deepStrictEqual(result.structuredContent, {
      action: 'click',
      page: 1,
      element: 42,
    })
  })

  it('overwrites keys on repeated data() writes', () => {
    const response = new ToolResponse()
    response.data('count', 1)
    response.data({ count: 2 })
    response.data('count', 3)

    const result = response.toResult()
    assert.deepStrictEqual(result.structuredContent, { count: 3 })
  })

  it('times out slow post-actions without failing tool output', async () => {
    const response = new ToolResponse({ postActionTimeoutMs: 25 })
    response.text('ok')
    response.includeSnapshot(1)

    const browser = {
      snapshot: async () => await new Promise<string>(() => {}),
    } as unknown as Browser

    const start = Date.now()
    const result = await response.build(browser)
    const elapsed = Date.now() - start

    assert.ok(elapsed < 250, `Expected fast timeout, got ${elapsed}ms`)
    assert.ok(!result.isError)

    const text = textOf(result)
    assert.ok(text.includes('ok'))
    assert.ok(!text.includes('[Page 1 snapshot]'))
  })

  it('includes snapshot output when post-action completes in time', async () => {
    const response = new ToolResponse({ postActionTimeoutMs: 200 })
    response.text('ok')
    response.includeSnapshot(1)

    const browser = {
      snapshot: async () => '[42] button "Submit"',
    } as unknown as Browser

    const result = await response.build(browser)
    const text = textOf(result)

    assert.ok(text.includes('ok'))
    assert.ok(text.includes('[Page 1 snapshot]'))
    assert.ok(text.includes('[42] button "Submit"'))
  })

  it('stops waiting for a post-action when the request is aborted', async () => {
    const response = new ToolResponse({ postActionTimeoutMs: 1_000 })
    response.text('ok')
    response.includeSnapshot(1)

    const browser = {
      snapshot: async () => await new Promise<string>(() => {}),
    } as unknown as Browser
    const controller = new AbortController()
    let activeAbortListeners = 0
    let addedAbortListeners = 0
    let removedAbortListeners = 0
    const trackedSignal = {
      get aborted() {
        return controller.signal.aborted
      },
      get reason() {
        return controller.signal.reason
      },
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type === 'abort') {
          activeAbortListeners += 1
          addedAbortListeners += 1
        }
        controller.signal.addEventListener(type, listener, options)
      },
      removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) {
        if (type === 'abort') {
          activeAbortListeners -= 1
          removedAbortListeners += 1
        }
        controller.signal.removeEventListener(type, listener, options)
      },
    } as AbortSignal

    const start = Date.now()
    const pending = response.build(browser, trackedSignal)
    controller.abort('cancel post-action')
    const result = await pending
    const elapsed = Date.now() - start

    assert.ok(elapsed < 250, `Expected prompt abort, got ${elapsed}ms`)
    assert.ok(!result.isError)
    assert.ok(textOf(result).includes('ok'))
    assert.strictEqual(addedAbortListeners, 1)
    assert.strictEqual(removedAbortListeners, 1)
    assert.strictEqual(activeAbortListeners, 0)
  })

  it('ignores a snapshot that resolves after its build was aborted', async () => {
    const response = new ToolResponse({ postActionTimeoutMs: 1_000 })
    response.text('ok')
    response.includeSnapshot(1)
    let resolveSnapshot: ((value: string) => void) | undefined
    const snapshot = new Promise<string>((resolve) => {
      resolveSnapshot = resolve
    })
    const browser = {
      snapshot: async () => snapshot,
    } as unknown as Browser
    const controller = new AbortController()

    const pending = response.build(browser, controller.signal)
    controller.abort('cancel snapshot')
    const result = await pending
    const returnedContent = result.content.map((item) => ({ ...item }))
    assert.ok(resolveSnapshot)

    resolveSnapshot('[99] button "Too late"')
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepStrictEqual(result.content, returnedContent)
    assert.deepStrictEqual(response.toResult().content, returnedContent)
    assert.ok(!textOf(result).includes('Too late'))
    assert.ok(!textOf(response.toResult()).includes('Too late'))
  })

  it('does not launch queued post-actions for a pre-aborted build', async () => {
    const response = new ToolResponse({ postActionTimeoutMs: 1_000 })
    response.text('ok')
    response.includeSnapshot(1)
    response.includeScreenshot(1)
    response.includePages()
    const calls = {
      snapshot: 0,
      screenshot: 0,
      pages: 0,
    }
    const browser = {
      snapshot: async () => {
        calls.snapshot += 1
        return 'snapshot'
      },
      screenshot: async () => {
        calls.screenshot += 1
        return { data: 'image', mimeType: 'image/png' }
      },
      listPages: async () => {
        calls.pages += 1
        return []
      },
    } as unknown as Browser
    const controller = new AbortController()
    controller.abort('cancel before build')

    const start = Date.now()
    const result = await response.build(browser, controller.signal)
    const elapsed = Date.now() - start

    assert.ok(elapsed < 100, `Expected prompt pre-abort, got ${elapsed}ms`)
    assert.ok(!result.isError)
    assert.deepStrictEqual(calls, {
      snapshot: 0,
      screenshot: 0,
      pages: 0,
    })
    assert.ok(textOf(result).includes('ok'))
    assert.ok(!textOf(result).includes('snapshot'))
  })

  it('ignores a snapshot that resolves after its post-action timeout', async () => {
    const response = new ToolResponse({ postActionTimeoutMs: 10 })
    response.text('ok')
    response.includeSnapshot(1)
    let resolveSnapshot: ((value: string) => void) | undefined
    const snapshot = new Promise<string>((resolve) => {
      resolveSnapshot = resolve
    })
    const browser = {
      snapshot: async () => snapshot,
    } as unknown as Browser

    const result = await response.build(browser)
    const returnedContent = result.content.map((item) => ({ ...item }))
    assert.ok(resolveSnapshot)

    resolveSnapshot('[100] link "Arrived after timeout"')
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepStrictEqual(result.content, returnedContent)
    assert.deepStrictEqual(response.toResult().content, returnedContent)
    assert.ok(!textOf(result).includes('Arrived after timeout'))
    assert.ok(!textOf(response.toResult()).includes('Arrived after timeout'))
  })

  it('returns defensive content and structured-data snapshots', () => {
    const response = new ToolResponse()
    response.text('original')
    response.data({ count: 1 })

    const first = response.toResult()
    first.content.push({ type: 'text', text: 'external mutation' })
    assert.ok(first.structuredContent)
    first.structuredContent.count = 999

    const second = response.toResult()

    assert.deepStrictEqual(second.content, [{ type: 'text', text: 'original' }])
    assert.deepStrictEqual(second.structuredContent, { count: 1 })
  })

  it('does not expose mutable references to existing content items', () => {
    const response = new ToolResponse()
    response.text('original')

    const first = response.toResult()
    const firstItem = first.content[0]
    assert.ok(firstItem)
    assert.strictEqual(firstItem.type, 'text')
    firstItem.text = 'external mutation'

    const second = response.toResult()

    assert.deepStrictEqual(second.content, [{ type: 'text', text: 'original' }])
  })

  it('deeply snapshots nested structured objects and arrays on output', () => {
    const response = new ToolResponse()
    response.data({
      page: { title: 'Original page' },
      tabs: [{ title: 'First tab' }, { title: 'Second tab' }],
    })

    const first = response.toResult()
    assert.ok(first.structuredContent)
    const firstPage = first.structuredContent.page as { title: string }
    const firstTabs = first.structuredContent.tabs as Array<{ title: string }>
    firstPage.title = 'Mutated page'
    firstTabs[0].title = 'Mutated tab'
    firstTabs.push({ title: 'Injected tab' })

    const second = response.toResult()

    assert.deepStrictEqual(second.structuredContent, {
      page: { title: 'Original page' },
      tabs: [{ title: 'First tab' }, { title: 'Second tab' }],
    })
  })

  it('snapshots nested structured inputs when data is recorded', () => {
    const page = {
      title: 'Original page',
      labels: ['stable'],
    }
    const tabs = [{ title: 'First tab' }]
    const response = new ToolResponse()

    response.data({ page, tabs })
    page.title = 'Changed after data()'
    page.labels.push('late mutation')
    tabs[0].title = 'Changed tab'
    tabs.push({ title: 'Late tab' })

    assert.deepStrictEqual(response.toResult().structuredContent, {
      page: {
        title: 'Original page',
        labels: ['stable'],
      },
      tabs: [{ title: 'First tab' }],
    })
  })

  it('rejects unsupported structured values without partially recording them', () => {
    const response = new ToolResponse()

    assert.throws(
      () =>
        response.data({
          validBeforeFailure: 'must not leak',
          unsupported: () => 'not cloneable',
        }),
      {
        name: 'TypeError',
        message: /structured data must be cloneable/i,
      },
    )
    assert.strictEqual(response.toResult().structuredContent, undefined)
  })
})
