import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import type { DispatchOutcome } from '../../src/api/services/queen-dispatch'
import { laneOf } from '../../src/api/services/queen-runners'
import { runRound } from '../../src/api/services/queen-tick'
import { queendPathEnvVar } from '../__helpers__/queend-path'

/**
 * A runner's task in the round: a live claim that takes no worker slot of this
 * container, and the pass that hands a full container's next tasks to runners.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. queen-round.test.ts drives the real
 * `queend` and skips where it is not built - which is every machine without
 * Swift, CI included. What these cases pin is the ROUND's half of the contract:
 * which state it puts a runner's row in, and what it asks when the policy says
 * the container is full. So the policy is a stand-in that applies the one rule
 * that matters to both questions, exactly as QueenDelegationPolicy states it:
 * only `running` counts against capacity (`canStartAnother`), and queued,
 * running, awaitingReview and rejected are live claims (`claimOnIssue`).
 */

const LIMIT = 1
const STAND_IN = `#!/usr/bin/env bun
const q = JSON.parse(await Bun.stdin.text())
const out = (a) => { process.stdout.write(JSON.stringify(a)); process.exit(0) }
if (q.kind !== 'choose') out({ kind: q.kind, allowed: false, refusal: 'not asked here' })
const running = q.tasks.filter((t) => t.state === 'running').length
if (running >= ${LIMIT})
  out({ kind: 'choose', allowed: false,
        refusal: running + ' workers already running (limit ${LIMIT})' })
const live = ['queued', 'running', 'awaitingReview', 'rejected']
const free = q.candidates.find((n) =>
  !q.tasks.some((t) => t.issue.number === n && live.includes(t.state)))
if (free === undefined) out({ kind: 'choose', allowed: false, refusal: 'nothing left' })
out({ kind: 'choose', allowed: true, chosen: free, chosenPaths: ['docs/' + free + '.md'] })
`

const QUEEND_ENV = queendPathEnvVar()
let dir: string
const saved: Record<string, string | undefined> = {}
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'queen-round-runners-'))
  const bin = join(dir, 'queend')
  writeFileSync(bin, STAND_IN)
  chmodSync(bin, 0o755)
  for (const key of [QUEEND_ENV, 'WORKSPACE_DIR', 'TRIOS_GITHUB_REPO']) {
    saved[key] = process.env[key]
  }
  process.env[QUEEND_ENV] = bin
  process.env.TRIOS_GITHUB_REPO = 'gHashTag/trios'
  process.env.WORKSPACE_DIR = join(dir, 'no-such-workspace')
  globalThis.fetch = (async () =>
    new Response('[]', { status: 200 })) as unknown as typeof fetch
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
})

/** One round's database: the in-flight rows given, everything else empty. */
function roundPool(inFlight: Record<string, unknown>[]) {
  return {
    query: async (sql: string) => {
      if (String(sql).includes('FROM queen_registry'))
        return { rowCount: 1, rows: [{ tasks: [] }] }
      if (/key_index, finished_at, review_state, reviewed_at/.test(sql))
        return { rowCount: inFlight.length, rows: inFlight }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
}

const inFlight = (issue: number, keyIndex: number) => ({
  issue,
  branch: `queen-${issue}`,
  owned_paths: [`docs/${issue}.md`],
  conversation_id: `00000000-0000-4000-8000-${String(issue).padStart(12, '0')}`,
  dispatched_at: new Date().toISOString(),
  key_index: keyIndex,
  finished_at: null,
  review_state: null,
  reviewed_at: null,
  send_backs: 0,
})

type Call = { issue: number; runnerOnly: boolean; taken: number[] }

function recordingDispatch(lane: (call: number) => number) {
  const calls: Call[] = []
  const dispatch = async (...args: unknown[]): Promise<DispatchOutcome> => {
    const issue = args[1] as number
    const deps = (args[8] ?? {}) as { runnerOnly?: boolean }
    calls.push({
      issue,
      runnerOnly: deps.runnerOnly === true,
      taken: args[4] as number[],
    })
    return {
      started: true,
      issue,
      branch: `queen-${issue}`,
      detail: 'started',
      conversationId: `00000000-0000-4000-8000-00000000000${calls.length}`,
      keyIndex: lane(calls.length),
    }
  }
  return { calls, dispatch: dispatch as never }
}

describe('a runner’s task in the round', () => {
  it('holds its issue but takes no worker slot of this container', async () => {
    // One slot, and a runner is working on #900: the container is still empty.
    const { calls, dispatch } = recordingDispatch(() => 0)
    await runRound(
      roundPool([inFlight(900, laneOf(3))]),
      'me',
      7,
      { held: true },
      [900, 101],
      { dispatch, idleRunner: async () => null },
    )
    // #900 is claimed (not chosen again); #101 starts in the free slot.
    expect(calls.map((c) => c.issue)).toEqual([101])
    expect(calls[0].runnerOnly).toBe(false)
    // And the runner's lane is not one of this deployment's keys.
    expect(calls[0].taken).toEqual([])
  })

  it('a task the loop offered to a runner leaves the slot free for the next', async () => {
    // First dispatch went to a runner, the second to the container.
    const { calls, dispatch } = recordingDispatch((n) =>
      n === 1 ? laneOf(3) : 0,
    )
    await runRound(roundPool([]), 'me', 7, { held: true }, [101, 102, 103], {
      dispatch,
      idleRunner: async () => null,
    })
    // 101 to the runner, 102 to the one container slot, then the policy says full.
    expect(calls.map((c) => c.issue)).toEqual([101, 102])
    expect(calls[1].taken).toEqual([])
  })
})

describe('the runner-only pass', () => {
  it('hands a full container’s next tasks to idle runners, and only to runners', async () => {
    let idle = 2
    const { calls, dispatch } = recordingDispatch((n) => laneOf(n))
    const result = await runRound(
      roundPool([inFlight(999, 0)]),
      'me',
      7,
      { held: true },
      [101, 102, 103],
      {
        dispatch,
        idleRunner: async () =>
          idle-- > 0
            ? { id: 1, lane: laneOf(1), label: 'laptop', ownerName: 'Alice' }
            : null,
      },
    )
    expect(calls.map((c) => [c.issue, c.runnerOnly])).toEqual([
      [101, true],
      [102, true],
    ])
    expect((result.dispatch as unknown[]).length).toBe(2)
  })

  it('does not run when no runner is idle', async () => {
    const { calls, dispatch } = recordingDispatch(() => 0)
    await runRound(
      roundPool([inFlight(999, 0)]),
      'me',
      7,
      { held: true },
      [101],
      {
        dispatch,
        idleRunner: async () => null,
      },
    )
    expect(calls).toEqual([])
  })

  it('stops at the first task no runner will take', async () => {
    const calls: number[] = []
    await runRound(
      roundPool([inFlight(999, 0)]),
      'me',
      7,
      { held: true },
      [101, 102],
      {
        dispatch: (async (_pool: unknown, issue: number) => {
          calls.push(issue)
          return {
            started: false,
            issue,
            branch: `queen-${issue}`,
            detail: 'no runner is free to take it',
          }
        }) as never,
        idleRunner: async () => ({
          id: 1,
          lane: laneOf(1),
          label: 'laptop',
          ownerName: 'Alice',
        }),
      },
    )
    expect(calls).toEqual([101])
  })

  it('never runs once the lease is gone', async () => {
    const { calls, dispatch } = recordingDispatch(() => laneOf(1))
    await runRound(
      roundPool([inFlight(999, 0)]),
      'me',
      7,
      { held: false },
      [101],
      {
        dispatch,
        idleRunner: async () => ({
          id: 1,
          lane: laneOf(1),
          label: 'laptop',
          ownerName: 'Alice',
        }),
      },
    )
    expect(calls).toEqual([])
  })
})
