import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  briefFor,
  classifyEscalation,
  classifyParkedEscalations,
  MAXIMUM_CONCURRENT_WORKERS,
  redispatchSentBackWork,
  SEND_BACK_RETRY_CEILING,
} from '../../src/api/services/queen-tick'

/**
 * The two review valves, #1362: a send-back used to be a full stop (the work
 * was returned and nothing ever re-dispatched it) and an escalation waited
 * for a person who was watching no Postgres column. These drive the retry
 * pass, the classifier and the reporter against fakes, because what is under
 * test here is WHICH STATEMENTS each pass issues and WHAT THE CLASSIFIER
 * DARES TO SAY - not the policy, which has its own suites.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. The passes are the real code. The
 * database is a recording fake (the assertion is which statements are
 * issued). `queend` is never asked: the retry pass deliberately does not go
 * through a `choose` question, so nothing here needs the binary. The
 * workspace for the one case that exercises `dispatchBee` for real is a
 * throwaway git repository, so `prepareWorktree` cuts a real worktree and
 * `startTurn` is failed deterministically at `fetch` - no bee is ever run.
 */

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
  'TRIOS_API_TOKEN',
  'TRIOS_QUEEND_PATH',
  'TRIOS_REPO_REF',
  'WORKSPACE_DIR',
  'TRIOS_GITHUB_REPO',
]

const saved: Record<string, string | undefined> = {}
const realFetch = globalThis.fetch

beforeAll(() => {
  for (const key of PROVIDER_KEYS) delete process.env[key]
})

beforeEach(() => {
  for (const key of PROVIDER_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.TRIOS_GITHUB_REPO = 'gHashTag/trios'
  // A workspace that is not there, so `committedFiles` answers nothing
  // deterministically rather than reading whatever machine runs the suite.
  process.env.WORKSPACE_DIR = join(tmpdir(), 'review-valves-no-such-workspace')
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  globalThis.fetch = realFetch
})

interface Recorded {
  sql: string
  params: unknown[]
}

/**
 * Postgres, answering the two statements the passes ask and recording all of
 * them. The send-back SELECT and the escalation SELECT are told apart by the
 * verdict they are scoped to, the way the passes themselves tell them apart.
 */
function poolAnswering(opts: {
  sentBack?: Array<Record<string, unknown>>
  escalated?: Array<Record<string, unknown>>
}) {
  const queries: Recorded[] = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      queries.push({ sql: text, params })
      if (
        text.includes("review_state = 'sendBack'") &&
        text.includes('FROM queen_dispatch')
      ) {
        return {
          rowCount: opts.sentBack?.length ?? 0,
          rows: opts.sentBack ?? [],
        }
      }
      if (
        text.includes("review_state = 'escalate'") &&
        text.includes('FROM queen_dispatch')
      ) {
        return {
          rowCount: opts.escalated?.length ?? 0,
          rows: opts.escalated ?? [],
        }
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, queries }
}

/** A dispatch insert, which `queen_dispatch_history` must not be mistaken for. */
const isDispatchInsert = (q: Recorded) =>
  /INSERT INTO queen_dispatch\b/.test(q.sql)

const insertFor = (queries: Recorded[], issue: number) =>
  queries.find((q) => isDispatchInsert(q) && q.params[0] === issue)

const updatesFor = (queries: Recorded[], issue: number) =>
  queries.filter(
    (q) =>
      q.sql.startsWith('UPDATE queen_dispatch') && q.params.includes(issue),
  )

/** A finished dispatch as the send-back pass reads it. */
const sentBackRow = (
  issue: number,
  sendBacks: number,
  said: string,
): Record<string, unknown> => ({
  issue,
  send_backs: sendBacks,
  conversation_id: `conv-${issue}`,
  said,
})

const SAID_WITH_UNMET = [
  '## VERDICT',
  '- the reporter prints 7 and 6: unmet',
  '- everything else: met',
].join('\n')

const BODY = [
  '## Success Criteria',
  '- the reporter prints 7 and 6.',
  '',
  '## Boundary',
  '`docs/only-1316.md`',
].join('\n')

/**
 * The ceiling is the policy's own number, read out of the Swift source the
 * way `tests/t27/ring00_parity.sh` pins its constants. Two copies of one
 * number in two languages is exactly how they drift; this fails the day
 * someone changes one without the other.
 */
describe('the ceiling, pinned to the policy', () => {
  it('equals QueenReviewDecision.maximumSendBacks', () => {
    const source = readFileSync(
      join(
        import.meta.dir,
        '../../../../queen-core/Sources/QueenCore/QueenReviewDecision.swift',
      ),
      'utf8',
    )
    const match = source.match(/maximumSendBacks = (\d+)/)
    expect(match).not.toBeNull()
    expect(SEND_BACK_RETRY_CEILING).toBe(Number(match?.[1]))
    expect(SEND_BACK_RETRY_CEILING).toBe(2)
  })

  it('names a worker limit equal to QueenDelegationPolicy.maximumConcurrentWorkers', () => {
    const source = readFileSync(
      join(
        import.meta.dir,
        '../../../../queen-core/Sources/QueenPolicy/QueenDelegation.swift',
      ),
      'utf8',
    )
    const match = source.match(/maximumConcurrentWorkers = (\d+)/)
    expect(match).not.toBeNull()
    expect(MAXIMUM_CONCURRENT_WORKERS).toBe(Number(match?.[1]))
  })
})

describe('classifyEscalation separates the causes', () => {
  it('says the run produced no files when every criterion was met and nothing was committed', () => {
    const answer = classifyEscalation({
      verdicts: [{ criterion: 'the run is quoted', met: true }],
      committedFiles: 0,
    })
    expect(answer.kind).toBe('no-files-produced')
    expect(answer.reason).toContain('no files were committed')
    expect(answer.reason).toContain("the bee's run")
  })

  it('does not call unmet work a no-files escalation', () => {
    const answer = classifyEscalation({
      verdicts: [{ criterion: 'the run is quoted', met: false }],
      committedFiles: 0,
    })
    expect(answer.kind).not.toBe('no-files-produced')
  })

  it('says the issue is unworkable when a criterion names a tool the container lacks, and names the criterion', () => {
    const answer = classifyEscalation({
      verdicts: [{ criterion: 'the build runs', met: false }],
      committedFiles: 0,
      criteria: ['the `swift build` run exits 0'],
      toolAvailable: () => false,
    })
    expect(answer.kind).toBe('issue-unworkable')
    expect(answer.reason).toContain('swift build')
    expect(answer.reason).toContain('`swift`')
  })

  it('does not call an issue unworkable for a tool that IS available', () => {
    const answer = classifyEscalation({
      verdicts: [{ criterion: 'the run is quoted', met: false }],
      committedFiles: 1,
      criteria: ['the `bun test` run is quoted'],
      toolAvailable: () => true,
    })
    // Available tool, files present, verdicts unmet: nothing is determined,
    // and the default must win over a guess.
    expect(answer.kind).toBe('needs-a-person')
  })

  it('says the issue is unworkable when the boundary names no reachable path, and names the paths', () => {
    const answer = classifyEscalation({
      verdicts: [],
      committedFiles: 0,
      boundaryPaths: ['/etc/hosts', '~/secrets'],
      pathReachable: () => false,
    })
    expect(answer.kind).toBe('issue-unworkable')
    expect(answer.reason).toContain('/etc/hosts')
    expect(answer.reason).toContain('~/secrets')
  })

  it('does not call an issue unworkable while any boundary path is reachable', () => {
    const answer = classifyEscalation({
      verdicts: [],
      committedFiles: 0,
      boundaryPaths: ['/etc/hosts', 'docs/x.md'],
      pathReachable: (p) => p === 'docs/x.md',
    })
    expect(answer.kind).toBe('needs-a-person')
  })

  it('classifies an unrecognised cause as undetermined, not as a specific kind', () => {
    const answer = classifyEscalation({
      verdicts: [
        { criterion: 'the run is quoted', met: false },
        { criterion: 'the totals print', met: true },
      ],
      committedFiles: 3,
      criteria: ['the run is quoted', 'the totals print'],
      toolAvailable: () => true,
      pathReachable: () => true,
    })
    expect(answer.kind).toBe('needs-a-person')
    expect(answer.kind).not.toBe('no-files-produced')
    expect(answer.kind).not.toBe('issue-unworkable')
    expect(answer.reason).toContain('not determined')
  })
})

describe('a sent-back dispatch becomes a candidate again, up to the ceiling', () => {
  it('re-dispatches one under the ceiling and marks the attempt as a retry', async () => {
    const { pool, queries } = poolAnswering({
      sentBack: [sentBackRow(1316, 1, SAID_WITH_UNMET)],
    })

    const round = await redispatchSentBackWork(
      pool,
      'gHashTag/trios',
      [1316],
      { '1316': BODY },
      {},
      0,
      [],
      { held: true },
    )

    // A candidate again: the dispatch was attempted and recorded, where
    // before this pass nothing ever reopened the issue.
    expect(insertFor(queries, 1316)).toBeDefined()
    expect(round.retried.map((r) => r.issue)).toEqual([1316])

    // Distinguishable from a first attempt, on the record.
    const mark = updatesFor(queries, 1316).find((q) =>
      q.sql.includes('send_back_retry = true'),
    )
    expect(mark).toBeDefined()

    // Not escalated: this row is under the ceiling.
    expect(
      updatesFor(queries, 1316).some((q) =>
        q.sql.includes("review_state = 'escalate'"),
      ),
    ).toBe(false)
  })

  it('escalates one at the ceiling instead of re-dispatching, naming the ceiling', async () => {
    const { pool, queries } = poolAnswering({
      sentBack: [sentBackRow(1311, 2, SAID_WITH_UNMET)],
    })

    const round = await redispatchSentBackWork(
      pool,
      'gHashTag/trios',
      [1311],
      { '1311': BODY },
      {},
      0,
      [],
      { held: true },
    )

    // NOT re-dispatched: no dispatch row was written for it.
    expect(insertFor(queries, 1311)).toBeUndefined()
    expect(round.retried).toEqual([])
    expect(round.ceilinged).toEqual([1311])

    // Its state becomes an escalation whose recorded reason names the ceiling.
    const flip = updatesFor(queries, 1311).find((q) =>
      q.sql.includes("review_state = 'escalate'"),
    )
    expect(flip).toBeDefined()
    expect(String(flip?.params[1])).toContain(
      `retry ceiling of ${SEND_BACK_RETRY_CEILING}`,
    )
    expect(String(flip?.params[1])).toContain('not re-dispatched')
  })

  it('leaves a sent-back dispatch alone when its issue has closed', async () => {
    const { pool, queries } = poolAnswering({
      sentBack: [sentBackRow(1351, 1, SAID_WITH_UNMET)],
    })

    const round = await redispatchSentBackWork(
      pool,
      'gHashTag/trios',
      // 1351 is not among the open issues this round.
      [1300],
      { '1300': BODY },
      {},
      0,
      [],
      { held: true },
    )

    // Neither re-dispatched nor escalated: the work is no longer wanted.
    expect(insertFor(queries, 1351)).toBeUndefined()
    expect(queries.some((q) => q.params.includes(1351))).toBe(false)
    expect(round.skippedClosed).toEqual([1351])
    expect(round.retried).toEqual([])
    expect(round.ceilinged).toEqual([])
  })

  /**
   * FR-005. The retry path must be scoped to send-backs alone: an escalation
   * - even one whose count is below the ceiling - is a verdict waiting for a
   * person, and an escalation automatically retried is worse than one parked
   * if the cause was a person's decision.
   */
  it('does not re-dispatch an escalation', async () => {
    const { pool, queries } = poolAnswering({
      escalated: [
        {
          issue: 1175,
          send_backs: 2,
          conversation_id: 'conv-1175',
          said: SAID_WITH_UNMET,
        },
      ],
    })

    await redispatchSentBackWork(
      pool,
      'gHashTag/trios',
      [1175],
      { '1175': BODY },
      {},
      0,
      [],
      { held: true },
    )

    // The pass asked only for send-backs, and dispatched nothing at all.
    const read = queries.find((q) => q.sql.includes('FROM queen_dispatch d'))
    expect(read?.sql).toContain("review_state = 'sendBack'")
    expect(queries.some(isDispatchInsert)).toBe(false)
  })

  it('waits when the swarm is already at the worker limit', async () => {
    const { pool, queries } = poolAnswering({
      sentBack: [sentBackRow(1316, 1, SAID_WITH_UNMET)],
    })

    const round = await redispatchSentBackWork(
      pool,
      'gHashTag/trios',
      [1316],
      { '1316': BODY },
      {},
      MAXIMUM_CONCURRENT_WORKERS,
      [],
      { held: true },
    )

    expect(queries.some(isDispatchInsert)).toBe(false)
    expect(round.retried).toEqual([])
  })

  /**
   * FR-002, the one that keeps the retry bounded. `send_backs` is the only
   * thing standing between a retry and an unbounded loop, and it survives a
   * redispatch only because the dispatch upsert deliberately does not name
   * the column. This asserts that omission where it lives - in the ON
   * CONFLICT clause of the very INSERT a retry issues - and that no
   * statement the pass writes assigns the counter either. Introduce a reset
   * (a `send_backs = 0` in the upsert, or an assignment anywhere here) and
   * this goes red.
   */
  it('does not reset send_backs across the retry', async () => {
    const { pool, queries } = poolAnswering({
      sentBack: [sentBackRow(1316, 1, SAID_WITH_UNMET)],
    })

    await redispatchSentBackWork(
      pool,
      'gHashTag/trios',
      [1316],
      { '1316': BODY },
      {},
      0,
      [],
      { held: true },
    )

    const insert = insertFor(queries, 1316)
    expect(insert).toBeDefined()
    const conflict = String(insert?.sql).slice(
      String(insert?.sql).indexOf('ON CONFLICT'),
    )
    expect(conflict).not.toContain('send_backs')
    // And nowhere else in the pass's own writing either.
    expect(queries.filter((q) => /send_backs\s*=/.test(q.sql))).toEqual([])
  })
})

describe('the brief a retried bee is given', () => {
  it('says why the bee is here again, and what was unmet', () => {
    const brief = briefFor(
      1316,
      'gHashTag/trios',
      ['docs/only-1316.md'],
      BODY,
      [],
      'none',
      { unmet: ['the reporter prints 7 and 6'], sendBacks: 1 },
    )
    expect(brief).toContain('Why you are here again')
    expect(brief).toContain('This is a retry, not a first attempt')
    expect(brief).toContain('1. the reporter prints 7 and 6')
    expect(brief).toContain(`send-back 1 of ${SEND_BACK_RETRY_CEILING}`)
  })

  it('keeps the ceiling in view even when the previous verdict cannot be re-read', () => {
    const brief = briefFor(
      1316,
      'gHashTag/trios',
      ['docs/only-1316.md'],
      BODY,
      [],
      'none',
      { unmet: [], sendBacks: 1 },
    )
    expect(brief).toContain('could not be re-read')
    expect(brief).toContain(`of ${SEND_BACK_RETRY_CEILING}`)
  })

  it('tells a first attempt nothing about retries', () => {
    const brief = briefFor(1316, 'gHashTag/trios', ['docs/only-1316.md'], BODY)
    expect(brief).not.toContain('Why you are here again')
  })
})

describe('parked escalations are classified, not acted on', () => {
  it('writes the kind on the row, from the evidence the row still holds', async () => {
    const { pool, queries } = poolAnswering({
      escalated: [
        {
          issue: 1244,
          conversation_id: 'conv-1244',
          criteria: [],
          owned_paths: [],
          said: '## VERDICT\n- everything promised: met',
        },
      ],
    })

    // WORKSPACE_DIR points nowhere, so `committedFiles` answers nothing -
    // every criterion met against zero files, which is the no-files case.
    const classified = await classifyParkedEscalations(pool)

    expect(classified.map((c) => c.issue)).toEqual([1244])
    expect(classified[0]?.kind).toBe('no-files-produced')
    const write = updatesFor(queries, 1244).find((q) =>
      q.sql.includes('escalation_kind = $2'),
    )
    expect(write).toBeDefined()
    expect(write?.params[1]).toBe('no-files-produced')
    expect(String(write?.params[2])).toContain('no files were committed')
    // The read is scoped to the unclassified, so a classified row is left
    // alone on a re-run.
    const read = queries.find((q) => q.sql.includes('FROM queen_dispatch d'))
    expect(read?.sql).toContain('escalation_kind IS NULL')
  })

  it('writes needs-a-person when the cause is not determined, and dispatches nothing', async () => {
    const { pool, queries } = poolAnswering({
      escalated: [
        {
          issue: 1291,
          conversation_id: 'conv-1291',
          criteria: ['the `bun test` run is quoted'],
          owned_paths: ['docs/x.md'],
          said: '## VERDICT\n- the run is quoted: unmet',
        },
      ],
    })

    const classified = await classifyParkedEscalations(pool)

    expect(classified[0]?.kind).toBe('needs-a-person')
    expect(classified[0]?.kind).not.toBe('no-files-produced')
    expect(classified[0]?.kind).not.toBe('issue-unworkable')
    // Classification is a label for the operator: no code path here
    // re-dispatches an escalation on the strength of it.
    expect(queries.some(isDispatchInsert)).toBe(false)
  })
})

/**
 * The one case that runs `dispatchBee` for real: a throwaway repository, a
 * throwaway provider credential, and a `fetch` that answers 500 so the turn
 * fails deterministically after the worktree is cut. What this observes that
 * the fake-pool cases cannot: the CRITERIA the retry records (FR-006 - they
 * must be re-read from the issue, not inherited from the attempt that
 * failed) and the BRIEF the second bee actually receives (the unmet list,
 * FR-003/story 1 scenario 4).
 */
function workspaceWithOrigin(): string {
  const root = mkdtempSync(join(tmpdir(), 'review-valves-'))
  const source = join(root, 'source')
  mkdirSync(source, { recursive: true })
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: source, encoding: 'utf8' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'bee@example.invalid')
  git('config', 'user.name', 'a bee')
  writeFileSync(join(source, 'README.md'), 'base\n')
  git('add', '-A')
  git('commit', '-m', 'base')
  // A clone, so `git fetch origin` inside the workspace answers from a local
  // path: no network, and `prepareWorktree` can cut the branch for real.
  spawnSync('git', ['clone', '--quiet', source, join(root, 'BrowserOS')], {
    encoding: 'utf8',
  })
  return root
}

describe('the retry dispatch, end to end to the refusal', () => {
  // A real repository, a real fetch, a real worktree: this one is measured in
  // git subprocesses rather than promises, so it carries its own timeout and
  // is judged on the work.
  it('re-reads the criteria at retry time and briefs the bee with what was unmet', async () => {
    const root = workspaceWithOrigin()
    process.env.WORKSPACE_DIR = root
    process.env.TRIOS_REPO_REF = 'main'
    process.env.ZAI_API_KEY = 'x'
    process.env.TRIOS_API_TOKEN = 'x'
    const briefs: string[] = []
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      briefs.push(String(JSON.parse(String(init?.body)).message))
      return new Response('not today', { status: 500 })
    }) as typeof fetch

    const { pool, queries } = poolAnswering({
      sentBack: [sentBackRow(1316, 1, SAID_WITH_UNMET)],
    })
    const round = await redispatchSentBackWork(
      pool,
      'gHashTag/trios',
      [1316],
      { '1316': BODY },
      {
        '1316': {
          delegatable: true,
          isSpec: false,
          missing: [],
          remedy: '',
          criteria: ['the corrected criterion, re-read from the issue now'],
          criteriaSource: 'stated',
        },
      },
      0,
      [],
      { held: true },
    )

    // The turn was attempted for real and refused by the chat endpoint -
    // deterministically, at the stubbed fetch.
    expect(round.retried).toEqual([
      {
        issue: 1316,
        started: false,
        conversationId: expect.any(String),
        keyIndex: 0,
      },
    ])

    // FR-006: the dispatch records the criteria re-read THIS round from the
    // current issue body, not the dead attempt's contract.
    const insert = insertFor(queries, 1316)
    expect(insert).toBeDefined()
    expect(insert?.params[7]).toBe(
      JSON.stringify(['the corrected criterion, re-read from the issue now']),
    )
    expect(insert?.params[8]).toBe('stated')

    // The brief the second bee receives: the retry section and the unmet
    // criterion from the previous attempt's own verdict.
    expect(briefs).toHaveLength(1)
    expect(briefs[0]).toContain('Why you are here again')
    expect(briefs[0]).toContain('1. the reporter prints 7 and 6')

    // Distinguishable from a first attempt even though no bee ran: the
    // refusal is still a retry attempt, on the record.
    const mark = updatesFor(queries, 1316).find((q) =>
      q.sql.includes('send_back_retry = true'),
    )
    expect(mark).toBeDefined()
  }, 30000)
})

/**
 * Story 3: the parked queue is countable. The thirteen rows quoted in the
 * issue, as the operator's query would dump them, against the real script
 * under `node`.
 */
const PARKED_ROWS = [
  {
    issue: 1244,
    review_state: 'escalate',
    send_backs: 0,
    finished_at: '2026-08-31T18:05:00Z',
    escalation_kind: 'needs-a-person',
  },
  {
    issue: 1240,
    review_state: 'escalate',
    send_backs: 0,
    finished_at: '2026-08-31T19:40:00Z',
    escalation_kind: 'issue-unworkable',
  },
  {
    issue: 1216,
    review_state: 'escalate',
    send_backs: 0,
    finished_at: '2026-08-31T21:12:00Z',
    escalation_kind: 'no-files-produced',
  },
  {
    issue: 1316,
    review_state: 'sendBack',
    send_backs: 1,
    finished_at: '2026-09-02T09:30:00Z',
  },
  {
    issue: 1318,
    review_state: 'sendBack',
    send_backs: 1,
    finished_at: '2026-09-02T10:02:00Z',
  },
  {
    issue: 1175,
    review_state: 'escalate',
    send_backs: 2,
    finished_at: '2026-09-02T11:44:00Z',
    escalation_kind: 'needs-a-person',
  },
  {
    issue: 1311,
    review_state: 'sendBack',
    send_backs: 2,
    finished_at: '2026-09-02T14:20:00Z',
  },
  {
    issue: 1133,
    review_state: 'escalate',
    send_backs: 2,
    finished_at: '2026-09-02T16:55:00Z',
    escalation_kind: null,
  },
  {
    issue: 1291,
    review_state: 'escalate',
    send_backs: 2,
    finished_at: '2026-09-02T18:31:00Z',
    escalation_kind: 'needs-a-person',
  },
  {
    issue: 1332,
    review_state: 'sendBack',
    send_backs: 1,
    finished_at: '2026-09-03T08:15:00Z',
  },
  {
    issue: 1328,
    review_state: 'sendBack',
    send_backs: 1,
    finished_at: '2026-09-03T09:47:00Z',
  },
  {
    issue: 1338,
    review_state: 'sendBack',
    send_backs: 1,
    finished_at: '2026-09-03T11:26:00Z',
  },
  {
    issue: 1350,
    review_state: 'sendBack',
    send_backs: 1,
    finished_at: '2026-09-03T12:58:00Z',
  },
]

const REPORTER = join(
  import.meta.dir,
  '../../../../../tools/parked-dispatch-report.mjs',
)

describe('the parked dispatch report', () => {
  it('counts the thirteen rows as 7 send-backs and 6 escalations, with their ages', () => {
    const fixture = join(tmpdir(), 'parked-rows-1362.json')
    writeFileSync(fixture, JSON.stringify(PARKED_ROWS))

    const run = spawnSync(process.execPath, [REPORTER, fixture], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('sendBack: 7')
    expect(run.stdout).toContain('escalate: 6')
    // Every row printed with its issue, state, attempts and age in days.
    expect(run.stdout).toContain('#1244  escalate  send_backs=0  age=')
    expect(run.stdout).toContain('#1350  sendBack  send_backs=1  age=0d')
    expect(run.stdout.match(/age=\d+d/g)?.length).toBe(13)
    // Escalations carry their kind, classified or honestly not yet.
    expect(run.stdout).toContain('kind=no-files-produced')
    expect(run.stdout).toContain('kind=needs-a-person (not yet classified)')
  })

  it('refuses loudly when the rows cannot be read, rather than printing an empty queue', () => {
    const run = spawnSync(
      process.execPath,
      [REPORTER, join(tmpdir(), 'parked-rows-that-do-not-exist.json')],
      { encoding: 'utf8' },
    )
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('could not read rows')
  })
})
