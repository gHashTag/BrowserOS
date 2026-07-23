import { describe, expect, it } from 'bun:test'
import { type ToolExecutionOptions, type ToolSet, tool } from 'ai'
import { z } from 'zod'
import {
  appendEvidence,
  createMergedToolDescriptorResolver,
  MutableToolEvidenceSinkRelay,
  normalizeToolResult,
  resolveToolReliabilityDescriptor,
  type ToolEvidenceSink,
  type ToolExecutionReceipt,
  type ToolResultObservation,
  wrapToolSetWithEvidence,
} from '../../src/agent/execution-evidence'
import type {
  EvidenceEvent,
  NormalizedToolResult,
  ToolEffect,
} from '../../src/agent/execution-types'

type MutableNormalizedToolResult = {
  -readonly [Key in keyof NormalizedToolResult]: NormalizedToolResult[Key]
}

type RuntimeToolExecute = (
  input: unknown,
  options: ToolExecutionOptions,
) => unknown

function executionOptions(
  toolCallId: string,
  abortSignal?: AbortSignal,
): ToolExecutionOptions {
  return {
    toolCallId,
    messages: [],
    abortSignal,
  }
}

function requireExecute(tools: ToolSet, name: string): RuntimeToolExecute {
  const execute = tools[name]?.execute
  if (!execute) {
    throw new Error(`Expected ${name} to have an execute function`)
  }
  return execute as RuntimeToolExecute
}

function observation(
  overrides: Partial<ToolResultObservation> = {},
): ToolResultObservation {
  return {
    outcome: 'resolved',
    started: true,
    effects: ['observe'],
    output: { value: 'ok' },
    ...overrides,
  }
}

function runtimeObservation(value: unknown): ToolResultObservation {
  return value as ToolResultObservation
}

function result(
  overrides: Partial<NormalizedToolResult> = {},
): NormalizedToolResult {
  return {
    transportStatus: 'received',
    executionStatus: 'success',
    effectStatus: 'none',
    verificationStatus: 'not-run',
    ...overrides,
  }
}

function event(overrides: Partial<EvidenceEvent> = {}): EvidenceEvent {
  return {
    eventId: 'event-1',
    toolCallId: 'call-1',
    toolName: 'filesystem_write',
    kind: 'settled',
    effects: ['filesystem-write'],
    retrySafety: 'safe',
    result: result({
      effectStatus: 'unknown',
      verificationStatus: 'not-run',
    }),
    argumentDigest: 'args',
    outputDigest: 'output',
    recordedAt: 100,
    ...overrides,
  }
}

describe('normalizeToolResult', () => {
  const cases: readonly {
    readonly name: string
    readonly observation: ToolResultObservation
    readonly expected: NormalizedToolResult
  }[] = [
    {
      name: 'marks a trusted structured semantic error without failing transport',
      observation: observation({ output: { isError: true } }),
      expected: result({
        executionStatus: 'error',
        verificationStatus: 'not-run',
      }),
    },
    {
      name: 'marks a rejected transport as failed and errored',
      observation: observation({
        outcome: 'rejected',
        started: false,
        output: undefined,
      }),
      expected: result({
        transportStatus: 'failed',
        executionStatus: 'error',
        verificationStatus: 'not-run',
      }),
    },
    {
      name: 'marks denial as received, denied, and effect-free',
      observation: observation({
        outcome: 'denied',
        effects: ['filesystem-write'],
      }),
      expected: result({
        executionStatus: 'denied',
        verificationStatus: 'not-run',
      }),
    },
    {
      name: 'marks abort before start as received, aborted, and effect-free',
      observation: observation({
        outcome: 'aborted',
        started: false,
        effects: ['filesystem-write'],
      }),
      expected: result({
        executionStatus: 'aborted',
        verificationStatus: 'not-run',
      }),
    },
    {
      name: 'keeps a started mutating abort effect unknown',
      observation: observation({
        outcome: 'aborted',
        effects: ['filesystem-write'],
      }),
      expected: result({
        executionStatus: 'aborted',
        effectStatus: 'unknown',
        verificationStatus: 'not-run',
      }),
    },
    {
      name: 'keeps an aborted read effect-free',
      observation: observation({
        outcome: 'aborted',
        effects: ['filesystem-read'],
      }),
      expected: result({
        executionStatus: 'aborted',
        verificationStatus: 'not-run',
      }),
    },
    {
      name: 'marks a successful read as effect-free without fabricating verification policy',
      observation: observation({ effects: ['filesystem-read'] }),
      expected: result(),
    },
    {
      name: 'keeps a resolved mutation unknown without a trusted receipt',
      observation: observation({ effects: ['filesystem-write'] }),
      expected: result({
        effectStatus: 'unknown',
        verificationStatus: 'not-run',
      }),
    },
    {
      name: 'does not treat empty output as proof of an applied mutation',
      observation: observation({
        effects: ['browser-write'],
        output: undefined,
      }),
      expected: result({
        effectStatus: 'unknown',
        verificationStatus: 'not-run',
      }),
    },
    {
      name: 'does not treat the literal Success as proof of an applied mutation',
      observation: observation({
        effects: ['external-write'],
        output: 'Success',
      }),
      expected: result({
        effectStatus: 'unknown',
        verificationStatus: 'not-run',
      }),
    },
    {
      name: 'keeps a started rejected mutation effect unknown',
      observation: observation({
        outcome: 'rejected',
        effects: ['command'],
      }),
      expected: result({
        transportStatus: 'failed',
        executionStatus: 'error',
        effectStatus: 'unknown',
        verificationStatus: 'not-run',
      }),
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(normalizeToolResult(testCase.observation)).toEqual(
        testCase.expected,
      )
    })
  }

  it.each([
    ['error'],
    ['denied'],
    ['applied'],
    ['the write was applied successfully'],
  ])('does not infer semantics from output prose: %s', (output) => {
    expect(
      normalizeToolResult(
        observation({ effects: ['filesystem-read'], output }),
      ),
    ).toEqual(result())
  })

  it.each([
    ['null', null],
    ['array', [{ isError: true }]],
    ['primitive', 42],
    ['boolean false', { isError: false }],
    ['nested field', { result: { isError: true } }],
    [
      'prototype field',
      Object.assign(Object.create({ isError: true }) as object, {
        value: 'not an error',
      }),
    ],
  ])('ignores an untrusted isError shape: %s', (_name, output) => {
    expect(
      normalizeToolResult(
        observation({ effects: ['filesystem-read'], output }),
      ),
    ).toEqual(result())
  })

  it('accepts a data field on a null-prototype structured output', () => {
    const output = Object.create(null) as Record<string, unknown>
    output.isError = true

    expect(
      normalizeToolResult(
        observation({ effects: ['filesystem-read'], output }),
      ),
    ).toEqual(
      result({
        executionStatus: 'error',
        verificationStatus: 'not-run',
      }),
    )
  })

  it('does not execute or trust an isError accessor', () => {
    let reads = 0
    const output = Object.defineProperty({}, 'isError', {
      enumerable: true,
      get: () => {
        reads += 1
        return true
      },
    })

    expect(
      normalizeToolResult(
        observation({ effects: ['filesystem-read'], output }),
      ),
    ).toEqual(result({ executionStatus: 'error' }))
    expect(reads).toBe(0)
  })

  it.each([
    ['applied', 'passed'],
    ['partial', 'failed'],
    ['unknown', 'not-run'],
  ] as const)('accepts trusted mutation receipt effect=%s verification=%s', (effectStatus, verificationStatus) => {
    expect(
      normalizeToolResult(
        observation({
          effects: ['filesystem-write'],
          receipt: { effectStatus, verificationStatus },
        }),
      ),
    ).toEqual(result({ effectStatus, verificationStatus }))
  })

  it('uses a trusted receipt to refine a failed started mutation without hiding the failure', () => {
    expect(
      normalizeToolResult(
        observation({
          outcome: 'rejected',
          effects: ['external-write'],
          receipt: {
            effectStatus: 'partial',
            verificationStatus: 'failed',
          },
        }),
      ),
    ).toEqual(
      result({
        transportStatus: 'failed',
        executionStatus: 'error',
        effectStatus: 'partial',
        verificationStatus: 'failed',
      }),
    )
  })

  it('uses a trusted receipt to refine an aborted started mutation without hiding the abort', () => {
    expect(
      normalizeToolResult(
        observation({
          outcome: 'aborted',
          effects: ['browser-write'],
          receipt: {
            effectStatus: 'applied',
            verificationStatus: 'passed',
          },
        }),
      ),
    ).toEqual(
      result({
        executionStatus: 'aborted',
        effectStatus: 'applied',
        verificationStatus: 'passed',
      }),
    )
  })

  it('denial takes precedence over a contradictory receipt', () => {
    expect(
      normalizeToolResult(
        observation({
          outcome: 'denied',
          effects: ['filesystem-write'],
          receipt: {
            effectStatus: 'applied',
            verificationStatus: 'passed',
          },
        }),
      ),
    ).toEqual(result({ executionStatus: 'denied' }))
  })

  it.each([
    ['read', true, ['filesystem-read'] as const],
    ['observe', true, ['observe'] as const],
    ['verify', true, ['verify'] as const],
    ['not started', false, ['filesystem-write'] as const],
  ])('does not let a receipt fabricate an effect for %s observations', (_name, started, effects) => {
    expect(
      normalizeToolResult(
        observation({
          started,
          effects,
          receipt: { effectStatus: 'applied' },
        }),
      ).effectStatus,
    ).toBe('none')
  })

  it('ignores malformed runtime receipt values', () => {
    const receipt = {
      effectStatus: 'invented',
      verificationStatus: 'also-invented',
    } as unknown as ToolExecutionReceipt

    expect(
      normalizeToolResult(
        observation({
          effects: ['filesystem-write'],
          receipt,
        }),
      ),
    ).toEqual(
      result({
        executionStatus: 'error',
        effectStatus: 'unknown',
      }),
    )
  })

  it.each([
    ['read', ['filesystem-read'] as const],
    ['observe', ['observe'] as const],
    ['verify', ['verify'] as const],
  ])('leaves successful %s verification not-run without an explicit passed or failed receipt', (_name, effects) => {
    expect(normalizeToolResult(observation({ effects }))).toEqual(result())
  })

  it('accepts an explicit verifier result only after execution started', () => {
    expect(
      normalizeToolResult(
        observation({
          effects: ['verify'],
          receipt: { verificationStatus: 'passed' },
        }),
      ),
    ).toEqual(result({ verificationStatus: 'passed' }))
  })

  it('ignores receipt not-required because policy owns that decision', () => {
    expect(
      normalizeToolResult(
        observation({
          effects: ['filesystem-write'],
          receipt: {
            effectStatus: 'applied',
            verificationStatus: 'not-required',
          },
        }),
      ),
    ).toEqual(result({ effectStatus: 'applied' }))
  })

  it.each([
    ['denied', 'denied'],
    ['aborted', 'aborted'],
    ['rejected', 'error'],
  ] as const)('ignores receipt verification when %s occurs before execution starts', (outcome, executionStatus) => {
    expect(
      normalizeToolResult(
        observation({
          outcome,
          started: false,
          effects: ['filesystem-write'],
          receipt: {
            effectStatus: 'applied',
            verificationStatus: 'passed',
          },
        }),
      ),
    ).toEqual(
      result({
        transportStatus: outcome === 'rejected' ? 'failed' : 'received',
        executionStatus,
      }),
    )
  })

  it('fails closed when a resolved observation claims execution never started', () => {
    expect(
      normalizeToolResult(
        observation({
          started: false,
          effects: ['filesystem-write'],
          receipt: {
            effectStatus: 'applied',
            verificationStatus: 'passed',
          },
        }),
      ),
    ).toEqual(result({ executionStatus: 'error' }))
  })

  it('fails an unknown runtime outcome at the transport boundary', () => {
    expect(
      normalizeToolResult(
        runtimeObservation({
          outcome: 'invented',
          started: true,
          effects: ['filesystem-read'],
          output: {},
        }),
      ),
    ).toEqual(
      result({
        transportStatus: 'failed',
        executionStatus: 'error',
      }),
    )
  })

  it('treats an unknown runtime effect as potentially mutating', () => {
    expect(
      normalizeToolResult(
        runtimeObservation({
          outcome: 'resolved',
          started: true,
          effects: ['unexpected-write'],
          output: {},
        }),
      ),
    ).toEqual(
      result({
        executionStatus: 'error',
        effectStatus: 'unknown',
      }),
    )
  })

  it.each([
    ['null', null],
    ['plain object', { 0: 'observe', length: 1 }],
    ['string', 'observe'],
  ])('fails closed for non-array effects: %s', (_name, effects) => {
    expect(
      normalizeToolResult(
        runtimeObservation({
          outcome: 'resolved',
          started: true,
          effects,
          output: {},
        }),
      ),
    ).toEqual(
      result({
        executionStatus: 'error',
        effectStatus: 'unknown',
      }),
    )
  })

  it.each([
    ['missing', undefined],
    ['string', 'true'],
    ['number', 1],
  ])('fails closed for a malformed started field: %s', (_name, started) => {
    expect(
      normalizeToolResult(
        runtimeObservation({
          outcome: 'resolved',
          started,
          effects: ['filesystem-read'],
          output: {},
        }),
      ),
    ).toEqual(
      result({
        executionStatus: 'error',
        effectStatus: 'unknown',
      }),
    )
  })

  it('does not invoke an accessor element in the effects array', () => {
    let reads = 0
    const effects: unknown[] = []
    Object.defineProperty(effects, '0', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'observe'
      },
    })

    expect(
      normalizeToolResult(
        runtimeObservation({
          outcome: 'resolved',
          started: true,
          effects,
          output: {},
        }),
      ),
    ).toEqual(
      result({
        executionStatus: 'error',
        effectStatus: 'unknown',
      }),
    )
    expect(reads).toBe(0)
  })

  it('contains a throwing effects proxy without invoking its get trap', () => {
    let gets = 0
    const effects = new Proxy(['observe'], {
      get: () => {
        gets += 1
        throw new Error('effects get must not run')
      },
      getOwnPropertyDescriptor: () => {
        throw new Error('effects descriptor failed')
      },
    })

    expect(() =>
      normalizeToolResult(
        runtimeObservation({
          outcome: 'resolved',
          started: true,
          effects,
          output: {},
        }),
      ),
    ).not.toThrow()
    expect(
      normalizeToolResult(
        runtimeObservation({
          outcome: 'resolved',
          started: true,
          effects,
          output: {},
        }),
      ),
    ).toEqual(
      result({
        executionStatus: 'error',
        effectStatus: 'unknown',
      }),
    )
    expect(gets).toBe(0)
  })

  it('does not invoke observation accessors and fails transport closed', () => {
    let reads = 0
    const input = Object.defineProperties(
      {},
      {
        outcome: {
          get: () => {
            reads += 1
            return 'resolved'
          },
        },
        started: {
          get: () => {
            reads += 1
            return true
          },
        },
        effects: {
          get: () => {
            reads += 1
            return ['observe']
          },
        },
      },
    )

    expect(normalizeToolResult(runtimeObservation(input))).toEqual(
      result({
        transportStatus: 'failed',
        executionStatus: 'error',
        effectStatus: 'unknown',
      }),
    )
    expect(reads).toBe(0)
  })

  it('contains an observation proxy whose descriptor trap throws', () => {
    const input = new Proxy(
      {
        outcome: 'resolved',
        started: true,
        effects: ['observe'],
      },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('observation descriptor failed')
        },
      },
    )

    expect(() => normalizeToolResult(runtimeObservation(input))).not.toThrow()
    expect(normalizeToolResult(runtimeObservation(input))).toEqual(
      result({
        transportStatus: 'failed',
        executionStatus: 'error',
        effectStatus: 'unknown',
      }),
    )
  })

  it('contains a throwing output proxy as a semantic error', () => {
    const output = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('output descriptor failed')
        },
      },
    )

    expect(() =>
      normalizeToolResult(
        observation({ effects: ['filesystem-read'], output }),
      ),
    ).not.toThrow()
    expect(
      normalizeToolResult(
        observation({ effects: ['filesystem-read'], output }),
      ),
    ).toEqual(result({ executionStatus: 'error' }))
  })

  it('does not invoke receipt accessors and fails closed', () => {
    let reads = 0
    const receipt = Object.defineProperty({}, 'effectStatus', {
      get: () => {
        reads += 1
        return 'applied'
      },
    })

    expect(
      normalizeToolResult(
        runtimeObservation({
          outcome: 'resolved',
          started: true,
          effects: ['filesystem-write'],
          output: {},
          receipt,
        }),
      ),
    ).toEqual(
      result({
        executionStatus: 'error',
        effectStatus: 'unknown',
      }),
    )
    expect(reads).toBe(0)
  })

  it('contains a throwing receipt proxy and fails closed', () => {
    const receipt = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('receipt descriptor failed')
        },
      },
    )

    expect(() =>
      normalizeToolResult(
        runtimeObservation({
          outcome: 'resolved',
          started: true,
          effects: ['filesystem-write'],
          output: {},
          receipt,
        }),
      ),
    ).not.toThrow()
    expect(
      normalizeToolResult(
        runtimeObservation({
          outcome: 'resolved',
          started: true,
          effects: ['filesystem-write'],
          output: {},
          receipt,
        }),
      ),
    ).toEqual(
      result({
        executionStatus: 'error',
        effectStatus: 'unknown',
      }),
    )
  })

  it.each([
    ['null', null],
    ['primitive', 7],
    ['array', []],
  ])('fails transport closed for a malformed observation: %s', (_name, input) => {
    expect(normalizeToolResult(runtimeObservation(input))).toEqual(
      result({
        transportStatus: 'failed',
        executionStatus: 'error',
        effectStatus: 'unknown',
      }),
    )
  })
})

describe('appendEvidence', () => {
  it('returns a new frozen ledger with a deep owned snapshot of the new event', () => {
    const prior: readonly EvidenceEvent[] = Object.freeze([])
    const effects: ToolEffect[] = ['filesystem-write']
    const normalized: MutableNormalizedToolResult = {
      transportStatus: 'received',
      executionStatus: 'success',
      effectStatus: 'unknown',
      verificationStatus: 'not-run',
    }
    const input = event({ effects, result: normalized })

    const next = appendEvidence(prior, input)
    const stored = next[0]

    expect(next).not.toBe(prior)
    expect(Object.isFrozen(next)).toBe(true)
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored.effects)).toBe(true)
    expect(Object.isFrozen(stored.result)).toBe(true)
    expect(stored).not.toBe(input)
    expect(stored.effects).not.toBe(effects)
    expect(stored.result).not.toBe(normalized)
    expect(prior).toEqual([])

    effects.push('external-write')
    normalized.effectStatus = 'applied'
    input.toolName = 'caller-mutated'

    expect(stored.effects).toEqual(['filesystem-write'])
    expect(stored.result?.effectStatus).toBe('unknown')
    expect(stored.toolName).toBe('filesystem_write')
  })

  it('does not trust arbitrary deeply frozen prior event identity', () => {
    const priorResult = Object.freeze(result())
    const priorEffects = Object.freeze(['filesystem-read'] as ToolEffect[])
    const priorEvent = Object.freeze(
      event({
        eventId: 'prior',
        effects: priorEffects,
        result: priorResult,
      }),
    )
    const prior = Object.freeze([priorEvent])

    const next = appendEvidence(prior, event({ eventId: 'next' }))

    expect(next[0]).not.toBe(priorEvent)
    expect(next).toHaveLength(2)
  })

  it('preserves identity only for snapshots created by this module', () => {
    const firstLedger = appendEvidence([], event({ eventId: 'prior' }))
    const ownedPrior = firstLedger[0]

    const next = appendEvidence(firstLedger, event({ eventId: 'next' }))

    expect(next[0]).toBe(ownedPrior)
    expect(next).toHaveLength(2)
  })

  it('snapshots unsafe prior entries so the new ledger has no live references', () => {
    const priorEffects: ToolEffect[] = ['filesystem-read']
    const priorResult: MutableNormalizedToolResult = {
      transportStatus: 'received',
      executionStatus: 'success',
      effectStatus: 'none',
      verificationStatus: 'not-required',
    }
    const unsafePrior = event({
      eventId: 'prior',
      effects: priorEffects,
      result: priorResult,
    })
    const prior: readonly EvidenceEvent[] = [unsafePrior]

    const next = appendEvidence(prior, event({ eventId: 'next' }))
    const storedPrior = next[0]

    expect(storedPrior).not.toBe(unsafePrior)
    expect(storedPrior.effects).not.toBe(priorEffects)
    expect(storedPrior.result).not.toBe(priorResult)
    expect(Object.isFrozen(storedPrior)).toBe(true)
    expect(Object.isFrozen(storedPrior.effects)).toBe(true)
    expect(Object.isFrozen(storedPrior.result)).toBe(true)

    priorEffects.push('filesystem-write')
    priorResult.executionStatus = 'error'
    unsafePrior.toolName = 'caller-mutated'

    expect(storedPrior.effects).toEqual(['filesystem-read'])
    expect(storedPrior.result?.executionStatus).toBe('success')
    expect(storedPrior.toolName).toBe('filesystem_write')
  })

  it('deeply freezes an event without a result', () => {
    const input = event({ kind: 'requested', result: undefined })

    const next = appendEvidence([], input)

    expect(next[0].result).toBeUndefined()
    expect(Object.isFrozen(next[0])).toBe(true)
    expect(Object.isFrozen(next[0].effects)).toBe(true)
  })

  it('rejects a frozen prior event accessor without invoking it or changing the prior ledger', () => {
    let reads = 0
    const unsafe = event({ eventId: 'unsafe-prior' })
    Object.freeze(unsafe.effects)
    if (unsafe.result !== undefined) {
      Object.freeze(unsafe.result)
    }
    Object.defineProperty(unsafe, 'toolName', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'accessor-tool'
      },
    })
    Object.freeze(unsafe)
    const prior = Object.freeze([unsafe])

    expect(() => appendEvidence(prior, event({ eventId: 'next' }))).toThrow(
      TypeError,
    )
    expect(() => appendEvidence(prior, event({ eventId: 'next' }))).toThrow(
      /Cannot snapshot evidence event/,
    )
    expect(reads).toBe(0)
    expect(prior).toEqual([unsafe])
    expect(prior[0]).toBe(unsafe)
  })

  it('drops unexpected nested event and result fields from the owned snapshot', () => {
    const unexpectedEvent = { live: { value: 'event-original' } }
    const unexpectedResult = { live: { value: 'result-original' } }
    const inputResult = Object.assign(result(), {
      unexpected: unexpectedResult,
    })
    const input = Object.assign(
      event({
        result: inputResult,
      }),
      { unexpected: unexpectedEvent },
    )

    const stored = appendEvidence([], input as unknown as EvidenceEvent)[0]

    expect(Object.hasOwn(stored, 'unexpected')).toBe(false)
    expect(Object.hasOwn(stored.result ?? {}, 'unexpected')).toBe(false)

    unexpectedEvent.live.value = 'event-mutated'
    unexpectedResult.live.value = 'result-mutated'

    expect(Object.hasOwn(stored, 'unexpected')).toBe(false)
    expect(Object.hasOwn(stored.result ?? {}, 'unexpected')).toBe(false)
  })

  it('wraps an event proxy failure in a clear TypeError and preserves the prior ledger', () => {
    const prior = appendEvidence([], event({ eventId: 'prior' }))
    const priorEntry = prior[0]
    const unsafe = new Proxy(event({ eventId: 'unsafe' }), {
      getOwnPropertyDescriptor: () => {
        throw new Error('event descriptor failed')
      },
    })

    expect(() => appendEvidence(prior, unsafe)).toThrow(TypeError)
    expect(() => appendEvidence(prior, unsafe)).toThrow(
      /Cannot snapshot evidence event/,
    )
    expect(prior).toHaveLength(1)
    expect(prior[0]).toBe(priorEntry)
  })

  it('wraps a throwing effects proxy without invoking its get trap', () => {
    let gets = 0
    const effects = new Proxy(['filesystem-read'] as ToolEffect[], {
      get: () => {
        gets += 1
        throw new Error('effects get must not run')
      },
      getOwnPropertyDescriptor: () => {
        throw new Error('effects descriptor failed')
      },
    })
    const input = event({ effects })

    expect(() => appendEvidence([], input)).toThrow(TypeError)
    expect(() => appendEvidence([], input)).toThrow(
      /Cannot snapshot evidence event/,
    )
    expect(gets).toBe(0)
  })

  it('rejects a result accessor without invoking it', () => {
    let reads = 0
    const unsafeResult = result()
    Object.defineProperty(unsafeResult, 'executionStatus', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'success'
      },
    })
    const input = event({ result: unsafeResult })

    expect(() => appendEvidence([], input)).toThrow(TypeError)
    expect(() => appendEvidence([], input)).toThrow(
      /Cannot snapshot evidence event/,
    )
    expect(reads).toBe(0)
  })

  it('wraps a throwing result proxy in a clear TypeError', () => {
    const unsafeResult = new Proxy(result(), {
      getOwnPropertyDescriptor: () => {
        throw new Error('result descriptor failed')
      },
    })
    const input = event({ result: unsafeResult })

    expect(() => appendEvidence([], input)).toThrow(TypeError)
    expect(() => appendEvidence([], input)).toThrow(
      /Cannot snapshot evidence event/,
    )
  })

  it('ignores an overridden ledger map instead of accepting injected entries', () => {
    let mapCalls = 0
    let injectedReads = 0
    const actual = event({ eventId: 'actual-prior' })
    const injected = event({ eventId: 'injected-prior' })
    Object.defineProperty(injected, 'toolName', {
      get: () => {
        injectedReads += 1
        return 'injected-tool'
      },
    })
    Object.freeze(injected)
    const ledger = [actual]
    Object.defineProperty(ledger, 'map', {
      value: () => {
        mapCalls += 1
        return [injected]
      },
    })

    const next = appendEvidence(ledger, event({ eventId: 'next' }))

    expect(next.map((entry) => entry.eventId)).toEqual(['actual-prior', 'next'])
    expect(mapCalls).toBe(0)
    expect(injectedReads).toBe(0)
  })

  it('rejects a sparse ledger without changing the caller-owned new event', () => {
    const ledger = new Array<EvidenceEvent>(1)
    const effects: ToolEffect[] = ['filesystem-write']
    const normalized: MutableNormalizedToolResult = {
      transportStatus: 'received',
      executionStatus: 'success',
      effectStatus: 'unknown',
      verificationStatus: 'not-run',
    }
    const input = event({ effects, result: normalized })

    expect(() => appendEvidence(ledger, input)).toThrow(TypeError)
    expect(() => appendEvidence(ledger, input)).toThrow(
      /Cannot snapshot evidence ledger/,
    )
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(effects)).toBe(false)
    expect(Object.isFrozen(normalized)).toBe(false)
    expect(input.effects).toBe(effects)
    expect(input.result).toBe(normalized)
  })

  it('rejects a non-array ledger runtime value with a clear TypeError', () => {
    const ledger = {
      length: 0,
      map: () => [],
    } as unknown as readonly EvidenceEvent[]

    expect(() => appendEvidence(ledger, event())).toThrow(TypeError)
    expect(() => appendEvidence(ledger, event())).toThrow(
      /Cannot snapshot evidence ledger/,
    )
  })

  it('rejects a ledger index accessor without invoking it', () => {
    let reads = 0
    const ledger = new Array<EvidenceEvent>(1)
    Object.defineProperty(ledger, '0', {
      get: () => {
        reads += 1
        return event({ eventId: 'accessor-prior' })
      },
    })

    expect(() => appendEvidence(ledger, event())).toThrow(TypeError)
    expect(() => appendEvidence(ledger, event())).toThrow(
      /Cannot snapshot evidence ledger/,
    )
    expect(reads).toBe(0)
  })

  it('wraps ledger proxy trap failures without producing partial output', () => {
    const ledger = new Proxy([event({ eventId: 'proxy-prior' })], {
      get: () => {
        throw new Error('raw ledger get failure')
      },
      getOwnPropertyDescriptor: () => {
        throw new Error('raw ledger descriptor failure')
      },
    })

    expect(() => appendEvidence(ledger, event())).toThrow(TypeError)
    expect(() => appendEvidence(ledger, event())).toThrow(
      /Cannot snapshot evidence ledger/,
    )
  })
})

describe('tool reliability descriptors', () => {
  it.each([
    ['filesystem_read', ['filesystem-read'], 'safe'],
    ['filesystem_grep', ['filesystem-read'], 'safe'],
    ['filesystem_find', ['filesystem-read'], 'safe'],
    ['filesystem_ls', ['filesystem-read'], 'safe'],
    ['filesystem_write', ['filesystem-write'], 'safe'],
    ['filesystem_edit', ['filesystem-write'], 'unsafe'],
    ['filesystem_bash', ['command'], 'unknown'],
  ] as const)('curates filesystem descriptor for %s', (name, effects, retrySafety) => {
    expect(
      resolveToolReliabilityDescriptor(name, { kind: 'filesystem' }),
    ).toEqual({ effects, retrySafety })
  })

  it.each([
    ['memory_search', ['filesystem-read'], 'safe'],
    ['memory_read_core', ['filesystem-read'], 'safe'],
    ['soul_read', ['filesystem-read'], 'safe'],
    ['memory_write', ['filesystem-write'], 'unsafe'],
    ['memory_update_core', ['filesystem-write'], 'unsafe'],
    ['soul_update', ['filesystem-write'], 'unsafe'],
  ] as const)('curates memory descriptor for %s', (name, effects, retrySafety) => {
    expect(resolveToolReliabilityDescriptor(name, { kind: 'memory' })).toEqual({
      effects,
      retrySafety,
    })
  })

  it.each([
    ['observation', ['observe'], 'safe'],
    ['screenshots', ['observe'], 'safe'],
    ['input', ['browser-write'], 'unsafe'],
    ['navigation', ['browser-write'], 'unsafe'],
    ['scripts', ['browser-write'], 'unsafe'],
    ['data-modification', ['browser-write'], 'unsafe'],
    ['assistant', ['browser-write'], 'unsafe'],
  ] as const)('maps BrowserOS category %s conservatively', (approvalCategory, effects, retrySafety) => {
    expect(
      resolveToolReliabilityDescriptor('registry_tool', {
        kind: 'browser',
        approvalCategory,
      }),
    ).toEqual({ effects, retrySafety })
  })

  it('maps final unknown and MCP tools to an unknown external write', () => {
    expect(
      resolveToolReliabilityDescriptor('some_custom_mcp_tool', {
        kind: 'external',
      }),
    ).toEqual({
      effects: ['external-write'],
      retrySafety: 'unknown',
    })
  })

  it('uses the descriptor belonging to the source that wins merge precedence', () => {
    const browserDescriptor = resolveToolReliabilityDescriptor('collision', {
      kind: 'browser',
      approvalCategory: 'observation',
    })
    const externalDescriptor = resolveToolReliabilityDescriptor('collision', {
      kind: 'external',
    })
    const filesystemDescriptor = resolveToolReliabilityDescriptor(
      'filesystem_read',
      { kind: 'filesystem' },
    )
    const describe = createMergedToolDescriptorResolver([
      {
        toolNames: ['collision', 'browser_only'],
        describeTool: () => browserDescriptor,
      },
      {
        toolNames: ['collision'],
        describeTool: () => externalDescriptor,
      },
      {
        toolNames: ['collision'],
        describeTool: () => filesystemDescriptor,
      },
    ])

    expect(describe('collision')).toEqual(filesystemDescriptor)
    expect(describe('browser_only')).toEqual(browserDescriptor)
    expect(describe('not-in-the-merge')).toEqual({
      effects: ['external-write'],
      retrySafety: 'unknown',
    })
  })
})

describe('wrapToolSetWithEvidence', () => {
  const readDescriptor = () =>
    resolveToolReliabilityDescriptor('filesystem_read', {
      kind: 'filesystem' as const,
    })
  const writeDescriptor = () =>
    resolveToolReliabilityDescriptor('filesystem_write', {
      kind: 'filesystem' as const,
    })

  it('forwards successful output and both execute arguments by identity', async () => {
    const output = { text: 'read complete' }
    const input = { path: '/safe/value.txt', nested: { limit: 3 } }
    const options = executionOptions('call-read')
    let receivedInput: unknown
    let receivedOptions: ToolExecutionOptions | undefined
    const source = {
      filesystem_read: tool({
        description: 'read',
        inputSchema: z.unknown(),
        execute: (actualInput, actualOptions) => {
          receivedInput = actualInput
          receivedOptions = actualOptions
          return output
        },
      }),
    } satisfies ToolSet
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(source, {
      evidenceSink: { record: (item) => events.push(item) },
      describeTool: readDescriptor,
    })

    const actual = requireExecute(wrapped, 'filesystem_read')(input, options)

    expect(actual).toBe(output)
    expect(await actual).toBe(output)
    expect(receivedInput).toBe(input)
    expect(receivedOptions).toBe(options)
    expect(events).toHaveLength(2)
    expect(events.map((item) => item.kind)).toEqual(['requested', 'settled'])
    expect(events.map((item) => item.toolCallId)).toEqual([
      'call-read',
      'call-read',
    ])
    expect(events[0].toolName).toBe('filesystem_read')
    expect(events[0].effects).toEqual(['filesystem-read'])
    expect(events[0].result).toBeUndefined()
    expect(events[1].result).toEqual(result())
    expect(events[0].argumentDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(events[1].argumentDigest).toBe(events[0].argumentDigest)
    expect(events[1].outputDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(events[0])).toBe(true)
    expect(Object.isFrozen(events[0].effects)).toBe(true)
    expect(Object.isFrozen(events[1].result)).toBe(true)
  })

  it('preserves the original execute receiver and tool property descriptors', () => {
    const marker = Symbol('marker')
    let getterReads = 0
    const sourceTool = tool({
      description: 'read',
      inputSchema: z.unknown(),
      execute(this: object) {
        return this
      },
    })
    Object.defineProperty(sourceTool, marker, {
      configurable: false,
      enumerable: false,
      value: 'symbol-value',
      writable: false,
    })
    Object.defineProperty(sourceTool, 'lazyMetadata', {
      configurable: true,
      enumerable: false,
      get: () => {
        getterReads += 1
        return 'metadata'
      },
    })
    const source = { filesystem_read: sourceTool } satisfies ToolSet
    const wrapped = wrapToolSetWithEvidence(source, {
      evidenceSink: { record: () => {} },
      describeTool: readDescriptor,
    })
    const wrappedTool = wrapped.filesystem_read as typeof sourceTool & {
      readonly [marker]: string
      readonly lazyMetadata: string
    }

    expect(getterReads).toBe(0)
    expect(Object.getOwnPropertyDescriptor(wrappedTool, marker)).toEqual(
      Object.getOwnPropertyDescriptor(sourceTool, marker),
    )
    expect(
      Object.getOwnPropertyDescriptor(wrappedTool, 'lazyMetadata'),
    ).toEqual(Object.getOwnPropertyDescriptor(sourceTool, 'lazyMetadata'))
    const receiver = { receiver: true }
    expect(
      requireExecute(wrapped, 'filesystem_read').call(
        receiver,
        {},
        executionOptions('call-this'),
      ),
    ).toBe(receiver)
    expect(getterReads).toBe(0)
  })

  it('preserves PromiseLike completion and forwards the exact resolved value', async () => {
    const output = { text: 'thenable output' }
    const options = executionOptions('call-thenable')
    const thenable = Object.defineProperty({}, 'then', {
      value: (
        onfulfilled: (value: typeof output) => unknown,
        _onrejected?: (reason: unknown) => unknown,
      ) => {
        return Promise.resolve(onfulfilled(output))
      },
    })
    let receivedOptions: ToolExecutionOptions | undefined
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        filesystem_read: tool({
          description: 'read',
          inputSchema: z.unknown(),
          execute: (_input, actualOptions) => {
            receivedOptions = actualOptions
            return thenable
          },
        }),
      },
      {
        evidenceSink: { record: (item) => events.push(item) },
        describeTool: readDescriptor,
      },
    )

    const pending = requireExecute(wrapped, 'filesystem_read')({}, options)

    expect(typeof (pending as { then?: unknown }).then === 'function').toBe(
      true,
    )
    expect(await pending).toBe(output)
    expect(receivedOptions).toBe(options)
    expect(events.map((item) => item.kind)).toEqual(['requested', 'settled'])
  })

  it('preserves every AsyncIterable yield and settles after normal completion', async () => {
    const preliminary = { type: 'preliminary', value: 1 }
    const final = { type: 'final', value: 2 }
    const input = { query: 'status' }
    const options = executionOptions('call-stream')
    let receivedInput: unknown
    let receivedOptions: ToolExecutionOptions | undefined
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        filesystem_read: tool({
          description: 'streaming read',
          inputSchema: z.unknown(),
          execute: (actualInput, actualOptions) => {
            receivedInput = actualInput
            receivedOptions = actualOptions
            return (async function* () {
              yield preliminary
              yield final
            })()
          },
        }),
      },
      {
        evidenceSink: { record: (item) => events.push(item) },
        describeTool: readDescriptor,
      },
    )

    const stream = requireExecute(wrapped, 'filesystem_read')(input, options)

    expect(Symbol.asyncIterator in (stream as object)).toBe(true)
    expect(events.map((item) => item.kind)).toEqual(['requested'])
    const yielded: unknown[] = []
    for await (const chunk of stream as AsyncIterable<unknown>) {
      yielded.push(chunk)
    }
    expect(yielded).toEqual([preliminary, final])
    expect(yielded[0]).toBe(preliminary)
    expect(yielded[1]).toBe(final)
    expect(receivedInput).toBe(input)
    expect(receivedOptions).toBe(options)
    expect(events.map((item) => item.kind)).toEqual(['requested', 'settled'])
    expect(events[1].result).toEqual(result())
    expect(events[1].outputDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('preserves an AsyncIterable rejection and settles exactly once', async () => {
    const rejection = new Error('stream failed')
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        filesystem_read: tool({
          description: 'streaming read',
          inputSchema: z.unknown(),
          execute: () =>
            (async function* () {
              yield { type: 'preliminary' }
              throw rejection
            })(),
        }),
      },
      {
        evidenceSink: { record: (item) => events.push(item) },
        describeTool: readDescriptor,
      },
    )
    const stream = requireExecute(wrapped, 'filesystem_read')(
      {},
      executionOptions('call-stream-reject'),
    ) as AsyncIterable<unknown>
    const iterator = stream[Symbol.asyncIterator]()

    expect((await iterator.next()).value).toEqual({ type: 'preliminary' })
    try {
      await iterator.next()
      throw new Error('Expected stream to reject')
    } catch (error) {
      expect(error).toBe(rejection)
    }
    expect(events.map((item) => item.kind)).toEqual(['requested', 'settled'])
    expect(events[1].result).toEqual(
      result({
        transportStatus: 'failed',
        executionStatus: 'error',
      }),
    )
  })

  it('settles an early-cancelled AsyncIterable once without consuming the rest', async () => {
    let finallyCalls = 0
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        filesystem_write: tool({
          description: 'streaming write',
          inputSchema: z.unknown(),
          execute: () =>
            (async function* () {
              try {
                yield { type: 'preliminary' }
                yield { type: 'unreachable' }
              } finally {
                finallyCalls += 1
              }
            })(),
        }),
      },
      {
        evidenceSink: { record: (item) => events.push(item) },
        describeTool: writeDescriptor,
      },
    )
    const stream = requireExecute(wrapped, 'filesystem_write')(
      {},
      executionOptions('call-stream-cancel'),
    ) as AsyncIterable<unknown>

    for await (const _chunk of stream) {
      break
    }

    expect(finallyCalls).toBe(1)
    expect(events.map((item) => item.kind)).toEqual(['requested', 'settled'])
    expect(events[1].result).toEqual(
      result({
        executionStatus: 'aborted',
        effectStatus: 'unknown',
        verificationStatus: 'not-run',
      }),
    )
  })

  it('records semantic own isError as an execution error', async () => {
    const output = { isError: true, text: 'missing file' }
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        filesystem_read: tool({
          description: 'read',
          inputSchema: z.unknown(),
          execute: () => output,
        }),
      },
      {
        evidenceSink: { record: (item) => events.push(item) },
        describeTool: readDescriptor,
      },
    )

    expect(
      await requireExecute(wrapped, 'filesystem_read')(
        {},
        executionOptions('call-semantic-error'),
      ),
    ).toBe(output)
    expect(events[1].result).toEqual(
      result({
        executionStatus: 'error',
        verificationStatus: 'not-run',
      }),
    )
  })

  it('forwards the exact rejection and settles once', async () => {
    const rejection = new Error('exact rejection')
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        filesystem_read: tool({
          description: 'read',
          inputSchema: z.unknown(),
          execute: () => {
            throw rejection
          },
        }),
      },
      {
        evidenceSink: { record: (item) => events.push(item) },
        describeTool: readDescriptor,
      },
    )

    try {
      await requireExecute(wrapped, 'filesystem_read')(
        {},
        executionOptions('call-reject'),
      )
      throw new Error('Expected execution to reject')
    } catch (error) {
      expect(error).toBe(rejection)
    }
    expect(events.map((item) => item.kind)).toEqual(['requested', 'settled'])
    expect(events[1].result).toEqual(
      result({
        transportStatus: 'failed',
        executionStatus: 'error',
      }),
    )
  })

  it('observes a pre-abort without suppressing the original execution', async () => {
    const abortController = new AbortController()
    abortController.abort('cancel before dispatch')
    const output = { text: 'original still ran' }
    let calls = 0
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        filesystem_write: tool({
          description: 'write',
          inputSchema: z.unknown(),
          execute: () => {
            calls += 1
            return output
          },
        }),
      },
      {
        evidenceSink: { record: (item) => events.push(item) },
        describeTool: writeDescriptor,
      },
    )

    expect(
      await requireExecute(wrapped, 'filesystem_write')(
        { content: 'value' },
        executionOptions('call-pre-abort', abortController.signal),
      ),
    ).toBe(output)
    expect(calls).toBe(1)
    expect(events.map((item) => item.kind)).toEqual(['requested', 'settled'])
    expect(events[1].result).toEqual(
      result({
        executionStatus: 'aborted',
        effectStatus: 'unknown',
        verificationStatus: 'not-run',
      }),
    )
  })

  it('observes an abort after a mutating execution starts as unknown effect', async () => {
    const abortController = new AbortController()
    let releaseExecution: ((output: object) => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const output = { text: 'finished after abort' }
    const pendingOutput = new Promise<object>((resolve) => {
      releaseExecution = resolve
    })
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        filesystem_write: tool({
          description: 'write',
          inputSchema: z.unknown(),
          execute: () => {
            markStarted?.()
            return pendingOutput
          },
        }),
      },
      {
        evidenceSink: { record: (item) => events.push(item) },
        describeTool: writeDescriptor,
      },
    )

    const execution = requireExecute(wrapped, 'filesystem_write')(
      { content: 'value' },
      executionOptions('call-mid-abort', abortController.signal),
    )
    await started
    abortController.abort('cancel in flight')
    releaseExecution?.(output)

    expect(await execution).toBe(output)
    expect(events.map((item) => item.kind)).toEqual(['requested', 'settled'])
    expect(events[1].result).toEqual(
      result({
        executionStatus: 'aborted',
        effectStatus: 'unknown',
        verificationStatus: 'not-run',
      }),
    )
  })

  it('keeps mutating success unknown without inventing a receipt', async () => {
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        filesystem_write: tool({
          description: 'write',
          inputSchema: z.unknown(),
          execute: () => ({ text: 'Success' }),
        }),
      },
      {
        evidenceSink: { record: (item) => events.push(item) },
        describeTool: writeDescriptor,
      },
    )

    await requireExecute(wrapped, 'filesystem_write')(
      { content: 'value' },
      executionOptions('call-write'),
    )

    expect(events[1].result).toEqual(
      result({
        effectStatus: 'unknown',
        verificationStatus: 'not-run',
      }),
    )
  })

  it('returns the original tool set unchanged when no sink is installed', () => {
    const source = {
      filesystem_read: tool({
        description: 'read',
        inputSchema: z.unknown(),
        execute: () => ({ text: 'read' }),
      }),
    } satisfies ToolSet

    expect(
      wrapToolSetWithEvidence(source, { describeTool: readDescriptor }),
    ).toBe(source)
  })

  it('leaves a tool without execute unchanged and emits nothing', () => {
    const withoutExecute = tool({
      description: 'client-side tool',
      inputSchema: z.unknown(),
    })
    const source = { client_side: withoutExecute } satisfies ToolSet
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(source, {
      evidenceSink: { record: (item) => events.push(item) },
      describeTool: readDescriptor,
    })

    expect(wrapped.client_side).toBe(withoutExecute)
    expect(events).toEqual([])
  })

  it('contains sink failures without changing return or rejection identity', async () => {
    const output = { text: 'unchanged' }
    const rejection = new Error('unchanged rejection')
    const throwingSink: ToolEvidenceSink = {
      record: () => {
        throw new Error('telemetry unavailable')
      },
    }
    const wrapped = wrapToolSetWithEvidence(
      {
        succeeds: tool({
          description: 'success',
          inputSchema: z.unknown(),
          execute: () => output,
        }),
        rejects: tool({
          description: 'failure',
          inputSchema: z.unknown(),
          execute: () => {
            throw rejection
          },
        }),
      },
      {
        evidenceSink: throwingSink,
        describeTool: readDescriptor,
      },
    )

    expect(
      await requireExecute(wrapped, 'succeeds')(
        {},
        executionOptions('call-sink-success'),
      ),
    ).toBe(output)
    try {
      await requireExecute(wrapped, 'rejects')(
        {},
        executionOptions('call-sink-reject'),
      )
      throw new Error('Expected execution to reject')
    } catch (error) {
      expect(error).toBe(rejection)
    }
  })

  it('captures one relay target for requested and late settled events', async () => {
    let releaseExecution: ((output: object) => void) | undefined
    const pendingOutput = new Promise<object>((resolve) => {
      releaseExecution = resolve
    })
    const firstEvents: EvidenceEvent[] = []
    const secondEvents: EvidenceEvent[] = []
    const relay = new MutableToolEvidenceSinkRelay()
    relay.setTarget({ record: (item) => firstEvents.push(item) })
    const wrapped = wrapToolSetWithEvidence(
      {
        filesystem_read: tool({
          description: 'read',
          inputSchema: z.unknown(),
          execute: () => pendingOutput,
        }),
      },
      {
        evidenceSink: relay,
        describeTool: readDescriptor,
      },
    )

    const execution = requireExecute(wrapped, 'filesystem_read')(
      {},
      executionOptions('call-first-owner'),
    )
    relay.setTarget({ record: (item) => secondEvents.push(item) })
    releaseExecution?.({ text: 'late completion' })
    await execution

    expect(firstEvents.map((item) => item.kind)).toEqual([
      'requested',
      'settled',
    ])
    expect(firstEvents.map((item) => item.toolCallId)).toEqual([
      'call-first-owner',
      'call-first-owner',
    ])
    expect(secondEvents).toEqual([])
  })

  it('produces deterministic opaque SHA-256 digests for ordinary inputs', async () => {
    const digests: string[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        filesystem_read: tool({
          description: 'read',
          inputSchema: z.unknown(),
          execute: () => ({ text: 'constant output' }),
        }),
      },
      {
        evidenceSink: {
          record: (item) => {
            if (item.kind === 'requested') {
              digests.push(item.argumentDigest)
            }
          },
        },
        describeTool: readDescriptor,
      },
    )
    const execute = requireExecute(wrapped, 'filesystem_read')

    await execute(
      { beta: [2, { y: true }], alpha: 'private-value' },
      executionOptions('call-digest-1'),
    )
    await execute(
      { alpha: 'private-value', beta: [2, { y: true }] },
      executionOptions('call-digest-2'),
    )

    expect(digests).toHaveLength(2)
    expect(digests[0]).toBe(digests[1])
    expect(digests[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(digests[0]).not.toContain('private-value')
  })

  it('never crashes, invokes getters, or leaks raw values while digesting hostile inputs', async () => {
    let getterReads = 0
    const accessor = Object.defineProperty({}, 'secret-accessor-value', {
      enumerable: true,
      get: () => {
        getterReads += 1
        throw new Error('getter must not run')
      },
    })
    const cyclic: Record<string, unknown> = {
      secret: 'cycle-secret-value',
    }
    cyclic.self = cyclic
    const throwingProxy = new Proxy(
      { secret: 'proxy-secret-value' },
      {
        ownKeys: () => {
          throw new Error('proxy keys unavailable')
        },
        getOwnPropertyDescriptor: () => {
          throw new Error('proxy descriptor unavailable')
        },
      },
    )
    const hostileInputs: unknown[] = [
      9007199254740993n,
      cyclic,
      accessor,
      throwingProxy,
      new Error('error-secret-value'),
    ]
    const events: EvidenceEvent[] = []
    const wrapped = wrapToolSetWithEvidence(
      {
        filesystem_read: tool({
          description: 'read',
          inputSchema: z.unknown(),
          execute: (input) => input,
        }),
      },
      {
        evidenceSink: { record: (item) => events.push(item) },
        describeTool: readDescriptor,
      },
    )
    const execute = requireExecute(wrapped, 'filesystem_read')

    for (const [index, hostileInput] of hostileInputs.entries()) {
      expect(
        await execute(hostileInput, executionOptions(`call-hostile-${index}`)),
      ).toBe(hostileInput)
    }

    expect(getterReads).toBe(0)
    expect(events).toHaveLength(hostileInputs.length * 2)
    for (const item of events) {
      expect(item.argumentDigest).toMatch(/^[a-f0-9]{64}$/)
      if (item.outputDigest !== undefined) {
        expect(item.outputDigest).toMatch(/^[a-f0-9]{64}$/)
      }
      const serialized = JSON.stringify(item)
      expect(serialized).not.toContain('cycle-secret-value')
      expect(serialized).not.toContain('proxy-secret-value')
      expect(serialized).not.toContain('error-secret-value')
      expect(serialized).not.toContain('secret-accessor-value')
    }
  })
})
