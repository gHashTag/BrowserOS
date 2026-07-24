/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { AiSdkAgent, type AiSdkAgentConfig } from '../../agent/ai-sdk-agent'
import { sanitizeMessagesForToolset } from '../../agent/message-validation'
import type { SessionExecutionFingerprint } from '../../agent/session-fingerprint'
import type { AgentSession, SessionStore } from '../../agent/session-store'
import { logger } from '../../lib/logger'

export function logWarningSafely(
  message: string,
  details: Record<string, unknown>,
): void {
  try {
    logger.warn(message, details)
  } catch {
    // Cleanup and publication outcomes must not depend on observability.
  }
}

async function disposeUnusedReplacement(
  agent: AiSdkAgent,
  conversationId: string,
): Promise<void> {
  try {
    await agent.dispose()
  } catch {
    logWarningSafely('Failed to dispose unused replacement agent', {
      conversationId,
    })
  }
}

export async function rebuildSessionAtomically(options: {
  sessionStore: SessionStore
  session: AgentSession
  aiSdkAgentConfig: AiSdkAgentConfig
  conversationId: string
  executionFingerprint: SessionExecutionFingerprint
  hiddenPageId: number | undefined
  mcpServerKey: string
  workingDir: string | undefined
  approvalConfigKey: string
}): Promise<AgentSession> {
  const {
    sessionStore,
    session,
    aiSdkAgentConfig,
    conversationId,
    executionFingerprint,
    hiddenPageId,
    mcpServerKey,
    workingDir,
    approvalConfigKey,
  } = options
  const previousMessages = [...session.agent.messages]
  const agent = await AiSdkAgent.create(aiSdkAgentConfig)
  try {
    agent.messages = sanitizeMessagesForToolset(
      previousMessages,
      agent.toolNames,
    )
  } catch (error) {
    await disposeUnusedReplacement(agent, conversationId)
    throw error
  }

  const replacement: AgentSession = {
    agent,
    executionFingerprint,
    hiddenPageId,
    browserContext: aiSdkAgentConfig.browserContext,
    mcpServerKey,
    workingDir,
    approvalConfigKey,
  }

  let published: boolean
  try {
    published = sessionStore.replace(conversationId, session, replacement)
  } catch (error) {
    await disposeUnusedReplacement(agent, conversationId)
    throw error
  }
  if (!published) {
    await disposeUnusedReplacement(agent, conversationId)
    throw new Error('Session changed while rebuilding')
  }

  try {
    await session.agent.dispose()
  } catch {
    logWarningSafely('Failed to dispose replaced agent', { conversationId })
  }

  return replacement
}
