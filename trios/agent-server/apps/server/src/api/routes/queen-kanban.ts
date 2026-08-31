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

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  )
}

interface RegistryTask {
  issue?: { owner?: string; repo?: string; number?: number }
  title?: string
  state?: string
  worker?: string
  ownedPaths?: string[]
}

async function build(pool: Pool): Promise<Card[]> {
  const variant = process.env.TRIOS_VARIANT || 'prod'
  const [registry, dispatches, issues] = await Promise.all([
    pool.query('SELECT tasks FROM queen_registry WHERE variant = $1', [
      variant,
    ]),
    pool.query(
      `SELECT issue, branch, started, detail, finished_at
         FROM queen_dispatch WHERE started = true AND finished_at IS NULL`,
    ),
    pool.query('SELECT number, title, owned_paths FROM queen_issues'),
  ])

  const tasks: RegistryTask[] = registry.rowCount
    ? (registry.rows[0].tasks as RegistryTask[])
    : []

  const cards = new Map<number, Card>()

  // The registry first: it is the account of record, and an issue that has a
  // task is described by that task rather than by its own openness.
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
    const rank = COLUMNS.findIndex((c) => c.key === card.column)
    const prior = existing
      ? COLUMNS.findIndex((c) => c.key === existing.column)
      : -1
    if (!existing || rank > prior) cards.set(number, card)
  }

  // The issue list, keyed, so a dispatch can borrow the title and boundary its
  // own row does not carry. Without this the RUNNING column - the one an
  // operator looks at first - showed bare numbers where every other column had
  // a sentence, because a dispatch the app never saw has no registry task to
  // take a title from.
  const known = new Map<number, { title: string; paths: string[] }>()
  for (const row of issues.rows) {
    known.set(row.number as number, {
      title: row.title as string,
      paths: (row.owned_paths ?? []) as string[],
    })
  }

  // Then what the container has in flight, which the registry mirror cannot
  // know about: it is written by the app.
  for (const row of dispatches.rows) {
    const number = row.issue as number
    const prior = cards.get(number)
    cards.set(number, {
      number,
      title: prior?.title ?? known.get(number)?.title ?? `#${number}`,
      column: 'running',
      paths: prior?.paths?.length
        ? prior.paths
        : (known.get(number)?.paths ?? []),
      detail: String(row.detail ?? '').slice(0, 140),
      worker: 'cloud tick',
    })
  }

  // Finally the open issues nobody has taken. Held-versus-free is decided by
  // the same rule the Queen uses: does any NON-terminal task own an
  // overlapping path.
  const holding = tasks.filter(
    (t) =>
      t.state === 'running' ||
      t.state === 'queued' ||
      t.state === 'awaitingReview' ||
      t.state === 'rejected',
  )
  for (const row of issues.rows) {
    const number = row.number as number
    if (cards.has(number)) continue
    const paths: string[] = row.owned_paths ?? []
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
      .filter((t) => (t.ownedPaths ?? []).some((p) => paths.includes(p)))
      .map((t) => `#${t.issue?.number}`)
    cards.set(number, {
      number,
      title: row.title as string,
      column: heldBy.length > 0 ? 'blocked' : 'backlog',
      paths,
      heldBy: heldBy.length > 0 ? heldBy : undefined,
    })
  }

  return [...cards.values()].sort((a, b) => b.number - a.number)
}

function render(cards: Card[], repo: string): string {
  const columns = COLUMNS.map((col) => {
    const mine = cards.filter((c) => c.column === col.key)
    const body = mine.length
      ? mine
          .map(
            (c) => `<article class="card ${esc(col.key)}">
        <a class="num" href="https://github.com/${esc(repo)}/issues/${c.number}"
           target="_blank" rel="noreferrer">#${c.number}</a>
        <div class="t">${esc(c.title)}</div>
        ${c.worker ? `<div class="who">${esc(c.worker)}</div>` : ''}
        ${c.heldBy ? `<div class="held">held by ${esc(c.heldBy.join(', '))}</div>` : ''}
        ${c.paths.length ? `<div class="paths">${c.paths.map((p) => `<code>${esc(p)}</code>`).join(' ')}</div>` : ''}
        ${c.detail ? `<div class="d">${esc(c.detail)}</div>` : ''}
      </article>`,
          )
          .join('')
      : '<div class="empty">nothing here</div>'
    return `<section class="col">
      <div class="col-head"><h2>${esc(col.title)}</h2><span class="n">${mine.length}</span></div>
      <div class="col-blurb">${esc(col.blurb)}</div>
      <div class="cards">${body}</div>
    </section>`
  }).join('')

  return `<!doctype html>
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
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);
  font-weight:300;line-height:var(--phi);-webkit-font-smoothing:antialiased}
 .wrap{padding:var(--sp3) var(--sp2)}
 h1{font-size:var(--f3);font-weight:500;margin:0 0 var(--sp-1);letter-spacing:-.02em}
 h1 span{color:var(--accent)}
 .sub{color:var(--muted);font-size:var(--f-1);margin-bottom:var(--sp2)}
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
  border-left:2px solid var(--muted);border-radius:var(--sp0);
  padding:var(--sp1) var(--sp1)}
 .card.running{border-left-color:var(--accent)}
 .card.review{border-left-color:var(--golden)}
 .card.blocked{border-left-color:var(--red)}
 .card.done{border-left-color:#2a6}
 .card.dropped{border-left-color:#333}
 .num{font-family:var(--mono);font-size:var(--f-2);color:var(--accent);
  text-decoration:none}
 .num:hover{text-decoration:underline}
 .t{font-size:var(--f-1);margin:var(--sp-1) 0;line-height:1.4}
 .who{font-size:var(--f-3);color:var(--accent);font-family:var(--mono)}
 .held{font-size:var(--f-3);color:var(--red);font-family:var(--mono)}
 .paths{margin-top:var(--sp-1)}
 .d{font-size:var(--f-3);color:var(--muted);margin-top:var(--sp-1);
  word-break:break-word}
 code{font-family:var(--mono);font-size:var(--f-3);color:var(--muted);
  background:rgba(255,255,255,.05);padding:0 .3em;border-radius:3px;
  display:inline-block;margin:1px 0;word-break:break-all}
 .empty-board{border:1px solid var(--golden);border-radius:var(--sp0);
  padding:var(--sp1) var(--sp2);color:var(--golden);font-size:var(--f-1);
  margin-bottom:var(--sp2);max-width:60ch}
 .empty{color:#333;font-size:var(--f-3);padding:var(--sp1) 0}
 footer{margin-top:var(--sp3);padding-top:var(--sp1);border-top:1px solid var(--border);
  color:var(--muted);font-size:var(--f-3);display:flex;gap:var(--sp2);flex-wrap:wrap}
 a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
 .phi{color:var(--golden)}
</style></head>
<body><div class="wrap">
 <h1>trios <span>&#8226;</span> the board</h1>
 <div class="sub">${cards.length} issues from <code>${esc(repo)}</code>.
   Columns are the Queen's own states, not invented ones &#8212; every card
   clicks through to its issue.</div>
 <div class="board">${columns}</div>
 <footer>
  <span>&#966;<sup>2</sup> + 1/&#966;<sup>2</sup> = 3 <span class="phi">TRINITY</span></span>
  <span><a href="/queen/tree">technology tree &#8594;</a></span>
  <span><a href="/queen/dashboard">the swarm &#8594;</a></span>
 </footer>
</div></body></html>`
}

export function createQueenKanbanRoute() {
  return new Hono().get('/', async (c) => {
    const url = queenLeaseDatabaseUrl()
    if (!url) {
      return c.html(
        '<pre style="padding:2rem;background:#000;color:#888;font-family:ui-monospace">' +
          'No database configured, so there is no board to draw.\n' +
          'This is a missing DATABASE_URL, not an empty swarm.</pre>',
        503,
      )
    }
    const repo = process.env.TRIOS_GITHUB_REPO || 'gHashTag/trios'
    const pool = new Pool({ connectionString: url })
    try {
      const cards = await build(pool)
      // Six empty columns say nothing about why they are empty. A board drawn
      // against a database that simply has no swarm in it looks identical to a
      // quiet swarm, and only one of those is a fact about the project - the
      // same distinction the tree makes between a missing file and an empty
      // one. Measured on a laptop: the local server answered 200 and rendered
      // six empty columns because its database is not the one the Queen writes
      // to.
      if (cards.length === 0) {
        return c.html(
          render(cards, repo).replace(
            '<div class="board">',
            '<div class="empty-board">This database holds no registry, no ' +
              'dispatches and no issues. That is a database without a swarm ' +
              'in it, not a swarm with nothing to do - the Queen writes to ' +
              "the deployment's Postgres, so a local server pointed " +
              'elsewhere draws this.</div><div class="board">',
          ),
          200,
          { 'Cache-Control': 'no-store' },
        )
      }
      return c.html(render(cards, repo), 200, { 'Cache-Control': 'no-store' })
    } finally {
      await pool.end()
    }
  })
}
