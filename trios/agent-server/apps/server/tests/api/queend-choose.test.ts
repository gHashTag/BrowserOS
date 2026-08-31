import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The chooser, driven as the round drives it: a real `queend`, a real board.
 *
 * WHAT IT PINS. The chooser skipped any issue that had a task in ANY state -
 * "a task already exists for it". Its own doc comment listed the states it
 * meant, and `cancelled` and `failed` were not among them. They were excluded
 * anyway, so an abandoned or failed attempt silenced its issue for good.
 *
 * Measured on the live board 2026-08-31: of 40 candidates, six were unreachable
 * for this reason - #1127, #1147, #1173, #1286 cancelled and #1111, #1133
 * failed - all six still open on GitHub. A failure is the state that most
 * plainly means "do this again".
 *
 * WHY THE BINARY AND NOT A UNIT TEST. `queen-core` has no test target, and
 * XCTest does not link under the CommandLineTools toolchain this repository
 * builds with. Driving the shipped binary is the strongest proof available and
 * it tests the thing that actually runs.
 *
 * HONEST LIMIT, stated because a quiet skip is how a gate comes to report
 * success it never earned: on a machine that has not built `queend`, the
 * behaviour tests below DO NOT RUN. `binary is where the container expects it`
 * always runs, so the path cannot drift unnoticed.
 */

const BIN = join(
  import.meta.dir,
  '../../../../queen-core/.build/release/queend',
)
const DOCKERFILE = join(import.meta.dir, '../../../../Dockerfile')
const present = existsSync(BIN)

function ask(question: unknown): Record<string, unknown> {
  const run = spawnSync(BIN, {
    input: JSON.stringify(question),
    encoding: 'utf8',
  })
  return JSON.parse(run.stdout)
}

function task(issue: number, state: string) {
  const id = `00000000-0000-0000-0000-0000000000${String(issue % 100).padStart(2, '0')}`
  return {
    id,
    conversationId: id,
    issue: { owner: 'gHashTag', repo: 'trios', number: issue },
    title: 'a recorded task',
    worker: 'w',
    state,
    ownedPaths: [],
    virtualBranch: null,
    createdAt: '2026-08-31T10:00:00Z',
    updatedAt: '2026-08-31T10:00:00Z',
    acceptanceCriteria: [],
    interventions: [],
    criterionVerdicts: {},
  }
}

const body = (n: number) =>
  [
    '## Success Criteria',
    '- make check exits 0.',
    '',
    '## Boundary',
    `\`docs/only-${n}.md\``,
  ].join('\n')

const board = (numbers: number[], tasks: Array<ReturnType<typeof task>>) => ({
  kind: 'choose',
  candidates: numbers,
  candidateBodies: Object.fromEntries(numbers.map((n) => [String(n), body(n)])),
  tasks,
})

describe('queend chooses the next bee', () => {
  // Runs everywhere. If the binary moves, this fails rather than letting the
  // suite above quietly stop testing anything.
  it('is where the container expects it', () => {
    expect(readFileSync(DOCKERFILE, 'utf8')).toContain('queend')
    expect(BIN.endsWith('/queend')).toBe(true)
  })

  it.skipIf(!present)('picks up an issue whose attempt failed', () => {
    const answer = ask(board([1111], [task(1111, 'failed')]))
    expect(answer.chosen).toBe(1111)
  })

  it.skipIf(!present)('picks up an issue whose task was cancelled', () => {
    const answer = ask(board([1127], [task(1127, 'cancelled')]))
    expect(answer.chosen).toBe(1127)
  })

  it.skipIf(!present)('leaves work that already landed alone', () => {
    const answer = ask(board([1137], [task(1137, 'accepted')]))
    // Swift omits a nil rather than encoding null, so the key is absent.
    expect(answer.chosen ?? null).toBeNull()
    expect(String(answer.skipped)).toContain('already landed')
  })

  it.skipIf(!present)('leaves an issue a worker is on', () => {
    const answer = ask(board([1176], [task(1176, 'running')]))
    // Swift omits a nil rather than encoding null, so the key is absent.
    expect(answer.chosen ?? null).toBeNull()
    expect(String(answer.skipped)).toContain('a worker has it')
  })

  // rejected means the Queen sent it back and the same bee is expected to
  // return to those files. Handing it to someone else is a collision.
  it.skipIf(!present)('leaves an issue that was sent back', () => {
    const answer = ask(board([1175], [task(1175, 'rejected')]))
    // Swift omits a nil rather than encoding null, so the key is absent.
    expect(answer.chosen ?? null).toBeNull()
    expect(String(answer.skipped)).toContain('expected back')
  })

  // A retry running over a past failure is claimed by the retry, whichever
  // order the registry lists them in.
  it.skipIf(!present)('lets a live retry outrank an old failure', () => {
    const answer = ask(
      board([1133], [task(1133, 'failed'), task(1133, 'running')]),
    )
    // Swift omits a nil rather than encoding null, so the key is absent.
    expect(answer.chosen ?? null).toBeNull()
    expect(String(answer.skipped)).toContain('a worker has it')
  })
})
