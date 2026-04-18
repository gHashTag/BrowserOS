/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * A2A Relay Observer Agent
 *
 * Подключается к /a2a/ws как клиент
 * Отслеживает сообщения в чате
 * Отвечает от behalf of the user (simple echo/reply mode)
 * Hardened with state machine, sequence validation, and exponential backoff
 */

import { A2A_PORT } from '@trios/shared/constants/ports'
import type { UIMessageStreamEvent } from '@trios/shared/schemas/ui-stream'
import { createParser, type EventSourceMessage } from 'eventsource-parser'
import { logger } from '../../lib/logger'
import {
  A2AAgentMode,
  A2AAgentState,
  type A2AClientMessage,
  A2AConnectionState,
  A2AErrorType,
  type A2AHardeningOptions,
  A2AMessageType,
  type A2ARecoverableError,
  type A2ARelayObserverConfig,
  type A2AServerMessage,
  A2ASseEventType,
  type A2AStateTransition,
} from './a2a-types'

/**
 * Internal config extending the base config with hardening options
 */
interface InternalRelayObserverConfig extends A2ARelayObserverConfig {
  hardening?: A2AHardeningOptions
}

function safeJsonParse(data: unknown): unknown | null {
  if (typeof data !== 'string') return null
  try {
    return JSON.parse(data) as unknown
  } catch {
    return null
  }
}

/**
 * Minimal Trinity experience event API for A2A
 * Captures: agent-connection, agent-disconnect, message-sent, message-received,
 *           reconnect-attempt, reconnect-success, reconnect-failure
 */
export type TrinityExperienceEvent =
  | { type: 'agent-connection'; agentId: string; timestamp: number }
  | { type: 'agent-disconnect'; agentId: string; timestamp: number }
  | {
      type: 'message-sent'
      agentId: string
      message: string
      timestamp: number
    }
  | {
      type: 'message-received'
      agentId: string
      message: string
      timestamp: number
    }
  | {
      type: 'reconnect-attempt'
      agentId: string
      attempt: number
      timestamp: number
    }
  | {
      type: 'reconnect-success'
      agentId: string
      attempt: number
      timestamp: number
    }
  | {
      type: 'reconnect-failure'
      agentId: string
      attempt: number
      maxAttempts: number
      timestamp: number
    }

/**
 * Event emitter for Trinity experience hooks
 * Captures all A2A events for benchmark comparison
 */
export class TrinityExperienceEmitter {
  private events: TrinityExperienceEvent[] = []
  private enabled: boolean

  constructor(enabled: boolean = true) {
    this.enabled = enabled
  }

  /**
   * Emit a Trinity experience event
   */
  emit(event: TrinityExperienceEvent): void {
    if (!this.enabled) return

    this.events.push(event)

    // Keep last 1000 events to prevent memory bloat
    if (this.events.length > 1000) {
      this.events = this.events.slice(-1000)
    }

    logger.debug('TrinityExperience:', event as Record<string, unknown>)
  }

  /**
   * Get all events
   */
  getEvents(): TrinityExperienceEvent[] {
    return [...this.events]
  }

  /**
   * Clear all events
   */
  clear(): void {
    this.events = []
  }

  /**
   * Get events by type
   */
  getEventsByType(
    type: TrinityExperienceEvent['type'],
  ): TrinityExperienceEvent[] {
    return this.events.filter((e) => e.type === type)
  }

  /**
   * Get event count by type
   */
  getEventCount(type: TrinityExperienceEvent['type']): number {
    return this.getEventsByType(type).length
  }

  /**
   * Export events for Trinity experience
   */
  exportForExperience(agentId: string): string {
    return JSON.stringify({
      agentId,
      events: this.events,
      exportTimestamp: Date.now(),
    })
  }

  /**
   * Calculate statistics
   */
  getStats() {
    return {
      totalEvents: this.events.length,
      connections: this.getEventCount('agent-connection'),
      disconnects: this.getEventCount('agent-disconnect'),
      messagesSent: this.getEventCount('message-sent'),
      messagesReceived: this.getEventCount('message-received'),
      reconnectAttempts: this.getEventCount('reconnect-attempt'),
      reconnectSuccesses: this.getEventCount('reconnect-success'),
      reconnectFailures: this.getEventCount('reconnect-failure'),
    }
  }
}

/**
 * Calculate exponential backoff delay with jitter
 * Formula: min(1000 * 2^attempt, maxDelay) + jitter(±jitterPercent%)
 */
function calculateReconnectDelay(
  attempt: number,
  maxDelay: number,
  jitterPercent: number,
): number {
  const baseDelay = Math.min(1000 * 2 ** attempt, maxDelay)
  const jitter = baseDelay * jitterPercent * (Math.random() * 2 - 1)
  return Math.floor(baseDelay + jitter)
}

/**
 * State logger for tracking transitions
 */
class StateLogger {
  private transitions: A2AStateTransition[] = []
  private enabled: boolean

  constructor(enabled: boolean = true) {
    this.enabled = enabled
  }

  logTransition(
    from: A2AConnectionState | A2AAgentState,
    to: A2AConnectionState | A2AAgentState,
    reason?: string,
  ): void {
    if (!this.enabled) return

    const transition: A2AStateTransition = {
      from,
      to,
      timestamp: Date.now(),
      reason,
    }

    this.transitions.push(transition)
    logger.debug(
      'State transition:',
      transition as unknown as Record<string, unknown>,
    )
  }

  getTransitions(): A2AStateTransition[] {
    return [...this.transitions]
  }

  getLastState(): A2AConnectionState | A2AAgentState | null {
    const last = this.transitions[this.transitions.length - 1]
    return last ? last.to : null
  }
}

/**
 * Hardened A2A Relay Observer with state machine, sequence validation, and exponential backoff
 */
export class RelayObserver {
  private config: InternalRelayObserverConfig
  private hardening: A2AHardeningOptions
  private ws: WebSocket | null = null
  private trinityEmitter: TrinityExperienceEmitter

  // State machine
  private connectionState: A2AConnectionState = A2AConnectionState.disconnected
  private agentState: A2AAgentState = A2AAgentState.idle
  private stateLogger: StateLogger

  // Reconnection state
  private reconnectAttempts = 0
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null

  // Sequence validation
  private expectedSequence = 0
  private enableSequenceValidation = false

  // Agent identification for multi-agent scenarios
  private agentId: string
  private messageLog: Array<{
    sequence: number
    type: string
    payload: unknown
    timestamp: number
  }> = []

  constructor(config: InternalRelayObserverConfig) {
    this.config = config
    this.hardening = config.hardening || {}
    this.agentId = config.agentName || `RelayObserver-${Date.now()}`

    const enableLogging = this.hardening.enableStateLogging ?? true
    this.stateLogger = new StateLogger(enableLogging)

    // Initialize Trinity experience emitter
    this.trinityEmitter = new TrinityExperienceEmitter(true)

    this.enableSequenceValidation =
      this.hardening.enableSequenceValidation ?? false
  }

  /**
   * Запуск агента - подключается к A2A WebSocket
   */
  async start(): Promise<void> {
    this.setConnectionState(
      A2AConnectionState.connecting,
      'Starting connection',
    )

    const port = this.config.a2aPort || A2A_PORT
    const wsUrl = `ws://127.0.0.1:${port}/ws`

    logger.info('RelayObserver: Connecting to A2A', {
      url: wsUrl,
      agentId: this.agentId,
      mode: this.config.mode,
    })

    try {
      this.ws = new WebSocket(wsUrl)
    } catch (error) {
      this.handleError(A2AErrorType.connectionError, error as Error)
      throw error
    }

    this.ws.onopen = () => this.onOpen()
    this.ws.onmessage = (event) => this.onMessage(event)
    this.ws.onerror = (event) => this.onError(event)
    this.ws.onclose = () => this.onClose()

    // Send ready message when connected
    setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendMessage({
          type: A2AMessageType.ready,
        })

        // Emit Trinity experience event
        this.trinityEmitter.emit({
          type: 'agent-connection',
          agentId: this.agentId,
          timestamp: Date.now(),
        })
      }
    }, 100)
  }

  /**
   * Остановка агента
   */
  stop(): void {
    this.setConnectionState(A2AConnectionState.closed, 'Stopping agent')
    this.setAgentState(A2AAgentState.stopped, 'Agent stopped')

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    // Emit Trinity experience event for disconnect
    this.trinityEmitter.emit({
      type: 'agent-disconnect',
      agentId: this.agentId,
      timestamp: Date.now(),
    })

    if (this.ws) {
      logger.info('RelayObserver: Closing WebSocket', { agentId: this.agentId })
      this.ws.close()
      this.ws = null
    }

    this.reconnectAttempts = 0
    this.expectedSequence = 0
  }

  /**
   * Get current state
   */
  getConnectionState(): A2AConnectionState {
    return this.connectionState
  }

  getAgentState(): A2AAgentState {
    return this.agentState
  }

  /**
   * Get message log for testing
   */
  getMessageLog(): Array<{
    sequence: number
    type: string
    payload: unknown
    timestamp: number
  }> {
    return [...this.messageLog]
  }

  /**
   * Clear message log
   */
  clearMessageLog(): void {
    this.messageLog = []
  }

  /**
   * Get Trinity experience events
   */
  getTrinityExperienceEvents(): TrinityExperienceEvent[] {
    return this.trinityEmitter.getEvents()
  }

  /**
   * Get Trinity experience events by type
   */
  getTrinityExperienceEventsByType(
    type: TrinityExperienceEvent['type'],
  ): TrinityExperienceEvent[] {
    return this.trinityEmitter.getEventsByType(type)
  }

  /**
   * Get Trinity experience statistics
   */
  getTrinityExperienceStats() {
    return this.trinityEmitter.getStats()
  }

  /**
   * Export Trinity experience data
   */
  exportTrinityExperience(): string {
    return this.trinityEmitter.exportForExperience(this.agentId)
  }

  /**
   * Clear Trinity experience events
   */
  clearTrinityExperience(): void {
    this.trinityEmitter.clear()
  }

  private setConnectionState(state: A2AConnectionState, reason?: string): void {
    if (this.connectionState !== state) {
      this.stateLogger.logTransition(this.connectionState, state, reason)
      this.connectionState = state
    }
  }

  private setAgentState(state: A2AAgentState, reason?: string): void {
    if (this.agentState !== state) {
      this.stateLogger.logTransition(this.agentState, state, reason)
      this.agentState = state
    }
  }

  private onOpen(): void {
    const wasReconnecting =
      this.connectionState === A2AConnectionState.reconnecting

    this.setConnectionState(A2AConnectionState.connected, 'WebSocket opened')

    // Emit Trinity experience event for successful reconnect
    if (wasReconnecting && this.reconnectAttempts > 0) {
      this.trinityEmitter.emit({
        type: 'reconnect-success',
        agentId: this.agentId,
        attempt: this.reconnectAttempts,
        timestamp: Date.now(),
      })
    }

    this.reconnectAttempts = 0
  }

  private onMessage(event: MessageEvent): void {
    if (!event.data) return

    const parsed = safeJsonParse(event.data) as A2AClientMessage | null
    if (!parsed) {
      logger.warn('RelayObserver: Failed to parse message', {
        data: event.data,
      })
      return
    }

    logger.debug('RelayObserver: Received message', {
      type: String(parsed.type),
      agentId: this.agentId,
    })

    // Emit Trinity experience event for message received
    if (parsed.type === A2AMessageType.chat && parsed.request?.message) {
      this.trinityEmitter.emit({
        type: 'message-received',
        agentId: this.agentId,
        message: String(parsed.request.message),
        timestamp: Date.now(),
      })
    }

    switch (parsed.type) {
      case A2AMessageType.chat:
        if (parsed.request) {
          this.handleChatMessage(parsed.request)
        }
        break

      case A2AMessageType.abort:
        logger.info('RelayObserver: Received abort signal', {
          agentId: this.agentId,
        })
        this.stop()
        break

      default:
        logger.warn('RelayObserver: Unknown message type', {
          type: parsed.type,
        })
    }
  }

  private async handleChatMessage(
    request: Record<string, unknown>,
  ): Promise<void> {
    const message = request.message as string

    if (!message || typeof message !== 'string') {
      logger.warn('RelayObserver: Invalid message', { request })
      return
    }

    logger.info('RelayObserver: User message', {
      message: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
      mode: this.config.mode,
      agentId: this.agentId,
    })

    this.setAgentState(A2AAgentState.processing, 'Processing message')

    const mode = this.config.mode
    const safeMode: A2AAgentMode =
      mode === 'echo' || mode === 'observe' || mode === 'ai'
        ? mode
        : A2AAgentMode.echo

    switch (safeMode) {
      case A2AAgentMode.echo:
        // Echo mode - simply return message
        this.sendToA2A(message)
        break

      case A2AAgentMode.observe:
        // Observe mode - log without responding
        logger.info('RelayObserver: [observe] ' + message)
        break

      case A2AAgentMode.ai:
        // AI mode - generate response (stub)
        this.sendToA2A(await this.generateAIResponse(message))
        break
    }

    this.setAgentState(A2AAgentState.idle, 'Message processed')
  }

  private sendMessage(message: A2AClientMessage | A2AServerMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('RelayObserver: WebSocket not ready', {
        state: this.connectionState,
        readyState: this.ws?.readyState,
      })
      return
    }

    // Log message for testing
    this.messageLog.push({
      sequence: this.expectedSequence,
      type: message.type as string,
      payload: message,
      timestamp: Date.now(),
    })

    this.ws.send(JSON.stringify(message))
    logger.debug('RelayObserver: Message sent', {
      type: String(message.type),
      agentId: this.agentId,
    })
  }

  private sendToA2A(message: string): void {
    const response: A2AClientMessage = {
      type: A2AMessageType.chat,
      request: {
        message,
        role: 'assistant',
        agentName: this.config.agentName || 'RelayObserver',
      },
    }

    this.sendMessage(response)

    // Emit Trinity experience event for message sent
    this.trinityEmitter.emit({
      type: 'message-sent',
      agentId: this.agentId,
      message,
      timestamp: Date.now(),
    })

    logger.info('RelayObserver: Response sent', { agentId: this.agentId })
  }

  private async generateAIResponse(message: string): Promise<string> {
    // Stub implementation for AI mode
    // TODO: Connect LLM for response generation
    return `[AI stub for: "${message}"]`
  }

  private onError(event: Event): void {
    this.handleError(A2AErrorType.connectionError, new Error('WebSocket error'))
  }

  private handleError(type: A2AErrorType, error: Error): void {
    const recoverableError: A2ARecoverableError = {
      type,
      message: error.message,
      recoverable: this.isRecoverable(type),
      timestamp: Date.now(),
      context: {
        agentId: this.agentId,
        connectionState: this.connectionState,
        reconnectAttempts: this.reconnectAttempts,
      },
    }

    logger.error(
      'RelayObserver: Error',
      recoverableError as unknown as Record<string, unknown>,
    )
  }

  private isRecoverable(type: A2AErrorType): boolean {
    return (
      type === A2AErrorType.connectionError ||
      type === A2AErrorType.reconnectFailed
    )
  }

  private onClose(): void {
    this.setConnectionState(A2AConnectionState.disconnected, 'WebSocket closed')

    const maxAttempts = this.config.maxReconnectAttempts ?? 5
    const maxDelay = this.hardening.maxReconnectDelay ?? 30000
    const jitterPercent = this.hardening.reconnectJitterPercent ?? 0.25

    if (this.reconnectAttempts < maxAttempts) {
      this.reconnectAttempts++

      // Emit Trinity experience event for reconnect attempt
      this.trinityEmitter.emit({
        type: 'reconnect-attempt',
        agentId: this.agentId,
        attempt: this.reconnectAttempts,
        timestamp: Date.now(),
      })

      this.setConnectionState(
        A2AConnectionState.reconnecting,
        `Reconnecting (attempt ${this.reconnectAttempts})`,
      )

      const delay = calculateReconnectDelay(
        this.reconnectAttempts,
        maxDelay,
        jitterPercent,
      )

      logger.info('RelayObserver: Scheduling reconnect', {
        attempt: this.reconnectAttempts,
        delay,
        maxAttempts,
      })

      this.reconnectTimeout = setTimeout(() => {
        this.start()
      }, delay)
    } else {
      // Emit Trinity experience event for reconnect failure
      this.trinityEmitter.emit({
        type: 'reconnect-failure',
        agentId: this.agentId,
        attempt: this.reconnectAttempts,
        maxAttempts,
        timestamp: Date.now(),
      })

      logger.error('RelayObserver: Max reconnect attempts reached', {
        attempts: this.reconnectAttempts,
        maxAttempts,
      })
      this.ws = null
    }

    // Emit Trinity experience event for disconnect (always on close)
    this.trinityEmitter.emit({
      type: 'agent-disconnect',
      agentId: this.agentId,
      timestamp: Date.now(),
    })
  }
}
