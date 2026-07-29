/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'

import { filterValidMessages, repairOrphanToolCalls } from './message-validation'

/** Builds an assistant message carrying a single tool part in `state`. */
function assistantWithTool(state: string, toolCallId = 'call_1'): UIMessage {
  return {
    id: 'm1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-filesystem_read',
        toolCallId,
        state,
        input: { path: 'a.txt' },
      },
    ],
  } as unknown as UIMessage
}

describe('repairOrphanToolCalls', () => {
  test('gives an interrupted tool call an error result', () => {
    const [message] = repairOrphanToolCalls([assistantWithTool('input-available')])
    const part = message.parts[0] as { state: string; errorText?: string }

    expect(part.state).toBe('output-error')
    expect(part.errorText).toContain('interrupted')
  })

  test('repairs a call that never left the input-streaming state', () => {
    const [message] = repairOrphanToolCalls([assistantWithTool('input-streaming')])
    expect((message.parts[0] as { state: string }).state).toBe('output-error')
  })

  test('leaves a completed tool call untouched', () => {
    const original = assistantWithTool('output-available')
    const [message] = repairOrphanToolCalls([original])

    expect(message).toBe(original)
  })

  test('preserves the tool call itself rather than dropping it', () => {
    // Dropping the call as well as the result leaves the model with no record
    // of what it tried, and it repeats the same call forever.
    const [message] = repairOrphanToolCalls([assistantWithTool('input-available')])
    const part = message.parts[0] as { toolCallId: string; input: unknown }

    expect(message.parts).toHaveLength(1)
    expect(part.toolCallId).toBe('call_1')
    expect(part.input).toEqual({ path: 'a.txt' })
  })

  test('repairs dynamic tool parts too', () => {
    const message = {
      id: 'm1',
      role: 'assistant',
      parts: [{ type: 'dynamic-tool', toolCallId: 'call_2', state: 'input-available' }],
    } as unknown as UIMessage

    const [repaired] = repairOrphanToolCalls([message])
    expect((repaired.parts[0] as { state: string }).state).toBe('output-error')
  })

  test('ignores user messages', () => {
    const user = {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: 'hello' }],
    } as unknown as UIMessage

    expect(repairOrphanToolCalls([user])[0]).toBe(user)
  })
})

describe('filterValidMessages', () => {
  test('repairs orphans while filtering, so a poisoned conversation recovers', () => {
    const [message] = filterValidMessages([assistantWithTool('input-available')])
    expect((message.parts[0] as { state: string }).state).toBe('output-error')
  })

  test('still drops messages with no parts', () => {
    const empty = { id: 'e', role: 'assistant', parts: [] } as unknown as UIMessage
    expect(filterValidMessages([empty])).toHaveLength(0)
  })
})
