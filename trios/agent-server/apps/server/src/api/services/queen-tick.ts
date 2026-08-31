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
  dispatchBee,
  reapDispatchesFromPreviousBoot,
  reapStalledDispatches,
} from './queen-dispatch'
import {
  acquireQueenLease,
  logLeaseOutcome,
  queenHolderName,
  queenLeaseDatabaseUrl,
  releaseQueenLease,
} from './queen-lease'

const LEASE_NAME = 'queen-tick'
const QUEEND = '/usr/local/bin/queend'
/// A task shaped for the policy needs an id; a dispatch that never opened a
/// conversation has none. All-zeroes is a UUID that decodes and can collide
/// with nothing real.
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

interface QueendChoice {
  allowed: boolean
  chosen?: number | null
  chosenPaths?: string[] | null
  refusal?: string | null
  skipped?: string[] | null
}

/**
 * The TTL is a LIVENESS window, not a work window. I had these confused.
 *
 * The first version reasoned "the TTL must outlive a round" and set it to three
 * times the tick interval - ninety minutes - renewing only when a round ran.
 * That is sound only if renewal and work are the same event, and it produced
 * exactly the failure it looks like it should: a deploy replaced the container,
 * the old holder died without releasing, and its lease went on holding the hive
 * for ninety minutes while the new one correctly stood down every round.
 *
 *   14:36:18 Queen tick starting          holder="f2375165-...:1"
 *   14:36:18 Queen lease held elsewhere    holder="9680f61f-...:1"
 *            self="f2375165-...:1" expiresAt="15:52:42"
 *
 * Nothing there is malfunctioning. The exclusion did its job; the lease was
 * simply describing a process that no longer existed.
 *
 * Separating the two fixes it. A heartbeat renews far more often than the tick
 * runs, so the TTL only has to outlive a couple of missed heartbeats - and a
 * holder that dies frees the hive in minutes rather than in whatever the work
 * interval happens to be. The round may then take as long as it likes.
 */
const LEASE_TTL_SECONDS = 180
const HEARTBEAT_SECONDS = 60

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
async function openIssues(
  repo: string,
): Promise<Array<{ number: number; body: string }>> {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&per_page=50`,
    { headers: { Accept: 'application/vnd.github+json' } },
  )
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
  const issues = (await response.json()) as Array<{
    number: number
    body?: string | null
    pull_request?: unknown
  }>
  // The issues endpoint returns pull requests too, and a PR is not work to
  // delegate - it is work already done waiting for a verdict.
  //
  // The BODY comes along, because the boundary lives in it. Fetching numbers
  // here and bodies later would be a second round trip per candidate against an
  // anonymous rate limit that is 60 an hour.
  return issues
    .filter((i) => !i.pull_request)
    .map((i) => ({ number: i.number, body: i.body ?? '' }))
}

/** One body per candidate, keyed as queend expects. */
async function bodiesFor(
  repo: string,
  numbers: number[],
): Promise<Record<string, string>> {
  const bodies: Record<string, string> = {}
  for (const number of numbers) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues/${number}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    )
    if (!response.ok) continue
    const issue = (await response.json()) as { body?: string | null }
    bodies[String(number)] = issue.body ?? ''
  }
  return bodies
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

export async function runQueenTickOnce(
  pool: Pool,
  candidateOverride?: number[],
): Promise<{
  ran: boolean
  reason?: string
  choice?: QueendChoice
  dispatch?: unknown
}> {
  const holder = queenHolderName()
  const grant = await acquireQueenLease(
    pool,
    LEASE_NAME,
    holder,
    LEASE_TTL_SECONDS,
  )
  logLeaseOutcome(grant, holder)
  if (!grant.acquired) return { ran: false, reason: `held by ${grant.holder}` }

  // Renew while the work runs. A round that outlives its TTL would finish as a
  // private citizen: still delegating, while a second supervisor legitimately
  // holds the lease and delegates too.
  heartbeat = setInterval(() => {
    acquireQueenLease(pool, LEASE_NAME, holder, LEASE_TTL_SECONDS).catch(
      () => {},
    )
  }, HEARTBEAT_SECONDS * 1000)
  try {
    return await runRound(pool, holder, grant.fence, candidateOverride)
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = undefined
    // Give it back even when the round threw. A round that fails still had its
    // turn; holding the lease through the failure would make one bad minute
    // cost the other supervisor its next three.
    await releaseQueenLease(pool, LEASE_NAME, holder).catch(() => {})
  }
}

/** The work of a round, with the lease already in hand. */
async function runRound(
  pool: Pool,
  holder: string,
  fence: number,
  candidateOverride?: number[],
): Promise<{
  ran: boolean
  reason?: string
  choice?: QueendChoice
  dispatch?: unknown
}> {
  const grant = { fence }

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
  // An override still goes through `queend`. The point of a diagnostic round is
  // to exercise the real decision on chosen inputs, not to bypass it - a probe
  // that skipped the policy would prove the probe.
  let candidates: number[]
  let candidateBodies: Record<string, string>
  if (candidateOverride) {
    candidates = candidateOverride
    candidateBodies = await bodiesFor(repo, candidateOverride)
  } else {
    const open = await openIssues(repo)
    candidates = open.map((i) => i.number)
    candidateBodies = Object.fromEntries(
      open.map((i) => [String(i.number), i.body]),
    )
  }
  // Reap before reading the board, not after.
  //
  // A dispatch that has stopped without saying so still holds its paths, so a
  // board read before the sweep is a board with phantom work on it - and the
  // round would skip a candidate on behalf of a bee that died in a redeploy an
  // hour ago. Same ordering the app's own review scheduler uses, for the same
  // reason: housekeeping first, then decide.
  const reaped = await reapStalledDispatches(pool)
  if (reaped.length > 0) {
    logger.info('Queen tick reaped stalled dispatches', { issues: reaped })
  }

  // The board the container decides against is the app's mirror PLUS this
  // container's own dispatches.
  //
  // The mirror is written by the app and knows nothing about what the tick
  // started. Without this the round would choose an issue, dispatch a bee, and
  // thirty minutes later find the same issue unclaimed and dispatch another -
  // forever, with each new bee cutting a branch over the last one's. The
  // symptom would have been a swarm that looks busy and a registry that never
  // grows.
  //
  // Shaped as tasks rather than handled specially, so BOTH guards apply: the
  // "a task already exists for it" check and the boundary conflict check. That
  // is why the boundary is stored at dispatch - a task holding no paths holds
  // nothing against anyone.
  const inFlight = await pool.query(
    `SELECT issue, branch, owned_paths, conversation_id, dispatched_at, key_index
       FROM queen_dispatch
      WHERE started = true
        AND finished_at IS NULL
        AND dispatched_at > now() - interval '24 hours'`,
  )
  const [owner, repoName] = repo.split('/')
  // Seconds, no fraction.
  //
  // Postgres hands back a JS Date and JSON.stringify writes it with
  // milliseconds - "2026-08-29T16:13:06.821Z". Swift's `.iso8601` decoding
  // strategy does not accept a fractional second, so `queend` refused the whole
  // question the moment there was anything in flight to report:
  //
  //   codingPath: ["tasks", "Index 67"]
  //   "Expected date string to be ISO8601-formatted."
  //
  // Index 67 is the first of MINE, after the registry's own sixty-seven - which
  // is what made it obvious. The app's tasks encode without the fraction
  // because Swift wrote them; mine have to match that, not merely be valid
  // ISO 8601.
  const isoSeconds = (value: unknown): string =>
    new Date(value as string).toISOString().replace(/\.\d{3}Z$/, 'Z')
  // EVERY non-optional field of DelegatedTask, not the ones that seemed
  // interesting.
  //
  // Swift's synthesised Codable refuses the whole document for one missing
  // key, and `queend` reports which - so this was found the honest way, one
  // refusal at a time, until the list was read properly:
  //
  //   codingPath: ["tasks", "Index 67"]  "Expected date string to be ISO8601"
  //   keyNotFound("acceptanceCriteria")
  //
  // Index 67 is the first of MINE, after the registry's own sixty-seven. The
  // lesson is not "add acceptanceCriteria": it is that a hand-built record
  // standing in for a real type must be built from the type's field list, not
  // from what the author remembers of it.
  const containerTasks = inFlight.rows.map((row) => ({
    id: row.conversation_id ?? ZERO_UUID,
    conversationId: row.conversation_id ?? ZERO_UUID,
    issue: { owner, repo: repoName, number: row.issue },
    title: 'dispatched by the cloud tick',
    worker: 'cloud-tick',
    state: 'running',
    ownedPaths: row.owned_paths ?? [],
    virtualBranch: row.branch,
    createdAt: isoSeconds(row.dispatched_at),
    updatedAt: isoSeconds(row.dispatched_at),
    // Empty, and empty is the truthful value: the cloud tick does not yet read
    // acceptance criteria out of the issue, so claiming any here would be
    // inventing a contract the bee was never given.
    acceptanceCriteria: [],
    interventions: [],
    criterionVerdicts: {},
  }))

  const choice = await askQueend({
    kind: 'choose',
    candidates,
    candidateBodies,
    tasks: [...registry.rows[0].tasks, ...containerTasks],
  })

  await recordTick(pool, holder, grant.fence, choice)
  logger.info('Queen tick decided', {
    chosen: choice.chosen ?? null,
    refusal: choice.refusal ?? null,
    candidates: candidates.length,
  })

  // And then start it. A supervisor that only chooses is a supervisor in name:
  // the choice was the visible half of the round, and for several deploys it
  // was the only half, which reads in a log exactly like a working loop.
  if (choice.allowed && typeof choice.chosen === 'number') {
    // Which keys the bees already in flight are holding. Passed in rather than
    // derived inside dispatch, because the in-flight set is the round's own
    // view of the board and deriving it twice is how two views disagree.
    const takenKeys = inFlight.rows
      .map((r) => r.key_index)
      .filter((i): i is number => typeof i === 'number')
    const dispatch = await dispatchBee(
      pool,
      choice.chosen,
      briefFor(
        choice.chosen,
        repo,
        choice.chosenPaths ?? [],
        candidateBodies[String(choice.chosen)] ?? '',
      ),
      choice.chosenPaths ?? [],
      takenKeys,
    )
    return { ran: true, choice, dispatch }
  }
  return { ran: true, choice }
}

/**
 * What the bee is told, and what it is told NOT to do.
 *
 * The push prohibition is not caution, it is the shape of the deployment: this
 * container holds no push credential by design, so a bee that tries will fail
 * confusingly, and one that believes it succeeded is worse. Work leaves here as
 * a patch the Mac replays - proven end to end - and the bee's job ends at a
 * commit on its own branch.
 */
function briefFor(
  issue: number,
  repo: string,
  ownedPaths: string[],
  issueBody: string,
): string {
  // The boundary, in the words the Mac uses.
  //
  // It was computed FOR this bee - `queend` parsed it out of the issue and
  // refused three other candidates on the strength of it - and then was the one
  // thing the bee itself was never told. A rule enforced against everyone
  // except the party it constrains is not a rule, it is a trap.
  const boundary =
    ownedPaths.length > 0
      ? 'You may create or edit files under these paths and nowhere else: ' +
        ownedPaths.join(', ') +
        '. Work outside them is dropped rather than reviewed.'
      : 'No paths were assigned to you. Say so in this chat before editing ' +
        'anything, rather than guessing at a boundary nobody set.'

  // The issue text, inlined, because the bee cannot go and get it.
  //
  // The old brief opened with "Read the issue first" - an instruction this
  // container makes impossible. The image installs git, ca-certificates and
  // openssh-client and no `gh`; the agent shell's environment is scrubbed to a
  // ten-entry allowlist with GITHUB_TOKEN deliberately excluded. So the bee's
  // first instruction could never be followed, and the only description of the
  // task it actually received was the number. Meanwhile the tick had already
  // fetched every candidate's body to decide with - it was one variable away.
  const body = issueBody.trim()
  const description = body
    ? ['## The issue, in full', '', body].join('\n')
    : '## The issue\n\nIts body could not be read. Say so rather than guessing ' +
      'at what it wanted.'

  return [
    `# ${repo}#${issue}`,
    '',
    description,
    '',
    '## Boundary',
    '',
    boundary,
    `Your branch is queen-${issue} and this worktree is yours alone - no other`,
    'worker and no build reads or writes it while you have it.',
    '',
    '## Verification',
    '',
    'When you stop, answer every acceptance criterion the issue states in turn:',
    'met, not met, or could not check. Do not summarise and do not shorten this',
    'part - an unchecked criterion is not a pass, and saying so plainly costs',
    'you nothing.',
    '',
    '## Out of scope',
    '',
    'Anything the issue does not ask for. Work that seems obviously needed and',
    'is not asked for is a thing to raise here, not to do quietly.',
    '',
    '## Finishing',
    '',
    'Everything you write is English - source, comments, documentation, commit',
    'messages. Finish with a commit on your branch. Do NOT push: this machine',
    'holds no push credential by design, and the work is carried out as a patch',
    'by the operator. A failed push reads as a failed task; a commit is the',
    'deliverable.',
  ].join('\n')
}

/**
 * Who the bee is, sent in the field the server actually reads.
 *
 * Separate from the briefing because they are different things: the brief is
 * the task, this is the standing identity that should hold across every turn of
 * it. The Mac composes an equivalent and - until today - threw it away on the
 * wire, so neither side has ever had one arrive.
 */
export function workerSystemPrompt(
  issue: number,
  repo: string,
  workingDirectory: string,
  ownedPaths: string[],
): string {
  const lines = [
    `You are a Trinity worker bee, supervised by the Queen. You work on exactly one issue: ${repo}#${issue}.`,
    `Your repository is ${workingDirectory}. Work only inside it: other checkouts of this project exist on this machine, and editing one of those puts your work where nobody looks for it.`,
    'This checkout is yours alone. Do the work yourself: do not delegate and do not open other chats.',
  ]
  if (ownedPaths.length > 0) {
    lines.push(
      `You may create or edit files under these paths and nowhere else: ${ownedPaths.join(', ')}. Work outside them is dropped rather than reviewed.`,
    )
  }
  lines.push(
    'Everything you write is English. When you stop, answer every acceptance criterion in turn: met, not met, or could not check.',
  )
  return lines.join(' ')
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
let heartbeat: ReturnType<typeof setInterval> | undefined

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

  // Clear the previous container's phantoms before the first round reads the
  // board. A row still in flight belongs to a process that died with the
  // deployment it ran in, and it holds its boundary against real work until
  // somebody notices.
  reapDispatchesFromPreviousBoot(pool)
    .then((issues) => {
      if (issues.length > 0) {
        logger.info('Queen tick reaped dispatches from a previous boot', {
          issues,
        })
      }
    })
    .catch(() => {})

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
    if (heartbeat) clearInterval(heartbeat)
    releaseQueenLease(pool, LEASE_NAME, queenHolderName()).catch(() => {})
  }
  process.once('SIGTERM', handover)
  process.once('SIGINT', handover)
}
