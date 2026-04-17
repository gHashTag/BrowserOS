/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * SSE Fanout Harness
 *
 * Test harness for SSE event fanout scenarios:
 * - Multiple subscribers receive same event
 * - Late subscriber receives new events
 * - Subscriber disconnect does not affect others
 */

/**
 * SSE event for fanout
 */
export interface SSEEvent {
  type: string
  data: unknown
  timestamp: number
}

/**
 * Subscriber information
 */
export interface Subscriber {
  id: string
  events: SSEEvent[]
  connectedAt: number
}

/**
 * SSE Fanout Harness for testing multiple subscribers
 */
export class SSEFanoutHarness {
  private subscribers = new Map<string, Subscriber>()
  private eventLog: SSEEvent[] = []
  private streamClosed = false

  /**
   * Create a new SSE stream for testing
   */
  createStream(conversationId: string): URL {
    const baseUrl = 'http://127.0.0.1:3001'
    return new URL(`${baseUrl}/a2a/${conversationId}/stream`)
  }

  /**
   * Subscribe a new client to the stream
   */
  subscribe(clientId: string): Subscriber {
    const subscriber: Subscriber = {
      id: clientId,
      events: [],
      connectedAt: Date.now(),
    }

    this.subscribers.set(clientId, subscriber)
    console.log(`[SSEFanout] Subscriber ${clientId} joined. Total: ${this.subscribers.size}`)

    return subscriber
  }

  /**
   * Unsubscribe a client from the stream
   */
  unsubscribe(clientId: string): boolean {
    const existed = this.subscribers.delete(clientId)

    if (existed) {
      console.log(`[SSEFanout] Subscriber ${clientId} left. Total: ${this.subscribers.size}`)
    }

    return existed
  }

  /**
   * Get subscriber by ID
   */
  getSubscriber(clientId: string): Subscriber | undefined {
    return this.subscribers.get(clientId)
  }

  /**
   * Get all subscribers
   */
  getAllSubscribers(): Subscriber[] {
    return Array.from(this.subscribers.values())
  }

  /**
   * Get subscriber count
   */
  getSubscriberCount(): number {
    return this.subscribers.size
  }

  /**
   * Broadcast event to all subscribers
   */
  broadcast(event: SSEEvent): number {
    if (this.streamClosed) {
      console.warn(`[SSEFanout] Cannot broadcast: stream closed`)
      return 0
    }

    const timestamp = event.timestamp || Date.now()
    const eventWithTimestamp = { ...event, timestamp }

    let delivered = 0

    this.subscribers.forEach((subscriber) => {
      subscriber.events.push(eventWithTimestamp)
      delivered++
    })

    this.eventLog.push(eventWithTimestamp)

    console.log(`[SSEFanout] Broadcast event to ${delivered} subscribers`)
    return delivered
  }

  /**
   * Late join scenario: subscriber joins after events were sent
   */
  lateSubscribe(clientId: string, afterEventCount: number = 0): Subscriber {
    const subscriber: Subscriber = {
      id: clientId,
      events: [],
      connectedAt: Date.now(),
    }

    this.subscribers.set(clientId, subscriber)

    console.log(`[SSEFanout] Late subscriber ${clientId} joined after ${afterEventCount} events`)

    return subscriber
  }

  /**
   * Simulate subscriber drop for testing resilience
   */
  simulateSubscriberDrop(clientId: string): boolean {
    const existed = this.unsubscribe(clientId)

    console.log(`[SSEFanout] Simulated drop of subscriber ${clientId}. Existed: ${existed}`)

    return existed
  }

  /**
   * Get events sent to a specific subscriber
   */
  getSubscriberEvents(clientId: string): SSEEvent[] {
    const subscriber = this.subscribers.get(clientId)
    return subscriber ? [...subscriber.events] : []
  }

  /**
   * Get event log
   */
  getEventLog(): SSEEvent[] {
    return [...this.eventLog]
  }

  /**
   * Clear event log
   */
  clearEventLog(): void {
    this.eventLog = []
  }

  /**
   * Mark stream as closed
   */
  closeStream(): void {
    this.streamClosed = true
    console.log(`[SSEFanout] Stream closed`)
  }

  /**
   * Open stream for testing
   */
  openStream(): void {
    this.streamClosed = false
    console.log(`[SSEFanout] Stream opened`)
  }

  /**
   * Verify subscriber received specific event count
   */
  verifySubscriberReceivedEvents(clientId: string, expectedCount: number): boolean {
    const subscriber = this.subscribers.get(clientId)

    if (!subscriber) {
      console.warn(`[SSEFanout] Subscriber ${clientId} not found`)
      return false
    }

    const actualCount = subscriber.events.length

    if (actualCount === expectedCount) {
      console.log(`[SSEFanout] Subscriber ${clientId} received expected ${expectedCount} events`)
      return true
    }

    console.log(`[SSEFanout] Subscriber ${clientId} event count mismatch. Expected: ${expectedCount}, Actual: ${actualCount}`)
    return false
  }
}

/**
 * Create fanout harness with multiple initial subscribers
 */
export function createFanoutHarness(subscriberCount: number): SSEFanoutHarness {
  const harness = new SSEFanoutHarness()

  for (let i = 0; i < subscriberCount; i++) {
    harness.subscribe(`subscriber-${i}`)
  }

  return harness
}
