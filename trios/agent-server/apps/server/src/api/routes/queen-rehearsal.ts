/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A recorded stream where a model would be, so the machinery can be proven
 * without one.
 *
 * The container has everything a bee needs except a provider credential, and
 * that credential is not something this process may install for itself. So
 * dispatch was written, wired, and never once executed: the worktree step and
 * the turn step had no evidence at all, only code review.
 *
 * This is the repository's own answer to that, moved into the cloud. The Mac
 * proves worker behaviour by replaying recorded SSE cassettes instead of
 * calling a model - that is what `TRIOS_REPLAY_CASSETTE` does. The same trick
 * works here because `openai-compatible` is the one provider whose factory
 * requires a baseUrl and no apiKey: point it at this route and the whole chain
 * runs - dispatch, worktree, turn, stream, drain, finish - with nothing secret
 * anywhere in it.
 *
 * WHAT THIS IS NOT. It is not a bee thinking. Nothing here reads the issue,
 * chooses an approach, or writes code; the reply is scripted. It proves the
 * PLUMBING carries a turn from the tick to a finished dispatch, and that is
 * precisely the part that had never run. Any claim beyond that would be the
 * kind of claim this repository keeps having to retract.
 *
 * Off unless TRIOS_QUEEN_REHEARSAL is set. A deployment that has a real key
 * must never quietly rehearse instead of working.
 */

import { Hono } from 'hono'
import { logger } from '../../lib/logger'

/**
 * The OpenAI chat-completions shape, streamed.
 *
 * `createOpenAICompatible` POSTs to `{baseUrl}/chat/completions` and reads
 * `data:` frames with `choices[0].delta`. The final frame must be `[DONE]` or
 * the client waits for a stream that has already ended - which reads, from the
 * outside, exactly like a bee that hung.
 */
export function createQueenRehearsalRoute() {
  return new Hono().post('/chat/completions', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const model = typeof body?.model === 'string' ? body.model : 'rehearsal'
    logger.info('Queen rehearsal turn', { model })

    const reply = [
      'Rehearsal turn. This reply came from a recorded stream inside the',
      'container, not from a model: the deployment holds no provider',
      'credential, and this route exists so the dispatch chain can be proven',
      'without one. Nothing was read and nothing was decided.',
    ].join(' ')

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const frame = (delta: Record<string, unknown>, finish?: string) =>
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: 'rehearsal',
                object: 'chat.completion.chunk',
                created: 0,
                model,
                choices: [{ index: 0, delta, finish_reason: finish ?? null }],
              })}\n\n`,
            ),
          )

        frame({ role: 'assistant', content: '' })
        // In pieces, because a single frame would not exercise the caller's
        // accumulation path - and accumulation is where a real stream breaks.
        for (const word of reply.split(' ')) frame({ content: `${word} ` })
        frame({}, 'stop')
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })
}
