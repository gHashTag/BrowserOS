import { describe, expect, it } from 'bun:test'
import {
  ACCEPTED_XP,
  githubLoginOf,
  HOUR_XP,
  type KeyWork,
  parseOwners,
  rank,
  xpFor,
} from '../../src/api/services/queen-leaderboard'

/**
 * XP is a reading of work that happened on a lane, not a count of keys lent:
 * a key added and never used carries nothing, and paying for the adding would
 * pay for ten dead keys.
 */
const lane = (
  keyIndex: number,
  accepted: number,
  finished: number,
  hours: number,
): KeyWork => ({
  keyIndex,
  accepted,
  finished,
  hours,
})

describe('who lent a lane', () => {
  it('reads the operator map, and skips what it cannot read', () => {
    expect(parseOwners('0=Dmitrii, 1=@alex ,4=Trinity community')).toEqual({
      0: 'Dmitrii',
      1: '@alex',
      4: 'Trinity community',
    })
    expect(parseOwners('')).toEqual({})
    expect(parseOwners(undefined)).toEqual({})
    expect(parseOwners('nope,=x,3=,-1=a')).toEqual({})
  })

  it('names an unclaimed lane rather than dropping it', () => {
    const [row] = rank([lane(7, 1, 2, 1)], {})
    expect(row.name).toBe('key #7')
    expect(row.claimed).toBe(false)
  })
})

describe('the score', () => {
  it('pays for accepted work and for the hours a bee spent', () => {
    expect(xpFor({ accepted: 2, hours: 3 })).toBe(2 * ACCEPTED_XP + 3 * HOUR_XP)
    expect(xpFor({ accepted: 0, hours: 0 })).toBe(0)
  })

  it('pays nothing for turns that were never accepted, beyond their hours', () => {
    const [row] = rank([lane(0, 0, 5, 2)], { 0: 'Alex' })
    expect(row.xp).toBe(2 * HOUR_XP)
  })

  it('gathers every lane one person lent into one row', () => {
    const [row] = rank([lane(0, 3, 6, 2.5), lane(2, 1, 2, 1.5)], {
      0: 'Dmitrii',
      2: 'Dmitrii',
    })
    expect(row.keys).toEqual([0, 2])
    expect(row.accepted).toBe(4)
    expect(row.finished).toBe(8)
    expect(row.hours).toBe(4)
    expect(row.xp).toBe(4 * ACCEPTED_XP + 4 * HOUR_XP)
  })

  it('ranks by XP, then by turns finished, then by name', () => {
    const ranked = rank(
      [lane(0, 1, 1, 0), lane(1, 1, 9, 0), lane(2, 5, 1, 0), lane(3, 1, 1, 0)],
      { 0: 'Bob', 1: 'Ann', 2: 'Zoe', 3: 'Ada' },
    )
    expect(ranked.map((r) => r.name)).toEqual(['Zoe', 'Ann', 'Ada', 'Bob'])
  })

  it('reads a GitHub login out of an @name, and carries it to the row', () => {
    expect(githubLoginOf('@alex')).toBe('alex')
    expect(githubLoginOf('@torvalds')).toBe('torvalds')
    expect(githubLoginOf('@gHashTag')).toBe('gHashTag')
    expect(githubLoginOf('@a-b-c9')).toBe('a-b-c9')
    const [row] = rank([lane(0, 1, 1, 0)], { 0: '@alex' })
    expect(row.github).toBe('alex')
    expect(row.name).toBe('@alex')
  })

  /**
   * The handle becomes a link to a person's profile and the URL of their
   * avatar, so anything that is not a login must not become one. A plain name
   * is shown as itself; it is never pointed at somebody else's account.
   */
  it('refuses a name that is not a GitHub login', () => {
    for (const name of [
      'Dmitrii',
      'Trinity community',
      '@',
      '@-alex',
      '@alex-',
      '@al--ex',
      '@alex/../torvalds',
      '@alex bob',
      '@alex.png',
      '@' + 'a'.repeat(40),
      'mail@example.com',
    ]) {
      expect(githubLoginOf(name)).toBeUndefined()
    }
    const [row] = rank([lane(0, 1, 1, 0)], { 0: 'Trinity community' })
    expect(row.github).toBeUndefined()
    expect(row.claimed).toBe(true)
  })

  it('gives an unclaimed lane no handle at all', () => {
    const [row] = rank([lane(7, 1, 1, 0)], {})
    expect(row.name).toBe('key #7')
    expect(row.github).toBeUndefined()
    expect(row.claimed).toBe(false)
  })
})
