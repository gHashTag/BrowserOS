/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The #1379 regression test: a round whose dispatches were all refused must
 * report that nothing started, not report a bee working.
 *
 * Imports `bun:test` and the module under test and nothing else. The module
 * has no imports by design - a bee's worktree has no `node_modules`, so this
 * test has to run with neither a database nor the `queend` binary to hand.
 */
import { describe, expect, it } from 'bun:test'
import {
  dispatchesThatStarted,
  nothingStartedLine,
  refusedLines,
  reportHeadline,
  startedLine,
} from '../../src/api/services/queen-report-lines'

/** The refusal `dispatchBee` returns when every provider key is busy - the
 * routine case from the issue, not an exotic failure. */
const KEY_EXHAUSTED_DETAIL =
  'all 1 provider key(s) are already in use by bees in flight. Add another ' +
  'with ZAI_API_KEY_2 (or the equivalent for your provider) to widen the ' +
  'swarm.'

const REFUSAL = 'every provider key is busy; the swarm is a key short'

/** The dispatch lines of a report body, assembled the way `report()` assembles
 * them: the started sentence, then one line per refused dispatch, then the
 * nothing-started sentence when nothing started. */
function dispatchBody(
  outcomes: Parameters<typeof startedLine>[0],
  refusal: string | undefined,
  candidates: number,
): string {
  const lines: string[] = []
  const started = startedLine(outcomes)
  if (started !== '') lines.push(started)
  lines.push(...refusedLines(outcomes))
  if (dispatchesThatStarted(outcomes).length === 0) {
    lines.push(nothingStartedLine(refusal, candidates))
  }
  return lines.join('\n')
}

describe('queen report dispatch lines', () => {
  it('reports a round whose only dispatch was refused as started nothing', () => {
    const outcomes = [
      { started: false, issue: 1234, detail: KEY_EXHAUSTED_DETAIL },
    ]

    // The count is the booleans, not the array length: one refusal is not a
    // worker, however many entries the array holds.
    expect(dispatchesThatStarted(outcomes)).toHaveLength(0)

    const headline = reportHeadline(0, outcomes, REFUSAL)
    expect(headline).not.toContain('bee(s) working')
    expect(headline).toBe(REFUSAL)

    const body = dispatchBody(outcomes, REFUSAL, 3)
    // No sentence claims a bee was started.
    expect(body).not.toContain('Started 1 bee(s)')
    // The refusal is carried verbatim, and the refused issue and its detail
    // are named - the operator reads why, not only that nothing happened.
    expect(body).toContain(REFUSAL)
    expect(body).toContain('#1234')
    expect(body).toContain(KEY_EXHAUSTED_DETAIL)
    expect(body).toContain('3 issue(s) were on the table.')
  })

  it('counts only the dispatch that started in a mixed round', () => {
    const outcomes = [
      { started: true, issue: 11, detail: 'worktree ready; zai/glm-4.6' },
      { started: false, issue: 22, detail: KEY_EXHAUSTED_DETAIL },
    ]

    expect(dispatchesThatStarted(outcomes)).toHaveLength(1)

    // The started sentence is byte-for-byte what it has always been for a
    // round that started one bee, and names only the started issue.
    expect(startedLine(outcomes)).toBe('Started 1 bee(s): #11.')
    expect(startedLine(outcomes)).not.toContain('#22')

    // The refused dispatch is reported separately, with its cause. The
    // detail is a sentence and closes itself; no second period is added.
    expect(refusedLines(outcomes)).toEqual([
      `Refused #22: ${KEY_EXHAUSTED_DETAIL}`,
    ])

    expect(reportHeadline(0, outcomes, REFUSAL)).toBe('1 bee(s) working')
  })

  it('builds an empty round exactly as before', () => {
    expect(dispatchesThatStarted([])).toHaveLength(0)
    expect(startedLine([])).toBe('')
    expect(refusedLines([])).toEqual([])

    // The nothing-started sentence is unchanged, word for word - with a
    // refusal given and with none.
    expect(nothingStartedLine(REFUSAL, 3)).toBe(
      `Started nothing. ${REFUSAL}. 3 issue(s) were on the table.`,
    )
    expect(nothingStartedLine(undefined, 0)).toBe(
      'Started nothing. No reason given. 0 issue(s) were on the table.',
    )

    // An empty round's headline is the refusal, or its default.
    expect(reportHeadline(0, [], REFUSAL)).toBe(REFUSAL)
    expect(reportHeadline(0, [], undefined)).toBe('nothing to do')

    // Escalations still outrank the started count in the headline.
    expect(reportHeadline(2, [{ started: true, issue: 11 }], REFUSAL)).toBe(
      '2 waiting on you',
    )
  })

  it('truncates a long refusal detail the way the stray line truncates', () => {
    const longDetail = 'x'.repeat(400)
    const [line] = refusedLines([
      { started: false, issue: 7, detail: longDetail },
    ])
    // 200 characters shown, '...' marks the cut - and the ellipsis already
    // closes the sentence, so no further period is appended.
    expect(line).toBe(`Refused #7: ${'x'.repeat(200)}...`)

    // A short detail that is not a sentence still gets its closing period.
    const [short] = refusedLines([{ started: false, issue: 8, detail: 'no' }])
    expect(short).toBe('Refused #8: no.')
  })
})
