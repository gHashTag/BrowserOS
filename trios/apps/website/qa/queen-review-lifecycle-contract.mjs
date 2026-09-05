#!/usr/bin/env bun
/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The deterministic UI contract for the Queen review lifecycle on the t27.ai
 * dashboard (#1318, part of #1314).
 *
 * WHAT THIS FILE IS.
 *
 * One script, run with `bun run qa` from apps/website (the repository's
 * runtime is bun - the agent-server package declares `node: please-use-bun`,
 * and the server-side Queen tests are bun:test files for the same reason). It
 * imports the REAL page module - the same src/pages/Queen.tsx the site builds
 * - and pins:
 *
 *   the state names   the closed set the server publishes (#1316), nothing
 *                     else, in a stable render order
 *   the counters      four separate counts, derived only from public cards,
 *                     never merged, never fabricated
 *   the fallback      legacy review cards without the additive state land in
 *                     reconciliationAnomaly, VISIBLY, never in Queen debt
 *   the labels        all four counters, owners and actions, translated in
 *                     BOTH locales, with no label reused across queues
 *   the markup        server-rendered output of the real component: counters,
 *                     badges, queues, the honest unavailable state, and the
 *                     public-ledger-only boundary (guarded fields cannot leak
 *                     into the page even when the payload carries them)
 *   the stylesheet    every top-level selector scoped under .queen-page, and
 *                     a prefers-reduced-motion block that removes all motion
 *
 * DETERMINISM.
 *
 * No clock, no network, no randomness: the fixtures below are plain objects
 * and the renderer is react-dom/server's renderToStaticMarkup. Two runs on
 * the same tree produce the same verdict.
 *
 * HONESTY ABOUT FAILURES.
 *
 * Every check has a name; the first failure prints exactly which one broke
 * and with what, and the process exits 1. Nothing is skipped quietly.
 */

import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PUBLIC_BOARD_PATH,
  LEGACY_REVIEW_COLUMN,
  REVIEW_STATES,
  QUEEN_COPY,
  REVIEW_STATE_COPY,
  QueenPage,
  STANDALONE_SHELL,
  boardCopy,
  cardsInQueue,
  classifyReviewCard,
  fetchPublicBoard,
  resolveLocale,
  reviewCopy,
  reviewQueueCounts,
} from '../src/pages/Queen.tsx'

/* ------------------------------------------------------------------ *
 * harness                                                             *
 * ------------------------------------------------------------------ */

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push({ name, detail: detail ?? 'condition was false' })
}

check(
  'api: the page module exports its loader for the production site',
  typeof fetchPublicBoard === 'function',
)

function equal(name, actual, expected) {
  const okay = JSON.stringify(actual) === JSON.stringify(expected)
  check(
    name,
    okay,
    okay ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  )
}

/* ------------------------------------------------------------------ *
 * fixtures                                                            *
 * ------------------------------------------------------------------ */

/**
 * A public board whose queues each carry a distinctive count.
 *
 *   2 queenReviewPending    #2001, #2002
 *   1 changesRequested      #2003
 *   3 humanEscalation       #2004, #2005, #2006
 *   3 reconciliationAnomaly #2007 (explicit), #2008 (LEGACY, no state),
 *                           #2011 (unknown token 'awaitingReview')
 *
 *   #2009 running and #2010 done are not review work and must be counted
 *   nowhere.
 *
 * The cards also carry fields the public projection never sends (worker,
 * branch, heldBy) so the markup checks below can prove they cannot leak even
 * if a future payload regresses and starts sending them.
 */
const FIXTURE_CARDS = [
  {
    number: 2001,
    title: 'Finished dispatch, no verdict yet (one)',
    column: 'review',
    reviewState: 'queenReviewPending',
    worker: 'zai/secret-provider',
    branch: 'queen/secret-branch',
  },
  {
    number: 2002,
    title: 'Finished dispatch, no verdict yet (two)',
    column: 'review',
    reviewState: 'queenReviewPending',
  },
  {
    number: 2003,
    title: 'The Queen sent this back for changes',
    column: 'review',
    reviewState: 'changesRequested',
    heldBy: ['#9999'],
  },
  {
    number: 2004,
    title: 'Escalated to a human (one)',
    column: 'review',
    reviewState: 'humanEscalation',
  },
  {
    number: 2005,
    title: 'Escalated to a human (two)',
    column: 'review',
    reviewState: 'humanEscalation',
  },
  {
    number: 2006,
    title: 'Escalated to a human (three)',
    column: 'review',
    reviewState: 'humanEscalation',
  },
  {
    number: 2007,
    title: 'Registry row the ledger cannot prove',
    column: 'review',
    reviewState: 'reconciliationAnomaly',
  },
  {
    // The legacy card: published before the additive field existed. The one
    // case FR-002 is about.
    number: 2008,
    title: 'Legacy review card without the additive state',
    column: 'review',
  },
  {
    number: 2009,
    title: 'A bee is on this right now',
    column: 'running',
  },
  {
    number: 2010,
    title: 'Accepted and landed',
    column: 'done',
  },
  {
    // Old vocabulary that must never be a public label again, and whose owner
    // is exactly as unproven as a missing field.
    number: 2011,
    title: 'Card carrying the old universal review word',
    column: 'review',
    reviewState: 'awaitingReview',
  },
]

const FIXTURE_COUNTS = {
  queenReviewPending: 2,
  changesRequested: 1,
  humanEscalation: 3,
  reconciliationAnomaly: 3,
}

const FIXTURE_BOARD = {
  repo: 'gHashTag/trios',
  columns: [
    { key: 'backlog', title: 'backlog', blurb: '' },
    { key: 'review', title: 'in review', blurb: '' },
  ],
  cards: FIXTURE_CARDS,
  pulse: {
    rounds: 7,
    bees: 4,
    verdicts: 2,
    lastRoundAt: '2026-09-02T00:00:00.000Z',
    roundSeconds: 1800,
  },
}

/* ------------------------------------------------------------------ *
 * 1. state names                                                      *
 * ------------------------------------------------------------------ */

equal(
  'state names: the closed set, in the dashboard render order',
  [...REVIEW_STATES],
  ['queenReviewPending', 'changesRequested', 'humanEscalation', 'reconciliationAnomaly'],
)

equal('state names: the public endpoint path is pinned', PUBLIC_BOARD_PATH, '/queen/public-board')
equal('state names: the legacy review column is pinned', LEGACY_REVIEW_COLUMN, 'review')

/* ------------------------------------------------------------------ *
 * 2. classification, including the fallback (FR-002)                  *
 * ------------------------------------------------------------------ */

const CLASSIFICATION_CASES = [
  ['a published queenReviewPending card', { reviewState: 'queenReviewPending' }, 'queenReviewPending'],
  ['a published changesRequested card', { reviewState: 'changesRequested' }, 'changesRequested'],
  ['a published humanEscalation card', { reviewState: 'humanEscalation' }, 'humanEscalation'],
  ['a published reconciliationAnomaly card', { reviewState: 'reconciliationAnomaly' }, 'reconciliationAnomaly'],
  [
    'FR-002: a legacy review card with no additive state is an anomaly',
    { column: 'review' },
    'reconciliationAnomaly',
  ],
  [
    'FR-002: a legacy review card with reviewState null is an anomaly',
    { column: 'review', reviewState: null },
    'reconciliationAnomaly',
  ],
  [
    'FR-002: a legacy review card with a non-string reviewState is an anomaly',
    { column: 'review', reviewState: 42 },
    'reconciliationAnomaly',
  ],
  [
    'an empty-string reviewState is unproven, not pending',
    { column: 'review', reviewState: '' },
    'reconciliationAnomaly',
  ],
  [
    "the old universal 'awaitingReview' word is unproven, not pending",
    { column: 'review', reviewState: 'awaitingReview' },
    'reconciliationAnomaly',
  ],
  [
    'an unknown future token is unproven, not pending',
    { column: 'review', reviewState: 'someNewStateThePageDoesNotKnow' },
    'reconciliationAnomaly',
  ],
  ['a running card is not review work', { column: 'running' }, null],
  ['a running card with no column is not review work', {}, null],
  ['a done card is not review work', { column: 'done' }, null],
  ['a backlog card is not review work', { column: 'backlog' }, null],
  ['null is not review work', null, null],
  ['a string is not review work', 'queenReviewPending', null],
  ['an array is not review work', ['queenReviewPending'], null],
]

for (const [name, card, expected] of CLASSIFICATION_CASES) {
  const actual = classifyReviewCard(card)
  equal(`classification: ${name}`, actual, expected)
}

// The fallback rule, said out loud so a regression reads as itself:
const legacy = classifyReviewCard({ column: 'review' })
check(
  'FR-002: a legacy review card is never classified as Queen review pending',
  legacy !== 'queenReviewPending',
  `legacy card classified as ${legacy}`,
)

/* ------------------------------------------------------------------ *
 * 3. counters (FR-001)                                                *
 * ------------------------------------------------------------------ */

equal('counters: four separate counts from the fixture board', reviewQueueCounts(FIXTURE_CARDS), FIXTURE_COUNTS)

equal('counters: an empty card list is four truthful zeros', reviewQueueCounts([]), {
  queenReviewPending: 0,
  changesRequested: 0,
  humanEscalation: 0,
  reconciliationAnomaly: 0,
})

equal('counters: a missing card list is four truthful zeros', reviewQueueCounts(undefined), {
  queenReviewPending: 0,
  changesRequested: 0,
  humanEscalation: 0,
  reconciliationAnomaly: 0,
})

equal('counters: null is four truthful zeros', reviewQueueCounts(null), {
  queenReviewPending: 0,
  changesRequested: 0,
  humanEscalation: 0,
  reconciliationAnomaly: 0,
})

// A board of ONLY legacy cards: nothing may silently become Queen debt.
equal(
  'counters: a board of only legacy review cards counts one queue - anomaly',
  reviewQueueCounts([{ column: 'review' }, { column: 'review' }, { column: 'review' }]),
  {
    queenReviewPending: 0,
    changesRequested: 0,
    humanEscalation: 0,
    reconciliationAnomaly: 3,
  },
)

// Separation: moving one card moves exactly one counter.
const before = reviewQueueCounts(FIXTURE_CARDS)
const moved = FIXTURE_CARDS.map((card) =>
  card.number === 2002 ? { ...card, reviewState: 'humanEscalation' } : card,
)
const after = reviewQueueCounts(moved)
equal('counters: the moved card left its old queue', after.queenReviewPending, before.queenReviewPending - 1)
equal('counters: the moved card entered its new queue', after.humanEscalation, before.humanEscalation + 1)
equal('counters: no other queue moved', [after.changesRequested, after.reconciliationAnomaly], [
  before.changesRequested,
  before.reconciliationAnomaly,
])

// cardsInQueue agrees with the counters.
for (const state of REVIEW_STATES) {
  equal(
    `queue membership: ${state} lists exactly the cards the counter counted`,
    cardsInQueue(FIXTURE_CARDS, state).length,
    FIXTURE_COUNTS[state],
  )
}
equal(
  'queue membership: the legacy card #2008 sits in the anomaly queue',
  cardsInQueue(FIXTURE_CARDS, 'reconciliationAnomaly').map((card) => card.number),
  [2007, 2008, 2011],
)

// The input is never mutated: counting is reading (FR-004).
const frozenCards = FIXTURE_CARDS.map((card) => ({ ...card }))
reviewQueueCounts(frozenCards)
equal('counters: counting does not mutate the board', frozenCards, FIXTURE_CARDS)

/* ------------------------------------------------------------------ *
 * 4. locales and labels                                               *
 * ------------------------------------------------------------------ */

const LOCALE_CASES = [
  ['ru resolves to ru', 'ru', 'ru'],
  ['RU resolves to ru', 'RU', 'ru'],
  ['ru-RU resolves to ru', 'ru-RU', 'ru'],
  ['en resolves to en', 'en', 'en'],
  ['en-US resolves to en', 'en-US', 'en'],
  ['an unknown locale falls back to en, closed', 'fr', 'en'],
  ['a non-string locale falls back to en', 42, 'en'],
]
for (const [name, input, expected] of LOCALE_CASES) {
  equal(`locale: ${name}`, resolveLocale(input), expected)
}

for (const locale of ['en', 'ru']) {
  const labels = REVIEW_STATES.map((state) => reviewCopy(state, locale).label)
  check(
    `labels: all four ${locale} counter labels are non-empty`,
    labels.every((label) => typeof label === 'string' && label.length > 0),
    `labels were ${JSON.stringify(labels)}`,
  )
  check(
    `labels: no two ${locale} queues share a label`,
    new Set(labels).size === 4,
    `labels were ${JSON.stringify(labels)}`,
  )
  for (const field of ['owner', 'action', 'hint']) {
    const values = REVIEW_STATES.map((state) => reviewCopy(state, locale)[field])
    check(
      `labels: all four ${locale} badge ${field}s are non-empty`,
      values.every((value) => typeof value === 'string' && value.length > 0),
      `${field}s were ${JSON.stringify(values)}`,
    )
  }
  // Translation actually happened, for all four states.
  for (const state of REVIEW_STATES) {
    check(
      `labels: ${state} is translated (${locale === 'ru' ? 'differs from English' : 'exists against Russian'})`,
      reviewCopy(state, 'en').label !== reviewCopy(state, 'ru').label,
      `en and ru labels are identical for ${state}`,
    )
  }
  // A human escalation is never labelled as waiting for the Queen, in either
  // language - the flattering lie this page exists to remove.
  check(
    `labels: humanEscalation copy in ${locale} never names the Queen as owner`,
    !/queen|королев/i.test(`${reviewCopy('humanEscalation', locale).owner} ${reviewCopy('humanEscalation', locale).action}`),
    `owner/action was ${reviewCopy('humanEscalation', locale).owner} / ${reviewCopy('humanEscalation', locale).action}`,
  )
}

// The copy table is complete: every state, both locales.
for (const state of REVIEW_STATES) {
  for (const locale of ['en', 'ru']) {
    check(
      `copy table: ${state} has a ${locale} entry`,
      REVIEW_STATE_COPY[state] && typeof REVIEW_STATE_COPY[state][locale] === 'object',
    )
    check(
      `copy table: page chrome has a ${locale} entry`,
      typeof QUEEN_COPY[locale] === 'object' && QUEEN_COPY[locale].heading.length > 0,
    )
  }
}

// Unknown state fails visible, toward anomaly, in both locales.
check(
  'copy fallback: an unknown state gets the anomaly copy, not a blank',
  reviewCopy('notARealState', 'en').label === REVIEW_STATE_COPY.reconciliationAnomaly.en.label,
  `got ${JSON.stringify(reviewCopy('notARealState', 'en'))}`,
)

/* ------------------------------------------------------------------ *
 * 5. the rendered markup                                              *
 * ------------------------------------------------------------------ */

const renderEnglish = renderToStaticMarkup(
  QueenPage({
    board: FIXTURE_BOARD,
    status: 'ready',
    locale: 'en',
    fetchedAt: '2026-09-02T12:00:00.000Z',
  }),
)

const renderRussian = renderToStaticMarkup(
  QueenPage({
    board: FIXTURE_BOARD,
    status: 'ready',
    locale: 'ru',
    fetchedAt: null,
  }),
)

// Every counter renders, in order, with its own count next to its own label.
for (const state of REVIEW_STATES) {
  const countPattern = new RegExp(
    `data-review-counter="${state}"[\\s\\S]{0,600}?<b[^>]*data-review-count="${state}"[^>]*>${FIXTURE_COUNTS[state]}</b>`,
  )
  check(
    `markup: the ${state} counter shows ${FIXTURE_COUNTS[state]}`,
    countPattern.test(renderEnglish),
    'counter with its count not found in the rendered page',
  )
  const label = reviewCopy(state, 'en').label
  check(
    `markup: the ${state} counter carries the English label`,
    renderEnglish.includes(label),
    `label "${label}" not found`,
  )
  check(
    `markup: the ${state} counter carries the Russian label`,
    renderRussian.includes(reviewCopy(state, 'ru').label),
    `label "${reviewCopy(state, 'ru').label}" not found in the RU render`,
  )
  const queuePattern = new RegExp(`data-review-queue="${state}"`)
  check(
    `markup: the ${state} queue section renders`,
    queuePattern.test(renderEnglish),
  )
}

// The queue count agrees with the counter beside it.
for (const state of REVIEW_STATES) {
  const queueCountPattern = new RegExp(
    `data-review-queue-count="${state}"[^>]*>${FIXTURE_COUNTS[state]}<`,
  )
  check(
    `markup: the ${state} queue heading shows its own count`,
    queueCountPattern.test(renderEnglish),
  )
}

// Badges name the owner and the action, in the reader's locale.
for (const state of REVIEW_STATES) {
  for (const locale of ['en', 'ru']) {
    const markup = locale === 'en' ? renderEnglish : renderRussian
    const owner = reviewCopy(state, locale).owner
    const action = reviewCopy(state, locale).action
    check(
      `markup: the ${state} badge names its owner (${locale})`,
      new RegExp(`data-review-badge="${state}"[\\s\\S]{0,400}?data-review-owner[^>]*>${escapeHtml(owner)}`).test(markup),
      `owner "${owner}" not found in the ${locale} badge`,
    )
    check(
      `markup: the ${state} badge names its action (${locale})`,
      new RegExp(`data-review-badge="${state}"[\\s\\S]{0,600}?data-review-action[^>]*>${escapeHtml(action)}`).test(markup),
      `action "${action}" not found in the ${locale} badge`,
    )
  }
}

// FR-002, in the markup: the legacy card #2008 renders inside the anomaly
// queue and NOT inside the Queen-review-pending queue.
const anomalyQueue = extractSection(renderEnglish, 'reconciliationAnomaly')
const pendingQueue = extractSection(renderEnglish, 'queenReviewPending')
check(
  'markup: FR-002 - the legacy card #2008 renders in the anomaly queue',
  anomalyQueue.includes('#2008') && anomalyQueue.includes('Legacy review card'),
  'legacy card not found in the anomaly queue section',
)
check(
  'markup: FR-002 - the legacy card #2008 is absent from the Queen review queue',
  !pendingQueue.includes('#2008'),
  'legacy card leaked into the Queen review pending queue',
)
check(
  'markup: FR-002 - the legacy card badge names the unproven owner',
  new RegExp('data-review-card[^>]*[\\s\\S]*?#2008[\\s\\S]{0,800}?data-review-owner[^>]*>Unproven').test(renderEnglish),
)

// Honest states: unavailable shows the notice and NO counters; loading shows
// the reading notice; a ready board with no review work shows four true zeros.
const renderUnavailable = renderToStaticMarkup(
  QueenPage({ board: null, status: 'unavailable', locale: 'en' }),
)
check(
  'markup: the unavailable state shows its notice',
  renderUnavailable.includes('data-queen-notice="unavailable"') &&
    renderUnavailable.includes(boardCopy('en').unavailableTitle),
)
check(
  'markup: the unavailable state shows no counters',
  !renderUnavailable.includes('data-review-counter='),
  'a counter rendered for an unreachable board',
)
const renderLoading = renderToStaticMarkup(
  QueenPage({ board: null, status: 'loading', locale: 'ru' }),
)
check(
  'markup: the loading state shows its notice (ru)',
  renderLoading.includes('data-queen-notice="loading"') &&
    renderLoading.includes(boardCopy('ru').loading),
)

const renderQuiet = renderToStaticMarkup(
  QueenPage({
    board: { repo: 'gHashTag/trios', columns: [], cards: [{ number: 3001, column: 'running' }] },
    status: 'ready',
    locale: 'en',
  }),
)
for (const state of REVIEW_STATES) {
  const zeroPattern = new RegExp(`data-review-counter="${state}"[\\s\\S]{0,600}?>0</b>`)
  check(
    `markup: a ready board with no review work shows a true zero for ${state}`,
    zeroPattern.test(renderQuiet),
  )
}
check(
  'markup: a ready board with no review work shows the empty-queue line',
  renderQuiet.includes(boardCopy('en').emptyQueue),
)

// FR-004, in the markup: only public facts render. The fixture cards carry
// guarded-looking fields on purpose; none of them may appear.
for (const secret of ['zai/secret-provider', 'queen/secret-branch', '#9999']) {
  check(
    `boundary: guarded-looking field "${secret}" does not reach the page`,
    !renderEnglish.includes(secret),
  )
}

// FR-004, in the markup: the page ignores the pulse block entirely - two
// boards differing ONLY in throughput numbers render identically.
const loudPulse = renderToStaticMarkup(
  QueenPage({
    board: {
      repo: 'gHashTag/trios',
      columns: [],
      cards: [{ number: 4001, column: 'review', reviewState: 'queenReviewPending' }],
      pulse: { rounds: 9999, bees: 9999, verdicts: 9999, lastRoundAt: null, roundSeconds: null },
    },
    status: 'ready',
    locale: 'en',
  }),
)
const quietPulse = renderToStaticMarkup(
  QueenPage({
    board: {
      repo: 'gHashTag/trios',
      columns: [],
      cards: [{ number: 4001, column: 'review', reviewState: 'queenReviewPending' }],
    },
    status: 'ready',
    locale: 'en',
  }),
)
check(
  'FR-004: throughput numbers cannot change what the page says',
  loudPulse === quietPulse,
  'two boards differing only in pulse rendered differently',
)
check(
  'FR-004: no invented bees count renders',
  !renderEnglish.includes('bees working') && !renderEnglish.includes('9999'),
)

// Cards link through to their public GitHub issue.
check(
  'markup: cards link to their GitHub issue',
  renderEnglish.includes('https://github.com/gHashTag/trios/issues/2001'),
)

// The fetchedAt stamp is shown when known and absent when not.
check(
  'markup: the ledger-read stamp renders when known',
  renderEnglish.includes('2026-09-02T12:00:00.000Z'),
)
check(
  'markup: no stamp when the read time is unknown',
  !renderRussian.includes('ledger read at'),
)

/* ------------------------------------------------------------------ *
 * 6. source-level guards                                              *
 * ------------------------------------------------------------------ */

const pageSource = readFileSync(new URL('../src/pages/Queen.tsx', import.meta.url), 'utf8')
const cssSource = readFileSync(new URL('../src/pages/Queen.css', import.meta.url), 'utf8')

check(
  'source: the page never sends an Authorization header',
  !pageSourceWithoutComments(pageSource).includes('Authorization'),
  'an Authorization header appeared in Queen.tsx',
)
check(
  'source: fetchPublicBoard fetches with no options at all',
  /fetch\(`\$\{baseUrl\}\$\{path\}`\)/.test(pageSource),
  'fetchPublicBoard no longer calls fetch bare',
)

// The stylesheet stays inside .queen-page: no top-level selector may address
// anything else, which is what keeps the rest of the site intact (FR-003).
// At-rules with no selector (@keyframes, @font-face) cannot be prefixed with a
// class, so they are held to the namespacing rule instead: their identifier
// must start with `queen-`, which cannot collide with the site's own rules.
const scoped = cssTopLevelSelectors(cssSource)
for (const selector of scoped.selectors) {
  const isAtRule = selector.startsWith('@')
  const namespaced = /^@[\w-]*\s+queen-/.test(selector)
  check(
    `css: selector "${firstLine(selector)}" stays inside the page's namespace`,
    selector.includes('.queen-page') || (isAtRule && namespaced),
  )
}
check(
  'css: the stylesheet declares at least one .queen-page rule',
  scoped.selectors.length > 0,
)

// Motion is decoration only, and reduced-motion removes all of it.
check(
  'css: a prefers-reduced-motion block exists',
  cssSource.includes('@media (prefers-reduced-motion: reduce)'),
)
const reducedBlock = extractMediaBlock(cssSource, 'prefers-reduced-motion')
check(
  'css: reduced motion disables animations',
  reducedBlock.includes('animation: none'),
  'the reduced-motion block does not set animation: none',
)
check(
  'css: reduced motion disables transitions',
  reducedBlock.includes('transition: none'),
  'the reduced-motion block does not set transition: none',
)

// The standalone shell wires the real bundle and never claims to be the site.
const shell = STANDALONE_SHELL()
check('shell: references the bundled script', shell.includes('assets/queen.js'))
check('shell: references the bundled stylesheet', shell.includes('assets/queen.css'))
check(
  'shell: marked noindex so the preview cannot be mistaken for the site',
  shell.includes('noindex'),
)

/* ------------------------------------------------------------------ *
 * report                                                              *
 * ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.error(`queen review lifecycle contract: FAILED (${failures.length})\n`)
  for (const failure of failures) {
    console.error(`  ✗ ${failure.name}`)
    console.error(`    ${failure.detail}`)
  }
  process.exit(1)
}
console.log(`queen review lifecycle contract: ${passed} checks passed`)

/* ------------------------------------------------------------------ *
 * helpers                                                             *
 * ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** The rendered inside of one data-review-queue section. */
function extractSection(markup, state) {
  const start = markup.indexOf(`data-review-queue="${state}"`)
  if (start === -1) return ''
  const next = markup.slice(start + 1).search(/data-review-queue="/)
  return next === -1 ? markup.slice(start) : markup.slice(start, start + 1 + next)
}

/** The body of the first @media block whose header mentions `feature`. */
function extractMediaBlock(css, feature) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let at = 0
  while (at < withoutComments.length) {
    const open = withoutComments.indexOf('{', at)
    if (open === -1) return ''
    const prelude = withoutComments.slice(at, open).trim()
    const end = matchingBrace(withoutComments, open)
    if (end === -1) return ''
    if (prelude.startsWith('@media') && prelude.includes(feature)) {
      return withoutComments.slice(open + 1, end)
    }
    at = end + 1
  }
  return ''
}

/** The index of the `}` closing the `{` at `open`, or -1. */
function matchingBrace(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Every top-level selector in a stylesheet, with @media blocks flattened one
 * level (their inner selectors are top-level rules for scoping purposes - a
 * rule inside @media can escape scope just as easily as one outside).
 *
 * At-rules that carry no selector of their own (@keyframes, @font-face) are
 * reported by their prelude, so the scoping check below still sees them: a
 * global @keyframes name or @font-face would reach the whole site too.
 */
function cssTopLevelSelectors(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = []
  let at = 0
  while (at < withoutComments.length) {
    const skipped = /^\s+/.exec(withoutComments.slice(at))
    if (skipped) {
      at += skipped[0].length
      continue
    }
    const open = withoutComments.indexOf('{', at)
    if (open === -1) break
    const prelude = withoutComments.slice(at, open).trim()
    const end = matchingBrace(withoutComments, open)
    if (end === -1) break
    if (prelude.startsWith('@media')) {
      selectors.push(...cssTopLevelSelectors(withoutComments.slice(open + 1, end)).selectors)
    } else {
      selectors.push(prelude)
    }
    at = end + 1
  }
  return { selectors }
}

function firstLine(value) {
  return value.split('\n')[0].slice(0, 80)
}

/**
 * Source with block comments and whole-line // comments removed, so a check
 * like "the word Authorization appears nowhere" tests CODE, not prose. (The
 * page's own header comment says "no Authorization header"; the contract must
 * not fail on the sentence that states the rule.)
 */
function pageSourceWithoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}
