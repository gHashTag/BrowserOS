/**
 * WHO IS CARRYING THE SWARM, AND BY HOW MUCH.
 *
 * The owner, 2026-09-23: people who lend the swarm a provider token of their
 * own should earn XP for it, and there should be a leaderboard.
 *
 * XP IS NOT A COUNT OF TOKENS LENT. A key that is added and never used carries
 * nothing, and paying for the adding would pay for ten dead keys. Every bee
 * runs on exactly one credential and the dispatch records which
 * (`key_index`), how long it ran and what the review said, so the score is a
 * reading of work that actually happened:
 *
 *   ACCEPTED_XP   per issue whose work the Queen accepted on that key
 *   HOUR_XP       per hour a bee spent working on it
 *
 * A send-back, an escalation or an empty turn pays nothing: the hours are
 * counted for every finished turn, because the key holder paid for them either
 * way, but only accepted work earns the larger part.
 *
 * WHOSE KEY IS WHICH. The credentials come from the operator's environment, so
 * the mapping from a lane to a person does too: `TRIOS_KEY_OWNERS`, e.g.
 *
 *   TRIOS_KEY_OWNERS="0=Dmitrii,1=@alex,4=Trinity community"
 *
 * A lane nobody claimed is shown as `key #N` rather than dropped - the work is
 * real and the board must not imply the swarm ran on four keys when it ran on
 * fourteen. Nothing here reads a key, and nothing here can: the value never
 * leaves the environment, and only its index appears in the database.
 */
import type { Pool } from 'pg'

/** An issue the Queen accepted, on this key. */
export const ACCEPTED_XP = 100
/** An hour of a bee's turn, on this key. */
export const HOUR_XP = 10

export interface KeyWork {
  keyIndex: number
  accepted: number
  finished: number
  hours: number
}

export interface Contributor {
  /** The operator's name for the lender, or `key #N` when nobody claimed it. */
  name: string
  /** Whether a person claimed this lane in TRIOS_KEY_OWNERS. */
  claimed: boolean
  keys: number[]
  accepted: number
  finished: number
  hours: number
  xp: number
}

/** `0=Dmitrii,1=@alex` -> { 0: 'Dmitrii', 1: '@alex' }. Bad entries are skipped. */
export function parseOwners(raw: string | undefined): Record<number, string> {
  const owners: Record<number, string> = {}
  for (const entry of (raw ?? '').split(',')) {
    const at = entry.indexOf('=')
    if (at <= 0) continue
    const index = Number(entry.slice(0, at).trim())
    const name = entry
      .slice(at + 1)
      .trim()
      .slice(0, 40)
    if (!Number.isInteger(index) || index < 0 || !name) continue
    owners[index] = name
  }
  return owners
}

export function xpFor(work: Pick<KeyWork, 'accepted' | 'hours'>): number {
  return Math.round(work.accepted * ACCEPTED_XP + work.hours * HOUR_XP)
}

/**
 * The work of each lane, gathered by lender and ranked. Pure: the rows are the
 * database's, the ranking is this function's, and the test drives it directly.
 */
export function rank(
  work: KeyWork[],
  owners: Record<number, string>,
): Contributor[] {
  const byName = new Map<string, Contributor>()
  for (const lane of work) {
    const claimed = Object.hasOwn(owners, lane.keyIndex)
    const name = claimed ? owners[lane.keyIndex] : `key #${lane.keyIndex}`
    const seen = byName.get(name)
    const into: Contributor = seen ?? {
      name,
      claimed,
      keys: [],
      accepted: 0,
      finished: 0,
      hours: 0,
      xp: 0,
    }
    into.keys.push(lane.keyIndex)
    into.accepted += lane.accepted
    into.finished += lane.finished
    into.hours = Math.round((into.hours + lane.hours) * 10) / 10
    byName.set(name, into)
  }
  const ranked = [...byName.values()].map((c) => ({ ...c, xp: xpFor(c) }))
  // XP first; then the one who finished more turns; then by name, so two equal
  // rows do not swap places between two readings of the same data.
  ranked.sort(
    (a, b) =>
      b.xp - a.xp || b.finished - a.finished || a.name.localeCompare(b.name),
  )
  return ranked
}

/**
 * Every lane's work over a window, from the live dispatches and the archive of
 * earlier attempts. A retry overwrites its dispatch row (one row per issue), so
 * the archive is where the turns before it live; leaving it out counted the
 * last attempt of each issue and called it the swarm's whole history.
 */
export async function keyWork(pool: Pool, days = 30): Promise<KeyWork[]> {
  const { rows } = await pool.query(
    `WITH turns AS (
       SELECT key_index, review_state, dispatched_at, finished_at
         FROM queen_dispatch
        WHERE dispatched_at > now() - ($1::integer * interval '1 day')
       UNION ALL
       SELECT (snapshot->>'key_index')::integer,
              snapshot->>'review_state',
              (snapshot->>'dispatched_at')::timestamptz,
              (snapshot->>'finished_at')::timestamptz
         FROM queen_dispatch_history
        WHERE archived_at > now() - ($1::integer * interval '1 day')
          AND snapshot->>'key_index' ~ '^[0-9]+$'
     )
     SELECT key_index,
            count(*) FILTER (WHERE review_state = 'accept') AS accepted,
            count(*) FILTER (WHERE finished_at IS NOT NULL) AS finished,
            coalesce(
              sum(extract(epoch FROM (finished_at - dispatched_at)))
                FILTER (WHERE finished_at IS NOT NULL),
              0
            ) / 3600.0 AS hours
       FROM turns
      WHERE key_index IS NOT NULL
      GROUP BY key_index
      ORDER BY key_index`,
    [days],
  )
  return rows.map((row) => ({
    keyIndex: Number(row.key_index),
    accepted: Number(row.accepted ?? 0),
    finished: Number(row.finished ?? 0),
    hours: Math.round(Number(row.hours ?? 0) * 10) / 10,
  }))
}

export interface Leaderboard {
  days: number
  measuredAt: string
  /** What one accepted issue and one bee-hour are worth, so the page can say so. */
  scoring: { acceptedXp: number; hourXp: number }
  contributors: Contributor[]
}

export async function leaderboard(pool: Pool, days = 30): Promise<Leaderboard> {
  const work = await keyWork(pool, days)
  return {
    days,
    measuredAt: new Date().toISOString(),
    scoring: { acceptedXp: ACCEPTED_XP, hourXp: HOUR_XP },
    contributors: rank(work, parseOwners(process.env.TRIOS_KEY_OWNERS)),
  }
}
