/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The task leases and the event log, held against their contract
 * (specs/queen/control.t27, vendored from gHashTag/t27 - gHashTag/t27#6657):
 *
 * - the card is read by the real compiler wasm and the numbers this module
 *   enforces are pinned to what the card says - TTL 180, heartbeat 60,
 *   reconcile 300, ten event names - so amending the card without amending
 *   the wiring shows up here, not in production;
 * - the lease behaves on both sides of its one statement: a returned row is
 *   a landed claim, zero rows is an incumbent to report, never a lease;
 * - an event the card does not name is refused BEFORE any SQL runs, because
 *   the kind column is an index into the card's EVENT_NAMES and a number the
 *   card never agreed to is a lie the log would keep for ever.
 */

import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import {
  claimTaskLease,
  loadControlSpec,
  publishEvent,
  releaseTaskLease,
} from '../../src/api/services/queen-control'
import { MIGRATION_SQL, QUEEN_CONTROL_SQL } from '../../src/lib/db/pg-migrate'

/**
 * A stand-in for Postgres that answers what Postgres would, and remembers
 * what it was asked. The SQL-text rule of queen-lease.test.ts applies here
 * too: these tests pin the behaviour on either side of each statement, not
 * the statement's spelling - exclusion is a property of how Postgres executes
 * it, proven on the deployment by two concurrent contenders.
 */
function fakePool(
  responses: Array<{ rowCount: number; rows: unknown[] }>,
): Pool & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = []
  let call = 0
  const pool = {
    query: async (sql: string, args: unknown[]) => {
      calls.push([sql, args])
      return responses[call++] ?? { rowCount: 0, rows: [] }
    },
  }
  return Object.assign(pool as unknown as Pool, { calls })
}

describe('the control card, read by the compiler', () => {
  it('pins the numbers the wiring enforces', async () => {
    const spec = await loadControlSpec()
    expect(spec.taskLeaseTtlSeconds).toBe(180)
    expect(spec.taskHeartbeatSeconds).toBe(60)
    expect(spec.taskLeaseTtlSeconds).toBeGreaterThan(spec.taskHeartbeatSeconds)
    expect(spec.reconcileSeconds).toBe(300)
    expect(spec.noHolder).toBe(0)
    expect(spec.eventKinds).toBe(10)
    expect(spec.eventNames.length).toBe(spec.eventKinds)
  })

  it('names the ten events, created first and tick last', async () => {
    const spec = await loadControlSpec()
    expect(spec.eventNames[0]).toBe('queen/task.created')
    expect(spec.eventNames[spec.eventNames.length - 1]).toBe('queen/tick')
    // The names this module publishes by, in full, so renaming one in the
    // card fails HERE rather than as a refused event in production.
    expect(spec.eventNames).toEqual([
      'queen/task.created',
      'queen/task.ended',
      'queen/worker.idle',
      'queen/lease.expired',
      'queen/task.evidence',
      'queen/task.reviewed',
      'queen/task.assign',
      'queen/task.cancel',
      'queen/lease.heartbeat',
      'queen/tick',
    ])
  })

  it('refuses a card that stops typechecking, with no fallback', async () => {
    // A root without queen/control.t27: the reader must throw rather than
    // serve remembered numbers - the fallback is where the copy of the rule
    // stops matching the rule.
    const root = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp('queen-control-refusal-'),
    )
    await expect(loadControlSpec(root)).rejects.toThrow(/control\.t27/)
  })
})

describe('the DDL has one home', () => {
  it('boot and round run the same QUEEN_CONTROL_SQL, embedded in MIGRATION_SQL', () => {
    expect(QUEEN_CONTROL_SQL).toContain(
      'CREATE TABLE IF NOT EXISTS queen_task_lease',
    )
    expect(QUEEN_CONTROL_SQL).toContain(
      'CREATE TABLE IF NOT EXISTS queen_event_log',
    )
    // Interpolated, not transcribed: the boot string contains the round
    // string verbatim, so the two paths cannot drift apart.
    expect(MIGRATION_SQL).toContain(QUEEN_CONTROL_SQL.trim())
  })
})

describe('task lease', () => {
  it('reports a landed claim when the statement returned a row', async () => {
    const pool = fakePool([
      {
        rowCount: 1,
        rows: [
          {
            holder: 'me',
            fence: '3',
            expires_at: new Date('2026-10-06T12:03:00Z'),
          },
        ],
      },
    ])
    const grant = await claimTaskLease(pool, 1301, 'me', 180)
    expect(grant.landed).toBe(true)
    expect(grant.holder).toBe('me')
    expect(grant.fence).toBe(3)
  })

  it('reports the incumbent, never a lease, when the statement was refused', async () => {
    const pool = fakePool([
      { rowCount: 0, rows: [] },
      {
        rowCount: 1,
        rows: [
          {
            holder: 'the-other-container',
            fence: '5',
            expires_at: new Date('2026-10-06T12:02:30Z'),
          },
        ],
      },
    ])
    const grant = await claimTaskLease(pool, 1301, 'me', 180)
    expect(grant.landed).toBe(false)
    expect(grant.holder).toBe('the-other-container')
    expect(grant.fence).toBe(5)
  })

  it('takes the TTL it was given, not a remembered one', async () => {
    const pool = fakePool([
      {
        rowCount: 1,
        rows: [{ holder: 'me', fence: '1', expires_at: new Date() }],
      },
    ])
    await claimTaskLease(pool, 1301, 'me', 180)
    // The only arg: issue, holder, ttl. A hardcoded TTL here would survive
    // every card amendment.
    expect(pool.calls[0]?.[1]).toEqual([1301, 'me', 180])
  })

  it('releases guarded on the holder, expiring rather than deleting', async () => {
    const pool = fakePool([{ rowCount: 1, rows: [] }])
    const released = await releaseTaskLease(pool, 1301, 'me')
    expect(released).toBe(true)
    expect(pool.calls[0]?.[0]).toMatch(/expires_at = now\(\) - /)
    expect(pool.calls[0]?.[0]).not.toMatch(/DELETE/)
    expect(pool.calls[0]?.[1]).toEqual([1301, 'me'])
  })
})

describe('event log', () => {
  it('writes the kind as the index into the card EVENT_NAMES', async () => {
    const pool = fakePool([{ rowCount: 1, rows: [{ seq: '41' }] }])
    const seq = await publishEvent(pool, 'queen/task.created', {
      issue: 1301,
    })
    expect(seq).toBe(41)
    const [, args] = pool.calls[0]
    expect(args[0]).toBe('queen')
    expect(args[1]).toBe(0) // queen/task.created is EVENT_NAMES[0]
    expect(JSON.parse(String(args[2]))).toEqual({ issue: 1301 })
  })

  it('refuses an event the card does not name, before any SQL runs', async () => {
    const pool = fakePool([])
    await expect(
      publishEvent(pool, 'queen/task.exploded', { issue: 1301 }),
    ).rejects.toThrow(/not in EVENT_NAMES/)
    expect(pool.calls).toHaveLength(0)
  })
})
