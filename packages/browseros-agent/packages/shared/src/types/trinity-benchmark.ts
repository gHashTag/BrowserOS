/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Trinity Benchmark Session Type
 *
 * SSOT format for toxic verdicts and delta-analyses
 * Stores complete session data with all metrics
 */

export interface TrinityBenchmarkSession {
  /** Unique session identifier */
  sessionId: string

  /** Timestamp of first event or session creation */
  timestamp: number

  /** Format version for migration */
  formatVersion: 'v1'

  /** Benchmark configuration used */
  config: BenchmarkConfig

  /** All collected metrics */
  metrics: BenchmarkMetrics

  /** Production readiness verdict */
  verdict: 'production-ready' | 'needs-improvement'

  /** Detailed reasons for verdict when not production-ready */
  verdictDetails?: string[]

  /** Delta comparison with previous run */
  delta?: DeltaMetrics

  /** All raw events for post-analysis */
  events: TrinityExperienceEvent[]

  /** SHA-256 hash of events for integrity verification */
  eventsHash?: string

  /** Total session duration in milliseconds */
  durationMs?: number
}

export interface BenchmarkConfig {
  /** Session identifier (optional, generated if omitted) */
  sessionId?: string

  /** Test name/scenario identifier */
  testName: string

  /** Number of benchmark sessions to run */
  sessions: number

  /** Messages per session */
  messagesPerSession?: number

  /** Simulate reconnect after N messages (0 = no reconnect) */
  simulateReconnectAfter?: number

  /** Max reconnect attempts per session */
  maxReconnectAttempts?: number

  /** A2A WebSocket port used */
  a2aPort?: number

  /** Agent identifier */
  agentId?: string
}

export interface BenchmarkMetrics {
  /** Message latency statistics */
  messageLatency: LatencyStats

  /** Reconnect latency statistics */
  reconnectLatency: LatencyStats

  /** Reconnect success rate (0-1) */
  reconnectSuccessRate: number

  /** Connection stability metrics */
  connectionStability: ConnectionStats
}

export interface LatencyStats {
  /** Minimum latency (ms) */
  min: number

  /** Maximum latency (ms) */
  max: number

  /** Median / 50th percentile (ms) */
  p50: number

  /** 95th percentile (ms) - PRIMARY THRESHOLD METRIC */
  p95: number

  /** 99th percentile (ms) */
  p99: number

  /** Mean latency (ms) */
  mean: number

  /** Number of samples collected */
  samples: number
}

export interface ConnectionStats {
  /** Total connections during session */
  totalConnections: number

  /** Number of disconnects */
  disconnects: number

  /** Unique agent sessions completed */
  sessionsCompleted: number
}

export interface DeltaMetrics {
  /** Message latency delta percentages */
  messageLatency: { p50: number; p95: number; p99: number; mean: number }

  /** Reconnect latency delta percentages */
  reconnectLatency: { p50: number; p95: number; p99: number; mean: number }

  /** Reconnect success rate delta percentage */
  reconnectSuccessRate: number
}

export interface TrinityExperienceEvent {
  type: string
  agentId: string
  timestamp: number
  message?: string
  attempt?: number
}
