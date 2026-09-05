import { describe, expect, it } from 'bun:test'
import type { UIMessage } from 'ai'
import {
  getMessageSegments,
  type NudgeData,
  type ToolInvocationInfo,
  type ToolInvocationState,
} from './getMessageSegments'

/**
 * Coverage note: getMessageSegments is the only runtime export of this module
 * and every assertion below exercises it directly. The remaining exports
 * (ToolInvocationState, ToolInvocationInfo, NudgeType, NudgeData and
 * MessageSegment) are types; they are exercised through the values fed to and
 * returned by getMessageSegments. No export needs a live dependency to be
 * exercised, so nothing is listed here as blocked.
 */

type MessagePart = UIMessage['parts'][number]

interface ToolPartOverrides {
  toolCallId?: string
  state?: ToolInvocationState
  input?: Record<string, unknown>
  output?: unknown
  approval?: ToolInvocationInfo['approval']
}

const messageWith = (parts: MessagePart[], id = 'm1'): UIMessage => ({
  id,
  parts,
})

const textPart = (text: string): MessagePart =>
  ({ type: 'text', text }) as MessagePart

const reasoningPart = (text: string): MessagePart =>
  ({ type: 'reasoning', text }) as MessagePart

const toolPart = (
  toolName: string,
  overrides: ToolPartOverrides = {},
): MessagePart =>
  ({
    type: `tool-${toolName}`,
    toolCallId: overrides.toolCallId ?? `call-${toolName}`,
    state: overrides.state ?? 'output-available',
    input: overrides.input,
    output: overrides.output,
    approval: overrides.approval,
  }) as MessagePart

const nudgeOutput = (payload: unknown): unknown => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  isError: false,
})

describe('getMessageSegmentsContract', () => {
  it('getMessageSegments maps UIMessage parts to ordered, keyed segments', () => {
    const schedulePayload: NudgeData = {
      type: 'schedule_suggestion',
      query: 'check the news',
      scheduleType: 'daily',
    }
    const appPayload: NudgeData = { type: 'app_connection', appName: 'GitHub' }

    // A message without parts yields no segments.
    expect(getMessageSegments(messageWith([]), true, true)).toEqual([])

    // Parts the renderer does not know about are dropped and do not disturb
    // the numbering of the segments around them.
    expect(
      getMessageSegments(
        messageWith([
          textPart('one'),
          {
            type: 'source-url',
            url: 'https://example.test',
          } as unknown as MessagePart,
          textPart('two'),
        ]),
        false,
        false,
      ),
    ).toEqual([
      { type: 'text', key: 'm1-text-0', text: 'one' },
      { type: 'text', key: 'm1-text-1', text: 'two' },
    ])

    // Keys carry the message id.
    expect(
      getMessageSegments(
        messageWith([textPart('hey')], 'conv-9-msg-42'),
        false,
        false,
      ),
    ).toEqual([{ type: 'text', key: 'conv-9-msg-42-text-0', text: 'hey' }])

    // A trailing reasoning part of the last message streams only while the
    // conversation is streaming, and only when no part follows it.
    expect(
      getMessageSegments(messageWith([reasoningPart('hmm')]), true, true),
    ).toEqual([
      {
        type: 'reasoning',
        key: 'm1-reasoning-0',
        text: 'hmm',
        isStreaming: true,
      },
    ])
    expect(
      getMessageSegments(messageWith([reasoningPart('hmm')]), false, true),
    ).toEqual([
      {
        type: 'reasoning',
        key: 'm1-reasoning-0',
        text: 'hmm',
        isStreaming: false,
      },
    ])
    expect(
      getMessageSegments(messageWith([reasoningPart('hmm')]), true, false),
    ).toEqual([
      {
        type: 'reasoning',
        key: 'm1-reasoning-0',
        text: 'hmm',
        isStreaming: false,
      },
    ])
    expect(
      getMessageSegments(
        messageWith([reasoningPart('early'), textPart('later')]),
        true,
        true,
      ),
    ).toEqual([
      {
        type: 'reasoning',
        key: 'm1-reasoning-0',
        text: 'early',
        isStreaming: false,
      },
      { type: 'text', key: 'm1-text-0', text: 'later' },
    ])
    expect(
      getMessageSegments(
        messageWith([reasoningPart('a'), reasoningPart('b')]),
        true,
        true,
      ),
    ).toEqual([
      {
        type: 'reasoning',
        key: 'm1-reasoning-0',
        text: 'a',
        isStreaming: false,
      },
      {
        type: 'reasoning',
        key: 'm1-reasoning-1',
        text: 'b',
        isStreaming: true,
      },
    ])

    // A lone tool call becomes one batch, flushed at the end of the message,
    // and missing input, output and approval fall back to empty values.
    expect(
      getMessageSegments(messageWith([toolPart('search')]), false, false),
    ).toEqual([
      {
        type: 'tool-batch',
        key: 'm1-tools-call-search',
        tools: [
          {
            state: 'output-available',
            toolCallId: 'call-search',
            toolName: 'search',
            input: {},
            output: [],
          },
        ],
      },
    ])

    // Consecutive tool calls share a single batch keyed by the first call,
    // and state, input, output and approval are carried through unchanged.
    expect(
      getMessageSegments(
        messageWith([
          toolPart('search', {
            toolCallId: 'call-search',
            input: { query: 'browseros' },
            output: ['hit-1', 'hit-2'],
          }),
          toolPart('read', {
            toolCallId: 'call-read',
            state: 'partial-call',
            approval: { id: 'appr-7', approved: false, reason: 'not yet' },
          }),
        ]),
        false,
        false,
      ),
    ).toEqual([
      {
        type: 'tool-batch',
        key: 'm1-tools-call-search',
        tools: [
          {
            state: 'output-available',
            toolCallId: 'call-search',
            toolName: 'search',
            input: { query: 'browseros' },
            output: ['hit-1', 'hit-2'],
          },
          {
            state: 'partial-call',
            toolCallId: 'call-read',
            toolName: 'read',
            input: {},
            output: [],
            approval: { id: 'appr-7', approved: false, reason: 'not yet' },
          },
        ],
      },
    ])

    // A null output is normalised to an empty array.
    expect(
      getMessageSegments(
        messageWith([toolPart('search', { output: null })]),
        false,
        false,
      ),
    ).toEqual([
      {
        type: 'tool-batch',
        key: 'm1-tools-call-search',
        tools: [
          {
            state: 'output-available',
            toolCallId: 'call-search',
            toolName: 'search',
            input: {},
            output: [],
          },
        ],
      },
    ])

    // A text or reasoning part closes the batch in front of it, so two tool
    // runs separated by prose arrive as two batches in reading order.
    expect(
      getMessageSegments(
        messageWith([
          textPart('first'),
          toolPart('search', { toolCallId: 'call-a' }),
          textPart('second'),
          toolPart('search', { toolCallId: 'call-b' }),
        ]),
        false,
        false,
      ),
    ).toEqual([
      { type: 'text', key: 'm1-text-0', text: 'first' },
      {
        type: 'tool-batch',
        key: 'm1-tools-call-a',
        tools: [
          {
            state: 'output-available',
            toolCallId: 'call-a',
            toolName: 'search',
            input: {},
            output: [],
          },
        ],
      },
      { type: 'text', key: 'm1-text-1', text: 'second' },
      {
        type: 'tool-batch',
        key: 'm1-tools-call-b',
        tools: [
          {
            state: 'output-available',
            toolCallId: 'call-b',
            toolName: 'search',
            input: {},
            output: [],
          },
        ],
      },
    ])

    // A recognised schedule nudge becomes a nudge segment carrying the parsed
    // payload verbatim, and it closes the batch in front of it.
    expect(
      getMessageSegments(
        messageWith([
          toolPart('search', { toolCallId: 'call-x' }),
          toolPart('suggest_schedule', {
            toolCallId: 'call-sched',
            output: nudgeOutput(schedulePayload),
          }),
        ]),
        false,
        false,
      ),
    ).toEqual([
      {
        type: 'tool-batch',
        key: 'm1-tools-call-x',
        tools: [
          {
            state: 'output-available',
            toolCallId: 'call-x',
            toolName: 'search',
            input: {},
            output: [],
          },
        ],
      },
      {
        type: 'nudge',
        key: 'm1-nudge-call-sched',
        nudgeType: 'schedule_suggestion',
        data: schedulePayload,
      },
    ])

    // An app-connection nudge is reported under its own nudge type.
    expect(
      getMessageSegments(
        messageWith([
          toolPart('suggest_app_connection', {
            toolCallId: 'call-app',
            output: nudgeOutput(appPayload),
          }),
        ]),
        false,
        false,
      ),
    ).toEqual([
      {
        type: 'nudge',
        key: 'm1-nudge-call-app',
        nudgeType: 'app_connection',
        data: appPayload,
      },
    ])

    // Nudge output that cannot be read - an error result, no text part,
    // unparseable text, a foreign payload type, or no output at all - emits
    // nothing.
    const ignoredNudgeOutputs: unknown[] = [
      {
        content: [{ type: 'text', text: JSON.stringify(schedulePayload) }],
        isError: true,
      },
      { content: [{ type: 'image', data: 'zzz' }] },
      { content: [{ type: 'text', text: '{not json' }] },
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ type: 'weather', city: 'Oslo' }),
          },
        ],
      },
      undefined,
    ]
    for (const ignoredOutput of ignoredNudgeOutputs) {
      expect(
        getMessageSegments(
          messageWith([
            toolPart('suggest_schedule', {
              toolCallId: 'call-sched',
              output: ignoredOutput,
            }),
          ]),
          false,
          false,
        ),
      ).toEqual([])
    }

    // A nudge tool that has not produced output yet stays invisible and never
    // joins the batch of the ordinary tools around it.
    expect(
      getMessageSegments(
        messageWith([
          toolPart('suggest_schedule', {
            toolCallId: 'call-sched',
            state: 'call',
          }),
          toolPart('search', { toolCallId: 'call-y' }),
        ]),
        false,
        false,
      ),
    ).toEqual([
      {
        type: 'tool-batch',
        key: 'm1-tools-call-y',
        tools: [
          {
            state: 'output-available',
            toolCallId: 'call-y',
            toolName: 'search',
            input: {},
            output: [],
          },
        ],
      },
    ])

    // An unreadable nudge output emits no segment of its own, yet a nudge
    // that has reached output-available still closes the batch in front of
    // it, so the tools after it start a fresh batch of their own.
    expect(
      getMessageSegments(
        messageWith([
          toolPart('search', { toolCallId: 'call-a' }),
          toolPart('suggest_schedule', {
            toolCallId: 'call-sched',
            output: { content: [{ type: 'text', text: '{not json' }] },
          }),
          toolPart('read', { toolCallId: 'call-b' }),
        ]),
        false,
        false,
      ),
    ).toEqual([
      {
        type: 'tool-batch',
        key: 'm1-tools-call-a',
        tools: [
          {
            state: 'output-available',
            toolCallId: 'call-a',
            toolName: 'search',
            input: {},
            output: [],
          },
        ],
      },
      {
        type: 'tool-batch',
        key: 'm1-tools-call-b',
        tools: [
          {
            state: 'output-available',
            toolCallId: 'call-b',
            toolName: 'read',
            input: {},
            output: [],
          },
        ],
      },
    ])

    // A full conversation round keeps every kind of segment in order, with
    // per-kind counters and a streaming flag on the final reasoning only.
    expect(
      getMessageSegments(
        messageWith([
          reasoningPart('planning'),
          textPart('working'),
          toolPart('search', {
            toolCallId: 'call-s',
            input: { q: 'hi' },
            output: ['r'],
          }),
          toolPart('read', { toolCallId: 'call-r' }),
          toolPart('suggest_schedule', {
            toolCallId: 'call-n',
            output: nudgeOutput(schedulePayload),
          }),
          textPart('done'),
          reasoningPart('wrapping up'),
        ]),
        true,
        true,
      ),
    ).toEqual([
      {
        type: 'reasoning',
        key: 'm1-reasoning-0',
        text: 'planning',
        isStreaming: false,
      },
      { type: 'text', key: 'm1-text-0', text: 'working' },
      {
        type: 'tool-batch',
        key: 'm1-tools-call-s',
        tools: [
          {
            state: 'output-available',
            toolCallId: 'call-s',
            toolName: 'search',
            input: { q: 'hi' },
            output: ['r'],
          },
          {
            state: 'output-available',
            toolCallId: 'call-r',
            toolName: 'read',
            input: {},
            output: [],
          },
        ],
      },
      {
        type: 'nudge',
        key: 'm1-nudge-call-n',
        nudgeType: 'schedule_suggestion',
        data: schedulePayload,
      },
      { type: 'text', key: 'm1-text-1', text: 'done' },
      {
        type: 'reasoning',
        key: 'm1-reasoning-1',
        text: 'wrapping up',
        isStreaming: true,
      },
    ])
  })
})
