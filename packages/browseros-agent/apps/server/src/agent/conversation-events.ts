/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from 'node:events'

export type ConversationEvent =
  | { type: 'user-message'; conversationId: string; message: string; at: string }

class ConversationEventBus {
  private emitter = new EventEmitter()

  emit(event: ConversationEvent): void {
    this.emitter.emit(event.conversationId, event)
    this.emitter.emit('*', event)
  }

  subscribe(
    conversationId: string,
    listener: (event: ConversationEvent) => void,
  ): () => void {
    this.emitter.on(conversationId, listener)
    return () => this.emitter.off(conversationId, listener)
  }
}

export const conversationEvents = new ConversationEventBus()

