import {
  isToolInputAvailable,
  isToolInputError,
  isToolOutputError,
  type Message,
} from '../../types'
import type { PreComputedMetrics } from './types'

export function extractMetrics(
  messages: Message[],
  screenshotCount: number,
  terminationReason = 'unknown',
): PreComputedMetrics {
  let totalToolCalls = 0
  let errorCount = 0
  let stepCount = 0
  const toolNames = new Set<string>()

  let firstTimestamp: string | null = null
  let lastTimestamp: string | null = null

  for (const msg of messages) {
    const ts = 'timestamp' in msg ? (msg.timestamp as string) : null
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts
      lastTimestamp = ts
    }

    if (isToolInputAvailable(msg)) {
      totalToolCalls++
      toolNames.add(msg.toolName)
    }

    if (isToolOutputError(msg) || isToolInputError(msg)) {
      errorCount++
    }

    if ('type' in msg && msg.type === 'start-step') {
      stepCount++
    }
  }

  const totalDurationMs =
    firstTimestamp && lastTimestamp
      ? new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()
      : 0

  return {
    totalDurationMs,
    totalToolCalls,
    errorCount,
    errorRate: totalToolCalls > 0 ? errorCount / totalToolCalls : 0,
    screenshotCount,
    uniqueToolNames: Array.from(toolNames),
    stepCount,
    terminationReason,
  }
}
