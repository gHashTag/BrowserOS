/**
 * Executor - Wraps AiSdkAgent for page-level browser actions (direct CDP)
 *
 * The executor:
 * - Receives goal-level instructions from orchestrator
 * - Executes browser actions until the goal is accomplished
 * - Returns observation to orchestrator (not full history)
 */

import { randomUUID } from 'node:crypto'
import { AiSdkAgent } from '@trios/server/agent/tool-loop'
import type { ResolvedAgentConfig } from '@trios/server/agent/types'
import type { Browser } from '@trios/server/browser'
import { registry } from '@trios/server/tools/registry'
import type { BrowserContext } from '@trios/shared/schemas/browser-context'
import { CladoActionExecutor } from './clado-action-executor'
import type { ExecutorResult } from './types'

const EXECUTOR_SYSTEM_PROMPT = `You are a browser executor. You receive a single goal-level instruction and execute it using browser tools.

## Your Job
1. Execute browser actions to achieve the given goal
2. Stop as soon as the goal is accomplished — do NOT perform extra actions
3. Write a final observation describing the result

## Final Response Format
When done, your response MUST include:
- What you accomplished (or what went wrong)
- What the page currently shows: key headings, links, data, or content visible
- The current URL from the address bar
- If you got stuck, what is blocking progress

## Rules
- Only do what was asked. Do not navigate away, open extra tabs, or reorganize the browser.
- If the goal is to navigate somewhere, confirm you arrived by describing what you see.
- If the goal is to click something, confirm the result of the click.
- If you cannot find what was asked for, say so clearly — do not guess or improvise.
- Prefer browser_navigate over browser_open_tab for going to URLs.
- Do NOT call browser_group_tabs or other organizational tools.`

export interface ToolCallInfo {
  toolCallId: string
  toolName: string
  input: unknown
}

export interface ToolResultInfo {
  toolCallId: string
  toolName: string
  output: unknown
}

export interface ExecutorCallbacks {
  onToolCallStart?: (toolCall: ToolCallInfo) => void
  onToolCallFinish?: () => Promise<void>
  onStepFinish?: (step: {
    toolCalls?: ReadonlyArray<ToolCallInfo>
    toolResults?: ReadonlyArray<ToolResultInfo>
    text?: string
  }) => Promise<void>
}

export class Executor {
  private cladoExecutor: CladoActionExecutor | null = null
  private stepsUsed = 0
  private currentUrl = ''
  private configTemplate: ResolvedAgentConfig
  private isCladoAction: boolean
  private browser: Browser | null
  private serverUrl: string
  private windowId?: number
  private tabId?: number
  private initialPageId?: number
  private callbacks: ExecutorCallbacks

  constructor(
    configTemplate: ResolvedAgentConfig,
    browser: Browser | null,
    serverUrl: string,
    options?: {
      isCladoAction?: boolean
      windowId?: number
      tabId?: number
      initialPageId?: number
      callbacks?: ExecutorCallbacks
    },
  ) {
    this.configTemplate = configTemplate
    this.isCladoAction = options?.isCladoAction ?? false
    this.browser = browser
    this.serverUrl = serverUrl
    this.windowId = options?.windowId
    this.tabId = options?.tabId
    this.initialPageId = options?.initialPageId
    this.callbacks = options?.callbacks ?? {}
  }

  async execute(
    instruction: string,
    signal?: AbortSignal,
  ): Promise<ExecutorResult> {
    if (this.isCladoAction) {
      if (!this.cladoExecutor) {
        this.cladoExecutor = new CladoActionExecutor(
          {
            provider: this.configTemplate.provider,
            model: this.configTemplate.model,
            apiKey: this.configTemplate.apiKey ?? '',
            baseUrl: this.configTemplate.baseUrl,
          },
          this.serverUrl,
          this.windowId,
          this.tabId,
          this.initialPageId,
        )
        this.cladoExecutor.setCallbacks(this.callbacks)
      }

      const result = await this.cladoExecutor.execute(instruction, signal)
      this.stepsUsed = this.cladoExecutor.getTotalSteps()
      this.currentUrl = result.url || this.currentUrl
      return result
    }

    if (!this.browser) {
      throw new Error('Browser instance is required for standard executor path')
    }

    const stepsAtStart = this.stepsUsed
    const toolsUsed: string[] = []
    let status: 'done' | 'blocked' | 'timeout' = 'done'
    let resultText = ''

    const conversationId = randomUUID()
    const agentConfig: ResolvedAgentConfig = {
      ...this.configTemplate,
      conversationId,
      userSystemPrompt: EXECUTOR_SYSTEM_PROMPT,
      evalMode: true,
      workingDir: `/tmp/trios-eval-executor-${conversationId}`,
    }

    // Build browser context so executor agent knows the correct page ID
    let browserContext: BrowserContext | undefined
    if (this.browser) {
      const pages = await this.browser.listPages()
      const activePage = pages[0]
      if (activePage) {
        browserContext = {
          activeTab: {
            id: activePage.tabId,
            pageId: activePage.pageId,
            url: activePage.url,
            title: activePage.title,
          },
        }
      }
    }

    let agent: AiSdkAgent | null = null

    try {
      agent = await AiSdkAgent.create({
        resolvedConfig: agentConfig,
        browser: this.browser,
        registry,
        browserContext,
      })

      await agent.toolLoopAgent.generate({
        prompt: instruction,
        abortSignal: signal,

        experimental_onToolCallStart: ({ toolCall }) => {
          const input = toolCall.input as Record<string, unknown> | undefined
          if (input && typeof input.url === 'string' && input.url.length > 0) {
            this.currentUrl = input.url
          }
          this.callbacks.onToolCallStart?.({
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: toolCall.input,
          })
        },

        experimental_onToolCallFinish: async () => {
          this.stepsUsed++
          await this.callbacks.onToolCallFinish?.()
        },

        onStepFinish: async ({ toolCalls, toolResults, text }) => {
          if (toolCalls) {
            for (const tc of toolCalls) {
              if (!toolsUsed.includes(tc.toolName)) {
                toolsUsed.push(tc.toolName)
              }
            }
          }

          if (text) {
            resultText = text
          }

          await this.callbacks.onStepFinish?.({ toolCalls, toolResults, text })
        },
      })
    } catch {
      if (signal?.aborted) {
        status = 'timeout'
      } else {
        status = 'blocked'
      }
    } finally {
      if (agent) await agent.dispose().catch(() => {})
    }

    if (status === 'done' && signal?.aborted) {
      status = 'timeout'
    }

    const observation =
      resultText || 'Execution completed with no actions taken.'

    return {
      observation,
      status,
      url: this.currentUrl,
      actionsPerformed: this.stepsUsed - stepsAtStart,
      toolsUsed,
    }
  }

  async close(): Promise<void> {
    await this.cladoExecutor?.close()
  }

  getTotalSteps(): number {
    if (this.isCladoAction) {
      return this.cladoExecutor?.getTotalSteps() ?? 0
    }
    return this.stepsUsed
  }
}
