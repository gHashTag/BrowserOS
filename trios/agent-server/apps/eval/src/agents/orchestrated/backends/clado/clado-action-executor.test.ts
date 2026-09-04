/**
 * Contract suite for the single export of clado-action-executor.ts:
 * the CladoActionExecutor class.
 *
 * The executor's only live dependencies are a browser driven over an MCP
 * server (McpClient) and the remote Clado action model (CladoActionClient).
 * Both are network services, and both are swapped for in-process fakes below
 * via mock.module, so this suite needs no network, no database and no
 * container. Every assertion observes behaviour through the public surface
 * only: the constructor, execute(), close(), getTotalSteps(), the
 * ExecutorResult it resolves, and the ExecutorCallbacks it reports to.
 *
 * Nothing is left unpinned: the module exports exactly one symbol
 * (CladoActionExecutor) and no dependency blocked it from being exercised
 * here, so the blocked-export list required by the issue is empty.
 */
import { describe, expect, it, mock } from 'bun:test'
import type { ExecutorConfig } from '../../../orchestrator-executor/types'
import type { ExecutorCallbacks } from '../../executor-backend'
import type { CladoAction, CladoActionResponse } from './types'

interface FakeToolResult {
  content: Array<{
    type: string
    text?: string
    data?: string
    mimeType?: string
  }>
  isError?: boolean
}

type FakeToolHandler = (
  name: string,
  args: Record<string, unknown>,
) => Promise<FakeToolResult>

const SCREENSHOT_PNG = 'c2NyZWVuc2hvdA=='

const defaultToolHandler: FakeToolHandler = async (name, args) => {
  if (name === 'take_screenshot') {
    return {
      content: [{ type: 'image', data: SCREENSHOT_PNG, mimeType: 'image/png' }],
    }
  }
  if (name === 'evaluate_script') {
    const expression = String(args.expression ?? args.function ?? '')
    if (expression.includes('innerWidth')) {
      return { content: [{ type: 'text', text: '[1920, 1080]' }] }
    }
    return { content: [{ type: 'text', text: 'https://example.com/after' }] }
  }
  return { content: [{ type: 'text', text: 'ok' }] }
}

interface RecordedToolCall {
  name: string
  args: Record<string, unknown>
}

const createdMcpClients: FakeMcpClient[] = []
const createdCladoClients: FakeCladoActionClient[] = []

class FakeMcpClient {
  readonly calls: RecordedToolCall[] = []
  closeCalls = 0
  toolHandler: FakeToolHandler = defaultToolHandler

  constructor(readonly serverUrl: string) {
    createdMcpClients.push(this)
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<FakeToolResult> {
    this.calls.push({ name, args })
    return this.toolHandler(name, args)
  }

  async close(): Promise<void> {
    this.closeCalls++
  }
}

interface RecordedPredictionRequest {
  instruction: string
  imageBase64: string
  actionHistory: CladoAction[]
}

class FakeCladoActionClient {
  readonly requests: RecordedPredictionRequest[] = []
  queue: CladoActionResponse[] = []
  failure: Error | null = null

  constructor(readonly options: { baseUrl?: string; apiKey?: string }) {
    createdCladoClients.push(this)
  }

  async requestActionPrediction(
    input: RecordedPredictionRequest,
  ): Promise<CladoActionResponse> {
    // The executor hands over its live action-history array; snapshot what was
    // actually visible at request time so assertions see that moment.
    this.requests.push({
      instruction: input.instruction,
      imageBase64: input.imageBase64,
      actionHistory: input.actionHistory.map((action) => ({ ...action })),
    })
    if (this.failure) throw this.failure
    const next = this.queue.shift()
    if (!next) {
      throw new Error('prediction queue exhausted')
    }
    return next
  }
}

mock.module('../../../../utils/mcp-client', () => ({
  McpClient: FakeMcpClient,
}))

mock.module('./clado-client', () => ({
  CladoActionClient: FakeCladoActionClient,
}))

const { CladoActionExecutor } = await import('./clado-action-executor')

const EXECUTOR_CONFIG: ExecutorConfig = {
  provider: 'clado-action',
  model: 'clado-act',
  apiKey: 'eval-test-key',
  baseUrl: 'https://clado.example.test/action',
}

function buildExecutor(pageId?: number) {
  const executor = new CladoActionExecutor(
    EXECUTOR_CONFIG,
    'http://127.0.0.1:1',
    pageId,
  )
  const mcp = createdMcpClients[createdMcpClients.length - 1]
  const clado = createdCladoClients[createdCladoClients.length - 1]
  if (!mcp || !clado) {
    throw new Error('executor did not construct its fake clients')
  }
  return { executor, mcp, clado }
}

interface RecordedStep {
  toolCalls?: ReadonlyArray<{ toolCallId: string; toolName: string }>
  toolResults?: ReadonlyArray<{
    toolCallId: string
    toolName: string
    output: unknown
  }>
}

function buildCallbacks() {
  const toolCallStarts: Array<{
    toolCallId: string
    toolName: string
    input: unknown
  }> = []
  const finishedSteps: RecordedStep[] = []
  const toolCallFinishes: number[] = []
  const callbacks: ExecutorCallbacks = {
    onToolCallStart: (toolCall) => {
      toolCallStarts.push(toolCall)
    },
    onStepFinish: async (step) => {
      finishedSteps.push(step as RecordedStep)
    },
    onToolCallFinish: async () => {
      toolCallFinishes.push(Date.now())
    },
  }
  return { toolCallStarts, finishedSteps, toolCallFinishes, callbacks }
}

describe('cladoActionExecutorContract', () => {
  it('pins CladoActionExecutor: provider guard, delegation loop, coordinate translation, callbacks, failure paths and step accounting', async () => {
    // The constructor refuses every provider except clado-action, before
    // building any client.
    let wrongProviderError: unknown
    try {
      new CladoActionExecutor(
        { provider: 'tool-loop', model: 'm', apiKey: 'k' },
        'http://127.0.0.1:1',
      )
    } catch (error) {
      wrongProviderError = error
    }
    expect(wrongProviderError).toBeInstanceOf(Error)
    expect((wrongProviderError as Error).message).toBe(
      'CladoActionExecutor requires provider="clado-action"',
    )
    expect(createdMcpClients).toHaveLength(0)
    expect(createdCladoClients).toHaveLength(0)

    // A click round followed by end() with a final answer completes the
    // delegation and reports the trajectory.
    const happy = buildExecutor(7)
    expect(happy.executor.getTotalSteps()).toBe(0)
    happy.clado.queue = [
      {
        action: 'click',
        x: 500,
        y: 250,
        raw_response: '<thinking>need to click the hero</thinking>',
      },
      { action: 'end', final_answer: 'Clicked the button' },
    ]
    const happyCallbacks = buildCallbacks()
    happy.executor.setCallbacks(happyCallbacks.callbacks)

    const firstRun = await happy.executor.execute('Click the button')

    expect(firstRun.status).toBe('done')
    expect(firstRun.url).toBe('https://example.com/after')
    expect(firstRun.actionsPerformed).toBe(2) // the click and the end() both count
    expect(firstRun.toolsUsed).toEqual(['clado_action_predict'])
    expect(firstRun.observation).toContain('Status: done')
    expect(firstRun.observation).toContain(
      'Reason: Model requested end() with final_answer: Clicked the button',
    )
    expect(firstRun.observation).toContain('URL: https://example.com/after')
    expect(firstRun.observation).toContain('Final answer: Clicked the button')
    expect(firstRun.observation).toContain('1. click:500:250')
    expect(firstRun.observation).toContain('2. end(Clicked the button)')
    expect(firstRun.observation).toContain('Total model actions: 2')
    expect(firstRun.observation).toContain('Step 1: need to click the hero')

    // Clado's 0-1000 normalized coordinates are translated through the
    // viewport probed by evaluate_script, and page-scoped tools carry the
    // executor's page id.
    expect(happy.mcp.calls.map((call) => call.name)).toEqual([
      'take_screenshot',
      'evaluate_script', // viewport probe
      'click_at',
      'take_screenshot', // second round
      'evaluate_script', // final URL probe
    ])
    expect(happy.mcp.calls[0].args).toEqual({ format: 'png', page: 7 })
    expect(happy.mcp.calls[1].args).toEqual({
      expression: '(() => [window.innerWidth, window.innerHeight])()',
      page: 7,
    })
    expect(happy.mcp.calls[2].args).toEqual({
      x: 960,
      y: 270,
      clickCount: 1,
      page: 7,
    })
    expect(happy.mcp.calls[4].args).toEqual({
      expression: '(() => window.location.href)()',
      page: 7,
    })

    // The model is asked once per round with the instruction, the current
    // screenshot and the raw action history.
    expect(happy.clado.requests).toHaveLength(2)
    expect(happy.clado.requests[0].instruction).toBe('Click the button')
    expect(happy.clado.requests[0].imageBase64).toBe(SCREENSHOT_PNG)
    expect(happy.clado.requests[0].actionHistory).toEqual([])
    // The parsed action objects keep explicit undefined fields for missing
    // coordinates, so match on the observable payload instead.
    expect(happy.clado.requests[1].actionHistory).toMatchObject([
      { action: 'click', x: 500, y: 250 },
    ])

    // Callbacks observe one predict tool-call per round, formatted history,
    // and one step report per round.
    expect(happyCallbacks.toolCallStarts).toHaveLength(2)
    expect(happyCallbacks.toolCallStarts[0].toolName).toBe(
      'clado_action_predict',
    )
    expect(happyCallbacks.toolCallStarts[0].input).toEqual({
      instruction: 'Click the button',
      history: 'None',
    })
    expect(happyCallbacks.toolCallStarts[1].input).toEqual({
      instruction: 'Click the button',
      history: 'click(500, 250)',
    })
    expect(happyCallbacks.toolCallFinishes).toHaveLength(2) // click + end()
    expect(happyCallbacks.finishedSteps).toHaveLength(2)
    expect(happyCallbacks.finishedSteps[0].toolCalls?.[0]?.toolCallId).toBe(
      happyCallbacks.toolCallStarts[0].toolCallId,
    )
    expect(
      happyCallbacks.finishedSteps[0].toolResults?.[0]?.output,
    ).toMatchObject({
      parsedActions: [{ action: 'click', x: 500, y: 250 }],
      executed: ['Executed click at (960, 270).'],
    })
    expect(
      happyCallbacks.finishedSteps[1].toolResults?.[0]?.output,
    ).toMatchObject({
      parsedActions: [{ action: 'end', final_answer: 'Clicked the button' }],
      executed: ['Model requested end() with final_answer: Clicked the button'],
    })
    expect(happy.executor.getTotalSteps()).toBe(2)

    // A second delegation on the same executor accumulates steps.
    happy.clado.queue = [{ action: 'end' }]
    const secondRun = await happy.executor.execute('Click the button')
    expect(secondRun.actionsPerformed).toBe(1)
    expect(happy.executor.getTotalSteps()).toBe(3)
    expect(secondRun.observation).toContain(
      'Reason: Model requested end() and marked task complete.',
    )

    // close() releases the MCP connection.
    await happy.executor.close()
    expect(happy.mcp.closeCalls).toBe(1)

    // A screenshot response without image data blocks the delegation before
    // any prediction is made, and the failure reason is observable.
    const blind = buildExecutor()
    blind.mcp.toolHandler = async (name, args) => {
      if (name === 'take_screenshot') {
        return { content: [{ type: 'text', text: 'no image payload' }] }
      }
      return defaultToolHandler(name, args)
    }
    blind.clado.queue = [{ action: 'end' }]
    const blindRun = await blind.executor.execute('look around')
    expect(blindRun.status).toBe('blocked')
    expect(blindRun.actionsPerformed).toBe(0)
    expect(blindRun.toolsUsed).toEqual([])
    expect(blindRun.observation).toContain(
      'Reason: Could not capture screenshot: Screenshot response did not include base64 image data',
    )
    expect(blindRun.url).toBe('https://example.com/after')
    expect(blind.clado.requests).toHaveLength(0)

    // A failing prediction request is reported through the step callback and
    // blocks the delegation.
    const down = buildExecutor()
    down.clado.failure = new Error('HTTP 503 Service Unavailable: clado down')
    const downCallbacks = buildCallbacks()
    down.executor.setCallbacks(downCallbacks.callbacks)
    const downRun = await down.executor.execute('look around')
    expect(downRun.status).toBe('blocked')
    expect(downRun.actionsPerformed).toBe(0)
    expect(downRun.toolsUsed).toEqual([])
    expect(downRun.observation).toContain(
      'Reason: Clado action request failed: HTTP 503 Service Unavailable: clado down',
    )
    expect(downRun.url).toBe('https://example.com/after')
    expect(downCallbacks.finishedSteps).toHaveLength(1)
    expect(downCallbacks.finishedSteps[0].toolResults?.[0]?.output).toEqual({
      error: 'HTTP 503 Service Unavailable: clado down',
    })

    // Three consecutive unparsable predictions burn a step each and then
    // block the delegation instead of looping forever.
    const garbled = buildExecutor()
    garbled.clado.queue = [
      {
        action: null,
        raw_response: '',
        parse_error: 'no parsable answer block',
      },
      {
        action: null,
        raw_response: '',
        parse_error: 'no parsable answer block',
      },
      {
        action: null,
        raw_response: '',
        parse_error: 'no parsable answer block',
      },
    ]
    const garbledCallbacks = buildCallbacks()
    garbled.executor.setCallbacks(garbledCallbacks.callbacks)
    const garbledRun = await garbled.executor.execute('look around')
    expect(garbledRun.status).toBe('blocked')
    expect(garbledRun.actionsPerformed).toBe(3)
    expect(garbledRun.toolsUsed).toEqual([])
    expect(garbledRun.observation).toContain(
      'Reason: Clado returned 3 consecutive unparseable responses.',
    )
    expect(garbledRun.observation).toContain('Total model actions: 3')
    expect(garbledCallbacks.finishedSteps).toHaveLength(3)
    expect(
      garbledCallbacks.finishedSteps[2].toolResults?.[0]?.output,
    ).toMatchObject({
      parseError: 'no parsable answer block',
      consecutiveParseFailures: 3,
      parsedActions: [],
    })

    // A delegation that starts aborted reports timeout, touches no tool and
    // asks the model nothing.
    const controller = new AbortController()
    controller.abort()
    const cancelled = buildExecutor()
    const cancelledRun = await cancelled.executor.execute(
      'look around',
      controller.signal,
    )
    expect(cancelledRun.status).toBe('timeout')
    expect(cancelledRun.actionsPerformed).toBe(0)
    expect(cancelledRun.url).toBe('')
    expect(cancelledRun.observation).toContain('Status: timeout')
    expect(cancelledRun.observation).toContain(
      'Reason: Delegation aborted by timeout or cancellation.',
    )
    expect(cancelledRun.observation).toContain('No actions were executed.')
    expect(cancelled.mcp.calls).toHaveLength(0)
    expect(cancelled.clado.requests).toHaveLength(0)

    // An unsupported action name blocks the delegation and names the offender.
    const weird = buildExecutor()
    weird.clado.queue = [{ action: 'teleport', x: 1, y: 1 }]
    const weirdCallbacks = buildCallbacks()
    weird.executor.setCallbacks(weirdCallbacks.callbacks)
    const weirdRun = await weird.executor.execute('look around')
    expect(weirdRun.status).toBe('blocked')
    expect(weirdRun.actionsPerformed).toBe(0)
    expect(weirdRun.observation).toContain(
      'Reason: Action execution failed: Unsupported Clado action: teleport',
    )
    expect(
      weirdCallbacks.finishedSteps[0].toolResults?.[0]?.output,
    ).toMatchObject({
      executed: ['Failed teleport: Unsupported Clado action: teleport'],
    })

    // Typing with no known target point refuses to guess where to type.
    const drifting = buildExecutor()
    drifting.clado.queue = [{ action: 'type', text: 'hello' }]
    const driftingRun = await drifting.executor.execute('fill the form')
    expect(driftingRun.status).toBe('blocked')
    expect(driftingRun.actionsPerformed).toBe(0)
    expect(driftingRun.observation).toContain(
      'Reason: Action execution failed: type action: no coordinates available',
    )

    // Typing at a given point lands on the translated viewport coordinates.
    const typing = buildExecutor(3)
    typing.clado.queue = [
      { action: 'type', text: 'hello', x: 100, y: 200 },
      { action: 'end' },
    ]
    const typingRun = await typing.executor.execute('fill the form')
    expect(typingRun.status).toBe('done')
    expect(typingRun.actionsPerformed).toBe(2)
    const typeCall = typing.mcp.calls.find((call) => call.name === 'type_at')
    expect(typeCall?.args).toEqual({
      x: 192,
      y: 216,
      text: 'hello',
      clear: false,
      page: 3,
    })
    expect(typingRun.observation).toContain('1. type:hello')

    // When the viewport probe fails, clicks fall back to a 1440x900 viewport
    // (normalized 1000 is clamped to 999 before scaling).
    const fallback = buildExecutor()
    fallback.mcp.toolHandler = async (name, args) => {
      const expression = String(args.expression ?? args.function ?? '')
      if (name === 'evaluate_script' && expression.includes('innerWidth')) {
        return {
          content: [{ type: 'text', text: 'evaluate failed: page gone' }],
        }
      }
      return defaultToolHandler(name, args)
    }
    fallback.clado.queue = [
      { action: 'click', x: 1000, y: 500 },
      { action: 'end' },
    ]
    const fallbackRun = await fallback.executor.execute('click something')
    expect(fallbackRun.status).toBe('done')
    const fallbackClick = fallback.mcp.calls.find(
      (call) => call.name === 'click_at',
    )
    expect(fallbackClick?.args).toEqual({
      x: 1439,
      y: 450,
      clickCount: 1,
      page: 1,
    })

    // Predictions that never end are stopped by the action budget.
    const endless = buildExecutor()
    endless.clado.queue = Array.from({ length: 15 }, () => ({
      action: 'press_key',
      key: 'Tab',
    }))
    const endlessRun = await endless.executor.execute('keep going')
    expect(endlessRun.status).toBe('blocked')
    expect(endlessRun.actionsPerformed).toBe(15)
    expect(endlessRun.toolsUsed).toEqual(['clado_action_predict'])
    expect(endlessRun.observation).toContain(
      'Reason: Reached max action budget (15) without a clear completion signal.',
    )
    expect(endlessRun.observation).toContain('Total model actions: 15')
    expect(endlessRun.observation).toContain('5. press_key:Tab')
    expect(
      endless.mcp.calls.filter((call) => call.name === 'press_key'),
    ).toHaveLength(15)
  })
})
