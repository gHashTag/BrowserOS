import type { ErrorSource, EvalWarning, Message, TaskError } from '../types'
import { MessageLogger } from './message-logger'
import { ScreenshotCapture } from './screenshot'
import { parseSSEEvents } from './stream-text-accumulator'
import { TrajectorySaver } from './trajectory-saver'
import type { CaptureContextConfig } from './types'

export class CaptureContext {
  private serverUrl: string
  private taskId: string
  private errors: TaskError[] = []
  private warnings: EvalWarning[] = []
  private pendingScreenshot: number | null = null
  private onEvent?: (taskId: string, event: Record<string, unknown>) => void

  private activePageId: number

  screenshot!: ScreenshotCapture
  messageLogger!: MessageLogger
  trajectorySaver: TrajectorySaver

  private constructor(config: CaptureContextConfig) {
    this.serverUrl = config.serverUrl
    this.taskId = config.taskId
    this.activePageId = config.initialPageId
    this.onEvent = config.onEvent
    this.trajectorySaver = new TrajectorySaver(config.outputDir, config.taskId)
  }

  static async create(
    config: CaptureContextConfig,
  ): Promise<{ capture: CaptureContext; taskOutputDir: string }> {
    const capture = new CaptureContext(config)
    const taskOutputDir = await capture.initInternal()
    return { capture, taskOutputDir }
  }

  private async initInternal(): Promise<string> {
    const taskOutputDir = await this.trajectorySaver.init()
    this.screenshot = new ScreenshotCapture(this.serverUrl, taskOutputDir)
    await this.screenshot.init()
    this.messageLogger = new MessageLogger(taskOutputDir)
    return taskOutputDir
  }

  getActivePageId(): number {
    return this.activePageId
  }

  setActivePageId(pageId: number): void {
    this.activePageId = pageId
  }

  emitEvent(taskId: string, event: Record<string, unknown>): void {
    this.onEvent?.(taskId, event)
  }

  /**
   * Create a stream writer that captures and logs all stream events
   */
  createStreamWriter(): { write: (data: string) => Promise<void> } {
    return {
      write: async (data: string) => {
        const events = parseSSEEvents(data)
        for (const event of events) {
          if (
            event.type === 'tool-output-available' ||
            event.type === 'tool-output-error'
          ) {
            await this.messageLogger.logStreamEvent(
              event,
              this.pendingScreenshot ?? undefined,
            )
            this.onEvent?.(this.taskId, {
              ...event,
              screenshot: this.pendingScreenshot,
            } as Record<string, unknown>)
            this.pendingScreenshot = null
          } else {
            await this.messageLogger.logStreamEvent(event)
            this.onEvent?.(this.taskId, event as Record<string, unknown>)
          }
        }
      },
    }
  }

  addError(
    source: ErrorSource,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.errors.push({
      source,
      message,
      timestamp: new Date().toISOString(),
      details,
    })
  }

  addWarning(source: ErrorSource, message: string): void {
    console.warn(`[${source}] ${message}`)
    this.warnings.push({
      source,
      message,
      timestamp: new Date().toISOString(),
    })
  }

  getErrors(): TaskError[] {
    return [...this.errors]
  }

  getWarnings(): EvalWarning[] {
    return [...this.warnings]
  }

  getMessages(): Message[] {
    return this.messageLogger.getMessages()
  }

  getScreenshotCount(): number {
    return this.screenshot.getCount()
  }

  getLastAssistantText(): string | null {
    return this.messageLogger.getLastAssistantText()
  }
}
