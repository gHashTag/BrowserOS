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
         )`,
    [holder, ttlSeconds],
  )
  return result.rowCount ?? 0
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
  return seq
}

/** The event names this card knows, for callers that publish by name. */
export async function controlEventNames(): Promise<string[]> {
  return (await loadControlSpec()).eventNames
}

export { queenHolderName }
