/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { consumeStream, createAgentUIStreamResponse, type UIMessage } from 'ai'
import { AiSdkAgent, type AiSdkAgentConfig } from '../../agent/ai-sdk-agent'
import { formatUserMessage } from '../../agent/format-message'
import { filterValidMessages } from '../../agent/message-validation'
import {
  deriveSessionExecutionFingerprint,
  type SessionExecutionFingerprint,
} from '../../agent/session-fingerprint'
import type { AgentSession, SessionStore } from '../../agent/session-store'
import type { ResolvedAgentConfig } from '../../agent/types'
import type { Browser } from '../../browser/browser'
import { resolveLLMConfig } from '../../lib/clients/llm/config'
import type { ToolRegistry } from '../../tools/tool-registry'
import type { KlavisProxyRef } from '../services/klavis/strata-proxy'
import type { ChatRequest } from '../types'
import {
  acquireOwnedChatRun,
  applyToolApprovalResponses,
  failOwnedChatRun,
  finishOwnedChatRun,
  ownsChatRun,
  restoreUserMessage,
} from './chat-run-lifecycle'
import {
  buildApprovalConfigKey,
  buildContextChanges,
  buildMcpServerKey,
  resolveEffectiveBrowserContext,
} from './chat-session-context'
import {
  logInfoSafely,
  logWarningSafely,
  rebuildSessionAtomically,
} from './chat-session-rebuild'

export interface ChatServiceDeps {
  sessionStore: SessionStore
  klavisRef?: KlavisProxyRef
  browser: Browser
  registry: ToolRegistry
  browserosId?: string
  aiSdkDevtoolsEnabled?: boolean
}

function runOnce(keys: Set<number>, key: number, action: () => void): void {
  if (keys.has(key)) return
  keys.add(key)
  action()
}

function injectPreviousConversation(
  session: AgentSession,
  request: ChatRequest,
): void {
  const previousConversation = request.previousConversation
  if (!previousConversation?.length) return
  for (const message of previousConversation) {
    if (!message.content.trim()) continue
    session.agent.messages.push({
      id: crypto.randomUUID(),
      role: message.role === 'assistant' ? 'assistant' : 'user',
      parts: [{ type: 'text', text: message.content }],
    })
  }
  logInfoSafely('Injected previous conversation history', {
    conversationId: request.conversationId,
    messageCount: previousConversation.length,
  })
}

export class ChatService {
  constructor(private deps: ChatServiceDeps) {}

  async processMessage(
    request: ChatRequest,
    abortSignal: AbortSignal,
  ): Promise<Response> {
    const { sessionStore } = this.deps
    const ownedRun = acquireOwnedChatRun(sessionStore, request)
    let session = sessionStore.get(request.conversationId)
    let newlyCreatedHiddenPageId: number | undefined
    let messageSnapshot: UIMessage[] | undefined
    let ownsSessionHiddenPage = false
    const closedPageIds = new Set<number>()
    const clearRunEvidence = (): void => {
      session?.agent.setEvidenceSink(undefined)
    }
    const closeRunHiddenPage = (): void => {
      const pageId =
        (ownsSessionHiddenPage ? session?.hiddenPageId : undefined) ??
        newlyCreatedHiddenPageId
      if (pageId === undefined) return
      if (session?.hiddenPageId === pageId) {
        session.hiddenPageId = undefined
      }
      runOnce(closedPageIds, pageId, () => {
        this.closeHiddenPage(pageId, request.conversationId)
      })
    }

    try {
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
      const effectiveContext = await resolveEffectiveBrowserContext(
        this.deps.browser,
        request,
        session,
      )
      const { browserContext, hiddenPageId } = effectiveContext
      newlyCreatedHiddenPageId = effectiveContext.newlyCreatedHiddenPageId
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
      const executionFingerprint =
        deriveSessionExecutionFingerprint(aiSdkAgentConfig)

      const mcpServerKey = buildMcpServerKey(
        browserContext,
        Boolean(this.deps.klavisRef?.handle),
      )
      const approvalConfigKey = buildApprovalConfigKey(
        request.toolApprovalConfig,
      )
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
      const contextChanges: string[] = []

      if (
        !ownedRun.isApprovalContinuation &&
        session &&
        session.executionFingerprint !== executionFingerprint
      ) {
        logInfoSafely(
          'Execution fingerprint changed mid-conversation, rebuilding session',
          {
            conversationId: request.conversationId,
            previousFingerprint: session.executionFingerprint,
            currentFingerprint: executionFingerprint,
            changedCategories: [
              ...(approvalChanged ? ['approval'] : []),
              'execution-config',
              ...(mcpChanged ? ['mcp'] : []),
              ...(workspaceChanged ? ['workspace'] : []),
            ],
          },
        )
        session = await this.rebuildChangedSession({
          session,
          request,
          aiSdkAgentConfig,
          executionFingerprint,
          hiddenPageId,
          mcpServerKey,
          approvalConfigKey,
        })
        contextChanges.push(...pendingContextChanges)
      }

      let isNewSession = false
      if (!session) {
        isNewSession = true
        session = {
          agent: await AiSdkAgent.create(aiSdkAgentConfig),
          executionFingerprint,
          hiddenPageId,
          browserContext,
          mcpServerKey,
          workingDir: request.userWorkingDir,
          approvalConfigKey,
        }
        sessionStore.set(request.conversationId, session)
      }
      ownsSessionHiddenPage = true
      session.agent.updateAclRules(request.aclRules)

      if (isNewSession) injectPreviousConversation(session, request)
      messageSnapshot = structuredClone(session.agent.messages)

      let wrappedUserMessageId: string | undefined
      let promptUiMessages: UIMessage[]
      if (ownedRun.isApprovalContinuation) {
        applyToolApprovalResponses(
          session.agent.messages,
          request.toolApprovalResponses ?? [],
        )
        promptUiMessages = filterValidMessages(session.agent.messages)
        logInfoSafely('Applied tool approval responses', {
          conversationId: request.conversationId,
          count: request.toolApprovalResponses?.length ?? 0,
        })
      } else {
        const userContent = formatUserMessage(
          request.message,
          browserContext,
          request.selectedText,
          request.selectedTextSource,
        )
        const contextPrefix =
          contextChanges.length > 0
            ? `${contextChanges.map((change) => `[Context: ${change}]`).join('\n')}\n\n`
            : ''
        wrappedUserMessageId = session.agent.appendUserMessage(
          request.message,
          ownedRun.userMessageId,
        )
        const promptUserText = contextPrefix + userContent
        promptUiMessages = filterValidMessages(session.agent.messages).map(
          (message) =>
            message.id === wrappedUserMessageId && message.role === 'user'
              ? {
                  ...message,
                  parts: [{ type: 'text' as const, text: promptUserText }],
                }
              : message,
        )
        session.agent.setEvidenceSink(
          sessionStore.createEvidenceSink(
            request.conversationId,
            ownedRun.runId,
          ),
        )
      }

      const streamedSession = session
      let finishCallbackConsumed = false
      return await createAgentUIStreamResponse({
        agent: streamedSession.agent.toolLoopAgent,
        uiMessages: promptUiMessages,
        abortSignal,
        consumeSseStream: consumeStream,
        onFinish: async ({ messages, isAborted, finishReason }) => {
          if (finishCallbackConsumed) return
          finishCallbackConsumed = true
          const restored = restoreUserMessage(
            messages,
            wrappedUserMessageId,
            request.message,
          )
          const result = finishOwnedChatRun({
            sessionStore,
            session: streamedSession,
            conversationId: request.conversationId,
            runId: ownedRun.runId,
            messages: restored,
            isAborted: Boolean(isAborted),
            finishReason,
            deniedByApproval: ownedRun.deniedByApproval,
            clearEvidenceSink: clearRunEvidence,
            closeHiddenPage: closeRunHiddenPage,
          })
          if (result !== 'stale') {
            logInfoSafely('Agent execution complete', {
              conversationId: request.conversationId,
              totalMessages: streamedSession.agent.messages.length,
            })
          }
        },
      })
    } catch (error) {
      if (
        messageSnapshot &&
        session &&
        sessionStore.get(request.conversationId) === session &&
        ownsChatRun(sessionStore, request.conversationId, ownedRun.runId)
      ) {
        session.agent.messages = messageSnapshot
      }
      failOwnedChatRun({
        sessionStore,
        conversationId: request.conversationId,
        runId: ownedRun.runId,
        failureReason: abortSignal.aborted ? 'aborted' : 'execution-error',
        clearEvidenceSink: clearRunEvidence,
        closeHiddenPage: closeRunHiddenPage,
      })
      throw error
    }
  }

  async deleteSession(
    conversationId: string,
  ): Promise<{ deleted: boolean; sessionCount: number }> {
    const session = this.deps.sessionStore.get(conversationId)
    const hiddenPageId = session?.hiddenPageId
    const deleted = await this.deps.sessionStore.delete(conversationId)
    if (deleted && hiddenPageId !== undefined) {
      if (session?.hiddenPageId === hiddenPageId) {
        session.hiddenPageId = undefined
      }
      this.closeHiddenPage(hiddenPageId, conversationId)
    }
    return { deleted, sessionCount: this.deps.sessionStore.count() }
  }

  private closeHiddenPage(pageId: number, conversationId: string): void {
    this.deps.browser.closePage(pageId).catch(() => {
      logWarningSafely('Failed to close hidden page', {
        pageId,
        conversationId,
      })
    })
  }

  private async rebuildChangedSession(options: {
    session: AgentSession
    request: ChatRequest
    aiSdkAgentConfig: AiSdkAgentConfig
    executionFingerprint: SessionExecutionFingerprint
    hiddenPageId: number | undefined
    mcpServerKey: string
    approvalConfigKey: string
  }): Promise<AgentSession> {
    const {
      session,
      request,
      aiSdkAgentConfig,
      executionFingerprint,
      hiddenPageId,
      mcpServerKey,
      approvalConfigKey,
    } = options
    const previousHiddenPageId = session.hiddenPageId
    const replacement = await rebuildSessionAtomically({
      sessionStore: this.deps.sessionStore,
      session,
      aiSdkAgentConfig,
      conversationId: request.conversationId,
      executionFingerprint,
      hiddenPageId,
      mcpServerKey,
      workingDir: request.userWorkingDir,
      approvalConfigKey,
    })
    if (
      previousHiddenPageId !== undefined &&
      previousHiddenPageId !== replacement.hiddenPageId
    ) {
      this.closeHiddenPage(previousHiddenPageId, request.conversationId)
    }
    return replacement
  }
}
