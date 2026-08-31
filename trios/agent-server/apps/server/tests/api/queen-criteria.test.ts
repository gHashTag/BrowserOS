import { describe, expect, it } from 'bun:test'
import { briefFor } from '../../src/api/services/queen-tick'

/**
 * A bee is judged against acceptance criteria and used to be told none.
 *
 * Measured on the live board, 2026-08-31. Three bees finished real work -
 * 38 989, 56 258 and 12 989 characters of transcript across #1244, #1240 and
 * #1216 - and every one of them was written off with the same sentence:
 *
 *   "the task has no acceptance criteria, so there is nothing to judge it
 *    against - it can only be abandoned or accepted on faith"
 *
 * The criteria were in the issues. Two things kept them from arriving:
 * `criteriaFromIssue` knew four headings and `## Success Criteria` - the one
 * the repository's own spec rule mandates - was not among them; and the cloud
 * tick never asked for them at all, sending an empty list with every dispatch.
 *
 * So the swarm could start work and could not finish it, and every finished
 * task escalated to the operator - who had just said the Queen must not wait on
 * their review. This file holds the last few inches of that path.
 */
describe('the brief tells the bee what it will be judged by', () => {
  const brief = (criteria: string[], source = 'stated') =>
    briefFor(
      1176,
      'gHashTag/trios',
      ['rings/SR-00/QueenLocalisation.swift'],
      '## Success Criteria\n- `make check` exits 0.\n',
      criteria,
      source,
    )

  it('lists the criteria, numbered, in the issue order', () => {
    const text = brief(['`make check` exits 0.', 'No event name is a literal.'])
    expect(text).toContain('## What you will be judged by')
    expect(text).toContain('1. `make check` exits 0.')
    expect(text).toContain('2. No event name is a literal.')
  })

  it('says when they were stood in for by the requirements', () => {
    const text = brief(['**FR-001**: It MUST wait.'], 'requirements')
    expect(text).toContain('numbered requirements')
    expect(text).toContain('1. **FR-001**: It MUST wait.')
  })

  // The case that must not silently produce an unjudgeable task again.
  it('asks the bee to state its own when the issue names none', () => {
    const text = brief([], 'none')
    expect(text).toContain('states no acceptance criteria')
    expect(text).toContain('will be judged by')
    // And it must be honest about whose criteria those are.
    expect(text).toContain('YOUR criteria')
  })

  // The verdict block is what the review parses. If the brief stops asking for
  // it in the exact shape, `parseVerdictBlock` reads nothing and the review is
  // back to judging against zero.
  it('still demands the verdict block the reviewer parses', () => {
    const text = brief(['One thing.'])
    expect(text).toContain('## VERDICT')
    expect(text).toContain('met | unmet | could-not-check')
    expect(text.indexOf('## VERDICT')).toBeGreaterThan(
      text.indexOf('## What you will be judged by'),
    )
  })

  it('keeps telling the bee its boundary and that it must not push', () => {
    const text = brief(['One thing.'])
    expect(text).toContain('rings/SR-00/QueenLocalisation.swift')
    expect(text).toContain('Do NOT push')
  })
})
