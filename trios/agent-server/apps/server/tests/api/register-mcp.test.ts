/**
 * @license
 * Copyright 2025 BrowserOS
 *
 * First suite for src/api/services/mcp/register-mcp.ts.
 *
 * The module exports exactly one runtime symbol, registerTools, and the
 * single test below exercises that symbol across its whole observable
 * surface: what lands on the MCP server, what a registered handler
 * returns to a caller, how the per-request default windowId is applied,
 * what the execution observer is told, and how failures surface. Every
 * collaborator the function needs - the MCP server, the tool registry,
 * the browser and the monitoring observer - is supplied as an in-memory
 * double, so no export had to be left out and none is listed here as
 * blocked by a live dependency. The suite therefore needs no network,
 * no database and no container.
 */

import { describe, expect, it } from 'bun:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { registerTools } from '../../src/api/services/mcp/register-mcp'
import type { Browser } from '../../src/browser/browser'
import type { ToolExecutionObserver } from '../../src/monitoring/observer'
import type {
  MonitoringToolEndInput,
  MonitoringToolStartInput,
} from '../../src/monitoring/types'
import type { ToolDefinition } from '../../src/tools/framework'
import { ToolRegistry } from '../../src/tools/tool-registry'

// What the fake MCP server captures for one registerTool call. The
// handler here is the callback registerTools installs; invoking it is
// what a real server would do when a client calls the tool.
interface RegisteredTool {
  name: string
  description: string | undefined
  inputSchema: unknown
  outputSchema: unknown
  handler: (
    args: Record<string, unknown>,
    extra: { signal: AbortSignal },
  ) => Promise<{
    content: { type: 'text'; text: string }[]
    isError?: boolean
    structuredContent?: Record<string, unknown>
  }>
}

function makeFakeMcpServer(): {
  server: McpServer
  registered: RegisteredTool[]
} {
  const registered: RegisteredTool[] = []
  const server = {
    registerTool(
      name: string,
      config: {
        description?: string
        inputSchema?: unknown
        outputSchema?: unknown
      },
      handler: RegisteredTool['handler'],
    ): void {
      registered.push({
        name,
        description: config.description,
        inputSchema: config.inputSchema,
        outputSchema: config.outputSchema,
        handler,
      })
    },
  } as unknown as McpServer
  return { server, registered }
}

function makeRecordingObserver(): {
  observer: ToolExecutionObserver
  starts: MonitoringToolStartInput[]
  ends: MonitoringToolEndInput[]
} {
  const starts: MonitoringToolStartInput[] = []
  const ends: MonitoringToolEndInput[] = []
  const observer: ToolExecutionObserver = {
    onToolStart: async (input) => {
      starts.push(input)
    },
    onToolEnd: async (input) => {
      ends.push(input)
    },
  }
  return { observer, starts, ends }
}

// A browser double whose only interesting knob is the page->tab lookup,
// which the execution pipeline consults after a tool runs when the call
// carried a numeric `page` argument. Tests can make it throw to break
// the pipeline around a perfectly healthy tool.
function makeBrowser(
  getTabIdForPage: (pageId: number) => number | undefined = () => undefined,
): Browser {
  return { getTabIdForPage } as unknown as Browser
}

// Builds a real ToolDefinition whose handler records the arguments it
// received and then defers to the caller-supplied behaviour.
function makeTool(config: {
  name: string
  input?: z.ZodType
  output?: z.ZodType
  handler: ToolDefinition['handler']
}): { tool: ToolDefinition; receivedArgs: unknown[] } {
  const receivedArgs: unknown[] = []
  const tool: ToolDefinition = {
    name: config.name,
    description: `test tool ${config.name}`,
    approvalCategory: 'input',
    input: config.input ?? z.object({}),
    output: config.output,
    handler: async (args, ctx, response) => {
      receivedArgs.push(args)
      await config.handler(args, ctx, response)
    },
  }
  return { tool, receivedArgs }
}

describe('registerMcpContract', () => {
  it('registerTools publishes the registry on an MCP server whose handlers run the tools, apply the default windowId, notify the observer and surface failures as results', async () => {
    const signal = new AbortController().signal

    // -- Registration: every registry tool lands on the server under its
    // own name, with its own description and its own zod schemas.
    const windowTool = makeTool({
      name: 'windowed',
      input: z.object({
        windowId: z.number().optional(),
      }),
      output: z.object({ windowId: z.number().nullable() }),
      handler: async (args, _ctx, response) => {
        response.text('windowed ran')
        response.data(
          'windowId',
          (args as { windowId?: number }).windowId ?? null,
        )
      },
    })
    const plainTool = makeTool({
      name: 'plain',
      input: z.object({}),
      handler: async (_args, _ctx, response) => {
        response.text('plain ran')
      },
    })
    const { server, registered } = makeFakeMcpServer()
    const { observer, starts, ends } = makeRecordingObserver()
    registerTools(server, new ToolRegistry([windowTool.tool, plainTool.tool]), {
      browser: makeBrowser(),
      directories: {},
      observer,
      defaultWindowId: 7,
    })
    expect(registered.map((entry) => entry.name)).toEqual(['windowed', 'plain'])
    expect(registered[0]?.description).toBe(windowTool.tool.description)
    expect(registered[0]?.inputSchema).toBe(windowTool.tool.input)
    expect(registered[0]?.outputSchema).toBe(windowTool.tool.output)

    // -- Calling the registered handler runs the tool and hands the
    // caller back the tool's own output.
    const windowed = registered[0] as RegisteredTool
    const injected = await windowed.handler({}, { signal })
    expect(injected.content).toEqual([{ type: 'text', text: 'windowed ran' }])
    expect(injected.structuredContent).toEqual({ windowId: 7 })
    expect(injected.isError).toBeUndefined()
    expect(windowTool.receivedArgs[0]).toEqual({ windowId: 7 })

    // -- The per-request default windowId fills only the gap: an explicit
    // windowId from the caller wins, and a tool whose input schema has no
    // windowId field is left alone.
    const explicit = await windowed.handler({ windowId: 3 }, { signal })
    expect(explicit.structuredContent).toEqual({ windowId: 3 })
    expect(windowTool.receivedArgs[1]).toEqual({ windowId: 3 })
    const plainResult = await (registered[1] as RegisteredTool).handler(
      {},
      { signal },
    )
    expect(plainResult.content).toEqual([{ type: 'text', text: 'plain ran' }])
    expect(plainTool.receivedArgs[0]).toEqual({})
    const noDefault = makeFakeMcpServer()
    registerTools(noDefault.server, new ToolRegistry([windowTool.tool]), {
      browser: makeBrowser(),
      directories: {},
      observer,
    })
    const untouched = await (noDefault.registered[0] as RegisteredTool).handler(
      {},
      { signal },
    )
    expect(untouched.structuredContent).toEqual({ windowId: null })

    // -- The observer on the context is told about the run: started with
    // the tool's name and the effective arguments, finished with output
    // that mirrors what the caller received.
    expect(starts[0]?.toolName).toBe('windowed')
    expect(starts[0]?.toolDescription).toBe(windowTool.tool.description)
    expect(starts[0]?.source).toBe('browser-tool')
    expect(typeof starts[0]?.toolCallId).toBe('string')
    expect(starts[0]?.args).toEqual({ windowId: 7 })
    expect(ends[0]?.toolCallId).toBe(starts[0]?.toolCallId)
    expect(ends[0]?.error).toBeUndefined()
    const endOutput = ends[0]?.output as {
      content: unknown
      structuredContent: Record<string, unknown>
    }
    expect(endOutput.content).toEqual(injected.content)
    expect(endOutput.structuredContent).toEqual({ windowId: 7 })

    // -- A tool whose handler throws does not reject the call: the caller
    // gets an error result naming the tool, and the observer is told.
    const boomTool = makeTool({
      name: 'boom',
      input: z.object({}),
      handler: async () => {
        throw new Error('tool exploded')
      },
    })
    const boom = makeFakeMcpServer()
    const boomObserver = makeRecordingObserver()
    registerTools(boom.server, new ToolRegistry([boomTool.tool]), {
      browser: makeBrowser(),
      directories: {},
      observer: boomObserver.observer,
    })
    const boomResult = await (boom.registered[0] as RegisteredTool).handler(
      {},
      { signal },
    )
    expect(boomResult.isError).toBe(true)
    expect(boomResult.content).toEqual([
      { type: 'text', text: 'Internal error in boom: tool exploded' },
    ])
    expect(boomObserver.ends[0]?.error).toBe('Tool returned isError=true')

    // -- A failure in the execution machinery around a healthy tool also
    // resolves as an error result instead of rejecting: here the browser
    // double throws while the pipeline resolves the page argument.
    const pageTool = makeTool({
      name: 'pagebound',
      input: z.object({ page: z.number().optional() }),
      handler: async (_args, _ctx, response) => {
        response.text('pagebound ran')
      },
    })
    const broken = makeFakeMcpServer()
    const brokenObserver = makeRecordingObserver()
    registerTools(broken.server, new ToolRegistry([pageTool.tool]), {
      browser: makeBrowser(() => {
        throw new Error('page lookup exploded')
      }),
      directories: {},
      observer: brokenObserver.observer,
    })
    const failed = await (broken.registered[0] as RegisteredTool).handler(
      { page: 4 },
      { signal },
    )
    expect(failed.isError).toBe(true)
    expect(failed.content).toEqual([
      { type: 'text', text: 'page lookup exploded' },
    ])
    expect(failed.structuredContent).toBeUndefined()
    expect(brokenObserver.starts[0]?.toolName).toBe('pagebound')
    expect(brokenObserver.ends[0]?.error).toBe('page lookup exploded')
  })
})
