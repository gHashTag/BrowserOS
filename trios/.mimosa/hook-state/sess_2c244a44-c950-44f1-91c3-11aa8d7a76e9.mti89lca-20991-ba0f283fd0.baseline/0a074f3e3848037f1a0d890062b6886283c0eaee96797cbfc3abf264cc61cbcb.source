import {
  type UIMessageStreamEvent,
  UIMessageStreamEventSchema,
} from '@browseros/shared/schemas/ui-stream'

/**
 * Parse SSE data lines into validated UIMessageStreamEvents.
 * Shared by CaptureContext and StreamTextAccumulator.
 */
export function parseSSEEvents(data: string): UIMessageStreamEvent[] {
  const events: UIMessageStreamEvent[] = []
  const lines = data.split('\n')
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    const jsonStr = line.slice(6)
    if (jsonStr === '[DONE]') continue
    try {
      const parsed = JSON.parse(jsonStr)
      const result = UIMessageStreamEventSchema.safeParse(parsed)
      if (result.success) events.push(result.data)
    } catch {
      // Ignore parse errors
    }
  }
  return events
}

/**
 * Accumulates SSE stream data into validated UIMessageStreamEvents.
 * Provides text extraction and tool introspection without file I/O.
 */
export class StreamTextAccumulator {
  private events: UIMessageStreamEvent[] = []

  async write(data: string): Promise<void> {
    const parsed = parseSSEEvents(data)
    this.events.push(...parsed)
  }

  /**
   * Get last complete assistant text.
   * Accumulates text-start/delta/end sequences, returns the final one.
   */
  getLastText(): string | null {
    let lastText = ''
    let currentText = ''
    for (const event of this.events) {
      if (event.type === 'text-start') currentText = ''
      else if (event.type === 'text-delta') currentText += event.delta
      else if (event.type === 'text-end') {
        lastText = currentText
        currentText = ''
      }
    }
    return lastText || null
  }

  getToolNames(): string[] {
    const names = new Set<string>()
    for (const event of this.events) {
      if (event.type === 'tool-input-available') names.add(event.toolName)
    }
    return [...names]
  }

  getToolCallCount(): number {
    return this.events.filter((e) => e.type === 'tool-input-available').length
  }

  getEvents(): UIMessageStreamEvent[] {
    return [...this.events]
  }

  reset(): void {
    this.events = []
  }
}
