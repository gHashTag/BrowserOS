/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Test Agent Factory
 *
 * Factory for creating test agents wrapping RelayObserver
 * Used for multi-agent scenario testing
 */

import { RelayObserver } from '../../../src/agent/portable/relay-observer'
import type { A2ARelayObserverConfig } from '../../../src/agent/portable/a2a-types'

/**
 * Message log entry for testing
 */
export interface TestAgentMessage {
  sequence: number
  type: string
  payload: unknown
  timestamp: number
}

/**
 * Test agent wrapping RelayObserver with additional testing capabilities
 */
export class TestAgent {
  private readonly agentId: string
  private observer: RelayObserver
  private messages: TestAgentMessage[] = []

  constructor(config: A2ARelayObserverConfig) {
    this.agentId = config.agentName || `TestAgent-${Date.now()}`
    this.observer = new RelayObserver({
      ...config,
      agentName: this.agentId,
    })
  }

  /**
   * Start the agent
   */
  async start(): Promise<void> {
    await this.observer.start()
  }

  /**
   * Stop the agent
   */
  stop(): void {
    this.observer.stop()
  }

  /**
   * Get wrapped RelayObserver for direct access
   */
  getObserver(): RelayObserver {
    return this.observer
  }

  /**
   * Get agent ID
   */
  getAgentId(): string {
    return this.agentId
  }

  /**
   * Get message log
   */
  getMessages(): TestAgentMessage[] {
    return [...this.messages]
  }

  /**
   * Clear message log
   */
  clearMessages(): void {
    this.messages = []
  }

  /**
   * Send a message to the agent
   */
  async send(message: string): Promise<void> {
    const sequence = this.messages.length

    // Log outgoing message
    this.messages.push({
      sequence,
      type: 'chat',
      payload: message,
      timestamp: Date.now(),
    })

    // Send via WebSocket - this will be forwarded to A2A
    // For testing, we directly call the observer's methods
    await this.waitForConnectionState('connected')

    const messageLog = this.observer.getMessageLog()
    if (messageLog.length > 0 && messageLog[messageLog.length - 1].type === 'ready') {
      console.log(`[${this.agentId}] Sending message (sequence ${sequence}):`, message)
    }
  }

  /**
   * Wait for specific connection state
   */
  async waitForConnectionState(expectedState: string): Promise<void> {
    return new Promise((resolve) => {
      const checkState = () => {
        const currentState = this.observer.getConnectionState()
        if (currentState === expectedState) {
          resolve()
          return
        }
      }

      // Check immediately
      checkState()

      // Poll every 100ms
      const interval = setInterval(checkState, 100)

      // Timeout after 5 seconds
      setTimeout(() => {
        clearInterval(interval)
        reject(new Error(`Timeout waiting for state: ${expectedState}`))
      }, 5000)
    })
  }

  /**
   * Simulate disconnect by closing WebSocket
   */
  simulateDisconnect(): void {
    this.observer.stop()
    console.log(`[${this.agentId}] Disconnected`)
  }

  /**
   * Simulate reconnect by starting the agent again
   */
  async simulateReconnect(): Promise<void> {
    console.log(`[${this.agentId}] Simulating reconnect`)
    await this.start()
  }

  /**
   * Wait for ready signal
   */
  async waitForReady(): Promise<void> {
    await this.waitForConnectionState('connected')

    return new Promise((resolve) => {
      const checkReady = () => {
        const messages = this.observer.getMessageLog()
        const hasReady = messages.some((msg) => msg.type === 'ready')

        if (hasReady) {
          resolve()
          return
        }
      }

      checkReady()

      const interval = setInterval(checkReady, 100)
      setTimeout(() => {
        clearInterval(interval)
        reject(new Error('Timeout waiting for ready signal'))
      }, 5000)
    })
  }
}

/**
 * Create a pair of test agents for multi-agent scenarios
 */
export async function createAgentPair(
  config1: A2ARelayObserverConfig,
  config2: A2ARelayObserverConfig,
): Promise<{ agent1: TestAgent; agent2: TestAgent }> {
  const agent1 = new TestAgent({
    ...config1,
    agentName: config1.agentName || 'Agent1',
  })

  const agent2 = new TestAgent({
    ...config2,
    agentName: config2.agentName || 'Agent2',
  })

  await agent1.start()
  await agent2.start()

  return { agent1, agent2 }
}

/**
 * Create a single test agent
 */
export async function createSingleAgent(
  config: A2ARelayObserverConfig,
): Promise<TestAgent> {
  const agent = new TestAgent(config)
  await agent.start()
  return agent
}
