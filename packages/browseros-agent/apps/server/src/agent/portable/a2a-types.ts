/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * A2A Types
 *
 * Strict type definitions derived from relay_observer.t27 specification
 * Ensures protocol compliance across TypeScript implementations
 */

import type { UIMessageStreamEvent } from '@trios/shared/schemas/ui-stream'

// ============================================================================
// Message Types
// ============================================================================

/**
 * Message types for WebSocket communication
 * Corresponds to MessageType enum from relay_observer.t27
 */
export enum A2AMessageType {
  ready = 'ready',
  chat = 'chat',
  abort = 'abort',
  sse = 'sse',
  error = 'error',
}

/**
 * SSE event types for streaming responses
 * Corresponds to SseEvent struct from relay_observer.t27
 */
export enum A2ASseEventType {
  textDelta = 'text-delta',
  done = 'done',
  toolStart = 'tool-start',
  toolEnd = 'tool-end',
  error = 'error',
}

/**
 * Agent operating modes
 * Corresponds to AgentMode enum from relay_observer.t27
 */
export enum A2AAgentMode {
  echo = 'echo',
  observe = 'observe',
  ai = 'ai',
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Relay Observer configuration interface
 * Derived from RelayObserverConfig struct in relay_observer.t27
 */
export interface A2ARelayObserverConfig {
  /** A2A WebSocket server port (default 3001) */
  a2aPort: number

  /** Optional shared secret for A2A access */
  a2aKey?: string

  /** Target conversation ID for message routing */
  conversationId?: string

  /** Agent mode: echo, observe, or ai */
  mode: A2AAgentMode

  /** Agent display name */
  agentName?: string

  /** Greeting message on connect */
  greetingMessage?: string

  /** Maximum reconnect attempts */
  maxReconnectAttempts?: number

  /** Delay between reconnect attempts (ms) */
  reconnectDelay?: number

  /** Reconnect delay multiplier (doubles each attempt) */
  reconnectDelayMultiplier?: number

  /** Hardening options for security and resilience */
  hardening?: A2AHardeningOptions
}

// ============================================================================
// WebSocket Messages
// ============================================================================

/**
 * Client message sent to A2A server
 */
export interface A2AClientMessage {
  /** Message type identifier */
  type: A2AMessageType

  /** Request payload (for chat messages) */
  request?: {
    message?: string
    role?: 'user' | 'assistant'
    agentName?: string
    conversationId?: string
    [key: string]: unknown
  }
}

/**
 * Server message received from A2A server
 */
export interface A2AServerMessage {
  /** Message type identifier */
  type: A2AMessageType

  /** Event data for SSE messages */
  event?: UIMessageStreamEvent

  /** Error message (optional) */
  message?: string
}

// ============================================================================
// Multi-Agent Routing
// ============================================================================

/**
 * Routing target information for multi-agent scenarios
 */
export interface A2ARoutingTarget {
  /** Target agent identifier */
  targetAgentId?: string

  /** Source agent identifier */
  sourceAgentId?: string

  /** Message sequence number for ordering */
  sequence?: number
}

/**
 * Message with routing information
 */
export type A2ARoutedMessage = A2AClientMessage & A2ARoutingTarget

// ============================================================================
// Connection State
// ============================================================================

/**
 * WebSocket connection states
 */
export enum A2AConnectionState {
  disconnected = 'disconnected',
  connecting = 'connecting',
  connected = 'connected',
  reconnecting = 'reconnecting',
  closed = 'closed',
}

/**
 * Agent operational states
 */
export enum A2AAgentState {
  idle = 'idle',
  processing = 'processing',
  error = 'error',
  stopped = 'stopped',
}

/**
 * State transition log entry
 */
export interface A2AStateTransition {
  from: A2AConnectionState | A2AAgentState
  to: A2AConnectionState | A2AAgentState
  timestamp: number
  reason?: string
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * A2A error categories
 */
export enum A2AErrorType {
  connectionError = 'connection_error',
  parseError = 'parse_error',
  sendError = 'send_error',
  reconnectFailed = 'reconnect_failed',
  sequenceError = 'sequence_error',
  routingError = 'routing_error',
}

/**
 * Recoverable error information
 */
export interface A2ARecoverableError {
  type: A2AErrorType
  message: string
  recoverable: boolean
  timestamp: number
  context?: Record<string, unknown>
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Hardening options for Relay Observer
 */
export interface A2AHardeningOptions {
  /** Enable sequence validation */
  enableSequenceValidation?: boolean

  /** Enable state logging */
  enableStateLogging?: boolean

  /** Maximum reconnect delay (ms) */
  maxReconnectDelay?: number

  /** Jitter percentage for reconnect delay (default 25%) */
  reconnectJitterPercent?: number
}

/**
 * Default hardening options
 */
export const DEFAULT_HARDENING: A2AHardeningOptions = {
  enableSequenceValidation: false,
  enableStateLogging: true,
  maxReconnectDelay: 30000,
  reconnectJitterPercent: 0.25,
}
