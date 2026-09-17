/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Converts an aggregated OpenClaw session history (rich content blocks
 * across the agent's main + sub-sessions) into the flat AgentHistoryPage
 * shape the chat panel consumes.
 *
 * Input: OpenClawSessionHistory.messages — each message has `content`
 *   that is either a string OR an array of typed blocks
 *   ({type: 'text'|'thinking'|'toolCall'|'toolResult'}). The HTTP endpoint
 *   returns the array form even though the type definition says string.
 *
 * Output: AgentHistoryEntry[] — flat text per entry, separate `reasoning`
 *   and `toolCalls` fields the UI renders as collapsible sections.
 *
 * Tool result pairing: `toolCall` blocks emit on assistant messages;
 * the matching `toolResult` arrives in a later message (typically with
 * role 'tool' or 'toolResult'). We pair them by `toolCallId` so the
 * resulting AgentHistoryToolCall has both input and output.
 */

import { unwrapBrowserosAcpUserMessage } from '../../../lib/agents/acpx-runtime'
import type {
  AgentHistoryEntry,
  AgentHistoryToolCall,
} from '../../../lib/agents/agent-types'
import type { AgentHistoryPage } from '../../../lib/agents/types'
import type {
  OpenClawSessionHistory,
  OpenClawSessionHistoryMessage,
} from './openclaw-http-client'

const CRON_PROMPT_PREFIX_PATTERN =
  /^\[cron:[0-9a-f-]+ ([^\]]+)\]\s*([\s\S]*?)\n*Current time:[^\n]*(?:\n[\s\S]*)?$/
const CRON_DELIVERY_TRAILER =
  /\n*Use the message tool if you need to notify the user directly[\s\S]*$/
const QUEUED_MARKER_LINE =
  /^\[Queued user message that arrived while the previous turn was still active\]\s*$/m
const SUBAGENT_CONTEXT_PREFIX = /^\[Subagent Context\][\s\S]*$/
// Emitted by OpenClaw's acp-cli ahead of the BrowserOS envelope. Three
// prefix shapes (any combination, in this stack order):
//
//   1. `[media attached: <internal-path> (<mime>)]`        ← per attachment
//   2. `[<weekday> <YYYY-MM-DD HH:MM> <TZ>]`               ← injectTimestamp
//   3. `[Working directory: <path>]`                       ← acp-cli prefixCwd
//
// Stacks #1 may appear multiple times (one per image). Stack #2 and #3
// can render on the same line separated by a space. Each known prefix is
// anchored on its content shape (not just `[…]`) to avoid clobbering
// user-typed lines that happen to start with a bracket.
const OPENCLAW_MEDIA_PREFIX_LINE = /^\[media attached:[^\]\n]*\]\n/
const OPENCLAW_TIMESTAMP_PREFIX =
  /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]\n]*\][ \t]*/
const OPENCLAW_WORKDIR_PREFIX = /^\[Working directory: [^\]\n]*\]\n+/

function stripOpenClawAcpCliEnvelope(value: string): string {
  let s = value
  while (OPENCLAW_MEDIA_PREFIX_LINE.test(s)) {
    s = s.replace(OPENCLAW_MEDIA_PREFIX_LINE, '')
  }
  s = s.replace(OPENCLAW_TIMESTAMP_PREFIX, '')
  s = s.replace(OPENCLAW_WORKDIR_PREFIX, '')
  return s
}

/**
 * Strip OpenClaw + BrowserOS scaffolding from a "user" message before
 * showing it in the chat panel.
 *
 * BrowserOS-side envelope (`<role>…</role>\n\n<user_request>…</user_request>`)
 * is delegated to `unwrapBrowserosAcpUserMessage`, which performs an
 * exact-string match against the same constants `buildBrowserosAcpPrompt`
 * uses to wrap. Matcher and wrapper live in the same repo, so the two
 * always travel together.
 *
 * OpenClaw's acp-cli prepends a `[Working directory: <path>]\n\n` line
 * before the BrowserOS envelope (see /app/dist/acp-cli-*.js, line 1361).
 * We strip that single line up-front so the `^<role>` anchor in
 * `unwrapBrowserosAcpUserMessage` matches.
 *
 * OpenClaw-injected scaffolding (cron prefix, queued-marker, subagent
 * context) is still pattern-matched here. Removing those requires either
 * an OpenClaw schema change exposing the structured trigger payload, or a
 * BrowserOS-side side-channel (cache cron payloads on `cron.add` and look
 * up by jobId). Tracked as the next cleanup; until then this is best-
 * effort with text-level patterns.
 */
export function cleanHistoryUserText(raw: string): string {
  if (!raw) return raw
  // Queued-marker case: this is structurally a multi-message blob, so
  // split first and recurse into each chunk. We keep the join character
  // narrow (single newline) so e.g. five cron payloads render as five
  // visually-separate lines rather than one wall of text.
  if (QUEUED_MARKER_LINE.test(raw)) {
    const chunks = raw
      .split(
        /^\[Queued user message that arrived while the previous turn was still active\]\s*$/m,
      )
      .map((chunk) => cleanSingleUserMessage(chunk))
      .filter((chunk) => chunk.length > 0)
    return chunks.join('\n')
  }
  return cleanSingleUserMessage(raw)
}

function cleanSingleUserMessage(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  // Subagent context seed: pure scaffolding, drop entirely. The real
  // task lives in the subagent's system prompt; the user-message body
  // is just framing the model never produced.
  if (SUBAGENT_CONTEXT_PREFIX.test(trimmed)) {
    return ''
  }
  const cronMatch = CRON_PROMPT_PREFIX_PATTERN.exec(trimmed)
  if (cronMatch) {
    const payload = cronMatch[2] ?? ''
    return payload.replace(CRON_DELIVERY_TRAILER, '').trim()
  }
  // Strip OpenClaw's acp-cli envelope (media-attached lines + timestamp
  // + workdir) before delegating, so the BrowserOS unwrap helper's
  // `^<role>` anchor matches.
  const withoutEnvelope = stripOpenClawAcpCliEnvelope(trimmed)
  return unwrapBrowserosAcpUserMessage(withoutEnvelope).trim()
}

type RichBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string; text?: string }
  | {
      type: 'toolCall'
      id?: string
      toolCallId?: string
      name?: string
      arguments?: unknown
    }
  | {
      type: 'toolResult'
      toolCallId?: string
      content?: unknown
      isError?: boolean
    }
  | { type: string; [key: string]: unknown }

// We hold the AgentHistoryToolCall reference itself in `pending` so a
// later `toolResult` block mutates the same object that was already
// pushed onto the assistant entry's `toolCalls` array.
type PendingToolCall = AgentHistoryToolCall

export function convertOpenClawHistoryToAgentHistory(
  agentId: string,
  raw: OpenClawSessionHistory,
): AgentHistoryPage {
  const items: AgentHistoryEntry[] = []
  // Resolved tool calls keyed by toolCallId — used to attach `output`
  // back to the assistant entry that issued the call once the tool
  // result arrives in a subsequent message.
  const pendingByToolCallId = new Map<string, PendingToolCall>()

  let entryCounter = 0
  const nextId = () => `${agentId}:hist:${entryCounter++}`

  for (const message of raw.messages) {
    const blocks = normalizeBlocks(message)
    const role = normalizeRole(message.role)

    if (!role) {
      // 'system' / 'tool' messages aren't shown as their own chat entries;
      // tool results get folded into the assistant entry they complete.
      if (message.role === 'tool') {
        applyToolResults(blocks, pendingByToolCallId)
      }
      continue
    }

    const rawText = collectText(blocks).trim()
    const text = role === 'user' ? cleanHistoryUserText(rawText) : rawText
    const reasoningText = collectThinking(blocks).trim()
    const toolCallEntries = collectToolCalls(blocks, pendingByToolCallId)

    // Skip empty entries. Two cases:
    //   - User: cleaner returned empty after stripping scaffolding (e.g.
    //     dropped Subagent Context message). No bubble to render.
    //   - Assistant: model returned only thinking blocks (common with
    //     MiniMax `thinking: minimal` for trivial prompts) and no text
    //     or tools. The empty bubble + dangling reasoning collapsible
    //     reads as broken UI; cleaner to drop the turn entirely.
    if (!text && toolCallEntries.length === 0) continue

    const entry: AgentHistoryEntry = {
      id: message.messageId ?? nextId(),
      agentId,
      sessionId: 'main',
      role,
      text,
      createdAt: message.timestamp ?? 0,
    }
    if (reasoningText) {
      entry.reasoning = { text: reasoningText }
    }
    if (toolCallEntries.length > 0) {
      entry.toolCalls = toolCallEntries
    }

    items.push(entry)
  }

  return {
    agentId,
    sessionId: 'main',
    items,
  }
}

function normalizeBlocks(message: OpenClawSessionHistoryMessage): RichBlock[] {
  const content = (message as { content: unknown }).content
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  if (Array.isArray(content)) {
    return content as RichBlock[]
  }
  return []
}

function normalizeRole(
  role: OpenClawSessionHistoryMessage['role'],
): 'user' | 'assistant' | null {
  if (role === 'user' || role === 'assistant') return role
  return null
}

function collectText(blocks: RichBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function collectThinking(blocks: RichBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'thinking') {
      const value =
        typeof block.thinking === 'string'
          ? block.thinking
          : typeof block.text === 'string'
            ? block.text
            : ''
      if (value) parts.push(value)
    }
  }
  return parts.join('\n\n')
}

function collectToolCalls(
  blocks: RichBlock[],
  pending: Map<string, PendingToolCall>,
): AgentHistoryToolCall[] {
  const out: AgentHistoryToolCall[] = []
  for (const block of blocks) {
    if (block.type !== 'toolCall') continue
    const callId =
      typeof block.toolCallId === 'string'
        ? block.toolCallId
        : typeof block.id === 'string'
          ? block.id
          : undefined
    if (!callId) continue
    const toolName = typeof block.name === 'string' ? block.name : 'unknown'
    const entry: AgentHistoryToolCall = {
      toolCallId: callId,
      toolName,
      status: 'completed',
      input: block.arguments,
    }
    out.push(entry)
    // Hold the same reference so a later toolResult mutates the entry
    // already pushed onto the assistant's toolCalls array.
    pending.set(callId, entry)
  }
  return out
}

function applyToolResults(
  blocks: RichBlock[],
  pending: Map<string, PendingToolCall>,
): void {
  for (const block of blocks) {
    if (block.type !== 'toolResult') continue
    const callId =
      typeof block.toolCallId === 'string' ? block.toolCallId : undefined
    if (!callId) continue
    const entry = pending.get(callId)
    if (!entry) continue
    if (block.isError) {
      entry.status = 'failed'
      entry.error =
        typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content)
    } else {
      entry.output = block.content
    }
  }
}
