import { describe, expect, it, mock } from 'bun:test'
import type { LlmProviderConfig } from '@/lib/llm-providers/types'

/**
 * First suite for getChatServerResponse, the single export of
 * ./getChatServerResponse. Every export is exercised below; none had to be
 * left untested, so no dependency-blocked export is listed here.
 *
 * The module's inputs that live in the browser (the agent server base URL,
 * the stored provider list, the stored MCP server list, the stored
 * personalisation text) are pinned through mock.module, because the real
 * modules read BrowserOS preferences and chrome.storage, which do not exist
 * under `bun test`. Everything downstream of those inputs - request-body
 * assembly, the HTTP call, SSE parsing via eventsource-parser, stream-state
 * reduction and error mapping - runs as the real code. `fetch` is replaced
 * with an in-memory stub that answers with scripted SSE payloads, so the
 * suite needs no network, no database and no container.
 */

const testProvider: LlmProviderConfig = {
  id: 'pinned-provider',
  type: 'browseros',
  name: 'Pinned Provider',
  baseUrl: 'https://pinned.invalid/v1',
  modelId: 'pinned-model',
  supportsImages: false,
  contextWindow: 200000,
  temperature: 0,
  createdAt: 0,
  updatedAt: 0,
}

mock.module('@/lib/browseros/helpers', () => ({
  getAgentServerUrl: async () => 'http://127.0.0.1:65530',
}))

mock.module('@/lib/llm-providers/storage', () => ({
  DEFAULT_PROVIDER_ID: 'browseros',
  providersStorage: { getValue: async () => [testProvider] },
  defaultProviderIdStorage: { getValue: async () => testProvider.id },
  createDefaultBrowserOSProvider: () => testProvider,
}))

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  mcpServerStorage: { getValue: async () => [] },
}))

mock.module('../personalization/personalizationStorage', () => ({
  personalizationStorage: {
    getValue: async () => 'Pinned personalisation text.',
  },
}))

const { getChatServerResponse } = await import('./getChatServerResponse')

/** One SSE `data:` event per stream chunk, the way a live server sends them. */
function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${event}\n\n`))
        }
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

const textEvent = (delta: string) =>
  JSON.stringify({ type: 'text-delta', id: 't', delta })

const finishEvent = () => JSON.stringify({ type: 'finish', finishReason: 'stop' })

describe('getChatServerResponseContract', () => {
  it('getChatServerResponse: posts the chat, assembles the streamed reply, and maps every failure mode', async () => {
    type CapturedRequest = { url: string; body: Record<string, unknown> | null }
    const originalFetch = globalThis.fetch
    const requests: CapturedRequest[] = []
    let respondWith: () => Response = () => sseResponse([textEvent('unused')])

    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      requests.push({
        url: String(input),
        body: JSON.parse(init?.body ?? 'null') as Record<
          string,
          unknown
        > | null,
      })
      return respondWith()
    }) as typeof fetch

    try {
      // The full happy path: prose, a tool call that succeeds, a tool call
      // that fails, a non-JSON event and a [DONE] marker to be ignored, more
      // prose, then the finish marker.
      respondWith = () =>
        sseResponse([
          textEvent('Reading the page.'),
          JSON.stringify({
            type: 'tool-input-available',
            toolCallId: 'call-1',
            toolName: 'read_page',
            input: { url: 'https://example.com' },
          }),
          JSON.stringify({
            type: 'tool-output-available',
            toolCallId: 'call-1',
            output: { title: 'Example Domain' },
          }),
          JSON.stringify({
            type: 'tool-input-available',
            toolCallId: 'call-2',
            toolName: 'click_link',
            input: { text: 'More information' },
          }),
          JSON.stringify({
            type: 'tool-output-error',
            toolCallId: 'call-2',
            errorText: 'link not found',
          }),
          'this event is not JSON',
          '[DONE]',
          textEvent(' Done.'),
          finishEvent(),
        ])

      const result = await getChatServerResponse({
        message: 'Summarise the page.',
        conversationId: 'conv-pinned-001',
      })

      // The request went to the chat endpoint of the configured server and
      // carried the user's message and the caller's conversation id.
      expect(requests.at(-1)?.url).toBe('http://127.0.0.1:65530/chat')
      expect(requests.at(-1)?.body?.messages).toEqual([
        { role: 'user', content: 'Summarise the page.' },
      ])
      expect(requests.at(-1)?.body?.conversationId).toBe('conv-pinned-001')

      // The reply text is every text delta concatenated in arrival order.
      expect(result.text).toBe('Reading the page. Done.')

      // The caller's conversation id passes through unchanged.
      expect(result.conversationId).toBe('conv-pinned-001')

      // The final result is the prose that trailed the last tool call.
      expect(result.finalResult).toBe('Done.')

      // The execution log joins each completed step with a blank line.
      expect(result.executionLog).toBe('Reading the page.\n\nDone.')

      // Tool calls are recorded in arrival order, with outputs and errors
      // attached to the right call and a timestamp each.
      const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      expect(result.toolCalls).toHaveLength(2)
      expect(result.toolCalls[0]).toMatchObject({
        id: 'call-1',
        name: 'read_page',
        input: { url: 'https://example.com' },
        output: { title: 'Example Domain' },
      })
      expect(result.toolCalls[0]?.timestamp).toMatch(isoTimestamp)
      expect(result.toolCalls[1]).toMatchObject({
        id: 'call-2',
        name: 'click_link',
        input: { text: 'More information' },
        error: 'link not found',
      })
      expect(result.toolCalls[1]?.timestamp).toMatch(isoTimestamp)

      // With no conversation id given, one is minted and sent on the wire.
      respondWith = () => sseResponse([textEvent('Pong.'), finishEvent()])

      const minted = await getChatServerResponse({ message: 'Ping.' })

      expect(minted.conversationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      expect(minted.text).toBe('Pong.')
      expect(requests.at(-1)?.body?.conversationId).toBe(minted.conversationId)

      // When the stream's last act is a tool call rather than prose, the
      // final result falls back to the text that led up to the tool call,
      // and that step appears in the log twice.
      respondWith = () =>
        sseResponse([
          textEvent('Step one.'),
          JSON.stringify({
            type: 'tool-input-available',
            toolCallId: 'call-3',
            toolName: 'read_page',
            input: { url: 'https://example.org' },
          }),
          JSON.stringify({
            type: 'tool-output-available',
            toolCallId: 'call-3',
            output: { title: 'Example' },
          }),
          finishEvent(),
        ])

      const bare = await getChatServerResponse({ message: 'Tool last.' })

      expect(bare.text).toBe('Step one.')
      expect(bare.finalResult).toBe('Step one.')
      expect(bare.executionLog).toBe('Step one.\n\nStep one.')

      // A non-2xx HTTP status becomes an error naming status and reason.
      respondWith = () =>
        new Response(null, {
          status: 503,
          statusText: 'Service Unavailable',
        })

      await expect(
        getChatServerResponse({ message: 'Fail on HTTP.' }),
      ).rejects.toThrow('Chat request failed: 503 Service Unavailable')

      // An error event inside the stream is surfaced as a rejection.
      respondWith = () =>
        sseResponse([
          JSON.stringify({ type: 'error', errorText: 'model overloaded' }),
        ])

      await expect(
        getChatServerResponse({ message: 'Fail mid-stream.' }),
      ).rejects.toThrow('model overloaded')

      // A stream that ends without a finish marker is an interruption error.
      respondWith = () => sseResponse([textEvent('Cut off.')])

      await expect(
        getChatServerResponse({ message: 'Fail truncated.' }),
      ).rejects.toThrow(
        'Stream ended unexpectedly without completion. The task may have been interrupted.',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
