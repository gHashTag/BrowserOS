import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  reviewFinishedDispatches,
  unjudgedCriteria,
} from '../../src/api/services/queen-tick'

/**
 * #1420. Silence and failure, told apart.
 *
 * Measured 2026-09-04, from the six dispatches parked at the retry ceiling,
 * the unmet count WAS the omitted count in every one - #1133, #1175, #1316,
 * #1318, #1311 - and in none of them had the criteria been judged and failed.
 * The review marks a criterion unmet when the VERDICT block carries no line
 * for it, which is the correct default: an unanswered criterion is not a
 * satisfied one. But the record could not say WHICH kind of unmet a criterion
 * was, so a worker reading "4 criterion(s) not met" heard "I failed four
 * things" when four things had merely never been mentioned, and three of the
 * six burned their whole retry budget - reached `maximumRealAttempts`, asked
 * for a person - without the work ever being assessed. The oldest waited 91
 * hours.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. The policy is real - `queend`, the same
 * binary the container runs - because sendBack-versus-wait is the policy's
 * call and a stub of it would prove the stub. The database is a recording
 * fake, because the assertion is about which statements the review issues;
 * the workspace is pointed at a directory that does not exist so
 * `committedFiles` returns empty deterministically rather than reading
 * whatever happens to be on the machine running the suite. The unit tests at
 * the top need none of that and always run.
 *
 * HONEST LIMIT, stated because a quiet skip is how a gate comes to report
 * success it never earned: on a machine with neither the worktree build of
 * `queend` nor the container's `/usr/local/bin/queend`, the behaviour tests
 * below DO NOT RUN. The first describe always runs, so the function under
 * test cannot drift unnoticed.
 */

const BIN = [
  // The machine that has built the policy: the same binary the round drives.
  join(import.meta.dir, '../../../../queen-core/.build/release/queend'),
  // The container: the installed path `queendPath()` falls back to.
  '/usr/local/bin/queend',
].find(existsSync)
const present = Boolean(BIN)

const ISSUE = 1420

/**
 * Five criteria, phrased the way an issue's own Success Criteria section
 * would phrase them. Distinct openings on purpose: the send-back test below
 * asserts one criterion appears under one heading and not the other, and a
 * substring of one criterion inside another would blur that.
 */
const FIVE = [
  'The tab strip scrolls on trackpad input',
  'The review records judged and unjudged separately',
  'The send-back names both lists under their own headings',
  'A silent attempt does not spend the retry ceiling',
  'A judged failure does spend the retry ceiling',
]

/** A verdict block answering the first N criteria, met or unmet as given. */
const block = (answers: Array<{ of: string; met: boolean }>): string =>
  ['## VERDICT', ...answers.map((a) => `- ${a.of}: ${a.met ? 'met' : 'unmet'}`)].join('\n')

describe('unjudgedCriteria, the difference itself', () => {
  /**
   * The fact the whole issue turns on. A block that answered two of five
   * leaves exactly the other three, in the order they were promised - and a
   * criterion that was judged UNMET is not among them, because it was judged.
   */
  it('names the criteria no verdict line answered', () => {
    const judged = [
      { criterion: FIVE[0], met: true },
      { criterion: FIVE[1], met: false },
    ]
    const silent = unjudgedCriteria(FIVE, judged)
    expect(silent).toEqual(FIVE.slice(2))
    // The judged failure is a failure, not a silence - the two lists the
    // send-back will name must not overlap.
    expect(silent).not.toContain(FIVE[1])
  })

  it('returns nothing when the block answered every criterion', () => {
    expect(
      unjudgedCriteria(FIVE, FIVE.map((c) => ({ criterion: c, met: true }))),
    ).toEqual([])
  })

  /**
   * A bee quotes the criteria "in the issue's own words", but a quote is not
   * a copy: backticks, punctuation and case all drift. Comparing exactly
   * would call a faithfully quoted criterion omitted - which is how this bug
   * would come back wearing a different hat.
   */
  it('matches a verdict line that quoted the criterion loosely', () => {
    const promised = ['`make check` exits 0.', 'No event name is A Literal.']
    const judged = [
      { criterion: 'make check exits 0', met: true },
      { criterion: 'no event name is a literal', met: true },
    ]
    expect(unjudgedCriteria(promised, judged)).toEqual([])
  })

  /**
   * `parseVerdictBlock` slices a line's criterion at 300 characters, so a
   * line quoting a long criterion holds only its beginning. The promised
   * text contains the line's text and not the other way round - the match
   * has to work in that direction or every long criterion reads as omitted.
   */
  it('matches the truncated quote of a criterion longer than the parser keeps', () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`)
    const long = words.join(' ') // about 340 characters
    const quoted = words.slice(0, 30).join(' ') // the first 300, at a word boundary
    expect(long.length).toBeGreaterThan(300)
    expect(
      unjudgedCriteria([long], [{ criterion: quoted, met: true }]),
    ).toEqual([])
  })

  /**
   * The containment guard. Without it, a short line - "warm-up: met" - is
   * contained by any criterion that mentions the word, and one word would
   * judge the whole contract. Twelve characters of overlap before
   * containment counts is the fence; an exact match always counts.
   */
  it('does not let a short line judge everything that mentions it', () => {
    expect(
      unjudgedCriteria(['The warm-up waits for the gate'], [
        { criterion: 'warm-up', met: true },
      ]),
    ).toEqual(['The warm-up waits for the gate'])
  })

  it('counts an exact match however short', () => {
    expect(
      unjudgedCriteria(['warm-up'], [{ criterion: 'warm-up', met: true }]),
    ).toEqual([])
  })
})

interface FinishedRow {
  issue: number
  conversation_id: string
  criteria: string[]
  criteria_source: string
  send_backs: number
  owned_paths: string[]
  said: string
}

function finishedRow(over: Partial<FinishedRow> = {}): FinishedRow {
  return {
    issue: ISSUE,
    conversation_id: '00000000-0000-0000-0000-0000000005ac',
    criteria: FIVE,
    criteria_source: 'stated',
    send_backs: 0,
    owned_paths: ['docs/only-1420.md'],
    said: '',
    ...over,
  }
}

/**
 * Postgres, answering the shapes the review asks for and recording all of
 * them. The same fake the round's own suite drives, matched on statement
 * fragments rather than on order, because what the review WRITES is the
 * thing under test here.
 */
function reviewPool(finished: FinishedRow[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: String(sql), params })
      if (String(sql).includes('FROM queen_dispatch d')) {
        return { rowCount: finished.length, rows: finished }
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, queries }
}

/** The UPDATE that records a verdict, as opposed to the reaper's. */
const reviewUpdate = (queries: Array<{ sql: string; params: unknown[] }>) =>
  queries.find(
    (q) =>
      q.sql.includes('UPDATE queen_dispatch') &&
      q.sql.includes('review_state ='),
  )

describe('the review, against the real policy', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['TRIOS_QUEEND_PATH', 'WORKSPACE_DIR']) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    if (BIN) process.env.TRIOS_QUEEND_PATH = BIN
    // A workspace that is not there: `committedFiles` runs git in it, fails,
    // and returns nothing - which is what this suite wants to be true every
    // time, on every machine.
    process.env.WORKSPACE_DIR = join(tmpdir(), 'queen-review-unjudged-no-such')
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  /**
   * THE ACCEPTANCE SCENARIO. A VERDICT block covering 2 of 5 criteria, both
   * judged met: the result reports judged 2 and unjudged 3 (FR-001), and the
   * attempt does not count against the retry ceiling (FR-003), because no
   * criterion the bee was given was attempted and failed - the unmet three
   * are unmet by omission, and the retry counter measures judged-and-found-
   * wanting. `send_backs` starts at 1 rather than 0 so "did not advance" is
   * a fact about this round and not the default of a fresh row.
   */
  it.if(present)(
    'reports judged 2, unjudged 3, and leaves the retry counter alone',
    async () => {
      const { pool, queries } = reviewPool([
        finishedRow({
          send_backs: 1,
          said: [
            'I did the two things I could reach.',
            '',
            block([
              { of: FIVE[0], met: true },
              { of: FIVE[1], met: true },
            ]),
          ].join('\n'),
        }),
      ])

      const reviewed = await reviewFinishedDispatches(pool)

      expect(reviewed.acted).toEqual([`#${ISSUE}:sendBack`])
      // FR-001: judged and unjudged recorded as separate numbers.
      expect(reviewed.tally).toEqual([
        { issue: ISSUE, judged: 2, unjudged: 3 },
      ])

      const update = reviewUpdate(queries)
      expect(update?.params[1]).toBe('sendBack')
      // FR-003: the increment is fenced by the boolean, and the boolean is
      // false - the counter does not advance.
      expect(update?.sql).toContain('$5::boolean')
      expect(update?.params[4]).toBe(false)
    },
  )

  /**
   * The control, and the other half of FR-003. A block that covered all five
   * with two judged failures reports unjudged 0, and the attempt DOES count:
   * work was attempted and found wanting, which is what the retry ceiling
   * budgets for. Without this case the one above could pass by never
   * counting anything at all.
   */
  it.if(present)(
    'counts the attempt when a criterion was judged and failed',
    async () => {
      const { pool, queries } = reviewPool([
        finishedRow({
          said: block([
            { of: FIVE[0], met: true },
            { of: FIVE[1], met: true },
            { of: FIVE[2], met: false },
            { of: FIVE[3], met: false },
            { of: FIVE[4], met: true },
          ]),
        }),
      ])

      const reviewed = await reviewFinishedDispatches(pool)

      expect(reviewed.tally).toEqual([
        { issue: ISSUE, judged: 5, unjudged: 0 },
      ])

      const update = reviewUpdate(queries)
      expect(update?.params[1]).toBe('sendBack')
      expect(update?.sql).toContain('send_backs + 1')
      expect(update?.params[4]).toBe(true)
    },
  )

  /**
   * FR-002 and the first user story. A send-back naming four unmet criteria
   * where ONE was tested and failed and THREE were never written a verdict
   * line for: the worker reading it must be able to tell "you did not do
   * this" from "you did not say whether you did this", so the two lists sit
   * under distinct headings and each criterion appears under exactly one.
   *
   * And the budget, spent: this unmet list is NOT all silence, so the
   * attempt counts. Only the wholly-silent round is excused.
   */
  it.if(present)(
    'names the tested failures and the silences under distinct headings',
    async () => {
      const { pool, queries } = reviewPool([
        finishedRow({
          said: block([
            { of: FIVE[0], met: false },
            { of: FIVE[1], met: true },
          ]),
        }),
      ])

      const reviewed = await reviewFinishedDispatches(pool)

      expect(reviewed.tally).toEqual([
        { issue: ISSUE, judged: 2, unjudged: 3 },
      ])

      const update = reviewUpdate(queries)
      expect(update?.params[1]).toBe('sendBack')
      // Four unmet, one of them judged: the attempt counts (FR-003's "ALL
      // unjudged" is an AND, not an OR).
      expect(update?.params[4]).toBe(true)

      const note = String(update?.params[2])
      const atFailed = note.indexOf('Criteria that were tested and failed:')
      const atSilent = note.indexOf(
        'Criteria you never wrote a verdict line for',
      )
      expect(atFailed).toBeGreaterThanOrEqual(0)
      expect(atSilent).toBeGreaterThan(atFailed)
      const failedList = note.slice(atFailed, atSilent)
      const silentList = note.slice(atSilent)
      // The tested failure under its own heading, and nowhere else.
      expect(failedList).toContain(FIVE[0])
      expect(silentList).not.toContain(FIVE[0])
      // Every silence under the other heading, and nowhere else.
      for (const criterion of FIVE.slice(2)) {
        expect(silentList).toContain(criterion)
        expect(failedList).not.toContain(criterion)
      }
    },
  )

  /**
   * The boundary of the boundary. A transcript with NO verdict block at all
   * is not a wall of omissions: it is the torn-or-slow-transcript signature
   * the wait state exists for (#1335), and the frozen-wait valve - not the
   * retry ceiling - is what releases it if the transcript never arrives. So
   * the policy is asked about zero verdicts and answers wait, and nothing is
   * spent. Told apart, too: judged 0 is a different fact from judged 2.
   */
  it.if(present)(
    'still reads a wholly absent block as a wait',
    async () => {
      const { pool, queries } = reviewPool([
        finishedRow({ said: 'I finished. It all looks fine to me.' }),
      ])

      const reviewed = await reviewFinishedDispatches(pool)

      expect(reviewed.tally).toEqual([
        { issue: ISSUE, judged: 0, unjudged: 5 },
      ])

      const update = reviewUpdate(queries)
      expect(update?.params[1]).toBe('wait')
      expect(update?.params[4]).toBe(false)
    },
  )
})
