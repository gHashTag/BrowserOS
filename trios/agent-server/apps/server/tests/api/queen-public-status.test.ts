import { describe, expect, it } from 'bun:test'
import {
  configuredBillingMode,
  createQueenPublicStatusRoute,
} from '../../src/api/routes/queen-public-status'

type QueryResult = { rowCount: number; rows: Array<Record<string, unknown>> }

function fakePool(results: QueryResult[]) {
  let at = 0
  let ended = false
  return {
    query: async () => results[at++] ?? { rowCount: 0, rows: [] },
    end: async () => {
      ended = true
    },
    wasEnded: () => ended,
  }
}

/**
 * The counts row and the latest-dispatch row every fixture below pairs with
 * its tick row, so each test states only the part it varies. `unreviewed`
 * rides along with the other counts the aggregate query returns.
 */
const emptyDispatchCounts: QueryResult = {
  rowCount: 1,
  rows: [{ total: '0', finished: '0', running: '0', unreviewed: '0' }],
}
const noLatestDispatch: QueryResult = { rowCount: 0, rows: [] }

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
  '#1210: a worker has it or is expected back (running)',
  '#1211: a worker has it or is expected back (rejected)',
  '#1215: the work already landed (accepted) - the issue is open and nobody closed it',
  '#1220: apps/server/src/api/routes/queen-status.ts held by gHashTag/trios#1188',
  '#1221: docs/board.md, apps/server/src/lib/board.ts held by gHashTag/trios#1189, gHashTag/trios#1190',
  '#1230: delegatable but not yet a spec - missing scenarios, success criteria',
  '#1231: delegatable but not yet a spec - missing requirements',
  '#1240: not first',
  '#1241: not first',
  '#1242: not first',
]

const expectedSummary = {
  claimed: 2,
  completed: 1,
  missingBoundary: 3,
  fileConflict: 2,
  incompleteSpec: 2,
  notFirst: 3,
}

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
            decided_at: '2026-09-01T04:17:42.983Z',
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
        rows: [{ total: '8', finished: '8', running: '0', unreviewed: '2' }],
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
    }).request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      status: 'ok',
      // Eight finished dispatches, two still owing a verdict: the idle
      // reading of the tick's refusal must lose to the verdicts owed.
      swarmState: 'waiting_for_review',
      scheduler: {
        enabled: true,
        intervalSeconds: 1800,
        billingMode: 'coding_plan',
        estimatedUSDGateEnabled: false,
      },
      lastTick: {
        decidedAt: '2026-09-01T04:17:42.983Z',
        allowed: false,
        refusal: 'nothing to choose',
        skippedCount: representativeSkipped.length,
        skipSummary: expectedSummary,
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
        lastTick: { skippedCount: number; skipSummary: Record<string, number> }
      }

    // Two reads of the same tick: identical bytes, or the summary is not
    // deterministic and a public consumer cannot rely on it.
    const first = await read()
    const second = await read()
    expect(JSON.stringify(first.lastTick.skipSummary)).toBe(
      JSON.stringify(second.lastTick.skipSummary),
    )

    const summary = first.lastTick.skipSummary
    expect(summary).toEqual({ ...expectedSummary, other: 2 })
    const total = Object.values(summary).reduce((a, b) => a + b, 0)
    expect(total).toBe(first.lastTick.skippedCount)
    expect(total).toBeLessThanOrEqual(first.lastTick.skippedCount)
    expect(total).toBeGreaterThan(0)
  })

  it('leaks no issue number, path, branch, title or secret from the skip reasons', async () => {
    // The four values the success criteria name - an issue number, a
    // repository path, a branch name, a title, a secret-looking value - plus
    // the one FR-003 adds. They are planted in the skip reasons AND in the
    // decision fields and dispatch-row columns the projection must ignore, so
    // the assertion covers every road out of this route, not just the summary.
    // One deliberate exception: `refusal` stays queend's closed template
    // ('nothing to choose' and its fixed siblings, main.swift), published as
    // it always has been, so it is not a channel a payload can ride.
    const leakIssue = '#1291'
    const leakPath = 'agent-server/apps/server/src/lib/queen-secret.ts'
    const leakBranch = 'queen-1291-leak-probe'
    const leakTitle = 'Teach the swarm to dream'
    const leakSecret = 'sk-trios-9f8e7d6c5b4a3210fedcba9876543210'

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
                `#1291: ${leakPath} held by ${leakSecret}`,
                `#1292: ${leakBranch}: a worker has it or is expected back (running)`,
                `#1293: ${leakTitle} not first`,
              ],
              note: leakBranch,
              providerKey: leakSecret,
              credentials: { token: leakSecret },
              chosenPaths: [leakPath],
              strays: [{ issue: 1291, paths: [leakPath] }],
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
            detail: leakSecret,
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
    }).request('/')

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    // The classification ran on planted rows without echoing any of them,
    // and an empty swarm under a live scheduler reads as health.
    expect(body.swarmState).toBe('healthy_idle')
    // The categorisation still worked while none of it was echoed back.
    expect(body.lastTick).toEqual({
      decidedAt: '2026-09-01T04:17:42.983Z',
      allowed: false,
      refusal: 'nothing to choose',
      skippedCount: 3,
      skipSummary: { claimed: 1, fileConflict: 1, notFirst: 1 },
    })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(leakIssue)
    expect(serialized).not.toContain(leakPath)
    expect(serialized).not.toContain(leakBranch)
    expect(serialized).not.toContain(leakTitle)
    expect(serialized).not.toContain(leakSecret)
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
    }).request('/')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      // The tick says it chose work while no dispatch is observable. This may
      // be the real recordTick -> recordDispatch window, so the snapshot is
      // unavailable until the row appears or a no-choice tick supersedes it.
      swarmState: 'unavailable',
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
        rows: [{ total: '3', finished: '1', running: '2', unreviewed: '1' }],
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
        rows: [{ total: '1', finished: '0', running: '1', unreviewed: '0' }],
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

  it('classifies finished unjudged work as waiting_for_review', async () => {
    // Scenario 2's rows: no unfinished dispatch, one finished dispatch whose
    // review_state is still null. The tick says the last round found nothing
    // eligible - the idle signal - and must lose to the verdict still owed,
    // because a swarm that looks empty but owes a review is not idle.
    const pool = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            decided_at: '2026-09-01T04:17:42.983Z',
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
        rows: [{ total: '1', finished: '1', running: '0', unreviewed: '1' }],
      },
      noLatestDispatch,
    ])
    const response = await createQueenPublicStatusRoute({
      databaseUrl: () => 'postgres://configured',
      createPool: () => pool,
      tickIntervalSeconds: () => 1800,
    }).request('/')
    const body = (await response.json()) as Record<string, unknown>
    expect(body.swarmState).toBe('waiting_for_review')
    expect((body.dispatches as Record<string, unknown>).unreviewed).toBe(1)
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
                '#1298: a worker has it or is expected back (running)',
                '#1299: not first',
              ],
            },
          },
        ],
      },
      {
        rowCount: 1,
        rows: [{ total: '2', finished: '2', running: '0', unreviewed: '0' }],
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
    })
  })
})
