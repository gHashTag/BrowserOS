/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The board, as columns a person reads left to right.
 *
 * The technology tree answers "what is this project made of". This answers the
 * question an operator actually opens a page for: what is being worked on, what
 * is stuck, and on whom. Same data, different question - and the tree was the
 * wrong shape for it, which is fair comment.
 *
 * THE COLUMNS ARE THE QUEEN'S OWN STATES, not invented ones. A board whose
 * columns do not exist in the system it describes teaches its reader a
 * vocabulary the logs will not use.
 *
 *   backlog     an open issue with a declared boundary and no task
 *   blocked     an open issue whose boundary is held by somebody else
 *   running     a dispatch in flight, or a registry task marked running
 *   review      awaitingReview - which is NOT terminal, and holds its boundary
 *   done        accepted or merged
 *   dropped     failed or cancelled
 *
 * Every card links to its GitHub issue, because a board you cannot click
 * through from is a screenshot.
 *
 * WHY THE SHELL IS OPEN AND THE DATA IS NOT.
 *
 * The first version served the whole board unguarded, on the reasoning that
 * issue titles are public. They are; the rest is not. Measured from outside
 * with no credential: 57 cards, every registry state, "held by #1174", and the
 * bees' own details down to `zai/glm-5.3` and their worktree paths. That is the
 * swarm's operating state, and it was the THIRD route in this deployment I
 * mounted without the guard its neighbours carry.
 *
 * So it follows the dashboard's shape instead: this route returns markup with
 * no state in it, and `/queen/board` returns the cards behind the same bearer
 * check as everything else. The token lives in sessionStorage and travels in an
 * Authorization header - never in the URL, which is the one place it must not
 * go.
 *
 * NO ISSUE IS INVENTED. A card appears only for a number that GitHub showed the
 * tick or that the registry already carries. An issue with no boundary section
 * is shown as such rather than hidden: the Queen cannot delegate it, and that is
 * a fact about the issue worth seeing rather than an empty space.
 */

import { Hono } from 'hono'
import { Pool } from 'pg'
import { queenLeaseDatabaseUrl } from '../services/queen-lease'

interface Card {
  number: number
  title: string
  column: string
  paths: string[]
  detail?: string
  worker?: string
  heldBy?: string[]
  /** The last round's own words for why it passed this candidate over. */
  whyNotChosen?: string
  /** How many acceptance criteria this issue offers, and where they came from. */
  criteria?: number
  criteriaSource?: string
  /** Spec sections the issue still lacks. */
  needs?: string[]
}

const COLUMNS = [
  {
    key: 'backlog',
    title: 'backlog',
    blurb: 'declared a boundary, nobody on it',
  },
  { key: 'blocked', title: 'blocked', blurb: 'its files are held' },
  { key: 'running', title: 'running', blurb: 'a bee has it now' },
  {
    key: 'review',
    title: 'in review',
    blurb: 'holds its boundary until judged',
  },
  { key: 'done', title: 'done', blurb: 'accepted or merged' },
  { key: 'dropped', title: 'dropped', blurb: 'failed or cancelled' },
]

function columnFor(state: string): string {
  switch (state) {
    case 'running':
    case 'queued':
      return 'running'
    case 'awaitingReview':
    case 'rejected':
      return 'review'
    case 'accepted':
    case 'merged':
      return 'done'
    default:
      return 'dropped'
  }
}

/**
 * How far along the pipeline a column is, for collapsing several tasks on one
 * issue into one card.
 *
 * This is NOT the left-to-right order. COLUMNS is serialized to the client and
 * consumed as the render order, so ranking by index into it put `dropped`
 * (last, therefore highest) above `done` - and an issue whose attempts were
 * [accepted, cancelled] was drawn as dropped.
 *
 * The rule it mirrors is `QueenDelegationPolicy.claimOnIssue`
 * (rings/SR-00/QueenDelegation.swift:505-520): live beats done beats dead,
 * whatever order the registry lists them in. Verified against the shipped
 * binary - on [accepted, cancelled] and on [cancelled, accepted] alike, queend
 * answers "the work already landed (accepted)".
 *
 * `running` and `review` share a rank because `claimOnIssue` folds all four
 * non-terminal states into one `.live` and takes the first: a tie must leave
 * the earlier card standing, not promote the later one.
 */
function pipelineRank(column: string): number {
  switch (column) {
    case 'dropped':
      return 0
    case 'done':
      return 1
    default:
      // running and review. backlog and blocked never reach here - no registry
      // task produces them - and they are live for the same reason.
      return 2
  }
}

/**
 * How long a task awaiting a verdict keeps its file boundary.
 *
 * Mirrors `QueenDelegationPolicy.reviewBoundaryHoldHours`
 * (rings/SR-00/QueenDelegation.swift:618). The number is checked against the
 * Swift source by queen-board.test.ts, because the failure mode when these
 * drift is silent: the board says BLOCKED and names a holder while the Queen
 * has already released the hold and will start a bee on it at the next tick.
 */
const REVIEW_BOUNDARY_HOLD_HOURS = 48

/**
 * Whether this task's boundary should still exclude other work.
 *
 * Mirrors `QueenDelegationPolicy.stillHoldsBoundary`
 * (rings/SR-00/QueenDelegation.swift:626-634): terminal never holds, only
 * `awaitingReview` ages out, and `queued`, `running` and `rejected` hold for
 * ever because a bee may be writing right now or is expected back.
 */
function stillHoldsBoundary(task: RegistryTask, now: number): boolean {
  const state = task.state
  if (state === 'queued' || state === 'running' || state === 'rejected') {
    return true
  }
  if (state !== 'awaitingReview') return false
  const updated = Date.parse(task.updatedAt ?? '')
  // A timestamp that will not parse is not evidence the hold expired. Reading
  // NaN as "released" would free every boundary the moment the field changed
  // shape, which is the loud failure pretending to be a quiet one.
  if (Number.isNaN(updated)) return true
  return (now - updated) / 3.6e6 < REVIEW_BOUNDARY_HOLD_HOURS
}

/**
 * A boundary path reduced to its comparable form.
 *
 * Mirrors `QueenBoundaryPaths.normalize`
 * (rings/SR-00/QueenBoundaryPaths.swift:36-41), including its deliberate
 * silence about a TRAILING slash - `rings/SR-00/` is left alone and the prefix
 * test below is what catches it.
 */
function normalizeBoundaryPath(path: string): string {
  let value = path.trim()
  while (value.startsWith('./')) value = value.slice(2)
  while (value.startsWith('/')) value = value.slice(1)
  return value
}

/**
 * Whether two boundaries can reach the same file.
 *
 * Mirrors `QueenDelegationPolicy.pathsOverlap`
 * (rings/SR-00/QueenDelegation.swift:577-583). The board used array membership,
 * which is string equality, so the ordinary containment case - one task owning
 * `rings/SR-00` and an issue claiming `rings/SR-00/Foo.swift` - was drawn in
 * BACKLOG as free work that the Queen would have refused. Measured against the
 * shipped binary: queend answers `rings/SR-00/Foo.swift held by ...#1286`, and
 * so does `./rings/SR-00` and `rings/SR-00/`.
 *
 * Compared by path COMPONENT, so `docs` and `docsite` stay disjoint - that
 * distinction is the point of the Swift comment at :571-574.
 */
function pathsOverlap(first: string, second: string): boolean {
  const a = normalizeBoundaryPath(first)
  const b = normalizeBoundaryPath(second)
  if (a === '' || b === '') return false
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/**
 * Which column a container dispatch belongs in.
 *
 * `row.finished_at ? 'review' : 'running'` was the whole rule, so no cloud work
 * could ever reach `done` and the Queen's own verdict appeared on no surface at
 * all: `review_state` is written by queen-tick.ts:942 and was read by no route.
 * The page could show that turns finish and never that any of them landed.
 *
 * The values are `QueenReviewDecision.Verdict`
 * (rings/SR-00/QueenReviewDecision.swift:26-32). A reaped row cannot appear
 * here - the query excludes it, and its issue is released back to BACKLOG,
 * which is what the Queen does with it too.
 */
function dispatchColumn(row: Record<string, unknown>): string {
  const verdict = row.review_state == null ? '' : String(row.review_state)
  if (verdict === 'accept') return 'done'
  if (verdict !== '') return 'review'
  return row.finished_at ? 'review' : 'running'
}

/** What the dispatch card says under its title. */
function dispatchDetail(row: Record<string, unknown>): string {
  const said = String(row.detail ?? '')
  const verdict = row.review_state == null ? '' : String(row.review_state)
  if (verdict !== '') {
    const note = String(row.review_note ?? '').slice(0, 88)
    return `the Queen judged this ${verdict}${note ? ` - ${note}` : ''}`
  }
  if (row.finished_at) {
    return `turn finished, waiting for a verdict - ${said.slice(0, 88)}`
  }
  return said.slice(0, 140)
}

/**
 * A jsonb column read as a list of paths, or nothing.
 *
 * `owned_paths` is jsonb and jsonb holds whatever was put in it - a string, a
 * number, an object. Asserting it into `string[]` would move the failure from
 * here to the first `.some()` call, one function away from the row that was
 * wrong. Same discipline as `asRecord` in task-queue-service, for the same
 * reason.
 */
function asPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

/**
 * What the last round said about each candidate it passed over.
 *
 * `queend` writes one line per skipped issue and the round stores the whole
 * decision. Reading it back is strictly better than the board guessing: the
 * board can see that an issue has a boundary and is not being worked, and it
 * cannot see WHY - whether its files are held, whether it is not a spec, or
 * whether the work already landed and nobody closed the issue.
 */
function addLastRoundReasons(
  cards: Map<number, Card>,
  decision: unknown,
): void {
  const skipped = (decision as { skipped?: unknown })?.skipped
  if (!Array.isArray(skipped)) return
  for (const entry of skipped) {
    const line = String(entry)
    const match = line.match(/^#(\d+):\s*(.+)$/)
    if (!match) continue
    const card = cards.get(Number(match[1]))
    if (!card) continue
    // Several lines can name one issue - not a spec AND its files are held.
    // Both are true and both matter, so they are joined rather than raced.
    card.whyNotChosen = card.whyNotChosen
      ? `${card.whyNotChosen}; ${match[2]}`
      : match[2]
  }
}

/**
 * How judgeable an issue is, for the card.
 *
 * A card that shows only a title cannot answer the question the operator keeps
 * asking - why is nothing happening to this. "0 criteria" and "missing
 * boundary, requirements" answer it in the issue's own terms, and both are
 * already computed by the round.
 */
function addCriteria(
  cards: Map<number, Card>,
  issueRows: Array<Record<string, unknown>>,
): void {
  // ONE pass over every card, not a spread at each of the three places a card
  // is created. The first version applied it only where a card is built from an
  // untaken issue, so 2 of 57 cards carried criteria - and the 16 issues that
  // DO state them mostly have a registry task, which is a different branch.
  // Three creation sites and a rule applied at one of them is the same shape as
  // the two board-record builders that took the round down this morning.
  for (const row of issueRows) {
    const card = cards.get(row.number as number)
    if (!card) continue
    const needs = Array.isArray(row.missing)
      ? row.missing.filter((m): m is string => typeof m === 'string')
      : []
    card.criteria = Array.isArray(row.criteria) ? row.criteria.length : 0
    card.criteriaSource = String(row.criteria_source ?? 'none')
    card.needs = needs.length > 0 ? needs : undefined
  }
}

interface RegistryTask {
  issue?: { owner?: string; repo?: string; number?: number }
  title?: string
  state?: string
  worker?: string
  ownedPaths?: string[]
  /**
   * When the task last changed, ISO-8601, as `DelegatedTask.updatedAt` writes
   * it. Read because a boundary hold has a clock on it - see
   * `stillHoldsBoundary` above - and this function had no way to see one.
   */
  updatedAt?: string
}

/** Everything the board is built from, so it can be built without a database. */
export interface BoardInput {
  tasks: RegistryTask[]
  dispatches: Array<Record<string, unknown>>
  issues: Array<Record<string, unknown>>
  decision?: unknown
  /** Milliseconds, for the 48-hour boundary ageout. Defaults to now. */
  now?: number
}

async function build(pool: Pool): Promise<{ cards: Card[]; pulse: Pulse }> {
  const variant = process.env.TRIOS_VARIANT || 'prod'
  const [registry, dispatches, issues, lastTick, day] = await Promise.all([
    pool.query('SELECT tasks FROM queen_registry WHERE variant = $1', [
      variant,
    ]),
    // The SAME set the round decides against, bound the same way. The tick has
    // carried `AND dispatched_at > now() - interval '7 days'` since it learned
    // to stop counting ancient rows (queen-tick.ts); the board had no age bound
    // at all, so a week-old dispatch was still shown holding an issue in review
    // that the Queen had already stopped seeing. Two surfaces, one table, two
    // different sets is the shape of every disagreement on this page.
    pool.query(
      // owned_paths and dispatched_at are read because composeCards uses them:
      // a cloud dispatch HOLDS the files it was given, and the 48-hour review
      // clock starts when it finished. Selecting neither is how the holder list
      // came to hold nothing - the query and its reader disagreed, and the only
      // place that showed was a headline claiming an issue was ready while the
      // Queen's own sentence underneath said there was nothing to choose.
      `SELECT issue, branch, started, detail, finished_at, outcome,
              review_state, review_note, owned_paths, dispatched_at
         FROM queen_dispatch
        WHERE started = true
          AND (finished_at IS NULL OR outcome NOT LIKE 'reaped%')
          AND dispatched_at > now() - interval '7 days'`,
    ),
    pool.query(
      `SELECT number, title, owned_paths, criteria, criteria_source, missing
         FROM queen_issues`,
    ),
    // The reason the LAST round gave for passing over each candidate, per
    // issue. The round already works this out and writes it down; the board was
    // recomputing a thinner version of the same thing and could only ever say
    // "blocked". "held by #1176" and "not yet a spec - missing requirements"
    // are different problems with different fixes, and a person looking at this
    // page has no other way to tell them apart.
    pool.query(
      `SELECT decision, decided_at FROM queen_tick ORDER BY decided_at DESC LIMIT 1`,
    ),
    // The last day, in five numbers. A board that shows only the present cannot
    // answer "is she working at all" - the honest answer to which is a count of
    // rounds, not a spinner.
    pool.query(
      `SELECT
         (SELECT count(*) FROM queen_tick
           WHERE decided_at > now() - interval '24 hours') AS rounds,
         (SELECT count(*) FROM queen_dispatch
           WHERE started AND dispatched_at > now() - interval '24 hours') AS bees,
         (SELECT count(*) FROM queen_dispatch
           WHERE reviewed_at > now() - interval '24 hours') AS verdicts,
         (SELECT coalesce(sum(input_tokens), 0) FROM queen_dispatch
           WHERE dispatched_at > now() - interval '24 hours') AS input_tokens,
         (SELECT coalesce(sum(output_tokens), 0) FROM queen_dispatch
           WHERE dispatched_at > now() - interval '24 hours') AS output_tokens`,
    ),
  ])

  const counts = day.rows[0] ?? {}
  return {
    cards: composeCards({
      tasks: registry.rowCount
        ? (registry.rows[0].tasks as RegistryTask[])
        : [],
      dispatches: dispatches.rows,
      issues: issues.rows,
      decision: lastTick.rows[0]?.decision,
    }),
    pulse: {
      rounds: Number(counts.rounds ?? 0),
      bees: Number(counts.bees ?? 0),
      verdicts: Number(counts.verdicts ?? 0),
      inputTokens: Number(counts.input_tokens ?? 0),
      outputTokens: Number(counts.output_tokens ?? 0),
      lastRoundAt: lastTick.rows[0]?.decided_at
        ? new Date(lastTick.rows[0].decided_at).toISOString()
        : null,
      lastRefusal:
        (lastTick.rows[0]?.decision as { refusal?: string } | undefined)
          ?.refusal ?? null,
      roundSeconds: Number(process.env.TRIOS_QUEEN_TICK_SECONDS ?? '0') || null,
      workerKeys: providerKeyCount(),
      workerLimit: 4,
    },
  }
}

/**
 * The swarm's last day, and the one number that caps it.
 *
 * WHY A KEY COUNT IS ON A BOARD. The operator's question, asked in those
 * words, was "what is she doing - I do not understand". The board could show
 * that nothing was running and could not show WHY, and the why is usually not
 * on the board at all: with one provider key the swarm's ceiling is one bee,
 * whatever the policy's limit of four says. A page that shows 0 of 4 and does
 * not mention the key is inviting the reader to look for a bug that is not
 * there.
 */
export interface Pulse {
  rounds: number
  bees: number
  verdicts: number
  inputTokens: number
  outputTokens: number
  lastRoundAt: string | null
  /** The Queen's own sentence for why the last round started nobody. */
  lastRefusal: string | null
  roundSeconds: number | null
  workerKeys: number
  workerLimit: number
}

/**
 * How many provider keys this deployment holds. The COUNT, never a value.
 *
 * An empty string is not a key. A platform variable saved with an empty box
 * leaves the name behind, and counting the name would report a swarm that can
 * run four bees while three of them have nothing to authenticate with - the
 * same trap this repository's config file has been sitting in for months.
 */
export function providerKeyCount(
  env: Record<string, string | undefined> = process.env,
): number {
  const names = [
    'ZAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'MOONSHOT_API_KEY',
    'OPENAI_API_KEY',
  ]
  let found = 0
  for (const name of names) {
    if ((env[name] ?? '').length > 0) found++
    for (let i = 2; i <= 16; i++) {
      if ((env[name + '_' + i] ?? '').length > 0) found++
    }
  }
  return found
}

/**
 * The board, from rows rather than from a pool.
 *
 * Split out so the rules on this page - containment, the 48-hour hold, and
 * which of several tasks describes an issue - can be driven against the real
 * `queend` binary in a test. Every one of the three used to disagree with the
 * policy it claimed to mirror, and none of that was reachable without a
 * database.
 */
export function composeCards(input: BoardInput): Card[] {
  const now = input.now ?? Date.now()
  const cards = new Map<number, Card>()
  addRegistryTasks(cards, input.tasks)
  addInFlight(cards, input.dispatches, input.issues)
  addUntakenIssues(cards, input.issues, input.tasks, now, input.dispatches)
  addCriteria(cards, input.issues)
  addLastRoundReasons(cards, input.decision)
  return [...cards.values()].sort((a, b) => b.number - a.number)
}

/**
 * The registry is the account of record, so an issue that has a task is
 * described by that task rather than by its own openness.
 */
function addRegistryTasks(
  cards: Map<number, Card>,
  tasks: RegistryTask[],
): void {
  for (const task of tasks) {
    const number = task.issue?.number
    if (typeof number !== 'number') continue
    const state = task.state ?? 'unknown'
    const existing = cards.get(number)
    const card: Card = {
      number,
      title: task.title ?? `#${number}`,
      column: columnFor(state),
      paths: task.ownedPaths ?? [],
      detail: state,
      worker: task.worker,
    }
    // A number can carry several tasks over its life. The one furthest along
    // the pipeline is the one that describes it - otherwise a merged issue
    // reappears in "dropped" because an earlier attempt was cancelled.
    //
    // That is exactly what happened: the rank was an index into COLUMNS, which
    // is the RENDER order and ends [... done, dropped], so `dropped` outranked
    // `done` and the guard produced the case it was written to prevent.
    // pipelineRank is the Queen's order instead.
    const rank = pipelineRank(card.column)
    const prior = existing ? pipelineRank(existing.column) : -1
    if (!existing || rank > prior) cards.set(number, card)
  }
}

/**
 * What the container has in flight, which the registry mirror cannot know
 * about: the mirror is written by the app.
 *
 * A dispatch borrows its title and boundary from the issue list, because its
 * own row carries neither. Without that the RUNNING column - the one an
 * operator reads first - showed bare numbers where every other column had a
 * sentence.
 */
function addInFlight(
  cards: Map<number, Card>,
  rows: Array<Record<string, unknown>>,
  issueRows: Array<Record<string, unknown>>,
): void {
  // The issue list, keyed, so a dispatch can borrow the title and boundary its
  // own row does not carry. Without this the RUNNING column - the one an
  // operator looks at first - showed bare numbers where every other column had
  // a sentence, because a dispatch the app never saw has no registry task to
  // take a title from.
  const known = new Map<number, { title: string; paths: string[] }>()
  for (const row of issueRows) {
    known.set(row.number as number, {
      title: row.title as string,
      paths: asPaths(row.owned_paths),
    })
  }

  for (const row of rows) {
    const number = row.issue as number
    const prior = cards.get(number)
    cards.set(number, {
      number,
      title: prior?.title ?? known.get(number)?.title ?? `#${number}`,
      // Finished is not free. A turn that ended with work sits in review until
      // somebody judges it - but once she HAS judged it, that verdict is the
      // fact worth showing, and it was on no surface in this deployment.
      column: dispatchColumn(row),
      paths: prior?.paths?.length
        ? prior.paths
        : (known.get(number)?.paths ?? []),
      detail: dispatchDetail(row),
      worker: 'cloud tick',
    })
  }
}

/**
 * The open issues nobody has taken.
 *
 * Held-versus-free is decided by the rule the Queen uses: does any task that
 * STILL HOLDS its boundary own an overlapping path. `awaitingReview` counts as
 * holding, which is the whole reason a parked review blocks work - until it
 * ages out at 48 hours, which is the whole reason the swarm is no longer
 * starved by one.
 *
 * Both halves of that sentence were wrong here. Overlap was array membership,
 * so containment collisions were drawn as free work; and the hold had no clock,
 * so a review the Queen released days ago was still drawn as BLOCKED. The board
 * was simultaneously too permissive about paths and too strict about age, on
 * the one screen built to explain why the swarm is stalled.
 */
function addUntakenIssues(
  cards: Map<number, Card>,
  issueRows: Array<Record<string, unknown>>,
  tasks: RegistryTask[],
  now: number,
  dispatches: Array<Record<string, unknown>> = [],
): void {
  // HOLDERS ARE BOTH SIDES, and they were one.
  //
  // The list came from the app's registry alone, so a file held by a CLOUD
  // dispatch looked free. Measured on the live board the day the headline
  // landed: #1175 was shown in `backlog` and counted in "she can take", while
  // the round had refused it with
  //
  //   rings/SR-00/QueenLocalisation.swift held by gHashTag/trios#1176
  //
  // - #1176 being a cloud dispatch, which the registry knows nothing about. The
  // page and the Queen were reading different boards, and the page's number was
  // the one on the front in the largest type.
  const fromCloud: RegistryTask[] = dispatches.map((row) => ({
    issue: { number: row.issue as number },
    state: row.finished_at ? 'awaitingReview' : 'running',
    ownedPaths: asPaths(row.owned_paths),
    updatedAt: String(row.finished_at ?? row.dispatched_at ?? ''),
  }))
  const holding = [...tasks, ...fromCloud].filter((t) =>
    stillHoldsBoundary(t, now),
  )
  for (const row of issueRows) {
    const number = row.number as number
    if (cards.has(number)) continue
    const paths = asPaths(row.owned_paths)
    if (paths.length === 0) {
      cards.set(number, {
        number,
        title: row.title as string,
        column: 'backlog',
        paths: [],
        detail: 'declares no boundary, so nothing can be reserved for it',
      })
      continue
    }
    const heldBy = holding
      .filter((t) =>
        (t.ownedPaths ?? []).some((owned) =>
          paths.some((wanted) => pathsOverlap(owned, wanted)),
        ),
      )
      .map((t) => `#${t.issue?.number}`)
    cards.set(number, {
      number,
      title: row.title as string,
      column: heldBy.length > 0 ? 'blocked' : 'backlog',
      paths,
      heldBy: heldBy.length > 0 ? heldBy : undefined,
    })
  }
}

/**
 * The page, with no state in it.
 *
 * Markup, styling and the script that knows how to ask - nothing a reader could
 * not have written themselves. Every card on it arrives from `/queen/board`,
 * which is guarded.
 */
const SHELL = `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>trios &#8212; the board</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
 :root{--phi:1.618;--bg:#000;--panel:#0a0a0f;--border:rgba(255,255,255,.08);
  --accent:#00FF88;--golden:#FFD700;--red:#ff5f56;--text:#fff;--muted:#888;
  --font:"Outfit",system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  --f-3:.7rem;--f-2:.8125rem;--f-1:.875rem;--f0:1rem;--f3:2.058rem;
  --sp-1:.382rem;--sp0:.618rem;--sp1:1rem;--sp2:1.618rem;--sp3:2.618rem}
 /* The hidden attribute is a UA rule and loses to any author display rule.
    A rule like .auth{display:flex} therefore kept the token form on screen
    while el.hidden was true - measured: hidden=true, computed display=flex,
    57 cards behind it. Anything hidden must actually be hidden.
    NO BACKTICKS: this is inside a template literal. Fourth time today. */
 [hidden]{display:none !important}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);
  font-weight:300;line-height:var(--phi);-webkit-font-smoothing:antialiased}
 .wrap{padding:var(--sp3) var(--sp2)}
 h1{font-size:clamp(2.6rem,7vw,5.2rem);font-weight:600;margin:0 0 var(--sp-1);
  letter-spacing:-.045em;line-height:.95;text-wrap:balance}
 h1 span{color:var(--accent)}
 h1 a{color:var(--accent);text-decoration:none}
 .kicker{font-size:var(--f-3);letter-spacing:.34em;text-transform:uppercase;
  color:var(--muted);font-weight:500;margin-bottom:var(--sp0)}
 .rule{height:1px;background:linear-gradient(90deg,var(--accent),transparent 62%);
  margin:var(--sp1) 0 var(--sp2)}
 .lede{font-size:var(--f1,1.272rem);line-height:1.5;color:#bbb;max-width:52ch;
  font-weight:300;margin-bottom:var(--sp2)}
 .sub{color:var(--muted);font-size:var(--f-1);margin-bottom:var(--sp2)}
 .auth{display:flex;gap:var(--sp0);align-items:center;flex-wrap:wrap;margin-bottom:var(--sp2)}
 input,button{font-family:var(--font);font-size:var(--f-1);border-radius:var(--sp0);
  border:1px solid var(--border);background:var(--panel);color:var(--text);
  padding:var(--sp0) var(--sp1)}
 button{cursor:pointer;border-color:#00CC66;color:var(--accent)}
 button:hover{background:rgba(0,255,136,.08)}
 .err{color:var(--golden);font-size:var(--f-1);margin-bottom:var(--sp1)}
 .explain{display:grid;gap:var(--sp1);margin-bottom:var(--sp3);
  grid-template-columns:repeat(auto-fit,minmax(168px,1fr))}
 .stat{background:var(--panel);border:1px solid var(--border);
  border-radius:var(--sp0);padding:var(--sp1) var(--sp2)}
 .stat b{display:block;font-size:2.4rem;font-weight:600;line-height:1;
  letter-spacing:-.03em;margin-bottom:var(--sp-1)}
 .stat .lbl{font-size:var(--f-3);letter-spacing:.14em;text-transform:uppercase;
  color:var(--muted)}
 .stat .why{font-size:var(--f-3);color:#999;margin-top:var(--sp-1);line-height:1.45}
 .stat.good b{color:var(--accent)} .stat.warn b{color:var(--golden)}
 .stat.bad b{color:var(--red)}
 .flow{display:flex;gap:var(--sp0);align-items:center;flex-wrap:wrap;
  margin-bottom:var(--sp2);font-size:var(--f-2);color:var(--muted)}
 .flow i{font-style:normal;background:var(--panel);border:1px solid var(--border);
  border-radius:99px;padding:.2rem .7rem}
 .flow i.on{color:var(--accent);border-color:rgba(0,255,136,.4)}
 .flow s{text-decoration:none;color:#444}
 .board{display:grid;gap:var(--sp1);
  grid-template-columns:repeat(auto-fit,minmax(240px,1fr));align-items:start}
 .col-head{display:flex;align-items:baseline;justify-content:space-between;
  border-bottom:1px solid var(--border);padding-bottom:var(--sp0)}
 .col-head h2{font-size:var(--f-2);letter-spacing:.16em;text-transform:uppercase;
  color:var(--accent);font-weight:500;margin:0}
 .n{font-family:var(--mono);font-size:var(--f-2);color:var(--muted)}
 .col-blurb{color:var(--muted);font-size:var(--f-3);margin:var(--sp-1) 0 var(--sp1)}
 .cards{display:flex;flex-direction:column;gap:var(--sp0)}
 .card{background:var(--panel);border:1px solid var(--border);
  border-left:2px solid var(--muted);border-radius:var(--sp0);padding:var(--sp1)}
 .card.running{border-left-color:var(--accent)}
 .card.review{border-left-color:var(--golden)}
 .card.blocked{border-left-color:var(--red)}
 .verdict{margin:var(--sp1) 0 var(--sp0);padding:var(--sp1) var(--sp1);
   border:1px solid var(--border);border-left:4px solid var(--accent);
   background:var(--panel);border-radius:8px}
 .verdict h2{font-size:clamp(1.5rem,3.4vw,2.6rem);line-height:1.12;margin:0;
   letter-spacing:-.02em;font-weight:700}
 .verdict.idle{border-left-color:var(--red)}
 .verdict p{margin:.5rem 0 0;color:var(--muted);font-size:var(--f-1);
   line-height:1.5;max-width:74ch}
 .verdict code{color:var(--golden);font-family:var(--mono)}
 .pulse{display:flex;gap:var(--sp1);flex-wrap:wrap;margin:var(--sp0) 0;
   color:var(--muted);font-size:var(--f-2);font-family:var(--mono)}
 .pulse b{color:var(--fg);font-weight:600}
 .card.done{border-left-color:#2a6}
 .card.dropped{border-left-color:#333}
 .num{font-family:var(--mono);font-size:var(--f-2);color:var(--accent);text-decoration:none}
 .num:hover{text-decoration:underline}
 .t{font-size:var(--f-1);margin:var(--sp-1) 0;line-height:1.4}
 .who{font-size:var(--f-3);color:var(--accent);font-family:var(--mono)}
 .held{font-size:var(--f-3);color:var(--red);font-family:var(--mono)}
.crit{font-size:var(--f-3);color:var(--golden);margin-top:.35rem}
.crit.none{color:var(--red)}
.needs{font-size:var(--f-3);color:var(--dim);font-family:var(--mono)}
.why-card{font-size:var(--f-3);color:var(--dim);margin-top:.35rem;
  border-left:2px solid var(--line);padding-left:.5rem;line-height:1.45}
 .d{font-size:var(--f-3);color:var(--muted);margin-top:var(--sp-1);word-break:break-word}
 code{font-family:var(--mono);font-size:var(--f-3);color:var(--muted);
  background:rgba(255,255,255,.05);padding:0 .3em;border-radius:3px;
  display:inline-block;margin:1px 0;word-break:break-all}
 .empty{color:#333;font-size:var(--f-3);padding:var(--sp1) 0}
 .empty-board{border:1px solid var(--golden);border-radius:var(--sp0);
  padding:var(--sp1) var(--sp2);color:var(--golden);font-size:var(--f-1);
  margin-bottom:var(--sp2);max-width:60ch}
 footer{margin-top:var(--sp3);padding-top:var(--sp1);border-top:1px solid var(--border);
  color:var(--muted);font-size:var(--f-3);display:flex;gap:var(--sp2);flex-wrap:wrap}
 a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
 .phi{color:var(--golden)}
</style></head>
<body><div class="wrap">
 <div class="kicker">what the swarm is doing</div>
 <h1>the board</h1>
 <div class="rule"></div>
 <div class="sub" id="sub">Columns are the Queen's own states, not invented
  ones &#8212; every card clicks through to its issue.</div>
 <div class="auth" id="auth">
  <input type="password" id="token" placeholder="deployment token" size="34" autocomplete="off" />
  <button id="go">connect</button>
  <label style="color:var(--muted);font-size:var(--f-2);display:flex;gap:.3rem;align-items:center;cursor:pointer"><input type="checkbox" id="remember" style="width:auto;margin:0" checked />remember on this device</label>
  <span class="sub" style="margin:0">never in the URL &#8212; sent as a header</span>
 </div>
 <div class="err" id="err"></div>
 <!-- Every node draw() writes into is HERE, and permanent. The flow strip and
      the empty-board notice were built fresh and spliced in ahead of a sibling
      on each draw, and nothing removed the previous one: on a 30-second
      refresh the board's top was measured 4135px down the document after five
      refreshes, about two and a half minutes. A drawing function that appends
      is a leak with a timer on it. -->
 <div class="verdict" id="verdict" hidden></div>
 <div class="flow" id="flow" hidden></div>
 <div class="explain" id="explain"></div>
 <div class="pulse" id="pulse" hidden></div>
 <div class="empty-board" id="empty-board" hidden></div>
 <div class="board" id="board"></div>
 <footer>
  <span>&#966;<sup>2</sup> + 1/&#966;<sup>2</sup> = 3 <span class="phi">TRINITY</span></span>
  <span><a href="/queen/tree">technology tree &#8594;</a></span>
  <span><a href="/queen/dashboard">the swarm &#8594;</a></span>
 </footer>
</div>
<script>
(function(){
 var $=function(i){return document.getElementById(i)}
 var KEY='trios.queen.token'
  // localStorage when the operator ticked the box, sessionStorage otherwise.
  // BOTH are read, so a token stored either way is found and ticking the box
  // on one page carries to the other two without a second paste. That second
  // paste per tab was the whole friction.
 var token=localStorage.getItem(KEY)||sessionStorage.getItem(KEY)||''
 function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
   return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
 function draw(d){
  var repo=d.repo, board=$('board'); board.innerHTML=''
  // The explainer, from the same numbers the columns are built from. A reader
  // who has never seen this should learn what it is without asking: how many
  // the Queen COULD take, how many she is on, and what is in her way.
  var by={}; d.cards.forEach(function(c){by[c.column]=(by[c.column]||0)+1})
  var free=d.cards.filter(function(c){
    return c.column==='backlog' && c.paths && c.paths.length}).length
  var noBoundary=(by.backlog||0)-free
  var ex=$('explain')
  ex.innerHTML=
   '<div class="stat good"><b>'+(by.running||0)+'</b>'+
     '<span class="lbl">bees working</span>'+
     '<div class="why">a bee is one model turn in its own checkout</div></div>'+
   '<div class="stat'+(free===0?' bad':'')+'"><b>'+free+'</b>'+
     '<span class="lbl">she can take</span>'+
     '<div class="why">an issue is only delegatable once it names the files it will touch</div></div>'+
   '<div class="stat warn"><b>'+noBoundary+'</b>'+
     '<span class="lbl">no boundary</span>'+
     '<div class="why">these cannot be given out: nothing can be reserved for them</div></div>'+
   '<div class="stat'+((by.review||0)>0?' warn':'')+'"><b>'+(by.review||0)+'</b>'+
     '<span class="lbl">awaiting you</span>'+
     '<div class="why">finished work holds its files until somebody judges it</div></div>'+
   '<div class="stat'+((by.blocked||0)>0?' bad':'')+'"><b>'+(by.blocked||0)+'</b>'+
     '<span class="lbl">blocked</span>'+
     '<div class="why">their files are held by something in review</div></div>'
  // THE SENTENCE THE PAGE EXISTS FOR.
  //
  // The operator's words: "what is she doing - I do not understand". The board
  // showed five counters and a legend, and a reader could see that nothing was
  // running without learning WHY - which is usually not a fact about the board
  // at all. With one provider key the ceiling is one bee whatever the policy's
  // four says, so a page reading 0 of 4 invites a hunt for a bug that is not
  // there. The Queen already writes her own reason down every round; this puts
  // it at the top in the largest type on the page.
  var p=d.pulse||{}
  var v=$('verdict')
  var run=by.running||0
  var keys=p.workerKeys||0
  var ceiling=Math.min(keys||0, p.workerLimit||4)
  var head, why
  if(run>0){
   head=run===1?'One bee is working right now.':run+' bees are working right now.'
   why='Each has its own checkout and its own branch. Click <b>watch</b> on a '+
    'card to read what it is saying, as it says it.'
  } else if(free>0){
   head='Nothing is running, and '+free+' issue'+(free===1?' is':'s are')+' ready.'
   why='She wakes on a timer rather than on demand, so this is the gap between '+
    'rounds. Her last round said: <code>'+esc(p.lastRefusal||'nothing to choose')+'</code>'
  } else {
   head='Nothing is running, and there is nothing she may start.'
   why='Her own reason, from the last round: <code>'+
    esc(p.lastRefusal||'nothing to choose')+'</code>. '+
    (noBoundary>0?noBoundary+' issues name no files, so nothing can be reserved '+
      'for them and no bee can be sent at one. ':'')+
    ((by.review||0)>0?(by.review)+' finished and hold their files until judged. ':'')
  }
  v.className='verdict'+(run>0?'':' idle')
  v.innerHTML='<h2>'+esc(head)+'</h2><p>'+why+'</p>'+
   '<p>Capacity: <b>'+run+' of '+ceiling+'</b> workers busy. '+
   (keys===0
     ? 'This deployment holds <b>no provider key</b>, so no bee can start at all.'
     : keys<(p.workerLimit||4)
       ? 'The policy allows '+(p.workerLimit||4)+', and this deployment holds <b>'+
         keys+' provider key'+(keys===1?'':'s')+'</b> - one bee per key, so '+
         keys+' is the real ceiling.'
       : 'Keys are not the limit here.')+'</p>'
  v.hidden=false

  // What she actually did, over a day. A board that shows only the present
  // cannot answer "is she working at all"; the honest answer is a count of
  // rounds, not a spinner.
  var pu=$('pulse')
  var mins=p.roundSeconds?Math.round(p.roundSeconds/60):null
  pu.innerHTML='<span><b>'+(p.rounds||0)+'</b> rounds in 24h</span>'+
   '<span><b>'+(p.bees||0)+'</b> bees started</span>'+
   '<span><b>'+(p.verdicts||0)+'</b> verdicts given</span>'+
   '<span><b>'+(((p.inputTokens||0)+(p.outputTokens||0))/1000).toFixed(1)+
     'k</b> tokens</span>'+
   (mins?'<span>wakes every <b>'+mins+' min</b></span>':'')
  pu.hidden=false

  // Assigned into a node the shell already owns, never inserted. Same rule as
  // #explain above, for the reason written next to those nodes in the markup.
  var flow=$('flow')
  flow.innerHTML='<i'+(free>0?' class="on"':'')+'>1 pick an issue</i><s>&#8594;</s>'+
   '<i'+((by.running||0)>0?' class="on"':'')+'>2 cut a branch</i><s>&#8594;</s>'+
   '<i'+((by.running||0)>0?' class="on"':'')+'>3 a bee works</i><s>&#8594;</s>'+
   '<i'+((by.review||0)>0?' class="on"':'')+'>4 wait for a verdict</i><s>&#8594;</s>'+
   '<i'+((by.done||0)>0?' class="on"':'')+'>5 land it</i>'
  flow.hidden=false
  var total=d.cards.length
  $('sub').textContent=total+" issues from "+repo+". Columns are the Queen's own states."
  var w=$('empty-board')
  w.textContent=total===0
   ?'This database holds no registry, no dispatches and no issues. '+
    'That is a database without a swarm in it, not a swarm with nothing to do.'
   :''
  w.hidden=total!==0
  d.columns.forEach(function(col){
   var mine=d.cards.filter(function(c){return c.column===col.key})
   var cards=mine.map(function(c){
    return '<article class="card '+esc(col.key)+'">'+
     '<a class="num" target="_blank" rel="noreferrer" href="https://github.com/'+
       esc(repo)+'/issues/'+c.number+'">#'+c.number+'</a>'+
     ' <a class="num" style="color:var(--golden)" href="/queen/feed?issue='+
       c.number+'">watch &#8594;</a>'+
     '<div class="t">'+esc(c.title)+'</div>'+
     (c.worker?'<div class="who">'+esc(c.worker)+'</div>':'')+
     (c.heldBy?'<div class="held">held by '+esc(c.heldBy.join(', '))+'</div>':'')+
     ((c.paths&&c.paths.length)?'<div>'+c.paths.map(function(p){
        return '<code>'+esc(p)+'</code>'}).join(' ')+'</div>':'')+
     (c.detail?'<div class="d">'+esc(c.detail)+'</div>':'')+
     // How judgeable it is, and the round's own reason for passing it over.
     // The board could always say a card was stuck and never why.
     (typeof c.criteria==='number'
       ? '<div class="crit'+(c.criteria?'':' none')+'">'+
         (c.criteria
           ? c.criteria+' criteria to be judged by ('+esc(c.criteriaSource||'')+')'
           : 'no acceptance criteria - nothing to judge it against')+'</div>'
       : '')+
     ((c.needs&&c.needs.length)
       ? '<div class="needs">still needs: '+esc(c.needs.join(', '))+'</div>':'')+
     (c.whyNotChosen
       ? '<div class="why-card">last round: '+esc(c.whyNotChosen)+'</div>':'')+
     '</article>'
   }).join('')||'<div class="empty">nothing here</div>'
   var s=document.createElement('section')
   s.innerHTML='<div class="col-head"><h2>'+esc(col.title)+'</h2>'+
    '<span class="n">'+mine.length+'</span></div>'+
    '<div class="col-blurb">'+esc(col.blurb)+'</div>'+
    '<div class="cards">'+cards+'</div>'
   board.appendChild(s)
  })
 }
 function load(){
  // Try WITHOUT a token first. A local dev server has none configured, so
  // the guard trusts a loopback socket and the form is pure noise there.
  // Only a 403 proves a credential is actually required, and that is when
  // the form appears - measured rather than assumed from the URL.
  fetch('/queen/board',token?{headers:{Authorization:'Bearer '+token}}:undefined)
   .then(function(r){
     if(r.status===403){throw new Error('That token was refused.')}
     if(!r.ok){throw new Error('The board answered '+r.status+'.')}
     return r.json()})
   .then(function(d){$('auth').hidden=true; $('err').textContent=''; draw(d)})
   .catch(function(e){
     $('err').textContent=e.message
     $('auth').hidden=false
     sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); token=''})
 }
 $('go').addEventListener('click',function(){
  token=$('token').value.trim()
  if(!token) return
  var keep=$('remember')&&$('remember').checked
  ;(keep?localStorage:sessionStorage).setItem(KEY,token)
  ;(keep?sessionStorage:localStorage).removeItem(KEY); load()})
 $('token').addEventListener('keydown',function(e){if(e.key==='Enter')$('go').click()})
 $('auth').hidden=true; load()
 setInterval(load, 30000)
})()
</script>
</body></html>`

export function createQueenBoardRoute() {
  return new Hono().get('/', async (c) => {
    const url = queenLeaseDatabaseUrl()
    if (!url) return c.json({ error: 'No database configured' }, 503)
    const repo = process.env.TRIOS_GITHUB_REPO || 'gHashTag/trios'
    const pool = new Pool({ connectionString: url })
    try {
      const built = await build(pool)
      return c.json({
        repo,
        columns: COLUMNS,
        cards: built.cards,
        pulse: built.pulse,
      })
    } finally {
      await pool.end()
    }
  })
}

export function createQueenKanbanRoute() {
  return new Hono().get('/', (c) =>
    c.html(SHELL, 200, { 'Cache-Control': 'no-store' }),
  )
}
