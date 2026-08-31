/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Watching a bee work, as a feed.
 *
 * Until now a running bee was a row that said "started" and, ten minutes later,
 * a commit. Everything in between - what it read, which tool it reached for,
 * what it said about the issue - went into `drain()` and was discarded. There
 * was nothing to click on, which is exactly what it felt like from outside.
 *
 * WHY POLLING AND NOT SSE, having researched the alternative properly:
 *
 *   - `Bun.serve` in this image (oven/bun:1.3.6) applies NO backpressure to a
 *     slow SSE consumer. Measured on 1.3.12: a client that read 6 chunks made
 *     the server produce 40,001 and grow RSS by 3.2 GB in five seconds. Bun's
 *     own notes describe that as the pre-1.4 bug. A live view that can OOM the
 *     Queen because somebody left a tab open is not a live view.
 *   - Hono's `StreamingApi.write` swallows write errors, so the usual
 *     "write in a loop until it throws" disconnect detection never fires -
 *     measured in this codebase on two existing routes, nine heartbeats after
 *     the client had gone, with the `finally` never reached.
 *   - Railway caps an HTTP request at 15 minutes regardless of heartbeats, so
 *     every stream is a lease that must be re-established anyway. The replay
 *     path is mandatory whichever transport is chosen - and once replay exists,
 *     polling IS the replay path with nothing extra.
 *
 * So: `?since=` and a 2-second poll. It cannot leak memory, it cannot hang on a
 * dead socket, it resumes by construction, and the whole client is thirty lines
 * with no reconnection logic to get wrong. SSE is the better answer once the
 * runtime is on Bun 1.4; it is not the better answer today.
 */

import { Hono } from 'hono'
import { Pool } from 'pg'
import { queenLeaseDatabaseUrl } from '../services/queen-lease'

/** The transcript, guarded: this is what the bee said and did. */
export function createQueenFeedDataRoute() {
  return new Hono().get('/', async (c) => {
    const url = queenLeaseDatabaseUrl()
    if (!url) return c.json({ error: 'No database configured' }, 503)
    const conversation = c.req.query('conversation')
    const issue = Number(c.req.query('issue'))
    const since = Number(c.req.query('since') ?? '0')
    const pool = new Pool({ connectionString: url })
    try {
      // By conversation when one is named, otherwise everything for the issue -
      // a bee that was dispatched twice has two conversations, and an operator
      // asking about the ISSUE wants both rather than whichever happens to be
      // latest.
      const rows = conversation
        ? await pool.query(
            `SELECT conversation_id, seq, issue, at, kind, text
               FROM queen_transcript
              WHERE conversation_id = $1 AND seq > $2
              ORDER BY seq LIMIT 500`,
            [conversation, since],
          )
        : await pool.query(
            `SELECT conversation_id, seq, issue, at, kind, text
               FROM queen_transcript
              WHERE issue = $1
              ORDER BY at DESC, seq DESC LIMIT 500`,
            [Number.isFinite(issue) ? issue : -1],
          )
      const dispatch = await pool.query(
        `SELECT issue, branch, started, detail, conversation_id, finished_at,
                outcome, dispatched_at
           FROM queen_dispatch WHERE issue = $1`,
        [Number.isFinite(issue) ? issue : -1],
      )
      return c.json({
        entries: rows.rows.map((r) => ({
          conversationId: r.conversation_id,
          seq: r.seq,
          issue: r.issue,
          at: r.at,
          kind: r.kind,
          text: r.text,
        })),
        dispatch: dispatch.rowCount
          ? {
              issue: dispatch.rows[0].issue,
              branch: dispatch.rows[0].branch,
              detail: dispatch.rows[0].detail,
              conversationId: dispatch.rows[0].conversation_id,
              finishedAt: dispatch.rows[0].finished_at,
              outcome: dispatch.rows[0].outcome,
              dispatchedAt: dispatch.rows[0].dispatched_at,
            }
          : null,
      })
    } finally {
      await pool.end()
    }
  })
}

/**
 * The page. A shell with no state in it, like the board and the dashboard -
 * three routes have leaked in this deployment by rendering state server-side
 * and the shape of the fix is settled now.
 */
export function createQueenFeedRoute() {
  return new Hono().get('/', (c) =>
    c.html(SHELL, 200, { 'Cache-Control': 'no-store' }),
  )
}

const SHELL = `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>trios &#8212; the bee</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
 :root{--phi:1.618;--bg:#000;--panel:#0a0a0f;--border:rgba(255,255,255,.08);
  --accent:#00FF88;--golden:#FFD700;--red:#ff5f56;--text:#fff;--muted:#888;
  --font:"Outfit",system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  --f-3:.7rem;--f-2:.8125rem;--f-1:.875rem;--f0:1rem;--f2:1.618rem;--f3:2.058rem;
  --sp-1:.382rem;--sp0:.618rem;--sp1:1rem;--sp2:1.618rem;--sp3:2.618rem}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);
  font-weight:300;line-height:var(--phi);-webkit-font-smoothing:antialiased}
 .wrap{max-width:70ch;margin:0 auto;padding:var(--sp3) var(--sp2)}
 h1{font-size:var(--f2);font-weight:500;margin:0;letter-spacing:-.01em}
 h1 a{color:var(--accent);text-decoration:none}
 .meta{color:var(--muted);font-size:var(--f-2);margin:var(--sp-1) 0 var(--sp2)}
 .live{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;
  background:var(--accent);box-shadow:0 0 8px var(--accent);margin-right:.4rem;
  animation:pulse 1.6s ease-in-out infinite}
 .live.off{background:var(--muted);box-shadow:none;animation:none}
 @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
 .auth{display:flex;gap:var(--sp0);align-items:center;flex-wrap:wrap;margin-bottom:var(--sp2)}
 input,button{font-family:var(--font);font-size:var(--f-1);border-radius:var(--sp0);
  border:1px solid var(--border);background:var(--panel);color:var(--text);
  padding:var(--sp0) var(--sp1)}
 button{cursor:pointer;border-color:#00CC66;color:var(--accent)}
 .err{color:var(--golden);font-size:var(--f-1);margin-bottom:var(--sp1)}
 .post{display:flex;gap:var(--sp1);padding:var(--sp1) 0;
  border-bottom:1px solid var(--border)}
 .av{flex:0 0 2.2rem;height:2.2rem;border-radius:50%;display:flex;
  align-items:center;justify-content:center;font-family:var(--mono);
  font-size:var(--f-3);font-weight:500;background:#111;border:1px solid var(--border)}
 .av.bee{color:var(--accent);border-color:rgba(0,255,136,.35)}
 .av.tool{color:var(--golden);border-color:rgba(255,215,0,.35)}
 .av.err{color:var(--red);border-color:rgba(255,95,86,.35)}
 .body{flex:1;min-width:0}
 .who{font-size:var(--f-2);font-weight:500}
 .who .h{color:var(--muted);font-weight:300;font-family:var(--mono);
  font-size:var(--f-3);margin-left:var(--sp0)}
 .say{white-space:pre-wrap;word-break:break-word;font-size:var(--f-1);
  margin-top:var(--sp-1)}
 .tool{font-family:var(--mono);font-size:var(--f-3);color:var(--golden);
  background:rgba(255,215,0,.06);border-radius:var(--sp0);
  padding:var(--sp0) var(--sp1);margin-top:var(--sp-1);
  white-space:pre-wrap;word-break:break-all;max-height:14rem;overflow:auto}
 .tool.err{color:var(--red);background:rgba(255,95,86,.06)}
 .empty{color:var(--muted);font-size:var(--f-1);padding:var(--sp2) 0;max-width:56ch}
 footer{margin-top:var(--sp3);padding-top:var(--sp1);border-top:1px solid var(--border);
  color:var(--muted);font-size:var(--f-3);display:flex;gap:var(--sp2);flex-wrap:wrap}
 a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
 .phi{color:var(--golden)}
</style></head>
<body><div class="wrap">
 <h1 id="title">the bee</h1>
 <div class="meta" id="meta"><span class="live off" id="dot"></span>connecting</div>
 <div class="auth" id="auth">
  <input type="password" id="token" placeholder="deployment token" size="30" autocomplete="off" />
  <button id="go">connect</button>
  <label style="color:var(--muted);font-size:var(--f-2);display:flex;gap:.3rem;align-items:center;cursor:pointer"><input type="checkbox" id="remember" style="width:auto;margin:0" checked />remember on this device</label>
  <span style="color:var(--muted);font-size:var(--f-2)">stays in this tab &#8212; never in the URL</span>
 </div>
 <div class="err" id="err"></div>
 <div id="feed"></div>
 <footer>
  <span>&#966;<sup>2</sup> + 1/&#966;<sup>2</sup> = 3 <span class="phi">TRINITY</span></span>
  <span><a href="/queen/kanban">the board &#8594;</a></span>
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
 var q=new URLSearchParams(location.search)
 var issue=q.get('issue')||''
 var conv=q.get('conversation')||''
 var since=0, seen={}, timer=null

 function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
   return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
 function clock(iso){var d=new Date(iso);return isNaN(d)?'':d.toTimeString().slice(0,8)}

 // Auto-scroll ONLY when the reader is already at the bottom. Yanking the view
 // back down while somebody is reading earlier output is the commonest way a
 // live log becomes unusable.
 function atBottom(){return innerHeight+scrollY>=document.body.offsetHeight-120}

 function avatar(kind){
  if(kind==='say') return {c:'bee',s:'BEE',n:'Trinity Bee'}
  if(kind==='error'||kind==='raw') return {c:'err',s:'!',n:kind==='raw'?'unparsed frame':'error'}
  return {c:'tool',s:'{}',n:kind}
 }
 function post(e){
  var a=avatar(e.kind), stick=atBottom()
  var el=document.createElement('div'); el.className='post'
  var inner = e.kind==='say'
    ? '<div class="say">'+esc(e.text)+'</div>'
    : '<div class="tool'+(a.c==='err'?' err':'')+'">'+esc(e.text)+'</div>'
  el.innerHTML='<div class="av '+a.c+'">'+esc(a.s)+'</div><div class="body">'+
   '<div class="who">'+esc(a.n)+'<span class="h">'+clock(e.at)+
   ' &#183; #'+esc(e.issue==null?'?':e.issue)+'</span></div>'+inner+'</div>'
  $('feed').appendChild(el)
  if(stick) scrollTo(0, document.body.scrollHeight)
 }

 function load(){
  if(!token) return
  var u='/queen/feed/data?issue='+encodeURIComponent(issue)+
        (conv?('&conversation='+encodeURIComponent(conv)+'&since='+since):'')
  fetch(u,{headers:{Authorization:'Bearer '+token}})
   .then(function(r){
     if(r.status===403) throw new Error('That token was refused.')
     if(!r.ok) throw new Error('The feed answered '+r.status+'.')
     return r.json()})
   .then(function(d){
     $('auth').hidden=true; $('err').textContent=''
     var dp=d.dispatch
     if(dp){
      if(!conv && dp.conversationId){conv=dp.conversationId; since=0}
      var running=!dp.finishedAt
      $('dot').className='live'+(running?'':' off')
      $('meta').innerHTML='<span class="'+$('dot').className+'" id="dot"></span>'+
       (running?'working':'finished '+clock(dp.finishedAt))+
       ' &#183; <span style="font-family:var(--mono)">'+esc(dp.branch||'')+'</span>'+
       ' &#183; '+esc(dp.detail||'')
     }
     $('title').innerHTML='the bee on <a target="_blank" rel="noreferrer" '+
      'href="https://github.com/gHashTag/trios/issues/'+esc(issue)+'">#'+esc(issue)+'</a>'
     var fresh=d.entries.filter(function(e){
       var k=e.conversationId+':'+e.seq
       if(seen[k]) return false
       seen[k]=1; return true})
     // The no-conversation query returns newest-first; put it back in the order
     // it happened so the page reads downward like a conversation.
     if(!conv) fresh.reverse()
     fresh.forEach(post)
     fresh.forEach(function(e){if(e.seq>since) since=e.seq})
     if(d.entries.length===0 && $('feed').children.length===0){
      $('feed').innerHTML='<div class="empty">No transcript for this issue yet. '+
       'Rows appear while a bee is talking; a turn dispatched before this feed '+
       'existed left no trace, because its bytes were read and discarded.</div>'
     }})
   .catch(function(e){
     $('err').textContent=e.message; $('auth').hidden=false
     sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); token=''
     if(timer){clearInterval(timer); timer=null}})
 }
 function start(){ load(); if(!timer) timer=setInterval(load, 2000) }
 $('go').addEventListener('click',function(){
  token=$('token').value.trim(); if(!token) return
  var keep=$('remember')&&$('remember').checked
  ;(keep?localStorage:sessionStorage).setItem(KEY,token)
  ;(keep?sessionStorage:localStorage).removeItem(KEY); start()})
 $('token').addEventListener('keydown',function(e){if(e.key==='Enter')$('go').click()})
 if(token){$('auth').hidden=true; start()}
})()
</script>
</body></html>`
