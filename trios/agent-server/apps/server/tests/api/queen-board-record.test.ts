import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boardTask } from '../../src/api/services/queen-tick'

/**
 * The board record the cloud tick hands to `queend` is a hand-built stand-in
 * for a Swift type it cannot import. Swift's synthesised Codable refuses the
 * WHOLE document when one key is missing, so a record short of a field does not
 * degrade - the round dies and the Queen dispatches nobody.
 *
 * It has happened twice, and the second time is why this file exists:
 *
 *   codingPath: ["tasks", "Index 67"]  "Expected date string to be ISO8601"
 *   codingPath: ["tasks", "Index 70"]  keyNotFound("acceptanceCriteria")
 *
 * Both hid the same way. A running bee is only put on the board when a bee is
 * already running, and the swarm's ceiling was one - so the malformed record
 * was never built. The round that finally started a second bee was the round
 * that started failing, which made a fix look like a regression.
 *
 * A test that only checked today's field list would go stale the moment someone
 * adds a field in Swift. So this reads the Swift source and compares.
 */

const SWIFT = {
  // What `queend` actually compiles. This one IS the contract.
  compiled: join(
    import.meta.dir,
    '../../../../queen-core/Sources/QueenPolicy/QueenDelegation.swift',
  ),
  // The app's copy. Kept in step by hand, which is its own hazard.
  app: join(
    import.meta.dir,
    '../../../../../rings/SR-00/QueenDelegation.swift',
  ),
}

/**
 * The non-optional stored properties of `DelegatedTask` - the ones Swift will
 * demand. `var x: T?` has a default of nil and may be absent; `var x: T` may
 * not. Computed properties are skipped: a `{` on the line means a body, not
 * storage, and `isSettled` is exactly that.
 */
function requiredFields(path: string): string[] {
  const source = readFileSync(path, 'utf8')
  const start = source.indexOf('public struct DelegatedTask')
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start)
  const end = body.indexOf('\n}')
  const fields: string[] = []
  for (const line of body.slice(0, end).split('\n')) {
    const m = line.match(/^\s+public (?:let|var) ([A-Za-z]+): ([^=]+)$/)
    if (!m) continue
    const type = m[2].trim()
    if (type.endsWith('?') || type.includes('{')) continue
    fields.push(m[1])
  }
  return fields
}

describe('the board record the cloud tick sends to queend', () => {
  const record = boardTask('gHashTag', 'trios', {
    conversationId: null,
    issue: 1176,
    ownedPaths: ['rings/SR-00/QueenLocalisation.swift'],
    branch: 'queen-1176',
    at: '2026-08-31T13:48:10.523Z',
    title: 'dispatched by the cloud tick',
  })

  it('carries every field Swift will demand', () => {
    const required = requiredFields(SWIFT.compiled)
    // If the parser found nothing, it is broken and would pass anything.
    expect(required.length).toBeGreaterThan(8)
    expect(required).toContain('acceptanceCriteria')

    const missing = required.filter((f) => !(f in record))
    expect(missing).toEqual([])
  })

  // Drift between the two copies means the app and the supervisor disagree
  // about what a task is, and only one of them is checked above.
  it('is checked against a type the app has not drifted from', () => {
    expect(requiredFields(SWIFT.app)).toEqual(requiredFields(SWIFT.compiled))
  })

  // The first of the two refusals. Postgres hands back a Date and
  // JSON.stringify writes milliseconds; Swift's .iso8601 refuses them.
  it('writes dates without a fractional second', () => {
    expect(record.createdAt).toBe('2026-08-31T13:48:10Z')
    expect(record.updatedAt).toBe('2026-08-31T13:48:10Z')
  })

  it('substitutes a zero uuid rather than omitting an id', () => {
    expect(record.id).toBe('00000000-0000-0000-0000-000000000000')
    expect(record.conversationId).toBe(record.id)
  })
})
