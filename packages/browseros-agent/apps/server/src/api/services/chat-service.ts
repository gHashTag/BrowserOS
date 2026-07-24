/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createAgentUIStreamResponse, type UIMessage } from 'ai'
import { AiSdkAgent, type AiSdkAgentConfig } from '../../agent/ai-sdk-agent'
import { formatUserMessage } from '../../agent/format-message'
import {
  filterValidMessages,
  sanitizeMessagesForToolset,
} from '../../agent/message-validation'
import {
  deriveSessionExecutionFingerprint,
  type SessionExecutionFingerprint,
} from '../../agent/session-fingerprint'
import type { AgentSession, SessionStore } from '../../agent/session-store'
import type { ResolvedAgentConfig } from '../../agent/types'
import type { Browser } from '../../browser/browser'
import { resolveLLMConfig } from '../../lib/clients/llm/config'
import { logger } from '../../lib/logger'
import type { ToolRegistry } from '../../tools/tool-registry'
import type { KlavisProxyRef } from '../services/klavis/strata-proxy'
import type { ChatRequest } from '../types'
import {
  buildApprovalConfigKey,
  buildContextChanges,
  buildMcpServerKey,
  resolveEffectiveBrowserContext,
} from './chat-session-context'

export interface ChatServiceDeps {
  sessionStore: SessionStore
  klavisRef?: KlavisProxyRef
  browser: Browser
  registry: ToolRegistry
  browserosId?: string
  aiSdkDevtoolsEnabled?: boolean
}

export class ChatService {
  constructor(private deps: ChatServiceDeps) {}

  async processMessage(
    request: ChatRequest,
    abortSignal: AbortSignal,
  ): Promise<Response> {
    const { sessionStore } = this.deps

    const llmConfig = await resolveLLMConfig(request, this.deps.browserosId)
    const resolvedConfig: ResolvedAgentConfig = {
      conversationId: request.conversationId,
      provider: llmConfig.provider,
      model: llmConfig.model,
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      upstreamProvider: llmConfig.upstreamProvider,
      resourceName: llmConfig.resourceName,
      region: llmConfig.region,
      accessKeyId: llmConfig.accessKeyId,
      secretAccessKey: llmConfig.secretAccessKey,
      sessionToken: llmConfig.sessionToken,
      accountId: llmConfig.accountId,
      reasoningEffort: request.reasoningEffort,
      reasoningSummary: request.reasoningSummary,
      contextWindowSize: request.contextWindowSize,
      userSystemPrompt: request.userSystemPrompt,
      workingDir: request.userWorkingDir,
      supportsImages: request.supportsImages,
      chatMode: request.mode === 'chat',
      isScheduledTask: request.isScheduledTask,
      origin: request.origin,
      declinedApps: request.declinedApps,
      browserosId: this.deps.browserosId,
      toolApprovalConfig: request.toolApprovalConfig,
    }

    let session = sessionStore.get(request.conversationId)
    let isNewSession = false
    const contextChanges: string[] = []
    const { browserContext, hiddenPageId, newlyCreatedHiddenPageId } =
      await resolveEffectiveBrowserContext(this.deps.browser, request, session)
    const aiSdkAgentConfig: AiSdkAgentConfig = {
      resolvedConfig,
      browser: this.deps.browser,
      registry: this.deps.registry,
      browserContext,
      klavisRef: this.deps.klavisRef,
      browserosId: this.deps.browserosId,
      aiSdkDevtoolsEnabled: this.deps.aiSdkDevtoolsEnabled,
      aclRules: request.aclRules,
    }

    let executionFingerprint: SessionExecutionFingerprint
    try {
      executionFingerprint = deriveSessionExecutionFingerprint(aiSdkAgentConfig)
    } catch (error) {
      if (newlyCreatedHiddenPageId !== undefined) {
        this.closeHiddenPage(newlyCreatedHiddenPageId, request.conversationId)
      }
      throw error
    }

    // Legacy keys remain only for human-readable context-change notices.
    const mcpServerKey = buildMcpServerKey(
      browserContext,
      Boolean(this.deps.klavisRef?.handle),
    )
    const approvalConfigKey = buildApprovalConfigKey(request.toolApprovalConfig)
    const mcpChanged = session?.mcpServerKey !== mcpServerKey
    const workspaceChanged = session?.workingDir !== request.userWorkingDir
    const approvalChanged = session?.approvalConfigKey !== approvalConfigKey
    const pendingContextChanges = session
      ? buildContextChanges(
          session,
          request,
          mcpServerKey,
          mcpChanged,
          workspaceChanged,
        )
      : []

    if (session && session.executionFingerprint !== executionFingerprint) {
      const changedCategories = [
        ...(approvalChanged ? ['approval'] : []),
        'execution-config',
        ...(mcpChanged ? ['mcp'] : []),
        ...(workspaceChanged ? ['workspace'] : []),
      ]
      logger.info(
        'Execution fingerprint changed mid-conversation, rebuilding session',
        {
          conversationId: request.conversationId,
          previousFingerprint: session.executionFingerprint,
          currentFingerprint: executionFingerprint,
          changedCategories,
        },
      )
      session = await this.rebuildSession(
        session,
        request,
        aiSdkAgentConfig,
        executionFingerprint,
        hiddenPageId,
        mcpServerKey,
        approvalConfigKey,
      )
      contextChanges.push(...pendingContextChanges)
    }

    if (!session) {
      isNewSession = true
      let agent: AiSdkAgent
      try {
        agent = await AiSdkAgent.create(aiSdkAgentConfig)
      } catch (error) {
        if (newlyCreatedHiddenPageId !== undefined) {
          this.closeHiddenPage(newlyCreatedHiddenPageId, request.conversationId)
        }
        throw error
      }
      session = {
        agent,
        executionFingerprint,
        hiddenPageId,
        browserContext,
        mcpServerKey,
        workingDir: request.userWorkingDir,
        approvalConfigKey,
      }
      sessionStore.set(request.conversationId, session)
    }

    session.agent.updateAclRules(request.aclRules)

    if (isNewSession && request.previousConversation?.length) {
      for (const msg of request.previousConversation) {
        if (!msg.content.trim()) continue
        session.agent.messages.push({
          id: crypto.randomUUID(),
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          parts: [{ type: 'text', text: msg.content }],
        })
      }
      logger.info('Injected previous conversation history', {
        conversationId: request.conversationId,
        messageCount: request.previousConversation.length,
      })
    }

    // Handle tool approval responses: patch the agent's messages and re-run
    if (request.toolApprovalResponses?.length) {
      this.applyToolApprovalResponses(
        session.agent.messages,
        request.toolApprovalResponses,
      )
      logger.info('Applied tool approval responses', {
        conversationId: request.conversationId,
        count: request.toolApprovalResponses.length,
      })
      return createAgentUIStreamResponse({
        agent: session.agent.toolLoopAgent,
        uiMessages: filterValidMessages(session.agent.messages),
        abortSignal,
        onFinish: async ({ messages }: { messages: UIMessage[] }) => {
          session.agent.messages = filterValidMessages(messages)
        },
      })
    }

    const userContent = formatUserMessage(
      request.message,
      browserContext,
      request.selectedText,
      request.selectedTextSource,
    )

    // Prepend tool-change context when session was rebuilt mid-conversation
    const contextPrefix =
      contextChanges.length > 0
        ? `${contextChanges.map((c) => `[Context: ${c}]`).join('\n')}\n\n`
        : ''

    // Persist the *raw* user text in session.agent.messages so it
    // round-trips clean to the client's useChat state and to any
    // future history reload. The wrapped form (browser context +
    // <selected_text> + <USER_QUERY>) is built as a transient prompt
    // copy below — the LLM sees it, the user-visible state never
    // does.
    session.agent.appendUserMessage(request.message)
    const promptUserText = contextPrefix + userContent
    const wrappedUserMessageId =
      session.agent.messages[session.agent.messages.length - 1]?.id

    const promptUiMessages = filterValidMessages(session.agent.messages).map(
      (msg) =>
        msg.id === wrappedUserMessageId && msg.role === 'user'
          ? {
              ...msg,
              parts: [{ type: 'text' as const, text: promptUserText }],
            }
          : msg,
    )

    return createAgentUIStreamResponse({
      agent: session.agent.toolLoopAgent,
      uiMessages: promptUiMessages,
      abortSignal,
      onFinish: async ({ messages }: { messages: UIMessage[] }) => {
        // The agent loop returns `messages` containing the prompt-
        // wrapped user text. Restore the raw form before persisting
        // so subsequent turns see the clean text and the client's
        // local UIMessage matches what was originally typed.
        const restored = messages.map((msg) =>
          msg.id === wrappedUserMessageId && msg.role === 'user'
            ? {
                ...msg,
                parts: [{ type: 'text' as const, text: request.message }],
              }
            : msg,
        )
        session.agent.messages = filterValidMessages(restored)
        logger.info('Agent execution complete', {
          conversationId: request.conversationId,
          totalMessages: restored.length,
        })

        if (session?.hiddenPageId) {
          const pageId = session.hiddenPageId
          session.hiddenPageId = undefined
          this.closeHiddenPage(pageId, request.conversationId)
        }
      },
    })
  }

  async deleteSession(
    conversationId: string,
  ): Promise<{ deleted: boolean; sessionCount: number }> {
    const session = this.deps.sessionStore.get(conversationId)
    if (session?.hiddenPageId) {
      const pageId = session.hiddenPageId
      session.hiddenPageId = undefined
      this.closeHiddenPage(pageId, conversationId)
    }
    const deleted = await this.deps.sessionStore.delete(conversationId)
    return { deleted, sessionCount: this.deps.sessionStore.count() }
  }

  private closeHiddenPage(pageId: number, conversationId: string): void {
    this.deps.browser.closePage(pageId).catch((error) => {
      logger.warn('Failed to close hidden page', {
        pageId,
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private async rebuildSession(
    session: AgentSession,
    request: ChatRequest,
    aiSdkAgentConfig: AiSdkAgentConfig,
    executionFingerprint: SessionExecutionFingerprint,
    hiddenPageId: number | undefined,
    mcpServerKey: string,
    approvalConfigKey: string,
  ): Promise<AgentSession> {
    const previousMessages = [...session.agent.messages]
    const agent = await AiSdkAgent.create(aiSdkAgentConfig)
    try {
      agent.messages = sanitizeMessagesForToolset(
        previousMessages,
        agent.toolNames,
      )
    } catch (error) {
      await this.disposeUnusedReplacement(agent, request.conversationId)
      throw error
    }

    const newSession: AgentSession = {
      agent,
      executionFingerprint,
      hiddenPageId,
      browserContext: aiSdkAgentConfig.browserContext,
      mcpServerKey,
      workingDir: request.userWorkingDir,
      approvalConfigKey,
    }

    try {
      await session.agent.dispose()
    } catch (error) {
      await this.disposeUnusedReplacement(agent, request.conversationId)
      throw error
    }
    try {
      this.deps.sessionStore.set(request.conversationId, newSession)
    } catch (error) {
      await this.disposeUnusedReplacement(agent, request.conversationId)
      throw error
    }

    return newSession
  }

  private async disposeUnusedReplacement(
    agent: AiSdkAgent,
    conversationId: string,
  ): Promise<void> {
    try {
      await agent.dispose()
    } catch {
      logger.warn('Failed to dispose unused replacement agent', {
        conversationId,
      })
    }
  }

  private applyToolApprovalResponses(
    messages: UIMessage[],
    responses: Array<{
      approvalId: string
      approved: boolean
      reason?: string
    }>,
  ): void {
    const responseMap = new Map(responses.map((r) => [r.approvalId, r]))
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      for (const part of msg.parts) {
        const toolPart = part as {
          state?: string
          approval?: { id: string; approved?: boolean; reason?: string }
        }
        if (
          toolPart.state === 'approval-requested' &&
          toolPart.approval?.id &&
          responseMap.has(toolPart.approval.id)
        ) {
          const resp = responseMap.get(toolPart.approval.id)
          if (!resp) continue
          toolPart.state = 'approval-responded'
          toolPart.approval = {
            ...toolPart.approval,
            approved: resp.approved,
            reason: resp.reason,
          }
        }
      }
    }
  }
}
