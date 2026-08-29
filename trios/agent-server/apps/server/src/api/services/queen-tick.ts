/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The supervision round, running where there is no laptop.
 *
 * Everything this loop needs was moved into the container one piece at a time:
 * the checkout, the tools, the git credentials, the registry, and finally the
 * policy itself as a Linux binary. What stayed behind was the thing that wakes
 * up - so the whole apparatus was cloud-resident and still could not start a
 * round unless a Mac was awake to tell it to. This is that last piece.
 *
 * A round is: hold the lease, read the registry, ask GitHub what is open, let
 * `queend` decide, and write down what was decided. The deciding is deliberately
 * not here. It is in `queend`, compiled from the same eleven Swift files the Mac
 * app uses, because a second implementation of "which bee starts next" written
 * in TypeScript would be a second policy - agreeing at first, drifting later,
 * and impossible to tell apart from the first when they disagree.
 *
 * WHAT THIS LOOP DOES NOT DO: start the bee. Choosing and dispatching are
 * separate on purpose and this is the honest boundary of the migration today.
 * The container can cut a worktree and run a worker - that is proven - but the
 * dispatch path is still driven from the app. Recording the choice makes the
 * gap visible rather than hiding it behind a loop that appears to run.
 */

import { spawn } from 'node:child_process'
import { Pool } from 'pg'
import { logger } from '../../lib/logger'
import {
  acquireQueenLease,
  logLeaseOutcome,
  queenHolderName,
  queenLeaseDatabaseUrl,
  releaseQueenLease,
} from './queen-lease'

const LEASE_NAME = 'queen-tick'
const QUEEND = '/usr/local/bin/queend'

interface QueendChoice {
  allowed: boolean
  chosen?: number | null
  refusal?: string | null
  skipped?: string[] | null
}

/**
 * The lease TTL must outlive a round, or the holder loses it mid-work.
 *
 * Three times the interval: one round to run, and two missed renewals before
 * anyone else may take over. Shorter and a slow GitHub call hands the hive to a
 * second Queen while the first is still deciding.
 */
function leaseTtlSeconds(intervalSeconds: number): number {
  return Math.max(intervalSeconds * 3, 60)
}

function tickIntervalSeconds(): number {
  const raw = Number(process.env.TRIOS_QUEEN_TICK_SECONDS ?? '0')
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/**
 * Open issues, read without a credential.
 *
 * Anonymous on purpose: the repository is public, this is a read, and a token
 * here would be a credential in a container for no gain. GitHub's anonymous
 * rate limit is 60/hour against a loop that ticks at most a few times an hour.
 */
async function openIssueNumbers(repo: string): Promise<number[]> {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&per_page=50`,
    { headers: { Accept: 'application/vnd.github+json' } },
  )
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
  const issues = (await response.json()) as Array<{
    number: number
    pull_request?: unknown
  }>
  // The issues endpoint returns pull requests too, and a PR is not work to
  // delegate - it is work already done waiting for a verdict.
  return issues.filter((i) => !i.pull_request).map((i) => i.number)
}

/**
 * Hand the decision to the Queen's own policy binary.
 *
 * Rejects rather than defaulting when queend is missing or fails. A tick that
 * silently substitutes its own judgement for the policy's is worse than a tick
 * that stops: the first produces decisions nobody can trace to a rule.
 */
function askQueend(question: unknown): Promise<QueendChoice> {
  return new Promise((resolve, reject) => {
    const child = spawn(QUEEND, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`queend exited ${code}: ${err.trim() || out.trim()}`))
        return
      }
      try {
        resolve(JSON.parse(out) as QueendChoice)
      } catch {
        reject(
          new Error(`queend returned unparseable output: ${out.slice(0, 200)}`),
        )
      }
    })
    child.stdin.end(JSON.stringify(question))
  })
}

export async function runQueenTickOnce(pool: Pool): Promise<{
  ran: boolean
  reason?: string
  choice?: QueendChoice
}> {
  const holder = queenHolderName()
  const interval = tickIntervalSeconds() || 1800
  const grant = await acquireQueenLease(
    pool,
    LEASE_NAME,
    holder,
    leaseTtlSeconds(interval),
  )
  logLeaseOutcome(grant, holder)
  if (!grant.acquired) return { ran: false, reason: `held by ${grant.holder}` }

  const registry = await pool.query(
    'SELECT tasks FROM queen_registry WHERE variant = $1',
    [process.env.TRIOS_VARIANT || 'prod'],
  )
  if (!registry.rowCount) {
    // No mirror means no idea what the swarm is doing. Choosing anyway would be
    // choosing against an empty board, which reads as "nothing is running" and
    // starts a bee on an issue that already has one.
    await recordTick(pool, holder, grant.fence, {
      skipped: ['no registry mirror published yet'],
      allowed: false,
    })
    return { ran: true, reason: 'no registry mirror' }
  }

  const repo = process.env.TRIOS_GITHUB_REPO || 'gHashTag/BrowserOS'
  const candidates = await openIssueNumbers(repo)
  const choice = await askQueend({
    kind: 'choose',
    candidates,
    tasks: registry.rows[0].tasks,
  })

  await recordTick(pool, holder, grant.fence, choice)
  logger.info('Queen tick decided', {
    chosen: choice.chosen ?? null,
    refusal: choice.refusal ?? null,
    candidates: candidates.length,
  })
  return { ran: true, choice }
}

/**
 * The tick's own record, fenced.
 *
 * `fence >= excluded.fence` is what makes a stalled holder harmless: it wakes,
 * writes its decision from a term that has ended, and the row refuses it because
 * a later term has already written. Without this the last writer wins, and the
 * last writer is exactly the process that was too slow to still be the Queen.
 */
async function recordTick(
  pool: Pool,
  holder: string,
  fence: number,
  choice: QueendChoice,
): Promise<void> {
  await pool.query(
    `INSERT INTO queen_tick (name, holder, fence, decided_at, decision)
     VALUES ($1, $2, $3, now(), $4::jsonb)
     ON CONFLICT (name) DO UPDATE
       SET holder = EXCLUDED.holder,
           fence = EXCLUDED.fence,
           decided_at = EXCLUDED.decided_at,
           decision = EXCLUDED.decision
       WHERE queen_tick.fence <= EXCLUDED.fence`,
    [LEASE_NAME, holder, fence, JSON.stringify(choice)],
  )
}

let timer: ReturnType<typeof setInterval> | undefined

/**
 * Start the loop, or explain why not.
 *
 * Off unless `TRIOS_QUEEN_TICK_SECONDS` is set, so that running the server
 * locally - for a test, for development, on a laptop alongside the app - does
 * not quietly enrol a second Queen. Enabling it is a deployment decision, made
 * once, on the deployment that is meant to hold the hive.
 */
export function startQueenTick(): void {
  const interval = tickIntervalSeconds()
  if (!interval) return
  const url = queenLeaseDatabaseUrl()
  if (!url) {
    logger.warn('Queen tick requested but no database is configured')
    return
  }

  const pool = new Pool({ connectionString: url })
  logger.info('Queen tick starting', {
    intervalSeconds: interval,
    holder: queenHolderName(),
  })

  const round = () => {
    runQueenTickOnce(pool).catch((error) => {
      // A failed round must not kill the loop. The next one may well succeed -
      // GitHub rate limits reset, a database blips - and a supervisor that stops
      // supervising on its first bad minute is worse than no supervisor, because
      // the app still reports one as running.
      logger.warn('Queen tick round failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  round()
  timer = setInterval(round, interval * 1000)

  const handover = () => {
    if (timer) clearInterval(timer)
    releaseQueenLease(pool, LEASE_NAME, queenHolderName()).catch(() => {})
  }
  process.once('SIGTERM', handover)
  process.once('SIGINT', handover)
}
