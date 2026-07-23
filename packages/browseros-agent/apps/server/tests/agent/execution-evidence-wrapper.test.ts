import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ToolExecutionOptions, type ToolSet, tool } from 'ai'
import { z } from 'zod'
import { instrumentExternalMcpTools } from '../../src/agent/ai-sdk-agent'
import {
  digestForReliabilityDecision,
  MutableToolEvidenceSinkRelay,
  resolveToolReliabilityDescriptor,
  type ToolReliabilityDescriptor,
  wrapToolSetWithEvidence,
} from '../../src/agent/execution-evidence'
import type { EvidenceEvent } from '../../src/agent/execution-types'
import { metrics } from '../../src/lib/metrics'
import { createWriteTool } from '../../src/tools/filesystem/write'

type RuntimeExecute = (input: unknown, options: ToolExecutionOptions) => unknown

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

function executeOf(tools: ToolSet, name: string): RuntimeExecute {
  const execute = tools[name]?.execute
  if (typeof execute !== 'function') {
    throw new Error(`Expected executable tool: ${name}`)
  }
  return execute as RuntimeExecute
}

function executionOptions(
  toolCallId: string,
  abortSignal?: AbortSignal,
): ToolExecutionOptions {
  return { toolCallId, messages: [], abortSignal }
}

const writeDescriptor = (): ToolReliabilityDescriptor =>
  resolveToolReliabilityDescriptor('filesystem_write', {
    kind: 'filesystem',
  })

describe('tool evidence wrapper hardening', () => {
  it('marks a real pre-aborted filesystem write as started with an unknown effect', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'browseros-evidence-pre-abort-'),
    )
    tempDirectories.push(directory)
    const events: EvidenceEvent[] = []
    const abortController = new AbortController()
    abortController.abort(new Error('cancel before dispatch'))
    const wrapped = wrapToolSetWithEvidence(
      { filesystem_write: createWriteTool(directory) },
      {
        evidenceSink: { record: (event) => events.push(event) },
        describeTool: writeDescriptor,
      },
    )

    await executeOf(wrapped, 'filesystem_write')(
      { path: 'created.txt', content: 'written despite pre-abort' },
      executionOptions('pre-aborted-write', abortController.signal),
    )

    expect(await readFile(join(directory, 'created.txt'), 'utf8')).toBe(
      'written despite pre-abort',
    )
    expect(events.at(-1)?.result).toMatchObject({
      executionStatus: 'aborted',
      effectStatus: 'unknown',
    })
  })

  it('dispatches immediately through an unset relay without observing hostile input', () => {
    let descriptorCalls = 0
    let proxyTraps = 0
    const hostileInput = new Proxy(
      {},
      {
        ownKeys: () => {
          proxyTraps += 1
          throw new Error('observation must not inspect input')
        },
      },
    )
    const source = {
      passthrough: tool({
        description: 'passthrough',
        inputSchema: z.unknown(),
        execute: (input) => input,
      }),
    } satisfies ToolSet
    const relay = new MutableToolEvidenceSinkRelay()
    const wrapped = wrapToolSetWithEvidence(source, {
      evidenceSink: relay,
      describeTool: () => {
        descriptorCalls += 1
        return writeDescriptor()
      },
    })

    const output = executeOf(wrapped, 'passthrough')(
      hostileInput,
      executionOptions('unset-relay'),
    )

    expect(output).toBe(hostileInput)
    expect(descriptorCalls).toBe(0)
    expect(proxyTraps).toBe(0)
  })

  it('observes an inherited execute data method with the original call receiver', () => {
    const output = { ok: true }
    const receiver = { receiver: true }
    let actualReceiver: unknown
    const sourceTool = Object.assign(
      Object.create({
        execute(this: unknown) {
          actualReceiver = this
          return output
        },
      }) as object,
      tool({
        description: 'inherited execute',
        inputSchema: z.unknown(),
      }),
    ) as ToolSet[string]
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      { inherited: sourceTool },
      {
        evidenceSink: { record: (event) => events.push(event) },
        describeTool: writeDescriptor,
      },
    )

    const actual = executeOf(wrapped, 'inherited').call(
      receiver,
      {},
      executionOptions('inherited-execute'),
    )

    expect(actual).toBe(output)
    expect(actualReceiver).toBe(receiver)
    expect(events.map((event) => event.kind)).toEqual(['requested', 'settled'])
  })

  it.each([
    'own',
    'inherited',
  ] as const)('observes an %s execute accessor at normal lookup time', (placement) => {
    const output = { placement }
    const lookupReceiver = { lookup: placement }
    const callReceiver = { call: placement }
    const getterError = new Error(`${placement} getter error`)
    let getterCalls = 0
    let actualLookupReceiver: unknown
    let actualCallReceiver: unknown
    let shouldThrow = false
    const executeDescriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: true,
      get(this: unknown) {
        getterCalls += 1
        actualLookupReceiver = this
        if (shouldThrow) {
          throw getterError
        }
        return function (this: unknown) {
          actualCallReceiver = this
          return output
        }
      },
    }
    const base = tool({
      description: 'accessor execute',
      inputSchema: z.unknown(),
    })
    const sourceTool =
      placement === 'own'
        ? Object.defineProperty(base, 'execute', executeDescriptor)
        : Object.assign(
            Object.create(
              Object.defineProperty({}, 'execute', executeDescriptor),
            ) as object,
            base,
          )
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      { accessor: sourceTool as ToolSet[string] },
      {
        evidenceSink: { record: (event) => events.push(event) },
        describeTool: writeDescriptor,
      },
    )
    const wrappedTool = wrapped.accessor as {
      execute?: RuntimeExecute
    }

    expect(getterCalls).toBe(0)
    const execute = Reflect.get(wrappedTool, 'execute', lookupReceiver)
    expect(getterCalls).toBe(1)
    expect(actualLookupReceiver).toBe(lookupReceiver)
    expect(
      (execute as RuntimeExecute).call(
        callReceiver,
        {},
        executionOptions(`${placement}-accessor`),
      ),
    ).toBe(output)
    expect(actualCallReceiver).toBe(callReceiver)
    expect(events.map((event) => event.kind)).toEqual(['requested', 'settled'])

    shouldThrow = true
    expect(() => Reflect.get(wrappedTool, 'execute', lookupReceiver)).toThrow(
      getterError,
    )
  })

  it('uses normal async-iterator accessor lookup and preserves stream cancellation', async () => {
    const first = { chunk: 1 }
    const second = { chunk: 2 }
    let iteratorLookups = 0
    let sourceCancelled = 0
    const output = Object.defineProperty({}, Symbol.asyncIterator, {
      configurable: true,
      get: () => {
        iteratorLookups += 1
        return async function* () {
          try {
            yield first
            yield second
          } finally {
            sourceCancelled += 1
          }
        }
      },
    })
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        stream: tool({
          description: 'accessor stream',
          inputSchema: z.unknown(),
          execute: () => output,
        }),
      },
      {
        evidenceSink: { record: (event) => events.push(event) },
        describeTool: writeDescriptor,
      },
    )

    const stream = executeOf(wrapped, 'stream')(
      {},
      executionOptions('accessor-stream'),
    ) as AsyncIterable<unknown>
    expect(events.map((event) => event.kind)).toEqual(['requested'])
    for await (const chunk of stream) {
      expect(chunk).toBe(first)
      break
    }

    expect(iteratorLookups).toBe(2)
    expect(sourceCancelled).toBe(1)
    expect(events.at(-1)?.result).toMatchObject({
      executionStatus: 'aborted',
      effectStatus: 'unknown',
    })
  })

  it('looks up async iteration before an accessor then and preserves resolution identity', async () => {
    const resolved = { exact: true }
    const lookupOrder: string[] = []
    const output = Object.defineProperty({}, Symbol.asyncIterator, {
      get: () => {
        lookupOrder.push('asyncIterator')
        return undefined
      },
    })
    Object.defineProperty(output, 'then', {
      get: () => {
        lookupOrder.push('then')
        return (resolve: (value: unknown) => void) => resolve(resolved)
      },
    })
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        promiseLike: tool({
          description: 'accessor promise',
          inputSchema: z.unknown(),
          execute: () => output,
        }),
      },
      {
        evidenceSink: { record: (event) => events.push(event) },
        describeTool: writeDescriptor,
      },
    )

    const actual = await executeOf(wrapped, 'promiseLike')(
      {},
      executionOptions('accessor-promise'),
    )

    expect(actual).toBe(resolved)
    expect(lookupOrder).toEqual(['asyncIterator', 'then'])
    expect(events.map((event) => event.kind)).toEqual(['requested', 'settled'])
  })

  it('propagates async-iterator getter errors by identity and records rejection', () => {
    const getterError = new Error('iterator getter failed')
    const output = Object.defineProperty({}, Symbol.asyncIterator, {
      get: () => {
        throw getterError
      },
    })
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        brokenShape: tool({
          description: 'broken return shape',
          inputSchema: z.unknown(),
          execute: () => output,
        }),
      },
      {
        evidenceSink: { record: (event) => events.push(event) },
        describeTool: writeDescriptor,
      },
    )

    expect(() =>
      executeOf(wrapped, 'brokenShape')({}, executionOptions('broken-shape')),
    ).toThrow(getterError)
    expect(events.at(-1)?.result).toMatchObject({
      transportStatus: 'failed',
      executionStatus: 'error',
    })
  })

  it('disables evidence setup when telemetry-only execution options are hostile', () => {
    const output = { dispatched: true }
    let calls = 0
    const hostileOptions = new Proxy(
      {},
      {
        get: () => {
          throw new Error('telemetry option unavailable')
        },
      },
    ) as ToolExecutionOptions
    const wrapped = wrapToolSetWithEvidence(
      {
        dispatch: tool({
          description: 'dispatch',
          inputSchema: z.unknown(),
          execute: () => {
            calls += 1
            return output
          },
        }),
      },
      {
        evidenceSink: { record: () => {} },
        describeTool: writeDescriptor,
      },
    )

    expect(executeOf(wrapped, 'dispatch')({}, hostileOptions)).toBe(output)
    expect(calls).toBe(1)
  })

  it('never replaces an original rejection when settled-event setup fails', () => {
    const originalError = new Error('original tool rejection')
    const eventSetupError = new Error('settled event clock unavailable')
    const originalNow = Date.now
    let clockReads = 0
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        rejects: tool({
          description: 'rejects',
          inputSchema: z.unknown(),
          execute: () => {
            throw originalError
          },
        }),
      },
      {
        evidenceSink: { record: (event) => events.push(event) },
        describeTool: writeDescriptor,
      },
    )
    Date.now = () => {
      clockReads += 1
      if (clockReads === 2) {
        throw eventSetupError
      }
      return 100
    }

    try {
      expect(() =>
        executeOf(wrapped, 'rejects')(
          {},
          executionOptions('settlement-failure'),
        ),
      ).toThrow(originalError)
    } finally {
      Date.now = originalNow
    }
    expect(events.map((event) => event.kind)).toEqual(['requested'])
  })

  it('preserves executable __proto__ and constructor evidence keys as own properties', () => {
    const source = Object.create(null) as ToolSet
    for (const name of ['__proto__', 'constructor']) {
      Object.defineProperty(source, name, {
        configurable: true,
        enumerable: true,
        value: tool({
          description: name,
          inputSchema: z.unknown(),
          execute: () => name,
        }),
        writable: true,
      })
    }
    const events: EvidenceEvent[] = []

    const wrapped = wrapToolSetWithEvidence(source, {
      evidenceSink: { record: (event) => events.push(event) },
      describeTool: writeDescriptor,
    })

    expect(Object.getPrototypeOf(wrapped)).toBeNull()
    for (const name of ['__proto__', 'constructor']) {
      expect(Object.hasOwn(wrapped, name)).toBe(true)
      expect(
        executeOf(wrapped, name)({}, executionOptions(`call-${name}`)),
      ).toBe(name)
    }
    expect(
      events
        .filter((event) => event.kind === 'requested')
        .map((event) => event.toolName),
    ).toEqual(['__proto__', 'constructor'])
  })

  it('preserves executable __proto__ and constructor in external MCP instrumentation', () => {
    const source = Object.create(null) as ToolSet
    for (const name of ['__proto__', 'constructor']) {
      Object.defineProperty(source, name, {
        enumerable: true,
        value: tool({
          description: name,
          inputSchema: z.unknown(),
          execute: () => name,
        }),
      })
    }

    const instrumented = instrumentExternalMcpTools(source)

    expect(Object.getPrototypeOf(instrumented)).toBeNull()
    for (const name of ['__proto__', 'constructor']) {
      expect(Object.hasOwn(instrumented, name)).toBe(true)
      expect(
        executeOf(instrumented, name)({}, executionOptions(`external-${name}`)),
      ).toBe(name)
    }
  })

  it.each([
    'inherited-data',
    'own-accessor',
    'inherited-accessor',
  ] as const)('instruments %s external MCP execute with native receivers', (placement) => {
    const output = { placement }
    const lookupReceiver = { lookup: placement }
    const callReceiver = { call: placement }
    let getterCalls = 0
    let actualLookupReceiver: unknown
    let actualCallReceiver: unknown
    const sourceExecute = function (this: unknown) {
      actualCallReceiver = this
      return output
    }
    const executeDescriptor: PropertyDescriptor =
      placement === 'inherited-data'
        ? { configurable: true, value: sourceExecute }
        : {
            configurable: true,
            get(this: unknown) {
              getterCalls += 1
              actualLookupReceiver = this
              return sourceExecute
            },
          }
    const base = tool({
      description: placement,
      inputSchema: z.unknown(),
    })
    const sourceTool =
      placement === 'own-accessor'
        ? Object.defineProperty(base, 'execute', executeDescriptor)
        : Object.assign(
            Object.create(
              Object.defineProperty({}, 'execute', executeDescriptor),
            ) as object,
            base,
          )
    const metricSpy = spyOn(metrics, 'log').mockImplementation(() => {})

    try {
      const instrumented = instrumentExternalMcpTools({
        external: sourceTool as ToolSet[string],
      })
      expect(getterCalls).toBe(0)
      const execute = Reflect.get(
        instrumented.external as object,
        'execute',
        lookupReceiver,
      )
      expect(
        (execute as RuntimeExecute).call(
          callReceiver,
          {},
          executionOptions(`external-${placement}`),
        ),
      ).toBe(output)
      expect(actualCallReceiver).toBe(callReceiver)
      if (placement !== 'inherited-data') {
        expect(getterCalls).toBe(1)
        expect(actualLookupReceiver).toBe(lookupReceiver)
      }
      expect(metricSpy).toHaveBeenCalledTimes(1)
    } finally {
      metricSpy.mockRestore()
    }
  })

  it('dispatches an external MCP tool when metrics clock setup throws', () => {
    const output = { dispatched: true }
    let calls = 0
    const clockSpy = spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('clock unavailable')
    })
    const instrumented = instrumentExternalMcpTools({
      external: tool({
        description: 'clock failure',
        inputSchema: z.unknown(),
        execute: () => {
          calls += 1
          return output
        },
      }),
    })

    try {
      expect(
        executeOf(instrumented, 'external')(
          {},
          executionOptions('clock-failure'),
        ),
      ).toBe(output)
      expect(calls).toBe(1)
    } finally {
      clockSpy.mockRestore()
    }
  })

  it('uses bounded coarse digests for oversized strings, arrays, and objects', () => {
    const digests = new Map<string, string>()
    const wrapped = wrapToolSetWithEvidence(
      {
        digest: tool({
          description: 'digest',
          inputSchema: z.unknown(),
          execute: (input) => input,
        }),
      },
      {
        evidenceSink: {
          record: (event) => {
            if (event.kind === 'requested') {
              digests.set(event.toolCallId, event.argumentDigest)
            }
          },
        },
        describeTool: writeDescriptor,
      },
    )
    const execute = executeOf(wrapped, 'digest')
    const longA = 'a'.repeat(20_000)
    const longB = 'b'.repeat(20_000)
    const arrayA = new Array(20_000)
    const arrayB = new Array(20_000)
    arrayA[0] = 'a'
    arrayB[0] = 'b'
    const objectA: Record<string, string> = {}
    const objectB: Record<string, string> = {}
    for (let index = 0; index < 2_500; index += 1) {
      objectA[`key-${index}`] = 'a'
      objectB[`key-${index}`] = 'b'
    }
    let lateProxyReads = 0
    const wideKeyObject: Record<string, unknown> = {}
    for (let index = 0; index < 100; index += 1) {
      wideKeyObject[`${String(index).padStart(3, '0')}-${'k'.repeat(1_000)}`] =
        index
    }
    wideKeyObject.zzz = new Proxy(
      {},
      {
        ownKeys: () => {
          lateProxyReads += 1
          return []
        },
      },
    )

    const cases: readonly [string, unknown][] = [
      ['string-a', longA],
      ['string-b', longB],
      ['array-a', arrayA],
      ['array-b', arrayB],
      ['object-a', objectA],
      ['object-b', objectB],
      ['wide-keys', wideKeyObject],
    ]
    for (const [id, input] of cases) {
      expect(execute(input, executionOptions(id))).toBe(input)
    }

    expect(digests.get('string-a')).toBe(digests.get('string-b'))
    expect(digests.get('array-a')).toBe(digests.get('array-b'))
    expect(digests.get('object-a')).toBe(digests.get('object-b'))
    expect(lateProxyReads).toBe(0)
    for (const digest of digests.values()) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('never converts BigInt or enumerates generic objects while digesting', () => {
    let bigintConversions = 0
    let ownKeyReads = 0
    const originalBigIntToString = BigInt.prototype.toString
    BigInt.prototype.toString = function (...args): string {
      bigintConversions += 1
      return originalBigIntToString.apply(this, args)
    }
    const genericObject = new Proxy(
      { private: 'value' },
      {
        ownKeys: (target) => {
          ownKeyReads += 1
          return Reflect.ownKeys(target)
        },
      },
    )
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        digest: tool({
          description: 'bounded digest',
          inputSchema: z.unknown(),
          execute: (input) => input,
        }),
      },
      {
        evidenceSink: { record: (event) => events.push(event) },
        describeTool: writeDescriptor,
      },
    )
    const execute = executeOf(wrapped, 'digest')
    const bigint = 1n << 512n

    try {
      expect(execute(bigint, executionOptions('bigint'))).toBe(bigint)
      expect(execute(genericObject, executionOptions('generic-object'))).toBe(
        genericObject,
      )
    } finally {
      BigInt.prototype.toString = originalBigIntToString
    }

    expect(bigintConversions).toBe(0)
    expect(ownKeyReads).toBe(0)
    const requested = events.filter((event) => event.kind === 'requested')
    expect(requested.map((event) => event.argumentDigestFidelity)).toEqual([
      'coarse',
      'coarse',
    ])
  })

  it('records exact digest fidelity for bounded primitives', () => {
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        digest: tool({
          description: 'exact digest',
          inputSchema: z.unknown(),
          execute: (input) => input,
        }),
      },
      {
        evidenceSink: { record: (event) => events.push(event) },
        describeTool: writeDescriptor,
      },
    )

    executeOf(wrapped, 'digest')('bounded', executionOptions('exact'))

    expect(events[0]?.argumentDigestFidelity).toBe('exact')
    expect(events[1]?.argumentDigestFidelity).toBe('exact')
    expect(events[1]?.outputDigestFidelity).toBe('exact')
  })

  it('exposes only exact digests to reliability decisions', () => {
    expect(digestForReliabilityDecision('exact-digest', 'exact')).toBe(
      'exact-digest',
    )
    expect(
      digestForReliabilityDecision('coarse-digest', 'coarse'),
    ).toBeUndefined()
    expect(
      digestForReliabilityDecision('unavailable-digest', 'unavailable'),
    ).toBeUndefined()
  })
})
