/**
 * Contract tests for orchestrator-agent.ts
 *
 * Export coverage map (the module's single runtime export, per the issue's
 * measure of exported symbols):
 * - OrchestratorAgent — exercised by every test below, through both of its
 *   public members: the static create() factory and the run() method. Each
 *   test name states which behaviour of the export it pins.
 *
 * Type-only exports (OrchestratorAgentOptions, OrchestratorAgentResult) are
 * compile-time shapes; they are consumed by these tests through the runtime
 * export and have no behaviour of their own to assert.
 *
 * Nothing was left unpinned for lack of a dependency: the only external
 * dependency of the module — the LLM provider, built via
 * createLanguageModel() — is replaced here with scripted MockLanguageModelV3
 * models, so the suite needs no network, no database and no container, while
 * the real AI SDK ToolLoopAgent turn loop, the real delegate tool and the
 * real subject code all execute. The one behaviour that could not be pinned
 * is the 300-second delegation timeout inside the delegate tool: observing
 * it fire would require a wall-clock five-minute wait (the subject's
 * constructor takes no injectable clock), so it is named here instead. No
 * exported symbol depends on it.
 *
 * The subject is imported unmodified; only the provider-factory module it
 * calls into is stubbed, which is the seam the module itself defines for
 * provider construction.
 */
import { describe, expect, it, mock } from 'bun:test'
import type { ResolvedAgentConfig } from '@browseros/server/agent/types'
import type { LanguageModel } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { ExecutorFactory, ExecutorResult } from './types'

// The provider-level types are derived from the mock so the suite does not
// need @ai-sdk/provider as a direct dependency of this package.
type ModelDoGenerate = InstanceType<typeof MockLanguageModelV3>['doGenerate']
type ModelCallOptions = Parameters<ModelDoGenerate>[0]
type ModelGenerateResult = Awaited<ReturnType<ModelDoGenerate>>
type ModelUsage = NonNullable<ModelGenerateResult['usage']>

// ---------------------------------------------------------------------------
// Seam: scripted language models in place of the real provider factory
// ---------------------------------------------------------------------------

let scriptedModel: LanguageModel | undefined

mock.module('@browseros/server/agent/tool-loop/provider-factory', () => ({
  createLanguageModel: () => {
    if (!scriptedModel) {
      throw new Error('test bug: no scripted model was set before create()')
    }
    return scriptedModel
  },
}))

// Imported after mock.module so the subject binds to the stubbed factory.
const { OrchestratorAgent } = await import('./orchestrator-agent')

// ---------------------------------------------------------------------------
// Scripted-model helpers
// ---------------------------------------------------------------------------

function usage(): ModelUsage {
  return {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  }
}

function textResponse(text: string): ModelGenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: usage(),
    warnings: [],
  }
}

function delegateCallResponse(instruction: string): ModelGenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: `call_delegate_${Math.random().toString(36).slice(2, 8)}`,
        toolName: 'delegate',
        input: JSON.stringify({ instruction }),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: usage(),
    warnings: [],
  }
}

type ModelStepScript = (
  options: ModelCallOptions,
  stepNumber: number,
) => ModelGenerateResult | Promise<ModelGenerateResult>

/**
 * A model whose every generation call runs `script`. `script` receives the
 * real call options — including the full prompt with tool results — so tests
 * can observe exactly what the subject feeds to the model.
 */
function scriptedLanguageModel(script: ModelStepScript): LanguageModel {
  let stepNumber = 0
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      stepNumber += 1
      return script(options, stepNumber)
    },
  }) as unknown as LanguageModel
}

type PromptMessage = {
  role: string
  content: unknown
}

/** The text bodies of every tool-result the model was shown, in order. */
function toolResultTexts(prompt: PromptMessage[]): string[] {
  const texts: string[] = []
  for (const message of prompt) {
    if (message.role !== 'tool') continue
    for (const part of message.content as {
      type: string
      output?: { value?: unknown }
    }[]) {
      if (part.type === 'tool-result' && part.output) {
        texts.push(String(part.output.value))
      }
    }
  }
  return texts
}

/** The text of the user message of the model's first call. */
function firstUserText(prompt: PromptMessage[]): string {
  for (const message of prompt) {
    if (message.role !== 'user') continue
    for (const part of message.content as { type: string; text?: string }[]) {
      if (part.type === 'text' && typeof part.text === 'string') {
        return part.text
      }
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// Subject helpers
// ---------------------------------------------------------------------------

function agentConfig(
  maxTurns?: number,
): ResolvedAgentConfig & { maxTurns?: number } {
  const config: ResolvedAgentConfig = {
    conversationId: 'orchestrator-agent-contract-test',
    provider: 'openai' as ResolvedAgentConfig['provider'],
    model: 'scripted-test-model',
  }
  return maxTurns === undefined ? config : { ...config, maxTurns }
}

function executorResult(
  overrides: Partial<ExecutorResult> = {},
): ExecutorResult {
  return {
    observation: 'nothing to report',
    status: 'done',
    url: '',
    actionsPerformed: 0,
    toolsUsed: [],
    ...overrides,
  }
}

/** An executor factory that records instructions and replays one result. */
function recordingExecutor(
  result: () => ExecutorResult | Promise<ExecutorResult>,
): { factory: ExecutorFactory; instructions: string[] } {
  const instructions: string[] = []
  return {
    instructions,
    factory: async (instruction) => {
      instructions.push(instruction)
      return result()
    },
  }
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

describe('orchestratorAgentContract', () => {
  it('exercises OrchestratorAgent.create(): it returns a runnable instance', () => {
    scriptedModel = scriptedLanguageModel(() => textResponse('unused'))
    const { factory } = recordingExecutor(() => executorResult())

    const agent = OrchestratorAgent.create(agentConfig(), {
      executorFactory: factory,
    })

    expect(agent).toBeInstanceOf(OrchestratorAgent)
    expect(typeof agent.run).toBe('function')
  })

  it('exercises OrchestratorAgent.run(): a direct model answer succeeds with no delegations', async () => {
    scriptedModel = scriptedLanguageModel(() =>
      textResponse('The answer is 42.'),
    )
    const { factory, instructions } = recordingExecutor(() => executorResult())

    const result = await OrchestratorAgent.create(agentConfig(), {
      executorFactory: factory,
    }).run('What is the answer?')

    expect(result).toEqual({
      success: true,
      answer: 'The answer is 42.',
      reason: null,
      delegationCount: 0,
      totalExecutorSteps: 0,
      turns: 0,
    })
    expect(instructions).toEqual([])
  })

  it('exercises OrchestratorAgent.run(): the task query is what the model is asked, and one delegation flows end to end', async () => {
    const seenUserTexts: string[] = []
    scriptedModel = scriptedLanguageModel((options, stepNumber) => {
      if (stepNumber === 1) {
        seenUserTexts.push(firstUserText(options.prompt as PromptMessage[]))
        return delegateCallResponse('Open the HN best page')
      }
      return textResponse('Done: browsed HN best.')
    })
    const { factory, instructions } = recordingExecutor(() =>
      executorResult({
        observation: 'Opened HN best page',
        status: 'done',
        url: 'https://news.ycombinator.com/best',
        actionsPerformed: 3,
        toolsUsed: ['navigate'],
      }),
    )

    const result = await OrchestratorAgent.create(agentConfig(), {
      executorFactory: factory,
    }).run('Find the top post on HN')

    expect(seenUserTexts).toEqual(['Find the top post on HN'])
    expect(instructions).toEqual(['Open the HN best page'])
    expect(result.success).toBe(true)
    expect(result.answer).toBe('Done: browsed HN best.')
    expect(result.reason).toBeNull()
    expect(result.delegationCount).toBe(1)
    expect(result.totalExecutorSteps).toBe(3)
    expect(result.turns).toBe(1)
  })

  it('exercises OrchestratorAgent.run(): executor results are reported back to the model in the documented format', async () => {
    let modelSeenToolResults: string[] = []
    scriptedModel = scriptedLanguageModel((options, stepNumber) => {
      if (stepNumber === 1) {
        return delegateCallResponse('Open the HN best page')
      }
      modelSeenToolResults = toolResultTexts(options.prompt as PromptMessage[])
      return textResponse('Done.')
    })
    const { factory } = recordingExecutor(() =>
      executorResult({
        observation: 'Opened HN best page',
        status: 'done',
        url: 'https://news.ycombinator.com/best',
        actionsPerformed: 3,
        toolsUsed: ['navigate'],
      }),
    )

    await OrchestratorAgent.create(agentConfig(), {
      executorFactory: factory,
    }).run('Find the top post on HN')

    expect(modelSeenToolResults).toEqual([
      'Executor Result:\n- Status: done\n- Actions: 3\n- URL: https://news.ycombinator.com/best\n\nObservation:\nOpened HN best page',
    ])
  })

  it('exercises OrchestratorAgent.run(): timed-out executor results are flagged to the model and empty URLs become unknown', async () => {
    let modelSeenToolResults: string[] = []
    scriptedModel = scriptedLanguageModel((options, stepNumber) => {
      if (stepNumber === 1) {
        return delegateCallResponse('Keep scrolling')
      }
      modelSeenToolResults = toolResultTexts(options.prompt as PromptMessage[])
      return textResponse('Giving up.')
    })
    const { factory } = recordingExecutor(() =>
      executorResult({
        observation: 'Ran out of time scrolling',
        status: 'timeout',
        url: '',
        actionsPerformed: 7,
        toolsUsed: [],
      }),
    )

    const result = await OrchestratorAgent.create(agentConfig(), {
      executorFactory: factory,
    }).run('Scroll forever')

    expect(modelSeenToolResults).toEqual([
      'Executor Result:\n- Status: timeout (TIMED OUT)\n- Actions: 7\n- URL: unknown\n\nObservation:\nRan out of time scrolling',
    ])
    expect(result.success).toBe(true)
    expect(result.totalExecutorSteps).toBe(7)
  })

  it('exercises OrchestratorAgent.run(): a throwing executor becomes a failed delegation observation, not a failed run', async () => {
    let modelSeenToolResults: string[] = []
    scriptedModel = scriptedLanguageModel((options, stepNumber) => {
      if (stepNumber === 1) {
        return delegateCallResponse('Do the impossible')
      }
      modelSeenToolResults = toolResultTexts(options.prompt as PromptMessage[])
      return textResponse('Tried and reported.')
    })
    const { factory } = recordingExecutor(() => {
      throw new Error('executor exploded')
    })

    const result = await OrchestratorAgent.create(agentConfig(), {
      executorFactory: factory,
    }).run('Attempt the impossible')

    // The failure result carries status 'timeout', so it is flagged like any
    // other timed-out delegation.
    expect(modelSeenToolResults).toEqual([
      'Executor Result:\n- Status: timeout (TIMED OUT)\n- Actions: 0\n- URL: unknown\n\nObservation:\nDelegation failed: executor exploded',
    ])
    expect(result.success).toBe(true)
    expect(result.answer).toBe('Tried and reported.')
    expect(result.delegationCount).toBe(1)
    expect(result.totalExecutorSteps).toBe(0)
  })

  it('exercises OrchestratorAgent.run(): further delegations are refused once the executor step budget is spent', async () => {
    let modelSeenToolResults: string[] = []
    scriptedModel = scriptedLanguageModel((options, stepNumber) => {
      if (stepNumber <= 2) {
        return delegateCallResponse(`Instruction number ${stepNumber}`)
      }
      modelSeenToolResults = toolResultTexts(options.prompt as PromptMessage[])
      return textResponse('Stopped after the budget message.')
    })
    const { factory, instructions } = recordingExecutor(() =>
      executorResult({
        observation: 'Burned the whole budget in one go',
        status: 'done',
        url: 'https://example.com/finished',
        actionsPerformed: 300,
        toolsUsed: [],
      }),
    )

    const result = await OrchestratorAgent.create(agentConfig(), {
      executorFactory: factory,
    }).run('Spend the budget')

    // Only the first delegation reached an executor; the second was refused
    // by the step budget without launching one.
    expect(instructions).toEqual(['Instruction number 1'])
    expect(modelSeenToolResults).toHaveLength(2)
    expect(modelSeenToolResults[1]).toBe(
      'Step budget exhausted (300 steps used). Cannot delegate further.',
    )
    expect(result.success).toBe(true)
    expect(result.delegationCount).toBe(1)
    expect(result.totalExecutorSteps).toBe(300)
  })

  it('exercises OrchestratorAgent.run(): a model that never finishes falls back to the last observation and reports the turn budget', async () => {
    scriptedModel = scriptedLanguageModel((_options, stepNumber) =>
      delegateCallResponse(`Delegation ${stepNumber}`),
    )
    const { factory } = recordingExecutor(() =>
      executorResult({
        observation: 'Observation from delegation',
        status: 'done',
        url: 'https://example.com/page',
        actionsPerformed: 2,
        toolsUsed: [],
      }),
    )

    const result = await OrchestratorAgent.create(agentConfig(3), {
      executorFactory: factory,
    }).run('Never finish this')

    expect(result.success).toBe(false)
    expect(result.answer).toBe(
      'Executor Result:\n- Status: done\n- Actions: 2\n- URL: https://example.com/page\n\nObservation:\nObservation from delegation',
    )
    expect(result.reason).toBe('Exceeded maximum orchestrator turns (3)')
    expect(result.delegationCount).toBe(3)
    expect(result.turns).toBe(3)
    expect(result.totalExecutorSteps).toBe(6)
  })

  it('exercises OrchestratorAgent.run(): the turn budget defaults to 15 when maxTurns is not configured', async () => {
    scriptedModel = scriptedLanguageModel(() => delegateCallResponse('again'))
    const { factory } = recordingExecutor(() => executorResult())

    const result = await OrchestratorAgent.create(agentConfig(), {
      executorFactory: factory,
    }).run('Never finish this either')

    expect(result.success).toBe(false)
    expect(result.reason).toBe('Exceeded maximum orchestrator turns (15)')
    expect(result.delegationCount).toBe(15)
    expect(result.turns).toBe(15)
  })

  it('exercises OrchestratorAgent.run(): a model failure is reported as the reason of an unsuccessful run', async () => {
    scriptedModel = scriptedLanguageModel(() => {
      throw new Error('Model exploded')
    })
    const { factory } = recordingExecutor(() => executorResult())

    const result = await OrchestratorAgent.create(agentConfig(), {
      executorFactory: factory,
    }).run('Anything')

    expect(result).toEqual({
      success: false,
      answer: null,
      reason: 'Model exploded',
      delegationCount: 0,
      totalExecutorSteps: 0,
      turns: 0,
    })
  })

  it('exercises OrchestratorAgent.run(): an aborted signal is reported as an eval timeout', async () => {
    const abortController = new AbortController()
    // A model that, like a real provider, rejects once its request is aborted.
    scriptedModel = new MockLanguageModelV3({
      doGenerate: (options) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('test bug: model completed before the abort'))
          }, 5000)
          options.abortSignal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(
                new DOMException('This operation was aborted', 'AbortError'),
              )
            },
            { once: true },
          )
        }),
    }) as unknown as LanguageModel
    const { factory } = recordingExecutor(() => executorResult())

    setTimeout(() => abortController.abort(), 20)
    const result = await OrchestratorAgent.create(agentConfig(), {
      executorFactory: factory,
    }).run('Abort me', abortController.signal)

    expect(result).toEqual({
      success: false,
      answer: null,
      reason: 'Aborted by eval timeout',
      delegationCount: 0,
      totalExecutorSteps: 0,
      turns: 0,
    })
  })
})
