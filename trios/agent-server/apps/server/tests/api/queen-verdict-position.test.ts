import { describe, expect, it } from 'bun:test'
import {
  briefFor,
  parseVerdictBlock,
} from '../../src/api/services/queen-tick'

// WHY THE BLOCK MOVED TO THE FRONT.
//
// Measured over a three-hour window: 17% of dispatches accepted, 33% sent back,
// 28% answered `wait` - which means the review could not judge them at all.
//
//   #1429  discussed all four criteria in prose, wrote a block of TWO lines
//   #1427  the same
//   #1430  wrote three of four
//   accepted ones  wrote exactly one line per criterion
//
// The block was required to come LAST, after 25-35 kB of prose. The only
// machine-read part of the report sat where a turn that runs short loses it
// first. These pin both halves of the repair: the instruction now says BEGIN,
// and the parser no longer cares where the block is.

const CRITERIA = ['first thing', 'second thing', 'third thing']

describe('the brief asks for the verdict FIRST', () => {
  it('says begin, not end', () => {
    const brief = briefFor(1, 'o/r', ['a.ts'], '', CRITERIA, 'stated')
    expect(brief).toContain('BEGIN your LAST message')
    expect(brief).not.toContain('End your LAST message')
  })

  it('says why, so the instruction is not arbitrary', () => {
    const brief = briefFor(1, 'o/r', ['a.ts'], '', CRITERIA, 'stated')
    expect(brief).toContain('a report that runs')
    expect(brief).toContain('only part read by machine')
  })

  it('still emits one numbered slot per criterion', () => {
    const brief = briefFor(1, 'o/r', ['a.ts'], '', CRITERIA, 'stated')
    for (let i = 1; i <= CRITERIA.length; i++) {
      expect(brief).toContain(`- ${i}. <criterion ${i}`)
    }
  })
})

describe('parseVerdictBlock does not care where the block is', () => {
  const block = [
    '## VERDICT',
    '- first thing: met',
    '- second thing: unmet',
    '- third thing: could-not-check',
  ].join('\n')

  it('reads a block at the very top, followed by prose', () => {
    const said = `${block}\n\nNow the long explanation of what I did.\nWith several paragraphs.\n`
    const v = parseVerdictBlock(said)
    expect(v.length).toBe(3)
    expect(v[0]).toEqual({ criterion: 'first thing', met: true })
    expect(v[1].met).toBe(false)
  })

  it('still reads a block at the very end, so an older brief is not punished', () => {
    const said = `A long report first.\n\nThen the block.\n\n${block}\n`
    expect(parseVerdictBlock(said).length).toBe(3)
  })

  it('prefers the COMPLETE block when the words appear twice', () => {
    // A report that quotes the heading while explaining the rule - or repeats a
    // one-line summary - must not blank the parse. `lastIndexOf` would have
    // taken the later, emptier one.
    const said = `${block}\n\nI was told to write a "## VERDICT" heading first, and did.\n`
    expect(parseVerdictBlock(said).length).toBe(3)
  })

  it('takes the fuller of two real blocks rather than the last', () => {
    const short = '## VERDICT\n- first thing: met\n'
    const said = `${block}\n\nsome prose\n\n${short}`
    expect(parseVerdictBlock(said).length).toBe(3)
  })

  it('returns nothing when there is no block at all', () => {
    expect(parseVerdictBlock('I did the work and it went well.')).toEqual([])
  })

  it('a heading with no bullets under it yields nothing, not a crash', () => {
    expect(parseVerdictBlock('## VERDICT\n\nI could not decide.')).toEqual([])
  })
})
