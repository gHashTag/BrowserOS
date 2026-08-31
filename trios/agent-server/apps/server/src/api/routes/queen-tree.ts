/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The technology tree: what this project is built out of, and what is holding.
 *
 * Every node carries its EVIDENCE - a file:line, a command's output, a quoted
 * line - and the page shows it. That is the whole design constraint. A roadmap
 * whose statuses are opinions is a wish list, and this repository has already
 * paid for several of those: a skill claiming 1.1% stubs where there are none,
 * a gate that "spent months asleep" reporting SKIP as success, a board reading
 * 2 of 29 where the document it descends from has 0 of 29 ticked.
 *
 * So a status here is only as good as the string next to it, and the string is
 * always visible rather than folded away. Where two sources disagree the
 * disagreement is shown as a conflict rather than resolved silently - twelve of
 * them, and each one is a place where somebody would otherwise have trusted the
 * wrong document.
 *
 * The data is generated, not typed: `.trinity/dashboard/tech-tree.json`, read
 * at request time so a regeneration shows up without a deploy.
 */

import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { logger } from '../../lib/logger'

interface TreeNode {
  id: string
  label: string
  layer: string
  status: 'shipped' | 'partial' | 'blocked' | 'planned' | 'unknown'
  evidence: string
  blockedBy?: string
  note?: string
}

interface Tree {
  nodes: TreeNode[]
  edges: Array<{ from: string; to: string }>
  conflicts: string[]
  staleSkills: Array<{ skill: string; staleClaim: string; shouldSay: string }>
}

/**
 * Where the checkout is. In the container the repository is cloned into the
 * workspace volume; on a laptop the server runs from inside the checkout.
 * Both are tried rather than one being assumed, because a dashboard that is
 * blank on a developer's machine is a dashboard nobody develops.
 */
function candidatePaths(): string[] {
  const workspace = process.env.WORKSPACE_DIR || '/workspace'
  return [
    `${workspace}/BrowserOS/trios/.trinity/dashboard/tech-tree.json`,
    `${process.cwd()}/../../.trinity/dashboard/tech-tree.json`,
    `${process.cwd()}/.trinity/dashboard/tech-tree.json`,
  ]
}

async function loadTree(): Promise<Tree | null> {
  for (const path of candidatePaths()) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Tree
    } catch {
      // Try the next one. A missing file here is the normal case for two of
      // the three paths, so it is not worth a log line each.
    }
  }
  logger.warn('Technology tree not found', { tried: candidatePaths() })
  return null
}

const LAYERS = [
  {
    key: 'seed',
    title: 'seed',
    blurb: 'the compiler everything descends from',
  },
  { key: 'ring', title: 'rings', blurb: 'one rule, generated to four targets' },
  { key: 'silicon', title: 'silicon', blurb: 'what reaches a board' },
  { key: 'runtime', title: 'runtime', blurb: 'the server the swarm runs on' },
  { key: 'supervisor', title: 'supervisor', blurb: 'the Queen and her bees' },
  { key: 'interface', title: 'interface', blurb: 'what a person touches' },
]

const STATUS_ORDER = ['blocked', 'partial', 'planned', 'shipped', 'unknown']

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  )
}

function render(tree: Tree): string {
  const counts = tree.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.status] = (acc[n.status] || 0) + 1
    return acc
  }, {})

  const layers = LAYERS.map((layer) => {
    const nodes = tree.nodes
      .filter((n) => n.layer === layer.key)
      .sort(
        (a, b) =>
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
      )
    if (nodes.length === 0) return ''
    const cards = nodes
      .map((n) => {
        const deps = tree.edges.filter((e) => e.from === n.id).map((e) => e.to)
        return `<article class="node ${esc(n.status)}">
          <header><span class="badge">${esc(n.status)}</span>
            <h3>${esc(n.label)}</h3></header>
          ${n.blockedBy ? `<p class="blocked">held by ${esc(n.blockedBy)}</p>` : ''}
          <p class="ev">${esc(n.evidence)}</p>
          ${n.note ? `<p class="note">${esc(n.note)}</p>` : ''}
          ${deps.length ? `<p class="deps">needs ${deps.map((d) => `<code>${esc(d)}</code>`).join(' ')}</p>` : ''}
        </article>`
      })
      .join('')
    return `<section class="layer">
      <div class="layer-head"><h2>${esc(layer.title)}</h2>
        <span class="blurb">${esc(layer.blurb)}</span>
        <span class="count">${nodes.length}</span></div>
      <div class="nodes">${cards}</div>
    </section>`
  }).join('')

  const conflicts = tree.conflicts.map((c) => `<li>${esc(c)}</li>`).join('')

  const skills = tree.staleSkills
    .map(
      (s) => `<tr><td class="mono">${esc(s.skill)}</td>
        <td class="off">${esc(s.staleClaim)}</td>
        <td>${esc(s.shouldSay)}</td></tr>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>trios — technology tree</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
 :root{--phi:1.618;--bg:#000;--panel:#0a0a0f;--border:rgba(255,255,255,.08);
   --accent:#00FF88;--accent-dark:#00CC66;--golden:#FFD700;--text:#fff;--muted:#888;
   --font:"Outfit",system-ui,-apple-system,sans-serif;
   --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
   --f-3:.75rem;--f-2:.8125rem;--f-1:.875rem;--f0:1rem;--f1:1.272rem;--f2:1.618rem;--f3:2.058rem;
   --sp-1:.382rem;--sp0:.618rem;--sp1:1rem;--sp2:1.618rem;--sp3:2.618rem;--max-w:1200px}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);
   font-weight:300;line-height:var(--phi);-webkit-font-smoothing:antialiased}
 .wrap{max-width:var(--max-w);margin:0 auto;padding:var(--sp3) var(--sp2)}
 h1{font-size:var(--f3);font-weight:500;margin:0 0 var(--sp-1);letter-spacing:-.02em}
 h1 span{color:var(--accent)}
 .sub{color:var(--muted);font-size:var(--f-1);margin-bottom:var(--sp2)}
 .tally{display:flex;gap:var(--sp1);flex-wrap:wrap;margin-bottom:var(--sp3);
   font-size:var(--f-1)}
 .tally b{font-weight:500}
 .layer{margin-bottom:var(--sp3)}
 .layer-head{display:flex;align-items:baseline;gap:var(--sp1);
   border-bottom:1px solid var(--border);padding-bottom:var(--sp0);margin-bottom:var(--sp1)}
 .layer-head h2{font-size:var(--f-2);letter-spacing:.16em;text-transform:uppercase;
   color:var(--accent);font-weight:500;margin:0}
 .blurb{color:var(--muted);font-size:var(--f-2);flex:1}
 .count{color:var(--muted);font-size:var(--f-3);font-family:var(--mono)}
 .nodes{display:grid;gap:var(--sp1);
   grid-template-columns:repeat(auto-fit,minmax(310px,1fr))}
 .node{background:var(--panel);border:1px solid var(--border);
   border-left:2px solid var(--muted);
   border-radius:calc(var(--sp0)*var(--phi));padding:var(--sp1) var(--sp2)}
 .node.shipped{border-left-color:var(--accent)}
 .node.partial{border-left-color:var(--golden)}
 .node.blocked{border-left-color:#ff5f56}
 .node.planned{border-left-color:#333}
 .node header{display:flex;align-items:baseline;gap:var(--sp0);flex-wrap:wrap}
 .node h3{font-size:var(--f0);font-weight:500;margin:0 0 var(--sp-1);line-height:1.35}
 .badge{font-size:var(--f-3);letter-spacing:.12em;text-transform:uppercase;
   color:var(--muted);font-family:var(--mono)}
 .node.shipped .badge{color:var(--accent)}
 .node.partial .badge{color:var(--golden)}
 .node.blocked .badge{color:#ff5f56}
 .ev{font-family:var(--mono);font-size:var(--f-3);color:var(--muted);
   margin:var(--sp-1) 0 0;line-height:1.55;word-break:break-word}
 .note{font-size:var(--f-2);color:#bbb;margin:var(--sp0) 0 0}
 .blocked{color:#ff5f56;font-size:var(--f-2);margin:0}
 .deps{font-size:var(--f-3);color:var(--muted);margin:var(--sp0) 0 0}
 code{font-family:var(--mono);font-size:var(--f-3);
   background:rgba(255,255,255,.05);padding:0 .3em;border-radius:3px}
 ol{padding-left:var(--sp2)} ol li{margin-bottom:var(--sp0);font-size:var(--f-1);color:#ccc}
 table{width:100%;border-collapse:collapse;font-size:var(--f-2)}
 th{text-align:left;color:var(--muted);font-size:var(--f-3);letter-spacing:.1em;
   text-transform:uppercase;font-weight:500;padding:var(--sp0);border-bottom:1px solid var(--border)}
 td{padding:var(--sp0);border-bottom:1px solid var(--border);vertical-align:top}
 .mono{font-family:var(--mono)} .off{color:var(--muted)}
 footer{margin-top:var(--sp3);padding-top:var(--sp1);border-top:1px solid var(--border);
   color:var(--muted);font-size:var(--f-3);display:flex;justify-content:space-between;
   gap:var(--sp1);flex-wrap:wrap}
 .phi{color:var(--golden)}
 a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
</style></head>
<body><div class="wrap">
 <h1>trios <span>&#8226;</span> technology tree</h1>
 <div class="sub">Every status carries the evidence that produced it. Where two
   sources disagree, the disagreement is shown rather than resolved.</div>
 <div class="tally">
   <span><b style="color:var(--accent)">${counts.shipped || 0}</b> shipped</span>
   <span><b style="color:var(--golden)">${counts.partial || 0}</b> partial</span>
   <span><b style="color:#ff5f56">${counts.blocked || 0}</b> blocked</span>
   <span><b class="off">${counts.planned || 0}</b> planned</span>
   <span class="off">&#8226; ${tree.nodes.length} nodes, ${tree.edges.length} dependencies</span>
 </div>
 ${layers}
 <section class="layer">
   <div class="layer-head"><h2>conflicts</h2>
     <span class="blurb">two sources, two answers — neither picked for you</span>
     <span class="count">${tree.conflicts.length}</span></div>
   <ol>${conflicts}</ol>
 </section>
 <section class="layer">
   <div class="layer-head"><h2>skills that have gone stale</h2>
     <span class="blurb">a skill whose central claim the tree contradicts</span>
     <span class="count">${tree.staleSkills.length}</span></div>
   <table><thead><tr><th>skill</th><th>says</th><th>should say</th></tr></thead>
   <tbody>${skills}</tbody></table>
 </section>
 <footer>
   <span>&#966;<sup>2</sup> + 1/&#966;<sup>2</sup> = 3 &nbsp; <span class="phi">TRINITY</span></span>
   <span><a href="/queen/dashboard">the swarm &#8594;</a></span>
 </footer>
</div></body></html>`
}

export function createQueenTreeRoute() {
  return new Hono().get('/', async (c) => {
    const tree = await loadTree()
    if (!tree) {
      // Say which file is missing rather than rendering an empty diagram. An
      // empty tree and an unreadable one look identical, and only one of them
      // is a fact about the project.
      return c.html(
        '<pre style="font-family:ui-monospace;padding:2rem;background:#000;color:#888">' +
          'No technology tree found. Expected .trinity/dashboard/tech-tree.json\n' +
          'in the checkout. This is a missing FILE, not an empty project.</pre>',
        503,
      )
    }
    return c.html(render(tree), 200, { 'Cache-Control': 'no-store' })
  })
}
