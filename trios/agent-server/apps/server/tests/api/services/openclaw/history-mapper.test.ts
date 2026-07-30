/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { describe, expect, it } from 'bun:test'
import {
  cleanHistoryUserText,
  convertOpenClawHistoryToAgentHistory,
} from '../../../../src/api/services/openclaw/history-mapper'
import type { OpenClawSessionHistory } from '../../../../src/api/services/openclaw/openclaw-http-client'

describe('cleanHistoryUserText', () => {
  it('extracts the cron payload and drops the trailer', () => {
    const raw =
      '[cron:681df8ba-85e0-404e-a6ea-891d0f5068af hello-8] Print hello\n' +
      'Current time: Tuesday, May 5th, 2026 - 2:26 AM (Asia/Calcutta) / 2026-05-04 20:56 UTC\n\n' +
      'Use the message tool if you need to notify the user directly with an explicit target. ' +
      'If you do not send directly, your final plain-text reply will be delivered automatically.'
    expect(cleanHistoryUserText(raw)).toBe('Print hello')
  })

  it('extracts a multiline cron payload and drops the trailer', () => {
    const raw =
      '[cron:abcd1234-0000-0000-0000-000000000000 weather] Tell me the weather in Tokyo\n' +
      'and report back briefly.\n' +
      'Current time: Tuesday, May 5th, 2026 - 2:26 AM (Asia/Calcutta) / 2026-05-04 20:56 UTC\n\n' +
      'Use the message tool if you need to notify the user directly with an explicit target.'
    expect(cleanHistoryUserText(raw)).toBe(
      'Tell me the weather in Tokyo\nand report back briefly.',
    )
  })

  // Mirrors `BROWSEROS_ACP_AGENT_INSTRUCTIONS` from acpx-runtime.ts.
  // `unwrapBrowserosAcpUserMessage`'s `stripOuterRoleEnvelope` performs
  // an exact-prefix/suffix match against this constant, so test fixtures
  // need the full text — not a truncated stand-in.
  const ROLE_BLOCK =
    '<role>\n' +
    'You are BrowserOS - a browser agent with full control of a Chromium browser through the BrowserOS MCP server.\n\n' +
    'Use the BrowserOS MCP server for all browser tasks, including browsing the web, interacting with pages, inspecting browser state, and managing tabs, windows, bookmarks, and history.\n' +
    '</role>'

  it('unwraps the BrowserOS ACP user_request envelope', () => {
    const raw = `${ROLE_BLOCK}\n\n<user_request>\nhey\n</user_request>`
    expect(cleanHistoryUserText(raw)).toBe('hey')
  })

  it("strips OpenClaw acp-cli's leading [Working directory:] line", () => {
    // OpenClaw 2026.5.x's acp-cli prepends `[Working directory: <path>]
    // \n\n` before the BrowserOS envelope. We strip that line up-front
    // so the inner `<role>…</role>\n\n<user_request>` envelope can be
    // unwrapped by `unwrapBrowserosAcpUserMessage`.
    const raw =
      '[Working directory: /Users/me/.browseros-dev/agents/harness/workspace]\n\n' +
      `${ROLE_BLOCK}\n\n<user_request>\nhey\n</user_request>`
    expect(cleanHistoryUserText(raw)).toBe('hey')
  })

  it('strips the full OpenClaw acp-cli envelope on image-attachment turns', () => {
    // OpenClaw 2026.5.4+ (post image-bypass deletion) wraps user
    // messages with stacked envelope lines:
    //   [media attached: <path> (<mime>)]
    //   [<weekday> <date> <tz>] [Working directory: <path>]
    //   <BrowserOS role envelope>
    const raw =
      '[media attached: /home/node/.openclaw/media/inbound/image---abc.png (image/png)]\n' +
      '[Thu 2026-05-07 02:07 GMT+5:30] [Working directory: /Users/me/.browseros-dev/agents/harness/workspace]\n\n' +
      `${ROLE_BLOCK}\n\n<user_request>\nWhat color is this?\n</user_request>`
    expect(cleanHistoryUserText(raw)).toBe('What color is this?')
  })

  it('strips multiple stacked [media attached:] lines (one per attachment)', () => {
    const raw =
      '[media attached: /home/node/.openclaw/media/inbound/image---a.png (image/png)]\n' +
      '[media attached: /home/node/.openclaw/media/inbound/image---b.jpg (image/jpeg)]\n' +
      '[Thu 2026-05-07 02:07 GMT+5:30] [Working directory: /workspace]\n\n' +
      `${ROLE_BLOCK}\n\n<user_request>\nCompare these.\n</user_request>`
    expect(cleanHistoryUserText(raw)).toBe('Compare these.')
  })

  it('splits queued-marker concatenations and cleans each chunk', () => {
    // When multiple prompts queue up while a turn is active, BrowserOS
    // joins them with the queued-marker line. Each chunk between markers
    // is its own message that should be cleaned independently.
    const raw =
      '[Queued user message that arrived while the previous turn was still active]\n' +
      "[cron:aaaa hello-job-1] print('hello')\n" +
      'Current time: 2026-05-05 16:00 UTC\n\n' +
      'Use the message tool if you need to notify the user directly with an explicit target.\n' +
      '[Queued user message that arrived while the previous turn was still active]\n' +
      "[cron:bbbb hello-job-2] print('world')\n" +
      'Current time: 2026-05-05 16:01 UTC\n\n' +
      'Use the message tool if you need to notify the user directly with an explicit target.'
    expect(cleanHistoryUserText(raw)).toBe("print('hello')\nprint('world')")
  })

  it('drops a Subagent Context message entirely', () => {
    // OpenClaw seeds a nested subagent's session with a "Subagent
    // Context" prefix that's pure scaffolding. The actual task lives in
    // the system prompt, so the user message body is meaningless to
    // surface. cleanHistoryUserText returns empty; the converter then
    // skips the entry so it doesn't render an empty bubble.
    const raw =
      '[Subagent Context] You are running as a subagent (depth 1/1). ' +
      'Results auto-announce to your requester; do not busy-poll for status.\n\n' +
      'Begin. Your assigned task is in the system prompt under **Your Role**.'
    expect(cleanHistoryUserText(raw)).toBe('')
  })

  it('drops empty chunks left by leading queued marker', () => {
    // The blob often opens with a marker (no content before it). Empty
    // chunks should be dropped so we don't emit a leading newline.
    const raw =
      '[Queued user message that arrived while the previous turn was still active]\n' +
      '[cron:aaaa job] payload-only\n' +
      'Current time: now'
    expect(cleanHistoryUserText(raw)).toBe('payload-only')
  })

  it('preserves messages that match no known scaffolding', () => {
    expect(cleanHistoryUserText('hello there')).toBe('hello there')
    expect(cleanHistoryUserText('multi\nline\nuser text')).toBe(
      'multi\nline\nuser text',
    )
  })

  it('returns empty string unchanged', () => {
    expect(cleanHistoryUserText('')).toBe('')
  })
})

describe('convertOpenClawHistoryToAgentHistory', () => {
  it('strips cron scaffolding from user messages while preserving assistant text', () => {
    const raw: OpenClawSessionHistory = {
      sessionKey: 'agent:demo:main',
      messages: [
        {
          role: 'user',
          content: '' as never,
          // The HTTP endpoint actually returns content as an array of typed
          // blocks at runtime; the type is `string` for backward-compat.
          // Cast via `unknown` to reflect runtime.
          ...({
            content: [
              {
                type: 'text',
                text:
                  '[cron:abc-123 hello-1] Print hello\n' +
                  'Current time: 2026-05-05 16:00 UTC\n\n' +
                  'Use the message tool if you need to notify the user directly with an explicit target.',
              },
            ],
          } as unknown as { content: never }),
          timestamp: 1000,
        },
        {
          role: 'assistant',
          content: '' as never,
          ...({
            content: [{ type: 'text', text: 'hello' }],
          } as unknown as { content: never }),
          timestamp: 1001,
        },
      ],
    }

    const out = convertOpenClawHistoryToAgentHistory('demo', raw)
    expect(out.items.map((i) => ({ role: i.role, text: i.text }))).toEqual([
      { role: 'user', text: 'Print hello' },
      { role: 'assistant', text: 'hello' },
    ])
  })

  it('drops assistant turns that have only reasoning (no text, no tools)', () => {
    // MiniMax with thinking:minimal often returns only `thinking` blocks
    // for trivial prompts ("Print hello"). The empty text bubble with a
    // dangling reasoning collapsible reads as broken UI; cleaner to skip.
    const raw: OpenClawSessionHistory = {
      sessionKey: 'agent:demo:main',
      messages: [
        {
          role: 'user',
          content: '' as never,
          ...({
            content: [{ type: 'text', text: 'hi' }],
          } as unknown as { content: never }),
          timestamp: 1000,
        },
        {
          role: 'assistant',
          content: '' as never,
          ...({
            content: [
              {
                type: 'thinking',
                thinking: 'I should respond with a greeting.',
              },
            ],
          } as unknown as { content: never }),
          timestamp: 1001,
        },
      ],
    }
    const out = convertOpenClawHistoryToAgentHistory('demo', raw)
    expect(out.items.map((i) => ({ role: i.role, text: i.text }))).toEqual([
      { role: 'user', text: 'hi' },
    ])
  })

  it('drops Subagent Context user messages entirely (no empty bubble)', () => {
    const raw: OpenClawSessionHistory = {
      sessionKey: 'agent:demo:main',
      messages: [
        {
          role: 'user',
          content: '' as never,
          ...({
            content: [
              {
                type: 'text',
                text:
                  '[Subagent Context] You are running as a subagent (depth 1/1).\n\n' +
                  'Begin. Your assigned task is in the system prompt.',
              },
            ],
          } as unknown as { content: never }),
          timestamp: 1000,
        },
        {
          role: 'assistant',
          content: '' as never,
          ...({
            content: [{ type: 'text', text: 'real reply' }],
          } as unknown as { content: never }),
          timestamp: 1001,
        },
      ],
    }
    const out = convertOpenClawHistoryToAgentHistory('demo', raw)
    expect(out.items.map((i) => ({ role: i.role, text: i.text }))).toEqual([
      { role: 'assistant', text: 'real reply' },
    ])
  })

  it('attaches assistant reasoning and pairs tool call output across messages', () => {
    const raw: OpenClawSessionHistory = {
      sessionKey: 'agent:demo:main',
      messages: [
        {
          role: 'user',
          content: '' as never,
          ...({
            content: [{ type: 'text', text: 'navigate to example.com' }],
          } as unknown as { content: never }),
          timestamp: 1000,
        },
        {
          role: 'assistant',
          content: '' as never,
          ...({
            content: [
              {
                type: 'thinking',
                thinking: 'I should call the navigate tool.',
              },
              {
                type: 'toolCall',
                id: 'call-1',
                name: 'navigate',
                arguments: { url: 'https://example.com' },
              },
            ],
          } as unknown as { content: never }),
          timestamp: 1001,
        },
        {
          role: 'tool',
          content: '' as never,
          ...({
            content: [
              {
                type: 'toolResult',
                toolCallId: 'call-1',
                content: 'navigated',
              },
            ],
          } as unknown as { content: never }),
          timestamp: 1002,
        },
      ],
    }

    const out = convertOpenClawHistoryToAgentHistory('demo', raw)
    // 'tool' role messages are folded into the prior assistant entry, not surfaced
    expect(out.items.map((i) => i.role)).toEqual(['user', 'assistant'])
    const assistant = out.items[1]
    expect(assistant.reasoning?.text).toBe('I should call the navigate tool.')
    expect(assistant.toolCalls).toEqual([
      {
        toolCallId: 'call-1',
        toolName: 'navigate',
        status: 'completed',
        input: { url: 'https://example.com' },
        output: 'navigated',
      },
    ])
  })
})
