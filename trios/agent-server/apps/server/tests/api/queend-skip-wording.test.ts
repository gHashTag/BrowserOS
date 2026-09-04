import { describe, expect, it } from 'bun:test'
import { spokenForWordingParity } from '../../../../../tools/queend-skip-wording.mjs'

/**
 * The wording-parity gate for the chooser's skip sentences, proven in both
 * directions.
 *
 * WHAT IT PINS. The choose loop in queen-core/Sources/queend/main.swift used
 * to compose its own sentence for a candidate it passed over, and for every
 * state claimOnIssue counts as live - queued included - that sentence said a
 * worker had it. A queued task means a dispatch never happened: the issue is
 * claimed and stuck, not busy, and busy and stuck are the two readings that
 * call for opposite actions. The corrected wording lives in
 * QueenDelegationPolicy.spokenForReport and the chooser must take its
 * sentence from there. The gate keeps that true; these tests keep the gate
 * honest, because a gate that has never been seen to fail is not evidence.
 *
 * The gate is plain Node with no dependencies, which is why it can run in
 * the worker container: the same environment that cannot compile Swift can
 * still refuse to let the container's wording drift from the policy's.
 */

describe('queend-skip-wording', () => {
  it('accepts the shipped main.swift', () => {
    const result = spokenForWordingParity()
    expect(result.cannotCheck).toBeNull()
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
    // An empty scan is not success: there must be sites to have scanned, and
    // the policy must have yielded the vocabulary the rule enforces.
    expect(result.sites).toBeGreaterThan(0)
    expect(result.claimWords.length).toBeGreaterThan(0)
  })

  it('rejects a hand-written worker claim', () => {
    // The pre-change shape, built here as the negative control - a copy of
    // the defect, not of the policy. A live claim reported in the chooser's
    // own words is exactly what the gate exists to catch, whatever line it
    // moves to.
    const before = [
      'var skipped: [String] = []',
      'for number in candidates {',
      '    let states = tasks.filter { $0.issue.number == number }.map(\\.state)',
      '    let claim = QueenDelegationPolicy.claimOnIssue(states: states)',
      '    switch claim {',
      '    case .live(let state):',
      '        skipped.append("#\\(number): a worker has it or is expected back "',
      '            + "(\\(state.rawValue))")',
      '        continue',
      '    default: break',
      '    }',
      '}',
    ].join('\n')
    const result = spokenForWordingParity({ mainSource: before })
    expect(result.cannotCheck).toBeNull()
    expect(result.ok).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
    // The append itself is named, with its line.
    expect(result.violations[0].line).toBe(7)
    expect(result.violations[0].reasons.join(' ')).toContain('worker')
  })

  it('refuses success when the policy has no spokenForReport to read', () => {
    // The gate derives its vocabulary from the policy at run time, so a
    // policy it cannot read must be a failure, never a quiet pass.
    const result = spokenForWordingParity({
      policySource: 'enum QueenDelegationPolicy {\n}\n',
    })
    expect(result.ok).toBe(false)
    expect(result.cannotCheck).not.toBeNull()
    expect(String(result.cannotCheck)).toContain('spokenForReport')
  })
})
