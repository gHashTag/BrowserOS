/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Trinity A2A Benchmark Harness
 *
 * Runs controlled A2A sessions and measures:
 * - Message latency (sent → received)
 * - Reconnect intervals (attempt → success/failure)
 * - p50/p95/p99 percentiles
 * - Delta comparison to previous runs
 */

import type { TrinityExperienceEvent } from './relay-observer'
import { RelayObserver } from './relay-observer'
import { A2A_PORT } from '@browseros/shared/constants/ports'
import type { A2ARelayObserverConfig } from './a2a-types'

export interface BenchmarkConfig {
  /** Number of controlled sessions to run */
  sessions: number

  /** Messages per session */
  messagesPerSession: number

  /** Simulate reconnection after N messages (0 = no reconnect) */
  simulateReconnectAfter: number

  /** Max reconnect attempts per session */
  maxReconnectAttempts: number

  /** A2A port (from ports.ts SSOT) */
  a2aPort: number

  /** Previous benchmark data for delta comparison */
  previousRun?: BenchmarkResult
}

export interface BenchmarkMetrics {
  /** Message latency in milliseconds */
  messageLatency: {
    min: number
    max: number
    p50: number
    p95: number
    p99: number
    mean: number
    samples: number
  }

  /** Reconnect latency in milliseconds */
  reconnectLatency: {
    min: number
    max: number
    p50: number
    p95: number
    p99: number
    mean: number
    samples: number
  }

  /** Reconnect success rate */
  reconnectSuccessRate: number

  /** Connection stability */
  connectionStability: {
    totalConnections: number
    disconnects: number
    sessionsCompleted: number
  }
}

export interface BenchmarkResult {
  /** Timestamp of benchmark run */
  timestamp: number

  /** Configuration used */
  config: BenchmarkConfig

  /** Collected metrics */
  metrics: BenchmarkMetrics

  /** Delta from previous run */
  delta?: {
    messageLatency: { p50: number; p95: number; p99: number; mean: number }
    reconnectLatency: { p50: number; p95: number; p99: number; mean: number }
    reconnectSuccessRate: number
  }

  /** Verdict based on thresholds */
  verdict: 'pass' | 'warning' | 'fail'

  /** All raw events for analysis */
  events: TrinityExperienceEvent[]
}

export interface Thresholds {
  /** Max acceptable p95 message latency (ms) */
  maxMessageLatencyP95: number

  /** Max acceptable p95 reconnect latency (ms) */
  maxReconnectLatencyP95: number

  /** Min acceptable reconnect success rate (0-1) */
  minReconnectSuccessRate: number
}

export const DEFAULT_THRESHOLD: Thresholds = {
  maxMessageLatencyP95: 500, // 500ms for 95th percentile
  maxReconnectLatencyP95: 5000, // 5s for 95th percentile reconnect
  minReconnectSuccessRate: 0.8, // 80% reconnect success
}

/**
 * Calculate percentiles from sorted array
 */
function calculatePercentiles(values: number[]) {
  if (values.length === 0) {
    return { min: 0, max: 0, p50: 0, p95: 0, p99: 0, mean: 0, samples: 0 }
  }

  const sorted = [...values].sort((a, b) => a - b)
  const count = sorted.length

  const min = sorted[0]
  const max = sorted[count - 1]
  const mean = sorted.reduce((a, b) => a + b, 0) / count

  const p50 = sorted[Math.floor(count * 0.5)]
  const p95 = sorted[Math.floor(count * 0.95)]
  const p99 = sorted[Math.floor(count * 0.99)]

  return { min, max, p50, p95, p99, mean, samples: count }
}

/**
 * Calculate delta between current and previous metrics
 */
function calculateDelta(
  current: { p50: number; p95: number; p99: number; mean: number },
  previous: { p50: number; p95: number; p99: number; mean: number }
) {
  return {
    p50: ((current.p50 - previous.p50) / previous.p50) * 100,
    p95: ((current.p95 - previous.p95) / previous.p95) * 100,
    p99: ((current.p99 - previous.p99) / previous.p99) * 100,
    mean: ((current.mean - previous.mean) / previous.mean) * 100,
  }
}

/**
 * Determine verdict based on thresholds
 */
function determineVerdict(
  metrics: BenchmarkMetrics,
  thresholds: Thresholds,
  delta?: { reconnectSuccessRate: number }
): 'pass' | 'warning' | 'fail' {
  const fails = []
  const warnings = []

  // Check message latency
  if (metrics.messageLatency.p95 > thresholds.maxMessageLatencyP95 * 1.5) {
    fails.push(`Message latency p95 (${metrics.messageLatency.p95}ms) exceeds threshold (${thresholds.maxMessageLatencyP95 * 1.5}ms)`)
  } else if (metrics.messageLatency.p95 > thresholds.maxMessageLatencyP95) {
    warnings.push(`Message latency p95 (${metrics.messageLatency.p95}ms) above threshold (${thresholds.maxMessageLatencyP95}ms)`)
  }

  // Check reconnect latency
  if (metrics.reconnectLatency.samples > 0) {
    if (metrics.reconnectLatency.p95 > thresholds.maxReconnectLatencyP95 * 1.5) {
      fails.push(`Reconnect latency p95 (${metrics.reconnectLatency.p95}ms) exceeds threshold (${thresholds.maxReconnectLatencyP95 * 1.5}ms)`)
    } else if (metrics.reconnectLatency.p95 > thresholds.maxReconnectLatencyP95) {
      warnings.push(`Reconnect latency p95 (${metrics.reconnectLatency.p95}ms) above threshold (${thresholds.maxReconnectLatencyP95}ms)`)
    }
  }

  // Check reconnect success rate
  if (metrics.reconnectLatency.samples > 0 && metrics.reconnectSuccessRate < thresholds.minReconnectSuccessRate * 0.8) {
    fails.push(`Reconnect success rate (${(metrics.reconnectSuccessRate * 100).toFixed(1)}%)) below minimum (${thresholds.minReconnectSuccessRate * 0.8 * 100}%)`)
  } else if (metrics.reconnectSuccessRate < thresholds.minReconnectSuccessRate) {
    warnings.push(`Reconnect success rate (${(metrics.reconnectSuccessRate * 100).toFixed(1)}%)) below target (${thresholds.minReconnectSuccessRate * 100}%)`)
  }

  // Check for regression in delta
  if (delta) {
    if (delta.reconnectSuccessRate < -10) {
      warnings.push(`Reconnect success rate degraded by ${Math.abs(delta.reconnectSuccessRate).toFixed(1)}%`)
    }
  }

  if (fails.length > 0) return 'fail'
  if (warnings.length > 0) return 'warning'
  return 'pass'
}

/**
 * Benchmark harness for running controlled A2A sessions
 */
export class TrinityBenchmarkHarness {
  private config: BenchmarkConfig
  private thresholds: Thresholds
  private events: TrinityExperienceEvent[] = []

  constructor(config: Partial<BenchmarkConfig> = {}, thresholds: Partial<Thresholds> = {}) {
    this.config = {
      sessions: config.sessions ?? 10,
      messagesPerSession: config.messagesPerSession ?? 5,
      simulateReconnectAfter: config.simulateReconnectAfter ?? 2,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 3,
      a2aPort: config.a2aPort ?? A2A_PORT,
      previousRun: config.previousRun,
    }

    this.thresholds = {
      maxMessageLatencyP95: thresholds.maxMessageLatencyP95 ?? DEFAULT_THRESHOLD.maxMessageLatencyP95,
      maxReconnectLatencyP95: thresholds.maxReconnectLatencyP95 ?? DEFAULT_THRESHOLD.maxReconnectLatencyP95,
      minReconnectSuccessRate: thresholds.minReconnectSuccessRate ?? DEFAULT_THRESHOLD.minReconnectSuccessRate,
    }
  }

  /**
   * Run the benchmark and return results
   */
  async run(events: TrinityExperienceEvent[]): Promise<BenchmarkResult> {
    this.events = events

    const messageLatencies = this.extractMessageLatencies()
    const reconnectLatencies = this.extractReconnectLatencies()

    const metrics: BenchmarkMetrics = {
      messageLatency: calculatePercentiles(messageLatencies),
      reconnectLatency: calculatePercentiles(reconnectLatencies),
      reconnectSuccessRate: this.calculateReconnectSuccessRate(),
      connectionStability: this.calculateConnectionStability(),
    }

    const delta = this.config.previousRun
      ? {
          messageLatency: calculateDelta(
            metrics.messageLatency,
            this.config.previousRun.metrics.messageLatency
          ),
          reconnectLatency: calculateDelta(
            metrics.reconnectLatency,
            this.config.previousRun.metrics.reconnectLatency
          ),
          reconnectSuccessRate:
            ((metrics.reconnectSuccessRate - this.config.previousRun.metrics.reconnectSuccessRate) /
              this.config.previousRun.metrics.reconnectSuccessRate) *
            100,
        }
      : undefined

    const verdict = determineVerdict(metrics, this.thresholds, delta)

    return {
      timestamp: Date.now(),
      config: this.config,
      metrics,
      delta,
      verdict,
      events: this.events,
    }
  }

  /**
   * Extract message latencies (sent → received roundtrip)
   */
  private extractMessageLatencies(): number[] {
    const latencies: number[] = []
    const sentEvents = new Map<string, number>() // message → timestamp

    for (const event of this.events) {
      if (event.type === 'message-sent') {
        sentEvents.set(event.message, event.timestamp)
      } else if (event.type === 'message-received') {
        const sentTime = sentEvents.get(event.message)
        if (sentTime) {
          latencies.push(event.timestamp - sentTime)
          sentEvents.delete(event.message) // Prevent duplicate counting
        }
      }
    }

    return latencies
  }

  /**
   * Extract reconnect latencies (attempt → success/failure)
   */
  private extractReconnectLatencies(): number[] {
    const latencies: number[] = []
    const reconnectAttempts = new Map<number, { timestamp: number; agentId: string }>() // attempt → { timestamp, agentId }

    for (const event of this.events) {
      if (event.type === 'reconnect-attempt') {
        reconnectAttempts.set(event.attempt, { timestamp: event.timestamp, agentId: event.agentId })
      } else if (event.type === 'reconnect-success') {
        const attempt = reconnectAttempts.get(event.attempt)
        if (attempt && attempt.agentId === event.agentId) {
          latencies.push(event.timestamp - attempt.timestamp)
          reconnectAttempts.delete(event.attempt)
        }
      } else if (event.type === 'reconnect-failure') {
        reconnectAttempts.delete(event.attempt) // Failed attempts don't have success latency
      }
    }

    return latencies
  }

  /**
   * Calculate reconnect success rate
   */
  private calculateReconnectSuccessRate(): number {
    let attempts = 0
    let successes = 0

    for (const event of this.events) {
      if (event.type === 'reconnect-attempt') {
        attempts++
      } else if (event.type === 'reconnect-success') {
        successes++
      }
    }

    return attempts > 0 ? successes / attempts : 1
  }

  /**
   * Calculate connection stability metrics
   */
  private calculateConnectionStability() {
    let connections = 0
    let disconnects = 0
    const sessions = new Set<string>()

    for (const event of this.events) {
      sessions.add(event.agentId)
      if (event.type === 'agent-connection') {
        connections++
      } else if (event.type === 'agent-disconnect') {
        disconnects++
      }
    }

    return {
      totalConnections: connections,
      disconnects,
      sessionsCompleted: sessions.size,
    }
  }

  /**
   * Generate a human-readable report
   */
  generateReport(result: BenchmarkResult): string {
    const lines: string[] = []

    lines.push('# Trinity A2A Benchmark Report')
    lines.push(`Timestamp: ${new Date(result.timestamp).toISOString()}`)
    lines.push(`Verdict: ${result.verdict.toUpperCase()}`)
    lines.push('')

    lines.push('## Configuration')
    lines.push(`Sessions: ${result.config.sessions}`)
    lines.push(`Messages per session: ${result.config.messagesPerSession}`)
    lines.push(`A2A Port: ${result.config.a2aPort} (from ports.ts SSOT)`)
    lines.push('')

    lines.push('## Message Latency')
    const ml = result.metrics.messageLatency
    lines.push(`  Min: ${ml.min}ms`)
    lines.push(`  Max: ${ml.max}ms`)
    lines.push(`  Mean: ${ml.mean.toFixed(2)}ms`)
    lines.push(`  P50:  ${ml.p50}ms`)
    lines.push(`  P95:  ${ml.p95}ms (threshold: ${this.thresholds.maxMessageLatencyP95}ms)`)
    lines.push(`  P99:  ${ml.p99}ms`)
    lines.push(`  Samples: ${ml.samples}`)
    lines.push('')

    lines.push('## Reconnect Latency')
    const rl = result.metrics.reconnectLatency
    if (rl.samples > 0) {
      lines.push(`  Min: ${rl.min}ms`)
      lines.push(`  Max: ${rl.max}ms`)
      lines.push(`  Mean: ${rl.mean.toFixed(2)}ms`)
      lines.push(`  P50:  ${rl.p50}ms`)
      lines.push(`  P95:  ${rl.p95}ms (threshold: ${this.thresholds.maxReconnectLatencyP95}ms)`)
      lines.push(`  P99:  ${rl.p99}ms`)
      lines.push(`  Samples: ${rl.samples}`)
    } else {
      lines.push('  No reconnect events captured')
    }
    lines.push('')

    lines.push('## Reconnect Success Rate')
    lines.push(`  ${(result.metrics.reconnectSuccessRate * 100).toFixed(1)}% (threshold: ${(this.thresholds.minReconnectSuccessRate * 100).toFixed(1)}%)`)
    lines.push('')

    lines.push('## Connection Stability')
    const cs = result.metrics.connectionStability
    lines.push(`  Total connections: ${cs.totalConnections}`)
    lines.push(`  Disconnects: ${cs.disconnects}`)
    lines.push(`  Sessions: ${cs.sessionsCompleted}`)
    lines.push('')

    if (result.delta) {
      lines.push('## Delta from Previous Run')
      const d = result.delta
      lines.push('### Message Latency Delta')
      lines.push(`  P50:  ${d.messageLatency.p50 > 0 ? '+' : ''}${d.messageLatency.p50.toFixed(1)}%`)
      lines.push(`  P95:  ${d.messageLatency.p95 > 0 ? '+' : ''}${d.messageLatency.p95.toFixed(1)}%`)
      lines.push(`  P99:  ${d.messageLatency.p99 > 0 ? '+' : ''}${d.messageLatency.p99.toFixed(1)}%`)
      lines.push(`  Mean: ${d.messageLatency.mean > 0 ? '+' : ''}${d.messageLatency.mean.toFixed(1)}%`)
      lines.push('### Reconnect Latency Delta')
      lines.push(`  P50:  ${d.reconnectLatency.p50 > 0 ? '+' : ''}${d.reconnectLatency.p50.toFixed(1)}%`)
      lines.push(`  P95:  ${d.reconnectLatency.p95 > 0 ? '+' : ''}${d.reconnectLatency.p95.toFixed(1)}%`)
      lines.push(`  P99:  ${d.reconnectLatency.p99 > 0 ? '+' : ''}${d.reconnectLatency.p99.toFixed(1)}%`)
      lines.push(`  Mean: ${d.reconnectLatency.mean > 0 ? '+' : ''}${d.reconnectLatency.mean.toFixed(1)}%`)
      lines.push(`### Success Rate Delta`)
      lines.push(`  ${d.reconnectSuccessRate > 0 ? '+' : ''}${d.reconnectSuccessRate.toFixed(1)}%`)
      lines.push('')
    }

    return lines.join('\n')
  }

  /**
   * Save benchmark result to file for comparison
   */
  saveResult(result: BenchmarkResult, path: string): void {
    const data = JSON.stringify(result, null, 2)
    // Note: In actual implementation, use Bun.write or fs.writeFile
    // This is a placeholder for the API
    console.log(`[BenchmarkHarness] Would save result to: ${path}`)
  }

  /**
   * Load previous benchmark result for comparison
   */
  loadPreviousResult(path: string): BenchmarkResult | null {
    // Note: In actual implementation, read from file
    console.log(`[BenchmarkHarness] Would load previous result from: ${path}`)
    return null
  }

  /**
   * Export events for external analysis
   */
  exportEvents(events: TrinityExperienceEvent[]): string {
    return JSON.stringify({
      exportTimestamp: Date.now(),
      eventCount: events.length,
      events,
    }, null, 2)
  }

  /**
   * Parse events from exported format
   */
  parseEvents(json: string): TrinityExperienceEvent[] {
    const data = JSON.parse(json) as { events: TrinityExperienceEvent[] }
    return data.events || []
  }
}
