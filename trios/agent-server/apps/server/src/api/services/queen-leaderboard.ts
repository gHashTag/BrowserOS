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
 * A NAME THAT STARTS WITH `@` IS A GITHUB LOGIN. This project lives on GitHub -
 * the issues, the branches, the pull requests a bee opens are all there - so the
 * person who lent the lane is nearly always someone with a GitHub account, and
 * saying `1=@alex` gives the board a face and a profile to link instead of a
 * bare string. The login is validated against GitHub's own rule (alphanumerics
 * and single hyphens, up to 39 characters); anything else stays a plain name,
 * so `4=Trinity community` and an `@` in a display name cannot become a link to
 * a profile that is not theirs. Nothing is fetched from GitHub here: the handle
 * travels as text and the page builds the avatar URL, so a leaderboard read
 * never depends on GitHub being up or on a rate limit.
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
/**
 * AN ACCEPTED ISSUE WHOSE BOUNDARY NAMED A `.t27` FILE, ON TOP OF ACCEPTED_XP.
 *
 * Owner's word, 2026-09-23: the specs themselves are the main thing this score
 * should measure. That is not a preference, it is law L0 - everything below the
 * interface becomes `.t27` - and a score that paid the same for a shell script
 * and for the spec replacing it would reward every direction equally while the
 * constitution names one.
 *
 * So spec work pays three times what other accepted work pays, and the board
 * says which of the two it counted rather than hiding the weight in a total.
 */
export const SPEC_XP = 200

export interface KeyWork {
  keyIndex: number
  accepted: number
  /** Of those accepted, the ones whose boundary named a `.t27` file. */
  specs: number
  finished: number
  hours: number
}

export interface Contributor {
  /** Accepted issues whose boundary named a `.t27` file: the game's own goal. */
  specs?: number
  /** The operator's name for the lender, or `key #N` when nobody claimed it. */
  name: string
  /** Whether a person claimed this lane in TRIOS_KEY_OWNERS. */
  claimed: boolean
  /** Their GitHub login, when the name was written as `@login`. */
  github?: string
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

export function xpFor(
  work: Pick<KeyWork, 'accepted' | 'hours'> & { specs?: number },
): number {
  // Spec work is accepted work too, so it earns ACCEPTED_XP and SPEC_XP on top
  // rather than instead: the bonus says "and this one moved the goal", it does
  // not pretend the rest was not work.
  const specs = Math.min(work.specs ?? 0, work.accepted)
  return Math.round(
    work.accepted * ACCEPTED_XP + specs * SPEC_XP + work.hours * HOUR_XP,
  )
}

/**
 * GitHub's own rule for a login: alphanumerics and single hyphens, never at
 * either end, at most 39 characters. Kept strict on purpose - this string
 * becomes a link to a person's profile and the URL of their avatar, so a name
 * that merely contains an `@` must not be able to point the board at a
 * stranger's account.
 */
const GITHUB_LOGIN = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/

/** `@alex` -> 'alex'. Anything that is not a login is not one. */
export function githubLoginOf(name: string): string | undefined {
  if (!name.startsWith('@')) return undefined
  const login = name.slice(1)
  return GITHUB_LOGIN.test(login) ? login : undefined
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
      ...(claimed ? { github: githubLoginOf(name) } : {}),
      keys: [],
      accepted: 0,
      specs: 0,
      finished: 0,
      hours: 0,
      xp: 0,
    }
    into.keys.push(lane.keyIndex)
    into.accepted += lane.accepted
    into.specs = (into.specs ?? 0) + (lane.specs ?? 0)
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
export async function keyWork(
  pool: Pool,
  days: number | null = null,
): Promise<KeyWork[]> {
  // ALL TIME IS THE DEFAULT, and `days` narrows it.
  //
  // A thirty-day window was the first shape of this and it was the wrong one:
  // the board is a record of who carried the swarm, and a record that forgets
  // last month tells a lender their work stopped counting. It also shrinks on
  // its own - a lane that worked hard in August and stopped simply vanished,
  // which reads as "did nothing" rather than "did this, earlier".
  //
  // `null` means no time predicate at all rather than a very large number of
  // days, so the query has nothing to be off-by-one about, and the archive's
  // own rows decide how far back the answer goes.
  const windowed = days !== null
  const { rows } = await pool.query(
    `WITH turns AS (
       SELECT key_index, review_state, dispatched_at, finished_at, owned_paths
         FROM queen_dispatch
        ${windowed ? "WHERE dispatched_at > now() - ($1::integer * interval '1 day')" : ''}
       UNION ALL
       SELECT (snapshot->>'key_index')::integer,
              snapshot->>'review_state',
              (snapshot->>'dispatched_at')::timestamptz,
              (snapshot->>'finished_at')::timestamptz,
              coalesce(snapshot->'owned_paths', '[]'::jsonb)
         FROM queen_dispatch_history
        WHERE snapshot->>'key_index' ~ '^[0-9]+$'
          ${windowed ? "AND archived_at > now() - ($1::integer * interval '1 day')" : ''}
     )
     SELECT key_index,
            count(*) FILTER (WHERE review_state = 'accept') AS accepted,
            -- The game's own goal, counted from what the issue said it would
            -- touch: a boundary naming a .t27 file is spec work. The board
            -- shows this beside the total rather than folding it in silently.
            -- (No backticks in here: this is inside a template literal, and one
            -- of them ends the string and turns the rest into a tagged call.)
            count(*) FILTER (
              WHERE review_state = 'accept'
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(owned_paths) AS p(path)
                   WHERE path LIKE '%.t27'
                )
            ) AS specs,
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
    windowed ? [days] : [],
  )
  return rows.map((row) => ({
    keyIndex: Number(row.key_index),
    accepted: Number(row.accepted ?? 0),
    specs: Number(row.specs ?? 0),
    finished: Number(row.finished ?? 0),
    hours: Math.round(Number(row.hours ?? 0) * 10) / 10,
  }))
}

export interface Leaderboard {
  /** The window in days, or null for the whole record. */
  days: number | null
  measuredAt: string
  /** What one accepted issue and one bee-hour are worth, so the page can say so. */
  scoring: { acceptedXp: number; specXp: number; hourXp: number }
  contributors: Contributor[]
}

export async function leaderboard(
  pool: Pool,
  days: number | null = null,
): Promise<Leaderboard> {
  const work = await keyWork(pool, days)
  return {
    days,
    measuredAt: new Date().toISOString(),
    scoring: { acceptedXp: ACCEPTED_XP, specXp: SPEC_XP, hourXp: HOUR_XP },
    contributors: rank(work, parseOwners(process.env.TRIOS_KEY_OWNERS)),
  }
}
