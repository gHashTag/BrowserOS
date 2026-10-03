import { describe, expect, it } from 'bun:test'
import {
  type AcceptedTurn,
  creditIssues,
  parseOwnersSince,
} from '../../src/api/services/queen-lane-credits'

const turn = (issue: number, keyIndex: number, day: string): AcceptedTurn => ({
  issue,
  keyIndex,
  dispatchedAt: new Date(`${day}T12:00:00Z`),
})

describe('whose lane carried an accepted issue', () => {
  const owners = {
    0: '@dmitrii-f-t27',
    1: '@dmitrii-f-t27',
    2: 'Trinity community',
    10000: '@alex',
  }

  it('credits the GitHub login that claimed the lane of the latest accepted turn', () => {
    expect(
      creditIssues(
        [
          turn(5, 2, '2026-09-20'),
          turn(5, 0, '2026-09-25'),
          turn(7, 10000, '2026-09-21'),
        ],
        owners,
        {},
      ),
    ).toEqual([
      { issue: 5, github: 'dmitrii-f-t27', at: '2026-09-25T12:00:00.000Z' },
      { issue: 7, github: 'alex', at: '2026-09-21T12:00:00.000Z' },
    ])
  })

  it('leaves out a lane nobody claimed and a name that is not a login', () => {
    expect(
      creditIssues(
        [turn(1, 9, '2026-09-20'), turn(2, 2, '2026-09-20')],
        owners,
        {},
      ),
    ).toEqual([])
  })

  it('does not credit a turn from before the login lent that lane', () => {
    const since = parseOwnersSince('dmitrii-f-t27=2026-09-17')
    expect(
      creditIssues(
        [turn(1, 0, '2026-09-16'), turn(2, 1, '2026-09-17')],
        owners,
        since,
      ),
    ).toEqual([
      { issue: 2, github: 'dmitrii-f-t27', at: '2026-09-17T12:00:00.000Z' },
    ])
  })

  it('reads start dates by login and skips what it cannot read', () => {
    const since = parseOwnersSince(
      ' @Dmitrii-F-T27=2026-09-17, alex=soon, =2026-01-01, bob=2026-10-01',
    )
    expect(Object.keys(since).sort()).toEqual(['bob', 'dmitrii-f-t27'])
    expect(since['dmitrii-f-t27'].toISOString()).toBe(
      '2026-09-17T00:00:00.000Z',
    )
  })
})
