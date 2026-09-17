import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  crossCheckRing00Capacity,
  runningOnBoard,
  runRound,
  swiftCapacityAnswer,
} from '../../src/api/services/queen-tick'
import { logger } from '../../src/lib/logger'

/**
 * RING-00, called from the round it is supposed to shadow.
 *
 * WHY THIS FILE EXISTS. `rings/T27-00/generated/queen_core.rs` was proven
 * correct and called by nothing: `tests/t27/ring00_parity.sh` ran fourteen rows
 * and twenty-one constants through it and every decision the live supervisor
 * made still came from `queend`. A ring that only a test executes is a ring
 * whose production behaviour is a guess. `crossCheckRing00Capacity` asks it the
 * round's real capacity question every round, and this file is what stops that
 * call being deleted, inverted, or made able to stop a round.
 *
 * IT IS A CROSS-CHECK, NOT A HANDOVER, and the tests are written against that:
 * nothing below asserts that the ring's answer changes what the round does,
 * because it must not. Swift stays authoritative. What is asserted is that the
 * ring RAN, on the same number, and that a disagreement is loud.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT, named because a quiet stub is how a gate
 * comes to report success it never earned:
 *
 *   REAL when built - `t27core`, found at `rings/T27-00/shim` (or built from it
 *   with bare `rustc`, the ring's own contract, exactly as the parity harness
 *   does). Every test tagged `it.if(RING)` drives that binary and NOTHING RUNS
 *   in its place when it is absent. On a machine without the shim the
 *   agreement case below is not covered at all - the stub cases still run, and
 *   they can only prove the plumbing, never the ring.
 *
 *   REAL when built - `queend`, the Swift policy, at
 *   `queen-core/.build/release/queend`. The `runRound` tests need it and DO NOT
 *   RUN without it.
 *
 *   NEVER REAL - the disagreement. Two correct implementations of one rule
 *   cannot be made to disagree on purpose, so that case is driven by a stub
 *   binary that answers the opposite. The stub stands in for a future ring that
 *   has drifted, which is the event this whole cross-check exists to catch.
 *
 *   FAKE by choice - the database (a recording fake: the assertion is about
 *   logs, not storage), GitHub (stubbed at `fetch`; a test that reaches the
 *   network fails for reasons that have nothing to do with what it claims) and
 *   the workspace (a directory that does not exist, so `committedFiles` is
 *   empty deterministically).
 *
 * The first test in each describe always runs, so a path cannot drift
 * unnoticed while the rest sit skipped.
 */

// --- The real binaries ------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, '../../../../..')
const SHIM = join(REPO_ROOT, 'rings/T27-00/shim')
const QUEEND = join(
  import.meta.dir,
  '../../../../queen-core/.build/release/queend',
)
const QUEEND_PRESENT = existsSync(QUEEND)

/** Every .rs under a directory, so the shim's layout is discovered not assumed. */
function rustSources(dir: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...rustSources(path))
    else if (entry.endsWith('.rs')) found.push(path)
  }
  return found
}

/**
 * The real `t27core`, prebuilt or built here.
 *
 * Prebuilt first, because a machine that has one has the one the image ships.
 * Otherwise built from the shim with bare `rustc` - the ring's stated contract,
 * and the same thing `tests/t27/ring00_parity.sh` does - so this suite covers
 * the binary rather than a description of it. Returns null when neither is
 * possible, and every test that needs it is then skipped rather than faked.
 */
function findT27Core(): string | null {
  const prebuilt = () => {
    for (const candidate of [
      process.env.TRIOS_T27CORE_PATH,
      join(SHIM, 't27core'),
      join(SHIM, 'target/release/t27core'),
      join(SHIM, 'build/t27core'),
      '/usr/local/bin/t27core',
    ]) {
      if (candidate && existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate
      }
    }
    return null
  }
  const already = prebuilt()
  if (already) return already
  if (!existsSync(SHIM)) return null

  // The shim's own build, if it ships one. Preferred over guessing: it knows
  // its layout and this file must not encode a second opinion about it.
  const script = join(SHIM, 'build.sh')
  if (existsSync(script)) {
    spawnSync('/bin/sh', [script], { cwd: SHIM, encoding: 'utf8' })
    const built = prebuilt()
    if (built) return built
  }

  const rustc = [
    process.env.RUSTC,
    `${process.env.HOME}/.cargo/bin/rustc`,
    '/usr/local/bin/rustc',
  ].find((p) => p && existsSync(p))
  if (!rustc) return null

  const main = rustSources(SHIM).find((path) =>
    /fn\s+main\s*\(/.test(readFileSync(path, 'utf8')),
  )
  if (!main) return null

  // Bare `rustc`, no cargo and no dependencies: the ring's stated contract, and
  // what `tests/t27/ring00_parity.sh` does. Two shapes are possible and both
  // are tried rather than assumed - the shim may carry the generated code
  // inline (`mod`/`include!`, one invocation), or link it as a separate crate
  // (an rlib and `--extern`, two).
  const dir = join(main, '..')
  const out = join(mkdtempSync(join(tmpdir(), 'ring00-shim-')), 't27core')
  const flat = spawnSync(rustc, ['--edition', '2021', '-O', main, '-o', out], {
    cwd: dir,
    encoding: 'utf8',
  })
  if (flat.status === 0 && existsSync(out)) return out

  const generated = join(REPO_ROOT, 'rings/T27-00/generated/queen_core.rs')
  if (!existsSync(generated)) return null
  const rlib = join(out, '../libqueen_core.rlib')
  const lib = spawnSync(
    rustc,
    ['--edition', '2021', '--crate-type', 'lib', generated, '-o', rlib],
    { cwd: dir, encoding: 'utf8' },
  )
  if (lib.status !== 0) return null
  const linked = spawnSync(
    rustc,
    [
      '--edition',
      '2021',
      '-O',
      main,
      '--extern',
      `queen_core=${rlib}`,
      '-o',
      out,
    ],
    { cwd: dir, encoding: 'utf8' },
  )
  return linked.status === 0 && existsSync(out) ? out : null
}

const RING = findT27Core()

// --- Stubs, for the answers no correct binary will give ---------------------

const STUBS = mkdtempSync(join(tmpdir(), 'ring00-stub-'))

/** A `t27core` that prints exactly what it is told to, and exits `code`. */
function stub(name: string, body: string, code = 0): string {
  const path = join(STUBS, name)
  writeFileSync(path, `#!/bin/sh\n${body}\nexit ${code}\n`)
  chmodSync(path, 0o755)
  return path
}

const ABSENT = join(STUBS, 'no-such-t27core')

// --- Log capture ------------------------------------------------------------

interface Said {
  level: 'info' | 'warn' | 'error'
  message: string
  meta?: Record<string, unknown>
}

function capture(): { said: Said[]; restore: () => void } {
  const said: Said[] = []
  const originals = {
    info: logger.info.bind(logger),
    warn: logger.warn.bind(logger),
    error: logger.error.bind(logger),
  }
  for (const level of ['info', 'warn', 'error'] as const) {
    logger[level] = (message: string, meta?: Record<string, unknown>) => {
      said.push({ level, message: String(message), meta })
    }
  }
  return {
    said,
    restore: () => {
      logger.info = originals.info
      logger.warn = originals.warn
      logger.error = originals.error
    },
  }
}

const matching = (said: Said[], level: Said['level'], fragment: string) =>
  said.filter((s) => s.level === level && s.message.includes(fragment))

// =============================================================================
// The number, and where the Swift answer is read from
// =============================================================================

describe('ring-00 cross-check, the number both sides are asked about', () => {
  /**
   * `queend` counts `tasks.filter { $0.state == .running }.count`. This is that
   * count, and the states around it are the ones that made the container refuse
   * "4 workers already running (limit 4)" while exactly one bee existed.
   */
  it('counts only the bees that are actually running', () => {
    const board = [
      { state: 'running' },
      { state: 'awaitingReview' },
      { state: 'accepted' },
      { state: 'rejected' },
      { state: 'running' },
    ]
    expect(runningOnBoard(board)).toBe(2)
    expect(runningOnBoard([])).toBe(0)
  })

  /** A malformed row must not be counted as a worker, nor throw. */
  it('does not count what it cannot read', () => {
    expect(runningOnBoard([null, undefined, 7, 'running', {}])).toBe(0)
  })

  /** The capacity refusal is Swift saying false, and carries its own count. */
  it('reads a capacity refusal as false, and the count queend named', () => {
    const answer = swiftCapacityAnswer({
      allowed: false,
      refusal: '4 workers already running (limit 4)',
    })
    expect(answer.answer).toBe(false)
    expect(answer.runningNamed).toBe(4)
  })

  /** Past the gate is Swift saying true, whatever it went on to decide. */
  it('reads an allowed choice as true', () => {
    const answer = swiftCapacityAnswer({ allowed: true, chosen: 1234 })
    expect(answer.answer).toBe(true)
    expect(answer.runningNamed).toBeNull()
  })

  /**
   * THE GUARD ON THE READ. The capacity gate is the first guard in the `choose`
   * case; every later refusal - money, boundaries, order - happens with the
   * capacity question already answered true. A substring match on "running"
   * would read one of those as a capacity refusal and invert the Swift side of
   * every comparison, which is a cross-check that agrees with itself.
   */
  it('does not mistake another refusal for a capacity refusal', () => {
    for (const refusal of [
      'the daily budget is spent; no bee starts',
      'every candidate is held by a running task',
      'nothing open',
      '4 workers already running (limit 4) and the budget is spent',
    ]) {
      expect(swiftCapacityAnswer({ allowed: false, refusal }).answer).toBe(true)
    }
  })
})

// =============================================================================
// The ring itself
// =============================================================================

describe('ring-00 cross-check, against the real binary', () => {
  const savedPath: Record<string, string | undefined> = {}
  beforeEach(() => {
    savedPath.value = process.env.TRIOS_T27CORE_PATH
  })
  afterEach(() => {
    if (savedPath.value === undefined) delete process.env.TRIOS_T27CORE_PATH
    else process.env.TRIOS_T27CORE_PATH = savedPath.value
  })

  it('knows where the real binary would be', () => {
    expect(SHIM).toContain('rings/T27-00/shim')
  })

  /**
   * THE POINT OF THE WHOLE PIECE: the generated Rust, executed, answering the
   * same question the Swift policy answers, across the whole range the gate
   * turns on - including the ceiling, which is the only place it bites.
   *
   * The Swift side is `running < maximumConcurrentWorkers`, and 4 is pinned by
   * `tests/t27/ring00_parity.sh` row k01 against
   * `QueenDelegation.maximumConcurrentWorkers`.
   */
  it.if(RING !== null)(
    'agrees with Swift on every count around the limit',
    async () => {
      process.env.TRIOS_T27CORE_PATH = RING as string
      const { said, restore } = capture()
      try {
        for (const running of [0, 1, 2, 3, 4, 5, 9]) {
          const swift = { answer: running < 4, runningNamed: null }
          expect(await crossCheckRing00Capacity(running, swift)).toBe('agree')
        }
      } finally {
        restore()
      }
      // Said out loud, once per round, or "the ring runs in production" is a
      // claim in a document rather than a line somebody can read.
      expect(matching(said, 'info', 'Ring-00 agrees').length).toBe(7)
      expect(matching(said, 'error', 'Ring-00').length).toBe(0)
    },
  )

  /**
   * The control. Without it the test above passes for a binary that answers
   * `true` to everything: at 0..3 that is the right answer, and only the
   * ceiling tells them apart.
   */
  it.if(RING !== null)(
    'is not a binary that answers true to everything',
    async () => {
      process.env.TRIOS_T27CORE_PATH = RING as string
      const { restore } = capture()
      try {
        // Swift says false at the ceiling. A ring answering `true` there would
        // disagree - and this asserts it does not, which is the same fact from
        // the other side.
        expect(
          await crossCheckRing00Capacity(4, {
            answer: true,
            runningNamed: null,
          }),
        ).toBe('disagree')
      } finally {
        restore()
      }
    },
  )
})

// =============================================================================
// The three outcomes
// =============================================================================

describe('ring-00 cross-check, the three outcomes', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.TRIOS_T27CORE_PATH = process.env.TRIOS_T27CORE_PATH
  })
  afterEach(() => {
    if (saved.TRIOS_T27CORE_PATH === undefined) {
      delete process.env.TRIOS_T27CORE_PATH
    } else {
      process.env.TRIOS_T27CORE_PATH = saved.TRIOS_T27CORE_PATH
    }
  })

  /**
   * A DRIFTED RING. This is the event L0 exists to prevent - one rule with two
   * readings that no longer agree - and the only way to see it in a test is a
   * stub, because two correct implementations cannot be made to disagree.
   *
   * `error`, and both answers named: an operator reading the log has to be able
   * to tell WHICH side moved without re-running anything.
   */
  it('shouts when the ring disagrees, naming both answers and the input', async () => {
    process.env.TRIOS_T27CORE_PATH = stub(
      'disagrees',
      'echo can_start_another=false\necho free_slots=0',
    )
    const { said, restore } = capture()
    try {
      const outcome = await crossCheckRing00Capacity(1, {
        answer: true,
        runningNamed: null,
      })
      expect(outcome).toBe('disagree')
    } finally {
      restore()
    }
    const shouted = matching(said, 'error', 'RING-00 DISAGREES')
    expect(shouted.length).toBe(1)
    expect(shouted[0].meta?.swift).toBe(true)
    expect(shouted[0].meta?.ring).toBe(false)
    expect(shouted[0].meta?.running).toBe(1)
    // Swift is still the one in charge, and the log says so rather than
    // leaving a reader to work out which answer the swarm acted on.
    expect(shouted[0].meta?.authoritative).toBe('swift')
    expect(matching(said, 'info', 'Ring-00 agrees').length).toBe(0)
  })

  /** And in the other direction, so the comparison is not a one-way check. */
  it('shouts when the ring allows what Swift refused', async () => {
    process.env.TRIOS_T27CORE_PATH = stub(
      'permissive',
      'echo can_start_another=true\necho free_slots=1',
    )
    const { said, restore } = capture()
    try {
      expect(
        await crossCheckRing00Capacity(4, {
          answer: false,
          runningNamed: 4,
        }),
      ).toBe('disagree')
    } finally {
      restore()
    }
    const shouted = matching(said, 'error', 'RING-00 DISAGREES')
    expect(shouted.length).toBe(1)
    expect(shouted[0].meta?.swift).toBe(false)
    expect(shouted[0].meta?.ring).toBe(true)
  })

  /**
   * AN OBSERVER THAT CAN STOP A ROUND IS NOT AN OBSERVER. A container built
   * before the binary shipped, an image where the copy was dropped, a mount
   * that came up empty - none of it may cost the swarm a round.
   */
  it('warns and carries on when the binary is not there', async () => {
    process.env.TRIOS_T27CORE_PATH = ABSENT
    const { said, restore } = capture()
    try {
      expect(
        await crossCheckRing00Capacity(2, { answer: true, runningNamed: null }),
      ).toBe('unavailable')
    } finally {
      restore()
    }
    expect(
      matching(said, 'warn', 'Ring-00 cross-check did not run').length,
    ).toBe(1)
    expect(matching(said, 'error', 'Ring-00').length).toBe(0)
  })

  /** A binary that is there and refuses is the same class of event. */
  it('warns and carries on when the binary exits nonzero', async () => {
    process.env.TRIOS_T27CORE_PATH = stub(
      'refuses',
      'echo error=capacity needs 1 argument >&2',
      2,
    )
    const { said, restore } = capture()
    try {
      expect(
        await crossCheckRing00Capacity(2, { answer: true, runningNamed: null }),
      ).toBe('unavailable')
    } finally {
      restore()
    }
    expect(
      matching(said, 'warn', 'Ring-00 cross-check did not run').length,
    ).toBe(1)
  })

  /**
   * SILENCE IS NOT AGREEMENT. A binary that succeeds and answers nothing, or
   * answers something that is not a bool, must not be read as "the ring
   * agreed" - that is exactly how a dead cross-check reports success for ever.
   */
  it('refuses to read an unanswered question as agreement', async () => {
    for (const [name, body] of [
      ['silent', 'true'],
      ['wrong_key', 'echo free_slots=1'],
      ['not_a_bool', 'echo can_start_another=yes'],
    ] as const) {
      process.env.TRIOS_T27CORE_PATH = stub(name, body)
      const { said, restore } = capture()
      try {
        expect(
          await crossCheckRing00Capacity(0, {
            answer: true,
            runningNamed: null,
          }),
        ).toBe('unavailable')
      } finally {
        restore()
      }
      expect(matching(said, 'info', 'Ring-00 agrees').length).toBe(0)
      expect(
        matching(said, 'warn', 'Ring-00 cross-check did not run').length,
      ).toBe(1)
    }
  })

  /**
   * The two sides must have been asked about the SAME board. When `queend`
   * named its own count and it is not this one, an agreement below would be
   * two answers to two questions, and it says so.
   */
  it('says so when it was fed a different board than queend counted', async () => {
    process.env.TRIOS_T27CORE_PATH = stub(
      'agrees',
      'echo can_start_another=false\necho free_slots=0',
    )
    const { said, restore } = capture()
    try {
      expect(
        await crossCheckRing00Capacity(9, { answer: false, runningNamed: 4 }),
      ).toBe('agree')
    } finally {
      restore()
    }
    const drift = matching(said, 'error', 'a different board than queend')
    expect(drift.length).toBe(1)
    expect(drift[0].meta?.queendCounted).toBe(4)
    expect(drift[0].meta?.tickCounted).toBe(9)
  })
})

// =============================================================================
// The round
// =============================================================================

/**
 * Fixture, kept deliberately close to `queen-round.test.ts`: same recording
 * pool, same stubbed GitHub, same absent workspace. Duplicated rather than
 * shared because that file's fixture is shaped around what a ROUND writes, and
 * a helper extracted to serve both would drift toward whichever suite changed
 * last.
 */
const ISSUE = 1234
const BODY = [
  '## Success Criteria',
  '- make check exits 0.',
  '',
  '## Boundary',
  '`docs/only-1234.md`',
].join('\n')

const PROVIDER_KEYS = [
  'ZAI_API_KEY',
  'ZAI_API_KEY_2',
  'ZAI_API_KEY_3',
  'ZAI_API_KEY_4',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_API_KEY',
]

function roundPool() {
  const pool = {
    query: async (sql: string) => {
      const text = String(sql)
      if (text.includes('FROM queen_registry')) {
        return { rowCount: 1, rows: [{ tasks: [] }] }
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return pool
}

describe('the round calls it', () => {
  const saved: Record<string, string | undefined> = {}
  const realFetch = globalThis.fetch

  beforeEach(() => {
    for (const key of [
      ...PROVIDER_KEYS,
      'TRIOS_QUEEND_PATH',
      'TRIOS_T27CORE_PATH',
      'WORKSPACE_DIR',
      'TRIOS_GITHUB_REPO',
    ]) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env.TRIOS_QUEEND_PATH = QUEEND
    process.env.TRIOS_GITHUB_REPO = 'gHashTag/trios'
    process.env.WORKSPACE_DIR = join(tmpdir(), 'ring00-no-such-workspace')
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes(`/issues/${ISSUE}`)) {
        return new Response(JSON.stringify({ number: ISSUE, body: BODY }), {
          status: 200,
        })
      }
      return new Response('[]', { status: 200 })
    }) as typeof fetch
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    globalThis.fetch = realFetch
  })

  it('drives the same policy binary the container drives', () => {
    expect(QUEEND).toContain('queen-core/.build/release/queend')
  })

  /**
   * THE CALL SITE. Deleting the `crossCheckRing00Capacity` line from `runRound`
   * turns this red; nothing else in the suite would notice, which is precisely
   * how the ring came to be decorative in the first place.
   *
   * The lease is held false so the round decides and dispatches nothing: the
   * cross-check sits above the dispatch loop and needs no bee to be exercised.
   */
  it.if(QUEEND_PRESENT && RING !== null)(
    'runs the ring on the round own capacity question',
    async () => {
      process.env.TRIOS_T27CORE_PATH = RING as string
      const { said, restore } = capture()
      let result: Awaited<ReturnType<typeof runRound>>
      try {
        result = await runRound(roundPool(), 'me', 7, { held: false }, [ISSUE])
      } finally {
        restore()
      }
      expect(result.ran).toBe(true)

      const agreed = matching(said, 'info', 'Ring-00 agrees')
      expect(agreed.length).toBeGreaterThanOrEqual(1)
      // An empty registry and no container dispatches is a board of zero
      // running bees; both implementations are asked about THAT number.
      expect(agreed[0].meta?.running).toBe(0)
      expect(agreed[0].meta?.answer).toBe(true)
      expect(matching(said, 'error', 'RING-00 DISAGREES').length).toBe(0)
    },
  )

  /**
   * A disagreement is reported and the round STILL RETURNS. The cross-check is
   * an observer: it may make noise, it may not change the outcome. The choice
   * below is the same choice the round makes without it.
   */
  it.if(QUEEND_PRESENT)(
    'reports a disagreement and still finishes the round',
    async () => {
      process.env.TRIOS_T27CORE_PATH = stub(
        'round_disagrees',
        'echo can_start_another=false\necho free_slots=0',
      )
      const { said, restore } = capture()
      let result: Awaited<ReturnType<typeof runRound>>
      try {
        result = await runRound(roundPool(), 'me', 7, { held: false }, [ISSUE])
      } finally {
        restore()
      }

      expect(matching(said, 'error', 'RING-00 DISAGREES').length).toBe(1)
      // The round decided anyway, on the SWIFT answer. A cross-check that
      // changed the choice would be the handover this deliberately is not.
      expect(result.ran).toBe(true)
      expect(result.choice?.chosen).toBe(ISSUE)
    },
  )

  /**
   * And an absent binary costs nothing. This is the failure mode a first deploy
   * has - the image built before the binary was in it - and it must be a line
   * in a log, not a round the swarm did not get.
   */
  it.if(QUEEND_PRESENT)(
    'warns about a missing binary and still finishes the round',
    async () => {
      process.env.TRIOS_T27CORE_PATH = ABSENT
      const { said, restore } = capture()
      let result: Awaited<ReturnType<typeof runRound>>
      try {
        result = await runRound(roundPool(), 'me', 7, { held: false }, [ISSUE])
      } finally {
        restore()
      }

      expect(
        matching(said, 'warn', 'Ring-00 cross-check did not run').length,
      ).toBe(1)
      expect(result.ran).toBe(true)
      expect(result.choice?.chosen).toBe(ISSUE)
    },
  )
})

/**
 * The three checks below run EVERYWHERE, and that is the point.
 *
 * A skeptic proved what the gated ones are worth: with `queend` parked and the
 * whole `crossCheckRing00Capacity(...)` block deleted from `runRound`, the
 * suite still reported "15 pass, 3 skip, 0 fail". Every test that proves the
 * ring is called was skipping, so the call site could be removed in silence.
 * The same held for the image: deleting the runtime COPY of `t27core` left
 * "452 pass, 0 fail" behind it.
 *
 * These read the source and the Dockerfile instead. They need no binary, no
 * toolchain and no database, so there is no environment in which they quietly
 * stop testing anything - which is the failure mode this whole file exists to
 * avoid being an example of.
 */
describe('the ring reaches production at all', () => {
  const TICK = readFileSync(
    join(import.meta.dir, '../../src/api/services/queen-tick.ts'),
    'utf8',
  )
  const DOCKER = readFileSync(
    join(import.meta.dir, '../../../../Dockerfile'),
    'utf8',
  )

  it('is called from the round, not merely defined next to it', () => {
    expect(TICK).toContain('export async function crossCheckRing00Capacity')
    // CALL SITES, not mentions. A first version counted every occurrence of the
    // name and would have passed with the definition alone plus one comment -
    // it measured that the word exists, which is not the claim.
    const calls = TICK.split('await crossCheckRing00Capacity(').length - 1
    expect(calls).toBeGreaterThanOrEqual(1)
  })

  it('is shipped in the image the container runs', () => {
    expect(DOCKER).toContain('/usr/local/bin/t27core')
    expect(DOCKER).toContain('--from=t27core')
  })

  // The build context is `agent-server/`, so the ring cannot be copied from
  // where it lives. The mirror is what makes the COPY resolvable, and a mirror
  // nobody checks is a fork - `tests/t27/ring00_generated_is_current.sh` is the
  // check, and this asserts the files it guards are actually here.
  it('has the mirror the image builds from', () => {
    for (const name of ['queen_core.rs', 't27core.rs']) {
      expect(
        existsSync(join(import.meta.dir, '../../../../t27-core', name)),
      ).toBe(true)
    }
    expect(DOCKER).toContain('COPY t27-core/queen_core.rs')
  })

  // An observer that can hang the thing it observes is not an observer. The
  // call is awaited inline while the round holds the Queen's lease.
  it('cannot hang the round it observes', () => {
    expect(TICK).toContain('t27core did not answer within')
    expect(TICK).toContain("child.kill('SIGKILL')")
  })
})
