import { describe, expect, it } from 'bun:test'
import {
  briefFor,
  missingVerdictSlots,
} from '../../src/api/services/queen-tick'

/**
 * The other half of the same 91-hour block (#1421).
 *
 * Five dispatches on 2026-09-04 were returned or escalated with the reviewer
 * reporting "Finished work omitted N verdict lines", where N equalled the
 * number of criteria called unmet. The workers did not refuse to answer.
 * The brief already numbered the criteria - but it did not require the
 * report to be numbered the same way, so a worker writing prose about its
 * work satisfied the letter of the instruction and none of its purpose, and
 * nothing checked before the turn ended.
 *
 * Two things close that gap, and this file holds both:
 *
 *   `briefFor` hands the bee a VERDICT template with one numbered slot per
 *   criterion, and says in words that an omitted slot is read as unmet - so
 *   answering is unmissable rather than implied.
 *
 *   `missingVerdictSlots` names the numbers a given report leaves
 *   uncovered, reading the same block `parseVerdictBlock` reads - so the
 *   check exists as a function before anything wires it into the turn.
 *
 * The template appears ONLY when the task states criteria. A task with none
 * is unchanged: its bee is asked to state its own criteria first, and
 * numbering slots nobody has written yet would number nothing.
 */

/** The issue's own five criteria, verbatim, to build the brief against. */
const FIVE = [
  '`bun test apps/server/tests/api/queen-verdict-template.test.ts` passes',
  'The tick defines a function named `missingVerdictSlots`',
  'Given a brief built for five criteria, the test asserts the emitted text contains the five slots `1.` through `5.` under a `## VERDICT` heading',
  'Given a report text covering slots 1, 2 and 4 of five, `missingVerdictSlots` returns exactly `[3, 5]`',
  'Given a task whose criteria list is empty, the brief contains no VERDICT template at all',
]

const brief = (criteria: string[], source = 'stated') =>
  briefFor(
    1421,
    'gHashTag/trios',
    ['agent-server/apps/server/src/api/services/queen-tick.ts'],
    '## Success Criteria\n- The slots are numbered.\n',
    criteria,
    source,
  )

/**
 * The text under the `## VERDICT` heading and nothing else: the criteria are
 * numbered in their own section above it, so a check for the slot numbers
 * must not be satisfied by those.
 */
function verdictBlockOf(text: string): string {
  const at = text.lastIndexOf('## VERDICT')
  expect(at).toBeGreaterThanOrEqual(0)
  const rest = text.slice(at)
  const nextHeading = rest.indexOf('\n## ')
  return nextHeading < 0 ? rest : rest.slice(0, nextHeading)
}

/** Every numbered slot line in a block, e.g. `- 3. <criterion 3, ...`. */
const slotLines = (block: string): string[] =>
  block.match(/^[ \t]*[-*][ \t]+\d+\./gm) ?? []

describe('the brief hands the bee a numbered VERDICT template', () => {
  it('numbers one slot per criterion, exactly five for five', () => {
    const block = verdictBlockOf(brief(FIVE))
    const slots = slotLines(block)
    // Exactly five numbered lines - not four, not a sixth invented one.
    expect(slots).toHaveLength(5)
    for (let i = 1; i <= 5; i++) {
      expect(block).toContain(`- ${i}. `)
    }
    expect(block).not.toContain('- 6. ')
  })

  // FR-001's second half: the omission rule must be in words, because the
  // defect it answers was a worker satisfying the letter of an instruction
  // and none of its purpose. The rule is the purpose, stated.
  it('says in words that an omitted slot is read as unmet', () => {
    expect(brief(FIVE)).toContain('read as unmet')
  })

  // The template must be emitted only when the task states criteria, so a
  // task with none is unchanged (FR-003). Its brief keeps the standing
  // generic request - the bee that states its own criteria still needs the
  // block's shape - but not one numbered slot of the template appears,
  // under the heading or anywhere else in the brief.
  it('emits no VERDICT template at all when the criteria list is empty', () => {
    const text = brief([], 'none')
    expect(slotLines(verdictBlockOf(text))).toEqual([])
    expect(text.match(/^[ \t]*[-*][ \t]+\d+\./gm) ?? []).toEqual([])
  })

  // The worker that answers in prose is the case the incident was made of.
  // The helper must not credit it: numbers are the contract now.
  it('tells the bee to fill in every unanswered number before it stops', () => {
    expect(brief(FIVE)).toContain('fill in every number you have not answered')
  })
})

describe('missingVerdictSlots', () => {
  // The issue's own worked example: a report covering slots 1, 2 and 4 of
  // five leaves exactly 3 and 5 uncovered.
  it('names the numbers a report leaves unanswered', () => {
    const report = [
      'Done. The template is in the brief and the helper is exported.',
      '',
      '## VERDICT',
      '- 1. `bun test apps/server/tests/api/queen-verdict-template.test.ts` passes: met',
      '- 2. The tick defines a function named `missingVerdictSlots`: met',
      '- 4. Given a report text covering slots 1, 2 and 4 of five, `missingVerdictSlots` returns exactly `[3, 5]`: met',
    ].join('\n')
    expect(missingVerdictSlots(report, 5)).toEqual([3, 5])
  })

  // A report with no block has covered nothing - the answer that names
  // every slot, never a guess about which prose meant which criterion.
  it('reports every slot missing when there is no block', () => {
    expect(missingVerdictSlots('I finished. It all looks fine.', 5)).toEqual([
      1, 2, 3, 4, 5,
    ])
  })

  // The old order-based reading would call the first of these lines slot 1
  // and the second slot 2. It must not: a line without its number has not
  // answered a numbered slot.
  it('does not credit a report that answered in prose without numbers', () => {
    const prose = [
      '## VERDICT',
      '- The test passes: met',
      '- The helper exists: met',
    ].join('\n')
    expect(missingVerdictSlots(prose, 2)).toEqual([1, 2])
  })

  // Slots outside the promise cover nothing: a bee that miscounts and
  // writes a sixth line has still not answered the fifth.
  it('ignores a number the template never promised', () => {
    const report = [
      '## VERDICT',
      '- 1. One: met',
      '- 2. Two: met',
      '- 6. A slot that was never set: met',
    ].join('\n')
    expect(missingVerdictSlots(report, 3)).toEqual([3])
  })
})
