/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Directed Routing Tests
 *
 * Multi-agent scenario tests for directed routing:
 * - Agent1 sends message to Agent2 via targetAgentId
 * - Route to unregistered agent
 * - Route with agent in error state
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MessageRouter, RoutedMessage } from './message-router.test'
import type { A2AClientMessage } from '../../../src/agent/portable/a2a-types'

describe('Directed Routing Multi-Agent Scenarios', () => {
  let router: MessageRouter

  beforeEach(() => {
    router = new MessageRouter()
  })

  afterEach(() => {
    router.clearRoutingLog()
  })

  describe('Agent1 sends message to Agent2', () => {
    it('should route message to specific target agent', () => {
      // Setup: Register Agent2 handler
      let receivedMessage: RoutedMessage | null = null

      router.registerAgent('Agent2', (message: RoutedMessage) => {
        receivedMessage = message
      })

      // Action: Send message from Agent1 to Agent2
      const message: RoutedMessage = {
        type: 'chat',
        request: { message: 'Hello from Agent1' },
        sourceAgentId: 'Agent1',
        targetAgentId: 'Agent2',
      }

      const result = router.routeMessage(message)

      // Verify: Agent2 received the message
      expect(result).toBe(true)
      expect(receivedMessage).toEqual(message)

      // Verify routing log
      const log = router.getRoutingLog()
      expect(log.length).toBe(1)
      expect(log[0].from).toBe('Agent1')
      expect(log[0].to).toBe('Agent2')
    })

    it('should NOT route back to sender when no targetAgentId', () => {
      // Setup: Register Agent1 handler
      let agent1Received: RoutedMessage | null = null

      router.registerAgent('Agent1', (message: RoutedMessage) => {
        agent1Received = message
      })

      router.registerAgent('Agent2', () => {})

      // Action: Send message from Agent2 to Agent1 (wrong direction)
      const message: RoutedMessage = {
        type: 'chat',
        request: { message: 'Reply from Agent2' },
        sourceAgentId: 'Agent2',
        targetAgentId: 'Agent1',
      }

      const result = router.routeMessage(message)

      // Verify: Message NOT routed to Agent1
      expect(result).toBe(false)

      // Verify: Agent1 did NOT receive
      expect(agent1Received).toBeNull()

      // Verify routing log shows no route
      const log = router.getRoutingLog()
      expect(log.length).toBe(0)
    })
  })

  describe('Route to unregistered agent', () => {
    it('should return false and log error for unknown agent', () => {
      // Setup: Only register Agent1
      router.registerAgent('Agent1', () => {})

      // Action: Send message to non-existent Agent3
      const message: RoutedMessage = {
        type: 'chat',
        request: { message: 'Hello' },
        sourceAgentId: 'Agent1',
        targetAgentId: 'Agent3',
      }

      const result = router.routeMessage(message)

      // Verify: Routing failed
      expect(result).toBe(false)

      // Verify routing log shows error
      const log = router.getRoutingLog()
      expect(log.length).toBe(1)
      expect(log[0].to).toBe('not_found')
    })

    it('should notify sender about unknown target', () => {
      // Setup: Register sender notification handler
      let notificationReceived: boolean = false

      router.registerAgent('Agent1', () => {
        notificationReceived = true
      })

      // Action: Send to unknown agent
      const message: RoutedMessage = {
        type: 'chat',
        request: { message: 'Hello' },
        sourceAgentId: 'Agent1',
        targetAgentId: 'Agent3',
      }

      router.routeMessage(message)

      // Verify: Sender was notified
      expect(notificationReceived).toBe(true)
    })
  })

  describe('Route with agent in error state', () => {
    it('should skip routing when target agent is in error state', () => {
      // Setup: Register Agent2 in "error" state
      router.registerAgent('Agent2', (message: RoutedMessage) => {
        throw new Error('Agent2 is in error state')
      })

      // Action: Try to route to Agent2
      const message: RoutedMessage = {
        type: 'chat',
        request: { message: 'Hello' },
        sourceAgentId: 'Agent1',
        targetAgentId: 'Agent2',
      }

      const result = router.routeMessage(message)

      // Verify: Routing returned false (handler threw)
      expect(result).toBe(false)
    })
  })

  describe('Message format validation', () => {
    it('should handle valid chat message format', () => {
      const validMessage: RoutedMessage = {
        type: 'chat',
        request: { message: 'Valid message' },
        sourceAgentId: 'Agent1',
        targetAgentId: 'Agent2',
      }

      let received: RoutedMessage | null = null

      router.registerAgent('Agent2', (msg: RoutedMessage) => {
        received = msg
      })

      router.routeMessage(validMessage)

      expect(received).toEqual(validMessage)
    })

    it('should handle control message without routing', () => {
      // Messages without targetAgentId should be handled (broadcast/control)
      const controlMessage: RoutedMessage = {
        type: 'ready',
        sourceAgentId: 'Agent1',
      }

      let received: RoutedMessage | null = null

      router.registerAgent('default', (msg: RoutedMessage) => {
        received = msg
      })

      router.routeMessage(controlMessage)

      expect(received).toEqual(controlMessage)
    })
  })
})
  })

  describe('Routing Log', () => {
    it('should clear agent routing', () => {
      const router = new MessageRouter()

      router.registerAgent('Agent1', () => {})
      router.registerAgent('Agent2', () => {})
      router.registerAgent('default', () => {})

      const message1: RoutedMessage = {
        type: 'chat',
        request: { message: 'Message 1' },
        sourceAgentId: 'Agent1',
        targetAgentId: 'Agent2',
      }

      const message2: RoutedMessage = {
        type: 'chat',
        request: { message: 'Message 2' },
        sourceAgentId: 'Agent2',
        targetAgentId: 'Agent1',
      }

      router.routeMessage(message1)
      router.routeMessage(message2)

      // Clear Agent2 routing
      router.clearAgent('Agent2')

      // Verify only Agent1 routing remains
      const log = router.getRoutingLog()

      expect(log.length).toBe(1)
      expect(log[0].from).toBe('Agent1')
      expect(log[0].to).toBe('Agent1')
    })
  })
