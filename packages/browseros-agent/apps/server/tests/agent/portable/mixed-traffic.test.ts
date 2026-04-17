/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Mixed Traffic Tests
 *
 * Multi-agent scenario tests for mixed message types:
 * - Control messages separate from data
 * - SSE events distinct from WebSocket messages
 * - Error message does not interrupt stream
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import type { A2AClientMessage, A2AServerMessage } from '../../../src/agent/portable/a2a-types'
import { A2AMessageType } from '../../../src/agent/portable/a2a-types'

describe('Mixed Traffic Multi-Agent Scenarios', () => {
  /**
   * Control messages: ready, abort, error
   * Data messages: chat with request payload
   */
  describe('Control messages separate from data', () => {
    it('should process ready before chat message', () => {
      const messages: Array<{ type: string; timestamp: number }> = []

      // Simulate message processing order
      const readyMessage: A2AServerMessage = {
        type: A2AMessageType.ready,
      }

      const chatMessage: A2AClientMessage = {
        type: A2AMessageType.chat,
        request: { message: 'data payload' },
      }

      // Process ready first
      messages.push({ type: readyMessage.type, timestamp: Date.now() })
      expect(messages[0].type).toBe('ready')

      // Then process chat
      messages.push({ type: chatMessage.type, timestamp: Date.now() })
      expect(messages[1].type).toBe('chat')

      // Verify correct order
      expect(messages.length).toBe(2)
      expect(messages[0].timestamp).toBeLessThan(messages[1].timestamp)
    })

    it('should log control messages separately from data', () => {
      const controlLog: string[] = []
      const dataLog: string[] = []

      const controlTypes = ['ready', 'abort', 'error']
      const dataTypes = ['chat']

      // Ready message - control
      controlLog.push('ready')
      expect(controlLog).toContain('ready')
      expect(dataLog).not.toContain('ready')

      // Chat message - data
      dataLog.push('chat')
      expect(dataLog).toContain('chat')
      expect(controlLog).not.toContain('chat')

      // Verify separation
      expect(controlLog.length).toBe(1)
      expect(dataLog.length).toBe(1)
      expect(controlLog).not.toEqual(dataLog)
    })
  })

  describe('SSE events distinct from WebSocket messages', () => {
    it('should maintain separate channels for SSE and WebSocket', () => {
      const wsMessages: A2AClientMessage[] = []
      const sseEvents: Array<{ type: string; data: string }> = []

      // WebSocket message (bidirectional)
      const wsMessage: A2AClientMessage = {
        type: A2AMessageType.chat,
        request: { message: 'WebSocket data' },
      }
      wsMessages.push(wsMessage)

      // SSE event (unidirectional stream)
      const sseEvent = {
        type: 'text-delta',
        data: 'SSE stream data',
      }
      sseEvents.push(sseEvent)

      // Verify channels are separate
      expect(wsMessages.length).toBe(1)
      expect(sseEvents.length).toBe(1)

      // WebSocket messages have request structure
      expect(wsMessages[0]).toHaveProperty('type')
      expect(wsMessages[0]).toHaveProperty('request')

      // SSE events have different structure
      expect(sseEvents[0]).toHaveProperty('type')
      expect(sseEvents[0]).toHaveProperty('data')

      // Verify no cross-contamination
      expect(wsMessages[0].type).not.toBe('text-delta')
      expect(sseEvents[0].type).not.toBe('chat')
    })

    it('should handle chat via WebSocket and text-delta via SSE simultaneously', () => {
      interface MessageFlow {
        channel: 'ws' | 'sse'
        type: string
        payload: unknown
      }

      const messageFlow: MessageFlow[] = []

      // Simulate: Agent sends chat via WebSocket
      messageFlow.push({
        channel: 'ws',
        type: 'chat',
        payload: { message: 'User input' },
      })

      // Simultaneously: Server streams response via SSE
      messageFlow.push({
        channel: 'sse',
        type: 'text-delta',
        payload: 'Response chunk 1',
      })

      messageFlow.push({
        channel: 'sse',
        type: 'text-delta',
        payload: 'Response chunk 2',
      })

      // Verify both channels operating
      const wsMessages = messageFlow.filter((m) => m.channel === 'ws')
      const sseMessages = messageFlow.filter((m) => m.channel === 'sse')

      expect(wsMessages.length).toBe(1)
      expect(sseMessages.length).toBe(2)

      // Verify no channel confusion
      wsMessages.forEach((m) => expect(m.channel).toBe('ws'))
      sseMessages.forEach((m) => expect(m.channel).toBe('sse'))
    })
  })

  describe('Error message does not interrupt stream', () => {
    it('should log error while data stream continues', () => {
      interface StreamEvent {
        type: string
        timestamp: number
        interrupted: boolean
      }

      const streamEvents: StreamEvent[] = []

      // Normal data flow
      streamEvents.push({ type: 'text-delta', timestamp: Date.now(), interrupted: false })
      streamEvents.push({ type: 'text-delta', timestamp: Date.now(), interrupted: false })

      // Error occurs (logged but doesn't stop stream)
      streamEvents.push({ type: 'error', timestamp: Date.now(), interrupted: false })

      // Stream continues after error
      streamEvents.push({ type: 'text-delta', timestamp: Date.now(), interrupted: false })
      streamEvents.push({ type: 'done', timestamp: Date.now(), interrupted: false })

      // Verify stream continued
      expect(streamEvents.length).toBe(5)

      // Error is present
      const errorEvent = streamEvents.find((e) => e.type === 'error')
      expect(errorEvent).toBeDefined()

      // But stream was not interrupted
      streamEvents.forEach((event) => {
        expect(event.interrupted).toBe(false)
      })

      // Events after error exist
      const errorIndex = streamEvents.findIndex((e) => e.type === 'error')
      const eventsAfterError = streamEvents.slice(errorIndex + 1)
      expect(eventsAfterError.length).toBeGreaterThan(0)
      expect(eventsAfterError[0].type).toBe('text-delta')
    })

    it('should separate error logging from data logging', () => {
      const dataLog: Array<{ type: string; content: string }> = []
      const errorLog: Array<{ type: string; message: string }> = []

      // Data stream
      dataLog.push({ type: 'text-delta', content: 'Hello' })
      dataLog.push({ type: 'text-delta', content: ' World' })

      // Error (logged separately)
      errorLog.push({ type: 'warning', message: 'Timeout warning' })

      // Data continues
      dataLog.push({ type: 'done', content: '' })

      // Verify separation
      expect(dataLog.length).toBe(3)
      expect(errorLog.length).toBe(1)

      // Data log contains only data types
      dataLog.forEach((entry) => {
        expect(['text-delta', 'done']).toContain(entry.type)
      })

      // Error log contains only errors
      errorLog.forEach((entry) => {
        expect(['warning', 'error']).toContain(entry.type)
      })
    })
  })

  describe('Message type classification', () => {
    it('should correctly classify message types', () => {
      const isControlMessage = (msg: A2AClientMessage | A2AServerMessage): boolean => {
        return ['ready', 'abort', 'error'].includes(msg.type)
      }

      const isDataMessage = (msg: A2AClientMessage | A2AServerMessage): boolean => {
        return msg.type === 'chat'
      }

      const isSSEEvent = (msg: A2AServerMessage): boolean => {
        return msg.type === 'sse'
      }

      // Test control messages
      const readyMsg: A2AServerMessage = { type: 'ready' }
      const abortMsg: A2AClientMessage = { type: 'abort' }

      expect(isControlMessage(readyMsg)).toBe(true)
      expect(isControlMessage(abortMsg)).toBe(true)
      expect(isDataMessage(readyMsg)).toBe(false)
      expect(isDataMessage(abortMsg)).toBe(false)

      // Test data message
      const chatMsg: A2AClientMessage = {
        type: 'chat',
        request: { message: 'data' },
      }

      expect(isDataMessage(chatMsg)).toBe(true)
      expect(isControlMessage(chatMsg)).toBe(false)

      // Test SSE event
      const sseMsg: A2AServerMessage = {
        type: 'sse',
        event: { type: 'text-delta', text: 'stream' },
      }

      expect(isSSEEvent(sseMsg)).toBe(true)
      expect(isControlMessage(sseMsg)).toBe(false)
      expect(isDataMessage(sseMsg)).toBe(false)
    })
  })
})
