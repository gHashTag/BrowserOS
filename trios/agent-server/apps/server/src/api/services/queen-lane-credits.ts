/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * WHOSE LANE CARRIED EACH ISSUE'S BRANCH.
 *
 * The spec-authors board (gHashTag/trinity, apps/website/scripts/spec-authors.mjs)
 * credits a commit to its GitHub author. A swarm commit reaches master as the
 * squash of a `queen-<issue>` pull request, authored by whoever merged it, so
 * every bee's work read as the merger's own. The owner, 2026-10-03: credit it to
 * the person whose provider key the bee ran on. This is the record that makes
 * that possible: for each issue, the lane of its latest turn - the turn whose
 * work the `queen-<issue>` branch carries - and the GitHub login of the person
 * who claimed that lane.
 *
 * NOT ONLY ACCEPTED TURNS. Measured 2026-10-03: of 514 queen-<issue> pull
 * requests merged since 2026-09-17, 89 had an accepted turn; the rest were
 * merged by the maintainer after a sendBack, escalate or wait verdict. The
 * merge is what puts the work on master, so the lane that wrote the branch is
 * the one credited, whatever the Queen's own review said.
 *
 * Public on the same terms as the leaderboard: issue numbers and logins that
 * board already shows, no titles, no worker text, no credential.
 *
 * A LANE IS A SLOT, NOT A KEY. Index N named a different credential before its
 * present owner lent theirs (until 2026-09-17 the pool ran on the operator's
 * plan). TRIOS_KEY_OWNERS_SINCE (`login=YYYY-MM-DD,...`) says from when a
 * login's lanes were theirs; a turn dispatched earlier is credited to nobody
 * here, and the board falls back to its old rule for it.
 */
import type { Pool } from 'pg'
import { contributorOwnerNames } from './queen-contributor-keys'
import { githubLoginOf, parseOwners } from './queen-leaderboard'

export interface LaneCredit {
  issue: number
  github: string
  /** When the credited turn was dispatched, ISO. */
  at: string
}

export interface IssueTurn {
  issue: number
  keyIndex: number
  dispatchedAt: Date
}

/** `dmitrii-f-t27=2026-09-17` -> { 'dmitrii-f-t27': Date }. Bad entries are skipped. */
export function parseOwnersSince(
  raw: string | undefined,
): Record<string, Date> {
  const since: Record<string, Date> = {}
  for (const entry of (raw ?? '').split(',')) {
    const at = entry.indexOf('=')
    if (at <= 0) continue
    const login = entry.slice(0, at).trim().replace(/^@/, '').toLowerCase()
    const day = entry.slice(at + 1).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    const date = new Date(`${day}T00:00:00Z`)
    if (login && !Number.isNaN(date.getTime())) since[login] = date
  }
  return since
}

/**
 * Pure: one credit per issue, from its latest turn, only when that
 * lane is claimed by a GitHub login and the turn is not older than the login's
 * start date. An issue last worked on an unclaimed lane is left out, not guessed.
 */
export function creditIssues(
  turns: IssueTurn[],
  owners: Record<number, string>,
  since: Record<string, Date>,
): LaneCredit[] {
  const latest = new Map<number, IssueTurn>()
  for (const turn of turns) {
    const seen = latest.get(turn.issue)
    if (!seen || turn.dispatchedAt > seen.dispatchedAt)
      latest.set(turn.issue, turn)
  }
  const credits: LaneCredit[] = []
  for (const turn of latest.values()) {
    const name = owners[turn.keyIndex]
    const github = name ? githubLoginOf(name) : undefined
    if (!github) continue
    const from = since[github.toLowerCase()]
    if (from && turn.dispatchedAt < from) continue
    credits.push({
      issue: turn.issue,
      github,
      at: turn.dispatchedAt.toISOString(),
    })
  }
  return credits.sort((a, b) => a.issue - b.issue)
}

export async function issueTurns(pool: Pool): Promise<IssueTurn[]> {
  const { rows } = await pool.query(
    `SELECT issue, key_index, dispatched_at
       FROM queen_dispatch
      WHERE key_index IS NOT NULL AND dispatched_at IS NOT NULL
     UNION ALL
     SELECT issue, (snapshot->>'key_index')::integer,
            (snapshot->>'dispatched_at')::timestamptz
       FROM queen_dispatch_history
      WHERE snapshot->>'key_index' ~ '^-?[0-9]+$'
        AND snapshot->>'dispatched_at' IS NOT NULL`,
  )
  return rows.map((row) => ({
    issue: Number(row.issue),
    keyIndex: Number(row.key_index),
    dispatchedAt: new Date(row.dispatched_at),
  }))
}

export async function laneCredits(
  pool: Pool,
): Promise<{ measuredAt: string; repo: string; credits: LaneCredit[] }> {
  const owners = {
    ...parseOwners(process.env.TRIOS_KEY_OWNERS),
    ...(await contributorOwnerNames(pool)),
  }
  return {
    measuredAt: new Date().toISOString(),
    repo: 'gHashTag/t27',
    credits: creditIssues(
      await issueTurns(pool),
      owners,
      parseOwnersSince(process.env.TRIOS_KEY_OWNERS_SINCE),
    ),
  }
}
