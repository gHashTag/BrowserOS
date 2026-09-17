import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type EvalStreamEvent,
  extractLastAssistantText,
  type Message,
  type UIMessageStreamEvent,
  type UserMessage,
} from '../types'

export class MessageLogger {
  private messages: Message[] = []
  private outputPath: string

  constructor(outputDir: string) {
    this.outputPath = join(outputDir, 'messages.jsonl')
  }

  private async append(message: Message): Promise<void> {
    this.messages.push(message)
    await appendFile(this.outputPath, `${JSON.stringify(message)}\n`)
  }

  async logUser(content: string): Promise<void> {
    const message: UserMessage = {
      type: 'user',
      timestamp: new Date().toISOString(),
      content,
    }
    await this.append(message)
  }

  async logStreamEvent(
    event: UIMessageStreamEvent,
    screenshot?: number,
  ): Promise<void> {
    const message: EvalStreamEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      ...(screenshot !== undefined && { screenshot }),
    }
    await this.append(message)
  }

  getMessages(): Message[] {
    return [...this.messages]
  }

  getLastAssistantText(): string | null {
    return extractLastAssistantText(this.messages)
  }
}
