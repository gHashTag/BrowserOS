/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { UIMessageStreamEvent } from '@trios/shared/schemas/ui-stream'
import { createParser, type EventSourceMessage } from 'eventsource-parser'
import { logger } from '../../../lib/logger'

export interface A2ARelayConfig {
  /** Local server port (HTTP). */
  port: number
  /** Shared key (optional) to access /a2a/ws. */
  a2aKey?: string
  /** The conversation to join. */
  conversationId: string
  /** Provider/model/etc forwarded to /chat. */
  chatRequestBase: Record<string, unknown>
  /**
   * Called when a new user message is observed.
   * Must return assistant text to post back, or null to ignore.
   */
  onUserMessage: (text: string) => Promise<string | null>
}

function isTextDeltaEvent(
  ev: UIMessageStreamEvent,
): ev is UIMessageStreamEvent & { type: 'text-delta'; textDelta: string } {
  return (
    (ev as any)?.type === 'text-delta' &&
    typeof (ev as any)?.textDelta === 'string'
  )
}

function extractLastUserTextFromRequest(
  request: Record<string, unknown>,
): string | null {
  const msg = request.message
  return typeof msg === 'string' ? msg : null
}

async function forwardChatSSE(
  url: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
  onEvent: (event: UIMessageStreamEvent) => void,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(
      errorText || `Chat request failed with status ${response.status}`,
    )
  }

  const reader = response.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder()
  const pending: UIMessageStreamEvent[] = []
  const parser = createParser({
    onEvent: (msg: EventSourceMessage) => {
      if (msg.data === '[DONE]') return
      try {
        pending.push(JSON.parse(msg.data) as UIMessageStreamEvent)
      } catch {
        // ignore invalid json
      }
    },
  })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parser.feed(decoder.decode(value, { stream: true }))
      let ev = pending.shift()
      while (ev) {
        onEvent(ev)
        ev = pending.shift()
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Minimal “relay agent”:
 * - Watches inbound user chat requests (via your own wiring)
 * - When you call `handleIncomingUserRequest`, it can auto-generate and post a response
 *
 * This is deliberately small: the “brain” is supplied by `onUserMessage`.
 */
export class A2ARelay {
  private readonly chatUrl: string
  private readonly abortController = new AbortController()

  constructor(private cfg: A2ARelayConfig) {
    this.chatUrl = `http://127.0.0.1:${cfg.port}/chat`
  }

  stop(): void {
    this.abortController.abort()
  }

  /**
   * Call this from whatever event source you choose (e.g. WS /a2a client, DB trigger, etc).
   * It will optionally post an assistant reply back into the same conversation.
   */
  async handleIncomingUserRequest(
    request: Record<string, unknown>,
  ): Promise<void> {
    const conversationId = this.cfg.conversationId
    const userText = extractLastUserTextFromRequest(request)
    if (!userText) return

    const reply = await this.cfg.onUserMessage(userText)
    if (!reply) return

    const assistantRequest: Record<string, unknown> = {
      ...this.cfg.chatRequestBase,
      ...request,
      conversationId,
      message: reply,
    }

    let assistantText = ''
    await forwardChatSSE(
      this.chatUrl,
      assistantRequest,
      this.abortController.signal,
      (ev) => {
        if (isTextDeltaEvent(ev)) assistantText += ev.textDelta
      },
    )

    logger.info('A2A relay posted assistant reply', {
      conversationId,
      userChars: userText.length,
      assistantChars: assistantText.length,
    })
  }
}
