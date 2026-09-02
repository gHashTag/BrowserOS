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
 * BUILD PRECONDITION. The broad API suite intentionally does not build Swift,
 * so behavioral cases retain `skipIf`. Exact-artifact verification sets
 * `TRIOS_REQUIRE_QUEEND_TESTS=1`; in that mode the first test fails rather than
 * reporting a quiet green when the release binary is absent.
 */

const BIN = join(
  import.meta.dir,
  '../../../../queen-core/.build/release/queend',
)
const DOCKERFILE = join(import.meta.dir, '../../../../Dockerfile')
const present = existsSync(BIN)
const required = process.env.TRIOS_REQUIRE_QUEEND_TESTS === '1'

function ask(
  question: unknown,
  env?: Record<string, string>,
): Record<string, unknown> {
  const run = spawnSync(BIN, {
    input: JSON.stringify(question),
    encoding: 'utf8',
    // The cap knob is read from the environment, so the test has to be able to
    // set it. Inherited so the binary still finds its loader paths.
    env: { ...process.env, ...(env ?? {}) },
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

const board = (
  numbers: number[],
  tasks: Array<ReturnType<typeof task>>,
  maximumConcurrentWorkers?: number,
) => ({
  kind: 'choose',
  candidates: numbers,
  candidateBodies: Object.fromEntries(numbers.map((n) => [String(n), body(n)])),
  tasks,
  maximumConcurrentWorkers,
})

describe('queend chooses the next bee', () => {
  // Runs everywhere. If the binary moves, this fails rather than letting the
  // suite above quietly stop testing anything.
  it('is where the container expects it', () => {
    expect(readFileSync(DOCKERFILE, 'utf8')).toContain('queend')
    expect(BIN.endsWith('/queend')).toBe(true)
    if (required) expect(present).toBe(true)
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

  /**
   * #1311. The server knows the effective capacity for this deployment; the
   * compiled policy used to know only its static four-worker default. Raising
   * that constant would over-dispatch smaller installations, while leaving it
   * alone stranded verified capacity above four. The number therefore travels
   * with each choose question and is bounded by the policy at 1...8.
   */
  it.skipIf(!present)(
    'admits the eighth worker at an effective limit of eight',
    () => {
      const running = Array.from({ length: 7 }, (_, index) => ({
        ...task(2000 + index, 'running'),
        ownedPaths: [`docs/running-${index}.md`],
      }))
      const answer = ask(board([2100], running, 8))
      expect(answer.chosen).toBe(2100)
    },
  )

  it.skipIf(!present)(
    'refuses a fifth worker at an effective limit of four',
    () => {
      const running = Array.from({ length: 4 }, (_, index) =>
        task(2200 + index, 'running'),
      )
      const answer = ask(board([2300], running, 4))
      expect(answer.allowed).toBe(false)
      expect(String(answer.refusal)).toContain('limit 4')
    },
  )

  it.skipIf(!present)(
    'keeps the legacy four-worker default when the field is absent',
    () => {
      const running = Array.from({ length: 4 }, (_, index) =>
        task(2400 + index, 'running'),
      )
      const answer = ask(board([2500], running))
      expect(answer.allowed).toBe(false)
      expect(String(answer.refusal)).toContain('limit 4')
    },
  )

  it.skipIf(!present)('clamps an above-range runtime limit to eight', () => {
    const running = Array.from({ length: 8 }, (_, index) =>
      task(2600 + index, 'running'),
    )
    const answer = ask(board([2700], running, 99))
    expect(answer.allowed).toBe(false)
    expect(String(answer.refusal)).toContain('limit 8')
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

  /**
   * A boundary line whose separator is a tab, not a space.
   *
   * `QueenIssueBoundary.pathToken` split on the ASCII space alone, while the
   * deliberate second implementation in `queen-tick.ts` has always split on
   * `/\s+/`. Fed "-<TAB>docs/only-1301.md" the two returned
   * "-\tdocs/only-1301.md" and "docs/only-1301.md": one issue, two readings of
   * what it claims. Nothing downstream repairs it - the outer trim only
   * reaches the ends of the line, no strip removes a "-", and the fused token
   * still contains "/" so it is returned as a path.
   *
   * The consequence is not cosmetic. A claim of "-\tdocs/only-1301.md" matches
   * no file and collides with no holder, so the chooser starts a bee straight
   * over a path another worker is holding - the one collision this whole gate
   * exists to prevent.
   */
  const tabbedBody = (n: number) =>
    [
      '## Success Criteria',
      '- make check exits 0.',
      '',
      '## Boundary',
      `-\tdocs/only-${n}.md`,
    ].join('\n')

  const tabbedBoard = (n: number, tasks: Array<ReturnType<typeof task>>) => ({
    kind: 'choose',
    candidates: [n],
    candidateBodies: { [String(n)]: tabbedBody(n) },
    tasks,
  })

  it.skipIf(!present)('reads a tab as a token boundary', () => {
    const answer = ask(tabbedBoard(1301, []))
    expect(answer.chosen).toBe(1301)
    expect(answer.chosenPaths).toEqual(['docs/only-1301.md'])
  })

  it.skipIf(!present)('sees a collision on a tabbed boundary', () => {
    const holder = {
      ...task(1302, 'running'),
      issue: { owner: 'gHashTag', repo: 'trios', number: 1302 },
      ownedPaths: ['docs/only-1301.md'],
    }
    const answer = ask(tabbedBoard(1301, [holder]))
    // Swift omits a nil rather than encoding null, so the key is absent.
    expect(answer.chosen ?? null).toBeNull()
    expect(String(answer.skipped)).toContain('held by')
  })
})

/**
 * The money ceiling, on the path that actually spends it.
 *
 * WHAT IT PINS. `choose` is the only gate between a tick and a dispatched bee,
 * and it weighed capacity, boundaries and order - nothing else. `SwarmBudget`
 * was compiled into the QueenPolicy module this binary links and referenced by
 * nothing in it: the $10/day ceiling existed only in the Mac app, while the
 * dispatching path runs in a container. Since the round became a loop rather
 * than one dispatch, an exhausted budget bought a whole round of bees.
 *
 * The board below spends $12 of a $5 cap and then a $100 one. Same board, same
 * candidate, two answers - so the refusal is the budget and not the boundary.
 */
describe('queend refuses to start a bee once the day is spent', () => {
  // $15 per million input tokens for claude-opus in ModelPricing.table, so
  // 800k input tokens is $12.00 exactly. Dated now, because the budget is a
  // DAILY one and a task updated yesterday must not count against today.
  function spentTask(issue: number, inputTokens: number) {
    return {
      ...task(issue, 'accepted'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-opus-4.5',
      inputTokens,
      outputTokens: 0,
    }
  }

  it.skipIf(!present)('refuses when today is over the cap', () => {
    const answer = ask(board([1201], [spentTask(999, 800_000)]), {
      TRIOS_SWARM_BILLING_MODE: 'api_metered',
      TRIOS_SWARM_DAILY_CAP_USD: '5',
    })
    expect(answer.allowed).toBe(false)
    // Swift omits a nil rather than encoding null, so the key is absent.
    expect(answer.chosen ?? null).toBeNull()
    // ModelPricing.format drops the cents above $10, so $12.00 prints as $12.
    expect(String(answer.refusal)).toContain('spent about $12 today')
    expect(String(answer.refusal)).toContain('past its $5.00 daily limit')
  })

  it.skipIf(!present)('starts the same bee when the cap is raised', () => {
    const answer = ask(board([1201], [spentTask(999, 800_000)]), {
      TRIOS_SWARM_DAILY_CAP_USD: '100',
    })
    expect(answer.chosen).toBe(1201)
  })

  it.skipIf(!present)(
    'does not turn Coding Plan telemetry into a metered API refusal',
    () => {
      const answer = ask(board([1201], [spentTask(999, 800_000)]), {
        TRIOS_SWARM_BILLING_MODE: 'coding_plan',
        TRIOS_SWARM_DAILY_CAP_USD: '5',
      })
      expect(answer.chosen).toBe(1201)
      expect(String(answer.refusal ?? '')).not.toContain('daily limit')
    },
  )

  // Yesterday's spend is not today's. Without the day filter the cap would
  // latch shut permanently the first time a swarm had an expensive afternoon.
  it.skipIf(!present)('ignores spend from another day', () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
    const stale = { ...spentTask(999, 800_000), updatedAt: yesterday }
    const answer = ask(board([1201], [stale]), {
      TRIOS_SWARM_DAILY_CAP_USD: '5',
    })
    expect(answer.chosen).toBe(1201)
  })

  // A task with no provider or model has no price, and an unknown price stays
  // unknown rather than becoming an average - the same rule the table states.
  it.skipIf(!present)('does not invent a price for an unpriced task', () => {
    const answer = ask(board([1201], [task(999, 'accepted')]), {
      TRIOS_SWARM_DAILY_CAP_USD: '5',
    })
    expect(answer.chosen).toBe(1201)
  })
})
