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

function result(
  overrides: Partial<NormalizedToolResult> = {},
): NormalizedToolResult {
  return {
    transportStatus: 'received',
    executionStatus: 'success',
    effectStatus: 'none',
    verificationStatus: 'not-required',
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
      name: 'marks a successful read as effect-free and not requiring verification',
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
    ).toEqual(result())
    expect(reads).toBe(0)
  })

  it.each([
    ['applied', 'passed'],
    ['partial', 'failed'],
    ['none', 'not-required'],
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
    ).toEqual(
      result({
        executionStatus: 'denied',
        verificationStatus: 'passed',
      }),
    )
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
        effectStatus: 'unknown',
        verificationStatus: 'not-run',
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

  it('preserves deeply frozen prior event identity', () => {
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

    expect(next[0]).toBe(priorEvent)
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
})
