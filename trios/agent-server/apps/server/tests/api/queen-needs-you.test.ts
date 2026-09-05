import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import {
  createQueenNeedsYouRoute,
  DEFAULT_REPORT_LIMIT,
  MAX_REPORT_LIMIT,
} from '../../src/api/routes/queen-needs-you'
import { report } from '../../src/api/services/queen-tick'

type QueryResult = {
  rowCount: number | null
  rows: Array<Record<string, unknown>>
}

const empty: QueryResult = { rowCount: 0, rows: [] }

/**
 * Postgres answering the two shapes this route asks for, matched on fragments
 * of the statements rather than on order - the same discipline the round suite
 * records: a fake that encodes the order agrees with whatever the code does.
 * Every statement is recorded so the SQL itself can be asserted, not just its
 * effect. Rows carry MORE than the projection should ever return - bodies,
 * branches, conversation ids, provider detail - because a projection is proven
 * by what it drops, and a fixture without secrets proves nothing.
 */
function needsYouPool(reports: QueryResult, escalations: QueryResult) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: String(sql), params })
      const text = String(sql)
      if (text.includes('FROM queen_report')) return reports
      if (text.includes("review_state = 'escalate'")) return escalations
      return empty
    },
    end: async () => {},
  }
  return { pool, queries }
}

/** The production rows of 2026-09-04, the day the issue was measured. */
const NOW = Date.parse('2026-09-04T12:00:00.000Z')

const read = (pool: ReturnType<typeof needsYouPool>['pool'], path = '/') =>
  createQueenNeedsYouRoute({
    databaseUrl: () =>
      'postgres://secret-token@db-queen.internal.example:5432/queen',
    createPool: () => pool,
    now: () => NOW,
  }).request(path)

const reportsFixture: QueryResult = {
  rowCount: 2,
  rows: [
    {
      at: '2026-09-04T11:58:00.000Z',
      headline: 'nothing to choose',
      needs_you: false,
      // Present on the row, absent from the answer: the body names paths and
      // holders, and FR-001 is the whole reason it stays behind.
      body: 'Started nothing. apps/server/src/api/routes/queen-status.ts held by gHashTag/trios#1188',
    },
    {
      at: '2026-09-03T09:00:00.000Z',
      headline: '1 waiting on you',
      needs_you: true,
      body: 'ESCALATED 1 to you.',
    },
  ],
}

const escalationsFixture: QueryResult = {
  rowCount: 2,
  rows: [
    {
      issue: 1244,
      review_state: 'escalate',
      review_note:
        'the task has no acceptance criteria, so there is nothing to judge it ' +
        'against - it can only be abandoned or accepted on faith',
      since: '2026-08-31T19:12:00.000Z',
      reviewed_at: '2026-08-31T19:12:00.000Z',
      branch: 'queen-1244',
      conversation_id: 'secret-conversation',
      detail: 'provider and model detail',
    },
    {
      issue: 1175,
      review_state: 'escalate',
      review_note:
        'returned 2 time(s) already and 4 criterion(s) are still unmet; ' +
        'a third return would repeat a conversation that has not moved',
      since: '2026-09-02T21:36:00.000Z',
      reviewed_at: '2026-09-02T21:36:00.000Z',
      branch: 'queen-1175',
      conversation_id: 'another-secret-conversation',
      detail: 'provider and model detail',
    },
  ],
}

describe('GET /queen/needs-you', () => {
  it('returns the reports and the outstanding escalations, and nothing else', async () => {
    const { pool } = needsYouPool(reportsFixture, escalationsFixture)
    const response = await read(pool)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      status: 'ok',
      reports: {
        limit: DEFAULT_REPORT_LIMIT,
        returned: 2,
        items: [
          {
            at: '2026-09-04T11:58:00.000Z',
            headline: 'nothing to choose',
            needsYou: false,
          },
          {
            at: '2026-09-03T09:00:00.000Z',
            headline: '1 waiting on you',
            needsYou: true,
          },
        ],
      },
      escalations: {
        count: 2,
        // 2026-08-31T19:12Z to 2026-09-04T12:00Z is 3.7 days, the oldest
        // wait the issue measured in production.
        oldestWaitedDays: 3.7,
        items: [
          {
            issue: 1244,
            state: 'escalate',
            since: '2026-08-31T19:12:00.000Z',
            waitedDays: 3.7,
            reason:
              'the task has no acceptance criteria, so there is nothing to ' +
              'judge it against - it can only be abandoned or accepted on faith',
          },
          {
            issue: 1175,
            state: 'escalate',
            since: '2026-09-02T21:36:00.000Z',
            waitedDays: 1.6,
            reason:
              'returned 2 time(s) already and 4 criterion(s) are still unmet; ' +
              'a third return would repeat a conversation that has not moved',
          },
        ],
      },
    })
  })

  /**
   * FR-001 as a test rather than a promise. The fixture rows carry report
   * bodies with file paths, branches, conversation ids and provider detail;
   * none of it may survive into the serialized answer. An issue number, a
   * state, an age and the recorded reason are the whole payload.
   */
  it('leaves paths, transcripts and identifiers behind', async () => {
    const { pool } = needsYouPool(reportsFixture, escalationsFixture)
    const response = await read(pool)
    const serialized = JSON.stringify(await response.json())

    expect(serialized).not.toContain('src/api/routes')
    expect(serialized).not.toContain('secret-conversation')
    expect(serialized).not.toContain('queen-1244')
    expect(serialized).not.toContain('provider and model detail')
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('db-queen.internal.example')
  })

  it('orders the reports newest first and states the limit it applied', async () => {
    const { pool, queries } = needsYouPool(reportsFixture, escalationsFixture)
    const response = await read(pool)
    const body = (await response.json()) as {
      reports: { limit: number; items: Array<{ at: string }> }
    }

    const reportsQuery = queries.find((q) =>
      q.sql.includes('FROM queen_report'),
    )
    expect(reportsQuery?.sql).toContain('ORDER BY at DESC')
    expect(reportsQuery?.params).toEqual([DEFAULT_REPORT_LIMIT])
    expect(body.reports.limit).toBe(DEFAULT_REPORT_LIMIT)
    expect(body.reports.items[0].at).toBe('2026-09-04T11:58:00.000Z')
    expect(body.reports.items[1].at).toBe('2026-09-03T09:00:00.000Z')
  })

  it('honours a stated limit and clamps the absurd ones', async () => {
    const limitParam = async (path: string) => {
      const { pool, queries } = needsYouPool(reportsFixture, escalationsFixture)
      const response = await read(pool, path)
      const stated = ((await response.json()) as { reports: { limit: number } })
        .reports.limit
      const passed = queries.find((q) => q.sql.includes('FROM queen_report'))
        ?.params[0]
      return { stated, passed }
    }

    expect(await limitParam('/?limit=5')).toEqual({ stated: 5, passed: 5 })
    expect(await limitParam('/?limit=9999')).toEqual({
      stated: MAX_REPORT_LIMIT,
      passed: MAX_REPORT_LIMIT,
    })
    expect(await limitParam('/?limit=0')).toEqual({ stated: 1, passed: 1 })
    expect(await limitParam('/?limit=not-a-number')).toEqual({
      stated: DEFAULT_REPORT_LIMIT,
      passed: DEFAULT_REPORT_LIMIT,
    })
  })

  /**
   * Scenario 3 of the first story: no escalations at all must answer with an
   * explicit empty state rather than an error or an omitted field - a consumer
   * cannot tell "none" from "not checked" from an absence, and the difference
   * is the whole point of the route.
   */
  it('answers an explicit empty state when nothing is outstanding', async () => {
    const { pool } = needsYouPool(empty, empty)
    const response = await read(pool)
    const body = (await response.json()) as {
      reports: { limit: number; returned: number; items: unknown[] }
      escalations: {
        count: number
        oldestWaitedDays: number | null
        items: unknown[]
      }
    }

    expect(response.status).toBe(200)
    expect('escalations' in body).toBe(true)
    expect('reports' in body).toBe(true)
    expect(body.reports).toEqual({
      limit: DEFAULT_REPORT_LIMIT,
      returned: 0,
      items: [],
    })
    expect(body.escalations).toEqual({
      count: 0,
      oldestWaitedDays: null,
      items: [],
    })
  })

  it('returns 503 with a fixed sentence when the database is unreachable', async () => {
    const pool = {
      query: async () => {
        throw new Error(
          'connect ECONNREFUSED db-queen.internal.example:5432 ' +
            '(postgres://secret-token@db-queen.internal.example:5432/queen)',
        )
      },
      end: async () => {},
    }
    const response = await read(pool)
    const body = (await response.json()) as { error: string }

    expect(response.status).toBe(503)
    expect(body.error).toBe('Queen needs-you is unavailable')
    // The real error names the host and the token; the log may have it, the
    // answer may not.
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('db-queen.internal.example')
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('ECONNREFUSED')
  })

  it('returns 503 when no Queen database is configured', async () => {
    let created = false
    const response = await createQueenNeedsYouRoute({
      databaseUrl: () => undefined,
      createPool: () => {
        created = true
        throw new Error('must not be reached')
      },
      now: () => NOW,
    }).request('/')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'Queen database is not configured',
    })
    expect(created).toBe(false)
  })
})

/**
 * THE SECOND DEFECT, in the same insert.
 *
 * `needs_you` was set from `escalated.length > 0`, where `escalated` is the
 * escalations raised in THAT round - not the ones still unresolved. Of the 40
 * most recent reports zero had the flag while six dispatches waited, because
 * the one boolean whose whole job is to say "a person is needed" was false
 * whenever the need was not brand new.
 *
 * These drive the real insert through the exported `report`, with a recording
 * pool, because the flag is the contract and a transcription of it in a test
 * would only ever agree with itself. The round-level suite skips on a machine
 * without the queend binary; these do not, so the contract is checked here
 * too.
 */
function reportPool(outstanding: number | 'fail') {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: String(sql), params })
      const text = String(sql)
      if (text.includes("WHERE review_state = 'escalate'")) {
        if (outstanding === 'fail') throw new Error('the count query failed')
        return { rowCount: 1, rows: [{ outstanding: String(outstanding) }] }
      }
      return { rowCount: 1, rows: [] }
    },
    end: async () => {},
  }
  return { pool: pool as unknown as Pool, queries }
}

const reportInsert = (queries: Array<{ sql: string; params: unknown[] }>) =>
  queries.find((q) => q.sql.includes('INSERT INTO queen_report'))

const insertHeadline = (queries: Array<{ sql: string; params: unknown[] }>) =>
  String(reportInsert(queries)?.params[0])

const quietChoice = { allowed: false, refusal: 'nothing to choose' }

describe('the needs_you flag, computed from what is owed', () => {
  it('is true for a round that raises no new escalation while one is outstanding', async () => {
    const { pool, queries } = reportPool(1)
    await report(pool, { acted: [], strays: [] }, [], quietChoice, 3)

    const insert = reportInsert(queries)
    // THE assertion the issue asks for: reverting the condition to
    // `escalated.length > 0` - the escalations raised in this round, which is
    // none - turns this red while six-worth of dispatches wait.
    expect(insert?.params[2]).toBe(true)
    // The headline is deliberately untouched by this change: a round that
    // raised nothing still says the refusal, not "1 waiting on you".
    expect(insert?.params[0]).toBe('nothing to choose')
  })

  it('is false when nothing is outstanding and nothing is new', async () => {
    const { pool, queries } = reportPool(0)
    await report(pool, { acted: [], strays: [] }, [], quietChoice, 3)

    expect(reportInsert(queries)?.params[2]).toBe(false)
  })

  /**
   * The floor under the count. The count query is best-effort - a report must
   * not take the round down with it - and on its failure the raised-this-round
   * half is the only live fact left, so a brand-new escalation still flags.
   */
  it('still flags a need raised this round when the count cannot be read', async () => {
    const { pool, queries } = reportPool('fail')
    await report(
      pool,
      { acted: ['#1175:escalate'], strays: [] },
      [],
      quietChoice,
      3,
    )

    expect(reportInsert(queries)?.params[2]).toBe(true)
  })

  it('counts an escalation raised this round as outstanding too', async () => {
    const { pool, queries } = reportPool(1)
    await report(
      pool,
      { acted: ['#1244:escalate'], strays: [] },
      [],
      quietChoice,
      3,
    )

    // The review sweep writes review_state before the report runs, so the
    // count the insert reads already includes this round's escalation; the
    // headline names it.
    expect(reportInsert(queries)?.params[2]).toBe(true)
    expect(insertHeadline(queries)).toBe('1 waiting on you')
  })
})
