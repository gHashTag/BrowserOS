/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { UIMessage } from 'ai'
import type { AgentSession } from '../../agent/session-store'
import type { ChatRequest } from '../types'
import { logInfoSafely } from './chat-session-rebuild'

export function injectPreviousConversation(
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

export function restoreUserMessage(
  messages: UIMessage[],
  messageId: string | undefined,
  content: string,
): UIMessage[] {
  if (!messageId) return messages
  return messages.map((message) =>
    message.id === messageId && message.role === 'user'
      ? { ...message, parts: [{ type: 'text' as const, text: content }] }
      : message,
  )
}
