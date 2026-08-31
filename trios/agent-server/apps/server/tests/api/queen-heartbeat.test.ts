import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import { startLeaseHeartbeat } from '../../src/api/services/queen-tick'

/**
 * Postgres, answering the way `acquireQueenLease` reads it.
 *
 * A renewal is the same INSERT ... ON CONFLICT as an acquisition, so `granted`
 * decides whether it comes back with a row (renewed) or with none (somebody
 * else holds an unexpired lease, and the follow-up SELECT names them). The
 * count is what proves an interval stopped: a beat that was cleared makes no
 * further query, and a leaked one goes on asking forever.
 */
function leasePool(granted: () => boolean | 'reject') {
  let renewals = 0
  const pool = {
    query: async (text: string) => {
      if (!String(text).includes('INSERT INTO queen_lease')) {
        return {
          rowCount: 1,
          rows: [
            {
              holder: 'the-other-supervisor',
              fence: '9',
              expires_at: new Date(),
            },
          ],
        }
      }
      renewals += 1
      const verdict = granted()
      if (verdict === 'reject') throw new Error('connection terminated')
      return verdict
        ? {
            rowCount: 1,
            rows: [{ holder: 'me', fence: '8', expires_at: new Date() }],
          }
        : { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, renewals: () => renewals }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

describe('queen lease heartbeat', () => {
  /**
   * The handle used to be one module-scoped variable, and two rounds can
   * overlap in one process: `POST /queen/lease/tick` calls the same round
   * function as the timer, and both get `acquired: true` because the holder
   * name is stable within a process. The second assignment orphaned the first
   * interval, which then renewed the lease every 60 seconds for the life of the
   * process - so the Mac could never take the hive back from a container that
   * had stopped working.
   */
  it('two overlapping rounds each stop their own heartbeat', async () => {
    const { pool, renewals } = leasePool(() => true)
    const first = startLeaseHeartbeat(pool, 'me', 5)
    await sleep(15)
    const second = startLeaseHeartbeat(pool, 'me', 5)
    await sleep(15)
    expect(renewals()).toBeGreaterThan(0)

    // Whichever order they finish in, neither may leave a beat behind.
    first.stop()
    second.stop()
    const settled = renewals()
    await sleep(40)
    expect(renewals()).toBe(settled)
  })

  /**
   * `acquireQueenLease` RETURNS `{ acquired: false }` when the lease has moved;
   * it does not throw. The heartbeat used to drop that verdict on the floor, so
   * the round carried on dispatching as a private citizen while a second
   * supervisor legitimately held the lease - and `recordDispatch` carries no
   * fence, so its upsert would overwrite the real Queen's row for that issue.
   */
  it('stands the round down when a renewal is refused', async () => {
    const { pool, renewals } = leasePool(() => false)
    const { watch, stop } = startLeaseHeartbeat(pool, 'me', 5)
    expect(watch.held).toBe(true)

    await sleep(30)
    expect(watch.held).toBe(false)

    // And it stops asking. The answer will not improve, and a beat that keeps
    // renewing after the lease moved is the leak this file's other test covers.
    const settled = renewals()
    await sleep(30)
    expect(renewals()).toBe(settled)
    stop()
  })

  /**
   * A rejected query is not a lost lease. HEARTBEAT_SECONDS is 60 against a
   * LEASE_TTL_SECONDS of 180, so it takes three consecutive misses or a stall
   * past the TTL before anyone else can take over - standing down on the first
   * database blip would hand the hive away for nothing.
   */
  it('keeps the round alive when a renewal rejects', async () => {
    const { pool, renewals } = leasePool(() => 'reject')
    const { watch, stop } = startLeaseHeartbeat(pool, 'me', 5)
    await sleep(30)
    expect(watch.held).toBe(true)
    expect(renewals()).toBeGreaterThan(1)
    stop()
  })
})
