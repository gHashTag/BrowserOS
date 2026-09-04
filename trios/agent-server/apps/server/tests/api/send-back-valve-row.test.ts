import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  boardTask,
  SEND_BACK_IDLE_FLOOR_MS,
  stateOfDispatch,
} from '../../src/api/services/queen-tick'

/**
 * The send-back valve, proved on the rows that were actually stored.
 *
 * WHAT HAPPENED, 2026-09-04. Issues #1316 and #1318 each had one dispatch row
 * on `queen_dispatch`: `started`, `review_state = 'sendBack'`,
 * `send_backs = 1`, `finished_at` on 2026-09-02 - fifty-two hours idle, one
 * attempt burned of a ceiling of two. Run the shipped function on those values
 * and it agrees the attempt is over:
 *
 *   stateOfDispatch(true, 'sendBack', { idleMs: 52h, sendBacks: 1 }) -> failed
 *
 * `failed` is free in `QueenDelegationPolicy.claimOnIssue` - a failure is the
 * state that most obviously means "do this again" - so neither issue should
 * have been claimable against its own row. Yet round after round both were
 * counted in the tick's `claimed` bucket (the skip sentence "a worker has it
 * or is expected back (rejected)" is what that bucket is made of), and both
 * issues stayed unchoosable until a hand-written UPDATE released them. The
 * board query selects `finished_at`, `review_state` and `send_backs`, so the
 * inputs were present. Something between the row and the skip decision
 * disagreed with the function, and this file is the reproduction, not a guess.
 *
 * THE STEPS THIS WALKS, each named in its own assertion message so a failure
 * says which step disagreed rather than leaving that to be inferred:
 *
 *   step 1  the row is the stored shape - sendBack, one send-back, finished
 *   step 2  the shipped function on the row's own measured values
 *   step 3  the board task `containerTasks` builds from that row
 *   step 4  the claim rule, asked as the tick asks it, finds no claim
 *
 * WHAT IS REAL HERE. `stateOfDispatch` and `boardTask` are the shipped
 * functions the tick calls (queen-tick.ts:432 and :475); step 3 applies the
 * tick's own inline mapping, quoted below rather than re-derived. Step 4 is
 * `queend` itself - `kind: "choose"`, the same question the round asks - so
 * the claim goes through `QueenDelegationPolicy.claimOnIssue` rather than
 * through a restatement of it.
 *
 * THE CONTROL. A row of the same shape thirty minutes after its verdict maps
 * to `rejected`, which IS a live claim, and queend skips it as claimed. One
 * fixture answering both ways is what makes the `failed` half evidence rather
 * than a test passing for the wrong reason.
 *
 * HONEST LIMIT, stated because a quiet skip is how a gate reports success it
 * never earned: on a machine with no `queend` anywhere the tick could reach,
 * step 4 is skipped (`it.skipIf`), exactly as queend-choose.test.ts and
 * queen-board.test.ts skip theirs. Steps 1-3 always run. The binary is looked
 * for where the tick itself looks (`queendPath()`: `TRIOS_QUEEND_PATH`, then
 * `/usr/local/bin/queend`) and then where the repository builds it
 * (`queen-core/.build/release/queend`), so the claim rule is exercised by the
 * same artifact production runs.
 */

const HOUR = 60 * 60 * 1000

/**
 * A `queen_dispatch` row as the board query hands it back from Postgres, with
 * exactly the column list that query selects (queen-tick.ts:890-892): issue,
 * branch, owned_paths, conversation_id, dispatched_at, key_index, finished_at,
 * review_state, reviewed_at, send_backs, provider, model, input_tokens,
 * output_tokens.
 *
 * The TypeScript shapes are the ones node-postgres produces, because the
 * mapping consumes those and not the SQL ones: timestamptz arrives as a Date,
 * jsonb as a parsed array, integer as a number, and BIGINT AS A STRING - the
 * tokens are written '18432', not 18432, because a fixture that quietly
 * widened them would not be the row that was stored.
 *
 * Defaults are the two rows of 2026-09-04: `sendBack`, `send_backs = 1`,
 * finished 52 hours before `now`, reviewed at the same instant (the review
 * sweep re-reads `wait` rows, not send-backs, so `reviewed_at` stands where
 * the verdict put it), dispatched 60 hours before `now` - inside the 7-day
 * window the board query bounds - and `outcome` null, so the row is not
 * reaped and stays on the board.
 */
interface DispatchRow {
  issue: number
  branch: string
  started: boolean
  conversation_id: string
  owned_paths: string[]
  dispatched_at: Date
  key_index: number
  finished_at: Date
  review_state: string
  reviewed_at: Date
  send_backs: number
  provider: string
  model: string
  input_tokens: string
  output_tokens: string
  outcome: null
}

function rowLikeStored(
  issue: number,
  opts: { idleHours?: number; now?: number } = {},
): DispatchRow {
  const now = opts.now ?? Date.now()
  const finishedAt = new Date(now - (opts.idleHours ?? 52) * HOUR)
  return {
    issue,
    branch: `queen-${issue}`,
    started: true,
    conversation_id: `3f2b6c1e-0a1d-4c1e-9d2b-${String(issue).padStart(12, '0')}`,
    owned_paths: ['agent-server/apps/server/src/api/services/queen-tick.ts'],
    dispatched_at: new Date(now - 60 * HOUR),
    key_index: 0,
    finished_at: finishedAt,
    review_state: 'sendBack',
    reviewed_at: finishedAt,
    send_backs: 1,
    provider: 'zai',
    model: 'glm-5.3',
    input_tokens: '18432',
    output_tokens: '2011',
    outcome: null,
  }
}

/**
 * The tick's own mapper, quoted from `containerTasks` (queen-tick.ts:916-959)
 * rather than re-derived: `finished_at != null` decides finished, the lease's
 * idle is measured from `finished_at` - the clock nothing touches - and
 * `send_backs` is read off the row. `now` is a parameter only so the test can
 * hold it still; the tick passes `Date.now()`.
 */
function containerTaskOf(
  row: DispatchRow,
  now: number,
  owner = 'gHashTag',
  repoName = 'trios',
) {
  const finished = row.finished_at != null
  return boardTask(owner, repoName, {
    conversationId: row.conversation_id,
    issue: row.issue,
    ownedPaths: row.owned_paths ?? [],
    branch: row.branch,
    at: finished ? row.finished_at : row.dispatched_at,
    title: finished
      ? 'finished by the cloud tick, waiting for a verdict'
      : 'dispatched by the cloud tick',
    state: stateOfDispatch(finished, row.review_state, {
      idleMs: finished ? now - Date.parse(String(row.finished_at)) : 0,
      sendBacks: Number(row.send_backs ?? 0),
    }),
    provider: (row.provider as string) ?? undefined,
    model: (row.model as string) ?? undefined,
    inputTokens:
      row.input_tokens == null ? undefined : Number(row.input_tokens),
    outputTokens:
      row.output_tokens == null ? undefined : Number(row.output_tokens),
  })
}

/** Where the tick itself resolves `queend`, then where the repository builds it. */
function queendBinary(): string | null {
  const candidates = [
    process.env.TRIOS_QUEEND_PATH,
    '/usr/local/bin/queend',
    join(import.meta.dir, '../../../../queen-core/.build/release/queend'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

const BIN = queendBinary()
const present = BIN != null

function askQueend(question: unknown): Record<string, unknown> {
  const run = spawnSync(BIN as string, {
    input: JSON.stringify(question),
    encoding: 'utf8',
    env: {
      ...process.env,
      // The money gate is not on trial here. Raised so the only gates that can
      // refuse are the ones this file reproduces: the claim, the spec, the
      // boundary.
      TRIOS_SWARM_DAILY_CAP_USD: '1000000',
    },
  })
  expect(run.status, 'queend exited 0 on a decodable question').toBe(0)
  return JSON.parse(run.stdout)
}

/** A spec-shaped body, so the only thing queend can object to is the claim. */
function specBody(issue: number): string {
  return [
    '## User Scenarios & Testing',
    '',
    '### The valve is proved on a real row',
    '',
    '**Given** a dispatch row exactly as it was stored, **When** the board is',
    'built from it, **Then** the resulting task state is what the valve says.',
    '',
    '## Requirements',
    '',
    '- **FR-001**: a test MUST build a board task from the stored row shape.',
    '',
    '## Success Criteria',
    '',
    '- the mapped state is exact.',
    '',
    '## Boundary',
    '',
    `\`docs/valve-${issue}.md\``,
  ].join('\n')
}

function board(
  rows: DispatchRow[],
  now: number,
): {
  kind: string
  candidates: number[]
  candidateBodies: Record<string, string>
  tasks: unknown[]
} {
  const tasks = rows.map((row) => containerTaskOf(row, now))
  return {
    kind: 'choose',
    candidates: rows.map((row) => row.issue),
    candidateBodies: Object.fromEntries(
      rows.map((row) => [String(row.issue), specBody(row.issue)]),
    ),
    tasks,
  }
}

// The two rows as they stood together on the 2026-09-04 board.
const NOW = Date.now()
const STALE_1316 = rowLikeStored(1316, { now: NOW })
const STALE_1318 = rowLikeStored(1318, { now: NOW })

describe('the send-back valve on the stored rows for #1316 and #1318', () => {
  it('step 1 - the rows are the stored shape: sendBack, one send-back, finished', () => {
    for (const row of [STALE_1316, STALE_1318]) {
      expect(
        row.review_state,
        `#${row.issue} step 1 - the stored review_state is sendBack`,
      ).toBe('sendBack')
      expect(
        row.send_backs,
        `#${row.issue} step 1 - one send-back burned of the ceiling of two`,
      ).toBe(1)
      expect(
        row.finished_at != null,
        `#${row.issue} step 1 - the row is finished, so the lease applies`,
      ).toBe(true)
      const idle = NOW - Date.parse(String(row.finished_at))
      expect(
        idle >= SEND_BACK_IDLE_FLOOR_MS,
        `#${row.issue} step 1 - 52 hours idle, past the ${SEND_BACK_IDLE_FLOOR_MS}ms floor`,
      ).toBe(true)
    }
  })

  it('step 2 - the shipped function on the values measured off the row says failed', () => {
    for (const row of [STALE_1316, STALE_1318]) {
      const state = stateOfDispatch(true, row.review_state, {
        idleMs: NOW - Date.parse(String(row.finished_at)),
        sendBacks: Number(row.send_backs ?? 0),
      })
      expect(
        state,
        `#${row.issue} step 2 - stateOfDispatch(sendBack, 52h idle, 1 send-back) is failed, exactly as the issue's own probe says`,
      ).toBe('failed')
    }
  })

  it('step 3 - the board task containerTasks builds from each row is failed', () => {
    for (const row of [STALE_1316, STALE_1318]) {
      const task = containerTaskOf(row, NOW)
      expect(
        task.state,
        `#${row.issue} step 3 - the board task carries state failed, not rejected or awaitingReview`,
      ).toBe('failed')
    }
  })

  it.skipIf(!present)(
    'step 4 - the claim rule finds no claim, so neither issue holds itself',
    () => {
      const answer = askQueend(board([STALE_1316, STALE_1318], NOW))
      // Swift omits a nil rather than encoding null, so the key is absent.
      expect(
        answer.chosen,
        'step 4 - queend chose #1316, the first candidate with no claim against it',
      ).toBe(1316)
      const skipped = String(answer.skipped)
      expect(
        skipped,
        'step 4 - no row was skipped as claimed, landed or held: neither 52-hour send-back claims its issue',
      ).not.toContain('a worker has it or is expected back')
      expect(
        skipped,
        'step 4 - #1318 was passed over only for order',
      ).toContain('#1318: not first')
    },
  )

  // THE CONTROL. The same shape thirty minutes after its verdict is still a
  // live claim - `rejected`, the state `claimOnIssue` counts - so the `failed`
  // assertions above are not passing for a wrong reason (an always-failed
  // mapping, a state nobody reads, a floor of zero).
  it('the same row thirty minutes after its verdict maps to rejected', () => {
    const fresh = rowLikeStored(1316, { idleHours: 0.5, now: NOW })
    const task = containerTaskOf(fresh, NOW)
    expect(
      task.state,
      'control - a 30-minute-old sendBack is rejected, so the valve opens on idle and not on nothing',
    ).toBe('rejected')
  })

  it.skipIf(!present)(
    'the control through the claim rule: a 30-minute send-back is still claimed',
    () => {
      const fresh1316 = rowLikeStored(1316, { idleHours: 0.5, now: NOW })
      const fresh1318 = rowLikeStored(1318, { idleHours: 0.5, now: NOW })
      const answer = askQueend(board([fresh1316, fresh1318], NOW))
      expect(
        answer.chosen ?? null,
        'control - queend chose nothing: a fresh send-back claims its issue',
      ).toBeNull()
      expect(
        String(answer.skipped),
        'control - both issues skipped as claimed, the sentence the claimed bucket is made of',
      ).toContain('#1316: a worker has it or is expected back (rejected)')
      expect(String(answer.skipped)).toContain(
        '#1318: a worker has it or is expected back (rejected)',
      )
    },
  )
})
