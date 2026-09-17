import { describe, expect, it } from 'bun:test'
import {
  ClaudeCodeStreamParser,
  shouldCaptureScreenshotForTool,
} from '../../src/agents/claude-code/stream-parser'

describe('ClaudeCodeStreamParser', () => {
  it('maps assistant text and MCP tool use into eval stream events', () => {
    const parser = new ClaudeCodeStreamParser()
    const events = parser.pushLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will navigate.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'mcp__browseros__navigate_page',
              input: { page: 2, url: 'https://example.com' },
            },
          ],
        },
      }),
    )

    expect(events).toEqual([
      { type: 'text-start', id: expect.any(String) },
      {
        type: 'text-delta',
        id: expect.any(String),
        delta: 'I will navigate.',
      },
      { type: 'text-end', id: expect.any(String) },
      {
        type: 'tool-input-available',
        toolCallId: 'toolu_1',
        toolName: 'mcp__browseros__navigate_page',
        input: { page: 2, url: 'https://example.com' },
      },
    ])
    expect(parser.getLastText()).toBe('I will navigate.')
    expect(parser.getToolCallCount()).toBe(1)
  })

  it('maps Claude Code tool results into eval output events', () => {
    const parser = new ClaudeCodeStreamParser()
    const events = parser.pushLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'Navigated successfully',
            },
          ],
        },
      }),
    )

    expect(events).toEqual([
      {
        type: 'tool-output-available',
        toolCallId: 'toolu_1',
        output: 'Navigated successfully',
      },
    ])
  })

  it('uses result messages as the authoritative final text', () => {
    const parser = new ClaudeCodeStreamParser()
    parser.pushLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'I will complete the task.' }],
        },
      }),
    )
    parser.pushLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Final answer',
      }),
    )

    expect(parser.getLastText()).toBe('Final answer')
  })

  it('identifies BrowserOS MCP tools that should trigger screenshots', () => {
    expect(
      shouldCaptureScreenshotForTool('mcp__browseros__navigate_page'),
    ).toBe(true)
    expect(
      shouldCaptureScreenshotForTool('mcp__browseros__take_screenshot'),
    ).toBe(false)
    expect(shouldCaptureScreenshotForTool('Read')).toBe(false)
  })
})
