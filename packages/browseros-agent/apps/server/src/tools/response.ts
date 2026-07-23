import { TIMEOUTS } from '@browseros/shared/constants/timeouts'
import type { Browser } from '../browser/browser'

export type ContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export type PostAction =
  | { type: 'snapshot'; page: number }
  | { type: 'screenshot'; page: number }
  | { type: 'pages' }

export interface ToolResultMetadata {
  tabId?: number
}

export interface ToolResult {
  content: ContentItem[]
  isError?: boolean
  metadata?: ToolResultMetadata
  structuredContent?: Record<string, unknown>
}

interface ToolResponseOptions {
  postActionTimeoutMs?: number
}

function cloneStructuredValue<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch (error) {
    throw new TypeError('ToolResponse structured data must be cloneable', {
      cause: error,
    })
  }
}

function cloneAndValidateStructured(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const cloned = cloneStructuredValue(value)
  try {
    JSON.stringify(cloned)
  } catch (error) {
    throw new TypeError(
      'ToolResponse structured data must be JSON-serializable',
      { cause: error },
    )
  }
  return cloned
}

export class ToolResponse {
  private content: ContentItem[] = []
  private hasError = false
  private structured: Record<string, unknown> = {}
  private postActions: PostAction[] = []
  private postActionTimeoutMs: number

  constructor(options: ToolResponseOptions = {}) {
    this.postActionTimeoutMs =
      options.postActionTimeoutMs ?? TIMEOUTS.TOOL_POST_ACTION
  }

  text(value: string): void {
    this.content.push({ type: 'text', text: value })
  }

  image(data: string, mimeType: string): void {
    this.content.push({ type: 'image', data, mimeType })
  }

  error(message: string): void {
    this.hasError = true
    this.content.push({ type: 'text', text: message })
  }

  data(key: string, value: unknown): void
  data(obj: Record<string, unknown>): void
  data(keyOrObj: string | Record<string, unknown>, value?: unknown): void {
    const candidate = { ...this.structured }
    if (typeof keyOrObj === 'string') {
      candidate[keyOrObj] = value
    } else {
      Object.assign(candidate, keyOrObj)
    }
    this.structured = cloneAndValidateStructured(candidate)
  }

  includeSnapshot(page: number): void {
    this.postActions.push({ type: 'snapshot', page })
  }

  includeScreenshot(page: number): void {
    this.postActions.push({ type: 'screenshot', page })
  }

  includePages(): void {
    this.postActions.push({ type: 'pages' })
  }

  private async runPostAction(
    action: PostAction,
    browser: Browser,
  ): Promise<ContentItem[]> {
    switch (action.type) {
      case 'snapshot': {
        const tree = await browser.snapshot(action.page)
        return tree
          ? [{ type: 'text', text: `[Page ${action.page} snapshot]\n${tree}` }]
          : []
      }
      case 'screenshot': {
        const result = await browser.screenshot(action.page, {
          format: 'png',
          fullPage: false,
        })
        return [
          { type: 'text', text: `[Page ${action.page} screenshot]` },
          { type: 'image', data: result.data, mimeType: result.mimeType },
        ]
      }
      case 'pages': {
        const pages = await browser.listPages()
        if (pages.length === 0) {
          return [{ type: 'text', text: '[Open pages] None' }]
        }
        const lines = pages.map(
          (p) =>
            `  ${p.pageId}. ${p.title || '(untitled)'} — ${p.url}${p.isActive ? ' [ACTIVE]' : ''}`,
        )
        return [{ type: 'text', text: `[Open pages]\n${lines.join('\n')}` }]
      }
    }
  }

  private async withTimeout<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new Error('Post-action aborted')
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    try {
      const pending: Promise<T>[] = [
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error('Post-action timed out'))
          }, this.postActionTimeoutMs)
        }),
      ]

      if (signal) {
        pending.push(
          new Promise<T>((_, reject) => {
            const abort = () => reject(new Error('Post-action aborted'))
            if (signal.aborted) {
              abort()
              return
            }
            abortListener = abort
            signal.addEventListener('abort', abort, { once: true })
          }),
        )
      }

      const taskPromise = Promise.resolve().then(async () => {
        if (signal?.aborted) {
          throw new Error('Post-action aborted')
        }
        return await task()
      })
      pending.unshift(taskPromise)

      return await Promise.race(pending)
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      if (abortListener) {
        signal?.removeEventListener('abort', abortListener)
      }
    }
  }

  async build(browser: Browser, signal?: AbortSignal): Promise<ToolResult> {
    if (this.postActions.length > 0) {
      this.text('\n--- Additional context (auto-included) ---')
    }

    for (const action of this.postActions) {
      if (signal?.aborted) break
      try {
        const content = await this.withTimeout(
          () => this.runPostAction(action, browser),
          signal,
        )
        if (signal?.aborted) break
        this.content.push(...content)
      } catch {
        // Post-action failure doesn't fail the tool
        if (signal?.aborted) break
      }
    }
    return this.toResult()
  }

  toResult(): ToolResult {
    const hasStructured = Object.keys(this.structured).length > 0
    return {
      content: this.content.map((item) => ({ ...item })),
      ...(this.hasError && { isError: true }),
      ...(hasStructured && {
        structuredContent: cloneStructuredValue(this.structured),
      }),
    }
  }
}
