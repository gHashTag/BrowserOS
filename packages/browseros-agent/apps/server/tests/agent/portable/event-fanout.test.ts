/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Event Fanout Tests
 *
 * Multi-agent scenario tests for SSE event distribution:
 * - Multiple subscribers receive same event
 * - Late subscriber receives new events
 * - Subscriber disconnect does not affect others
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test'

describe('Event Fanout Multi-Agent Scenarios', () => {
  let harness: SSEFanoutHarness

  beforeEach(() => {
    harness = createFanoutHarness(3)
  })

  afterEach(() => {
    harness.clearEventLog()
  })

  describe('Multiple subscribers receive same event', () => {
    it('should broadcast event to all active subscribers', () => {
      const event: SSEEvent = {
        type: 'text-delta',
        data: 'Broadcast message',
      }

      const delivered = harness.broadcast(event)

      // Verify event was delivered to all 3 subscribers
      expect(delivered).toBe(3)

      // Verify all subscribers received the event
      const subscribers = harness.getAllSubscribers()
      expect(subscribers).toHaveLength(3)

      subscribers.forEach((subscriber) => {
        const lastEvent = subscriber.events[subscriber.events.length - 1]
        expect(lastEvent.type).toBe(event.type)
        expect(lastEvent.data).toBe(event.data)
      })
    })

    it('should maintain event order across subscribers', () => {
      const events = [
        { type: 'event1', data: 'data1' },
        { type: 'event2', data: 'data2' },
        { type: 'event3', data: 'data3' },
      ]

      events.forEach((event) => harness.broadcast(event))

      // Verify each subscriber received events in correct order
      const subscribers = harness.getAllSubscribers()

      subscribers.forEach((subscriber) => {
        expect(subscriber.events.length).toBe(3)

        expect(subscriber.events[0].data).toBe('data1')
        expect(subscriber.events[1].data).toBe('data2')
        expect(subscriber.events[2].data).toBe('data3')
      })
    })

    it('should track event log', () => {
      const event: SSEEvent = {
        type: 'test-event',
        data: 'test data',
      }

      harness.broadcast(event)

      const log = harness.getEventLog()

      expect(log).toHaveLength(1)
      expect(log[0].type).toBe('test-event')
      expect(log[0].data).toBe('test data')
    })
  })

  describe('Late subscriber receives new events', () => {
    it('should not deliver past events to late joiner', () => {
      const initialSubscribers = harness.getAllSubscribers()
      expect(initialSubscribers).toHaveLength(3)

      // Broadcast initial event
      const earlyEvent: SSEEvent = {
        type: 'early',
        data: 'early data',
      }
      harness.broadcast(earlyEvent)

      // Late subscriber joins
      const lateSubscriber = harness.lateSubscribe('subscriber-late', 1)

      // Broadcast new event
      const newEvent: SSEEvent = {
        type: 'new',
        data: 'new data',
      }
      harness.broadcast(newEvent)

      // Verify late subscriber only received new event
      expect(lateSubscriber.events).toHaveLength(1)
      expect(lateSubscriber.events[0].type).toBe('new')
      expect(lateSubscriber.events[0].data).toBe('new data')

      // Verify original subscribers received both events
      initialSubscribers.forEach((subscriber) => {
        expect(subscriber.events.length).toBe(2)
        expect(subscriber.events[0].data).toBe('early data')
        expect(subscriber.events[1].data).toBe('new data')
      })
    })

    it('should allow subscriber to receive events after join time', () => {
      const subscriber1 = harness.getSubscriber('subscriber-0')
      const subscriber2 = harness.getSubscriber('subscriber-1')

      expect(subscriber1?.events.length).toBe(0)
      expect(subscriber2?.events.length).toBe(0)

      // Broadcast event
      const event: SSEEvent = {
        type: 'test',
        data: 'data',
      }
      harness.broadcast(event)

      // Both subscribers should receive
      expect(subscriber1?.events.length).toBe(1)
      expect(subscriber2?.events.length).toBe(1)
    })
  })

  describe('Subscriber disconnect does not affect others', () => {
    it('should continue broadcasting after subscriber disconnect', () => {
      const event: SSEEvent = {
        type: 'test',
        data: 'data',
      }

      // All 3 subscribers receive initial event
      harness.broadcast(event)

      expect(harness.getSubscriberCount()).toBe(3)
      harness.getAllSubscribers().forEach((s) => {
        expect(s.events).toHaveLength(1)
      })

      // Disconnect one subscriber
      const removed = harness.simulateSubscriberDrop('subscriber-0')
      expect(removed).toBe(true)

      // Verify 2 remaining subscribers
      expect(harness.getSubscriberCount()).toBe(2)

      // Broadcast second event
      const event2: SSEEvent = {
        type: 'test2',
        data: 'data2',
      }
      harness.broadcast(event2)

      // Remaining subscribers receive, dropped one doesn't
      const remaining = harness.getAllSubscribers()

      expect(remaining).toHaveLength(2)

      remaining.forEach((subscriber) => {
        const lastEvent = subscriber.events[subscriber.events.length - 1]
        expect(subscriber.events.length).toBe(2)
        expect(lastEvent.type).toBe('test2')
        expect(lastEvent.data).toBe('data2')
      })

      // Verify dropped subscriber didn't receive new event
      const dropped = harness.getSubscriber('subscriber-0')
      expect(dropped).toBeUndefined()
      expect(dropped?.events.length).toBe(1)
    })

    it('should allow multiple disconnects', () => {
      const event: SSEEvent = {
        type: 'test',
        data: 'data',
      }

      // Broadcast to 3 subscribers
      harness.broadcast(event)

      expect(harness.getSubscriberCount()).toBe(3)

      // Disconnect 2 subscribers
      const removed1 = harness.simulateSubscriberDrop('subscriber-0')
      const removed2 = harness.simulateSubscriberDrop('subscriber-1')

      expect(removed1).toBe(true)
      expect(removed2).toBe(true)

      // Broadcast second event
      const event2: SSEEvent = {
        type: 'test2',
        data: 'data2',
      }
      harness.broadcast(event2)

      // Only remaining subscriber receives
      expect(harness.getSubscriberCount()).toBe(1)

      const remaining = harness.getAllSubscribers()
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe('subscriber-2')

      remaining.forEach((subscriber) => {
        expect(subscriber.events.length).toBe(2)
      })
    })
  })

  describe('Subscriber lifecycle', () => {
    it('should track subscriber connection time', () => {
      const beforeJoin = Date.now()

      const subscriber = harness.subscribe('new-subscriber')

      expect(subscriber.connectedAt).toBeGreaterThanOrEqual(beforeJoin)
      expect(subscriber.connectedAt).toBeLessThanOrEqual(Date.now() + 100) // Within 100ms
    })

    it('should unsubscribe correctly', () => {
      const subscriber = harness.subscribe('to-remove')

      expect(harness.getSubscriber('to-remove')).toBeDefined()

      const removed = harness.unsubscribe('to-remove')

      expect(removed).toBe(true)
      expect(harness.getSubscriber('to-remove')).toBeUndefined()
    })

    it('should handle unsubscribe of non-existent subscriber', () => {
      const removed = harness.unsubscribe('non-existent')

      expect(removed).toBe(false)
    })

    it('should get subscriber information', () => {
      const subscriber = harness.subscribe('test-sub')

      expect(subscriber.id).toBe('test-sub')
      expect(subscriber.events).toEqual([])
      expect(subscriber.connectedAt).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Event verification', () => {
    it('should verify subscriber received expected event count', () => {
      const event: SSEEvent = {
        type: 'test',
        data: 'data',
      }

      // Broadcast 3 times
      harness.broadcast(event)
      harness.broadcast(event)
      harness.broadcast(event)

      const subscriber = harness.getSubscriber('subscriber-0')

      const verified = harness.verifySubscriberReceivedEvents('subscriber-0', 3)

      expect(verified).toBe(true)
      expect(subscriber.events).toHaveLength(3)
    })

    it('should verify subscriber received specific events', () => {
      const events = [
        { type: 'e1', data: 'd1' },
        { type: 'e2', data: 'd2' },
        { type: 'e3', data: 'd3' },
      ]

      events.forEach((event) => harness.broadcast(event))

      const subscriber = harness.getSubscriber('subscriber-0')
      const subscriberEvents = subscriber?.events || []

      expect(subscriberEvents.length).toBe(3)
      expect(subscriberEvents[0]).toEqual(events[0])
      expect(subscriberEvents[1]).toEqual(events[1])
      expect(subscriberEvents[2]).toEqual(events[2])
    })

    it('should detect mismatched event counts', () => {
      const event: SSEEvent = {
        type: 'test',
        data: 'data',
      }

      harness.broadcast(event)
      harness.broadcast(event)
      harness.broadcast(event)

      const subscriber = harness.getSubscriber('subscriber-0')

      // Verify correct count
      const correct = harness.verifySubscriberReceivedEvents('subscriber-0', 3)
      expect(correct).toBe(true)

      // Verify incorrect count
      const incorrect = harness.verifySubscriberReceivedEvents('subscriber-0', 2)
      expect(incorrect).toBe(false)
    })
  })

  describe('Stream state', () => {
    it('should prevent broadcast when stream closed', () => {
      harness.closeStream()

      const event: SSEEvent = {
        type: 'test',
        data: 'data',
      }

      const delivered = harness.broadcast(event)

      expect(delivered).toBe(0)

      // Verify stream is marked closed
      // Note: harness doesn't have a method to check stream state
      // This test documents the expected behavior
    })

    it('should allow broadcast when stream reopened', () => {
      harness.closeStream()
      harness.openStream()

      const event: SSEEvent = {
        type: 'test',
        data: 'data',
      }

      const delivered = harness.broadcast(event)

      expect(delivered).toBeGreaterThan(0)
    })
  })
})
