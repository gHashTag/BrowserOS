import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import {
  readZaiPlanHealth,
  ZAI_CODING_USAGE_URL,
  type ZaiPlanHealth,
} from '../../src/api/services/zai-plan-health'
import { logger } from '../../src/lib/logger'

/**
 * The provider, answering what the provider would - through an injected fetch.
 *
 * These tests never touch the real Z.ai service. Every response below is
 * planted, including the official success shape, so a red test names THIS
 * code's defect rather than the provider's mood. The one thing they take from
 * the outside world is the URL the request is aimed at, asserted against the
 * constant rather than copied into it.
 */

/** A secret that must never survive into a result or a log line. */
const PLANTED_KEY = 'zai-sk-planted-do-not-print-5f2a9c'

const FIXED_NOW = new Date('2026-08-30T12:00:00.000Z')
const fixedClock = () => new Date(FIXED_NOW.getTime())

/** The documented monitor success envelope, tier and quota included. */
function officialSuccess(
  overrides: {
    data?: Record<string, unknown>
    envelope?: Record<string, unknown>
  } = {},
) {
  return {
    timestamp: '2026-08-30T10:00:00.000+00:00',
    code: 200,
    msg: 'OK',
    success: true,
    data: {
      code: 'SUCCESS',
      message: 'success',
      requestId: 'req-9f2c88a1',
      success: true,
      subscriptionTier: 'Lite',
      startTime: 1_753_091_669_000,
      expireTime: 1_755_769_909_000,
      resource: {
        createdAt: 1_753_091_669_000,
        total: 120,
        remaining: 118.4,
        used: 1.6,
        unit: 'credits',
      },
      usage: {
        promptTokens: 12_345,
        completionTokens: 6_789,
        totalTokens: 19_134,
      },
      subscription: { tier: 'Lite', deviceUsed: 2, deviceLimit: 5 },
      ...overrides.data,
    },
    ...overrides.envelope,
  }
}

/** Every outbound call the injected fetch received, in order. */
type RecordedCall = { input: unknown; init: RequestInit | undefined }

function respondingFetch(
  respond: (call: RecordedCall) => Promise<Response> | Response,
): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const call = { input, init }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/**
 * Capture every log line the service writes, at every level it can write.
 *
 * The assertions on these entries are the whole point of the secret tests: a
 * result can be inspected by eye, but the log line is what ends up on a disk
 * an operator greps. Swapping the methods on the shared instance follows the
 * pattern queen-dispatch.test.ts established.
 */
function captureLogs() {
  const entries: Array<{ message: string; meta?: Record<string, unknown> }> = []
  const originals = {
    info: logger.info.bind(logger),
    warn: logger.warn.bind(logger),
    error: logger.error.bind(logger),
  }
  const record = (message: string, meta?: Record<string, unknown>) => {
    entries.push({ message, meta })
  }
  logger.info = record
  logger.warn = record
  logger.error = record
  return {
    entries,
    restore: () => {
      logger.info = originals.info
      logger.warn = originals.warn
      logger.error = originals.error
    },
  }
}

/**
 * One read with a planted credential and a deterministic clock, plus the
 * captured log lines the read produced. Restores the logger either way, so a
 * failing assertion cannot leave the suite's logger patched.
 */
async function read(
  respond: (call: RecordedCall) => Promise<Response> | Response,
  timeoutMs = 500,
): Promise<{ result: ZaiPlanHealth; calls: RecordedCall[]; logs: string[] }> {
  const { fetch, calls } = respondingFetch(respond)
  const captured = captureLogs()
  try {
    const result = await readZaiPlanHealth({
      apiKey: PLANTED_KEY,
      fetchImpl: fetch,
      now: fixedClock,
      timeoutMs,
    })
    return {
      result,
      calls,
      logs: captured.entries.map((entry) => JSON.stringify(entry)),
    }
  } finally {
    captured.restore()
  }
}

/**
 * The planted secret must be absent from a serialization of the result and of
 * every captured log argument, for every scenario this helper wraps.
 */
function expectSecretAbsent(result: ZaiPlanHealth, logs: string[]) {
  const serialized = JSON.stringify(result)
  expect(serialized.includes(PLANTED_KEY)).toBe(false)
  for (const line of logs) {
    expect(line.includes(PLANTED_KEY)).toBe(false)
  }
  // An empty capture would make every absence assertion above vacuous.
  expect(logs.length).toBeGreaterThan(0)
}

beforeAll(() => {
  // A real key sitting in the runner's environment must not reach any
  // assertion below, and the missing-credential case must see a truly empty
  // environment rather than whatever the operator's shell exports.
  delete process.env.ZAI_API_KEY
})

afterEach(() => {
  delete process.env.ZAI_API_KEY
})

describe('zai plan health', () => {
  describe('a successful official monitor response', () => {
    it('aims one authenticated GET at the official endpoint', async () => {
      const { calls } = await read(() => jsonResponse(officialSuccess()))
      expect(calls.length).toBe(1)
      expect(calls[0].input).toBe(ZAI_CODING_USAGE_URL)
      expect(calls[0].init?.method).toBe('GET')
      // Positive control for every absence assertion below: the planted key
      // IS flowing through this code path, in the header and nowhere else.
      expect(calls[0].init?.headers).toEqual({
        Authorization: `Bearer ${PLANTED_KEY}`,
        Accept: 'application/json',
      })
    })

    it('reports only plan level, usage percent, reset time, observed time', async () => {
      const { result } = await read(() => jsonResponse(officialSuccess()))
      expect(result).toEqual({
        status: 'healthy',
        planLevel: 'lite',
        // 1.6 of 120 credits = 1.33%, rounded to a bounded integer.
        usagePercent: 1,
        resetsAt: new Date(1_755_769_909_000).toISOString(),
        observedAt: FIXED_NOW.toISOString(),
      })
      // The allowlist is a closed set: nothing else may ride along.
      expect(Object.keys(result).sort()).toEqual([
        'observedAt',
        'planLevel',
        'resetsAt',
        'status',
        'usagePercent',
      ])
    })

    it('rounds fractional usage to an integer percentage', async () => {
      const { result } = await read(() =>
        jsonResponse(
          officialSuccess({
            data: { resource: { total: 3, used: 1, remaining: 2 } },
          }),
        ),
      )
      expect(result).toEqual({
        status: 'healthy',
        planLevel: 'lite',
        usagePercent: 33,
        resetsAt: new Date(1_755_769_909_000).toISOString(),
        observedAt: FIXED_NOW.toISOString(),
      })
    })

    it('falls back to used+remaining when total is absent or zero', async () => {
      const noTotal = await read(() =>
        jsonResponse(
          officialSuccess({
            data: { resource: { remaining: 30, used: 30 } },
          }),
        ),
      )
      expect(noTotal.result.status).toBe('healthy')
      if (noTotal.result.status === 'healthy') {
        expect(noTotal.result.usagePercent).toBe(50)
      }

      const zeroTotal = await read(() =>
        jsonResponse(
          officialSuccess({
            data: { resource: { total: 0, remaining: 0, used: 10 } },
          }),
        ),
      )
      expect(zeroTotal.result.status).toBe('unavailable')
      if (zeroTotal.result.status === 'unavailable') {
        expect(zeroTotal.result.reason).toBe('invalid-payload')
      }
    })

    it('accepts numbers reported as strings', async () => {
      const { result } = await read(() =>
        jsonResponse(
          officialSuccess({
            data: {
              subscriptionTier: 'Max',
              expireTime: '1755769909000',
              resource: { total: '200', used: '84', remaining: '116' },
            },
          }),
        ),
      )
      expect(result.status).toBe('healthy')
      if (result.status === 'healthy') {
        expect(result.planLevel).toBe('max')
        expect(result.usagePercent).toBe(42)
      }
    })

    it('keeps the planted key out of the result and the log line', async () => {
      const { result, logs } = await read(() => jsonResponse(officialSuccess()))
      expectSecretAbsent(result, logs)
    })
  })

  describe('usage percentages are clamped, never invented', () => {
    it('clamps usage above 100 down to 100', async () => {
      const { result } = await read(() =>
        jsonResponse(
          officialSuccess({
            data: { resource: { total: 100, used: 150, remaining: 0 } },
          }),
        ),
      )
      expect(result.status).toBe('healthy')
      if (result.status === 'healthy') {
        expect(Number.isInteger(result.usagePercent)).toBe(true)
        expect(result.usagePercent).toBe(100)
      }
    })

    it('clamps negative usage up to 0', async () => {
      const { result } = await read(() =>
        jsonResponse(
          officialSuccess({
            data: { resource: { total: 100, used: -40, remaining: 140 } },
          }),
        ),
      )
      expect(result.status).toBe('healthy')
      if (result.status === 'healthy') {
        expect(result.usagePercent).toBe(0)
      }
    })

    it('clamps an absurd but finite ratio to 100', async () => {
      const { result } = await read(() =>
        jsonResponse(
          officialSuccess({
            data: { resource: { total: 1, used: 1e15, remaining: 0 } },
          }),
        ),
      )
      expect(result.status).toBe('healthy')
      if (result.status === 'healthy') {
        expect(result.usagePercent).toBe(100)
      }
    })

    it('refuses non-finite numbers rather than clamping them', async () => {
      // NaN and Infinity are not "a lot"; they are nothing, and clamping
      // nothing yields a confident number out of no data. JSON cannot carry
      // a bare NaN, so the string form is what a broken provider sends.
      const notANumber = await read(() =>
        jsonResponse(
          officialSuccess({
            data: { resource: { total: 100, used: 'NaN', remaining: 0 } },
          }),
        ),
      )
      expect(notANumber.result.status).toBe('unavailable')
      if (notANumber.result.status === 'unavailable') {
        expect(notANumber.result.reason).toBe('invalid-payload')
      }

      const infinite = await read(() =>
        jsonResponse(
          officialSuccess({
            data: { resource: { total: 100, used: 'Infinity', remaining: 0 } },
          }),
        ),
      )
      expect(infinite.result.status).toBe('unavailable')

      const missingResource = await read(() =>
        jsonResponse(officialSuccess({ data: { resource: null } })),
      )
      expect(missingResource.result.status).toBe('unavailable')
      if (missingResource.result.status === 'unavailable') {
        expect(missingResource.result.reason).toBe('invalid-payload')
      }
    })
  })

  describe('failure reads fail closed as unavailable', () => {
    it('reports timeout when the response never arrives', async () => {
      // A fetch that ignores the abort signal and never settles: only the
      // service's own deadline can end this read, which is the bound FR-005
      // demands. A test that hangs here is the failure it is looking for.
      const neverSettles = () => new Promise<Response>(() => {})
      const { result, calls, logs } = await read(neverSettles, 25)
      expect(result.status).toBe('unavailable')
      if (result.status === 'unavailable') {
        expect(result.reason).toBe('timeout')
        expect(result.observedAt).toBe(FIXED_NOW.toISOString())
      }
      expect(calls.length).toBe(1)
      expectSecretAbsent(result, logs)
    })

    it('reports timeout when the fetch honors the abort signal slowly', async () => {
      const hangsUntilAbort = (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error(`aborted with ${PLANTED_KEY} in the message`)),
          )
        })
      const recorder = respondingFetch((call) =>
        hangsUntilAbort(call.input, call.init),
      )
      const captured = captureLogs()
      let result: ZaiPlanHealth
      try {
        result = await readZaiPlanHealth({
          apiKey: PLANTED_KEY,
          fetchImpl: recorder.fetch,
          now: fixedClock,
          timeoutMs: 25,
        })
      } finally {
        captured.restore()
      }
      expect(result.status).toBe('unavailable')
      if (result.status === 'unavailable') {
        expect(result.reason).toBe('timeout')
      }
      expect(recorder.calls.length).toBe(1)
      const serialized = JSON.stringify(result)
      expect(serialized.includes(PLANTED_KEY)).toBe(false)
      for (const entry of captured.entries) {
        expect(JSON.stringify(entry).includes(PLANTED_KEY)).toBe(false)
      }
    })

    it('reports transport when the request itself fails', async () => {
      // The rejection's message deliberately quotes the planted key: the
      // catch must discard the error object wholesale, not relay its text.
      const { result, calls, logs } = await read(() =>
        Promise.reject(new Error(`socket reset while sending ${PLANTED_KEY}`)),
      )
      expect(result.status).toBe('unavailable')
      if (result.status === 'unavailable') {
        expect(result.reason).toBe('transport')
      }
      expect(calls.length).toBe(1)
      expectSecretAbsent(result, logs)
    })

    it('reports http-status on a non-2xx answer, echoing nothing back', async () => {
      // The 429 body quotes the credential back, as some gateways do. The
      // read must drop the body unread and say only "http-status".
      const { result, calls, logs } = await read(() =>
        jsonResponse(
          {
            code: 429,
            message: `rate limited for ${PLANTED_KEY}`,
            success: false,
          },
          429,
        ),
      )
      expect(result.status).toBe('unavailable')
      if (result.status === 'unavailable') {
        expect(result.reason).toBe('http-status')
      }
      expect(calls.length).toBe(1)
      expectSecretAbsent(result, logs)
    })

    it('reports invalid-payload on malformed JSON', async () => {
      const { result, calls, logs } = await read(
        () =>
          new Response(`{"data":{"subscriptionTier":"lite",${PLANTED_KEY}`, {
            status: 200,
          }),
      )
      expect(result.status).toBe('unavailable')
      if (result.status === 'unavailable') {
        expect(result.reason).toBe('invalid-payload')
      }
      expect(calls.length).toBe(1)
      expectSecretAbsent(result, logs)
    })

    it('reports invalid-payload on a 200 whose business envelope says failure', async () => {
      const { result } = await read(() =>
        jsonResponse(officialSuccess({ envelope: { success: false } })),
      )
      expect(result.status).toBe('unavailable')
      if (result.status === 'unavailable') {
        expect(result.reason).toBe('invalid-payload')
      }
    })

    it('reports invalid-payload when the documented fields are absent or alien', async () => {
      const noData = await read(() => jsonResponse({ success: true }))
      expect(noData.result.status).toBe('unavailable')

      const noTier = await read(() =>
        jsonResponse(
          officialSuccess({ data: { subscriptionTier: undefined } }),
        ),
      )
      expect(noTier.result.status).toBe('unavailable')

      // A tier outside the bounded pattern is refused, not passed through:
      // a freeform string from the provider is a channel to the logs.
      const alienTier = await read(() =>
        jsonResponse(
          officialSuccess({ data: { subscriptionTier: '../../etc/passwd' } }),
        ),
      )
      expect(alienTier.result.status).toBe('unavailable')

      const noExpiry = await read(() =>
        jsonResponse(officialSuccess({ data: { expireTime: 'not-a-time' } })),
      )
      expect(noExpiry.result.status).toBe('unavailable')
    })

    it('reports missing-credential without requesting anything', async () => {
      const recorder = respondingFetch(() => jsonResponse(officialSuccess()))
      const captured = captureLogs()
      let result: ZaiPlanHealth
      try {
        result = await readZaiPlanHealth({
          apiKey: '',
          fetchImpl: recorder.fetch,
          now: fixedClock,
        })
      } finally {
        captured.restore()
      }
      expect(result.status).toBe('unavailable')
      if (result.status === 'unavailable') {
        expect(result.reason).toBe('missing-credential')
      }
      // Zero requests: a read with nothing to authenticate sends nothing.
      expect(recorder.calls.length).toBe(0)
      const entry = captured.entries[0]
      expect(entry).toBeDefined()
      expect(JSON.stringify(entry).includes(PLANTED_KEY)).toBe(false)
    })
  })

  describe('unexpected provider fields never survive the parser', () => {
    it('discards every field outside the allowlist', async () => {
      const { result, logs } = await read(() =>
        jsonResponse(
          officialSuccess({
            data: {
              requestId: 'req-unexpected',
              internalApiKey: PLANTED_KEY,
              bearer: `Bearer ${PLANTED_KEY}`,
              usage: {
                promptTokens: 999_999,
                completionTokens: 999_999,
                totalTokens: 1_999_998,
              },
              subscription: {
                tier: 'Lite',
                billingContact: PLANTED_KEY,
              },
            },
          }),
        ),
      )
      expect(result.status).toBe('healthy')
      const serialized = JSON.stringify(result)
      expect(serialized.includes(PLANTED_KEY)).toBe(false)
      // Field names the allowlist does not know, and their values, are gone.
      for (const gone of [
        'requestId',
        'internalApiKey',
        'bearer',
        'promptTokens',
        'completionTokens',
        'subscription',
        'billingContact',
        'unit',
        'credits',
      ]) {
        expect(serialized.includes(gone)).toBe(false)
      }
      expectSecretAbsent(result, logs)
    })
  })

  describe('one bounded request per explicit read', () => {
    it('makes exactly one request per read and none between reads', async () => {
      const recorder = respondingFetch(() => jsonResponse(officialSuccess()))
      const first = await readZaiPlanHealth({
        apiKey: PLANTED_KEY,
        fetchImpl: recorder.fetch,
        now: fixedClock,
      })
      expect(first.status).toBe('healthy')
      expect(recorder.calls.length).toBe(1)

      // A second read re-requests rather than serving a cached verdict: a
      // scheduler reading again does so because time has passed.
      const second = await readZaiPlanHealth({
        apiKey: PLANTED_KEY,
        fetchImpl: recorder.fetch,
        now: fixedClock,
      })
      expect(second.status).toBe('healthy')
      expect(recorder.calls.length).toBe(2)
    })

    it('makes no second request after a failure - unavailable, not retry', async () => {
      let attempts = 0
      const recorder = respondingFetch(() => {
        attempts += 1
        return jsonResponse({ success: false }, 503)
      })
      const result = await readZaiPlanHealth({
        apiKey: PLANTED_KEY,
        fetchImpl: recorder.fetch,
        now: fixedClock,
      })
      expect(result.status).toBe('unavailable')
      expect(attempts).toBe(1)
      expect(recorder.calls.length).toBe(1)
    })
  })
})
