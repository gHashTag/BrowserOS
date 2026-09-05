/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The Queen page of the t27.ai website: her review queues, told truthfully.
 *
 * WHY THIS PAGE EXISTS (#1318, part of the review-lifecycle epic #1314).
 *
 * The public board used to fold four different facts into one word. A finished
 * dispatch the Queen had not judged yet, work she had sent back for changes,
 * work escalated to a human, and registry rows whose owner no durable ledger
 * could prove - all of it sat in one "in review" pile. An operator reading that
 * pile could not tell who owned what, and the worst reading was the flattering
 * one: everything looked like Queen debt, so a queue a person was supposed to
 * own sat waiting for a Queen who would never act on it.
 *
 * This page renders the four queues SEPARATELY, using the Queen's own
 * published states (#1316), and never invents a fifth:
 *
 *   queenReviewPending     finished durable dispatch, no verdict yet - the
 *                          Queen owes this work a verdict
 *   changesRequested       the Queen said sendBack - exactly one bounded retry
 *                          is due, carrying the unmet criteria
 *   humanEscalation        escalated - a person owns it now, it is NOT waiting
 *                          for the Queen
 *   reconciliationAnomaly  a registry-only review row whose owner the durable
 *                          dispatch ledger does not prove - it must be
 *                          reconciled, not silently parked as Queen debt
 *
 * THE FALLBACK RULE (FR-002), which is the point of the page.
 *
 * The `reviewState` field is additive (#1316 FR-004): older projections, and
 * older cached payloads, carry review cards WITHOUT it. Such a card is not
 * evidence of Queen debt - its owner is exactly what the missing field leaves
 * unproven - so it is classified `reconciliationAnomaly` and shown in that
 * queue, visibly. It is NEVER counted as `queenReviewPending`, because a page
 * that quietly launders unproven cards into the Queen's debt column is lying
 * in the direction that makes the system look busier than it is.
 *
 * WHAT THIS PAGE REFUSES TO DO (FR-004).
 *
 * It invents nothing: no bees, no tasks, no throughput, no review outcomes.
 * Every number is counted, on the client, from the public cards the server
 * sent - or it is not shown at all. When the public board cannot be read, the
 * page says so and shows NO counts rather than zeros, because an unreachable
 * ledger proves nothing and a zero here must always mean the ledger said zero.
 * It also reads public data only: `GET /queen/public-board`, no token, no
 * Authorization header, no guarded route, no transcript, no branch name. The
 * pulse block the endpoint carries is deliberately not rendered - throughput
 * is not this page's question, and a number displayed without its question is
 * how pages start inventing stories.
 *
 * WHAT THIS PAGE LEAVES ALONE (FR-003).
 *
 * All of its CSS is scoped under `.queen-page` (see Queen.css), so the
 * production site's own surfaces - RU/EN chrome, Kanban, Mission Map, Factory,
 * Technology Tree, the original TRINITY logo, Copy to Agent - keep their rules
 * untouched. The component takes its locale as a prop so the site's existing
 * language switching owns that decision.
 *
 * THE CONTRACT.
 *
 * qa/queen-review-lifecycle-contract.mjs pins the behaviour of everything
 * above: the closed state set, the exact counters, the legacy-card fallback,
 * both locales, and the rendered markup itself (server-rendered, so the
 * assertions are about what a browser would actually paint).
 */

// @ts-ignore - a stylesheet side-effect. esbuild and vite emit or inline it;
// tsc has no CSS module type without an ambient declaration file, which would
// be a fifth file inside this issue's boundary for no reader's benefit.
import './Queen.css'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

/* ------------------------------------------------------------------ *
 * The review lifecycle vocabulary                                     *
 * ------------------------------------------------------------------ */

/**
 * The public endpoint this page reads.
 *
 * Matches the server mount in
 * agent-server/apps/server/src/api/server.ts
 * (`.route('/queen/public-board', createQueenPublicBoardRoute())`).
 * The page fetches it with no options at all - no headers, no credentials -
 * because it is a public route and must stay one. The contract pins the path
 * so a rename on either side fails loudly instead of stranding the page.
 */
export const PUBLIC_BOARD_PATH = '/queen/public-board'

/**
 * The one legacy column that ever held review work, before `reviewState`
 * existed. Kept as a named constant because the fallback rule turns on it: a
 * card in this column without the additive state is a legacy review card.
 */
export const LEGACY_REVIEW_COLUMN = 'review'

/**
 * The closed set of public review lifecycle states, in render order.
 *
 * These are the states the server publishes (#1316), not page vocabulary. A
 * card carrying anything else is treated as unproven (see classifyReviewCard),
 * because a state this list does not contain is not a state the system has.
 */
export const REVIEW_STATES = [
  'queenReviewPending',
  'changesRequested',
  'humanEscalation',
  'reconciliationAnomaly',
] as const

export type ReviewState = (typeof REVIEW_STATES)[number]

/** The two locales the t27.ai site ships. */
export type Locale = 'en' | 'ru'

/* ------------------------------------------------------------------ *
 * The public board payload, as the server sends it                    *
 * ------------------------------------------------------------------ */

/**
 * One public card from /queen/public-board.
 *
 * `number`, `title` and `column` are the pre-existing public shape (see
 * publicBoardProjection in agent-server/apps/server/src/api/routes/
 * queen-kanban.ts); `reviewState` is the additive field from #1316. Everything
 * a guarded surface knows - worker, provider, branch, held-by, refusal text -
 * is absent from this type on purpose: the page cannot leak what it cannot
 * name. The classifier still receives cards as `unknown` rather than this
 * type, because a payload is an answer, not a promise.
 */
export interface PublicReviewCard {
  number: number
  title?: string
  column?: string
  criteria?: number
  needs?: string[]
  /** Additive (#1316). Absent on legacy cards and on non-review cards. */
  reviewState?: string | null
}

/** The public board payload. `pulse` is carried but never rendered (FR-004). */
export interface PublicBoard {
  repo: string
  columns: Array<{ key: string; title: string; blurb: string }>
  cards: PublicReviewCard[]
  pulse?: {
    rounds: number
    bees: number
    verdicts: number
    lastRoundAt: string | null
    roundSeconds: number | null
  }
}

/* ------------------------------------------------------------------ *
 * Copy: every state, both locales                                     *
 * ------------------------------------------------------------------ */

/** What one review state is called, who owns it, and what happens next. */
export interface ReviewStateCopy {
  /** Counter label - names the queue. */
  label: string
  /** Badge: the real owner of the work in this state. */
  owner: string
  /** Badge: the action that is actually pending. */
  action: string
  /** One line under the counter explaining the state. */
  hint: string
}

/**
 * RU/EN for all four states. Every string is translated, none is reused
 * between states within a locale, and the RU is real Russian rather than
 * English in Cyrillic dress - the acceptance scenario asks for consistent
 * translation of ALL FOUR counters and labels, so the contract checks all of
 * them in both locales.
 */
export const REVIEW_STATE_COPY: Record<ReviewState, Record<Locale, ReviewStateCopy>> = {
  queenReviewPending: {
    en: {
      label: 'Queen review pending',
      owner: 'Queen',
      action: 'verdict pending',
      hint: 'finished work the Queen has not judged yet',
    },
    ru: {
      label: 'Ожидает решения Королевы',
      owner: 'Королева',
      action: 'вердикт не вынесен',
      hint: 'работа завершена, но Королева её ещё не оценила',
    },
  },
  changesRequested: {
    en: {
      label: 'Changes requested',
      owner: 'Queen',
      action: 'changes requested - one retry due',
      hint: 'the Queen sent it back; exactly one bounded retry follows',
    },
    ru: {
      label: 'Требуют правки',
      owner: 'Королева',
      action: 'правки запрошены - назначен один повтор',
      hint: 'Королева вернула работу; следует ровно один повтор',
    },
  },
  humanEscalation: {
    en: {
      label: 'Human escalation',
      owner: 'Human',
      action: 'owned by a person',
      hint: 'a person owns this - it is not waiting for the Queen',
    },
    ru: {
      label: 'Передано человеку',
      owner: 'Человек',
      action: 'ведёт человек',
      hint: 'работой владеет человек - Королева её не ждёт',
    },
  },
  reconciliationAnomaly: {
    en: {
      label: 'Reconciliation anomaly',
      owner: 'Unproven',
      action: 'registry and ledger disagree',
      hint: 'no durable owner - the registry mirror must be reconciled',
    },
    ru: {
      label: 'Аномалия сверки',
      owner: 'Не доказано',
      action: 'реестр расходится с журналом',
      hint: 'владелец не подтверждён журналом - нужна сверка',
    },
  },
}

/** Chrome copy for the page, both locales. */
export interface QueenCopy {
  kicker: string
  heading: string
  lede: string
  loading: string
  unavailableTitle: string
  unavailableWhy: string
  emptyQueue: string
  countersAria: string
  updatedPrefix: string
  footerNote: string
}

export const QUEEN_COPY: Record<Locale, QueenCopy> = {
  en: {
    kicker: 'the swarm\u2019s public ledger',
    heading: 'Review queues',
    lede:
      'Four separate queues, one owner each. Every badge names who owns the ' +
      'work and what happens next - nothing on this page is inferred.',
    loading: 'reading the public ledger\u2026',
    unavailableTitle: 'The public board is unreachable',
    unavailableWhy:
      'Counts are hidden rather than guessed: an unreachable ledger proves ' +
      'nothing, and a zero on this page always means the ledger said zero.',
    emptyQueue: 'nothing in this queue - the ledger says so, not the layout',
    countersAria: 'review queues by owner',
    updatedPrefix: 'ledger read at',
    footerNote:
      'Public ledger only - /queen/public-board, no token, no transcripts, ' +
      'no private evidence.',
  },
  ru: {
    kicker: 'публичный журнал роя',
    heading: 'Очереди ревью',
    lede:
      'Четыре отдельные очереди, у каждой один владелец. На каждой карточке ' +
      'указано, кто владеет работой и что будет дальше - здесь нет ничего ' +
      'домысленного.',
    loading: 'читаем публичный журнал\u2026',
    unavailableTitle: 'Публичная доска недоступна',
    unavailableWhy:
      'Счётчики скрыты, а не занулены: недоступный журнал ничего не ' +
      'доказывает, а ноль на этой странице всегда означает, что журнал ' +
      'сказал ноль.',
    emptyQueue: 'в этой очереди ничего - так сказал журнал, а не вёрстка',
    countersAria: 'очереди ревью по владельцам',
    updatedPrefix: 'журнал прочитан',
    footerNote:
      'Только публичный журнал - /queen/public-board, без токена, без ' +
      'транскриптов, без закрытых данных.',
  },
}

/* ------------------------------------------------------------------ *
 * The lifecycle logic (pure, dependency-free, pinned by the contract) *
 * ------------------------------------------------------------------ */

/**
 * `'ru'` for ru and ru-*, `'en'` for everything else.
 *
 * The default is a closed choice, not a guess: an unknown locale falls back to
 * the site's English entry point rather than rendering half-translated chrome.
 */
export function resolveLocale(value: unknown): Locale {
  if (typeof value !== 'string') return 'en'
  const lower = value.toLowerCase()
  return lower === 'ru' || lower.startsWith('ru-') ? 'ru' : 'en'
}

/**
 * Which review queue a public card belongs to, or null when it is not review
 * work at all.
 *
 * THE ORDER OF THE RULES IS THE FALLBACK RULE (FR-002):
 *
 *  1. A card carrying a KNOWN `reviewState` is that state. The additive field
 *     is authoritative when present - it is the server's own derivation from
 *     the durable dispatch ledger.
 *  2. A card carrying an UNKNOWN or empty `reviewState` string is
 *     `reconciliationAnomaly`: the projection used vocabulary this page does
 *     not have, and unproven owner is exactly what anomaly means.
 *  3. A card with NO `reviewState` that sits in the legacy `review` column is
 *     a legacy review card: `reconciliationAnomaly`, visibly. The old column
 *     folded pending, changes-requested and escalation into one word, so its
 *     owner cannot be recovered from the card - and unproven owner is never
 *     Queen debt.
 *  4. Anything else (running, backlog, done...) is not review work: null, and
 *     it is counted nowhere.
 *
 * The input is `unknown` on purpose. A payload is an answer, not a promise,
 * and a malformed card must classify rather than throw - a dashboard that
 * crashes on one bad row shows nothing at all.
 */
export function classifyReviewCard(card: unknown): ReviewState | null {
  if (card === null || typeof card !== 'object') return null
  const record = card as { reviewState?: unknown; column?: unknown }
  const raw = record.reviewState
  if (typeof raw === 'string') {
    return (REVIEW_STATES as readonly string[]).includes(raw)
      ? (raw as ReviewState)
      : 'reconciliationAnomaly'
  }
  if (record.column === LEGACY_REVIEW_COLUMN) return 'reconciliationAnomaly'
  return null
}

/**
 * The four counters, from the same cards the queues are drawn from.
 *
 * Always returns all four keys, so the panel renders four counters whatever
 * the data holds - including a board with no review work at all, where four
 * truthful zeros ARE the fact being reported. Cards that are not review work
 * are counted nowhere (they return null above and are skipped here).
 */
export function reviewQueueCounts(
  cards: readonly unknown[] | null | undefined,
): Record<ReviewState, number> {
  const counts: Record<ReviewState, number> = {
    queenReviewPending: 0,
    changesRequested: 0,
    humanEscalation: 0,
    reconciliationAnomaly: 0,
  }
  if (!Array.isArray(cards)) return counts
  for (const card of cards) {
    const state = classifyReviewCard(card)
    if (state !== null) counts[state] += 1
  }
  return counts
}

/**
 * The copy for one state, failing visible.
 *
 * An unknown state gets the anomaly copy - the same direction as
 * classifyReviewCard - so even a caller that bypasses the classifier cannot
 * render a made-up label for unproven work.
 */
export function reviewCopy(state: ReviewState, locale: Locale): ReviewStateCopy {
  const copy = REVIEW_STATE_COPY[state] ?? REVIEW_STATE_COPY.reconciliationAnomaly
  return copy[locale] ?? copy.en
}

/** The chrome copy for one locale (resolveLocale first). */
export function boardCopy(locale: Locale): QueenCopy {
  return QUEEN_COPY[locale] ?? QUEEN_COPY.en
}

/** The cards of one queue, in the order the ledger sent them. */
export function cardsInQueue(
  cards: readonly unknown[] | null | undefined,
  state: ReviewState,
): unknown[] {
  if (!Array.isArray(cards)) return []
  return cards.filter((card) => classifyReviewCard(card) === state)
}

/* ------------------------------------------------------------------ *
 * Loading the public board                                            *
 * ------------------------------------------------------------------ */

/**
 * Reads the public board.
 *
 * No options object, no headers, no credentials: the route is public and the
 * page is public-ledger-only by construction (FR-003). If the board answers
 * anything other than 200, that is an unavailable board - the caller shows the
 * honest notice rather than zeros.
 */
export async function fetchPublicBoard(
  baseUrl = '',
  path: string = PUBLIC_BOARD_PATH,
): Promise<PublicBoard> {
  const response = await fetch(`${baseUrl}${path}`)
  if (!response.ok) {
    throw new Error(`public board answered ${response.status}`)
  }
  return (await response.json()) as PublicBoard
}

export type QueenBoardStatus = 'loading' | 'ready' | 'unavailable'

/** The state useQueenBoard keeps; exported for the contract's SSR fixtures. */
export interface QueenBoardLoad {
  board: PublicBoard | null
  status: QueenBoardStatus
  fetchedAt: string | null
}

/**
 * Polls the public board every 30 seconds, the same cadence the server-side
 * board shell uses. Only used by the standalone preview - the production site
 * mounts <QueenPage> inside its own router and owns its data flow - but kept
 * here so the preview exercises the page exactly as shipped.
 */
export function useQueenBoard(baseUrl = ''): QueenBoardLoad {
  const [load, setLoad] = useState<QueenBoardLoad>({
    board: null,
    status: 'loading',
    fetchedAt: null,
  })
  useEffect(() => {
    let cancelled = false
    const read = async () => {
      try {
        const board = await fetchPublicBoard(baseUrl)
        if (!cancelled) {
          setLoad({ board, status: 'ready', fetchedAt: new Date().toISOString() })
        }
      } catch {
        // Unreachable is a state, not an exception to swallow into zeros.
        if (!cancelled) setLoad({ board: null, status: 'unavailable', fetchedAt: null })
      }
    }
    void read()
    const timer = setInterval(read, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [baseUrl])
  return load
}

/* ------------------------------------------------------------------ *
 * The page                                                            *
 * ------------------------------------------------------------------ */

export interface QueenPageProps {
  /** The public board payload, or null when it could not be read. */
  board?: PublicBoard | null
  /** Defaults to 'ready' when a board is given, 'loading' when not. */
  status?: QueenBoardStatus
  /** Any BCP-47-ish string; unknown locales resolve to English. */
  locale?: string
  /** When this render's ledger was read, ISO-8601, if the caller knows. */
  fetchedAt?: string | null
}

function ReviewCardLine({
  card,
  repo,
  state,
  locale,
}: {
  card: PublicReviewCard
  repo: string
  state: ReviewState
  locale: Locale
}): JSX.Element {
  const copy = reviewCopy(state, locale)
  const title = typeof card.title === 'string' && card.title.length > 0
    ? card.title
    : `#${card.number}`
  return (
    <article className="queen-card" data-review-card data-review-state={state}>
      <div className="queen-card__head">
        <a
          className="queen-card__number"
          href={`https://github.com/${repo}/issues/${card.number}`}
          target="_blank"
          rel="noreferrer"
        >
          #{card.number}
        </a>
        <h3 className="queen-card__title">{title}</h3>
      </div>
      {/* The badge is the acceptance criterion: it names the real owner and
          the real pending action, in the reader's locale. */}
      <p className="queen-badge" data-review-badge={state}>
        <span className="queen-badge__owner" data-review-owner>
          {copy.owner}
        </span>
        <span className="queen-badge__dot" aria-hidden="true" />
        <span className="queen-badge__action" data-review-action>
          {copy.action}
        </span>
      </p>
    </article>
  )
}

function ReviewQueueSection({
  state,
  cards,
  repo,
  locale,
}: {
  state: ReviewState
  cards: PublicReviewCard[]
  repo: string
  locale: Locale
}): JSX.Element {
  const copy = reviewCopy(state, locale)
  const headingId = `queen-queue-${state}`
  return (
    <section
      className="queen-queue"
      data-review-queue={state}
      aria-labelledby={headingId}
    >
      <header className="queen-queue__head">
        <h2 className="queen-queue__title" id={headingId}>
          {copy.label}
        </h2>
        <span className="queen-queue__count" data-review-queue-count={state}>
          {cards.length}
        </span>
      </header>
      {cards.length === 0 ? (
        <p className="queen-queue__empty">{boardCopy(locale).emptyQueue}</p>
      ) : (
        <ul className="queen-queue__cards">
          {cards.map((card) => (
            <li key={card.number}>
              <ReviewCardLine card={card} repo={repo} state={state} locale={locale} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The Queen review dashboard, as a pure function of its props.
 *
 * Deliberately hook-free: the production router and the QA contract both
 * server-render it with plain arguments, and a presentational page whose
 * truth is entirely its props cannot drift between the two.
 */
export function QueenPage(props: QueenPageProps): JSX.Element {
  const locale = resolveLocale(props.locale)
  const copy = boardCopy(locale)
  const status: QueenBoardStatus = props.status
    ?? (props.board ? 'ready' : 'loading')
  const board = status === 'ready' ? props.board : null
  const repo = board?.repo ?? 'gHashTag/trios'
  const cards = Array.isArray(board?.cards) ? board.cards : []
  const counts = reviewQueueCounts(cards)

  return (
    <section
      className="queen-page"
      data-contract="queen-review-lifecycle"
      data-queen-status={status}
      data-queen-locale={locale}
    >
      <header className="queen-page__header">
        <p className="queen-page__kicker">{copy.kicker}</p>
        <h1 className="queen-page__heading">{copy.heading}</h1>
        <p className="queen-page__lede">{copy.lede}</p>
      </header>

      {status === 'loading' ? (
        <p className="queen-notice" data-queen-notice="loading" role="status">
          {copy.loading}
        </p>
      ) : null}

      {status === 'unavailable' ? (
        <div
          className="queen-notice queen-notice--warn"
          data-queen-notice="unavailable"
          role="alert"
        >
          <p className="queen-notice__title">{copy.unavailableTitle}</p>
          <p className="queen-notice__why">{copy.unavailableWhy}</p>
        </div>
      ) : null}

      {board ? (
        <>
          <div
            className="queen-counters"
            role="list"
            aria-label={copy.countersAria}
          >
            {REVIEW_STATES.map((state) => (
              <div
                key={state}
                className="queen-counter"
                data-review-counter={state}
                role="listitem"
              >
                <b className="queen-counter__n" data-review-count={state}>
                  {counts[state]}
                </b>
                <span className="queen-counter__label">
                  {reviewCopy(state, locale).label}
                </span>
                <span className="queen-counter__hint">
                  {reviewCopy(state, locale).hint}
                </span>
              </div>
            ))}
          </div>

          <div className="queen-queues">
            {REVIEW_STATES.map((state) => (
              <ReviewQueueSection
                key={state}
                state={state}
                cards={cardsInQueue(cards, state) as PublicReviewCard[]}
                repo={repo}
                locale={locale}
              />
            ))}
          </div>

          <footer className="queen-page__footer">
            {props.fetchedAt ? (
              <span className="queen-page__stamp">
                {copy.updatedPrefix}{' '}
                <time dateTime={props.fetchedAt}>{props.fetchedAt}</time>
              </span>
            ) : null}
            <span className="queen-page__note">{copy.footerNote}</span>
          </footer>
        </>
      ) : null}
    </section>
  )
}

export default QueenPage

/* ------------------------------------------------------------------ *
 * The standalone preview artifact                                     *
 * ------------------------------------------------------------------ */

/**
 * The static shell `bun src/pages/Queen.tsx` (with TRIOS_WEBSITE_BUILD=1)
 * emits around the bundled page.
 *
 * This shell exists so the page can be built and inspected WITHOUT the rest of
 * the t27.ai site - the production site mounts <QueenPage> inside its own
 * layout, whose header (original TRINITY logo, language switch, Copy to
 * Agent) and routes (Kanban, Mission Map, Factory, Technology Tree) this
 * issue must not and does not touch. Nothing in here claims to be that site:
 * it is a preview harness for one page.
 */
export function STANDALONE_SHELL(options: {
  jsPath?: string
  cssPath?: string
} = {}): string {
  const jsPath = options.jsPath ?? 'assets/queen.js'
  const cssPath = options.cssPath ?? 'assets/queen.css'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TRINITY \u2014 the Queen\u2019s review queues (page preview)</title>
<meta name="robots" content="noindex" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="${cssPath}" />
<style>
  /* Shell chrome only. The page's own rules live in Queen.css and are all
     scoped under .queen-page, so nothing here or there reaches any other
     surface of the production site. */
  html,body{margin:0;background:#000;color:#fff}
  body{font-family:"Outfit",system-ui,sans-serif;font-weight:300;
    -webkit-font-smoothing:antialiased}
  .preview-bar{padding:.618rem 1.618rem;font-size:.8125rem;color:#888;
    border-bottom:1px solid rgba(255,255,255,.08);display:flex;gap:1rem;
    flex-wrap:wrap;align-items:baseline}
  .preview-bar b{color:#00FF88;font-weight:500;letter-spacing:.14em}
  .preview-note{max-width:72ch;color:#666;font-size:.75rem;line-height:1.5}
  #queen-root{padding:1rem}
  @media(min-width:640px){#queen-root{padding:2.618rem}}
</style>
<script>window.__TRIOS_WEBSITE_STANDALONE__ = true;</script>
<script type="module" src="${jsPath}"></script>
</head>
<body>
<div class="preview-bar">
  <b>TRINITY</b>
  <span class="preview-note">single-page build preview of
    src/pages/Queen.tsx \u2014 the production site renders this page inside its
    own layout, with the original TRINITY logo, RU/EN chrome, Kanban, Mission
    Map, Factory and Technology Tree, none of which this preview replaces.
    The page reads <code>/queen/public-board</code> on its own origin; with no
    board behind this origin it shows the honest unavailable notice.</span>
</div>
<div id="queen-root"></div>
<noscript><p style="padding:1.618rem;color:#FFD700">This page renders in the
browser and reads the public ledger; it needs JavaScript.</p></noscript>
</body>
</html>`
}

/** Reads ?lang= or a /ru/ prefix; the production site passes its own locale. */
function localeFromLocation(): string {
  if (typeof location === 'undefined') return 'en'
  const query = new URLSearchParams(location.search).get('lang')
  if (query) return query
  return location.pathname.startsWith('/ru') ? 'ru' : 'en'
}

/**
 * The preview root: the same page, wired to the same loader the contract
 * exercises. Kept private - the exported surface is the page, the logic, and
 * the shell.
 */
function StandaloneQueen(): JSX.Element {
  const [locale] = useState(() => localeFromLocation())
  const load = useQueenBoard()
  return (
    <QueenPage
      board={load.board}
      status={load.status}
      locale={locale}
      fetchedAt={load.fetchedAt}
    />
  )
}

/**
 * Builds the standalone preview artifact into dist/.
 *
 * `TRIOS_WEBSITE_BUILD=1 bun src/pages/Queen.tsx` runs this (package.json's
 * build script). The import of esbuild is dynamic so the module can be loaded
 * - by the QA contract, or by the production site's bundler - without pulling
 * a build tool into any other context.
 */
async function runStandaloneBuild(outDir = 'dist'): Promise<void> {
  const esbuild = await import('esbuild')
  const result = await esbuild.build({
    entryPoints: ['src/pages/Queen.tsx'],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    minify: true,
    target: ['es2020'],
    define: { 'process.env.NODE_ENV': '"production"' },
    outdir: `${outDir}/assets`,
    entryNames: 'queen',
    assetNames: 'queen',
    chunkNames: 'queen-chunk',
    metafile: true,
    logLevel: 'info',
    // The page module dynamically imports two things that exist only in the
    // build tool's world: esbuild itself and node:fs/promises (both used by
    // this build function and by nothing the browser ever runs). Bundling
    // either into the page artifact would drag node builtins into a browser
    // bundle; keeping them external leaves two import statements that no
    // browser code path executes.
    external: ['esbuild', 'node:fs/promises'],
  })
  const outputs = Object.keys(result.metafile?.outputs ?? {})
  const cssName = outputs
    .map((name) => name.split('/').pop() ?? '')
    .find((name) => name.endsWith('.css'))
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(outDir, { recursive: true })
  const html = STANDALONE_SHELL({
    jsPath: 'assets/queen.js',
    cssPath: cssName ? `assets/${cssName}` : undefined,
  })
  await writeFile(`${outDir}/index.html`, html, 'utf8')
  console.log(`[queen] built ${outDir}/index.html (+ ${outputs.length} assets)`)
}

/* Mount only inside the standalone shell. In the production site, the
   router imports QueenPage and owns the mount; importing this module there
   must not touch the document. */
if (typeof document !== 'undefined') {
  const flag = (
    globalThis as { __TRIOS_WEBSITE_STANDALONE__?: boolean }
  ).__TRIOS_WEBSITE_STANDALONE__
  const root = flag ? document.getElementById('queen-root') : null
  if (root) {
    createRoot(root).render(<StandaloneQueen />)
  }
}

/* The build entry. import.meta.main is Bun's "run as a script" marker. */
const importMeta = import.meta as ImportMeta & { main?: boolean }
if (importMeta.main === true) {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env
  if (env?.TRIOS_WEBSITE_BUILD === '1') {
    void runStandaloneBuild()
  } else {
    console.error(
      '[queen] src/pages/Queen.tsx is a page module. To build the preview ' +
        'artifact, run: TRIOS_WEBSITE_BUILD=1 bun src/pages/Queen.tsx',
    )
  }
}
