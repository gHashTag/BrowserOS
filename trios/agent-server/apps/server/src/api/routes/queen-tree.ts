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
 * The data is a hand-maintained file: `.trinity/dashboard/tech-tree.json`,
 * read at request time so an edit shows up without a deploy. Nothing in the
 * repository generates it - a hand-edit is the normal way it changes, and a
 * hand-edit is exactly what breaks it - so the loader, not either consumer,
 * decides whether a given file is a tree, and says which of three ways it
 * failed when it is not: absent, unparseable, or the wrong shape.
 */

import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { logger } from '../../lib/logger'

export interface TreeNode {
  id: string
  label: string
  layer: string
  status: 'shipped' | 'partial' | 'blocked' | 'planned' | 'unknown'
  evidence: string
  blockedBy?: string
  note?: string
}

export interface Tree {
  nodes: TreeNode[]
  edges: Array<{ from: string; to: string }>
  conflicts: string[]
  staleSkills: Array<{ skill: string; staleClaim: string; shouldSay: string }>
}

/**
 * Why a load failed. A consumer that cannot tell these apart sends its reader
 * hunting for a file that is sitting right there: the first loader returned
 * `null` for a file that was absent AND for one that was truncated AND for one
 * that parsed to the wrong shape, and the sentence asserted "missing FILE"
 * every time. `unreadable` is the rare fourth case - a file that exists but
 * cannot be read (permissions, a directory where the file should be) - which
 * is not "not found" either. The detail carries only facts the loader
 * established; where it could not establish one, the field says so.
 */
export type TreeLoadFailureKind =
  | 'not-found'
  | 'unparseable'
  | 'wrong-shape'
  | 'unreadable'

export interface TreeLoadFailure {
  /** The discriminator. A Tree never carries an `ok` field. */
  readonly ok: false
  /** Which of the failures occurred - the thing a consumer must not guess. */
  readonly kind: TreeLoadFailureKind
  /** Paths tried, parse position, first failing field - for the log and /queen/tree. */
  readonly detail: Record<string, unknown>
}

/** What loadTree hands back: a usable tree, or the reason there is none. */
export type TreeLoadResult = Tree | TreeLoadFailure

export function isTreeLoadFailure(value: unknown): value is TreeLoadFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  )
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
    // The container: the repository is cloned into the workspace volume.
    `${workspace}/BrowserOS/trios/.trinity/dashboard/tech-tree.json`,
    // A laptop: the server runs from `trios/agent-server`, so the project root
    // is ONE level up, not two. The first version had `../../` and reached
    // `BrowserOS/.trinity`, which does not exist - the page would have rendered
    // "no tree found" on the very machine the file was written on.
    `${process.cwd()}/../.trinity/dashboard/tech-tree.json`,
    `${process.cwd()}/.trinity/dashboard/tech-tree.json`,
  ]
}

export async function loadTree(): Promise<TreeLoadResult> {
  const tried = candidatePaths()
  for (const path of tried) {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Absent is the normal case for two of the three paths, so it is not
      // worth a log line each. Anything else - permissions, a directory where
      // the file should be - is a file that EXISTS and cannot be used, which
      // must not be reported as "not found".
      if (code === 'ENOENT') continue
      return logTreeLoadFailure({
        ok: false,
        kind: 'unreadable',
        detail: { path, readError: code ?? String(error) },
      })
    }

    // The first candidate that exists is THE tree. A corrupt one is reported,
    // not stepped over: falling through to a later candidate would hide the
    // file the reader actually needs to fix.
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return logTreeLoadFailure({
        ok: false,
        kind: 'unparseable',
        detail: {
          path,
          parseError: error instanceof Error ? error.message : String(error),
          position: locateJsonError(raw),
          length: raw.length,
        },
      })
    }

    const shape = firstShapeFailure(parsed)
    if (shape) {
      return logTreeLoadFailure({
        ok: false,
        kind: 'wrong-shape',
        detail: { path, ...shape },
      })
    }

    return parsed as Tree
  }

  return logTreeLoadFailure({
    ok: false,
    kind: 'not-found',
    detail: { tried },
  })
}

function logTreeLoadFailure(failure: TreeLoadFailure): TreeLoadFailure {
  logger.warn('Technology tree unavailable', {
    kind: failure.kind,
    ...failure.detail,
  })
  return failure
}

const NODE_STATUSES = ['shipped', 'partial', 'blocked', 'planned', 'unknown']

function typeOf(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(
  record: Record<string, unknown>,
  at: string,
  key: string,
): { field: string; expected: string; found: string } | null {
  if (typeof record[key] !== 'string') {
    return {
      field: `${at}.${key}`,
      expected: 'string',
      found: typeOf(record[key]),
    }
  }
  return null
}

/**
 * The first field the consumers read that is missing or mistyped, or null when
 * the value can be handed to render() and projectTree() as a Tree.
 *
 * This lives in the loader - not in either consumer - so the two cannot
 * disagree about what a valid tree is. It checks exactly the fields the
 * consumers touch and no others: a schema library would either reject files
 * the page renders happily or wave through fields the page crashes on. No
 * schema library, no dependencies - a walk down the fields, naming the first
 * one that would break a consumer.
 */
function firstShapeFailure(
  value: unknown,
): { field: string; expected: string; found: string } | null {
  if (!isPlainObject(value)) {
    return {
      field: '(the whole file)',
      expected: 'an object with nodes, edges, conflicts and staleSkills',
      found: typeOf(value),
    }
  }
  return (
    nodesShapeFailure(value) ??
    edgesShapeFailure(value) ??
    conflictsShapeFailure(value) ??
    staleSkillsShapeFailure(value)
  )
}

function nodesShapeFailure(value: Record<string, unknown>) {
  if (!Array.isArray(value.nodes)) {
    return {
      field: 'nodes',
      expected: 'an array of nodes',
      found: typeOf(value.nodes),
    }
  }
  for (let index = 0; index < value.nodes.length; index++) {
    const failure = nodeShapeFailure(value.nodes[index], `nodes[${index}]`)
    if (failure) return failure
  }
  return null
}

function nodeShapeFailure(node: unknown, at: string) {
  if (!isPlainObject(node)) {
    return { field: at, expected: 'an object', found: typeOf(node) }
  }
  for (const key of ['id', 'label', 'layer'] as const) {
    const failure = requireString(node, at, key)
    if (failure) return failure
  }
  if (
    typeof node.status !== 'string' ||
    !(NODE_STATUSES as readonly string[]).includes(node.status)
  ) {
    return {
      field: `${at}.status`,
      expected: `one of ${NODE_STATUSES.join(', ')}`,
      found: typeOf(node.status),
    }
  }
  const evidence = requireString(node, at, 'evidence')
  if (evidence) return evidence
  for (const key of ['blockedBy', 'note'] as const) {
    if (node[key] !== undefined && typeof node[key] !== 'string') {
      return {
        field: `${at}.${key}`,
        expected: 'string when present',
        found: typeOf(node[key]),
      }
    }
  }
  return null
}

function edgesShapeFailure(value: Record<string, unknown>) {
  if (!Array.isArray(value.edges)) {
    return {
      field: 'edges',
      expected: 'an array of {from, to}',
      found: typeOf(value.edges),
    }
  }
  for (let index = 0; index < value.edges.length; index++) {
    const edge = value.edges[index]
    const at = `edges[${index}]`
    if (!isPlainObject(edge)) {
      return { field: at, expected: 'an object', found: typeOf(edge) }
    }
    const from = requireString(edge, at, 'from')
    if (from) return from
    const to = requireString(edge, at, 'to')
    if (to) return to
  }
  return null
}

function conflictsShapeFailure(value: Record<string, unknown>) {
  if (!Array.isArray(value.conflicts)) {
    return {
      field: 'conflicts',
      expected: 'an array of strings',
      found: typeOf(value.conflicts),
    }
  }
  for (let index = 0; index < value.conflicts.length; index++) {
    if (typeof value.conflicts[index] !== 'string') {
      return {
        field: `conflicts[${index}]`,
        expected: 'string',
        found: typeOf(value.conflicts[index]),
      }
    }
  }
  return null
}

function staleSkillsShapeFailure(value: Record<string, unknown>) {
  if (!Array.isArray(value.staleSkills)) {
    return {
      field: 'staleSkills',
      expected: 'an array of {skill, staleClaim, shouldSay}',
      found: typeOf(value.staleSkills),
    }
  }
  for (let index = 0; index < value.staleSkills.length; index++) {
    const skill = value.staleSkills[index]
    const at = `staleSkills[${index}]`
    if (!isPlainObject(skill)) {
      return { field: at, expected: 'an object', found: typeOf(skill) }
    }
    for (const key of ['skill', 'staleClaim', 'shouldSay'] as const) {
      const failure = requireString(skill, at, key)
      if (failure) return failure
    }
  }
  return null
}

/**
 * WHERE a JSON parse failed, for an engine that reports only WHAT.
 *
 * JavaScriptCore throws `JSON Parse error: Expected ']'` with no offset
 * attached, so a sentence that names the parse position has to establish the
 * position itself. This walks the JSON grammar and stops at the first byte it
 * cannot accept; that offset is the position. It runs only AFTER JSON.parse
 * has refused the text - JSON.parse stays the authority on WHETHER the file
 * parses, this only locates the error it reported. If the walk somehow
 * completes on text JSON.parse refused, it returns null and the sentence says
 * the position was not established rather than inventing one.
 */
function locateJsonError(text: string): number | null {
  let i = 0
  const end = text.length
  const whitespace = ' \t\n\r'

  const skipWhitespace = () => {
    while (i < end && whitespace.includes(text[i])) i++
  }

  const scanString = (): boolean => {
    // The opening quote is at i.
    i++
    while (i < end) {
      const c = text[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '"') {
        i++
        return true
      }
      i++
    }
    return false // the file ended inside the string
  }

  const scanLiteral = (): boolean => {
    for (const keyword of ['true', 'false', 'null']) {
      if (text.startsWith(keyword, i)) {
        i += keyword.length
        return true
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(i),
    )
    if (number && number[0].length > 0) {
      i += number[0].length
      return true
    }
    return false
  }

  const scanValue = (): boolean => {
    skipWhitespace()
    if (i >= end) return false
    const c = text[i]
    if (c === '{') return scanObject()
    if (c === '[') return scanArray()
    if (c === '"') return scanString()
    return scanLiteral()
  }

  const scanArray = (): boolean => {
    i++ // the opening bracket
    skipWhitespace()
    if (i < end && text[i] === ']') {
      i++
      return true
    }
    for (;;) {
      if (!scanValue()) return false
      skipWhitespace()
      if (i >= end) return false
      if (text[i] === ',') {
        i++
        continue
      }
      if (text[i] === ']') {
        i++
        return true
      }
      return false
    }
  }

  const scanObject = (): boolean => {
    i++ // the opening brace
    skipWhitespace()
    if (i < end && text[i] === '}') {
      i++
      return true
    }
    for (;;) {
      skipWhitespace()
      if (i >= end || text[i] !== '"') return false
      if (!scanString()) return false
      skipWhitespace()
      if (i >= end || text[i] !== ':') return false
      i++
      if (!scanValue()) return false
      skipWhitespace()
      if (i >= end) return false
      if (text[i] === ',') {
        i++
        continue
      }
      if (text[i] === '}') {
        i++
        return true
      }
      return false
    }
  }

  try {
    if (!scanValue()) return Math.min(i, end)
    skipWhitespace()
    return i < end ? i : null
  } catch {
    // A walk this deep blew the stack on the same text that blew JSON.parse's.
    return null
  }
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
<title>trios &#8212; technology tree</title>
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
 /* The hidden attribute is a UA rule and loses to any author display rule.
    A rule like .auth{display:flex} therefore kept the token form on screen
    while el.hidden was true - measured: hidden=true, computed display=flex,
    57 cards behind it. Anything hidden must actually be hidden.
    NO BACKTICKS: this is inside a template literal. Fourth time today. */
 [hidden]{display:none !important}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);
   font-weight:300;line-height:var(--phi);-webkit-font-smoothing:antialiased}
 .wrap{max-width:var(--max-w);margin:0 auto;padding:var(--sp3) var(--sp2)}
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
 <div class="kicker">what this is built out of</div>
 <h1>technology<br/>tree</h1>
 <div class="rule"></div>
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
     <span class="blurb">two sources, two answers &#8212; neither picked for you</span>
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
   <span><a href="/queen/kanban">the board &#8594;</a> &nbsp; <a href="/queen/dashboard">the swarm &#8594;</a></span>
 </footer>
</div></body></html>`
}

/**
 * The 503 page. One sentence per established cause - the reader of a broken
 * dashboard is the person fixing the file, so the page tells them which state
 * they are in rather than a cause the loader never checked.
 */
function failurePage(failure: TreeLoadFailure): string {
  const lines: string[] = []
  if (failure.kind === 'not-found') {
    lines.push('No technology tree found. None of the expected files exist:')
    for (const path of (failure.detail.tried as string[]) ?? []) {
      lines.push(`  ${path}`)
    }
    lines.push('This is a missing FILE, not an empty project.')
  } else if (failure.kind === 'unparseable') {
    lines.push('The technology tree was found but could not be parsed as JSON:')
    lines.push(`  path: ${failure.detail.path}`)
    lines.push(`  parse error: ${failure.detail.parseError}`)
    lines.push(`  parse position: ${describePosition(failure.detail)}`)
  } else if (failure.kind === 'wrong-shape') {
    lines.push(
      'The technology tree was found and parsed, but it does not have the expected shape:',
    )
    lines.push(`  path: ${failure.detail.path}`)
    lines.push(
      `  first failing field: ${failure.detail.field} (expected ${failure.detail.expected}, found ${failure.detail.found})`,
    )
  } else {
    lines.push('The technology tree was found but could not be read:')
    lines.push(`  path: ${failure.detail.path}`)
    lines.push(`  read error: ${failure.detail.readError}`)
  }
  return `<pre style="font-family:ui-monospace;padding:2rem;background:#000;color:#888">${lines.map(esc).join('\n')}</pre>`
}

function describePosition(detail: Record<string, unknown>): string {
  const position = detail.position
  if (typeof position !== 'number') {
    // The engine refused the file and the walk could not place it. Say that
    // rather than offering a number nobody established.
    return 'not established by the parser'
  }
  const length = typeof detail.length === 'number' ? detail.length : NaN
  return position === length ? `${position} (end of input)` : String(position)
}

export function createQueenTreeRoute() {
  return new Hono().get('/', async (c) => {
    const result = await loadTree()
    if (isTreeLoadFailure(result)) {
      return c.html(failurePage(result), 503)
    }
    return c.html(render(result), 200, { 'Cache-Control': 'no-store' })
  })
}
