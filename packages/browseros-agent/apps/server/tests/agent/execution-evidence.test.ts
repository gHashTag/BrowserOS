import { describe, expect, it } from 'bun:test'
import {
  appendEvidence,
  normalizeToolResult,
  type ToolExecutionReceipt,
  type ToolResultObservation,
} from '../../src/agent/execution-evidence'
import type {
  EvidenceEvent,
  NormalizedToolResult,
  ToolEffect,
} from '../../src/agent/execution-types'

type MutableNormalizedToolResult = {
  -readonly [Key in keyof NormalizedToolResult]: NormalizedToolResult[Key]
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
