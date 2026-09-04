/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { UIMessage } from 'ai'

/**
 * Checks whether a UIMessage has meaningful content that can be sent
 * to the AI provider without causing validation errors.
 *
 * Two layers of validation can reject messages:
 *
 * 1. **AI SDK** (`validate-ui-messages.ts`):
 *    - `parts` array must be `.nonempty()` - rejects `parts: []`
 *
 * 2. **Provider API** (e.g. Gemini `generateContent`, Anthropic, OpenAI):
 *    - Assistant messages with only empty-string text are rejected
 *      as semantically empty, even though the SDK schema allows it
 *
 * This function guards against both layers so callers can filter
 * messages before passing them to `createAgentUIStreamResponse`.
 */
export function hasMessageContent(message: UIMessage): boolean {
  if (message.parts.length === 0) return false

  // A message that contains any non-text part (tool invocation, reasoning,
  // file, step-start, etc.) is always considered valid - those part types
  // carry meaning regardless of text content.
  const hasNonTextPart = message.parts.some((p) => p.type !== 'text')
  if (hasNonTextPart) return true

  // All parts are text - at least one must have non-whitespace content.
  return message.parts.some(
    (p) => p.type === 'text' && p.text.trim().length > 0,
  )
}

/**
 * Filters a UIMessage array, removing messages that would fail
 * SDK validation or provider-level content checks.
 */
export function filterValidMessages(messages: UIMessage[]): UIMessage[] {
  return repairOrphanToolCalls(messages.filter(hasMessageContent))
}

/**
 * Gives every tool call that never produced a result an explicit error result.
 *
 * When a stream is aborted mid-tool-call the assistant message is persisted
 * with a tool part still in `input-available`. The AI SDK validates the pairing
 * in `convertToLanguageModelPrompt` and throws `AI_MissingToolResultsError`
 * before the request leaves, so the conversation is dead for every later send,
 * not just the aborted one. Providers enforce the same invariant themselves.
 *
 * The result is synthesised rather than the part being dropped: deleting the
 * call as well as the result leaves the model with no record of what it tried,
 * and it then repeats the same call forever without ever seeing an outcome.
 */
export function repairOrphanToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message

    let repaired = false
    const parts = message.parts.map((part) => {
      const isToolPart =
        typeof part.type === 'string' &&
        (part.type.startsWith('tool-') || part.type === 'dynamic-tool')
      if (!isToolPart) return part

      const state = (part as { state?: string }).state
      if (state === 'output-available' || state === 'output-error') return part

      repaired = true
      return {
        ...part,
        state: 'output-error' as const,
        errorText:
          'This tool call was interrupted before it returned. Treat it as not run.',
      }
    })

    return repaired ? { ...message, parts } : message
  }) as UIMessage[]
}

/**
 * Remove tool parts that reference tools not present in the given toolset.
 *
 * When a session is rebuilt with a different set of tools (e.g., workspace
 * removed mid-conversation or MCP server disconnected), the carried-over
 * message history may contain tool parts for tools that no longer exist.
 * The AI SDK validates messages against the current toolset and rejects
 * parts with no matching schema.
 *
 * Tool parts use the type format `tool-${toolName}` (static tools) or
 * `dynamic-tool` (dynamic tools). This function filters out static tool
 * parts whose tool name is not in the provided set.
 */
export function sanitizeMessagesForToolset(
  messages: UIMessage[],
  toolNames: Set<string>,
): UIMessage[] {
  return messages
    .map((msg) => {
      const filteredParts = msg.parts.filter((part) => {
        // Static tool parts have type `tool-${toolName}`
        if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
          const toolName = part.type.slice(5)
          if (!toolNames.has(toolName)) return false
        }
        return true
      })

      if (filteredParts.length === msg.parts.length) return msg
      return { ...msg, parts: filteredParts }
    })
    .filter(hasMessageContent)
}
