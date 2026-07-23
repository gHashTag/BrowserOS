import { describe, expect, it } from 'bun:test'
import assert from 'node:assert'
import type { ToolExecutionOptions, ToolSet } from 'ai'
import { z } from 'zod'
import {
  buildBrowserToolSet,
  combineToolAbortSignals,
} from '../../src/agent/tool-adapter'
import type { Browser } from '../../src/browser/browser'
import { defineTool, type ToolContext } from '../../src/tools/framework'
import type { ToolResult } from '../../src/tools/response'
import { ToolRegistry } from '../../src/tools/tool-registry'

function createBrowser(methods: Record<string, unknown> = {}): Browser {
  return {
    getTabIdForPage: () => undefined,
    ...methods,
  } as unknown as Browser
}

function createContext(browser = createBrowser()): ToolContext {
  return {
    browser,
    directories: { workingDir: process.cwd() },
  }
}

async function executeRegisteredTool(
  toolSet: ToolSet,
  name: string,
  input: unknown,
  options: ToolExecutionOptions,
): Promise<ToolResult> {
  const execute = toolSet[name]?.execute
  assert.ok(execute, `Expected ${name} to have an execute function`)
  return (await execute(input, options)) as ToolResult
}

function executionOptions(abortSignal?: AbortSignal): ToolExecutionOptions {
  return {
    toolCallId: 'test-tool-call',
    messages: [],
    abortSignal,
  }
}

function resultText(result: ToolResult): string {
  return result.content
    .filter(
      (item): item is { type: 'text'; text: string } => item.type === 'text',
    )
    .map((item) => item.text)
    .join('\n')
}

describe('browser tool adapter abort propagation', () => {
  it('passes a composed signal that follows request cancellation to the handler', async () => {
    let capturedSignal: AbortSignal | undefined
    const registry = new ToolRegistry([
      defineTool({
        name: 'capture_signal',
        description: 'Capture the execution signal',
        approvalCategory: 'observation',
        input: z.object({}),
        handler: async (_args, _ctx, response, signal) => {
          capturedSignal = signal
          response.text('captured')
        },
      }),
    ])
    const controller = new AbortController()
    const toolSet = buildBrowserToolSet(registry, createContext())

    const result = await executeRegisteredTool(
      toolSet,
      'capture_signal',
      {},
      executionOptions(controller.signal),
    )

    assert.ok(!result.isError)
    assert.ok(capturedSignal, 'Expected handler to receive an AbortSignal')
    assert.notStrictEqual(capturedSignal, controller.signal)

    controller.abort('user cancelled')

    assert.strictEqual(capturedSignal.aborted, true)
    assert.strictEqual(capturedSignal.reason, 'user cancelled')
  })

  it('does not invoke the handler when the request is already aborted', async () => {
    let handlerCalls = 0
    const registry = new ToolRegistry([
      defineTool({
        name: 'must_not_run',
        description: 'Must not run after cancellation',
        approvalCategory: 'observation',
        input: z.object({}),
        handler: async (_args, _ctx, response) => {
          handlerCalls += 1
          response.text('ran')
        },
      }),
    ])
    const controller = new AbortController()
    controller.abort('cancel before execution')
    const toolSet = buildBrowserToolSet(registry, createContext())

    const result = await executeRegisteredTool(
      toolSet,
      'must_not_run',
      {},
      executionOptions(controller.signal),
    )

    assert.strictEqual(handlerCalls, 0)
    assert.strictEqual(result.isError, true)
    assert.match(
      result.content.map((item) => ('text' in item ? item.text : '')).join(' '),
      /aborted/i,
    )
  })

  it('re-checks cancellation after asynchronous ACL evaluation', async () => {
    let resolvePageInfo: ((value: { url: string }) => void) | undefined
    const pageInfo = new Promise<{ url: string }>((resolve) => {
      resolvePageInfo = resolve
    })
    let handlerCalls = 0
    const browser = createBrowser({
      refreshPageInfo: async () => pageInfo,
    })
    const context: ToolContext = {
      ...createContext(browser),
      aclRules: [
        {
          id: 'unmatched-rule',
          sitePattern: 'blocked.example',
          enabled: true,
        },
      ],
    }
    const registry = new ToolRegistry([
      defineTool({
        name: 'click',
        description: 'Exercise the asynchronous ACL boundary',
        approvalCategory: 'input',
        input: z.object({ page: z.number() }),
        handler: async (_args, _ctx, response) => {
          handlerCalls += 1
          response.text('clicked')
        },
      }),
    ])
    const controller = new AbortController()
    const toolSet = buildBrowserToolSet(registry, context)

    const pending = executeRegisteredTool(
      toolSet,
      'click',
      { page: 1 },
      executionOptions(controller.signal),
    )
    await Promise.resolve()
    controller.abort('cancel during ACL')
    assert.ok(resolvePageInfo)
    resolvePageInfo({ url: 'https://allowed.example' })

    const result = await pending

    assert.strictEqual(handlerCalls, 0)
    assert.strictEqual(result.isError, true)
    assert.match(
      result.content.map((item) => ('text' in item ? item.text : '')).join(' '),
      /aborted/i,
    )
  })

  it('uses the timeout signal when no request signal exists', async () => {
    const signal = combineToolAbortSignals(undefined, 10)
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener('abort', () => resolve(), { once: true })
    })

    assert.strictEqual(signal.aborted, true)
    assert.ok(signal.reason instanceof DOMException)
    assert.strictEqual(signal.reason.name, 'TimeoutError')
  })

  it('preserves structured content returned by browser tools', async () => {
    const registry = new ToolRegistry([
      defineTool({
        name: 'structured_result',
        description: 'Return structured output',
        approvalCategory: 'observation',
        input: z.object({}),
        handler: async (_args, _ctx, response) => {
          response.text('done')
          response.data({ pageId: 7, action: 'observed' })
        },
      }),
    ])
    const toolSet = buildBrowserToolSet(registry, createContext())

    const result = await executeRegisteredTool(
      toolSet,
      'structured_result',
      {},
      executionOptions(),
    )

    expect(result.structuredContent).toEqual({
      pageId: 7,
      action: 'observed',
    })
  })

  it('reports the standard abort error when an aborted handler throws', async () => {
    const controller = new AbortController()
    const registry = new ToolRegistry([
      defineTool({
        name: 'abort_then_throw',
        description: 'Abort while the handler is in flight',
        approvalCategory: 'observation',
        input: z.object({}),
        handler: async (_args, _ctx, _response, signal) => {
          controller.abort('cancel during handler')
          assert.strictEqual(signal.aborted, true)
          throw new Error('browser operation interrupted')
        },
      }),
    ])
    const toolSet = buildBrowserToolSet(registry, createContext())

    const result = await executeRegisteredTool(
      toolSet,
      'abort_then_throw',
      {},
      executionOptions(controller.signal),
    )

    assert.strictEqual(result.isError, true)
    assert.match(resultText(result), /Request was aborted/)
    assert.doesNotMatch(resultText(result), /Internal error/)
  })

  it('keeps ordinary handler failures classified as internal errors', async () => {
    const registry = new ToolRegistry([
      defineTool({
        name: 'ordinary_failure',
        description: 'Fail without request cancellation',
        approvalCategory: 'observation',
        input: z.object({}),
        handler: async () => {
          throw new Error('ordinary failure')
        },
      }),
    ])
    const toolSet = buildBrowserToolSet(registry, createContext())

    const result = await executeRegisteredTool(
      toolSet,
      'ordinary_failure',
      {},
      executionOptions(),
    )

    assert.strictEqual(result.isError, true)
    assert.match(
      resultText(result),
      /Internal error in ordinary_failure: ordinary failure/,
    )
  })

  it('does not discard a completed handler result solely because cancellation arrived', async () => {
    const controller = new AbortController()
    const registry = new ToolRegistry([
      defineTool({
        name: 'completed_side_effect',
        description: 'Complete before returning after cancellation',
        approvalCategory: 'observation',
        input: z.object({}),
        handler: async (_args, _ctx, response) => {
          response.text('side effect completed')
          controller.abort('arrived after completion')
        },
      }),
    ])
    const toolSet = buildBrowserToolSet(registry, createContext())

    const result = await executeRegisteredTool(
      toolSet,
      'completed_side_effect',
      {},
      executionOptions(controller.signal),
    )

    assert.ok(!result.isError)
    assert.match(resultText(result), /side effect completed/)
  })
})
