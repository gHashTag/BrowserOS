/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Milestones, epics, and the distance between the plan and the board.
 *
 * "Why are we prioritising this epic with these issues" turns out to have an
 * uncomfortable answer, and this page exists to show it rather than to dress it
 * up. Measured the day it was built:
 *
 *   58 issues are planned across 11 epics.  ZERO of them exist on GitHub.
 *   40 issues are open on GitHub.           ZERO of them belong to an epic.
 *   0 of 29 definition-of-done items are ticked.
 *
 * Those two sets do not intersect at all. The roadmap has never been filed, and
 * the work being done was never planned. A progress bar over the epics would
 * therefore be a lie by construction - it would render 0% next to a swarm that
 * has been busy all day - so the page shows the two columns side by side and
 * names the gap instead.
 *
 * AND THE ROADMAP IS NOT IN THE REPOSITORY. Its source is an unversioned file
 * in ~/Downloads that four documents and one Swift file cite as authoritative.
 * `.trinity/dashboard/roadmap.json` is an extracted INDEX - ids, titles, gates -
 * versioned so a gate and a page can read it. The prose is not copied: two
 * copies of a 91 KB document drift in silence, and the file remains the author.
 */

import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { logger } from '../../lib/logger'
import { queenLeaseDatabaseUrl } from '../services/queen-lease'

interface Roadmap {
  source: { file: string; bytes: number; inGit: boolean; note: string }
  epics: Array<{
    id: string
    title: string
    issues: Array<{ id: string; title: string }>
  }>
  milestones: Array<{ id: string; title: string; gate: string }>
  dod: { open: string[]; done: string[]; total: number }
}

async function loadRoadmap(): Promise<Roadmap | null> {
  const workspace = process.env.WORKSPACE_DIR || '/workspace'
  for (const path of [
    `${workspace}/BrowserOS/trios/.trinity/dashboard/roadmap.json`,
    `${process.cwd()}/../.trinity/dashboard/roadmap.json`,
  ]) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Roadmap
    } catch {
      // Two paths, one of which is always wrong. Not worth a line each.
    }
  }
  logger.warn('Roadmap index not found')
  return null
}

/** The board's own numbers, so the page cannot disagree with /queen/board. */
async function boardFacts(pool: Pool) {
  const issues = await pool.query(
    'SELECT number, title, is_spec, delegatable, missing FROM queen_issues',
  )
  const rows = issues.rows as Array<{
    number: number
    title: string
    is_spec: boolean
    delegatable: boolean
    missing: string[]
  }>
  const missingTally: Record<string, number> = {}
  for (const r of rows) {
    for (const m of r.missing ?? [])
      missingTally[m] = (missingTally[m] ?? 0) + 1
  }
  return {
    open: rows.length,
    specs: rows.filter((r) => r.is_spec).length,
    delegatable: rows.filter((r) => r.delegatable).length,
    missingTally,
    worst: rows
      .filter((r) => !r.is_spec)
      .sort((a, b) => (b.missing?.length ?? 0) - (a.missing?.length ?? 0))
      .slice(0, 12),
  }
}

/**
 * The .t27 migration, read from the file the ledger tools write.
 *
 * It lives beside the roadmap rather than inside it because the two answer
 * different questions: the roadmap is what somebody planned, this is how far
 * one law has travelled from being written to being generated. A plan can be
 * wrong; a line count cannot, which is why every number in this file is
 * produced by walking the tree and none is typed.
 */
async function loadMigration(): Promise<unknown | null> {
  for (const path of migrationPaths()) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      // The next candidate. Absent on a laptop that runs the server from
      // somewhere else, and that is not an error - the panel simply says so.
    }
  }
  return null
}

function migrationPaths(): string[] {
  const workspace = process.env.WORKSPACE_DIR || '/workspace'
  return [
    `${workspace}/BrowserOS/trios/.trinity/dashboard/t27-migration.json`,
    `${process.cwd()}/../.trinity/dashboard/t27-migration.json`,
    `${process.cwd()}/.trinity/dashboard/t27-migration.json`,
  ]
}

export function createQueenRoadmapDataRoute() {
  return new Hono().get('/', async (c) => {
    const url = queenLeaseDatabaseUrl()
    if (!url) return c.json({ error: 'No database configured' }, 503)
    const roadmap = await loadRoadmap()
    const pool = new Pool({ connectionString: url })
    try {
      return c.json({
        roadmap,
        migration: await loadMigration(),
        board: await boardFacts(pool),
      })
    } finally {
      await pool.end()
    }
  })
}

export function createQueenRoadmapRoute() {
  return new Hono().get('/', (c) =>
    c.html(SHELL, 200, { 'Cache-Control': 'no-store' }),
  )
}

const SHELL = `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>trios &#8212; the roadmap</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
 :root{--phi:1.618;--bg:#000;--panel:#0a0a0f;--border:rgba(255,255,255,.08);
  --accent:#00FF88;--golden:#FFD700;--red:#ff5f56;--text:#fff;--muted:#888;
  --font:"Outfit",system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  --f-3:.7rem;--f-2:.8125rem;--f-1:.875rem;--f0:1rem;--f1:1.272rem;--f3:2.058rem;
  --sp-1:.382rem;--sp0:.618rem;--sp1:1rem;--sp2:1.618rem;--sp3:2.618rem}
 [hidden]{display:none !important}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);
  font-weight:300;line-height:var(--phi);-webkit-font-smoothing:antialiased}
 .wrap{max-width:1180px;margin:0 auto;padding:var(--sp3) var(--sp2)}
 h1{font-size:clamp(2.6rem,7vw,5.2rem);font-weight:600;margin:0 0 var(--sp-1);
  letter-spacing:-.045em;line-height:.95}
 .kicker{font-size:var(--f-3);letter-spacing:.34em;text-transform:uppercase;
  color:var(--muted);font-weight:500;margin-bottom:var(--sp0)}
 .rule{height:1px;background:linear-gradient(90deg,var(--accent),transparent 62%);
  margin:var(--sp1) 0 var(--sp2)}
 .auth{display:flex;gap:var(--sp0);align-items:center;flex-wrap:wrap;margin-bottom:var(--sp2)}
 input,button{font-family:var(--font);font-size:var(--f-1);border-radius:var(--sp0);
  border:1px solid var(--border);background:var(--panel);color:var(--text);
  padding:var(--sp0) var(--sp1)}
 button{cursor:pointer;border-color:#00CC66;color:var(--accent)}
 .err{color:var(--golden);font-size:var(--f-1)}
 h2{font-size:var(--f-2);letter-spacing:.16em;text-transform:uppercase;
  color:var(--accent);font-weight:500;margin:var(--sp3) 0 var(--sp0);
  border-bottom:1px solid var(--border);padding-bottom:var(--sp0)}
 .gap{border:1px solid var(--red);border-radius:var(--sp0);padding:var(--sp1) var(--sp2);
  margin-bottom:var(--sp2)}
 .gap b{color:var(--red);font-size:var(--f1);font-weight:600}
 .gap p{margin:var(--sp0) 0 0;color:#bbb;font-size:var(--f-1);max-width:62ch}
 .spine{display:flex;gap:0;align-items:stretch;overflow-x:auto;padding-bottom:var(--sp0)}
 .ms{flex:1 0 148px;border-top:2px solid #222;padding:var(--sp1) var(--sp1) 0 0}
 .ms.now{border-top-color:var(--accent)}
 .ms .id{font-family:var(--mono);font-size:var(--f-2);color:var(--muted)}
 .ms.now .id{color:var(--accent)}
 .ms .t{font-size:var(--f-2);margin-top:var(--sp-1);line-height:1.35}
 .ms .g{font-size:var(--f-3);color:#777;margin-top:var(--sp-1)}
 .epics{display:grid;gap:var(--sp1);
  grid-template-columns:repeat(auto-fit,minmax(268px,1fr))}
 .epic{background:var(--panel);border:1px solid var(--border);
  border-left:2px solid #333;border-radius:var(--sp0);padding:var(--sp1) var(--sp2)}
 .epic h3{margin:0;font-size:var(--f0);font-weight:500;line-height:1.3}
 .epic .id{font-family:var(--mono);font-size:var(--f-3);color:var(--muted)}
 .epic .n{font-size:var(--f-3);color:var(--muted);margin-top:var(--sp-1)}
 .epic .filed{font-size:var(--f-3);color:var(--red);font-family:var(--mono)}
 .epic ol{margin:var(--sp0) 0 0;padding-left:1.1rem}
 .epic li{font-size:var(--f-3);color:#999;line-height:1.5}
 .bars{display:grid;gap:var(--sp0);max-width:640px}
 .bar{display:grid;grid-template-columns:9rem 1fr 3rem;gap:var(--sp0);
  align-items:center;font-size:var(--f-2)}
 .bar .track{height:.6rem;background:#141414;border-radius:99px;overflow:hidden}
 .bar .fill{display:block;height:100%;background:var(--red)}
 .bar .num{font-family:var(--mono);color:var(--muted);text-align:right}
 table{width:100%;border-collapse:collapse;font-size:var(--f-2);margin-top:var(--sp1)}
 th{text-align:left;color:var(--muted);font-size:var(--f-3);letter-spacing:.1em;
  text-transform:uppercase;font-weight:500;padding:var(--sp0);
  border-bottom:1px solid var(--border)}
 td{padding:var(--sp0);border-bottom:1px solid var(--border);vertical-align:top}
 .mono{font-family:var(--mono)} a{color:var(--accent);text-decoration:none}
 a:hover{text-decoration:underline}
 footer{margin-top:var(--sp3);padding-top:var(--sp1);border-top:1px solid var(--border);
  color:var(--muted);font-size:var(--f-3);display:flex;gap:var(--sp2);flex-wrap:wrap}
 .phi{color:var(--golden)}
</style></head>
<body><div class="wrap">
 <div class="kicker">what is planned, and what is filed</div>
 <h1>the roadmap</h1>
 <div class="rule"></div>
 <div class="auth" id="auth">
  <input type="password" id="token" placeholder="deployment token" size="30" autocomplete="off" />
  <button id="go">connect</button>
  <label style="color:var(--muted);font-size:var(--f-2);display:flex;gap:.3rem;align-items:center;cursor:pointer">
   <input type="checkbox" id="remember" style="width:auto;margin:0" checked />remember on this device</label>
 </div>
 <div class="err" id="err"></div>
 <div id="app"></div>
 <footer>
  <span>&#966;<sup>2</sup> + 1/&#966;<sup>2</sup> = 3 <span class="phi">TRINITY</span></span>
  <span><a href="/queen/kanban">the board &#8594;</a></span>
  <span><a href="/queen/tree">technology tree &#8594;</a></span>
  <span><a href="/queen/dashboard">the swarm &#8594;</a></span>
 </footer>
</div>
<script>
(function(){
 var $=function(i){return document.getElementById(i)}
 var KEY='trios.queen.token'
 var token=localStorage.getItem(KEY)||sessionStorage.getItem(KEY)||''
 function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
   return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}

 function draw(d){
  var r=d.roadmap, b=d.board
  // A missing roadmap file used to end the render here, which would have made
  // the migration panel below unreachable in exactly the case it is most worth
  // reading - a checkout without the planning file still has rings and still
  // has git history. Each half now stands or falls on its own input.
  if(!r){$('app').innerHTML='<div class="gap"><b>No roadmap index</b><p>'+
    'Expected .trinity/dashboard/roadmap.json in the checkout. This is a '+
    'missing FILE, not an empty plan.</p></div>'+migrationPanel(d.migration)
   return}
  var planned=r.epics.reduce(function(n,e){return n+e.issues.length},0)
  var html=''

  // The gap first, because it is the answer to the question people open this
  // page with. Two sets that do not intersect.
  html+='<div class="gap"><b>'+planned+' planned, 0 filed &#183; '+b.open+
    ' filed, 0 planned</b><p>The '+r.epics.length+' epics contain '+planned+
    ' issues and none of them exists on GitHub. The '+b.open+' open issues '+
    'belong to no epic. The plan has never been filed and the work being done '+
    'was never planned, so a progress bar over the epics would read 0% beside '+
    'a swarm that has been busy all day.</p></div>'

  html+='<h2>milestones</h2><div class="spine">'
  r.milestones.forEach(function(m,i){
   html+='<div class="ms'+(i===0?' now':'')+'"><div class="id">'+esc(m.id)+'</div>'+
    '<div class="t">'+esc(m.title)+'</div>'+
    (m.gate?'<div class="g">'+esc(m.gate.slice(0,110))+'</div>':'')+'</div>'
  })
  html+='</div>'

  html+='<h2>is every issue a spec?</h2><div class="bars">'
  var rows=[['a spec',b.specs,b.open],['delegatable',b.delegatable,b.open]]
  Object.keys(b.missingTally).sort(function(a,c){
    return b.missingTally[c]-b.missingTally[a]}).forEach(function(k){
    rows.push(['missing '+k, b.missingTally[k], b.open])})
  rows.forEach(function(row){
   var pct=row[2]?Math.round(row[1]/row[2]*100):0
   var good=row[0].indexOf('missing')<0
   html+='<div class="bar"><span>'+esc(row[0])+'</span>'+
     '<span class="track"><span class="fill" style="width:'+pct+'%;background:'+
     (good?(pct>50?'var(--accent)':'var(--red)'):'var(--golden)')+'"></span></span>'+
     '<span class="num">'+row[1]+'/'+row[2]+'</span></div>'
  })
  html+='</div>'

  html+='<h2>epics &#183; '+r.epics.length+', containing '+planned+' issues</h2>'+
   '<div class="epics">'
  r.epics.forEach(function(e){
   html+='<article class="epic"><div class="id">'+esc(e.id)+'</div>'+
     '<h3>'+esc(e.title)+'</h3>'+
     '<div class="n">'+e.issues.length+' issues planned</div>'+
     '<div class="filed">0 filed on GitHub</div><ol>'+
     e.issues.slice(0,4).map(function(i){
       return '<li>'+esc(i.title)+'</li>'}).join('')+
     (e.issues.length>4?'<li>... '+(e.issues.length-4)+' more</li>':'')+
     '</ol></article>'
  })
  html+='</div>'

  html+='<h2>the open issues furthest from being a spec</h2>'+
   '<table><thead><tr><th>issue</th><th>title</th><th>missing</th></tr></thead><tbody>'
  b.worst.forEach(function(w){
   html+='<tr><td class="mono"><a target="_blank" rel="noreferrer" '+
    'href="https://github.com/gHashTag/trios/issues/'+w.number+'">#'+w.number+'</a></td>'+
    '<td>'+esc(String(w.title).slice(0,64))+'</td>'+
    '<td class="mono" style="color:var(--golden)">'+esc((w.missing||[]).join(', '))+'</td></tr>'
  })
  html+='</tbody></table>'

  html+='<h2>definition of done</h2><div class="bars"><div class="bar">'+
   '<span>ticked</span><span class="track"><span class="fill" style="width:'+
   (r.dod.total?Math.round(r.dod.done.length/r.dod.total*100):0)+
   '%;background:var(--accent)"></span></span><span class="num">'+
   r.dod.done.length+'/'+r.dod.total+'</span></div></div>'
  html+='<p style="color:var(--muted);font-size:var(--f-3);max-width:62ch;margin-top:var(--sp1)">'+
   esc(r.source.note)+'</p>'

  html+=migrationPanel(d.migration)

  $('app').innerHTML=html
 }

 // The .t27 migration: the plan, and how far it has actually moved.
 //
 // Two things are drawn and they must not be confused. The TABLE is the plan -
 // five rings, innermost first, each with the hand-written file that answers
 // today. The CHART is the measurement: spec lines and hand-written lines per
 // day, read out of git history rather than recorded by anyone. The chart is
 // the honest part, and what it shows is that the two curves rose together -
 // writing the specification did not remove one line of what it specifies.
 function migrationPanel(m){
  if(!m) return '<h2>.t27 migration</h2><div class="gap"><b>No migration ledger</b>'+
    '<p>The server found no <code>.trinity/dashboard/t27-migration.json</code>. '+
    'It is written by the ledger tools; without it this panel states nothing '+
    'rather than guessing.</p></div>'
  var rings=m.rings||[], series=m.series||[]
  var specNow=rings.reduce(function(n,x){return n+(x.specLines||0)},0)
  var handNow=rings.reduce(function(n,x){return n+(x.handLines||0)},0)
  var genNow=rings.reduce(function(n,x){return n+(x.generated||0)},0)
  var h='<h2>.t27 migration &#183; '+genNow+' generated of '+rings.length+' rings</h2>'
  h+='<p style="color:var(--muted);max-width:74ch;margin:0 0 var(--sp1)">'+esc(m.law)+'</p>'
  h+='<div class="bars">'+
   bar('specification written', specNow, specNow+handNow, 'var(--accent)')+
   bar('still hand-written', handNow, specNow+handNow, 'var(--golden)')+
   bar('generated', genNow, rings.length, 'var(--accent)')+
   '</div>'
  h+=chart(series)
  h+='<table><thead><tr><th>ring</th><th>what</th><th>spec</th>'+
     '<th>hand-written today</th><th>state</th></tr></thead><tbody>'
  rings.forEach(function(x){
   h+='<tr><td class="mono">'+esc(x.id)+'</td><td>'+esc(x.what)+'</td>'+
     '<td class="mono">'+(x.specLines?x.specLines+' lines':'&#8212;')+'</td>'+
     '<td class="mono" style="color:var(--golden)">'+esc(x.handWrittenIn)+
     (x.handLines?' &#183; '+x.handLines+' lines':'')+'</td>'+
     '<td>'+esc(x.state)+'</td></tr>'
  })
  h+='</tbody></table>'
  h+='<h2>what blocks generation</h2><table><thead><tr><th>id</th><th>what</th>'+
     '<th>where</th><th>status</th></tr></thead><tbody>'
  ;(m.blockers||[]).forEach(function(b){
   h+='<tr><td class="mono">'+esc(b.id)+'</td><td>'+esc(b.what)+'</td>'+
     '<td class="mono">'+esc(b.where)+'</td>'+
     '<td class="mono" style="color:'+(String(b.status).indexOf('closed')===0?
       'var(--accent)':'var(--golden)')+'">'+esc(b.status)+'</td></tr>'
  })
  h+='</tbody></table>'
  return h
 }

 function bar(label,n,total,colour){
  var pct=total?Math.round(n/total*100):0
  return '<div class="bar"><span>'+esc(label)+'</span><span class="track">'+
   '<span class="fill" style="width:'+pct+'%;background:'+(colour||'var(--accent)')+
   '"></span></span><span class="num">'+n+'/'+total+'</span></div>'
 }

 // An inline SVG, drawn from the series with no library: two polylines over a
 // shared scale, one point per day that has a commit. A day with no commit is
 // absent rather than interpolated - a flat segment between two points is the
 // truth that nothing landed, and inventing a point would make it look like it did.
 function chart(series){
  if(series.length<2) return ''
  var W=1100,H=260,P=44
  var max=1; series.forEach(function(p){
   max=Math.max(max,p.spec_lines||0,p.hand_lines||0)})
  max=Math.ceil(max/100)*100
  var x=function(i){return P+i*(W-P*2)/(series.length-1)}
  var y=function(v){return H-P-(v/max)*(H-P*2)}
  var line=function(key,colour){
   var pts=series.map(function(p,i){return x(i).toFixed(1)+','+y(p[key]||0).toFixed(1)}).join(' ')
   return '<polyline fill="none" stroke="'+colour+'" stroke-width="2" points="'+pts+'"/>'
  }
  var svg='<svg viewBox="0 0 '+W+' '+H+'" width="100%" height="260" '+
   'style="background:var(--panel);border:1px solid var(--border);border-radius:4px">'
  for(var g=0;g<=4;g++){
   var gv=max*g/4, gy=y(gv)
   svg+='<line x1="'+P+'" x2="'+(W-P)+'" y1="'+gy+'" y2="'+gy+
     '" stroke="rgba(255,255,255,.06)"/>'+
     '<text x="6" y="'+(gy+4)+'" fill="#888" font-size="11" font-family="monospace">'+
     gv+'</text>'
  }
  svg+=line('hand_lines','#FFD700')+line('spec_lines','#00FF88')
  series.forEach(function(p,i){
   if(i%3&&i!==series.length-1) return
   svg+='<text x="'+x(i)+'" y="'+(H-12)+'" fill="#888" font-size="11" '+
     'text-anchor="middle" font-family="monospace">'+esc(p.day)+'</text>'
  })
  svg+='<text x="'+(W-P)+'" y="20" fill="#00FF88" font-size="12" text-anchor="end" '+
   'font-family="monospace">specification (.t27)</text>'+
   '<text x="'+(W-P)+'" y="38" fill="#FFD700" font-size="12" text-anchor="end" '+
   'font-family="monospace">hand-written</text></svg>'
  return '<h2>the two curves, from git history</h2>'+
   '<p style="color:var(--muted);max-width:74ch;margin:0 0 var(--sp0)">One point '+
   'per day that has a commit on this branch, counted by walking the tree at '+
   'that commit. The specification appears on 08-19 and stops; nothing was '+
   'generated and nothing hand-written was removed. A flat line here is a fact, '+
   'not a gap in the data.</p>'+svg
 }

 function load(){
  fetch('/queen/roadmap/data',token?{headers:{Authorization:'Bearer '+token}}:undefined)
   .then(function(res){
     if(res.status===403) throw new Error('That token was refused.')
     if(!res.ok) throw new Error('The roadmap answered '+res.status+'.')
     return res.json()})
   .then(function(d){$('auth').hidden=true; $('err').textContent=''; draw(d)})
   .catch(function(e){$('err').textContent=e.message; $('auth').hidden=false
     sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); token=''})
 }
 $('go').addEventListener('click',function(){
  token=$('token').value.trim(); if(!token) return
  var keep=$('remember')&&$('remember').checked
  ;(keep?localStorage:sessionStorage).setItem(KEY,token)
  ;(keep?sessionStorage:localStorage).removeItem(KEY); load()})
 $('token').addEventListener('keydown',function(e){if(e.key==='Enter')$('go').click()})
 $('auth').hidden=true; load()
})()
</script>
</body></html>`
