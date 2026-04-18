/**
 * Maps Gemini Computer Use actions to MCP tool calls
 *
 * Coordinate System:
 * - Screenshots captured with size='large' (1028px width, aspect ratio preserved)
 * - Gemini outputs normalized coordinates (0-999) relative to the screenshot
 * - We convert these to actual viewport coordinates by:
 *   1. Getting the real viewport dimensions via JavaScript
 *   2. Scaling normalized coords to actual viewport pixels
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ActionContext, ComputerUseAction, ScreenSize } from './types'
import { DEFAULTS } from './types'

interface McpToolResult {
  content: Array<{
    type: string
    text?: string
    data?: string
    mimeType?: string
  }>
  isError?: boolean
}

const MCP_TIMEOUT_MS = 30000

export class ActionMapper {
  private ctx: ActionContext
  private cachedViewport: ScreenSize | null = null

  constructor(ctx: ActionContext) {
    this.ctx = ctx
  }

  // Store debug info about viewport detection for inclusion in responses
  private viewportDebugInfo: string = ''

  /**
   * Get the actual browser viewport size via JavaScript
   * Caches the result to avoid repeated calls
   * Also stores debug info for troubleshooting
   */
  async getViewportSize(): Promise<ScreenSize> {
    if (this.cachedViewport) {
      return this.cachedViewport
    }

    try {
      const result = await this.callMcp('browser_execute_javascript', {
        tabId: this.ctx.tabId,
        windowId: this.ctx.windowId,
        code: '[window.innerWidth, window.innerHeight]',
      })

      const textContent =
        result.content.find((c) => c.type === 'text')?.text ?? ''

      // Check for error in result
      if (result.isError) {
        this.viewportDebugInfo = `[VIEWPORT ERROR] JS execution failed: ${textContent}. Using fallback: ${this.ctx.screenSize.width}x${this.ctx.screenSize.height}`
        console.warn(this.viewportDebugInfo)
        return this.ctx.screenSize
      }

      // Response format can be multiline:
      // "Result: [1440, 900]" or "Result: [\n  1200,\n  712\n]"
      const arrayMatch = textContent.match(/\[\s*(\d+)\s*,\s*(\d+)\s*\]/s)
      if (arrayMatch) {
        const width = parseInt(arrayMatch[1], 10)
        const height = parseInt(arrayMatch[2], 10)
        if (width > 0 && height > 0) {
          this.cachedViewport = { width, height }
          this.viewportDebugInfo = `[VIEWPORT OK] Detected: ${width}x${height} (raw response: "${textContent.substring(0, 100)}")`
          console.log(this.viewportDebugInfo)
          return this.cachedViewport
        } else {
          this.viewportDebugInfo = `[VIEWPORT PARSE ERROR] Invalid dimensions: ${width}x${height} from "${textContent}". Using fallback: ${this.ctx.screenSize.width}x${this.ctx.screenSize.height}`
          console.warn(this.viewportDebugInfo)
        }
      } else {
        this.viewportDebugInfo = `[VIEWPORT PARSE ERROR] Could not parse response: "${textContent}". Using fallback: ${this.ctx.screenSize.width}x${this.ctx.screenSize.height}`
        console.warn(this.viewportDebugInfo)
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      this.viewportDebugInfo = `[VIEWPORT EXCEPTION] ${errMsg}. Using fallback: ${this.ctx.screenSize.width}x${this.ctx.screenSize.height}`
      console.warn(this.viewportDebugInfo)
    }

    // Fallback to configured screenSize
    return this.ctx.screenSize
  }

  /**
   * Get the current viewport debug info
   */
  getViewportDebugInfo(): string {
    return this.viewportDebugInfo
  }

  /**
   * Clear cached viewport (call when tab/window changes or before new task)
   */
  clearViewportCache(): void {
    this.cachedViewport = null
  }

  /**
   * Scale normalized coordinate (0-999) to actual viewport pixel value
   */
  private async scaleCoordinates(
    normalizedX: number,
    normalizedY: number,
  ): Promise<{ x: number; y: number }> {
    const viewport = await this.getViewportSize()
    return {
      x: Math.round((normalizedX / 1000) * viewport.width),
      y: Math.round((normalizedY / 1000) * viewport.height),
    }
  }

  /**
   * Call an MCP tool
   */
  private async callMcp(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<McpToolResult> {
    const client = new Client({
      name: 'gemini-computer-use',
      version: '1.0.0',
    })

    const transport = new StreamableHTTPClientTransport(
      new URL(this.ctx.mcpUrl),
      {
        requestInit: {
          headers: { 'X-TRIOS-Source': 'gemini-computer-use' },
        },
      },
    )

    try {
      await client.connect(transport)

      const toolCallPromise = client.callTool({ name, arguments: args })
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new Error(`MCP tool call timed out after ${MCP_TIMEOUT_MS}ms`),
            ),
          MCP_TIMEOUT_MS,
        )
      })

      try {
        return (await Promise.race([
          toolCallPromise,
          timeoutPromise,
        ])) as McpToolResult
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }
    } finally {
      try {
        await transport.close()
      } catch {
        // Ignore close errors
      }
    }
  }

  /**
   * Execute a Computer Use action by mapping to MCP tools
   */
  async execute(
    action: ComputerUseAction,
  ): Promise<{ success: boolean; message: string }> {
    const { tabId, windowId } = this.ctx

    try {
      switch (action.name) {
        case 'click_at': {
          const viewport = await this.getViewportSize()
          const { x, y } = await this.scaleCoordinates(
            action.args.x,
            action.args.y,
          )
          await this.callMcp('browser_click_coordinates', {
            tabId,
            windowId,
            x,
            y,
          })
          // Return original coordinates + debug info for troubleshooting
          // Debug info shows: model input → viewport coords, viewport size, and any errors
          const debugInfo = `[DEBUG: input=(${action.args.x},${action.args.y}) → viewport=(${x},${y}), viewport=${viewport.width}x${viewport.height}] ${this.viewportDebugInfo}`
          return {
            success: true,
            message: `Clicked at (${action.args.x}, ${action.args.y}). ${debugInfo}`,
          }
        }

        case 'type_text_at': {
          const viewport = await this.getViewportSize()
          const { x, y } = await this.scaleCoordinates(
            action.args.x,
            action.args.y,
          )
          const { text, press_enter, clear_before_typing } = action.args

          // Clear field first if requested (select all + delete)
          if (clear_before_typing) {
            await this.callMcp('browser_click_coordinates', {
              tabId,
              windowId,
              x,
              y,
            })
            await this.callMcp('browser_execute_javascript', {
              tabId,
              windowId,
              code: `document.execCommand('selectAll')`,
            })
            await this.callMcp('browser_send_keys', {
              tabId,
              windowId,
              key: 'Delete',
            })
          }

          // Type the text
          await this.callMcp('browser_type_at_coordinates', {
            tabId,
            windowId,
            x,
            y,
            text,
          })

          // Press Enter if requested
          if (press_enter) {
            await this.callMcp('browser_send_keys', {
              tabId,
              windowId,
              key: 'Enter',
            })
          }

          // Return original coordinates + debug info
          const debugInfo = `[DEBUG: input=(${action.args.x},${action.args.y}) → viewport=(${x},${y}), viewport=${viewport.width}x${viewport.height}] ${this.viewportDebugInfo}`
          return {
            success: true,
            message: `Typed "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" at (${action.args.x}, ${action.args.y}). ${debugInfo}`,
          }
        }

        case 'navigate': {
          await this.callMcp('browser_navigate', {
            tabId,
            windowId,
            url: action.args.url,
          })
          return { success: true, message: `Navigated to ${action.args.url}` }
        }

        case 'scroll_document': {
          const { direction } = action.args
          if (direction === 'up') {
            await this.callMcp('browser_scroll_up', { tabId, windowId })
          } else if (direction === 'down') {
            await this.callMcp('browser_scroll_down', { tabId, windowId })
          } else {
            // Left/right scroll via JavaScript
            const scrollCode =
              direction === 'left'
                ? 'window.scrollBy(-window.innerWidth, 0)'
                : 'window.scrollBy(window.innerWidth, 0)'
            await this.callMcp('browser_execute_javascript', {
              tabId,
              windowId,
              code: scrollCode,
            })
          }
          return { success: true, message: `Scrolled ${direction}` }
        }

        case 'scroll_at': {
          const { x, y } = await this.scaleCoordinates(
            action.args.x,
            action.args.y,
          )
          const { direction, magnitude = 500 } = action.args

          // Click at position first to focus element
          await this.callMcp('browser_click_coordinates', {
            tabId,
            windowId,
            x,
            y,
          })

          // Scale magnitude from 0-999 to actual pixels
          const viewport = await this.getViewportSize()
          const scrollAmount = Math.round((magnitude / 1000) * viewport.height)

          // Use JavaScript scrollBy for precise control with magnitude
          const scrollCode =
            direction === 'up'
              ? `window.scrollBy(0, -${scrollAmount})`
              : direction === 'down'
                ? `window.scrollBy(0, ${scrollAmount})`
                : direction === 'left'
                  ? `window.scrollBy(-${scrollAmount}, 0)`
                  : `window.scrollBy(${scrollAmount}, 0)`
          await this.callMcp('browser_execute_javascript', {
            tabId,
            windowId,
            code: scrollCode,
          })

          // Return original coordinates to avoid confusing the model
          return {
            success: true,
            message: `Scrolled ${direction} at (${action.args.x}, ${action.args.y})`,
          }
        }

        case 'key_combination': {
          const { keys } = action.args

          // Map common key combinations to JavaScript or available keys
          const keyMap: Record<string, () => Promise<void>> = {
            'Control+a': async () => {
              await this.callMcp('browser_execute_javascript', {
                tabId,
                windowId,
                code: `document.execCommand('selectAll')`,
              })
            },
            'Control+c': async () => {
              await this.callMcp('browser_execute_javascript', {
                tabId,
                windowId,
                code: `document.execCommand('copy')`,
              })
            },
            'Control+v': async () => {
              await this.callMcp('browser_execute_javascript', {
                tabId,
                windowId,
                code: `document.execCommand('paste')`,
              })
            },
            'Control+z': async () => {
              await this.callMcp('browser_execute_javascript', {
                tabId,
                windowId,
                code: `document.execCommand('undo')`,
              })
            },
            Enter: async () => {
              await this.callMcp('browser_send_keys', {
                tabId,
                windowId,
                key: 'Enter',
              })
            },
            Escape: async () => {
              await this.callMcp('browser_send_keys', {
                tabId,
                windowId,
                key: 'Escape',
              })
            },
            Tab: async () => {
              await this.callMcp('browser_send_keys', {
                tabId,
                windowId,
                key: 'Tab',
              })
            },
            Backspace: async () => {
              await this.callMcp('browser_send_keys', {
                tabId,
                windowId,
                key: 'Backspace',
              })
            },
            Delete: async () => {
              await this.callMcp('browser_send_keys', {
                tabId,
                windowId,
                key: 'Delete',
              })
            },
            ArrowUp: async () => {
              await this.callMcp('browser_send_keys', {
                tabId,
                windowId,
                key: 'ArrowUp',
              })
            },
            ArrowDown: async () => {
              await this.callMcp('browser_send_keys', {
                tabId,
                windowId,
                key: 'ArrowDown',
              })
            },
            ArrowLeft: async () => {
              await this.callMcp('browser_send_keys', {
                tabId,
                windowId,
                key: 'ArrowLeft',
              })
            },
            ArrowRight: async () => {
              await this.callMcp('browser_send_keys', {
                tabId,
                windowId,
                key: 'ArrowRight',
              })
            },
          }

          // Normalize key string (case insensitive for modifiers)
          const normalizedKeys = keys
            .replace(/ctrl/i, 'Control')
            .replace(/cmd/i, 'Control')
          const handler = keyMap[normalizedKeys] || keyMap[keys]

          if (handler) {
            await handler()
          } else {
            const keyName = keys.split('+').pop() || ''
            await this.callMcp('browser_execute_javascript', {
              tabId,
              windowId,
              code: `
                const event = new KeyboardEvent('keydown', {
                  key: ${JSON.stringify(keyName)},
                  ctrlKey: ${keys.toLowerCase().includes('control')},
                  shiftKey: ${keys.toLowerCase().includes('shift')},
                  altKey: ${keys.toLowerCase().includes('alt')},
                  metaKey: ${keys.toLowerCase().includes('meta')},
                  bubbles: true
                });
                document.activeElement?.dispatchEvent(event);
              `,
            })
          }

          return { success: true, message: `Pressed ${keys}` }
        }

        case 'hover_at': {
          const { x, y } = await this.scaleCoordinates(
            action.args.x,
            action.args.y,
          )

          // Simulate hover via JavaScript mouseover event
          await this.callMcp('browser_execute_javascript', {
            tabId,
            windowId,
            code: `
              const elem = document.elementFromPoint(${x}, ${y});
              if (elem) {
                const event = new MouseEvent('mouseover', { bubbles: true, clientX: ${x}, clientY: ${y} });
                elem.dispatchEvent(event);
              }
            `,
          })

          // Return original coordinates to avoid confusing the model
          return {
            success: true,
            message: `Hovered at (${action.args.x}, ${action.args.y})`,
          }
        }

        case 'go_back': {
          await this.callMcp('browser_execute_javascript', {
            tabId,
            windowId,
            code: 'history.back()',
          })
          return { success: true, message: 'Navigated back' }
        }

        case 'go_forward': {
          await this.callMcp('browser_execute_javascript', {
            tabId,
            windowId,
            code: 'history.forward()',
          })
          return { success: true, message: 'Navigated forward' }
        }

        case 'wait_5_seconds': {
          await new Promise((resolve) => setTimeout(resolve, 5000))
          return { success: true, message: 'Waited 5 seconds' }
        }

        case 'drag_and_drop': {
          const start = await this.scaleCoordinates(
            action.args.x,
            action.args.y,
          )
          const end = await this.scaleCoordinates(
            action.args.destination_x,
            action.args.destination_y,
          )

          // Simulate drag and drop via JavaScript
          await this.callMcp('browser_execute_javascript', {
            tabId,
            windowId,
            code: `
              const startElem = document.elementFromPoint(${start.x}, ${start.y});
              const endElem = document.elementFromPoint(${end.x}, ${end.y});
              if (startElem && endElem) {
                const dragStart = new DragEvent('dragstart', { bubbles: true, clientX: ${start.x}, clientY: ${start.y} });
                const drop = new DragEvent('drop', { bubbles: true, clientX: ${end.x}, clientY: ${end.y} });
                const dragEnd = new DragEvent('dragend', { bubbles: true });
                startElem.dispatchEvent(dragStart);
                endElem.dispatchEvent(drop);
                startElem.dispatchEvent(dragEnd);
              }
            `,
          })

          // Return original coordinates to avoid confusing the model
          return {
            success: true,
            message: `Dragged from (${action.args.x}, ${action.args.y}) to (${action.args.destination_x}, ${action.args.destination_y})`,
          }
        }

        default: {
          const _exhaustive: never = action
          return {
            success: false,
            message: `Unknown action: ${JSON.stringify(action)}`,
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, message: `Action failed: ${message}` }
    }
  }

  /**
   * Capture a screenshot via MCP with retry logic
   *
   * Uses Gemini's recommended screenshot size (1440x900) for optimal model performance.
   * Now that viewport detection is working correctly, the coordinate mapping will be accurate.
   */
  async captureScreenshot(retries = 2): Promise<string | null> {
    const { width, height } = DEFAULTS.screenshotSize

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await this.callMcp('browser_get_screenshot', {
          tabId: this.ctx.tabId,
          windowId: this.ctx.windowId,
          width,
          height,
          showHighlights: false,
        })

        if (result.isError) {
          const errorText =
            result.content?.find((c) => c.type === 'text')?.text ??
            'Unknown error'
          if (attempt < retries) {
            console.warn(
              `Screenshot attempt ${attempt + 1} failed: ${errorText}, retrying...`,
            )
            await new Promise((r) => setTimeout(r, 500))
            continue
          }
          console.warn('Screenshot capture failed:', errorText)
          return null
        }

        const imageContent = result.content.find((c) => c.type === 'image')
        if (imageContent?.data) {
          return imageContent.data
        }

        if (attempt < retries) {
          console.warn(
            `Screenshot attempt ${attempt + 1}: No image data, retrying...`,
          )
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        return null
      } catch (error) {
        if (attempt < retries) {
          console.warn(
            `Screenshot attempt ${attempt + 1} error:`,
            error,
            'retrying...',
          )
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        console.warn('Screenshot capture error:', error)
        return null
      }
    }
    return null
  }

  /**
   * Get current page URL via MCP
   */
  async getCurrentUrl(): Promise<string> {
    try {
      const result = await this.callMcp('browser_execute_javascript', {
        tabId: this.ctx.tabId,
        windowId: this.ctx.windowId,
        code: 'window.location.href',
      })

      const textContent =
        result.content.find((c) => c.type === 'text')?.text ?? ''
      // Extract URL from result text
      const urlMatch = textContent.match(/Result:\s*"?([^"\n]+)"?/)
      return urlMatch?.[1] ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
}
