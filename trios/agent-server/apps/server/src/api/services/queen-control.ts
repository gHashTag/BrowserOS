/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * One task, one lease, and a log of what happened - the parts of
 * specs/queen/control.t27 the live loop was missing (gHashTag/t27#6657).
 *
 * The contract card is VENDORED at trios/agent-server/specs/queen/control.t27
 * and read here by the same vendored compiler wasm the scheduler uses. Every
 * constant this module enforces - the 180s task TTL, the 60s heartbeat, the
 * 300s reconcile cadence, the ten event names - is lifted from that file's
 * AST. Nothing is re-typed below; a card that stops typechecking stops this
 * module, because a supervisor running on remembered numbers is a supervisor
 * nobody amended.
 *
 * WHAT THIS FIXES. Before this module, every write below the round's lease was
 * unfenced - its own comment said so - and a dispatch was the only record that
 * an issue was taken. A container that died mid-turn left that record open for
 * the two-hour stall reaper, and the issue it named could not be re-chosen
 * until then. A TASK lease expires in TASK_LEASE_TTL_SECONDS: the same
 * container, redeployed or stalled past its heartbeat, hands the issue back in
 * minutes, and the fence makes a returning zombie's late writes visible as
 * stale rather than authoritative.
 *
 * HONEST SCOPE. The fence is WRITTEN and read, not yet enforced on
 * recordDispatch: closing that (write_lands on every dispatch write) is the
 * next slice, and pretending it is closed here would be the exact hand-copied
 * rule this codebase keeps catching. Event reactions (wakes_queen,
 * reaction_of) and the cancel/assign routes are also next slices; this lands
 * the lease, the log, and the wiring a round needs to use both.
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { DEFAULT_SPECS_ROOT } from '../../inngest/spec-catalog'
import { type Analyze, loadCompiler } from '../../inngest/t27-consts'
import { QUEEN_CONTROL_SQL } from '../../lib/db/pg-migrate'
import { logger } from '../../lib/logger'
import { queenHolderName } from './queen-lease'

/** The slice of the card this module enforces, straight from the wasm. */
export interface ControlSpec {
  /** EVENT_NAMES, in kind order. Index == event kind. */
  eventNames: string[]
  /** EVENT_KINDS. eventNames.length must equal it or the card is corrupt. */
  eventKinds: number
  reconcileSeconds: number
  taskLeaseTtlSeconds: number
  taskHeartbeatSeconds: number
  noHolder: number
}

let controlPromise: Promise<ControlSpec> | null = null

/**
 * Read the control card through the real compiler, once per process.
 *
 * Refusal discipline is the scheduler's: a card that does not typecheck or
 * drops a token is refused outright - there is no fallback set of constants,
 * because the fallback is where the copy of the rule stops matching the rule.
 */
export async function loadControlSpec(
  root: string = DEFAULT_SPECS_ROOT,
): Promise<ControlSpec> {
  if (controlPromise && resolve(root) === resolve(DEFAULT_SPECS_ROOT))
    return controlPromise
  const read = async (): Promise<ControlSpec> => {
    // Card first: a missing or unreadable card must be named as THAT, not as
    // a missing compiler, because the operator's next move is different.
    const text = await readFile(join(root, 'queen/control.t27'), 'utf8')
    const wasm = new Uint8Array(await readFile(join(root, 't27_compiler.wasm')))
    const analyze: Analyze = await loadCompiler(wasm)
    let a: ReturnType<Analyze>
    try {
      a = analyze(text)
    } catch (err) {
      throw new Error(
        `queen/control.t27: compiler refused it: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!a.typecheckOk)
      throw new Error(`queen/control.t27: typecheck: ${a.errors} error(s)`)
    if (a.discarded > 0)
      throw new Error(
        `queen/control.t27: parser discarded ${a.discarded} token(s)`,
      )
    const n = (k: string): number => {
      const v = a.consts[k]?.value
      if (typeof v !== 'number')
        throw new Error(`queen/control.t27: ${k} is missing`)
      return v
    }
    const names = a.consts.EVENT_NAMES?.value
    if (!Array.isArray(names) || names.some((x) => typeof x !== 'string'))
      throw new Error('queen/control.t27: EVENT_NAMES is missing')
    const spec: ControlSpec = {
      eventNames: names.map(String),
      eventKinds: n('EVENT_KINDS'),
      reconcileSeconds: n('RECONCILE_SECONDS'),
      taskLeaseTtlSeconds: n('TASK_LEASE_TTL_SECONDS'),
      taskHeartbeatSeconds: n('TASK_HEARTBEAT_SECONDS'),
      noHolder: n('NO_HOLDER'),
    }
    if (spec.eventNames.length !== spec.eventKinds)
      throw new Error(
        `queen/control.t27: EVENT_NAMES has ${spec.eventNames.length} entries, EVENT_KINDS says ${spec.eventKinds}`,
      )
    return spec
  }
  const p = read()
  if (resolve(root) === resolve(DEFAULT_SPECS_ROOT)) controlPromise = p
  return p
}

/**
 * Create the control tables if this deploy predates them.
 *
 * Same statements the boot migration runs (QUEEN_CONTROL_SQL is the one home
 * for this DDL); idempotent, so a round may run it cheaply on every pass.
 */
export async function ensureControlTables(pool: Pool): Promise<void> {
  await pool.query(QUEEN_CONTROL_SQL)
}

export interface TaskLeaseGrant {
  /** Whether THIS call landed the claim or the renewal. */
  landed: boolean
  /** Who holds it now - the incumbent, when `landed` is false. */
  holder: string
  fence: number
  expiresAt: string
}

/**
 * Take or renew the lease on ONE task, in one statement.
 *
 * The SQL is the queen_lease idiom moved to per-issue rows, and the semantics
 * are the card's claim_lands/renew_lands: an expired lease lands for anyone
 * (fence +1, so the old holder's term is superseded), an unexpired one lands
 * only for its own holder (a renewal). A contender that loses gets zero rows -
 * not an error, and not a lease - and the caller must not start work.
 */
export async function claimTaskLease(
  pool: Pool,
  issue: number,
  holder: string,
  ttlSeconds: number,
): Promise<TaskLeaseGrant> {
  const taken = await pool.query(
    `INSERT INTO queen_task_lease (issue, holder, acquired_at, renewed_at, expires_at, fence)
     VALUES ($1, $2, now(), now(), now() + make_interval(secs => $3), 1)
     ON CONFLICT (issue) DO UPDATE
       SET holder = EXCLUDED.holder,
           acquired_at = now(),
           renewed_at = now(),
           expires_at = now() + make_interval(secs => $3),
           fence = queen_task_lease.fence + 1
       WHERE queen_task_lease.expires_at < now()
          OR queen_task_lease.holder = EXCLUDED.holder
     RETURNING holder, fence, expires_at`,
    [issue, holder, ttlSeconds],
  )
  if (taken.rowCount && taken.rowCount > 0) {
    const row = taken.rows[0]
    return {
      landed: true,
      holder: row.holder,
      fence: Number(row.fence),
      expiresAt: new Date(row.expires_at).toISOString(),
    }
  }
  const held = await pool.query(
    'SELECT holder, fence, expires_at FROM queen_task_lease WHERE issue = $1',
    [issue],
  )
  const row = held.rows[0]
  return {
    landed: false,
    holder: row?.holder ?? 'unknown',
    fence: Number(row?.fence ?? 0),
    expiresAt: row ? new Date(row.expires_at).toISOString() : '',
  }
}

/**
 * Give a task back early - guarded on the holder, so a process that lost its
 * lease (and its fence) cannot also give away the new holder's.
 *
 * Expires rather than deletes, for the same reason queen_lease does: the fence
 * survives, or term 1 comes back and outranks the future.
 */
export async function releaseTaskLease(
  pool: Pool,
  issue: number,
  holder: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE queen_task_lease
        SET expires_at = now() - make_interval(secs => 1)
      WHERE issue = $1 AND holder = $2`,
    [issue, holder],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * The round's heartbeat: renew every lease this holder still has whose task is
 * genuinely in flight (`queen_dispatch` says started and unfinished).
 *
 * The card sets the heartbeat shorter than the TTL on purpose: a round that
 * runs on schedule keeps its leases alive, and a container that stops running
 * rounds loses them within the TTL without anyone sweeping. Renewal does not
 * bump the fence - the term continues, so `write_lands(fence, my_fence)` stays
 * true for the holder that never lost it.
 */
export async function renewRunningLeases(
  pool: Pool,
  holder: string,
  ttlSeconds: number,
): Promise<number> {
  const result = await pool.query(
    `UPDATE queen_task_lease t
        SET renewed_at = now(),
            expires_at = now() + make_interval(secs => $2)
       WHERE t.holder = $1
         AND t.expires_at >= now()
         AND EXISTS (
           SELECT 1 FROM queen_dispatch d
            WHERE d.issue = t.issue AND d.started AND d.finished_at IS NULL
              -- Only what the Queen herself is running or still holding as an
              -- order. A task a runner has taken is renewed by that runner
              -- (renewTaskLeases), so its lease says whether the RUNTIME is
              -- alive - the card's heartbeat comes from the agent runtime,
              -- not from the Queen vouching for a process she cannot see.
              AND d.claimed_by IS NULL
              AND d.runner_claimed_at IS NULL
         )`,
    [holder, ttlSeconds],
  )
  return result.rowCount ?? 0
}

/**
 * A runtime's heartbeat for the tasks it is running (card section 2:
 * TASK_HEARTBEAT_SECONDS, renew_lands). Renews only a lease that has not
 * expired: once a lease lapsed, the task may already be another runtime's,
 * and a late heartbeat must not revive it. Returns the issues renewed.
 */
export async function renewTaskLeases(
  pool: Pick<Pool, 'query'>,
  issues: number[],
  ttlSeconds: number,
): Promise<number[]> {
  if (issues.length === 0) return []
  const result = await pool.query(
    `UPDATE queen_task_lease
        SET renewed_at = now(),
            expires_at = now() + make_interval(secs => $2)
      WHERE issue = ANY($1::int[]) AND expires_at >= now()
      RETURNING issue`,
    [issues, ttlSeconds],
  )
  return result.rows.map((r) => Number(r.issue))
}

/**
 * Reclamation (card section 2: reclaimable, EV_LEASE_EXPIRED -> R_RECLAIM).
 * A task a runner took is ended at once when its lease has lapsed AND the
 * runner's own older pulse - `claimed_at` for a bee runner, `runner_lease_at`
 * for a lent runner - has also been silent for a whole TTL, instead of waiting
 * out the 10- and 15-minute silences of the runner reapers.
 *
 * Both, not either. A runner from before this rule renews only its old pulse;
 * draining through a deploy, it must not be mistaken for a dead one. A task
 * the Queen runs herself is left to the boot and stall reapers, which salvage
 * the worktree before they end the row; an order no runner has taken yet is
 * the offer reapers' business. Returns the issues ended, with their fences.
 */
export async function reclaimExpiredLeases(
  pool: Pool,
  ttlSeconds: number,
  outcome: string,
): Promise<Array<{ issue: number; fence: number }>> {
  const result = await pool.query(
    `UPDATE queen_dispatch d
        SET finished_at = now(), outcome = $2
       FROM queen_task_lease t
      WHERE t.issue = d.issue
        AND t.expires_at < now()
        AND d.started = true AND d.finished_at IS NULL
        AND (
          (d.claimed_by IS NOT NULL
             AND d.claimed_at < now() - make_interval(secs => $1))
          OR (d.runner_claimed_at IS NOT NULL
             AND coalesce(d.runner_lease_at, d.runner_claimed_at)
                 < now() - make_interval(secs => $1))
        )
      RETURNING d.issue, t.fence`,
    [ttlSeconds, outcome],
  )
  return result.rows.map((r) => ({
    issue: Number(r.issue),
    fence: Number(r.fence),
  }))
}

/**
 * Leases past their TTL - the card's `reclaimable`. Reported, not deleted:
 * takeover happens at claim time under the row lock, and this list is what the
 * round says out loud so a silent expiry is distinguishable from none.
 */
export async function reclaimableTaskLeases(
  pool: Pool,
): Promise<Array<{ issue: number; holder: string; fence: number }>> {
  const result = await pool.query(
    'SELECT issue, holder, fence FROM queen_task_lease WHERE expires_at < now()',
  )
  return result.rows.map((r) => ({
    issue: Number(r.issue),
    holder: String(r.holder),
    fence: Number(r.fence),
  }))
}

/**
 * Append one event to the log. `name` must be one of the card's EVENT_NAMES -
 * kinds are indices into that array, so a name this card does not know is a
 * caller the card has not agreed to, and it is refused before any SQL runs.
 *
 * The sequence is assigned in the same statement that writes the row; two
 * concurrent publishers on one stream race for (stream, seq) and the PRIMARY
 * KEY makes the loser an error rather than a duplicate. Idempotent replay by
 * event id (the card's `event_applies`) belongs to the reaction slice, which
 * is what needs it.
 */
export async function publishEvent(
  pool: Pool,
  name: string,
  payload: Record<string, unknown>,
  stream = 'queen',
): Promise<number> {
  const spec = await loadControlSpec()
  const kind = spec.eventNames.indexOf(name)
  if (kind < 0)
    throw new Error(
      `queen event ${JSON.stringify(name)} is not in EVENT_NAMES of the control card`,
    )
  const result = await pool.query(
    `INSERT INTO queen_event_log (stream, seq, kind, payload)
     SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3::jsonb
       FROM queen_event_log WHERE stream = $1
     RETURNING seq`,
    [stream, kind, JSON.stringify(payload)],
  )
  const seq = Number(result.rows[0]?.seq ?? 0)
  logger.info('Queen control event', { stream, name, kind, seq })
  // After the row exists, never before: a reaction that ran ahead of the log
  // would be a reaction to an event nobody can replay.
  if (eventListener) {
    try {
      eventListener({ stream, name, kind, seq })
    } catch (error) {
      logger.warn('Queen control event listener failed', {
        name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return seq
}

/** One event as the log recorded it. */
export interface ControlEvent {
  stream: string
  name: string
  kind: number
  seq: number
}

let eventListener: ((event: ControlEvent) => void) | null = null

/**
 * Who hears an event once it is in the log. One listener, set by the process
 * that runs the Queen's round (`wakeOnControlEvents` in queen-tick.ts); null
 * clears it. A process that runs no round - a bee runner - sets none, and its
 * events are still recorded.
 */
export function setControlEventListener(
  listener: ((event: ControlEvent) => void) | null,
): void {
  eventListener = listener
}

/**
 * Queue a person's assignment (card section 3). Idempotent: asking twice keeps
 * the first request's place in the order.
 */
export async function requestAssign(
  pool: Pool,
  issue: number,
  by: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO queen_manual_assign (issue, requested_by)
     VALUES ($1, $2) ON CONFLICT (issue) DO NOTHING`,
    [issue, by],
  )
}

/** The assignments still waiting, oldest first. */
export async function pendingAssigns(pool: Pool): Promise<number[]> {
  const result = await pool.query(
    'SELECT issue FROM queen_manual_assign ORDER BY requested_at, issue',
  )
  return result.rows.map((r) => Number(r.issue))
}

/** Drop the assignments a round has served. */
export async function clearAssigns(
  pool: Pool,
  issues: number[],
): Promise<void> {
  if (issues.length === 0) return
  await pool.query(
    'DELETE FROM queen_manual_assign WHERE issue = ANY($1::int[])',
    [issues],
  )
}

/**
 * Whether a task's lease is held right now by a bee that is still working: the
 * card's `task_leased_live` input to assign_answer. A lease that expired, or
 * whose dispatch already ended, holds nothing.
 */
export async function taskLeasedLive(
  pool: Pool,
  issue: number,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM queen_task_lease t
       JOIN queen_dispatch d ON d.issue = t.issue
      WHERE t.issue = $1 AND t.expires_at >= now()
        AND d.started AND d.finished_at IS NULL`,
    [issue],
  )
  return (result.rowCount ?? 0) > 0
}

export type CancelResult =
  | { status: 'none' }
  | { status: 'accepted' }
  | {
      status: 'cancelled'
      /** The bee was still working when the cancel landed. */
      wasRunning: boolean
      conversationId: string | null
      /** The task lease's fence after the cancel, or null if it never had one. */
      fence: number | null
    }

/**
 * Cancel one task (card section 3).
 *
 * - cancel_allowed: an accepted dispatch is not cancelled - only the CI
 *   take-back of dispatch.t27 undoes an accept.
 * - The row ends in one statement: `review_state = 'cancelled'` (which
 *   stateOfDispatch reads as `failed`, free in claimOnIssue, so the files are
 *   released at once) and `finished_at` set if it was not. `finishDispatch`
 *   writes only `WHERE finished_at IS NULL AND conversation_id = ...`, so the
 *   interrupted bee's own late ending does not land.
 * - cancel_counts_against_issue is false: send_backs, free_attempts and
 *   ceiling_releases are not touched.
 * - fence_after_cancel: the task lease's fence moves on and the lease expires,
 *   so any write still carrying the old fence is stale.
 * - A pending assignment of the issue is withdrawn with it.
 *
 * Interrupting the running turn is the caller's half, because only the process
 * that streams the turn can close its connection (`abortBeeHere`).
 */
export async function cancelTask(
  pool: Pool,
  issue: number,
  by: string,
  reason: string,
): Promise<CancelResult> {
  const note =
    `Cancelled by ${by}` +
    (reason ? `: ${reason}` : '') +
    ' (gHashTag/t27 specs/queen/control.t27 section 3). Not counted against the issue.'
  const ended = await pool.query(
    `WITH before AS (
       SELECT issue, finished_at IS NULL AS running, conversation_id,
              coalesce(review_state, '') AS was
         FROM queen_dispatch WHERE issue = $1 FOR UPDATE
     )
     UPDATE queen_dispatch d
        SET review_state = 'cancelled',
            judged_note = CASE WHEN b.was = 'cancelled' THEN d.judged_note
                               ELSE $2 || coalesce(E'\\n' || d.judged_note, '')
                          END,
            finished_at = coalesce(d.finished_at, now()),
            outcome = coalesce(d.outcome, 'cancelled')
       FROM before b
      WHERE d.issue = b.issue AND b.was <> 'accept'
      RETURNING b.running, b.conversation_id, b.was`,
    [issue, note],
  )
  if (!ended.rowCount) {
    const exists = await pool.query(
      'SELECT review_state FROM queen_dispatch WHERE issue = $1',
      [issue],
    )
    await clearAssigns(pool, [issue])
    if (!exists.rowCount) return { status: 'none' }
    return { status: 'accepted' }
  }
  const row = ended.rows[0]
  const fenced = await pool.query(
    `UPDATE queen_task_lease
        SET fence = fence + 1, expires_at = now() - make_interval(secs => 1)
      WHERE issue = $1
      RETURNING fence`,
    [issue],
  )
  await clearAssigns(pool, [issue])
  logger.info('Queen task cancelled', {
    issue,
    by,
    was: row.was || null,
    wasRunning: Boolean(row.running),
  })
  return {
    status: 'cancelled',
    wasRunning: Boolean(row.running),
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    fence: fenced.rowCount ? Number(fenced.rows[0].fence) : null,
  }
}

/** The event names this card knows, for callers that publish by name. */
export async function controlEventNames(): Promise<string[]> {
  return (await loadControlSpec()).eventNames
}

export { queenHolderName }
