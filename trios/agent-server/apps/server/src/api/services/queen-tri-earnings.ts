/**
 * WHAT AN ACCEPTED SPEC HAS EARNED, WRITTEN DOWN ONCE.
 *
 * The owner, 2026-10-01: the people who write `.t27` specs should mine TRI for
 * the ones the Queen accepts, and later move it to a wallet. Nothing can be
 * minted from a number nobody wrote down, so this is the first half: an
 * append-only record of every accepted spec turn, the commit it was judged on,
 * and the lane that carried it. No token exists yet, so nothing here is
 * withdrawable, and the public answer says so in words.
 *
 * WHY A TABLE, WHEN THE LEADERBOARD DERIVES ITS SCORE ON EVERY READ.
 * The leaderboard counts turns; an earning is a claim somebody will later sign.
 * `queen_dispatch` is keyed by issue and overwritten on redispatch, and the
 * archive keeps a snapshot only when an attempt is overwritten - a CI take-back
 * edits the row in place. Derived on read, an acceptance that was later taken
 * back would simply stop existing, and the record would say it never happened.
 * Here it stays, with `revoked_at` beside it. Rows are inserted and revoked,
 * never deleted and never edited otherwise.
 *
 * ONE EARNING = ONE (repository, issue, judged commit). Its id is
 * sha256('t27-accept:v1|<repo>|<issue>|<commit>'), recomputable by anyone from
 * public data, which is what `work_id` in the mint protocol asks for: a hash of
 * the accepted work, not a bare counter (trinity-fpga,
 * specs/trinet/mint_on_acceptance.t27). The same commit accepted twice is one
 * earning; a new commit accepted after a send-back is a second one.
 *
 * WHAT COUNTS AS A SPEC, HONESTLY: an accepted turn whose declared boundary
 * (`owned_paths`) names a `.t27` file - the same rule the leaderboard's `specs`
 * uses. That is the claim, not the diff; the spec paths are stored so the
 * claim can be checked against the commit.
 *
 * WHAT REVOKES ONE: a later verdict on the SAME commit that is a send-back or
 * an escalation - which is what a CI take-back is (queen-ci-verdict.ts). A
 * revocation is final for that earning: a fresh accept of the same commit does
 * not resurrect it, because an earning that can flip back and forth is not one
 * anybody can sign.
 *
 * THE AMOUNT is the owner's decision O2 (trinity-fpga
 * docs/docs/depin/decisions.md), taken 2026-10-01: 27 TRI per accepted spec in
 * epoch 1. It is published here, beside the record, so a signer can refuse an
 * attestation whose amount differs from the one anybody can read.
 *
 * WHAT IS NOT HERE: whether the commit was merged. Decision O4 says an earning
 * mints only once its judged commit landed; that is checked on GitHub by each
 * signer independently, not asserted by this record, so a Queen that lied about
 * a merge would convince nobody.
 */
import type { Pool } from 'pg'

import { githubLoginOf, parseOwners } from './queen-leaderboard'

/** The scheme a work id is hashed under; bumped if the inputs ever change. */
export const EARNING_SCHEME = 't27-accept:v1'

/** O2, 2026-10-01: TRI one accepted spec earns in epoch 1. */
export const TRI_PER_SPEC = 27

/**
 * Record every accepted spec turn not yet recorded, then revoke the ones a
 * later verdict on the same commit refused. Idempotent: a second run inserts
 * and revokes nothing new. Returns how many of each this run did.
 *
 * `repo` is the repository the round supervises (TRIOS_GITHUB_REPO). An issue
 * number means nothing without it, and the round already refuses to run when
 * it is unset, so this never guesses one.
 *
 * (No backticks in the SQL below: it is a template literal.)
 */
export async function recordEarnings(
  pool: Pool,
  repo: string,
): Promise<{ recorded: number; revoked: number }> {
  const inserted = await pool.query(
    `WITH accepted AS (
       SELECT issue, judged_head, key_index, owned_paths, reviewed_at
         FROM queen_dispatch
        WHERE review_state = 'accept'
          AND judged_head IS NOT NULL AND key_index IS NOT NULL
       UNION ALL
       SELECT issue,
              snapshot->>'judged_head',
              (snapshot->>'key_index')::integer,
              coalesce(snapshot->'owned_paths', '[]'::jsonb),
              (snapshot->>'reviewed_at')::timestamptz
         FROM queen_dispatch_history
        WHERE snapshot->>'review_state' = 'accept'
          AND snapshot->>'judged_head' IS NOT NULL
          AND snapshot->>'key_index' ~ '^[0-9]+$'
     ),
     specs AS (
       SELECT a.issue, a.judged_head, a.key_index, a.reviewed_at,
              (SELECT coalesce(jsonb_agg(p.path ORDER BY p.path), '[]'::jsonb)
                 FROM jsonb_array_elements_text(a.owned_paths) AS p(path)
                WHERE p.path LIKE '%.t27') AS spec_paths
         FROM accepted a
     ),
     first_accept AS (
       -- One earning per commit: the earliest acceptance of it.
       SELECT DISTINCT ON (issue, judged_head)
              issue, judged_head, key_index, spec_paths, reviewed_at
         FROM specs
        WHERE jsonb_array_length(spec_paths) > 0
        ORDER BY issue, judged_head, reviewed_at ASC NULLS LAST
     )
     INSERT INTO queen_tri_earnings
       (work_id, repo, issue, judged_head, key_index, spec_paths, accepted_at)
     SELECT encode(sha256(convert_to(
              $2::text || '|' || $1::text || '|' || issue::text || '|' || judged_head,
              'UTF8')), 'hex'),
            $1::text, issue, judged_head, key_index, spec_paths,
            coalesce(reviewed_at, now())
       FROM first_accept
     ON CONFLICT (work_id) DO NOTHING`,
    [repo, EARNING_SCHEME],
  )

  // Only the verdict's STATE is kept as the reason. The note is worker text
  // and CI log lines, and this table is read by a public route.
  const revoked = await pool.query(
    `UPDATE queen_tri_earnings e
        SET revoked_at = now(),
            revoked_reason = 'a later verdict on the same commit: ' || r.state
       FROM (
         SELECT issue, judged_head, review_state AS state, reviewed_at
           FROM queen_dispatch
          WHERE review_state IN ('sendBack', 'escalate')
            AND judged_head IS NOT NULL
         UNION ALL
         SELECT issue,
                snapshot->>'judged_head',
                snapshot->>'review_state',
                (snapshot->>'reviewed_at')::timestamptz
           FROM queen_dispatch_history
          WHERE snapshot->>'review_state' IN ('sendBack', 'escalate')
            AND snapshot->>'judged_head' IS NOT NULL
       ) r
      WHERE e.revoked_at IS NULL
        AND e.repo = $1
        AND r.issue = e.issue
        AND r.judged_head = e.judged_head
        AND r.reviewed_at > e.accepted_at`,
    [repo],
  )

  return {
    recorded: inserted.rowCount ?? 0,
    revoked: revoked.rowCount ?? 0,
  }
}

export interface Earning {
  workId: string
  repo: string
  issue: number
  /** The commit the acceptance was about. */
  commit: string
  keyIndex: number
  /** The `.t27` files the turn's declared boundary named. */
  specPaths: string[]
  acceptedAt: string
  revokedAt: string | null
  revokedReason: string | null
}

export interface Earner {
  name: string
  claimed: boolean
  github?: string
  keys: number[]
  /** Earnings standing. */
  earned: number
  /** Earnings a later verdict took back; shown, never hidden. */
  revoked: number
}

/**
 * Gather earnings by lender, the same way the leaderboard gathers lanes: by
 * the operator's name for the lane (TRIOS_KEY_OWNERS), or `key #N` when nobody
 * claimed it. Pure, so the suite drives it directly.
 */
export function earnersOf(
  earnings: Earning[],
  owners: Record<number, string>,
): Earner[] {
  const byName = new Map<string, Earner>()
  for (const earning of earnings) {
    const claimed = Object.hasOwn(owners, earning.keyIndex)
    const name = claimed ? owners[earning.keyIndex] : `key #${earning.keyIndex}`
    const into: Earner = byName.get(name) ?? {
      name,
      claimed,
      ...(claimed ? { github: githubLoginOf(name) } : {}),
      keys: [],
      earned: 0,
      revoked: 0,
    }
    if (!into.keys.includes(earning.keyIndex)) {
      into.keys.push(earning.keyIndex)
      into.keys.sort((a, b) => a - b)
    }
    if (earning.revokedAt) into.revoked += 1
    else into.earned += 1
    byName.set(name, into)
  }
  return [...byName.values()].sort(
    (a, b) =>
      b.earned - a.earned ||
      b.revoked - a.revoked ||
      a.name.localeCompare(b.name),
  )
}

function toEarning(row: Record<string, unknown>): Earning {
  return {
    workId: String(row.work_id),
    repo: String(row.repo),
    issue: Number(row.issue),
    commit: String(row.judged_head),
    keyIndex: Number(row.key_index),
    specPaths: Array.isArray(row.spec_paths) ? row.spec_paths.map(String) : [],
    acceptedAt: new Date(row.accepted_at as string).toISOString(),
    revokedAt: row.revoked_at
      ? new Date(row.revoked_at as string).toISOString()
      : null,
    revokedReason: row.revoked_reason ? String(row.revoked_reason) : null,
  }
}

export async function readEarnings(pool: Pool): Promise<Earning[]> {
  const { rows } = await pool.query(
    `SELECT work_id, repo, issue, judged_head, key_index, spec_paths,
            accepted_at, revoked_at, revoked_reason
       FROM queen_tri_earnings
      ORDER BY accepted_at DESC, work_id`,
  )
  return rows.map(toEarning)
}

/** How many of the most recent earnings the public answer lists one by one. */
export const RECENT_EARNINGS = 100

export interface EarningsLedger {
  measuredAt: string
  scheme: string
  /**
   * In words, because a number on a page reads as money: a mint exists only on
   * TON testnet, behind a signer quorum, and is not trustless.
   */
  status: typeof EARNINGS_STATUS
  /** TRI per accepted spec (O2). */
  triPerSpec: typeof TRI_PER_SPEC
  rules: {
    counts: string
    revokes: string
    notYet: string[]
  }
  totals: { earned: number; revoked: number }
  earners: Earner[]
  recent: Earning[]
}

export const EARNINGS_STATUS =
  'recorded; mintable on TON testnet only -- V1, signer quorum, NOT trustless'

export async function earningsLedger(pool: Pool): Promise<EarningsLedger> {
  const all = await readEarnings(pool)
  const revoked = all.filter((e) => e.revokedAt).length
  return {
    measuredAt: new Date().toISOString(),
    scheme: EARNING_SCHEME,
    status: EARNINGS_STATUS,
    triPerSpec: TRI_PER_SPEC,
    rules: {
      counts:
        'one earning per (repository, issue, judged commit) the Queen accepted, ' +
        'when the turn declared a .t27 file in its boundary',
      revokes:
        'a later send-back or escalation of the same commit, such as a CI take-back',
      notYet: [
        'an earning mints only after its judged commit is part of a pull request merged ' +
          'into the default branch that changes a declared .t27 file; each signer checks ' +
          'that on GitHub, this record does not assert it',
        'spec paths are what the turn declared; the merge check above is what ties them to a diff',
        'no mainnet token exists',
      ],
    },
    totals: { earned: all.length - revoked, revoked },
    earners: earnersOf(all, parseOwners(process.env.TRIOS_KEY_OWNERS)),
    recent: all.slice(0, RECENT_EARNINGS),
  }
}

/**
 * One earning by its work id, and who it is credited to: what a signer reads
 * before it signs an attestation for that work id. Null when no such earning
 * was recorded.
 */
export interface EarningLookup {
  scheme: string
  status: typeof EARNINGS_STATUS
  triPerSpec: typeof TRI_PER_SPEC
  earning: Earning
  earner: Pick<Earner, 'name' | 'claimed' | 'github'>
}

export async function earningByWorkId(
  pool: Pool,
  workId: string,
  owners: Record<number, string>,
): Promise<EarningLookup | null> {
  const { rows } = await pool.query(
    `SELECT work_id, repo, issue, judged_head, key_index, spec_paths,
            accepted_at, revoked_at, revoked_reason
       FROM queen_tri_earnings
      WHERE work_id = $1`,
    [workId],
  )
  if (rows.length === 0) return null
  const earning = toEarning(rows[0])
  const [who] = earnersOf([earning], owners)
  return {
    scheme: EARNING_SCHEME,
    status: EARNINGS_STATUS,
    triPerSpec: TRI_PER_SPEC,
    earning,
    earner: {
      name: who.name,
      claimed: who.claimed,
      ...(who.github ? { github: who.github } : {}),
    },
  }
}
