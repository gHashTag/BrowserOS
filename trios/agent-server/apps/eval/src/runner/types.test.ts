import { describe, expect, it } from 'bun:test'
import { PASS_FAIL_GRADER_ORDER } from '../graders/registry'
import type { TaskResult } from './types'
import { getPrimaryGraderResult, isSuccessfulResult } from './types'

/**
 * Contract suite for the runner's result-type helpers.
 *
 * Both exported symbols of this module are pure functions, so every export
 * is exercised below and none is blocked by a live dependency.
 */

function taskResult(status: TaskResult['status']): TaskResult {
  // The guard under test reads only the discriminant, so a minimal carrier
  // is enough to observe its behaviour for each status variant.
  return { status } as unknown as TaskResult
}

function grader(
  pass: boolean,
  score: number,
): { pass: boolean; score: number } {
  return { pass, score }
}

describe('typesContract', () => {
  describe('isSuccessfulResult', () => {
    it('isSuccessfulResult accepts completed and timeout, rejects failed', () => {
      expect(isSuccessfulResult(taskResult('completed'))).toBe(true)
      expect(isSuccessfulResult(taskResult('timeout'))).toBe(true)
      expect(isSuccessfulResult(taskResult('failed'))).toBe(false)
    })
  })

  describe('getPrimaryGraderResult', () => {
    it('getPrimaryGraderResult prefers declared precedence over insertion order, falls back to the first entry, and yields null when empty', () => {
      // No graders at all: nothing to report.
      expect(getPrimaryGraderResult({})).toBeNull()

      // Only graders outside the declared order: the first one that was
      // added to the record wins, with its name merged into the value.
      expect(
        getPrimaryGraderResult({
          custom_a: grader(false, 0.25),
          custom_b: grader(true, 0.9),
        }),
      ).toEqual({ name: 'custom_a', pass: false, score: 0.25 })

      // Declared graders added in reverse precedence: the earliest name in
      // the declared order wins even though a later one was added first.
      const [head, ...tail] = PASS_FAIL_GRADER_ORDER
      const reversed: Record<string, { pass: boolean; score: number }> = {}
      for (const name of [...tail].reverse()) {
        reversed[name] = grader(false, 0.1)
      }
      reversed[head] = grader(true, 1)
      expect(getPrimaryGraderResult(reversed)).toEqual({
        name: head,
        pass: true,
        score: 1,
      })

      // Even the lowest-precedence declared grader beats an unknown grader
      // that was added to the record before it.
      const lastDeclared =
        PASS_FAIL_GRADER_ORDER[PASS_FAIL_GRADER_ORDER.length - 1]
      expect(
        getPrimaryGraderResult({
          custom_a: grader(true, 1),
          [lastDeclared]: grader(false, 0),
        }),
      ).toEqual({ name: lastDeclared, pass: false, score: 0 })
    })
  })
})
