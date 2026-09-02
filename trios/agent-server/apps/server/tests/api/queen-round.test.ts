import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  closeDispatch,
  setDurableCloseListener,
} from '../../src/api/services/queen-dispatch'
import {
  createRoundGate,
  effectiveRuntimeWorkerLimit,
  refillOnBeeCompletion,
  runRound,
} from '../../src/api/services/queen-tick'
import { logger } from '../../src/lib/logger'

/**
 * The round itself, driven against the real policy binary.
 *
 * WHY THIS FILE EXISTS. Nothing in this repository called `runRound` or
 * `runQueenTickOnce`. A critic proved what that costs by deleting the
 * `watch.held &&` guard from the dispatch loop, the stand-down warning after
 * it, and the heartbeat sweep in `handover` - one at a time - and watching all
 * 364 tests stay green through every deletion. The lease guard is the one that
 * matters: every write below the choice is unfenced, so a round that has lost
 * its lease and keeps dispatching is a round writing bees onto the legitimate
 * Queen's board, `conversation_id` included.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. The policy is real - `queend`, the same
 * binary the container runs, pointed at by TRIOS_QUEEND_PATH. The database is
 * a recording fake, because the assertion is about which statements a round
 * issues. GitHub is stubbed at `fetch`, because a test that reaches the network
 * fails for reasons that have nothing to do with what it claims. The workspace
 * is pointed at a directory that does not exist so `committedFiles` returns
 * empty deterministically rather than reading whatever happens to be on the
 * machine running the suite.
 *
 * HONEST LIMIT, stated because a quiet skip is how a gate comes to report
 * success it never earned: on a machine that has not built `queend`, the
 * behaviour tests below DO NOT RUN. The first test always runs, so the path
 * cannot drift unnoticed.
 */

const BIN = join(
  import.meta.dir,
  '../../../../queen-core/.build/release/queend',
)
const present = existsSync(BIN)

/**
 * #1311. This is the server-side authority handed to every choose call in one
 * round. It is numeric only, closed at eight, and keeps a fail-closed one-slot
 * diagnostic path when the deployment has no usable provider credential.
 */
describe('queen round effective worker limit', () => {
  it('admits measured capacities 2, 4 and 8 without inventing extra slots', () => {
    expect(effectiveRuntimeWorkerLimit(2)).toBe(2)
    expect(effectiveRuntimeWorkerLimit(4)).toBe(4)
    expect(effectiveRuntimeWorkerLimit(8)).toBe(8)
  })

  it('clamps invalid and above-policy capacities to the closed range 1 through 8', () => {
    expect(effectiveRuntimeWorkerLimit(0)).toBe(1)
    expect(effectiveRuntimeWorkerLimit(Number.NaN)).toBe(1)
    expect(effectiveRuntimeWorkerLimit(99)).toBe(8)
  })
})

/** Every provider credential dispatch consults, so no bee is ever really run. */
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

const ISSUE = 1234
const BODY = [
  '## Success Criteria',
  '- make check exits 0.',
  '',
  '## Boundary',
  '`docs/only-1234.md`',
].join('\n')

interface FinishedRow {
  issue: number
  conversation_id: string
  criteria: string[]
  criteria_source: string
  send_backs: number
  owned_paths: string[]
  said: string
}

/**
 * A finished dispatch plus the stale registry mirror observed in production.
 *
 * Unlike roundPool, this answers the in-flight query with the row that was just
 * reviewed. Before #1315 that row became `rejected`, remained on the policy
 * board, and made queend refuse to choose the same issue for its requested
 * second pass. The registry mirror makes the second half of the defect visible:
 * even deleting the cloud row alone would still leave an awaitingReview task.
 */
function parkedSendBackPool() {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const row = {
    ...finishedRow(0),
    branch: `queen-${ISSUE}`,
    dispatched_at: '2026-09-02T03:00:00Z',
    finished_at: '2026-09-02T03:10:00Z',
    outcome: 'finished',
    review_state: null as string | null,
    review_note: null as string | null,
    key_index: 0,
    provider: 'zai',
    model: 'glm-5.3',
    input_tokens: 100,
    output_tokens: 20,
    started: true,
    retry_of_send_back: false,
  }
  const registryTask = {
    id: '00000000-0000-0000-0000-000000000999',
    conversationId: '00000000-0000-0000-0000-000000000999',
    issue: { owner: 'gHashTag', repo: 'trios', number: ISSUE },
    title: 'stale review mirror',
    worker: 'old-worker',
    state: 'awaitingReview',
    ownedPaths: row.owned_paths,
    virtualBranch: null,
    createdAt: row.dispatched_at,
    updatedAt: row.finished_at,
    acceptanceCriteria: row.criteria,
    interventions: [],
    criterionVerdicts: {},
  }
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      queries.push({ sql: text, params })
      if (text.includes('FROM queen_registry')) {
        return { rowCount: 1, rows: [{ tasks: [registryTask] }] }
      }
      if (text.includes('FROM queen_dispatch d')) {
        return {
          rowCount:
            row.finished_at != null && row.review_state === null ? 1 : 0,
          rows:
            row.finished_at != null && row.review_state === null ? [row] : [],
        }
      }
      if (
        text.includes('UPDATE queen_dispatch') &&
        text.includes('SET review_state = $2')
      ) {
        row.review_state = String(params[1])
        row.review_note = String(params[2])
        row.send_backs += row.review_state === 'sendBack' ? 1 : 0
        return { rowCount: 1, rows: [] }
      }
      if (
        text.includes('UPDATE queen_dispatch') &&
        text.includes('retry_of_send_back = true')
      ) {
        if (row.review_state !== 'sendBack' || row.finished_at == null) {
          return { rowCount: 0, rows: [] }
        }
        row.started = true
        row.finished_at = null
        row.outcome = null as unknown as string
        row.conversation_id = String(params[1])
        row.review_state = null
        if (text.includes('review_note = NULL')) row.review_note = null
        row.retry_of_send_back = true
        row.key_index = Number(params[2])
        row.provider = String(params[3])
        row.model = String(params[4])
        return { rowCount: 1, rows: [{ issue: ISSUE }] }
      }
      if (
        text.includes('UPDATE queen_dispatch') &&
        text.includes('detail = $3') &&
        text.includes('conversation_id = $2')
      ) {
        row.review_state = null
        return { rowCount: 1, rows: [] }
      }
      if (
        text.includes('SELECT issue, branch, owned_paths') &&
        text.includes('FROM queen_dispatch')
      ) {
        return { rowCount: 1, rows: [row] }
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, queries, row }
}

/** A dispatch insert, which `queen_dispatch_history` must not be mistaken for. */
const isDispatchInsert = (sql: string) =>
  /INSERT INTO queen_dispatch\b/.test(sql)

const isRetryClaim = (sql: string) =>
  sql.includes('UPDATE queen_dispatch') &&
  sql.includes('SET started = true') &&
  sql.includes('retry_of_send_back = true')

const tempWorkspaces: string[] = []

function prepareRetryWorkspace(): void {
  const parent = mkdtempSync(join(tmpdir(), 'queen-retry-workspace-'))
  tempWorkspaces.push(parent)
  const root = join(parent, 'BrowserOS')
  mkdirSync(join(root, 'trios', 'docs'), { recursive: true })
  writeFileSync(join(root, 'trios', 'docs', 'only-1234.md'), 'baseline\n')
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  expect(git('init').status).toBe(0)
  expect(git('config', 'user.name', 'Queen Test').status).toBe(0)
  expect(git('config', 'user.email', 'queen-test@example.invalid').status).toBe(
    0,
  )
  expect(git('add', '.').status).toBe(0)
  expect(git('commit', '-m', 'baseline').status).toBe(0)
  mkdirSync(join(root, '.worktrees'), { recursive: true })
  expect(
    git(
      'worktree',
      'add',
      '-b',
      `queen-${ISSUE}`,
      join(root, '.worktrees', `queen-${ISSUE}`),
      'HEAD',
    ).status,
  ).toBe(0)
  process.env.WORKSPACE_DIR = parent
  process.env.TRIOS_REPO_REF = 'HEAD'
}

/**
 * Postgres, answering the shapes one round asks for and recording all of them.
 *
 * Matched on fragments of the statements rather than on order, because the
 * order is the thing under test in two of the cases below and a fake that
 * encodes it would agree with whatever the code does.
 */
function roundPool(finished: FinishedRow[] = [], reviewWriteCount = 1) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: String(sql), params })
      const text = String(sql)
      if (text.includes('FROM queen_registry')) {
        return { rowCount: 1, rows: [{ tasks: [] }] }
      }
      if (text.includes('FROM queen_dispatch d')) {
        return { rowCount: finished.length, rows: finished }
      }
      if (
        text.includes('UPDATE queen_dispatch') &&
        text.includes('SET review_state = $2')
      ) {
        return { rowCount: reviewWriteCount, rows: [] }
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, queries, sql: () => queries.map((q) => q.sql) }
}

const saved: Record<string, string | undefined> = {}
const realFetch = globalThis.fetch

beforeEach(() => {
  for (const key of [
    ...PROVIDER_KEYS,
    'TRIOS_QUEEND_PATH',
    'WORKSPACE_DIR',
    'TRIOS_GITHUB_REPO',
    'TRIOS_API_TOKEN',
    'TRIOS_QUEEN_REHEARSAL',
    'TRIOS_REPO_REF',
  ]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.TRIOS_QUEEND_PATH = BIN
  // Named, because the round no longer guesses. It used to fall back to
  // `gHashTag/BrowserOS` - the monorepo this checkout happens to be, not the
  // issue tracker - and a supervisor that guesses which repository it serves
  // can dispatch bees at a stranger's issues.
  process.env.TRIOS_GITHUB_REPO = 'gHashTag/trios'
  // A workspace that is not there: `committedFiles` runs git in it, fails, and
  // returns nothing - which is what this suite wants to be true every time.
  process.env.WORKSPACE_DIR = join(tmpdir(), 'queen-round-no-such-workspace')
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
  // The refill wiring installs a module-level listener; a case that leaves
  // one behind hands its hook to every later close in this process.
  setDurableCloseListener(undefined)
  for (const path of tempWorkspaces.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('queen round, lease lost', () => {
  it('drives the binary the container drives', () => {
    expect(BIN).toContain('queen-core/.build/release/queend')
  })

  /**
   * THE DEFECT. `watch.held` is read at the top of the dispatch loop and
   * nowhere else stops the round: `recordDispatch` carries no fence, unlike
   * `recordTick`, so a round that lost the lease and dispatched anyway would
   * overwrite the real Queen's row for that issue and point the feed at the
   * wrong bee.
   *
   * Deleting `watch.held &&` from the loop condition turns this red - the round
   * reaches `dispatchBee`, which writes its refusal through `recordDispatch`,
   * and the INSERT appears.
   */
  it.if(present)('dispatches nothing once the lease has moved', async () => {
    const { pool, sql } = roundPool()
    const result = await runRound(pool, 'me', 7, { held: false }, [ISSUE])

    // The round still DECIDED - the choice happens before the loop and is
    // recorded under a fence that refuses a stale term. What must not happen is
    // the acting on it.
    expect(result.ran).toBe(true)
    expect(result.choice?.chosen).toBe(ISSUE)
    expect(result.dispatch).toBeUndefined()
    expect(sql().some(isDispatchInsert)).toBe(false)
  })

  /**
   * The stand-down is SAID, not merely done - and that warning was undefended
   * too. In a report a round that stood down and a round that had nothing to
   * start are the same round: both started zero bees. This log line is the only
   * evidence anywhere that a working container lost the hive mid-round, which
   * is precisely the event nobody would otherwise think to look for.
   */
  it.if(present)('says so when it stands down mid-round', async () => {
    const { pool } = roundPool()
    const said: string[] = []
    const original = logger.warn.bind(logger)
    logger.warn = (message: string, meta?: Record<string, unknown>) => {
      said.push(String(message))
      original(message, meta)
    }
    try {
      await runRound(pool, 'me', 7, { held: false }, [ISSUE])
    } finally {
      logger.warn = original
    }
    expect(said.some((line) => line.includes('stood down mid-round'))).toBe(
      true,
    )
  })

  /**
   * The control, without which the first test above passes for the wrong
   * reason: a round that never dispatches anything at all would satisfy it just
   * as well.
   *
   * With the lease held the same round reaches `dispatchBee`, which refuses for
   * want of a provider credential and records the refusal - so the INSERT this
   * suite watches for does appear, and its absence above is the guard and not
   * the fixture.
   */
  it.if(present)(
    'dispatches the same issue while the lease is held',
    async () => {
      const { pool, sql } = roundPool()
      const result = await runRound(pool, 'me', 7, { held: true }, [ISSUE])

      expect(result.choice?.chosen).toBe(ISSUE)
      expect(sql().some(isDispatchInsert)).toBe(true)
    },
  )
})

/**
 * The send-back count, end to end, through the real policy.
 *
 * `priorSendBacks` was the literal 0. `QueenReviewDecision.maximumSendBacks` is
 * 2 and the escalate arm is guarded by `priorSendBacks < maximumSendBacks`, so
 * a constant 0 made the guard permanently true: an issue whose criteria stayed
 * unmet was returned for ever and never became a person's problem. The same
 * literal reached `sendBackNote(unmet:attempt:)` as `0 + 1`, so a bee returned
 * for the fifth time was told "Returning this for a second pass" - every time.
 */
function finishedRow(sendBacks: number): FinishedRow {
  return {
    issue: ISSUE,
    conversation_id: '00000000-0000-0000-0000-0000000004d2',
    criteria: ['the tab opens'],
    criteria_source: 'stated',
    send_backs: sendBacks,
    owned_paths: ['docs/only-1234.md'],
    said: ['## VERDICT', '- the tab opens: unmet'].join('\n'),
  }
}

/** The UPDATE that records a verdict, as opposed to the reaper's. */
const reviewUpdate = (queries: Array<{ sql: string; params: unknown[] }>) =>
  queries.find(
    (q) =>
      q.sql.includes('UPDATE queen_dispatch') &&
      q.sql.includes('SET review_state = $2'),
  )

describe('queen round, send-backs counted', () => {
  it.if(present)(
    'recovers finished durable wait rows in the next review sweep',
    async () => {
      const row = { ...finishedRow(0), said: '', review_state: 'wait' }
      const { pool, queries } = roundPool([row])
      await runRound(pool, 'me', 7, { held: true }, [ISSUE])

      const read = queries.find((query) =>
        query.sql.includes('FROM queen_dispatch d'),
      )
      expect(read?.sql).toContain("d.review_state = 'wait'")
      expect(reviewUpdate(queries)?.params[1]).toBe('sendBack')
    },
  )

  it.if(present)(
    'returns finished incomplete verdict evidence for a bounded retry',
    async () => {
      const { pool, queries } = roundPool([{ ...finishedRow(0), said: '' }])
      await runRound(pool, 'me', 7, { held: true }, [ISSUE])

      const update = reviewUpdate(queries)
      expect(update?.params[1]).toBe('sendBack')
      expect(String(update?.params[2])).toContain('complete ## VERDICT block')
    },
  )

  it.if(present)(
    'escalates finished incomplete verdict evidence at the retry ceiling',
    async () => {
      const { pool, queries } = roundPool([{ ...finishedRow(2), said: '' }])
      await runRound(pool, 'me', 7, { held: true }, [ISSUE])

      const update = reviewUpdate(queries)
      expect(update?.params[1]).toBe('escalate')
      expect(String(update?.params[2])).toContain('complete ## VERDICT block')
    },
  )

  it.if(present)(
    'writes no review verdict after the Queen lease has moved',
    async () => {
      const { pool, queries } = roundPool([{ ...finishedRow(0), said: '' }])
      await runRound(pool, 'me', 7, { held: false }, [ISSUE])

      expect(reviewUpdate(queries)).toBeUndefined()
    },
  )

  it.if(present)(
    'claims one exact finished attempt before counting a send-back',
    async () => {
      const { pool, queries } = roundPool([finishedRow(0)], 0)
      await runRound(pool, 'me', 7, { held: true }, [ISSUE])

      const update = reviewUpdate(queries)
      expect(update?.sql).toContain('conversation_id = $5')
      expect(update?.sql).toContain('IS NOT DISTINCT FROM $6::text')
      expect(update?.params[4]).toBe(finishedRow(0).conversation_id)
      expect(update?.params[5]).toBeNull()
    },
  )

  it.if(present)(
    'names a missing middle criterion instead of a positional neighbour',
    async () => {
      const row = {
        ...finishedRow(0),
        criteria: ['first criterion', 'missing middle', 'third criterion'],
        said: [
          '## VERDICT',
          '- first criterion: met',
          '- third criterion: met',
        ].join('\n'),
      }
      const { pool, queries } = roundPool([row])
      await runRound(pool, 'me', 7, { held: true }, [ISSUE])

      const note = String(reviewUpdate(queries)?.params[2])
      expect(note).toContain('missing middle')
      expect(note).not.toContain('Unmet: third criterion')
    },
  )

  it.if(present)(
    'leaves review state recoverable when queend is unavailable',
    async () => {
      process.env.TRIOS_QUEEND_PATH = join(
        tmpdir(),
        'queen-round-no-such-queend',
      )
      const { pool, queries } = roundPool([{ ...finishedRow(0), said: '' }])
      await expect(
        runRound(pool, 'me', 7, { held: true }, [ISSUE]),
      ).rejects.toThrow()

      expect(reviewUpdate(queries)).toBeUndefined()
    },
  )

  it.if(present)(
    'reopens one Bee after sendBack instead of parking behind stale review state',
    async () => {
      const { pool, queries, row } = parkedSendBackPool()
      prepareRetryWorkspace()
      process.env.ZAI_API_KEY = 'test-only-zai-key'
      process.env.TRIOS_API_TOKEN = 'test-only-server-token'
      const chatBodies: Array<Record<string, unknown>> = []
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = String(input)
        if (url.endsWith('/chat')) {
          chatBodies.push(JSON.parse(String(init?.body)))
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('data: {"type":"start"}\n'),
                )
              },
            }),
            { status: 200 },
          )
        }
        if (url.includes(`/issues/${ISSUE}`)) {
          return new Response(JSON.stringify({ number: ISSUE, body: BODY }), {
            status: 200,
          })
        }
        return new Response('[]', { status: 200 })
      }) as typeof fetch
      await runRound(pool, 'me', 7, { held: true }, [ISSUE])
      await runRound(pool, 'me', 8, { held: true }, [ISSUE])

      expect(reviewUpdate(queries)?.params[1]).toBe('sendBack')
      const claims = queries.filter((query) => isRetryClaim(query.sql))
      expect(claims).toHaveLength(1)
      expect(claims[0].params[0]).toBe(ISSUE)
      expect(claims[0].params[2]).toBe(0)
      expect(claims[0].params[3]).toBe('zai')
      expect(claims[0].params[4]).toBe('glm-5.3')
      expect(claims[0].sql).not.toContain('review_note = NULL')
      expect(chatBodies).toHaveLength(1)
      expect(chatBodies[0].provider).toBe('zai')
      expect(chatBodies[0].model).toBe('glm-5.3')
      expect(String(chatBodies[0].message)).toContain(
        'Queen feedback from the previous pass',
      )
      expect(String(chatBodies[0].message)).toContain('the tab opens')
      expect(row.send_backs).toBe(1)
      expect(row.retry_of_send_back).toBe(true)
      expect(row.started).toBe(true)
      expect(row.review_note).toContain('the tab opens')
      const dispatchRead = queries.find(
        (query) =>
          query.sql.includes('SELECT issue, branch, owned_paths') &&
          query.sql.includes('FROM queen_dispatch'),
      )
      expect(dispatchRead?.sql).toContain("review_state = 'sendBack'")
    },
  )

  it.if(present)('returns a first failure for a second pass', async () => {
    const { pool, queries } = roundPool([finishedRow(0)])
    await runRound(pool, 'me', 7, { held: true }, [ISSUE])

    const update = reviewUpdate(queries)
    expect(update?.params[1]).toBe('sendBack')
    expect(String(update?.params[2])).toContain('for a second pass')
  })

  /**
   * The sentence that was impossible. With the literal this said "second pass"
   * for a bee on its third attempt; the count off the row makes it say what is
   * true.
   */
  it.if(present)('names the pass it is actually asking for', async () => {
    const { pool, queries } = roundPool([finishedRow(1)])
    await runRound(pool, 'me', 7, { held: true }, [ISSUE])

    const update = reviewUpdate(queries)
    expect(update?.params[1]).toBe('sendBack')
    expect(String(update?.params[2])).toContain('for a third pass')
    expect(String(update?.params[2])).not.toContain('for a second pass')
  })

  /**
   * The arm that was unreachable from the cloud. At the ceiling the policy
   * stops returning work and asks for a person, which is the whole purpose of
   * `maximumSendBacks` and was dead code for as long as the container sent 0.
   */
  it.if(present)(
    'escalates at the ceiling instead of returning for ever',
    async () => {
      const { pool, queries } = roundPool([finishedRow(2)])
      await runRound(pool, 'me', 7, { held: true }, [ISSUE])

      const update = reviewUpdate(queries)
      expect(update?.params[1]).toBe('escalate')
      expect(String(update?.params[2])).toContain('a third return would repeat')
    },
  )

  /** A returned task increments; anything else leaves the count alone. */
  it.if(present)(
    'increments only on a send-back, in the statement that records it',
    async () => {
      const { pool, queries } = roundPool([finishedRow(0)])
      await runRound(pool, 'me', 7, { held: true }, [ISSUE])

      const update = reviewUpdate(queries)
      expect(update?.sql).toContain('send_backs = CASE')
      expect(update?.sql).toContain("'sendBack'")
      expect(update?.sql).toContain('send_backs + 1')
    },
  )

  /**
   * The column has to exist before the SELECT reads it. `ensureQueenColumns`
   * runs earlier in the round than `reviewFinishedDispatches` and this pins
   * that ordering: reversed, the first round on a restored database would fail
   * on a column the code has and the schema does not.
   */
  it.if(present)('adds the column before the round reads it', async () => {
    const { pool, sql } = roundPool([finishedRow(0)])
    await runRound(pool, 'me', 7, { held: true }, [ISSUE])

    const added = sql().findIndex((s) =>
      s.includes('ADD COLUMN IF NOT EXISTS send_backs'),
    )
    const read = sql().findIndex((s) => s.includes('d.send_backs'))
    expect(added).toBeGreaterThanOrEqual(0)
    expect(read).toBeGreaterThan(added)
  })
})

/**
 * The boundary question, asked at last.
 *
 * `queend` has answered `kind: "boundary"` since it was written and nothing had
 * ever asked it: the only place holding both halves of the comparison -
 * the files a branch committed and the paths the issue declared - threw the
 * file names away at `.length` to get a count for the review. This drives the
 * whole chain on a real repository, because the part most likely to be wrong is
 * the ROOT: git reports `trios/docs/x.md` from the checkout root while an owned
 * path is the project-relative `docs/x.md`, and handing the Swift rule the
 * checkout root instead of the project directory would report every correct
 * write as a violation - the exact false accusation `QueenBoundaryPaths`
 * records being paid for on #1286.
 */
function repoWithStray(): string {
  const root = mkdtempSync(join(tmpdir(), 'queen-round-'))
  const repo = join(root, 'BrowserOS')
  mkdirSync(join(repo, 'trios', 'docs'), { recursive: true })
  mkdirSync(join(repo, 'trios', 'src'), { recursive: true })
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'bee@example.invalid')
  git('config', 'user.name', 'a bee')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git('add', '-A')
  git('commit', '-m', 'base')
  git('checkout', '-b', `queen-${ISSUE}`)
  writeFileSync(join(repo, 'trios', 'docs', 'only-1234.md'), 'inside\n')
  writeFileSync(join(repo, 'trios', 'src', 'stray.ts'), 'export const x = 1\n')
  git('add', '-A')
  git('commit', '-m', 'work')
  git('checkout', 'main')
  return root
}

describe('queen round, boundary checked', () => {
  it.if(present)(
    'names the files a bee committed outside its boundary',
    async () => {
      process.env.WORKSPACE_DIR = repoWithStray()
      process.env.TRIOS_REPO_REF = 'main'
      const { pool, queries } = roundPool([finishedRow(0)])
      await runRound(pool, 'me', 7, { held: true }, [ISSUE])
      delete process.env.TRIOS_REPO_REF

      const update = reviewUpdate(queries)
      const strays = JSON.parse(String(update?.params[3])) as string[]
      // The stray is named and the file inside the boundary is NOT - which is the
      // half that proves the root was reduced correctly rather than the check
      // simply flagging everything.
      expect(strays).toEqual(['src/stray.ts'])

      // And the operator is told, because the brief now promises exactly that.
      const report = queries.find((q) =>
        q.sql.includes('INSERT INTO queen_report'),
      )
      expect(String(report?.params[1])).toContain('outside the boundary')
      expect(String(report?.params[1])).toContain('src/stray.ts')
    },
  )
})

describe('the brief promises only what the system does', () => {
  /**
   * `briefFor` told every bee "Work outside them is dropped rather than
   * reviewed", and nothing anywhere dropped anything - a bee's commit is its
   * commit, whatever it touched. A promise the system does not keep is worse
   * than no promise: it prices an out-of-boundary edit at zero.
   */
  it('does not promise to discard out-of-boundary work', async () => {
    const { briefFor, workerSystemPrompt } = await import(
      '../../src/api/services/queen-tick'
    )
    const brief = briefFor(ISSUE, 'gHashTag/BrowserOS', ['docs/a.md'], BODY)
    expect(brief).not.toContain('dropped rather than reviewed')
    expect(brief).toContain('not discarded')

    const prompt = workerSystemPrompt(ISSUE, 'gHashTag/BrowserOS', '/w', [
      'docs/a.md',
    ])
    expect(prompt).not.toContain('dropped rather than reviewed')
    expect(prompt).toContain('not discarded')
  })

  it('carries the Queens previous verdict into a retry brief', async () => {
    const { briefFor } = await import('../../src/api/services/queen-tick')
    const brief = briefFor(
      ISSUE,
      'gHashTag/trios',
      ['docs/only-1234.md'],
      BODY,
      ['the tab opens'],
      'stated',
      'The tab did not open; return for a second pass.',
    )
    expect(brief).toContain('## Queen feedback from the previous pass')
    expect(brief).toContain('The tab did not open')
  })
})

/**
 * A supervisor that guesses which repository it serves can dispatch bees at a
 * stranger's issues.
 *
 * The round used to fall back to `gHashTag/BrowserOS` when TRIOS_GITHUB_REPO
 * was unset - and that is the CHECKOUT, the monorepo this tree happens to be,
 * not the issue tracker. The mistake has already been made by a reader: two
 * rounds reported "0 open issues, confirmed twice" while both counts were taken
 * against BrowserOS and trios had forty.
 *
 * Unset is a configuration error. It must stop the round rather than pick a
 * repository, because reading the wrong one looks exactly like working.
 */
describe('queen round, repository named', () => {
  it('refuses to run rather than guess a repository', async () => {
    const before = process.env.TRIOS_GITHUB_REPO
    delete process.env.TRIOS_GITHUB_REPO
    try {
      const { pool } = roundPool()
      await expect(
        runRound(pool, 'me', 7, { held: true }, [ISSUE]),
      ).rejects.toThrow(/TRIOS_GITHUB_REPO is not set/)
    } finally {
      if (before === undefined) delete process.env.TRIOS_GITHUB_REPO
      else process.env.TRIOS_GITHUB_REPO = before
    }
  })

  it('names BrowserOS in the refusal, so the old default is recognisable', async () => {
    const before = process.env.TRIOS_GITHUB_REPO
    delete process.env.TRIOS_GITHUB_REPO
    try {
      const { pool } = roundPool()
      await expect(
        runRound(pool, 'me', 7, { held: true }, [ISSUE]),
      ).rejects.toThrow(/gHashTag\/BrowserOS/)
    } finally {
      if (before === undefined) delete process.env.TRIOS_GITHUB_REPO
      else process.env.TRIOS_GITHUB_REPO = before
    }
  })
})

/**
 * #1295. The refill gate: one local round at a time, woken by finished bees.
 *
 * A bee's completion frees a key the swarm paid for, and before this the next
 * eligible mission waited out the periodic tick for it. The gate is the whole
 * answer and adds nothing else: rounds still run through `runQueenTickOnce`,
 * so the lease, the fencing, `queend` and the dispatch loop are exactly what
 * they were - what changes is only WHEN a round starts.
 *
 * WHAT IS REAL HERE: nothing, deliberately. The gate is pure scheduling - one
 * round at a time, one deferred follow-up - so these cases drive it with a
 * controllable round released by hand. No timer, no sleep, no provider, no
 * database, because the questions are only ever "how many rounds" and "how
 * many at once", and a real round underneath would answer with failures of
 * its own that have suites of their own.
 */
describe('the refill gate', () => {
  /** A round the test can hold open and release, so ordering is observed
   *  rather than timed. */
  function controlledRound() {
    const events: string[] = []
    let inFlight = 0
    let peak = 0
    const held: Array<() => void> = []
    const run = async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      events.push('start')
      await new Promise<void>((release) => held.push(release))
      events.push('end')
      inFlight -= 1
    }
    return {
      events,
      run,
      release: () => held.shift()?.(),
      /** The most rounds that ever ran at once, measured here rather than
       *  trusted from the gate's own books. */
      peak: () => peak,
    }
  }

  /** Let every pending continuation run. Microtasks only - the gate schedules
   *  no timers, so nothing here ever waits in real time. */
  const settle = async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve()
  }

  it('starts a round at once when a slot frees and none is running', async () => {
    const round = controlledRound()
    const gate = createRoundGate(round.run)

    gate.request('bee #1295 finished')
    // At once means synchronously here: no timer fired, nothing was slept.
    expect(round.events).toEqual(['start'])

    round.release()
    await settle()
    await gate.idle()
    expect(gate.roundsStarted()).toBe(1)
  })

  /**
   * THE FOCUSED TEST of the issue: two completions landing while a round is
   * already in flight must coalesce into at most one follow-up round, and no
   * two local rounds may overlap - a second concurrent round in this process
   * would hold the lease as the same holder (the heartbeat comment in
   * queen-tick.ts records that overlap being reachable), read a half-written
   * board, and dispatch against work the first round is still recording.
   */
  it('holds local round concurrency at 1 across a two-completion burst', async () => {
    const round = controlledRound()
    const gate = createRoundGate(round.run)

    // The round already in flight: the one a completion lands during.
    gate.request('the round already in flight')
    expect(round.events).toEqual(['start'])

    gate.request('bee #1295-a finished')
    gate.request('bee #1295-b finished')
    // Coalesced: neither completion started a round of its own.
    expect(round.events).toEqual(['start'])
    expect(gate.roundsStarted()).toBe(1)

    round.release()
    await settle()
    // Exactly one follow-up for the burst - not one per completion.
    expect(gate.roundsStarted()).toBe(2)
    expect(round.events).toEqual(['start', 'end', 'start'])

    round.release()
    await settle()
    await gate.idle()
    expect(gate.roundsStarted()).toBe(2)
    // Never two at once, measured outside the gate's own counting...
    expect(round.peak()).toBe(1)
    // ...and the gate's own books say the same thing.
    expect(gate.maxInFlight()).toBe(1)
  })

  // Work-conserving cuts both ways: a signal that arrives while the
  // FOLLOW-UP runs must still get its own round, or a busy swarm quietly
  // stops refilling the moment two bees finish close together.
  it('still answers a signal that arrives while the follow-up runs', async () => {
    const round = controlledRound()
    const gate = createRoundGate(round.run)

    gate.request('first')
    gate.request('bee #1 finished')
    round.release()
    await settle()
    expect(gate.roundsStarted()).toBe(2)

    gate.request('bee #2 finished')
    round.release()
    await settle()
    expect(gate.roundsStarted()).toBe(3)

    round.release()
    await settle()
    await gate.idle()
    // Three rounds asked for by name, three rounds run, no runaway fourth.
    expect(gate.roundsStarted()).toBe(3)
  })

  // Scenario 4, the gate's half: with no completion, nothing starts. The
  // timer's half is `startQueenTick`, unchanged - it still requests the
  // initial round and keeps the configured interval.
  it('runs nothing until something asks, and no more after the last ask', async () => {
    const round = controlledRound()
    const gate = createRoundGate(round.run)

    await settle()
    await gate.idle()
    expect(round.events).toEqual([])
    expect(gate.roundsStarted()).toBe(0)
  })

  // Shutdown symmetry with the timer: `handover` clears the interval so no
  // periodic round starts after SIGTERM, and the gate must not undo that by
  // starting one a late completion asked for. A refill round after handover
  // would re-acquire the lease from a container that has already given the
  // hive away.
  it('refuses rounds once stopped, and drops the queued follow-up', async () => {
    const round = controlledRound()
    const gate = createRoundGate(round.run)

    gate.request('in flight when SIGTERM arrives')
    gate.request('bee #1 finished')
    gate.stop()
    round.release()
    await settle()
    await gate.idle()

    expect(round.events).toEqual(['start', 'end'])
    expect(gate.roundsStarted()).toBe(1)

    gate.request('bee #2 finished')
    await settle()
    expect(gate.roundsStarted()).toBe(1)
  })
})

/**
 * The wiring, not the gate: a durable close must reach the round the tick
 * loop runs, through the same connection `startQueenTick` makes. A gate that
 * exists while nothing signals it is indistinguishable from no gate - so this
 * drives the real hook and the real close, with only the round replaced.
 */
describe('a finished bee reaches the gate the tick installs', () => {
  /** A pool whose every statement answers with `rowCount` rows. */
  const answeringPool = (rowCount: number) =>
    ({
      query: async () => ({ rowCount, rows: [] }),
    }) as unknown as Pool

  it('runs exactly one round for one durable close', async () => {
    const rounds: string[] = []
    const gate = createRoundGate(async () => {
      rounds.push('round')
    })
    refillOnBeeCompletion(gate.request)

    await closeDispatch(answeringPool(1), 1295, 'conv-1295', 'finished')
    await gate.idle()
    expect(rounds).toEqual(['round'])
  })

  // FR-003 at the far end of the wire: a zero-row close reaches nobody. The
  // gate must not run a round on the strength of a slot the board still shows
  // as held.
  it('runs nothing for a close that matched no row', async () => {
    const rounds: string[] = []
    const gate = createRoundGate(async () => {
      rounds.push('round')
    })
    refillOnBeeCompletion(gate.request)

    await closeDispatch(answeringPool(0), 1295, 'conv-1295', 'finished')
    await gate.idle()
    expect(rounds).toEqual([])
  })
})
