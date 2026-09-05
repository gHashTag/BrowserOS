import { describe, expect, it } from 'bun:test'
import {
  configuredBillingMode,
  createQueenPublicStatusRoute,
  SKIP_ISSUE_LIST_CAP,
} from '../../src/api/routes/queen-public-status'
import { configuredWorkerCapacity } from '../../src/api/services/queen-dispatch'

type QueryResult = { rowCount: number; rows: Array<Record<string, unknown>> }

function fakePool(results: QueryResult[]) {
  let at = 0
  let ended = false
  const statements: string[] = []
  return {
    query: async (sql?: string) => {
      // Counted, not parsed: the contract under test is HOW MANY queries a
      // read issues, never their text.
      if (typeof sql === 'string') statements.push(sql)
      return results[at++] ?? { rowCount: 0, rows: [] }
    },
    end: async () => {
      ended = true
    },
    wasEnded: () => ended,
    statementCount: () => statements.length,
  }
}

/**
 * The counts row and the latest-dispatch row every fixture below pairs with
 * its tick row, so each test states only the part it varies. `unreviewed`
 * and `started_running` ride along with the other counts the aggregate
 * query returns.
 */
const emptyDispatchCounts: QueryResult = {
  rowCount: 1,
  rows: [
    {
      total: '0',
      finished: '0',
      running: '0',
      unreviewed: '0',
      started_running: '0',
    },
  ],
}
const noLatestDispatch: QueryResult = { rowCount: 0, rows: [] }

/**
 * A clock fixed inside the fixtures' own time, so whether a tick is fresh is
 * a property of the fixture rather than of when the suite happens to run.
 * READ_AT sits half an interval after FRESH_TICK_DECIDED_AT (interval 1800s,
 * freshness window two intervals) and hours after every stale date below.
 *
 * Tick-backed queue states echo the decision time as `observedAt`; table-
 * backed ones echo READ_AT - both pinned exactly by these constants.
 */
const FRESH_TICK_DECIDED_AT = '2026-09-01T04:17:42.983Z'
const READ_AT = '2026-09-01T04:47:42.983Z'
const STALE_TICK_DECIDED_AT = '2026-09-01T00:47:42.983Z'
const fixedNow = () => Date.parse(READ_AT)

/**
 * One skip reason per sentence `queend` writes, verbatim in shape
 * (queen-core/Sources/queend/main.swift): issue number, payload, and for the
 * conflict reasons the very paths and holders that must never leave this
 * projection as anything but a count.
 */
const representativeSkipped = [
  '#1204: not yet a spec - missing boundary, scenarios, requirements, success criteria',
  '#1205: no issue body was supplied, so its boundary is unknown',
  '#1206: declares no boundary',
  '#1210: a worker already has it (running)',
  '#1211: it is rejected - claimed, but no worker is attached yet',
  '#1215: the work already landed (accepted) - the issue is open and nobody closed it',
  '#1220: apps/server/src/api/routes/queen-status.ts held by gHashTag/trios#1188',
  '#1221: docs/board.md, apps/server/src/lib/board.ts held by gHashTag/trios#1189, gHashTag/trios#1190',
  '#1230: delegatable but not yet a spec - missing scenarios, success criteria',
  '#1231: delegatable but not yet a spec - missing requirements',
  '#1240: not first',
  '#1241: not first',
  '#1242: not first',
]

/**
 * What every category above becomes: the count it always was, the issue
 * numbers behind it, and `more`, everything counted but not listed. Every
 * reason here carries its number, so every `more` is 0 and every list has
 * its count's length - the invariant the equality tests below pin.
 */
const expectedSummary = {
  claimed: { count: 2, issues: [1210, 1211], more: 0 },
  completed: { count: 1, issues: [1215], more: 0 },
  missingBoundary: { count: 3, issues: [1204, 1205, 1206], more: 0 },
  fileConflict: { count: 2, issues: [1220, 1221], more: 0 },
  incompleteSpec: { count: 2, issues: [1230, 1231], more: 0 },
  notFirst: { count: 3, issues: [1240, 1241, 1242], more: 0 },
}

/**
 * The tick of 2026-09-03T17:24:42Z that issue #1352 quotes: 51 skips whose
 * counts were all true and none usable, because no issue number was
 * published. The two missing boundaries the operator dug out by hand were
 * #957 and #380 - the payload has to say so itself now.
 */
const incidentSkipped = [
  ...Array.from(
    { length: 13 },
    (_, i) => `#${1010 + i}: a worker already has it (running)`,
  ),
  ...Array.from(
    { length: 34 },
    (_, i) =>
      `#${2001 + i}: the work already landed (accepted) - the issue is open and nobody closed it`,
  ),
  '#957: declares no boundary',
  '#380: no issue body was supplied, so its boundary is unknown',
  '#410: apps/server/src/api/routes/queen-status.ts held by gHashTag/trios#1188',
  '#420: delegatable but not yet a spec - missing scenarios, success criteria',
] as string[]

/**
 * User story 2's tick: one reason matching 200 issues, past the cap, plus
 * the round-level sentence a tick stores without a number.
 */
const truncatedSkipped = [
  ...Array.from({ length: 200 }, (_, i) => `#${3000 + i}: not first`),
  'no registry mirror published yet',
] as string[]

type PublishedSummary = {
  lastTick: {
    skippedCount: number
    skipIssueListCap: number
    skipSummary: Record<
      string,
      { count: number; issues: number[]; more: number }
    >
  }
}

/** Read /queen/status over one tick's skip array with an empty dispatch table. */
const readTick = async (skipped: unknown[]): Promise<PublishedSummary> =>
  (await (
    await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () =>
        fakePool([
          {
            rowCount: 1,
            rows: [
              {
                decided_at: '2026-09-03T17:24:42.000Z',
                decision: {
                  allowed: false,
                  refusal: 'nothing to choose',
                  skipped,
                },
              },
            ],
          },
          emptyDispatchCounts,
          noLatestDispatch,
        ]),
      tickIntervalSeconds: () => 1800,
    }).request('/')
  ).json()) as PublishedSummary

describe('configuredBillingMode', () => {
  it('requires the explicit Coding Plan value and otherwise stays metered', () => {
    expect(configuredBillingMode('coding_plan')).toBe('coding_plan')
    expect(configuredBillingMode(' CODING_PLAN ')).toBe('coding_plan')
    expect(configuredBillingMode(undefined)).toBe('api_metered')
    expect(configuredBillingMode('')).toBe('api_metered')
    expect(configuredBillingMode('subscription')).toBe('api_metered')
  })
})

describe('GET /queen/status', () => {
  it('returns only the public runtime summary', async () => {
    const pool = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            decided_at: FRESH_TICK_DECIDED_AT,
            decision: {
              allowed: false,
              refusal: 'nothing to choose',
              skipped: representativeSkipped,
              privateNote: 'must not escape',
            },
          },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            total: '8',
            finished: '8',
            running: '0',
            unreviewed: '2',
            started_running: '0',
          },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            issue: 1290,
            dispatched_at: '2026-08-31T17:07:16.580Z',
            finished_at: '2026-08-31T17:11:21.414Z',
            outcome: 'finished',
            branch: 'queen-1290',
            conversation_id: 'secret-conversation',
            detail: 'provider and model detail',
          },
        ],
      },
    ])

    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: () => 1800,
      billingMode: () => 'coding_plan',
      workerCapacity: () => 4,
      now: fixedNow,
    }).request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      status: 'ok',
      // Eight finished dispatches, two still owing a verdict - but the latest
      // tick refused with `nothing to choose`, so the tick measured the
      // blockade and it is the backlog, not the owed reviews. The verdicts
      // stay counted under dispatches.unreviewed; they just cannot name the
      // quiet while the tick that measured it says otherwise.
      swarmState: 'healthy_idle',
      // Paid slots exist and are all idle: running 0 here is an empty queue,
      // not missing capacity.
      workers: {
        capacity: 4,
        active: 0,
        idle: 4,
        utilization: 0,
      },
      // Four paid slots, all idle, and a fresh explicit no-choice decision
      // behind them: the queue is empty, which is the answer an operator
      // needs before reaching for a restart.
      queue: {
        state: 'no-eligible-work',
        observedAt: FRESH_TICK_DECIDED_AT,
      },
      scheduler: {
        enabled: true,
        intervalSeconds: 1800,
        billingMode: 'coding_plan',
        estimatedUSDGateEnabled: false,
      },
      lastTick: {
        decidedAt: FRESH_TICK_DECIDED_AT,
        allowed: false,
        refusal: 'nothing to choose',
        skippedCount: representativeSkipped.length,
        skipSummary: expectedSummary,
        skipIssueListCap: SKIP_ISSUE_LIST_CAP,
      },
      dispatches: {
        total: 8,
        finished: 8,
        running: 0,
        unreviewed: 2,
        latest: {
          issue: 1290,
          dispatchedAt: '2026-08-31T17:07:16.580Z',
          finishedAt: '2026-08-31T17:11:21.414Z',
          outcome: 'finished',
        },
      },
    })
    expect(pool.wasEnded()).toBe(true)
  })

  it('aggregates deterministically and never counts past skippedCount', async () => {
    // Mixed with what a real round also stores: a round-level reason the
    // chooser never wrote (no registry mirror) and a non-string entry jsonb
    // could have kept. Both must be filed, not dropped or crashed on, or the
    // summary would stop summing to skippedCount.
    const skipped = [
      ...representativeSkipped,
      'no registry mirror published yet',
      1299,
    ]
    const tickRow = {
      rowCount: 1,
      rows: [
        {
          decided_at: '2026-09-01T04:17:42.983Z',
          decision: { allowed: false, refusal: 'nothing to choose', skipped },
        },
      ],
    }
    const route = (pool: ReturnType<typeof fakePool>) =>
      createQueenPublicStatusRoute({
        databaseUrl: () => 'postgres://configured',
        createPool: () => pool,
        tickIntervalSeconds: () => 1800,
      })

    const read = async () =>
      (await (
        await route(fakePool([tickRow, emptyDispatchCounts, noLatestDispatch]))
      )
        .request('/')
        .then((r) => r.json())) as {
        lastTick: {
          skippedCount: number
          skipSummary: Record<string, { count: number; more: number }>
        }
      }

    // Two reads of the same tick: identical bytes, or the summary is not
    // deterministic and a public consumer cannot rely on it.
    const first = await read()
    const second = await read()
    expect(JSON.stringify(first.lastTick.skipSummary)).toBe(
      JSON.stringify(second.lastTick.skipSummary),
    )

    // The numberless pair is counted under `other` and contributes no issue:
    // its count is whole and its `more` carries the whole count, so the
    // category still obeys list + more === count.
    const summary = first.lastTick.skipSummary
    expect(summary).toEqual({
      ...expectedSummary,
      other: { count: 2, issues: [], more: 2 },
    })
    const total = Object.values(summary).reduce((a, b) => a + b.count, 0)
    expect(total).toBe(first.lastTick.skippedCount)
    expect(total).toBeLessThanOrEqual(first.lastTick.skippedCount)
    expect(total).toBeGreaterThan(0)
  })

  it('publishes issue numbers bare and leaks no path, branch, title or secret', async () => {
    // A repository path, a branch name, a title, a secret-looking value, and
    // the one shape an issue number can ride in - a `#`-prefixed token. They
    // are planted in the skip reasons AND in the decision fields and
    // dispatch-row columns the projection must ignore, so the assertion
    // covers every road out of this route, not just the summary. The issue
    // number itself now leaves, by design and bare (issue #1352); the probe
    // pins that nothing beyond the number can.
    // One deliberate exception: `refusal` stays queend's closed template
    // ('nothing to choose' and its fixed siblings, main.swift), published as
    // it always has been, so it is not a channel a payload can ride.
    const leakIssue = '#1291'
    const leakPath = 'agent-server/apps/server/src/lib/queen-secret.ts'
    const leakBranch = 'queen-1291-leak-probe'
    const leakTitle = 'Teach the swarm to dream'
    const leakSecret = 'sk-trios-9f8e7d6c5b4a3210fedcba9876543210'
    // The two values the queue criteria add: an issue body and a transcript
    // excerpt, planted where a scheduler would actually hold them, to prove
    // the newest field opens no newest channel.
    const leakBody =
      'Boundary: the sacred scroll of queen-secret.ts and nothing else'
    const leakTranscript =
      '<turn>worker murmurs the sacred scroll of queen-secret.ts</turn>'

    const pool = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            decided_at: FRESH_TICK_DECIDED_AT,
            decision: {
              allowed: false,
              refusal: 'nothing to choose',
              skipped: [
                `${leakIssue}: ${leakPath} held by ${leakSecret}`,
                `#1292: ${leakBranch}: a worker already has it (running)`,
                `#1293: ${leakTitle} not first`,
              ],
              note: leakBranch,
              providerKey: leakSecret,
              credentials: { token: leakSecret },
              chosenPaths: [leakPath],
              strays: [{ issue: 1291, paths: [leakPath] }],
              candidateBodies: { 1291: leakBody },
              transcript: leakTranscript,
            },
          },
        ],
      },
      emptyDispatchCounts,
      {
        rowCount: 1,
        rows: [
          {
            issue: 1290,
            dispatched_at: '2026-08-31T17:07:16.580Z',
            finished_at: null,
            outcome: 'running',
            branch: leakBranch,
            title: leakTitle,
            detail: leakTranscript,
            review_note: leakSecret,
            conversation_id: leakSecret,
            provider: leakSecret,
            model: leakSecret,
          },
        ],
      },
    ])

    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: () => 1800,
      workerCapacity: () => 4,
      now: fixedNow,
    }).request('/')

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    // The classification ran on planted rows without echoing any of them,
    // and an empty swarm under a live scheduler reads as health.
    expect(body.swarmState).toBe('healthy_idle')
    // The queue projection is closed: one state word, one timestamp, and no
    // third key a payload could ever ride.
    expect(body.queue).toEqual({
      state: 'no-eligible-work',
      observedAt: FRESH_TICK_DECIDED_AT,
    })
    expect(Object.keys(body.queue as object).sort()).toEqual([
      'observedAt',
      'state',
    ])
    // The categorisation still worked, and what it published is the issue
    // numbers - bare integers - and nothing else the reasons carried.
    expect(body.lastTick).toEqual({
      decidedAt: FRESH_TICK_DECIDED_AT,
      allowed: false,
      refusal: 'nothing to choose',
      skippedCount: 3,
      skipSummary: {
        fileConflict: { count: 1, issues: [1291], more: 0 },
        claimed: { count: 1, issues: [1292], more: 0 },
        notFirst: { count: 1, issues: [1293], more: 0 },
      },
      skipIssueListCap: SKIP_ISSUE_LIST_CAP,
    })
    const serialized = JSON.stringify(body)
    // FR-001, stated positively and negatively: the numbers leave as bare
    // integers, so no `#`-prefixed token - the shape the reasons store, and
    // the only shape a payload could ride out in - appears anywhere, while
    // the path, the branch, the title and the secret never appear at all.
    expect(serialized).not.toContain('#')
    expect(serialized).not.toContain(leakPath)
    expect(serialized).not.toContain(leakBranch)
    expect(serialized).not.toContain(leakTitle)
    expect(serialized).not.toContain(leakSecret)
    expect(serialized).not.toContain(leakBody)
    expect(serialized).not.toContain(leakTranscript)
  })

  it('summarises a legacy decision with no skip array as empty', async () => {
    // An older tick predates the skip array. The response it produced must
    // stay valid, with a summary that says nothing rather than one that
    // guesses.
    const pool = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            decided_at: '2026-08-30T09:00:00.000Z',
            decision: { allowed: true, refusal: null, chosen: 1288 },
          },
        ],
      },
      emptyDispatchCounts,
      noLatestDispatch,
    ])

    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: () => 1800,
      workerCapacity: () => 4,
      now: fixedNow,
    }).request('/')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      // The tick says it chose work while no dispatch is observable. This may
      // be the real recordTick -> recordDispatch window, so the snapshot is
      // unavailable until the row appears or a no-choice tick supersedes it.
      swarmState: 'unavailable',
      // Capacity is configured but nothing holds it, so the four slots read
      // idle - the unavailable state is about why, not how many.
      workers: {
        capacity: 4,
        active: 0,
        idle: 4,
        utilization: 0,
      },
      // And the queue cannot claim dispatched work the table does not show,
      // nor an empty queue a decision this old never said. The state is
      // unknown, dated by the row that went quiet.
      queue: {
        state: 'unknown',
        observedAt: '2026-08-30T09:00:00.000Z',
      },
      scheduler: {
        enabled: true,
        intervalSeconds: 1800,
        billingMode: 'api_metered',
        estimatedUSDGateEnabled: true,
      },
      lastTick: {
        decidedAt: '2026-08-30T09:00:00.000Z',
        allowed: true,
        refusal: null,
        skippedCount: 0,
        skipSummary: {},
        skipIssueListCap: SKIP_ISSUE_LIST_CAP,
      },
      dispatches: {
        total: 0,
        finished: 0,
        running: 0,
        unreviewed: 0,
        latest: null,
      },
    })
  })

  it('returns 503 when no Queen database is configured', async () => {
    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => undefined,
    }).request('/')
    expect(response.status).toBe(503)
  })

  it('reports an enabled scheduler only for a positive interval', async () => {
    const pool = fakePool([
      { rowCount: 0, rows: [] },
      emptyDispatchCounts,
      noLatestDispatch,
    ])
    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: () => 0,
    }).request('/')
    const body = await response.json()
    expect(body.scheduler).toEqual({
      enabled: false,
      intervalSeconds: 0,
      billingMode: 'api_metered',
      estimatedUSDGateEnabled: true,
    })
    // No scheduler, no tick, nothing running and nothing owed: the one
    // honest word for that is unavailable, not idle.
    expect(body.swarmState).toBe('unavailable')
    expect(body.lastTick).toBeNull()
    expect(body.dispatches.latest).toBeNull()
  })

  it('classifies unfinished work as working over every other signal', async () => {
    // A dispatch that has not finished is a fact about the present, read
    // straight off the table; everything else this route knows is a fact
    // about the last round. So one fixture says all of it at once - a
    // verdict owed (unreviewed), a scheduler nobody enabled, no tick row -
    // and working must still win, because "unavailable" would deny work
    // the table itself vouches for.
    const everythingElseSaysStop = fakePool([
      { rowCount: 0, rows: [] },
      {
        rowCount: 1,
        rows: [
          {
            total: '3',
            finished: '1',
            running: '2',
            unreviewed: '1',
            started_running: '2',
          },
        ],
      },
      noLatestDispatch,
    ])
    const stopped = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => everythingElseSaysStop,
      tickIntervalSeconds: () => 0,
    }).request('/')
    expect(((await stopped.json()) as Record<string, unknown>).swarmState).toBe(
      'working',
    )

    // And the calm version: scheduler on, a tick that chose, one bee in
    // flight. Nothing to outrank, and still working.
    const quiet = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            decided_at: '2026-09-01T04:17:42.983Z',
            decision: { allowed: true, refusal: null, chosen: 1296 },
          },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            total: '1',
            finished: '0',
            running: '1',
            unreviewed: '0',
            started_running: '1',
          },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            issue: 1296,
            dispatched_at: '2026-09-01T04:17:50.000Z',
            finished_at: null,
            outcome: null,
          },
        ],
      },
    ])
    const healthy = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => quiet,
      tickIntervalSeconds: () => 1800,
    }).request('/')
    const healthyBody = (await healthy.json()) as {
      swarmState: string
      dispatches: { running: number; unreviewed: number }
    }
    expect(healthyBody.swarmState).toBe('working')
    expect(healthyBody.dispatches.running).toBe(1)
    expect(healthyBody.dispatches.unreviewed).toBe(0)
  })

  it('cannot read waiting_for_review off a tick that refused with nothing to choose', async () => {
    // Issue #1352's second wrong signal, verbatim: swarmState
    // waiting_for_review, running 0, refusal 'nothing to choose'. The tick
    // measured the blockade - it examined every candidate and could start
    // none - so the quiet belongs to the backlog, and a state naming the
    // owed review as its cause is naming a cause the tick did not measure.
    // The refusal and the state must be readings of the same tick record.
    const emptyBacklog = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            decided_at: '2026-09-03T17:24:42.000Z',
            decision: {
              allowed: false,
              refusal: 'nothing to choose',
              skipped: ['#1297: not first'],
            },
          },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            total: '1',
            finished: '1',
            running: '0',
            unreviewed: '1',
            started_running: '0',
          },
        ],
      },
      noLatestDispatch,
    ])
    const body = (await (
      await createQueenPublicStatusRoute({
        databaseUrl: () => 'postgres://configured',
        createPool: () => emptyBacklog,
        tickIntervalSeconds: () => 1800,
      }).request('/')
    ).json()) as Record<string, unknown>
    expect(body.swarmState).not.toBe('waiting_for_review')
    expect(body.swarmState).toBe('healthy_idle')
    // The verdict still owed is not erased - it stays counted, just not
    // mislabeled as the reason the swarm is quiet.
    expect((body.dispatches as Record<string, unknown>).unreviewed).toBe(1)

    // And the control: identical counts, but the tick chose work rather than
    // measuring the backlog empty. Nothing outranks the owed verdict then,
    // and waiting_for_review keeps the meaning it always had.
    const owesVerdict = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            decided_at: '2026-09-03T17:24:42.000Z',
            decision: { allowed: true, refusal: null, chosen: 1296 },
          },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            total: '1',
            finished: '1',
            running: '0',
            unreviewed: '1',
            started_running: '0',
          },
        ],
      },
      noLatestDispatch,
    ])
    const control = (await (
      await createQueenPublicStatusRoute({
        databaseUrl: () => 'postgres://configured',
        createPool: () => owesVerdict,
        tickIntervalSeconds: () => 1800,
      }).request('/')
    ).json()) as Record<string, unknown>
    expect(control.swarmState).toBe('waiting_for_review')
  })

  it('classifies an empty swarm under a live scheduler as healthy_idle', async () => {
    // Scenario 3's rows: nothing running, nothing owed, scheduler enabled,
    // and a readable tick whose decision found no eligible candidate. On the
    // production base this reads as refusal 'nothing to choose' with
    // allowed false - failure-shaped - which is exactly the ambiguity this
    // state exists to close.
    const pool = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            decided_at: '2026-09-01T04:17:42.983Z',
            decision: {
              allowed: false,
              refusal: 'nothing to choose',
              skipped: [
                '#1298: a worker already has it (running)',
                '#1299: not first',
              ],
            },
          },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            total: '2',
            finished: '2',
            running: '0',
            unreviewed: '0',
            started_running: '0',
          },
        ],
      },
      noLatestDispatch,
    ])
    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: () => 1800,
    }).request('/')
    expect(
      ((await response.json()) as Record<string, unknown>).swarmState,
    ).toBe('healthy_idle')
  })

  it('does not call an allowed decision with no observable dispatch healthy', async () => {
    const pool = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            decided_at: '2026-09-01T04:17:42.983Z',
            decision: { allowed: true, refusal: null, chosen: 1296 },
          },
        ],
      },
      emptyDispatchCounts,
      noLatestDispatch,
    ])
    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: () => 1800,
    }).request('/')
    expect(
      ((await response.json()) as Record<string, unknown>).swarmState,
    ).toBe('unavailable')
  })

  it('classifies a swarm nobody vouches for as unavailable', async () => {
    const read = async (pool: ReturnType<typeof fakePool>, tick: number) =>
      (await (
        await createQueenPublicStatusRoute({
          databaseUrl: () => 'postgres://configured',
          createPool: () => pool,
          tickIntervalSeconds: () => tick,
        }).request('/')
      ).json()) as Record<string, unknown>

    // A disabled scheduler with a perfectly readable tick: the tick explains
    // yesterday, and nothing explains today.
    const schedulerOff = await read(
      fakePool([
        {
          rowCount: 1,
          rows: [
            {
              decided_at: '2026-09-01T04:17:42.983Z',
              decision: { allowed: false, refusal: 'nothing to choose' },
            },
          ],
        },
        emptyDispatchCounts,
        noLatestDispatch,
      ]),
      0,
    )
    expect(schedulerOff.swarmState).toBe('unavailable')

    // An enabled scheduler that has never decided: no tick row, so no basis
    // for calling the silence healthy.
    const noTick = await read(
      fakePool([
        { rowCount: 0, rows: [] },
        emptyDispatchCounts,
        noLatestDispatch,
      ]),
      1800,
    )
    expect(noTick.swarmState).toBe('unavailable')

    // A tick whose decision cannot be read is not a trustworthy tick, even
    // though the row itself still reports under lastTick as it always has.
    const unreadable = await read(
      fakePool([
        {
          rowCount: 1,
          rows: [
            { decided_at: '2026-09-01T04:17:42.983Z', decision: 'corrupt' },
          ],
        },
        emptyDispatchCounts,
        noLatestDispatch,
      ]),
      1800,
    )
    expect(unreadable.swarmState).toBe('unavailable')
    expect(unreadable.lastTick).toEqual({
      decidedAt: '2026-09-01T04:17:42.983Z',
      allowed: false,
      refusal: null,
      skippedCount: 0,
      skipSummary: {},
      skipIssueListCap: SKIP_ISSUE_LIST_CAP,
    })
  })
})

describe('skipSummary issue numbers', () => {
  it('keeps issues.length + more === count for every reason across three fixture ticks', async () => {
    // FR-005's three ticks: one with zero skips, the 2026-09-03 incident,
    // and one whose reasons outrun the cap. For every reason in every tick
    // the equality the success criteria name must hold, and the counts must
    // still sum to skippedCount. Drop `more` from the payload and the
    // equality line fails: a missing number is never a count.
    const fixtures = [[], incidentSkipped, truncatedSkipped] as unknown[][]

    for (const skipped of fixtures) {
      const body = await readTick(skipped)
      expect(body.lastTick.skipIssueListCap).toBe(SKIP_ISSUE_LIST_CAP)
      const entries = Object.values(body.lastTick.skipSummary)
      expect(entries.reduce((sum, entry) => sum + entry.count, 0)).toBe(
        body.lastTick.skippedCount,
      )
      for (const entry of entries) {
        expect(Number.isInteger(entry.count)).toBe(true)
        expect(entry.issues.every(Number.isInteger)).toBe(true)
        expect(entry.issues.length).toBeLessThanOrEqual(SKIP_ISSUE_LIST_CAP)
        expect(entry.more).toBeGreaterThanOrEqual(0)
        expect(entry.issues.length + entry.more).toBe(entry.count)
      }
    }

    // The zero-skip tick says nothing rather than guessing: no category
    // appears, so a page cannot render a reason the round never had.
    expect((await readTick([])).lastTick.skipSummary).toEqual({})
  })

  it('names the two issues behind missingBoundary: 2', async () => {
    // Scenario 1.2, straight from the incident: the two numbers the operator
    // had to read all 51 issues to learn are in the payload, and their sum
    // matches the count.
    const body = await readTick(incidentSkipped)
    expect(body.lastTick.skippedCount).toBe(51)
    expect(body.lastTick.skipSummary.missingBoundary).toEqual({
      count: 2,
      issues: [957, 380],
      more: 0,
    })
    expect(body.lastTick.skipSummary.claimed).toEqual({
      count: 13,
      issues: Array.from({ length: 13 }, (_, i) => 1010 + i),
      more: 0,
    })
    expect(body.lastTick.skipSummary.incompleteSpec).toEqual({
      count: 1,
      issues: [420],
      more: 0,
    })
  })

  it('caps the numbers it publishes and stays inside a stated byte ceiling', async () => {
    // User story 2: a reason matching 200 issues. The payload carries the
    // cap worth of numbers plus the remainder, the cap itself rides along
    // so the truncation is knowable, and the whole response stays under
    // this stated ceiling: 4096 bytes, room for every category truncated.
    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () =>
        fakePool([
          {
            rowCount: 1,
            rows: [
              {
                decided_at: '2026-09-03T17:24:42.000Z',
                decision: {
                  allowed: false,
                  refusal: 'nothing to choose',
                  skipped: truncatedSkipped,
                },
              },
            ],
          },
          emptyDispatchCounts,
          noLatestDispatch,
        ]),
      tickIntervalSeconds: () => 1800,
    }).request('/')
    const text = await response.text()
    expect(text.length).toBeLessThan(4096)

    const body = JSON.parse(text) as PublishedSummary
    expect(body.lastTick.skipIssueListCap).toBe(SKIP_ISSUE_LIST_CAP)
    expect(body.lastTick.skippedCount).toBe(201)
    expect(body.lastTick.skipSummary.notFirst).toEqual({
      count: 200,
      issues: Array.from({ length: SKIP_ISSUE_LIST_CAP }, (_, i) => 3000 + i),
      more: 200 - SKIP_ISSUE_LIST_CAP,
    })
    // The round-level sentence is counted but never numbered, and `more`
    // carries it whole rather than dropping it from the sum.
    expect(body.lastTick.skipSummary.other).toEqual({
      count: 1,
      issues: [],
      more: 1,
    })
  })

  it('lists the skipped issue, never the holder a conflict names', async () => {
    // A file conflict names its holders after the paths - `#1188` is another
    // issue's number, the holder's, and only the leading number is the
    // skipped issue. The holder must not ride out as a number either: the
    // count is about #1220, and 1188 belongs to a live task's brief.
    const body = await readTick([
      '#1220: apps/server/src/api/routes/queen-status.ts held by gHashTag/trios#1188',
    ])
    expect(body.lastTick.skipSummary.fileConflict).toEqual({
      count: 1,
      issues: [1220],
      more: 0,
    })
    expect(JSON.stringify(body)).not.toContain('1188')
  })

  /**
   * The queue fixtures below share one shape so each states only what it
   * varies: four paid slots, a 1800s tick interval, and a read at READ_AT.
   */
  const queueRoute = (
    pool: ReturnType<typeof fakePool>,
    opts?: {
      workerCapacity?: () => number
      tickIntervalSeconds?: () => number
    },
  ) =>
    createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: opts?.tickIntervalSeconds ?? (() => 1800),
      workerCapacity: opts?.workerCapacity ?? (() => 4),
      now: fixedNow,
    })

  const noChoiceTick = (decidedAt: string): QueryResult => ({
    rowCount: 1,
    rows: [
      {
        decided_at: decidedAt,
        decision: {
          allowed: false,
          refusal: 'nothing to choose',
          skipped: ['#1298: not first'],
        },
      },
    ],
  })

  const runningCounts = (running: number): QueryResult => ({
    rowCount: 1,
    rows: [
      {
        total: String(running),
        finished: '0',
        running: String(running),
        unreviewed: '0',
        started_running: String(running),
      },
    ],
  })

  const queueOf = async (
    pool: ReturnType<typeof fakePool>,
    opts?: {
      workerCapacity?: () => number
      tickIntervalSeconds?: () => number
    },
  ): Promise<{ state: string; observedAt: string }> => {
    const body = (await (await queueRoute(pool, opts).request('/')).json()) as {
      queue: { state: string; observedAt: string }
    }
    return body.queue
  }

  it('reads idle paid slots as no-eligible-work from the explicit no-choice decision', async () => {
    // Acceptance scenario 1: four idle slots, nothing running, and a last
    // tick refused as `nothing to choose`. The skip summary explains WHY each
    // candidate was passed over; the queue state is the one word a dashboard
    // can print next to 0% utilization without guessing.
    const pool = fakePool([
      noChoiceTick(FRESH_TICK_DECIDED_AT),
      runningCounts(0),
      noLatestDispatch,
    ])
    expect(await queueOf(pool)).toEqual({
      state: 'no-eligible-work',
      observedAt: FRESH_TICK_DECIDED_AT,
    })
  })

  it('reads a full worker pool as capacity-full regardless of skipped candidates', async () => {
    // Acceptance scenario 2: active workers equal capacity, so there is no
    // idle slot left to explain - and the tick's skip story must not re-explain
    // a full hive as an empty queue. The tick here is fresh AND explicitly
    // no-choice with a skipped candidate, exactly the rows that would read
    // no-eligible-work if precedence were the other way round.
    const fullWithSkips = fakePool([
      noChoiceTick(FRESH_TICK_DECIDED_AT),
      runningCounts(4),
      noLatestDispatch,
    ])
    expect(await queueOf(fullWithSkips)).toEqual({
      state: 'capacity-full',
      observedAt: READ_AT,
    })

    // And with no tick row at all: the table alone vouches for the full pool,
    // dated by the read rather than by telemetry that does not exist.
    const fullWithoutTick = fakePool([
      { rowCount: 0, rows: [] },
      runningCounts(4),
      noLatestDispatch,
    ])
    expect(await queueOf(fullWithoutTick)).toEqual({
      state: 'capacity-full',
      observedAt: READ_AT,
    })
  })

  it('reads partial utilization as work-dispatched on the dispatch table alone', async () => {
    // The fourth closed state: two of four slots busy. The tick is stale and
    // no-choice besides, and none of that matters - unfinished dispatches are
    // a fact about the present, read straight off the table, so the queue is
    // demonstrably supplying work and the free slots belong to a round that
    // has not happened yet.
    const pool = fakePool([
      noChoiceTick(STALE_TICK_DECIDED_AT),
      runningCounts(2),
      noLatestDispatch,
    ])
    expect(await queueOf(pool)).toEqual({
      state: 'work-dispatched',
      observedAt: READ_AT,
    })
  })

  it('never calls a stale or missing tick an empty queue', async () => {
    // Acceptance scenario 3: scheduler telemetry absent or stale reads as
    // unknown, never as no-eligible-work. A decision four hours old explains
    // a scheduler that stopped, not a queue that is empty.
    const stale = fakePool([
      noChoiceTick(STALE_TICK_DECIDED_AT),
      runningCounts(0),
      noLatestDispatch,
    ])
    expect(await queueOf(stale)).toEqual({
      state: 'unknown',
      observedAt: STALE_TICK_DECIDED_AT,
    })

    // No tick row at all: nothing was ever observed, so the observation is
    // the read itself.
    const missing = fakePool([
      { rowCount: 0, rows: [] },
      runningCounts(0),
      noLatestDispatch,
    ])
    expect(await queueOf(missing)).toEqual({
      state: 'unknown',
      observedAt: READ_AT,
    })

    // A row whose decision cannot be read says nothing, even at a fresh date;
    // `lastTick` still publishes the row exactly as it always has.
    const unreadable = fakePool([
      {
        rowCount: 1,
        rows: [{ decided_at: FRESH_TICK_DECIDED_AT, decision: 'corrupt' }],
      },
      runningCounts(0),
      noLatestDispatch,
    ])
    expect(await queueOf(unreadable)).toEqual({
      state: 'unknown',
      observedAt: FRESH_TICK_DECIDED_AT,
    })
  })

  it('reserves no-eligible-work for the closed nothing-to-choose refusal', async () => {
    // Other refusals are work the queue HAD and something else refused. A
    // spent budget (queend's other closed template, main.swift) with every
    // slot idle is not an empty queue, and must not read as one.
    const budgetRefusal = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            decided_at: FRESH_TICK_DECIDED_AT,
            decision: {
              allowed: false,
              refusal:
                'the swarm has spent about $10.85 today, $0.85 past its ' +
                '$10.00 daily limit (raise it with TRIOS_SWARM_DAILY_CAP_USD)',
            },
          },
        ],
      },
      runningCounts(0),
      noLatestDispatch,
    ])
    expect((await queueOf(budgetRefusal)).state).toBe('unknown')

    // A decision that chose work vouches for neither an empty queue nor a
    // dispatch the table cannot show - the same window swarmState refuses to
    // call healthy.
    const choseWork = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            decided_at: FRESH_TICK_DECIDED_AT,
            decision: { allowed: true, refusal: null, chosen: 1296 },
          },
        ],
      },
      runningCounts(0),
      noLatestDispatch,
    ])
    expect((await queueOf(choseWork)).state).toBe('unknown')

    // A disabled scheduler: a perfectly fresh, perfectly explicit no-choice
    // decision from a loop nobody restarted explains yesterday, not today.
    const schedulerOff = fakePool([
      noChoiceTick(FRESH_TICK_DECIDED_AT),
      runningCounts(0),
      noLatestDispatch,
    ])
    expect(
      (await queueOf(schedulerOff, { tickIntervalSeconds: () => 0 })).state,
    ).toBe('unknown')

    // No paid slot configured: whether a slot is idle is unknowable, and an
    // unknowable idle must not borrow the empty-queue word.
    const noCapacity = fakePool([
      noChoiceTick(FRESH_TICK_DECIDED_AT),
      runningCounts(0),
      noLatestDispatch,
    ])
    expect((await queueOf(noCapacity, { workerCapacity: () => 0 })).state).toBe(
      'unknown',
    )
  })

  it('derives the queue projection without a fourth database query', async () => {
    // The queue state is computed from the rows this route has always read -
    // the tick row, the counts, the latest dispatch - plus the configured
    // capacity, which comes from the environment and not the database. The
    // count proves no query was added and none was skipped to compensate: the
    // projection still derived a state.
    const pool = fakePool([
      noChoiceTick(FRESH_TICK_DECIDED_AT),
      runningCounts(4),
      noLatestDispatch,
    ])
    const response = await queueRoute(pool).request('/')
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect((body.queue as { state: string }).state).toBe('capacity-full')
    expect(pool.statementCount()).toBe(3)
    expect(pool.wasEnded()).toBe(true)
  })
})

describe('workers utilization', () => {
  it('gives running 0 a denominator: four slots with two started dispatches read half busy', async () => {
    // Four configured worker slots, two unfinished started dispatches, no
    // provider key set anywhere - the capacity is injected because the point
    // here is the projection, not the environment. `running: 2` next to
    // capacity 4 is an operator's whole answer: 2 active, 2 idle, 50 percent.
    const pool = fakePool([
      { rowCount: 0, rows: [] },
      {
        rowCount: 1,
        rows: [
          {
            total: '3',
            finished: '1',
            running: '2',
            unreviewed: '1',
            started_running: '2',
          },
        ],
      },
      noLatestDispatch,
    ])

    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: () => 1800,
      workerCapacity: () => 4,
      now: fixedNow,
    }).request('/')

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.workers).toEqual({
      capacity: 4,
      active: 2,
      idle: 2,
      utilization: 50,
    })
    // The denominator explains the counts; it must not reshape them.
    expect((body.dispatches as Record<string, unknown>).running).toBe(2)
  })

  it('reports all zeros for zero configured capacity and exposes no credential name or value', async () => {
    // Zero configured worker slots. Every field is 0, and the
    // credential-shaped values planted in the rows the projection reads
    // past - the counts row and the latest-dispatch row - must not ride
    // along: this page's capacity source is the provider environment, so its
    // names and values are the one leak that would matter most here.
    const plantedSecret = 'sk-trios-0123456789abcdef-fedcba'
    const pool = fakePool([
      { rowCount: 0, rows: [] },
      {
        rowCount: 1,
        rows: [
          {
            total: '1',
            finished: '0',
            running: '1',
            unreviewed: '0',
            started_running: '1',
            provider: 'ZAI_API_KEY',
            credential: plantedSecret,
            authorization: `Bearer ${plantedSecret}`,
          },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            issue: 1303,
            dispatched_at: '2026-09-02T10:00:00.000Z',
            finished_at: null,
            outcome: null,
            branch: 'queen-1303',
            detail: `Bearer ${plantedSecret}`,
            conversation_id: plantedSecret,
            provider: 'ANTHROPIC_API_KEY',
            model: plantedSecret,
          },
        ],
      },
    ])

    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: () => 1800,
      workerCapacity: () => 0,
      now: fixedNow,
    }).request('/')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.workers).toEqual({
      capacity: 0,
      active: 0,
      idle: 0,
      utilization: 0,
    })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('ZAI_API_KEY')
    expect(serialized).not.toContain('ANTHROPIC_API_KEY')
    expect(serialized).not.toContain('Bearer')
    expect(serialized).not.toContain(plantedSecret)
  })

  it('does not count a started = false unfinished dispatch as active', async () => {
    // Two unfinished dispatches, neither of which started. They stay
    // `running` - the table owes them an ending - but they spend no paid
    // slot, so active is 0 against capacity 4 and all four slots read idle.
    // Today's writer finishes a dispatch that never started (recordDispatch
    // writes the ending up front), so a row shaped like this is a legacy or
    // hand-written one; the projection must read it honestly all the same.
    const pool = fakePool([
      { rowCount: 0, rows: [] },
      {
        rowCount: 1,
        rows: [
          {
            total: '2',
            finished: '0',
            running: '2',
            unreviewed: '0',
            started_running: '0',
          },
        ],
      },
      noLatestDispatch,
    ])

    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: () => 0,
      workerCapacity: () => 4,
      now: fixedNow,
    }).request('/')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      workers: Record<string, number>
      dispatches: { running: number }
    }
    expect(body.workers).toEqual({
      capacity: 4,
      active: 0,
      idle: 4,
      utilization: 0,
    })
    expect(body.dispatches.running).toBe(2)
  })

  it('clamps malformed counts so active never exceeds capacity and idle never goes negative', async () => {
    // A count can only arrive wrong - the same row counted twice, a float, a
    // negative, a non-number - and every wrong shape must fold into the
    // closed range rather than promise slots the swarm does not have or
    // report over-subscription as a negative idle.
    const read = async (startedRunning: unknown, capacity: number) =>
      (
        (await (
          await createQueenPublicStatusRoute({
            databaseUrl: () => 'postgres://configured',
            createPool: () =>
              fakePool([
                { rowCount: 0, rows: [] },
                {
                  rowCount: 1,
                  rows: [
                    {
                      total: '9',
                      finished: '0',
                      running: '9',
                      unreviewed: '0',
                      started_running: startedRunning,
                    },
                  ],
                },
                noLatestDispatch,
              ]),
            tickIntervalSeconds: () => 1800,
            workerCapacity: () => capacity,
            now: fixedNow,
          }).request('/')
        ).json()) as Record<string, unknown>
      ).workers

    // Seven active dispatches against four slots: the swarm cannot spend
    // more slots than it has, so the projection says full, never over.
    expect(await read('7', 4)).toEqual({
      capacity: 4,
      active: 4,
      idle: 0,
      utilization: 100,
    })
    // A negative count is no count at all.
    expect(await read(-2, 4)).toEqual({
      capacity: 4,
      active: 0,
      idle: 4,
      utilization: 0,
    })
    // A fractional dispatch is not a dispatch.
    expect(await read('2.9', 4)).toEqual({
      capacity: 4,
      active: 2,
      idle: 2,
      utilization: 50,
    })
    // Malformed capacity admits no slots at all, and with no denominator
    // there is nothing to be active or idle.
    expect(await read('3', Number.NaN)).toEqual({
      capacity: 0,
      active: 0,
      idle: 0,
      utilization: 0,
    })
    expect(await read('3', 0)).toEqual({
      capacity: 0,
      active: 0,
      idle: 0,
      utilization: 0,
    })
  })

  it('reads capacity from the same authority as public research, not a second parser', async () => {
    // The denominator must come from `configuredWorkerCapacity` - the one
    // function that counts provider keys for dispatch and for
    // /queen/public-research. With a key planted in the environment and NO
    // workerCapacity injected, this route must report exactly what that one
    // authority reports, and must not echo the key or its variable name.
    const planted = 'sk-trios-env-authority-probe-fedcba9876'
    const saved = process.env.ZAI_API_KEY
    process.env.ZAI_API_KEY = planted
    try {
      const response = await createQueenPublicStatusRoute({
        databaseUrl: () => 'postgres://configured',
        createPool: () =>
          fakePool([
            { rowCount: 0, rows: [] },
            emptyDispatchCounts,
            noLatestDispatch,
          ]),
        tickIntervalSeconds: () => 1800,
        now: fixedNow,
      }).request('/')

      const body = (await response.json()) as {
        workers: { capacity: number }
      }
      expect(body.workers.capacity).toBe(configuredWorkerCapacity())
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain('ZAI_API_KEY')
      expect(serialized).not.toContain(planted)
    } finally {
      if (saved === undefined) delete process.env.ZAI_API_KEY
      else process.env.ZAI_API_KEY = saved
    }
  })
})
