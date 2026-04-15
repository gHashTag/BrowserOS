/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Browser } from '@browseros/shared/schemas/browser'
import type { ToolSet } from 'ai'
import type { AiSdkAgent } from '../ai-sdk-agent'
import type {
  AgentStatus,
  AgentStatusResponse,
  AgentTask,
  PortableAgentConfig,
  TaskEvent,
} from './config-schema'
import { LogCollector } from './log-collector'

export interface PortableAgentDeps {
  browserosId: string
  browserContext?: Record<string, unknown>
}

export class PortableAgent {
  private agent: AiSdkAgent | null = null
  private status: AgentStatus = 'idle'
  private startTime: number | null = null
  private taskCount = 0
  private conversationId: string | null = null

  constructor(
    public readonly config: PortableAgentConfig,
    private readonly browser: Browser,
    private readonly registry: ToolSet,
    private readonly deps: PortableAgentDeps,
    private readonly logs = new LogCollector(),
  ) {
    this.logs.info(`PortableAgent initialized for '${config.metadata.name}'`, {
      displayName: config.metadata.displayName,
      model: config.spec.llm.model,
    })
  }

  async start(): Promise<void> {
    if (this.status !== 'idle' && this.status !== 'stopped') {
      this.logs.warn(`Agent already in state '${this.status}', cannot start`)
      return
    }

    this.status = 'starting'
    this.startTime = Date.now()
    this.logs.info(`Starting agent '${this.config.metadata.name}'`)

    try {
      const { AiSdkAgent } = await import('../ai-sdk-agent')

      const resolvedConfig = this.buildResolvedConfig()
      this.agent = await AiSdkAgent.create({
        resolvedConfig,
        browser: this.browser,
        registry: this.registry,
        browserContext: this.deps.browserContext,
        klavisClient: undefined,
        browserosId: this.deps.browserosId,
      })

      this.conversationId = crypto.randomUUID()
      this.status = 'idle'
      this.logs.info(
        `Agent '${this.config.metadata.name}' started successfully`,
      )
    } catch (error) {
      this.status = 'error'
      this.logs.error(`Failed to start agent '${this.config.metadata.name}'`, {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'starting') {
      return
    }

    this.logs.info(`Stopping agent '${this.config.metadata.name}'`)

    try {
      if (this.agent) {
        await this.agent.dispose()
        this.agent = null
      }

      this.status = 'stopped'
      this.startTime = null
      this.conversationId = null
      this.logs.info(`Agent '${this.config.metadata.name}' stopped`)
    } catch (error) {
      this.logs.error(`Failed to stop agent '${this.config.metadata.name}'`, {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  async dispose(): Promise<void> {
    await this.stop()
    this.logs.clear()
  }

  async sendTask(task: AgentTask): Promise<ReadableStream<TaskEvent>> {
    if (this.status !== 'idle') {
      throw new Error(`Agent not ready. Current status: ${this.status}`)
    }

    this.status = 'busy'
    this.taskCount++
    this.logs.info(`Task submitted to agent '${this.config.metadata.name}'`, {
      taskLength: task.message.length,
    })

    if (!this.agent) {
      throw new Error('Agent not initialized')
    }

    try {
      const { createAgentUIStreamResponse } = await import(
        '../../utils/agent-ui'
      )

      const stream = createAgentUIStreamResponse({
        agent: this.agent.toolLoopAgent,
        uiMessages: this.buildMessages(task),
        abortSignal: new AbortController().signal,
      })

      return new ReadableStream<TaskEvent>({
        start: async (controller) => {
          controller.enqueue({ type: 'start', taskId: crypto.randomUUID() })

          const reader = stream.getReader()
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              if (value?.delta) {
                controller.enqueue({
                  type: 'text-delta',
                  text: value.delta,
                })
              }

              if (value?.toolCallStart) {
                controller.enqueue({
                  type: 'tool-start',
                  toolName: value.toolCallStart.name,
                  args: value.toolCallStart.args,
                })
              }

              if (value?.toolCallEnd) {
                controller.enqueue({
                  type: 'tool-end',
                  toolName: value.toolCallEnd.name,
                  result: value.toolCallEnd.result,
                })
              }

              if (value?.done) {
                controller.enqueue({
                  type: 'done',
                  result: value.done,
                })
                break
              }

              if (value?.error) {
                controller.enqueue({
                  type: 'error',
                  error: value.error.message || 'Unknown error',
                })
                break
              }
            }
          } finally {
            this.status = 'idle'
            controller.close()
          }
        },
      })
    } catch (error) {
      this.status = 'error'
      this.logs.error(`Task execution failed`, {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  getStatus(): AgentStatusResponse {
    const uptime = this.startTime
      ? Math.floor((Date.now() - this.startTime) / 1000)
      : null

    return {
      name: this.config.metadata.name,
      status: this.status,
      uptime,
      taskCount: this.taskCount,
      lastActivity: this.logs.getRecent(1)[0]?.timestamp || null,
      error:
        this.status === 'error'
          ? this.logs
              .getRecent(5)
              .reverse()
              .find((l) => l.level === 'error')?.message || null
          : null,
      config: {
        displayName: this.config.metadata.displayName,
        model: this.config.spec.llm.model,
        provider: this.config.spec.llm.provider,
      },
    }
  }

  getLogs(): Array<ReturnType<LogCollector['get']>> {
    return this.logs.get()
  }

  getLogsStream(): ReadableStream<ReturnType<LogCollector['get']>> {
    return new ReadableStream({
      start: (controller) => {
        const _unsubscribe = this.logs.onLogEntry((entry) => {
          controller.enqueue([entry])
        })
      },
    })
  }

  private buildResolvedConfig() {
    const apiKey = this.resolveApiKey()
    const baseUrl = this.config.spec.llm.baseUrl

    return {
      conversationId: this.conversationId || crypto.randomUUID(),
      provider: this.config.spec.llm.provider as any,
      model: this.config.spec.llm.model,
      apiKey,
      baseUrl,
      userSystemPrompt: this.config.spec.systemPrompt,
      workingDir: this.config.spec.workspace?.defaultDir,
      supportsImages: true,
      evalMode: false,
      chatMode: false,
      isScheduledTask: false,
      origin: 'sidepanel',
      browserosId: this.deps.browserosId,
      toolApprovalConfig: undefined,
    }
  }

  private buildMessages(task: AgentTask) {
    const messages = [
      {
        role: 'user',
        content: task.message,
      },
    ]

    if (task.context?.browserContext) {
      messages.unshift({
        role: 'system',
        content: JSON.stringify(task.context.browserContext),
      })
    }

    return messages
  }

  private resolveApiKey(): string | undefined {
    const { apiKey } = this.config.spec.llm

    if (!apiKey) {
      if (this.deps.browserContext?.apiKey) {
        return this.deps.browserContext.apiKey as string
      }
      return undefined
    }

    const match = apiKey.match(/^\${([^}]+)}$/)
    if (!match) return apiKey

    const envVar = match[1]
    return process.env[envVar]
  }
}
