/**
 * Maps Yutori n1 actions to MCP tool calls
 *
 * Coordinate System:
 * - n1 outputs normalized coordinates in 1000x1000 grid
 * - Screenshots captured with size='large' (1028px width, aspect ratio preserved)
 * - We scale normalized coords to actual viewport pixels
 *
 * Action Mapping (prioritize MCP tools over execute_javascript):
 * - click → browser_click_coordinates ✅
 * - type → browser_type_at_coordinates (uses last clicked coords) ✅
 * - scroll up/down → browser_scroll_up/down ✅
 * - scroll left/right → browser_execute_javascript (no horizontal scroll tool)
 * - key_press → browser_send_keys (for supported keys) ✅
 * - hover → browser_execute_javascript (no dedicated MCP tool)
 * - drag → browser_execute_javascript (no dedicated MCP tool)
 * - wait → setTimeout
 * - refresh → browser_execute_javascript (no dedicated MCP tool)
 * - go_back → browser_execute_javascript (no dedicated MCP tool)
 * - goto_url → browser_navigate ✅
 * - stop → returns answer (no MCP call)
 * - read_texts_and_links → browser_get_page_content ✅
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import sharp from 'sharp'
import type { ActionContext, N1Action, ScreenSize } from './types'
import { DEFAULTS } from './types'

/**
 * Convert PNG base64 to WebP base64 for smaller payload size.
 * Yutori n1 recommends WebP format for better compression.
 */
async function convertToWebP(pngBase64: string): Promise<string> {
  const pngBuffer = Buffer.from(pngBase64, 'base64')
  const webpBuffer = await sharp(pngBuffer)
    .webp({ quality: 80 }) // Good balance of quality and size
    .toBuffer()
  return webpBuffer.toString('base64')
}

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

// Scroll amount per unit (n1 recommends treating each amount as 10-15% of screen)
const SCROLL_PERCENT_PER_UNIT = 0.12 // 12% of viewport per scroll unit

export class ActionMapper {
  private ctx: ActionContext
  private cachedViewport: ScreenSize | null = null
  // Track last clicked coordinates for type action (n1 type has no coords)
  private lastClickCoordinates: { x: number; y: number } | null = null

  constructor(ctx: ActionContext) {
    this.ctx = ctx
  }

  // Store debug info about viewport detection for inclusion in responses
  private viewportDebugInfo: string = ''

  /**
   * Get the actual browser viewport size via JavaScript
   * This is critical for correct coordinate mapping:
   * - Screenshot is scaled to 1028px width (aspect ratio preserved)
   * - Clicks must be at actual viewport coordinates
   * - We scale: (normalized/1000) * viewport
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

      // Parse array format - can be multiline: [1440, 900] or "Result: [\n  1200,\n  712\n]"
      const arrayMatch = textContent.match(/\[\s*(\d+)\s*,\s*(\d+)\s*\]/s)
      if (arrayMatch) {
        const width = parseInt(arrayMatch[1], 10)
        const height = parseInt(arrayMatch[2], 10)
        if (width > 0 && height > 0) {
          this.cachedViewport = { width, height }
          this.viewportDebugInfo = `[VIEWPORT OK] Detected: ${width}x${height} (raw: "${textContent.substring(0, 100)}")`
          console.log(this.viewportDebugInfo)
          return this.cachedViewport
        } else {
          this.viewportDebugInfo = `[VIEWPORT PARSE ERROR] Invalid dimensions: ${width}x${height} from "${textContent}". Using fallback: ${this.ctx.screenSize.width}x${this.ctx.screenSize.height}`
          console.warn(this.viewportDebugInfo)
        }
      } else {
        this.viewportDebugInfo = `[VIEWPORT PARSE ERROR] Could not parse: "${textContent}". Using fallback: ${this.ctx.screenSize.width}x${this.ctx.screenSize.height}`
        console.warn(this.viewportDebugInfo)
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      this.viewportDebugInfo = `[VIEWPORT EXCEPTION] ${errMsg}. Using fallback: ${this.ctx.screenSize.width}x${this.ctx.screenSize.height}`
      console.warn(this.viewportDebugInfo)
    }

    // Fallback to config screenSize
    return this.ctx.screenSize
  }

  /**
   * Clear cached viewport (call when tab/window changes or before new task)
   */
  clearViewportCache(): void {
    this.cachedViewport = null
  }

  /**
   * Reset all tracked state (call before starting a new task)
   */
  reset(): void {
    this.cachedViewport = null
    this.lastClickCoordinates = null
  }

  /**
   * Scale normalized coordinate (0-1000) to actual viewport pixel value
   *
   * How it works:
   * - Screenshot is captured at 1028px width with preserved aspect ratio
   * - n1 predicts normalized coords (0-1000) for that screenshot
   * - Since aspect ratio is preserved, we can scale directly to viewport
   * - Formula: actualX = (normalizedX / 1000) * viewport.innerWidth
   */
  private async scaleCoordinates(
    normalizedX: number,
    normalizedY: number,
  ): Promise<{ x: number; y: number }> {
    const viewport = await this.getViewportSize()
    return {
      x: Math.round((normalizedX / DEFAULTS.normalizedMax) * viewport.width),
      y: Math.round((normalizedY / DEFAULTS.normalizedMax) * viewport.height),
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
      name: 'yutori-navigator',
      version: '1.0.0',
    })

    const transport = new StreamableHTTPClientTransport(
      new URL(this.ctx.mcpUrl),
      {
        requestInit: {
          headers: { 'X-TRIOS-Source': 'yutori-navigator' },
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
   * Execute an n1 action by mapping to MCP tools
   * Prioritizes native MCP tools over browser_execute_javascript for reliability
   * Returns the result message and optionally the stop answer
   */
  async execute(
    action: N1Action,
  ): Promise<{ success: boolean; message: string; stopAnswer?: string }> {
    const { tabId, windowId } = this.ctx

    try {
      switch (action.action_type) {
        case 'click': {
          const [normX, normY] = action.center_coordinates
          const viewport = await this.getViewportSize()
          const { x, y } = await this.scaleCoordinates(normX, normY)

          // Track coordinates for subsequent type action (n1 type has no coords)
          this.lastClickCoordinates = { x, y }

          await this.callMcp('browser_click_coordinates', {
            tabId,
            windowId,
            x,
            y,
          })
          // Return original coordinates + debug info
          const debugInfo = `[DEBUG: input=(${normX},${normY}) → viewport=(${x},${y}), viewport=${viewport.width}x${viewport.height}] ${this.viewportDebugInfo}`
          return {
            success: true,
            message: `Clicked at (${normX}, ${normY}). ${debugInfo}`,
          }
        }

        case 'type': {
          const { text, press_enter_after, clear_before_typing } = action

          // n1 type action has no coordinates - it expects element to be focused
          // Use last clicked coordinates with browser_type_at_coordinates
          if (!this.lastClickCoordinates) {
            // Fallback: click center of screen if no prior click
            const viewport = await this.getViewportSize()
            this.lastClickCoordinates = {
              x: Math.round(viewport.width / 2),
              y: Math.round(viewport.height / 2),
            }
          }

          const { x, y } = this.lastClickCoordinates

          // Clear field first if requested using native MCP tools
          if (clear_before_typing) {
            // Triple-click to select all text in the field
            await this.callMcp('browser_click_coordinates', {
              tabId,
              windowId,
              x,
              y,
            })
            // Use Delete key to clear
            await this.callMcp('browser_send_keys', {
              tabId,
              windowId,
              key: 'Delete',
            })
          }

          // Use browser_type_at_coordinates - the proper MCP tool for typing
          await this.callMcp('browser_type_at_coordinates', {
            tabId,
            windowId,
            x,
            y,
            text,
          })

          // Press Enter if requested using native MCP tool
          if (press_enter_after) {
            await this.callMcp('browser_send_keys', {
              tabId,
              windowId,
              key: 'Enter',
            })
          }

          // n1 type action has no coordinates - don't include viewport coords in response
          return {
            success: true,
            message: `Typed "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
          }
        }

        case 'scroll': {
          const { direction, center_coordinates, amount } = action
          const [normX, normY] = center_coordinates
          const { x, y } = await this.scaleCoordinates(normX, normY)

          // Track coordinates
          this.lastClickCoordinates = { x, y }

          // Click at position first to focus element (for scrollable containers)
          await this.callMcp('browser_click_coordinates', {
            tabId,
            windowId,
            x,
            y,
          })

          // For vertical scroll (up/down): use native MCP scroll tools
          // For horizontal scroll (left/right): use JS (no MCP tool available)
          if (direction === 'up' || direction === 'down') {
            const scrollTool =
              direction === 'up' ? 'browser_scroll_up' : 'browser_scroll_down'

            // Calculate how many scroll calls based on amount
            // n1 amount 1-2 = ~20% viewport, our tool = 100% viewport
            // So we scroll once for small amounts, more for larger
            const scrollCount = Math.max(1, Math.round(amount / 5))

            for (let i = 0; i < scrollCount; i++) {
              await this.callMcp(scrollTool, { tabId, windowId })
              // Small delay between scrolls for stability
              if (i < scrollCount - 1) {
                await new Promise((r) => setTimeout(r, 100))
              }
            }

            // Return original normalized coordinates
            return {
              success: true,
              message: `Scrolled ${direction} at (${normX}, ${normY})`,
            }
          } else {
            // Horizontal scroll - no MCP tool, use JS
            const viewport = await this.getViewportSize()
            const scrollPixels = Math.round(
              amount * SCROLL_PERCENT_PER_UNIT * viewport.width,
            )
            const scrollCode =
              direction === 'left'
                ? `window.scrollBy(-${scrollPixels}, 0)`
                : `window.scrollBy(${scrollPixels}, 0)`

            await this.callMcp('browser_execute_javascript', {
              tabId,
              windowId,
              code: scrollCode,
            })

            // Return original normalized coordinates
            return {
              success: true,
              message: `Scrolled ${direction} at (${normX}, ${normY})`,
            }
          }
        }

        case 'key_press': {
          const { key_comb } = action

          // Map keys to browser_send_keys supported keys
          // browser_send_keys supports: Enter, Delete, Backspace, Tab, Escape,
          // ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown
          const keyMap: Record<string, string> = {
            Enter: 'Enter',
            Escape: 'Escape',
            Tab: 'Tab',
            Backspace: 'Backspace',
            Delete: 'Delete',
            ArrowUp: 'ArrowUp',
            ArrowDown: 'ArrowDown',
            ArrowLeft: 'ArrowLeft',
            ArrowRight: 'ArrowRight',
            Home: 'Home',
            End: 'End',
            PageUp: 'PageUp',
            PageDown: 'PageDown',
            // Alternative names n1 might use
            Return: 'Enter',
            Esc: 'Escape',
            Up: 'ArrowUp',
            Down: 'ArrowDown',
            Left: 'ArrowLeft',
            Right: 'ArrowRight',
          }

          const mappedKey = keyMap[key_comb]
          if (mappedKey) {
            // Use native MCP tool
            await this.callMcp('browser_send_keys', {
              tabId,
              windowId,
              key: mappedKey,
            })
          } else {
            // For complex key combinations (Ctrl+A, etc.), use JavaScript
            const parts = key_comb.split('+')
            const mainKey = parts.pop() || ''
            const modifiers = parts.map((p) => p.toLowerCase())

            await this.callMcp('browser_execute_javascript', {
              tabId,
              windowId,
              code: `
                const event = new KeyboardEvent('keydown', {
                  key: '${mainKey}',
                  code: 'Key${mainKey.toUpperCase()}',
                  ctrlKey: ${modifiers.includes('control') || modifiers.includes('ctrl')},
                  shiftKey: ${modifiers.includes('shift')},
                  altKey: ${modifiers.includes('alt')},
                  metaKey: ${modifiers.includes('meta') || modifiers.includes('cmd')},
                  bubbles: true
                });
                document.activeElement?.dispatchEvent(event);
              `,
            })
          }

          return { success: true, message: `Pressed ${key_comb}` }
        }

        case 'hover': {
          // No dedicated MCP hover tool - use JS
          const [normX, normY] = action.center_coordinates
          const { x, y } = await this.scaleCoordinates(normX, normY)

          // Track coordinates
          this.lastClickCoordinates = { x, y }

          await this.callMcp('browser_execute_javascript', {
            tabId,
            windowId,
            code: `
              const elem = document.elementFromPoint(${x}, ${y});
              if (elem) {
                const event = new MouseEvent('mouseover', {
                  bubbles: true,
                  clientX: ${x},
                  clientY: ${y}
                });
                elem.dispatchEvent(event);
              }
            `,
          })

          // Return original normalized coordinates
          return { success: true, message: `Hovered at (${normX}, ${normY})` }
        }

        case 'drag': {
          // No dedicated MCP drag tool - use JS
          const [startNormX, startNormY] = action.start_coordinates
          const [endNormX, endNormY] = action.center_coordinates
          const start = await this.scaleCoordinates(startNormX, startNormY)
          const end = await this.scaleCoordinates(endNormX, endNormY)

          // Track end coordinates
          this.lastClickCoordinates = end

          await this.callMcp('browser_execute_javascript', {
            tabId,
            windowId,
            code: `
              const startElem = document.elementFromPoint(${start.x}, ${start.y});
              const endElem = document.elementFromPoint(${end.x}, ${end.y});
              if (startElem && endElem) {
                const dragStart = new DragEvent('dragstart', {
                  bubbles: true,
                  clientX: ${start.x},
                  clientY: ${start.y}
                });
                const drop = new DragEvent('drop', {
                  bubbles: true,
                  clientX: ${end.x},
                  clientY: ${end.y}
                });
                const dragEnd = new DragEvent('dragend', { bubbles: true });
                startElem.dispatchEvent(dragStart);
                endElem.dispatchEvent(drop);
                startElem.dispatchEvent(dragEnd);
              }
            `,
          })

          // Return original normalized coordinates
          return {
            success: true,
            message: `Dragged from (${startNormX}, ${startNormY}) to (${endNormX}, ${endNormY})`,
          }
        }

        case 'wait': {
          // n1 uses this for page loads
          await new Promise((resolve) => setTimeout(resolve, 2000))
          return { success: true, message: 'Waited 2 seconds' }
        }

        case 'refresh': {
          // No dedicated MCP refresh tool - use JS
          await this.callMcp('browser_execute_javascript', {
            tabId,
            windowId,
            code: 'location.reload()',
          })
          // Wait for page to start reloading
          await new Promise((resolve) => setTimeout(resolve, 1000))
          return { success: true, message: 'Refreshed page' }
        }

        case 'go_back': {
          // No dedicated MCP go_back tool - use JS
          await this.callMcp('browser_execute_javascript', {
            tabId,
            windowId,
            code: 'history.back()',
          })
          return { success: true, message: 'Navigated back' }
        }

        case 'goto_url': {
          // Use native MCP navigate tool
          await this.callMcp('browser_navigate', {
            tabId,
            windowId,
            url: action.url,
          })
          return { success: true, message: `Navigated to ${action.url}` }
        }

        case 'read_texts_and_links': {
          // Use native MCP tool
          const result = await this.callMcp('browser_get_page_content', {
            tabId,
            windowId,
            type: 'text-with-links',
          })
          const content =
            result.content.find((c) => c.type === 'text')?.text ?? ''
          return {
            success: true,
            message: `Read page content (${content.length} chars)`,
          }
        }

        case 'stop': {
          // Stop action - task is complete, return the answer
          return {
            success: true,
            message: 'Task completed',
            stopAnswer: action.answer,
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
   * Uses Yutori's recommended screenshot size (1280x800) for optimal model performance.
   * Now that viewport detection is working correctly, the coordinate mapping will be accurate.
   *
   * Returns WebP base64 string
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
          // Convert PNG to WebP for smaller payload (n1 recommends WebP)
          try {
            const webpBase64 = await convertToWebP(imageContent.data)
            return webpBase64
          } catch (conversionError) {
            console.warn('WebP conversion failed, using PNG:', conversionError)
            return imageContent.data
          }
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
      const urlMatch = textContent.match(/Result:\s*"?([^"\n]+)"?/)
      return urlMatch?.[1] ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
}
