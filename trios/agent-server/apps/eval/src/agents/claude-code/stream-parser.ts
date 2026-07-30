import { randomUUID } from 'node:crypto'
import type { UIMessageStreamEvent } from '../../types'

type JsonObject = Record<string, unknown>

export class ClaudeCodeStreamParser {
  private lastText: string | null = null
  private toolCallCount = 0

  pushLine(line: string): UIMessageStreamEvent[] {
    const trimmed = line.trim()
    if (!trimmed) return []

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return []
    }

    if (!isObject(parsed)) return []

    if (parsed.type === 'assistant') {
      return this.parseAssistantMessage(parsed)
    }
    if (parsed.type === 'user') {
      return this.parseUserMessage(parsed)
    }
    if (parsed.type === 'result' && typeof parsed.result === 'string') {
      this.lastText = parsed.result
    }

    return []
  }

  getLastText(): string | null {
    return this.lastText
  }

  getToolCallCount(): number {
    return this.toolCallCount
  }

  private parseAssistantMessage(message: JsonObject): UIMessageStreamEvent[] {
    const content = contentBlocks(message)
    const events: UIMessageStreamEvent[] = []

    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const id = randomUUID()
        this.lastText = block.text
        events.push(
          { type: 'text-start', id },
          { type: 'text-delta', id, delta: block.text },
          { type: 'text-end', id },
        )
      } else if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        this.toolCallCount++
        events.push({
          type: 'tool-input-available',
          toolCallId: block.id,
          toolName: block.name,
          input: block.input,
        })
      }
    }

    return events
  }

  private parseUserMessage(message: JsonObject): UIMessageStreamEvent[] {
    const content = contentBlocks(message)
    const events: UIMessageStreamEvent[] = []

    for (const block of content) {
      if (
        block.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string'
      ) {
        continue
      }

      if (block.is_error === true) {
        events.push({
          type: 'tool-output-error',
          toolCallId: block.tool_use_id,
          errorText: stringifyToolContent(block.content),
        })
      } else {
        events.push({
          type: 'tool-output-available',
          toolCallId: block.tool_use_id,
          output: normalizeToolContent(block.content),
        })
      }
    }

    return events
  }
}

export function shouldCaptureScreenshotForTool(toolName: string): boolean {
  if (!toolName.startsWith('mcp__browseros__')) return false
  return !toolName.endsWith('__take_screenshot')
}

function contentBlocks(message: JsonObject): JsonObject[] {
  const inner = isObject(message.message) ? message.message : message
  return Array.isArray(inner.content) ? inner.content.filter(isObject) : []
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null
}

function normalizeToolContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  return content.map((item) => {
    if (
      isObject(item) &&
      item.type === 'text' &&
      typeof item.text === 'string'
    ) {
      return item.text
    }
    return item
  })
}

function stringifyToolContent(content: unknown): string {
  const normalized = normalizeToolContent(content)
  if (typeof normalized === 'string') return normalized
  try {
    return JSON.stringify(normalized)
  } catch {
    return String(normalized)
  }
}
