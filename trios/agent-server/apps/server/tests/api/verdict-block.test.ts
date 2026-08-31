import { describe, expect, it } from 'bun:test'
import { parseVerdictBlock } from '../../src/api/services/queen-tick'

/**
 * The bee grades its own work and the Queen acts on that grade without waiting
 * for a person. That makes this parser the last honest gate in the loop, and
 * one rule matters more than the rest: **could-not-check is UNMET**.
 *
 * A criterion nobody verified has not been satisfied. Reading "I could not
 * tell" as "yes" is how work closes on faith, and this repository has closed
 * tasks that way before - the review policy's own escalation text says it:
 * "every criterion is marked met but nothing was committed; a reviewer that
 * passes an empty diff has judged the absence of work rather than the work".
 */
describe('the bee verdict block', () => {
  it('reads met and unmet', () => {
    const said = [
      'I did the thing.',
      '',
      '## VERDICT',
      '- The warm-up waits for the gate: met',
      '- Attempts are spaced past the cooldown: unmet',
    ].join('\n')
    expect(parseVerdictBlock(said)).toEqual([
      { criterion: 'The warm-up waits for the gate', met: true },
      { criterion: 'Attempts are spaced past the cooldown', met: false },
    ])
  })

  // The rule the whole file exists for.
  it('counts could-not-check as unmet, never as met', () => {
    const said = ['## VERDICT', '- make check exits 0: could-not-check'].join(
      '\n',
    )
    const [only] = parseVerdictBlock(said)
    expect(only.met).toBe(false)
  })

  it('is case-insensitive about the grade', () => {
    const said = ['## VERDICT', '- A thing: MET', '- Another: Unmet'].join('\n')
    expect(parseVerdictBlock(said).map((v) => v.met)).toEqual([true, false])
  })

  // A bee that wrote no block has not reported. Returning nothing makes the
  // policy see zero criteria judged, and it answers wait or escalate rather
  // than passing work nobody described.
  it('returns nothing when there is no block', () => {
    expect(parseVerdictBlock('I finished. It looks fine.')).toEqual([])
  })

  // A bee that talks about its verdict earlier and writes the real block at the
  // end must be read at the END. Otherwise a draft beats the final answer.
  it('takes the last block when there are two', () => {
    const said = [
      '## VERDICT',
      '- Draft criterion: unmet',
      '',
      'On reflection I fixed it.',
      '',
      '## VERDICT',
      '- Draft criterion: met',
    ].join('\n')
    expect(parseVerdictBlock(said)).toEqual([
      { criterion: 'Draft criterion', met: true },
    ])
  })

  it('stops at the first line that is not a verdict', () => {
    const said = [
      '## VERDICT',
      '- One: met',
      'and then some prose that should not be parsed as a criterion',
      '- Two: met',
    ].join('\n')
    expect(parseVerdictBlock(said)).toHaveLength(1)
  })

  it('tolerates blank lines inside the block', () => {
    const said = ['## VERDICT', '- One: met', '', '- Two: unmet'].join('\n')
    expect(parseVerdictBlock(said)).toHaveLength(2)
  })

  it('accepts an asterisk bullet as well as a dash', () => {
    const said = ['## VERDICT', '* One: met'].join('\n')
    expect(parseVerdictBlock(said)).toEqual([{ criterion: 'One', met: true }])
  })

  // A criterion quoted from the issue can carry a colon of its own. The grade
  // is the LAST colon-separated token, so the criterion keeps its punctuation.
  it('keeps a criterion that contains a colon', () => {
    const said = [
      '## VERDICT',
      '- Log line: queen.key.warmup appears within 100 s: met',
    ].join('\n')
    const [only] = parseVerdictBlock(said)
    expect(only.criterion).toBe(
      'Log line: queen.key.warmup appears within 100 s',
    )
    expect(only.met).toBe(true)
  })
})
