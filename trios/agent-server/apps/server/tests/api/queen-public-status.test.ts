import { describe, expect, it } from 'bun:test'
import { createQueenPublicStatusRoute } from '../../src/api/routes/queen-public-status'

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
 * its tick row, so each test states only the part it varies.
 */
const emptyDispatchCounts: QueryResult = {
  rowCount: 1,
  rows: [{ total: '0', finished: '0', running: '0' }],
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
        rows: [{ total: '8', finished: '8', running: '0' }],
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
    }).request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      status: 'ok',
      scheduler: { enabled: true, intervalSeconds: 1800 },
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

  it('leaks no issue number, path, branch or title from the skip reasons', async () => {
    // The three values the success criteria name, plus the one FR-003 adds:
    // an issue number, a repository path, a branch name, a title. They are
    // planted in the skip reasons AND in the decision fields and dispatch-row
    // columns the projection must ignore, so the assertion covers every road
    // out of this route, not just the summary.
    const leakIssue = '#1291'
    const leakPath = 'agent-server/apps/server/src/lib/queen-secret.ts'
    const leakBranch = 'queen-1291-leak-probe'
    const leakTitle = 'Teach the swarm to dream'

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
                `#1291: ${leakPath} held by gHashTag/trios#1188`,
                `#1292: ${leakBranch}: a worker has it or is expected back (running)`,
                `#1293: ${leakTitle} not first`,
              ],
              note: leakBranch,
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
            conversation_id: 'secret-conversation',
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
      scheduler: { enabled: true, intervalSeconds: 1800 },
      lastTick: {
        decidedAt: '2026-08-30T09:00:00.000Z',
        allowed: true,
        refusal: null,
        skippedCount: 0,
        skipSummary: {},
      },
      dispatches: { total: 0, finished: 0, running: 0, latest: null },
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
    expect(body.scheduler).toEqual({ enabled: false, intervalSeconds: 0 })
    expect(body.lastTick).toBeNull()
    expect(body.dispatches.latest).toBeNull()
  })
})
