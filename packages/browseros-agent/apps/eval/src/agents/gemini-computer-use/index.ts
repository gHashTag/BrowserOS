/**
 * Gemini Computer Use Evaluator
 * Implements AgentEvaluator interface for the eval framework
 */

import { DEFAULT_TIMEOUT_MS } from '../../constants'
import type { GeminiComputerUseConfig, TaskMetadata } from '../../types'
import { resolveEnvValue } from '../../utils/resolve-env'
import { withEvalTimeout } from '../../utils/with-eval-timeout'
import type { AgentContext, AgentEvaluator, AgentResult } from '../types'
import { GeminiComputerUseAgent } from './agent'
import { DEFAULTS } from './types'

export class GeminiComputerUseEvaluator implements AgentEvaluator {
  constructor(private ctx: AgentContext) {}

  async execute(): Promise<AgentResult> {
    const { config, task, capture, windowId = 0, tabId = 0 } = this.ctx
    const agentConfig = config.agent as GeminiComputerUseConfig

    const startTime = Date.now()
    const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS

    await capture.messageLogger.logUser(task.query)

    const apiKey = resolveEnvValue(agentConfig.apiKey)
    if (!apiKey) {
      throw new Error(
        `API key not found. Set ${agentConfig.apiKey} environment variable or provide the key directly.`,
      )
    }

    const agent = new GeminiComputerUseAgent({
      apiKey,
      turnLimit: agentConfig.turnLimit ?? DEFAULTS.turnLimit,
      screenSize: agentConfig.screenSize ?? DEFAULTS.screenSize,
      tabId,
      windowId,
      mcpUrl: `${config.trios.server_url}/mcp`,
    })

    agent.setActionHook(async (_action, _result) => {
      try {
        await capture.screenshot.capture(capture.getActivePageId())
      } catch (err) {
        console.warn('Screenshot capture failed in hook:', err)
      }
    })

    const streamWriter = capture.createStreamWriter()

    let finalText: string | null = null
    let totalActions = 0

    const { terminationReason } = await withEvalTimeout(
      timeoutMs,
      capture,
      async (signal) => {
        const result = await agent.execute(task.query, streamWriter, signal)
        finalText = result.finalText
        totalActions = result.totalActions
        return result
      },
    )

    const endTime = Date.now()

    const metadata: TaskMetadata = {
      query_id: task.query_id,
      dataset: task.dataset,
      query: task.query,
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date(endTime).toISOString(),
      total_duration_ms: endTime - startTime,
      total_steps: totalActions,
      termination_reason: terminationReason,
      final_answer: finalText ?? capture.getLastAssistantText(),
      errors: capture.getErrors(),
      warnings: capture.getWarnings(),
      agent_config: {
        type: 'gemini-computer-use',
        model: DEFAULTS.model,
        turnLimit: agentConfig.turnLimit ?? DEFAULTS.turnLimit,
        screenSize: agentConfig.screenSize ?? DEFAULTS.screenSize,
      },
      grader_results: {},
    }

    await capture.trajectorySaver.saveMetadata(metadata)

    return {
      metadata,
      messages: capture.getMessages(),
      finalAnswer: finalText ?? capture.getLastAssistantText(),
    }
  }
}
