/**
 * Contract suite for useSurveyChat.ts. The module has exactly one runtime
 * export — useChat — and this suite pins the behaviour that exists today:
 * initial state, the start/respond/stop/reset surface, the requests the hook
 * sends to the interview API, SSE stream assembly (including deltas split
 * across read boundaries), the completion marker, error paths and aborting.
 *
 * The remote interview API is faked with a fetch stub; the suite needs no
 * network, no database and no container. React is driven through a tiny
 * renderHook-style harness that implements just useState and useRef, which
 * are the only hooks the subject calls.
 *
 * Nothing was left unpinned for lack of a dependency: the single runtime
 * export of the module is exercised end to end below. (The BrowserOS pref
 * API is absent outside the extension, and the hook degrades by sending an
 * empty install id — that fallback is pinned rather than mocked away.)
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { useChat } from './useSurveyChat'

type ChatApi = ReturnType<typeof useChat>

const encoder = new TextEncoder()

const CLIENT_INTERNALS_KEY =
  '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'

type DispatcherHost = { H: unknown }

const reactSharedInternals = (
  React as unknown as Record<string, DispatcherHost | undefined>
)[CLIENT_INTERNALS_KEY]

if (!reactSharedInternals) {
  throw new Error(
    'React does not expose its client internals; the hook cannot be driven without a DOM renderer',
  )
}

/**
 * Minimal renderHook-style driver. Re-renders the hook synchronously after
 * every state update, mirroring how a real renderer would surface new state
 * to the component. Functional updates are applied exactly like React does.
 */
function mountHook<T>(hookFn: () => T): { api: () => T } {
  const stateCells: Array<{ value: unknown }> = []
  const refCells: Array<{ current: unknown }> = []
  let stateCursor = 0
  let refCursor = 0
  let rendering = false
  let latest: T

  const render = (): T => {
    stateCursor = 0
    refCursor = 0
    rendering = true
    const previousDispatcher = reactSharedInternals.H
    reactSharedInternals.H = dispatcher
    try {
      latest = hookFn()
    } finally {
      reactSharedInternals.H = previousDispatcher
      rendering = false
    }
    return latest
  }

  const dispatcher = {
    useState<S>(
      initial: S | (() => S),
    ): [S, (update: S | ((prev: S) => S)) => void] {
      const index = stateCursor
      stateCursor += 1
      if (index === stateCells.length) {
        const seed =
          typeof initial === 'function' ? (initial as () => S)() : initial
        stateCells.push({ value: seed })
      }
      const cell = stateCells[index]
      const setState = (update: S | ((prev: S) => S)): void => {
        cell.value =
          typeof update === 'function'
            ? (update as (prev: S) => S)(cell.value as S)
            : update
        if (!rendering) {
          render()
        }
      }
      return [cell.value as S, setState]
    },
    useRef<S>(initial: S): { current: S } {
      const index = refCursor
      refCursor += 1
      if (index === refCells.length) {
        refCells.push({ current: initial })
      }
      return refCells[index] as { current: S }
    },
  }

  render()
  return { api: () => latest }
}

const mountChat = (options?: Parameters<typeof useChat>[0]) =>
  mountHook(() => useChat(options))

type RecordedRequest = {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal | null | undefined
}

type ResponsePlan = {
  ok: boolean
  status: number
  sessionHeader: string | null
  chunks: Array<string | 'HANG'>
}

const streamingResponse = (
  chunks: Array<string | 'HANG'>,
  sessionHeader = 'sess-1',
): ResponsePlan => ({
  ok: true,
  status: 200,
  sessionHeader,
  chunks,
})

const failedResponse = (status: number): ResponsePlan => ({
  ok: false,
  status,
  sessionHeader: null,
  chunks: [],
})

const textDeltaLine = (delta: string): string =>
  `data: ${JSON.stringify({ type: 'text-delta', delta })}\n`
const completeLine = 'data: {"type":"interview_complete"}\n'
const doneLine = 'data: [DONE]\n'
const errorLine = (errorText: string): string =>
  `data: ${JSON.stringify({ type: 'error', errorText })}\n`

function makeReader(chunks: Array<string | 'HANG'>, signal?: AbortSignal) {
  let index = 0
  return {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (index >= chunks.length) {
        return { done: true }
      }
      const chunk = chunks[index]
      index += 1
      if (chunk === 'HANG') {
        return new Promise<{ done: boolean; value?: Uint8Array }>(
          (_resolve, reject) => {
            const abortWith = () => {
              const err = new Error('The operation was aborted')
              err.name = 'AbortError'
              reject(err)
            }
            if (signal?.aborted) {
              abortWith()
            } else {
              signal?.addEventListener('abort', abortWith, { once: true })
            }
          },
        )
      }
      return { done: false, value: encoder.encode(chunk) }
    },
    releaseLock() {},
  }
}

function stubFetch(): {
  requests: RecordedRequest[]
  respondWith: (plan: ResponsePlan) => void
  restore: () => void
} {
  const originalFetch = globalThis.fetch
  const requests: RecordedRequest[] = []
  let nextPlan: ResponsePlan = failedResponse(500)
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (init.body as string) : '',
      signal: init?.signal,
    }
    requests.push(request)
    const plan = nextPlan
    return {
      ok: plan.ok,
      status: plan.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'x-interview-session-id'
            ? plan.sessionHeader
            : null,
      },
      body: {
        getReader: () => makeReader(plan.chunks, request.signal ?? undefined),
      },
    } as unknown as Response
  }) as typeof fetch
  return {
    requests,
    respondWith: (plan) => {
      nextPlan = plan
    },
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

const transcript = (api: ChatApi): Array<string> =>
  api.messages.map((message) => `${message.role}:${message.content}`)

describe('useSurveyChatContract', () => {
  it('useChat: pins the observable behaviour of the only export of useSurveyChat', async () => {
    const server = stubFetch()
    try {
      // A fresh hook starts idle: no messages, no error, nothing streaming.
      const idle = mountChat()
      expect(idle.api().phase).toBe('idle')
      expect(idle.api().messages).toEqual([])
      expect(idle.api().isStreaming).toBe(false)
      expect(idle.api().error).toBeNull()

      // start() immediately turns active, opens an empty assistant bubble and
      // requests an interview; deltas that arrive split across read
      // boundaries are assembled into that bubble, and streaming ends clean.
      server.respondWith(
        streamingResponse([
          'data: {"type":"text-del',
          'ta","delta":"Hello"}\ndata: {"type":"text-delta","delta":" world"}\n',
          doneLine,
        ]),
      )
      const openingPromise = idle.api().start()
      const opening = idle.api()
      expect(opening.phase).toBe('active')
      expect(opening.isStreaming).toBe(true)
      expect(transcript(opening)).toEqual(['assistant:'])
      await openingPromise
      const afterStart = idle.api()
      expect(transcript(afterStart)).toEqual(['assistant:Hello world'])
      expect(afterStart.phase).toBe('active')
      expect(afterStart.isStreaming).toBe(false)
      expect(afterStart.error).toBeNull()
      expect(server.requests.length).toBe(1)
      const startRequest = server.requests[0]
      expect(startRequest.url).toBe(
        'https://jtbd-agent.fly.dev/api/interview/start',
      )
      expect(startRequest.method).toBe('POST')
      expect(startRequest.headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(startRequest.body)).toEqual({
        installId: '',
        experimentId: 'default',
        maxTurns: 20,
      })

      // respond() records the answer on the session from the response header,
      // streams the reply into a new assistant bubble, and the completion
      // event finishes the interview without leaking its marker into the
      // transcript.
      server.respondWith(
        streamingResponse([
          textDeltaLine('Got'),
          textDeltaLine(' it.'),
          completeLine,
          doneLine,
        ]),
      )
      await idle.api().respond('my answer')
      const afterRespond = idle.api()
      expect(transcript(afterRespond)).toEqual([
        'assistant:Hello world',
        'user:my answer',
        'assistant:Got it.',
      ])
      expect(afterRespond.phase).toBe('completed')
      expect(afterRespond.isStreaming).toBe(false)
      expect(afterRespond.error).toBeNull()
      expect(
        afterRespond.messages.every(
          (message) => !message.content.includes('__INTERVIEW_COMPLETE__'),
        ),
      ).toBe(true)
      const allIds = afterRespond.messages.map((message) => message.id)
      expect(allIds.every((id) => id.length > 0)).toBe(true)
      expect(new Set(allIds).size).toBe(allIds.length)
      const respondRequest = server.requests[1]
      expect(respondRequest.url).toBe(
        'https://jtbd-agent.fly.dev/api/interview/sess-1/respond',
      )
      expect(respondRequest.method).toBe('POST')
      expect(JSON.parse(respondRequest.body)).toEqual({
        response: 'my answer',
        maxTurns: 20,
      })

      // reset() clears transcript, error and phase, and forgets the session:
      // a later answer is dropped without touching the network.
      idle.api().reset()
      const afterReset = idle.api()
      expect(afterReset.phase).toBe('idle')
      expect(afterReset.messages).toEqual([])
      expect(afterReset.error).toBeNull()
      const requestsBefore = server.requests.length
      await afterReset.respond('ignored')
      expect(server.requests.length).toBe(requestsBefore)
      expect(transcript(idle.api())).toEqual([])

      // Without a started session, respond() is a silent no-op.
      const orphan = mountChat()
      await orphan.api().respond('nowhere')
      expect(server.requests.length).toBe(requestsBefore)
      expect(transcript(orphan.api())).toEqual([])
      expect(orphan.api().phase).toBe('idle')

      // A start that the server rejects surfaces the status as an error and
      // leaves the placeholder bubble in the transcript.
      const failing = mountChat()
      server.respondWith(failedResponse(503))
      await failing.api().start()
      const afterFailure = failing.api()
      expect(afterFailure.error?.message).toBe('Failed to start interview: 503')
      expect(afterFailure.phase).toBe('error')
      expect(afterFailure.isStreaming).toBe(false)
      expect(transcript(afterFailure)).toEqual(['assistant:'])

      // A start response that carries no session id header is refused before
      // any streaming happens.
      const headerless = mountChat()
      server.respondWith({
        ok: true,
        status: 200,
        sessionHeader: null,
        chunks: [],
      })
      await headerless.api().start()
      const afterHeaderless = headerless.api()
      expect(afterHeaderless.error?.message).toBe(
        'No session ID returned from server',
      )
      expect(afterHeaderless.phase).toBe('error')
      expect(afterHeaderless.isStreaming).toBe(false)

      // A respond that the server rejects keeps the user's answer on record
      // together with the empty reply bubble and reports the status.
      const brokenReply = mountChat()
      server.respondWith(streamingResponse([doneLine], 'sess-2'))
      await brokenReply.api().start()
      server.respondWith(failedResponse(500))
      await brokenReply.api().respond('try me')
      const afterBrokenReply = brokenReply.api()
      expect(afterBrokenReply.error?.message).toBe('Failed to respond: 500')
      expect(afterBrokenReply.phase).toBe('error')
      expect(afterBrokenReply.isStreaming).toBe(false)
      expect(transcript(afterBrokenReply)).toEqual([
        'assistant:',
        'user:try me',
        'assistant:',
      ])

      // An error event on the stream fails the interview with the server's
      // own text while keeping whatever streamed before the failure.
      const exploding = mountChat()
      server.respondWith(
        streamingResponse([
          textDeltaLine('partial'),
          errorLine('agent exploded'),
          doneLine,
        ]),
      )
      await exploding.api().start()
      const afterExplosion = exploding.api()
      expect(afterExplosion.error?.message).toBe('agent exploded')
      expect(afterExplosion.phase).toBe('error')
      expect(afterExplosion.isStreaming).toBe(false)
      expect(transcript(afterExplosion)).toEqual(['assistant:partial'])

      // stop() aborts the in-flight request: the stalled stream ends without
      // an error, streaming stops immediately, and the phase stays active.
      const stalled = mountChat()
      server.respondWith(streamingResponse(['HANG'], 'sess-3'))
      const stalledPromise = stalled.api().start()
      expect(stalled.api().isStreaming).toBe(true)
      stalled.api().stop()
      expect(stalled.api().isStreaming).toBe(false)
      await stalledPromise
      const afterStop = stalled.api()
      expect(afterStop.error).toBeNull()
      expect(afterStop.phase).toBe('active')
      expect(afterStop.isStreaming).toBe(false)
      expect(transcript(afterStop)).toEqual(['assistant:'])
      expect(server.requests.at(-1)?.signal?.aborted).toBe(true)

      // Caller options flow into the start request unchanged.
      const tuned = mountChat({ maxTurns: 3, experimentId: 'beta' })
      server.respondWith(streamingResponse([doneLine], 'sess-4'))
      await tuned.api().start()
      const tunedRequest = server.requests.at(-1)
      expect(tunedRequest?.url).toBe(
        'https://jtbd-agent.fly.dev/api/interview/start',
      )
      expect(JSON.parse(tunedRequest?.body ?? '')).toEqual({
        installId: '',
        experimentId: 'beta',
        maxTurns: 3,
      })
    } finally {
      server.restore()
    }
  })
})
