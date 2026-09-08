/**
 * Contract suite for clado-action-executor.ts.
 *
 * Exports of the subject: CladoActionExecutor — the only export. Every method
 * of the class (constructor, setCallbacks, execute, getTotalSteps, close) is
 * exercised by the assertions under the describe block below, so no export is
 * silently untested and no live dependency blocked coverage of anything.
 *
 * The two endpoints the executor talks to are replaced with in-process fakes
 * registered through mock.module before the subject is imported:
 *   - utils/mcp-client (the BrowserOS MCP server) — a real one needs a running
 *     browser, which needs a container or a desktop;
 *   - ./clado-client (the Clado action model) — a real one needs the network
 *     and an API key.
 * Everything else (clado-actions, clado-browser-driver, types, constants,
 * sleep) runs for real, so the suite pins the executor's actual contract:
 * what it sends to the browser, what it sends to the model, what it reports
 * back through ExecutorResult and the ExecutorCallbacks stream.
 *
 * The suite needs no database, no container and no network.
 */
import { afterAll, describe, expect, it, mock } from 'bun:test'
import type { McpToolResult } from '../../../../utils/mcp-client'
import type {
  CladoActionClientOptions,
  CladoActionPredictionInput,
} from './clado-client'
import type { CladoAction, CladoActionResponse } from './types'
import { CLADO_ACTION_PROVIDER } from './types'
import type { ExecutorConfig } from '../../../orchestrator-executor/types'
import type {
  ExecutorCallbacks,
  ToolCallInfo,
  ToolResultInfo,
} from '../../executor-backend'

type ToolRouter = (
  toolName: string,
  args: Record<string, unknown>,
) => McpToolResult

type ScriptedPrediction = CladoActionResponse | Error

interface RecordedToolCall {
  toolName: string
  args: Record<string, unknown>
}

interface RecordedPrediction {
  instruction: string
  imageBase64: string
  actionHistory: CladoAction[]
}

interface RecordedStep {
  toolCalls?: ReadonlyArray<ToolCallInfo>
  toolResults?: ReadonlyArray<ToolResultInfo>
  text?: string
}

interface Harness {
  serverUrls: string[]
  clientOptions: CladoActionClientOptions[]
  toolCalls: RecordedToolCall[]
  predictionRequests: RecordedPrediction[]
  predictions: ScriptedPrediction[]
  router: ToolRouter
  closeCount: number
}

const harness: Harness = {
  serverUrls: [],
  clientOptions: [],
  toolCalls: [],
  predictionRequests: [],
  predictions: [],
  router: () => ({ content: [] }),
  closeCount: 0,
}

const MCP_CLIENT_MODULE = '../../../../utils/mcp-client'
const CLADO_CLIENT_MODULE = './clado-client'

/** A browser that is 1920x1080 and always parked on the same page. */
function defaultRouter(
  toolName: string,
  args: Record<string, unknown>,
): McpToolResult {
  if (toolName === 'take_screenshot') {
    return {
      content: [
        { type: 'image', data: 'c2NyZWVuc2hvdA==', mimeType: 'image/png' },
      ],
    }
  }
  const expression = typeof args.expression === 'string' ? args.expression : ''
  if (expression.includes('innerWidth')) {
    return { content: [{ type: 'text', text: '[1920, 1080]' }] }
  }
  if (expression.includes('location.href')) {
    return { content: [{ type: 'text', text: '"https://example.com/landed"' }] }
  }
  return { content: [{ type: 'text', text: 'ok' }] }
}

function resetHarness(options: {
  router?: ToolRouter
  predictions?: ScriptedPrediction[]
} = {}): void {
  harness.serverUrls = []
  harness.clientOptions = []
  harness.toolCalls = []
  harness.predictionRequests = []
  harness.predictions = options.predictions ? [...options.predictions] : []
  harness.router = options.router ?? defaultRouter
  harness.closeCount = 0
}

mock.module(MCP_CLIENT_MODULE, () => ({
  McpClient: class {
    constructor(serverUrl: string) {
      harness.serverUrls.push(serverUrl)
    }

    async callTool(
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<McpToolResult> {
      harness.toolCalls.push({ toolName, args })
      return harness.router(toolName, args)
    }

    async close(): Promise<void> {
      harness.closeCount += 1
    }
  },
}))

mock.module(CLADO_CLIENT_MODULE, () => ({
  CladoActionClient: class {
    constructor(options: CladoActionClientOptions) {
      harness.clientOptions.push(options)
    }

    async requestActionPrediction(
      input: CladoActionPredictionInput,
    ): Promise<CladoActionResponse> {
      harness.predictionRequests.push({
        instruction: input.instruction,
        imageBase64: input.imageBase64,
        actionHistory: [...input.actionHistory],
      })
      const next = harness.predictions.shift()
      if (next === undefined) {
        throw new Error('scripted predictions ran out')
      }
      if (next instanceof Error) {
        throw next
      }
      return next
    }
  },
}))

const { CladoActionExecutor } = await import('./clado-action-executor')

afterAll(async () => {
  // mock.restore() does not undo mock.module, and a leaked mock would reach
  // any file loaded after this one in the same process (for example
  // tests/agents/executor-backend.test.ts, which imports the subject through
  // clado-executor-backend). The query suffix sidesteps the mock registry and
  // loads the real source, which is then put back with a synchronous factory.
  // Where the real source cannot load (a tree without node_modules), the mock
  // simply stays in place — nothing else imports these modules in a run of
  // this file alone.
  for (const specifier of [MCP_CLIENT_MODULE, CLADO_CLIENT_MODULE]) {
    try {
      const real = await import(`${specifier}?restore-real`)
      mock.module(specifier, () => real)
    } catch {
      // Real module unavailable in this environment; leave the mock standing.
    }
  }
})

const EXECUTOR_CONFIG: ExecutorConfig = {
  provider: CLADO_ACTION_PROVIDER,
  model: 'clado-action-model',
  apiKey: 'test-api-key',
  baseUrl: 'http://clado.test/predict',
}

function recordingCallbacks(): {
  callbacks: ExecutorCallbacks
  starts: ToolCallInfo[]
  finishes: RecordedStep[]
  toolFinishes: () => number
} {
  const starts: ToolCallInfo[] = []
  const finishes: RecordedStep[] = []
  let toolFinishCount = 0
  const callbacks: ExecutorCallbacks = {
    onToolCallStart: (toolCall) => {
      starts.push(toolCall)
    },
    onStepFinish: async (step) => {
      finishes.push(step)
    },
    onToolCallFinish: async () => {
      toolFinishCount += 1
    },
  }
  return { callbacks, starts, finishes, toolFinishes: () => toolFinishCount }
}

function stepOutput(step: RecordedStep | undefined): Record<string, unknown> {
  const output = step?.toolResults?.[0]?.output
  return (output ?? {}) as Record<string, unknown>
}

describe('cladoActionExecutorContract', () => {
  it('pins the CladoActionExecutor delegation contract end to end', async () => {
    // ---- constructor: rejects any other provider, before touching anything
    resetHarness()
    let rejected: unknown
    try {
      new CladoActionExecutor(
        { ...EXECUTOR_CONFIG, provider: 'tool-loop' },
        'http://browser.test',
      )
    } catch (error) {
      rejected = error
    }
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).toBe(
      `CladoActionExecutor requires provider="${CLADO_ACTION_PROVIDER}"`,
    )
    expect(harness.serverUrls).toEqual([])
    expect(harness.clientOptions).toEqual([])

    // ---- wiring: server URL, Clado credentials, default page id
    resetHarness({
      predictions: [
        { action: 'click', x: 500, y: 500 },
        { action: 'end', final_answer: 'Clicked the target.' },
      ],
    })
    const executor = new CladoActionExecutor(
      EXECUTOR_CONFIG,
      'http://browser.test',
    )
    expect(harness.serverUrls).toEqual(['http://browser.test/mcp'])
    expect(harness.clientOptions).toEqual([
      { baseUrl: 'http://clado.test/predict', apiKey: 'test-api-key' },
    ])
    expect(executor.getTotalSteps()).toBe(0)
    const recorder = recordingCallbacks()
    executor.setCallbacks(recorder.callbacks)

    const done = await executor.execute('Click the primary button')

    // Screenshot first, viewport resolved once, click mapped from the 0-1000
    // coordinate space onto 1920x1080, page id defaulted to 1, URL read back
    // after the loop ends.
    expect(harness.toolCalls).toEqual([
      {
        toolName: 'take_screenshot',
        args: { format: 'png', page: 1 },
      },
      {
        toolName: 'evaluate_script',
        args: {
          expression: '(() => [window.innerWidth, window.innerHeight])()',
          page: 1,
        },
      },
      {
        toolName: 'click_at',
        args: { x: 960, y: 540, clickCount: 1, page: 1 },
      },
      {
        toolName: 'take_screenshot',
        args: { format: 'png', page: 1 },
      },
      {
        toolName: 'evaluate_script',
        args: { expression: '(() => window.location.href)()', page: 1 },
      },
    ])

    // The model saw the instruction, the screenshot, and the growing history.
    expect(harness.predictionRequests).toEqual([
      {
        instruction: 'Click the primary button',
        imageBase64: 'c2NyZWVuc2hvdA==',
        actionHistory: [],
      },
      {
        instruction: 'Click the primary button',
        imageBase64: 'c2NyZWVuc2hvdA==',
        actionHistory: [{ action: 'click', x: 500, y: 500 }],
      },
    ])

    expect(done.status).toBe('done')
    expect(done.url).toBe('https://example.com/landed')
    expect(done.actionsPerformed).toBe(2)
    expect(done.toolsUsed).toEqual(['clado_action_predict'])
    expect(executor.getTotalSteps()).toBe(2)
    expect(done.observation).toBe(
      'Status: done\n' +
        'Reason: Model requested end() with final_answer: Clicked the target.\n' +
        'URL: https://example.com/landed\n' +
        'Final answer: Clicked the target.\n' +
        'Recent actions:\n' +
        '1. click:500:500\n' +
        '2. end(Clicked the target.)\n' +
        'Total model actions: 2',
    )

    // The callback stream mirrors each prediction round.
    expect(
      recorder.starts.map((event) => ({
        toolName: event.toolName,
        input: event.input,
      })),
    ).toEqual([
      {
        toolName: 'clado_action_predict',
        input: { instruction: 'Click the primary button', history: 'None' },
      },
      {
        toolName: 'clado_action_predict',
        input: {
          instruction: 'Click the primary button',
          history: 'click(500, 500)',
        },
      },
    ])
    expect(recorder.toolFinishes()).toBe(2)
    expect(recorder.finishes).toHaveLength(2)
    expect(stepOutput(recorder.finishes[0]).executed).toEqual([
      'Executed click at (960, 540).',
    ])
    expect(stepOutput(recorder.finishes[0]).parsedActions).toEqual([
      { action: 'click', x: 500, y: 500 },
    ])
    expect(stepOutput(recorder.finishes[1]).executed).toEqual([
      'Model requested end() with final_answer: Clicked the target.',
    ])

    // close() tears the MCP connection down exactly once.
    expect(harness.closeCount).toBe(0)
    await executor.close()
    expect(harness.closeCount).toBe(1)

    // ---- a multi-action prediction, a custom page id, and the adaptations
    // the executor owes the browser: the type reuses the point the click just
    // resolved, "C-a" becomes "Control+A", an unknown scroll direction
    // defaults to "down", and 500 normalized pixels become 4 scroll ticks.
    resetHarness({
      predictions: [
        {
          raw_response:
            '<thinking>plan the interaction</thinking>' +
            '<answer>{"action":"click","x":100,"y":100}</answer>' +
            '<answer>{"action":"type","text":"hello world"}</answer>' +
            '<answer>{"action":"press_key","key":"C-a"}</answer>' +
            '<answer>{"action":"scroll","direction":"diagonal","amount":500}</answer>',
        },
        { action: 'end' },
      ],
    })
    const paged = new CladoActionExecutor(
      EXECUTOR_CONFIG,
      'http://browser.test',
      7,
    )
    const pagedRecorder = recordingCallbacks()
    paged.setCallbacks(pagedRecorder.callbacks)

    const adapted = await paged.execute('Fill the search field')

    expect(harness.toolCalls).toEqual([
      {
        toolName: 'take_screenshot',
        args: { format: 'png', page: 7 },
      },
      {
        toolName: 'evaluate_script',
        args: {
          expression: '(() => [window.innerWidth, window.innerHeight])()',
          page: 7,
        },
      },
      {
        toolName: 'click_at',
        args: { x: 192, y: 108, clickCount: 1, page: 7 },
      },
      {
        toolName: 'type_at',
        args: { x: 192, y: 108, text: 'hello world', clear: false, page: 7 },
      },
      { toolName: 'press_key', args: { key: 'Control+A', page: 7 } },
      { toolName: 'scroll', args: { direction: 'down', amount: 4, page: 7 } },
      {
        toolName: 'take_screenshot',
        args: { format: 'png', page: 7 },
      },
      {
        toolName: 'evaluate_script',
        args: { expression: '(() => window.location.href)()', page: 7 },
      },
    ])
    expect(adapted.status).toBe('done')
    expect(adapted.actionsPerformed).toBe(5)
    expect(paged.getTotalSteps()).toBe(5)
    expect(adapted.observation).toContain(
      'Reason: Model requested end() and marked task complete.',
    )
    expect(adapted.observation).toContain('Total model actions: 5')
    expect(adapted.observation).toContain(
      'Model thinking trace:\nStep 1: plan the interaction',
    )
    expect(pagedRecorder.starts[1]?.input).toEqual({
      instruction: 'Fill the search field',
      history:
        "click(100, 100) -> type('hello world') -> press_key('C-a') -> scroll(diagonal)",
    })
    expect(pagedRecorder.toolFinishes()).toBe(5)
    expect(stepOutput(pagedRecorder.finishes[0]).executed).toEqual([
      'Executed click at (192, 108).',
      'Typed text (11 chars).',
      'Pressed key "Control+A".',
      'Scrolled down by 4 ticks.',
    ])
    expect(stepOutput(pagedRecorder.finishes[1]).executed).toEqual([
      'Model requested end().',
    ])

    // ---- the model endpoint failing leaves the delegation blocked, with the
    // error surfaced through both the reason and the callback stream
    resetHarness({ predictions: [new Error('HTTP 502 Bad Gateway')] })
    const wired = new CladoActionExecutor(EXECUTOR_CONFIG, 'http://browser.test')
    const wiredRecorder = recordingCallbacks()
    wired.setCallbacks(wiredRecorder.callbacks)

    const failed = await wired.execute('Click the primary button')

    expect(failed.status).toBe('blocked')
    expect(failed.url).toBe('https://example.com/landed')
    expect(failed.actionsPerformed).toBe(0)
    expect(failed.toolsUsed).toEqual([])
    expect(failed.observation).toContain(
      'Reason: Clado action request failed: HTTP 502 Bad Gateway',
    )
    expect(wiredRecorder.starts).toHaveLength(1)
    expect(wiredRecorder.toolFinishes()).toBe(0)
    expect(stepOutput(wiredRecorder.finishes[0])).toEqual({
      error: 'HTTP 502 Bad Gateway',
    })
    expect(harness.toolCalls.map((call) => call.toolName)).toEqual([
      'take_screenshot',
      'evaluate_script',
    ])

    // ---- a screenshot tool error blocks with the wrapped tool message
    resetHarness({
      router: (toolName, args) => {
        if (toolName === 'take_screenshot') {
          return {
            content: [{ type: 'text', text: 'renderer crashed' }],
            isError: true,
          }
        }
        return defaultRouter(toolName, args)
      },
      predictions: [{ action: 'end' }],
    })
    const blind = new CladoActionExecutor(EXECUTOR_CONFIG, 'http://browser.test')

    const unsighted = await blind.execute('Click the primary button')

    expect(unsighted.status).toBe('blocked')
    expect(unsighted.actionsPerformed).toBe(0)
    expect(unsighted.observation).toContain(
      'Reason: Could not capture screenshot: take_screenshot failed: renderer crashed',
    )
    expect(harness.predictionRequests).toEqual([])

    // ---- three unparseable predictions in a row stop the delegation
    const ramble: CladoActionResponse = {
      action: null,
      raw_response: 'the model rambled',
    }
    resetHarness({ predictions: [ramble, ramble, ramble] })
    const stubborn = new CladoActionExecutor(
      EXECUTOR_CONFIG,
      'http://browser.test',
    )
    const stubbornRecorder = recordingCallbacks()
    stubborn.setCallbacks(stubbornRecorder.callbacks)

    const unparsed = await stubborn.execute('Click the primary button')

    expect(unparsed.status).toBe('blocked')
    expect(unparsed.actionsPerformed).toBe(3)
    expect(stubborn.getTotalSteps()).toBe(3)
    expect(unparsed.observation).toContain(
      'Reason: Clado returned 3 consecutive unparseable responses.',
    )
    expect(unparsed.observation).toContain('invalid(parse_error:')
    expect(unparsed.observation).toContain('Total model actions: 3')
    expect(stepOutput(stubbornRecorder.finishes[2]).consecutiveParseFailures).toBe(
      3,
    )
    expect(stepOutput(stubbornRecorder.finishes[2]).parseError).toBe(
      'no parsable <answer> in raw_response',
    )
    expect(stubbornRecorder.starts[1]?.input).toEqual({
      instruction: 'Click the primary button',
      history: 'invalid()',
    })

    // ---- an already-aborted signal reports a timeout before any I/O
    resetHarness({ predictions: [{ action: 'end' }] })
    const controller = new AbortController()
    controller.abort()
    const cancelled = new CladoActionExecutor(
      EXECUTOR_CONFIG,
      'http://browser.test',
    )

    const aborted = await cancelled.execute('Anything', controller.signal)

    expect(aborted.status).toBe('timeout')
    expect(aborted.url).toBe('')
    expect(aborted.actionsPerformed).toBe(0)
    expect(aborted.toolsUsed).toEqual([])
    expect(harness.toolCalls).toEqual([])
    expect(harness.predictionRequests).toEqual([])
    expect(aborted.observation).toBe(
      'Status: timeout\n' +
        'Reason: Delegation aborted by timeout or cancellation.\n' +
        'URL: unknown\n' +
        'Recent actions:\n' +
        'No actions were executed.\n' +
        'Total model actions: 0',
    )

    // ---- burning the whole action budget without an end() blocks the run,
    // and running without any callbacks registered must not throw
    const enterPress: CladoActionResponse = { action: 'press_key', key: 'Enter' }
    resetHarness({
      predictions: Array.from({ length: 15 }, () => enterPress),
    })
    const tireless = new CladoActionExecutor(EXECUTOR_CONFIG, 'http://browser.test')

    const exhausted = await tireless.execute('Keep pressing Enter')

    expect(exhausted.status).toBe('blocked')
    expect(exhausted.actionsPerformed).toBe(15)
    expect(tireless.getTotalSteps()).toBe(15)
    expect(exhausted.toolsUsed).toEqual(['clado_action_predict'])
    expect(exhausted.observation).toContain(
      'Reason: Reached max action budget (15) without a clear completion signal.',
    )
    expect(exhausted.observation).toContain('Total model actions: 15')
    expect(exhausted.observation).toContain('5. press_key:Enter')
    expect(harness.predictionRequests).toHaveLength(15)
  })
})
