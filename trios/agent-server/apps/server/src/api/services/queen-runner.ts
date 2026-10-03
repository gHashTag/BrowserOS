/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A BEE THAT DOES NOT LIVE INSIDE THE QUEEN.
 *
 * Until now a bee was a thread of the supervisor: `dispatchBee` cut a worktree
 * on her volume and sent the turn to her own `/chat`. Everything the swarm
 * could ever be was therefore one container. Measured on the deployed one,
 * 2026-09-18: 24 GB of memory, about a gigabyte a bee, a 50 GB volume holding
 * every worktree, and a ceiling the operator kept moving up and down against
 * numbers that were really the container's and not the swarm's.
 *
 * So the work is handed over instead. The Queen still decides everything she
 * decided before - which issue, which boundary, which credential - and writes
 * it as a row. This file is the other half: a process that takes one such row
 * and does the work in ITS container, with its own memory, its own disk and its
 * own checkout. Add a replica and the swarm is wider; take one away and the
 * rows it had not claimed are still there.
 *
 * WHY THE ROW IS THE PROTOCOL. There is already a table that says which issue
 * is in flight, under which boundary, on which credential, and a review sweep
 * and two reapers that read it. A queue beside it would be a second answer to
 * the same question, and the two would disagree the first time a process died
 * between them. `UPDATE ... WHERE claimed_by IS NULL` over a row picked `FOR
 * UPDATE SKIP LOCKED` is the whole of the mutual exclusion: two runners cannot
 * take one issue, and a runner that dies without finishing leaves exactly what
 * a Queen that died mid-bee always left, which the boot reaper already clears.
 *
 * WHAT IS NOT SENT. The credential. The row carries `key_index`, and the runner
 * resolves it against the same worker variables the Queen reads, so a secret
 * never enters the table, the backups or anyone's `SELECT *`. A runner whose
 * variables differ cannot resolve the index and says so rather than reaching
 * for the next key along, which would be a different account.
 */
import { hostname } from 'node:os'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import { bundleOfBranch } from '../routes/queen-export'
import { runClaimedBee, salvageDispatch } from './queen-dispatch'
import { queenLeaseDatabaseUrl } from './queen-lease'

export interface BeeOrder {
  issue: number
  branch: string
  brief: string
  ownedPaths: string[]
  conversationId: string
  keyIndex: number
}

/** Who this runner is, in logs and in `claimed_by`. */
export function runnerName(): string {
  const stated = process.env.TRIOS_BEE_RUNNER_NAME?.trim()
  if (stated) return stated.slice(0, 80)
  // Railway gives every replica the same service name, so the pid is what
  // separates two runners in one image. A name that collides is not a
  // correctness problem - the claim is - but it is an unreadable log.
  return `${hostname()}:${process.pid}`
}

/** How many bees this replica carries at once. One by default, and small on purpose. */
export function runnerSlots(): number {
  const parsed = Number(process.env.TRIOS_BEE_RUNNER_SLOTS)
  if (!Number.isInteger(parsed) || parsed < 1) return 1
  return Math.min(parsed, 64)
}

function pollSeconds(): number {
  const parsed = Number(process.env.TRIOS_BEE_RUNNER_SECONDS ?? '0')
  if (!Number.isInteger(parsed) || parsed < 5) return 0
  return Math.min(parsed, 3600)
}

/**
 * Take one order, or nothing.
 *
 * `FOR UPDATE SKIP LOCKED` rather than a transaction two runners queue behind:
 * a runner that waits for another runner's lock is a runner doing nothing while
 * an unclaimed row sits next to it. Oldest first, because an order that has
 * waited longest is the one whose issue has been held longest.
 */
export async function claimQueuedBee(
  pool: Pool,
  runner: string,
): Promise<BeeOrder | null> {
  const rows = await pool.query(
    `UPDATE queen_dispatch
        SET claimed_by = $1, claimed_at = now()
      WHERE issue = (
        SELECT issue FROM queen_dispatch
         WHERE queued_at IS NOT NULL
           AND claimed_by IS NULL
           AND finished_at IS NULL
           AND started = true
         ORDER BY queued_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING issue, branch, brief, owned_paths, conversation_id, key_index`,
    [runner],
  )
  const row = rows.rows?.[0]
  if (!row) return null
  const keyIndex = Number(row.key_index)
  const conversationId = String(row.conversation_id ?? '')
  if (!Number.isInteger(keyIndex) || !conversationId) {
    // An order the Queen could not complete. Left claimed rather than retried:
    // a row without a credential or a conversation is not work this runner can
    // do, and releasing it would hand every runner the same unusable order.
    logger.warn('Runner claimed an order it cannot run', {
      issue: row.issue,
      hasConversation: Boolean(conversationId),
    })
    return null
  }
  return {
    issue: Number(row.issue),
    branch: String(row.branch),
    brief: String(row.brief ?? ''),
    ownedPaths: Array.isArray(row.owned_paths)
      ? (row.owned_paths as string[])
      : [],
    conversationId,
    keyIndex,
  }
}

/**
 * Wait for the ending the drain writes, vouching for the bee while it runs.
 *
 * Each poll renews `claimed_at`, which is how the Queen tells a long turn from a
 * dead runner: she cannot see this process, and without the renewal a runner
 * that vanished mid-turn would hold its issue's boundary and credential until
 * the two-hour rule. One statement does both jobs - a row that no longer
 * matches (finished, reaped, or re-dispatched to somebody else) is the answer
 * that this turn is no longer the table's business.
 */
export async function waitForEnding(
  pool: Pool,
  order: BeeOrder,
  runner: string,
  everyMs = 15_000,
): Promise<void> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, everyMs))
    try {
      const rows = await pool.query(
        `UPDATE queen_dispatch SET claimed_at = now()
          WHERE issue = $1 AND conversation_id = $2 AND claimed_by = $3
            AND finished_at IS NULL
          RETURNING issue`,
        [order.issue, order.conversationId, runner],
      )
      if (!rows.rows?.length) return
    } catch (error) {
      // One failed renewal is not a dead runner; the Queen gives it forty.
      logger.warn('Runner could not vouch for its bee', {
        issue: order.issue,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/**
 * Leave the work where somebody can reach it.
 *
 * The container publishes nothing - that rule is older than this file and the
 * reason for it is in queen-export.ts - but a runner cannot even be VISITED:
 * replicas share one address, its volume is its own, and it may be gone before
 * anyone asks. So the bundle goes into the table the export route now reads.
 * A turn that committed nothing has nothing to store, and that is not a
 * failure: plenty of bees end with a verdict and no commit.
 */
export async function storeBundle(
  pool: Pool,
  issue: number,
  runner: string,
): Promise<void> {
  const made = await bundleOfBranch(issue)
  if (!made.ok) {
    if (made.status !== 409) {
      logger.warn('Runner could not bundle its work', {
        issue,
        error: made.error,
      })
    }
    return
  }
  await pool.query(
    `INSERT INTO queen_bundle (issue, branch, base, runner, bytes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (issue) DO UPDATE
       SET branch = EXCLUDED.branch, base = EXCLUDED.base,
           runner = EXCLUDED.runner, bytes = EXCLUDED.bytes,
           created_at = now()`,
    [issue, made.branch, made.base, runner, made.bytes],
  )
  logger.info('Runner stored the bundle of a finished bee', {
    issue,
    branch: made.branch,
    commits: made.commits.length,
    bundleBytes: made.bytes.length,
  })
}

/**
 * One order, start to finish. Resolves when the bee has ended and its work is
 * where the publisher can fetch it, so the caller may then take another.
 */
export async function runOneOrder(
  pool: Pool,
  runner: string,
): Promise<BeeOrder | null> {
  const order = await claimQueuedBee(pool, runner)
  if (!order) return null
  logger.info('Runner claimed a bee', {
    runner,
    issue: order.issue,
    branch: order.branch,
  })
  inFlight.set(order.issue, order)
  try {
    const outcome = await runClaimedBee(pool, order)
    if (!outcome.started) return order
    await waitForEnding(pool, order, runner)
    await storeBundle(pool, order.issue, runner).catch((error) => {
      logger.warn('Runner could not store the bundle of a finished bee', {
        issue: order.issue,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return order
  } finally {
    inFlight.delete(order.issue)
  }
}

/** The orders this process is carrying right now, by issue. */
const inFlight = new Map<number, BeeOrder>()

/** The runner this process started, so a shutdown can drain it. */
let active: { pool: Pool; runner: string; stop: () => void } | null = null

/**
 * HOW LONG A STOPPING RUNNER WAITS FOR ITS BEES. Measured 2026-10-03: the
 * server leaves about 2 s after SIGTERM, so every release killed every bee in
 * flight - thirty at a time, each up to an hour of work - and their issues
 * waited for the reaper. `TRIOS_BEE_RUNNER_DRAIN_SECONDS` names the wait
 * (0..3600; unset or unreadable is 0, the old behaviour). The platform must
 * allow it too: on Railway, RAILWAY_DEPLOYMENT_DRAINING_SECONDS at least as long.
 */
export function drainSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.TRIOS_BEE_RUNNER_DRAIN_SECONDS?.trim() ?? ''
  if (!/^\d+$/.test(raw)) return 0
  return Math.min(Number(raw), 3600)
}

export interface DrainDeps {
  seconds?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  salvage?: typeof salvageDispatch
  store?: typeof storeBundle
  orders?: Map<number, BeeOrder>
}

/**
 * Take no more orders and let the bees in flight end on their own, up to the
 * drain deadline. A bee still running at the deadline is not thrown away: its
 * uncommitted work is salvaged into its branch and the branch is stored as a
 * bundle, so the Queen reviews what it did and the next attempt starts from it.
 */
export async function drainBeeRunner(
  pool: Pool,
  runner: string,
  deps: DrainDeps = {},
): Promise<{ waited: number; saved: number[] }> {
  const orders = deps.orders ?? inFlight
  const seconds = deps.seconds ?? drainSeconds()
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const started = now()
  const deadline = started + seconds * 1000
  if (orders.size > 0) {
    logger.info('Runner draining: no new orders, waiting for its bees', {
      runner,
      bees: orders.size,
      seconds,
    })
  }
  while (orders.size > 0 && now() < deadline) {
    await sleep(Math.min(2000, Math.max(0, deadline - now())))
  }
  const saved: number[] = []
  for (const order of [...orders.values()]) {
    try {
      await (deps.salvage ?? salvageDispatch)(pool, order.issue, 'reaped', {
        conversationId: order.conversationId,
      })
      await (deps.store ?? storeBundle)(pool, order.issue, runner)
      saved.push(order.issue)
    } catch (error) {
      logger.warn('Runner could not save the branch of a bee it stopped', {
        issue: order.issue,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (saved.length > 0) {
    logger.info('Runner saved the branches of bees it could not wait for', {
      runner,
      issues: saved,
    })
  }
  return { waited: Math.round((now() - started) / 1000), saved }
}

/** For the server's shutdown: drain the runner this process started, if any. */
export async function drainActiveRunner(): Promise<void> {
  if (!active) return
  active.stop()
  if (drainSeconds() === 0) return
  await drainBeeRunner(active.pool, active.runner)
}

/**
 * Start taking orders, or explain why not.
 *
 * Off unless `TRIOS_BEE_RUNNER_SECONDS` is set, for the same reason the Queen's
 * own loop is off by default: a server started on a laptop, in a test or beside
 * the app must not quietly join the hive and take work nobody can then find.
 */
export function startBeeRunner(): void {
  const every = pollSeconds()
  if (!every) return
  const url = queenLeaseDatabaseUrl()
  if (!url) {
    logger.warn('Bee runner requested but no database is configured')
    return
  }
  const runner = runnerName()
  const slots = runnerSlots()
  const pool = createQueenPool(url)
  let busy = 0
  let stopped = false
  logger.info('Bee runner starting', { runner, slots, everySeconds: every })

  const take = (): void => {
    if (stopped || busy >= slots) return
    busy += 1
    runOneOrder(pool, runner)
      .then((order) => {
        // A claim that found work asks again at once: a replica that waits out
        // its interval between bees is a replica idle for no reason, and the
        // queue is where the pacing belongs.
        if (order && !stopped) setImmediate(take)
      })
      .catch((error) => {
        logger.warn('Bee runner round failed', {
          runner,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        busy -= 1
      })
  }

  const timer = setInterval(() => {
    // Every free slot, not one: a replica with four slots and four orders
    // waiting should be carrying four bees, not one a minute.
    for (let slot = busy; slot < slots; slot++) take()
  }, every * 1000)
  take()

  const stop = (): void => {
    stopped = true
    clearInterval(timer)
  }
  active = { pool, runner, stop }

  process.once('SIGTERM', () => {
    stop()
    // The bees in flight are NOT abandoned here. Their rows stay claimed and
    // unfinished, which is exactly what a Queen that died mid-bee always left,
    // and the boot reaper clears it the same way.
  })
}
