import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_TIMEOUT_MS } from '../../constants'
import type { ClaudeCodeAgentConfig, UIMessageStreamEvent } from '../../types'
import { withEvalTimeout } from '../../utils/with-eval-timeout'
import type { AgentContext, AgentEvaluator, AgentResult } from '../types'
import {
  type ClaudeCodeProcessRunner,
  createClaudeCodeProcessRunner,
} from './process-runner'
import {
  ClaudeCodeStreamParser,
  shouldCaptureScreenshotForTool,
} from './stream-parser'

export interface ClaudeCodeEvaluatorDeps {
  processRunner?: ClaudeCodeProcessRunner
}

export class ClaudeCodeEvaluator implements AgentEvaluator {
  private processRunner: ClaudeCodeProcessRunner

  constructor(
    private ctx: AgentContext,
    deps: ClaudeCodeEvaluatorDeps = {},
  ) {
    this.processRunner = deps.processRunner ?? createClaudeCodeProcessRunner()
  }

  async execute(): Promise<AgentResult> {
    const { config, task, capture, taskOutputDir } = this.ctx
    const startTime = Date.now()
    const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS

    await capture.messageLogger.logUser(task.query)

    if (config.agent.type !== 'claude-code') {
      throw new Error('ClaudeCodeEvaluator only supports claude-code config')
    }
    const agentConfig = config.agent

    const mcpConfigPath = join(taskOutputDir, 'claude-code-mcp.json')
    await writeFile(
      mcpConfigPath,
      JSON.stringify(
        buildClaudeCodeMcpConfig(config.browseros.server_url),
        null,
        2,
      ),
    )

    const parser = new ClaudeCodeStreamParser()
    const toolNamesById = new Map<string, string>()
    const prompt = buildClaudeCodePrompt(task.query)
    const args = buildClaudeCodeArgs({
      prompt,
      mcpConfigPath,
      config: agentConfig,
    })

    const { terminationReason } = await withEvalTimeout(
      timeoutMs,
      capture,
      async (signal) => {
        const runResult = await this.processRunner.run({
          executable: agentConfig.claudePath,
          args,
          cwd: taskOutputDir,
          signal,
          onStdoutLine: async (line) => {
            const events = parser.pushLine(line)
            for (const event of events) {
              await this.handleStreamEvent(event, toolNamesById)
            }
          },
        })

        if (runResult.exitCode !== 0) {
          const message =
            runResult.stderr.trim() ||
            `Claude Code exited with status ${runResult.exitCode}`
          capture.addError('agent_execution', message, {
            exitCode: runResult.exitCode,
          })
          if (!parser.getLastText()) {
            throw new Error(message)
          }
        }

        for (const error of runResult.streamErrors ?? []) {
          capture.addWarning(
            'message_logging',
            `Claude Code stream event processing failed: ${error}`,
          )
        }

        return runResult
      },
    )

    const endTime = Date.now()
    const finalAnswer = parser.getLastText() ?? capture.getLastAssistantText()
    const metadata = {
      query_id: task.query_id,
      dataset: task.dataset,
      query: task.query,
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date(endTime).toISOString(),
      total_duration_ms: endTime - startTime,
      total_steps: parser.getToolCallCount() || capture.getScreenshotCount(),
      termination_reason: terminationReason,
      final_answer: finalAnswer,
      errors: capture.getErrors(),
      warnings: capture.getWarnings(),
      device_pixel_ratio: capture.screenshot.getDevicePixelRatio(),
      agent_config: {
        type: 'claude-code' as const,
        model: agentConfig.model,
      },
      grader_results: {},
    }

    await capture.trajectorySaver.saveMetadata(metadata)

    return {
      metadata,
      messages: capture.getMessages(),
      finalAnswer,
    }
  }

  private async handleStreamEvent(
    event: UIMessageStreamEvent,
    toolNamesById: Map<string, string>,
  ): Promise<void> {
    const { capture, task } = this.ctx
    let screenshot: number | undefined

    if (event.type === 'tool-input-available') {
      toolNamesById.set(event.toolCallId, event.toolName)
      if (isPageInput(event.input)) {
        capture.setActivePageId(event.input.page)
      }
    }

    if (
      event.type === 'tool-output-available' ||
      event.type === 'tool-output-error'
    ) {
      const toolName = toolNamesById.get(event.toolCallId)
      if (toolName && shouldCaptureScreenshotForTool(toolName)) {
        screenshot = await this.captureScreenshot()
      }
    }

    await capture.messageLogger.logStreamEvent(event, screenshot)
    capture.emitEvent(task.query_id, {
      ...event,
      ...(screenshot !== undefined && { screenshot }),
    })
  }

  private async captureScreenshot(): Promise<number | undefined> {
    const { capture, task } = this.ctx
    try {
      const screenshot = await capture.screenshot.capture(
        capture.getActivePageId(),
      )
      capture.emitEvent(task.query_id, {
        type: 'screenshot-captured',
        screenshot,
      })
      return screenshot
    } catch {
      return undefined
    }
  }
}

function isPageInput(input: unknown): input is { page: number } {
  return (
    typeof input === 'object' &&
    input !== null &&
    'page' in input &&
    typeof input.page === 'number'
  )
}

function buildClaudeCodePrompt(taskQuery: string): string {
  return [
    'You are running inside BrowserOS eval.',
    'Use the BrowserOS MCP tools to interact with the already-open browser and complete the user task.',
    'When the task is complete, respond with the final answer only.',
    'If blocked, explain the blocker clearly.',
    '',
    `Task: ${taskQuery}`,
  ].join('\n')
}

function buildClaudeCodeArgs({
  prompt,
  mcpConfigPath,
  config,
}: {
  prompt: string
  mcpConfigPath: string
  config: ClaudeCodeAgentConfig
}): string[] {
  const args = [
    '-p',
    prompt,
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--output-format',
    'stream-json',
    '--verbose',
  ]

  if (config.model) args.push('--model', config.model)
  args.push(...config.extraArgs)

  return args
}

function buildClaudeCodeMcpConfig(serverUrl: string) {
  const trimmed = serverUrl.replace(/\/$/, '')
  const url = trimmed.endsWith('/mcp') ? trimmed : `${trimmed}/mcp`
  return {
    mcpServers: {
      browseros: {
        type: 'http',
        url,
        headers: { 'X-BrowserOS-Source': 'sdk-internal' },
      },
    },
  }
}
