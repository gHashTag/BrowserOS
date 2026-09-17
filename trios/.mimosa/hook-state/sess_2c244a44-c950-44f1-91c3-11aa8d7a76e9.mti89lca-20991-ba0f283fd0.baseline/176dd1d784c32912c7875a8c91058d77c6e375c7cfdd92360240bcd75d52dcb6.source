/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * One Queen at a time.
 *
 * The supervision loop is not idempotent: a round reads the registry, picks an
 * issue nobody is working on, and starts a bee. Two rounds running concurrently
 * both see the same issue unclaimed, and both start a bee on it - two worktrees,
 * two branches, two sets of edits to the same files, and a boundary system that
 * was designed on the assumption that it decides who touches what. That is the
 * whole reason a cloud-resident tick could not simply be switched on: the Mac's
 * loop has been running all along, so adding a second one without exclusion
 * creates the exact race the boundaries exist to prevent.
 *
 * So exclusion comes first, and it lives in Postgres because Postgres is the one
 * thing both the Mac and the container can see. A file lock cannot cross a
 * network; an in-process mutex cannot cross a process.
 *
 * TWO PROPERTIES THIS MUST HAVE, and both are easy to get wrong:
 *
 *   1. Acquisition is ONE statement. `SELECT ... then UPDATE if free` has a
 *      window between the two where both contenders read "free". The insert
 *      below does the read and the write under the same row lock, so the loser
 *      gets zero rows back rather than a second copy of the lease.
 *
 *   2. A lease EXPIRES, and the holder can be wrong about holding it. A process
 *      that stalls past its TTL - a long GC pause, a suspended laptop, a
 *      container the platform froze - wakes up believing it is still the Queen
 *      while somebody else has taken over. TTL alone cannot fix this; nothing
 *      the stalled process can check locally is true. What fixes it is the
 *      fence: every acquisition increments a counter, and a holder's writes
 *      carry the fence it was granted. A write from the old term arrives with a
 *      smaller number and is refused by the database, not by the caller's
 *      goodwill.
 */

import type { Pool } from 'pg'
import { logger } from '../../lib/logger'

export interface LeaseGrant {
  /** Who holds it now. Not necessarily the caller - read `acquired`. */
  holder: string
  /** Whether THIS call obtained or renewed the lease. */
  acquired: boolean
  /** Monotonic term counter. A write carrying a lower fence is stale. */
  fence: number
  expiresAt: string
}

export function queenLeaseDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.RAILWAY_SSOT_URL || undefined
}

/**
 * Take the lease, or report who has it.
 *
 * Renewal is the same statement as acquisition: a holder renewing its own lease
 * matches `holder = EXCLUDED.holder` and takes a new term. That means a renewal
 * also bumps the fence, which reads odd until you consider the case it covers -
 * a holder that stalled long enough to be replaced and then reacquired. Its
 * in-flight writes from the previous term must not count, and they carry the
 * older fence, so they do not.
 */
export async function acquireQueenLease(
  pool: Pool,
  name: string,
  holder: string,
  ttlSeconds: number,
): Promise<LeaseGrant> {
  const taken = await pool.query(
    `INSERT INTO queen_lease (name, holder, acquired_at, expires_at, fence)
     VALUES ($1, $2, now(), now() + make_interval(secs => $3), 1)
     ON CONFLICT (name) DO UPDATE
       SET holder = EXCLUDED.holder,
           acquired_at = now(),
           expires_at = now() + make_interval(secs => $3),
           fence = queen_lease.fence + 1
       WHERE queen_lease.expires_at < now()
          OR queen_lease.holder = EXCLUDED.holder
     RETURNING holder, fence, expires_at`,
    [name, holder, ttlSeconds],
  )

  if (taken.rowCount && taken.rowCount > 0) {
    const row = taken.rows[0]
    return {
      holder: row.holder,
      acquired: true,
      fence: Number(row.fence),
      expiresAt: new Date(row.expires_at).toISOString(),
    }
  }

  // Zero rows means the WHERE refused: somebody else holds an unexpired lease.
  // Report WHO, because "you did not get it" is not actionable and "another
  // Queen has been holding this for six hours" is.
  const held = await pool.query(
    'SELECT holder, fence, expires_at FROM queen_lease WHERE name = $1',
    [name],
  )
  const row = held.rows[0]
  return {
    holder: row?.holder ?? 'unknown',
    acquired: false,
    fence: Number(row?.fence ?? 0),
    expiresAt: row ? new Date(row.expires_at).toISOString() : '',
  }
}

/**
 * Give it up early.
 *
 * Optional - the TTL covers a holder that dies without releasing. But a clean
 * shutdown that releases hands over in seconds instead of making the next
 * contender wait out the full term, and a supervisor that is down for a deploy
 * should not also be down for its lease.
 *
 * Guarded on the holder so a process cannot release a lease it no longer owns.
 */
export async function releaseQueenLease(
  pool: Pool,
  name: string,
  holder: string,
): Promise<boolean> {
  const result = await pool.query(
    // Expire rather than delete: the fence must survive, or the counter resets
    // to 1 on the next acquisition and a stale writer from term 5 outranks the
    // legitimate holder of the new term 1.
    `UPDATE queen_lease SET expires_at = now() - make_interval(secs => 1)
     WHERE name = $1 AND holder = $2`,
    [name, holder],
  )
  return (result.rowCount ?? 0) > 0
}

export async function queenLeaseStatus(
  pool: Pool,
  name: string,
): Promise<{ holder: string; fence: number; expiresAt: string } | null> {
  const result = await pool.query(
    'SELECT holder, fence, expires_at FROM queen_lease WHERE name = $1',
    [name],
  )
  if (!result.rowCount) return null
  const row = result.rows[0]
  return {
    holder: row.holder,
    fence: Number(row.fence),
    expiresAt: new Date(row.expires_at).toISOString(),
  }
}

/**
 * A name for this process that survives a restart badly on purpose.
 *
 * If a container restarted and came back with the SAME holder name, it would
 * renew a lease that the surviving instance had legitimately taken - the
 * `holder = EXCLUDED.holder` branch would fire and two live processes would both
 * be told they hold it. Including the boot identity means a restarted process is
 * a different contender and must wait out the term like anyone else.
 */
export function queenHolderName(): string {
  const platform =
    process.env.RAILWAY_REPLICA_ID ||
    process.env.RAILWAY_DEPLOYMENT_ID ||
    process.env.HOSTNAME ||
    'local'
  return `${platform}:${process.pid}`
}

export function logLeaseOutcome(grant: LeaseGrant, self: string): void {
  if (grant.acquired) return
  logger.info('Queen lease held elsewhere; standing down this round', {
    holder: grant.holder,
    self,
    expiresAt: grant.expiresAt,
  })
}
