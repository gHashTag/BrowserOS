import { logger } from '../lib/logger'
import type { MonitoringToolEndInput, MonitoringToolStartInput } from './types'

export interface ToolExecutionObserver {
  onToolStart(input: MonitoringToolStartInput): Promise<void>
  onToolEnd(input: MonitoringToolEndInput): Promise<void>
}

export function swallowMonitoringError(
  operation: string,
  error: unknown,
  metadata: Record<string, unknown>,
): void {
  logger.warn(`Lazy monitoring ${operation} failed`, {
    ...metadata,
    error: error instanceof Error ? error.message : String(error),
  })
}

export function buildMonitoringToolOutput(output: {
  content?: unknown
  structuredContent?: unknown
  metadata?: unknown
  isError?: boolean
}): Record<string, unknown> {
  const sanitizeContentItem = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') {
      return item
    }

    const record = item as {
      type?: unknown
      mimeType?: unknown
      data?: unknown
    }

    if (
      record.type === 'image' &&
      typeof record.mimeType === 'string' &&
      typeof record.data === 'string'
    ) {
      return {
        type: 'image',
        mimeType: record.mimeType,
        omitted: true,
        dataLength: record.data.length,
      }
    }

    return item
  }

  return {
    content: Array.isArray(output.content)
      ? output.content.map((item) => sanitizeContentItem(item))
      : output.content,
    structuredContent: output.structuredContent,
    metadata: output.metadata,
    isError: output.isError,
  }
}
