import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { logger } from '../../../lib/logger'
import { metrics } from '../../../lib/metrics'
import {
  buildMonitoringToolOutput,
  type ToolExecutionObserver,
} from '../../../monitoring/observer'
import {
  executeTool,
  type ToolContext,
  type ToolDefinition,
} from '../../../tools/framework'
import type { ToolRegistry } from '../../../tools/tool-registry'

// True when the tool's zod input schema is a ZodObject with a `windowId`
// field. Schema-driven so any future tool that takes a windowId
// participates automatically — no per-tool allowlist.
function inputHasWindowIdField(tool: ToolDefinition): boolean {
  const input = tool.input
  if (!(input instanceof z.ZodObject)) return false
  return 'windowId' in (input as z.AnyZodObject).shape
}

export function registerTools(
  mcpServer: McpServer,
  registry: ToolRegistry,
  ctx: ToolContext & {
    observer?: ToolExecutionObserver
    // Default windowId from X-BrowserOS-Default-Window-Id. When set,
    // tool calls without an explicit args.windowId have this value
    // injected — provided the tool's schema actually accepts one.
    defaultWindowId?: number
  },
): void {
  for (const tool of registry.all()) {
    const acceptsWindowId = inputHasWindowIdField(tool)
    const handler = async (
      args: Record<string, unknown>,
      extra: { signal: AbortSignal },
    ) => {
      // Inject the per-request default windowId only when (a) the host
      // supplied one via header, (b) the tool actually accepts a
      // windowId, and (c) the caller didn't explicitly set one. The
      // explicit-set check means an agent that *did* pick a windowId on
      // purpose still wins — we only fill the gap.
      if (
        ctx.defaultWindowId !== undefined &&
        acceptsWindowId &&
        args.windowId === undefined
      ) {
        args.windowId = ctx.defaultWindowId
      }
      const startTime = performance.now()
      const toolCallId = crypto.randomUUID()

      try {
        logger.info(`${tool.name} request: ${JSON.stringify(args, null, '  ')}`)
        await ctx.observer?.onToolStart({
          toolCallId,
          toolName: tool.name,
          toolDescription: tool.description,
          source: 'browser-tool',
          args,
        })

        const result = await executeTool(tool, args, ctx, extra.signal)

        metrics.log('tool_executed', {
          tool_name: tool.name,
          duration_ms: Math.round(performance.now() - startTime),
          success: !result.isError,
          source: 'mcp',
        })

        await ctx.observer?.onToolEnd({
          toolCallId,
          output: buildMonitoringToolOutput({
            content: result.content,
            structuredContent: result.structuredContent,
            metadata: result.metadata,
            isError: result.isError,
          }),
          error: result.isError ? 'Tool returned isError=true' : undefined,
        })

        return {
          content: result.content,
          isError: result.isError,
          structuredContent: result.structuredContent,
        }
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error)

        metrics.log('tool_executed', {
          tool_name: tool.name,
          duration_ms: Math.round(performance.now() - startTime),
          success: false,
          error_message: errorText,
          source: 'mcp',
        })

        await ctx.observer?.onToolEnd({
          toolCallId,
          error: errorText,
        })

        return {
          content: [{ type: 'text' as const, text: errorText }],
          isError: true,
        }
      }
    }

    mcpServer.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input as unknown as Record<string, never>,
        outputSchema: tool.output as unknown as Record<string, never>,
      },
      handler,
    )
  }

  logger.info(
    `Registered ${registry.names().length} tools: ${registry.names().join(', ')}`,
  )
}
