/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The hive, on one screen.
 *
 * The operator's words: "a game-like visual, one page, all the information, a
 * control centre". The board answers "what is on the list"; this answers "what
 * is the machine doing right now, and what can I press".
 *
 * WHY A SECOND PAGE RATHER THAN A BIGGER BOARD. The board is a list and reads
 * like one: columns, cards, a card per issue. A control room is the opposite
 * shape - a few large readings, a capacity gauge, one action. Growing the board
 * into both would leave neither legible, and the board is the page that works.
 *
 * SHELL AND GUARDED DATA, the same pattern the other queen pages use. The HTML
 * carries NO state: every number arrives from `/queen/board`, which requires
 * the bearer token. A page that embedded the swarm's state would publish it to
 * anyone who found the URL, which is how `/queen/kanban` once served 57 cards
 * and every bee's detail to an unauthenticated reader.
 *
 * EVERY NODE draw() writes into is permanent and assigned, never appended. The
 * board's flow strip was built fresh and spliced in on each 30-second redraw
 * and nothing removed the last one; the operator's screen carried a hundred and
 * twenty copies of the legend. A drawing function that appends is a leak with a
 * timer on it.
 */

import { Hono } from 'hono'

const SHELL = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Queen HQ</title>
<style>
 :root{
  --bg:#07090c; --panel:#0e1319; --panel2:#131a22; --border:#1e2933;
  --fg:#e6edf3; --muted:#7d8b99; --accent:#00ff88; --golden:#e3b341;
  --red:#ff5c5c; --blue:#5cc8ff;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  --f-2:.72rem; --f-1:.83rem; --sp0:.55rem; --sp1:1.1rem;
 }
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.5 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif}
 .wrap{max-width:1180px;margin:0 auto;padding:var(--sp1)}
 header{display:flex;align-items:baseline;gap:var(--sp1);flex-wrap:wrap;
  margin-bottom:var(--sp0)}
 h1{font-size:clamp(1.3rem,2.6vw,1.9rem);margin:0;letter-spacing:-.02em}
 .sub{color:var(--muted);font-size:var(--f-1)}
 .auth{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;
  margin:var(--sp0) 0;padding:var(--sp0);border:1px solid var(--border);
  border-radius:8px;background:var(--panel)}
 .auth[hidden]{display:none !important}
 input[type=password]{background:#05070a;border:1px solid var(--border);
  color:var(--fg);border-radius:6px;padding:.4rem .6rem;font-family:var(--mono)}
 button{background:var(--panel2);border:1px solid var(--border);color:var(--fg);
  border-radius:6px;padding:.42rem .8rem;cursor:pointer;font-size:var(--f-1)}
 button:hover{border-color:var(--accent);color:var(--accent)}
 button[disabled]{opacity:.45;cursor:not-allowed;border-color:var(--border);
  color:var(--muted)}
 .err{color:var(--red);font-size:var(--f-1);min-height:1.2em}

 /* the verdict: the one sentence the page exists for */
 .verdict{margin:var(--sp0) 0;padding:var(--sp1);border:1px solid var(--border);
  border-left:4px solid var(--accent);border-radius:10px;background:var(--panel)}
 .verdict[hidden]{display:none !important}
 .verdict.idle{border-left-color:var(--red)}
 .verdict h2{margin:0;font-size:clamp(1.25rem,3vw,2.1rem);line-height:1.14;
  letter-spacing:-.02em}
 .verdict p{margin:.5rem 0 0;color:var(--muted);font-size:var(--f-1);
  max-width:76ch}
 .verdict code{color:var(--golden);font-family:var(--mono)}

 /* the hive: one cell per worker slot */
 .hive{display:flex;gap:.5rem;flex-wrap:wrap;margin:var(--sp1) 0 var(--sp0)}
 .cell{width:96px;height:96px;border:1px solid var(--border);border-radius:10px;
  background:var(--panel);display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:.18rem;font-family:var(--mono);font-size:var(--f-2);
  color:var(--muted);position:relative;overflow:hidden}
 .cell .n{font-size:1.05rem;color:var(--fg)}
 .cell.busy{border-color:rgba(0,255,136,.5);color:var(--accent)}
 .cell.busy .n{color:var(--accent)}
 .cell.busy::after{content:"";position:absolute;inset:auto 0 0 0;height:3px;
  background:var(--accent);animation:pulse 1.6s ease-in-out infinite}
 .cell.locked{border-style:dashed;opacity:.5}
 @keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}

 /* readings */
 .gauges{display:grid;gap:.6rem;
  grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:var(--sp0) 0}
 .g{border:1px solid var(--border);border-radius:10px;background:var(--panel);
  padding:.7rem .8rem}
 .g b{display:block;font-size:1.7rem;line-height:1.1;font-family:var(--mono)}
 .g .lbl{color:var(--muted);font-size:var(--f-2);text-transform:uppercase;
  letter-spacing:.06em}
 .g .why{color:var(--muted);font-size:var(--f-2);margin-top:.3rem;opacity:.8}
 .g.good b{color:var(--accent)} .g.warn b{color:var(--golden)}
 .g.bad b{color:var(--red)}

 /* the pipeline, as a strip */
 .flow{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin:var(--sp0) 0}
 .flow i{font-style:normal;background:var(--panel);border:1px solid var(--border);
  border-radius:999px;padding:.24rem .7rem;font-size:var(--f-2);color:var(--muted)}
 .flow i.on{color:var(--accent);border-color:rgba(0,255,136,.4)}
 .flow s{text-decoration:none;color:#31404d}

 .cols{display:grid;gap:.5rem;
  grid-template-columns:repeat(auto-fit,minmax(120px,1fr));margin:var(--sp0) 0}
 .col{border:1px solid var(--border);border-radius:8px;background:var(--panel2);
  padding:.55rem .7rem}
 .col b{font-family:var(--mono);font-size:1.2rem}
 .col span{display:block;color:var(--muted);font-size:var(--f-2)}

 .panel{border:1px solid var(--border);border-radius:10px;background:var(--panel);
  padding:var(--sp0) var(--sp1);margin:var(--sp0) 0}
 .panel h3{margin:.2rem 0 .5rem;font-size:var(--f-1);color:var(--muted);
  text-transform:uppercase;letter-spacing:.08em}
 .row{display:flex;gap:.6rem;align-items:baseline;padding:.28rem 0;
  border-top:1px solid var(--border);font-size:var(--f-1)}
 .row:first-of-type{border-top:none}
 .row .k{font-family:var(--mono);color:var(--golden);min-width:5.2em}
 .row .t{color:var(--muted);flex:1}
 .row a{color:var(--blue);text-decoration:none}
 .row a:hover{text-decoration:underline}
 footer{color:var(--muted);font-size:var(--f-2);display:flex;gap:var(--sp1);
  flex-wrap:wrap;margin-top:var(--sp1);padding-top:var(--sp0);
  border-top:1px solid var(--border)}
 footer a{color:var(--muted)}
</style>
</head><body><div class="wrap">
<header>
 <h1>Queen HQ</h1>
 <span class="sub" id="sub">connect to see the hive</span>
</header>

<div class="auth" id="auth">
 <input type="password" id="token" placeholder="deployment token" size="30" autocomplete="off" />
 <button id="go">connect</button>
 <label style="color:var(--muted);font-size:var(--f-2);display:flex;gap:.3rem;align-items:center;cursor:pointer"><input type="checkbox" id="remember" style="width:auto;margin:0" checked />remember on this device</label>
 <span class="sub">never in the URL - sent as a header</span>
</div>
<div class="err" id="err"></div>

<!-- Permanent nodes. draw() ASSIGNS into these and never inserts a sibling:
     the board's legend was spliced in on every redraw and nothing removed the
     last one, so an hour-old tab carried a hundred and twenty copies. -->
<div class="verdict" id="verdict" hidden></div>
<div class="hive" id="hive"></div>
<div class="flow" id="flow" hidden></div>
<div class="gauges" id="gauges"></div>
<div class="cols" id="cols"></div>

<div class="panel" id="controls" hidden>
 <h3>control</h3>
 <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
  <button id="tick">run a round now</button>
  <button id="refresh">refresh</button>
  <span class="sub" id="tickmsg"></span>
 </div>
</div>

<div class="panel" id="livepanel" hidden>
 <h3>in flight and awaiting a verdict</h3>
 <div id="live"></div>
</div>

<footer>
 <span>&#966;<sup>2</sup> + 1/&#966;<sup>2</sup> = 3</span>
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
  var p=d.pulse||{}, by={}
  d.cards.forEach(function(c){by[c.column]=(by[c.column]||0)+1})
  var free=d.cards.filter(function(c){
    return c.column==='backlog' && c.paths && c.paths.length}).length
  var noBoundary=(by.backlog||0)-free
  var run=by.running||0
  var keys=Math.max((p.workerKeys||0)-(p.workerKeysRefused||0),0)
  var limit=p.workerLimit||4
  var ceiling=Math.min(keys||0,limit)

  // THE HIVE. One cell per slot the swarm could actually fill, which is the
  // smaller of the policy limit and the number of provider keys - a page that
  // drew four cells while one key existed would invite a hunt for three
  // missing bees that were never possible.
  var running=d.cards.filter(function(c){return c.column==='running'})
  var cells=''
  for(var i=0;i<Math.max(ceiling,1);i++){
   var b=running[i]
   cells+='<div class="cell'+(b?' busy':'')+'">'+
     (b?('<span class="n">#'+esc(b.number)+'</span><span>working</span>')
       :'<span class="n">-</span><span>free</span>')+'</div>'
  }
  for(var j=ceiling;j<limit;j++){
   cells+='<div class="cell locked"><span class="n">-</span><span>no key</span></div>'
  }
  $('hive').innerHTML=cells

  // The one sentence. Her own reason comes first, because the page is read by
  // someone asking "why is nothing happening" and the Queen already wrote the
  // answer down.
  var v=$('verdict'), head, why
  if(run>0){
   head=run===1?'One bee is working right now.':run+' bees are working right now.'
   why='Each has its own checkout and its own branch. The board shows what it holds.'
  } else if(free>0){
   head='Nothing is running, and '+free+' issue'+(free===1?' is':'s are')+' ready.'
   why='She wakes on a timer, so this is the gap between rounds. Press <b>run a round now</b> to close it.'
  } else {
   head='Nothing is running, and there is nothing she may start.'
   why='Her own reason, from the last round: <code>'+esc(p.lastRefusal||'nothing to choose')+'</code>. '+
     (noBoundary>0?noBoundary+' issues name no files, so nothing can be reserved for them. ':'')+
     ((by.review||0)>0?(by.review)+' finished and hold their files until judged.':'')
  }
  v.className='verdict'+(run>0?'':' idle')
  v.innerHTML='<h2>'+esc(head)+'</h2><p>'+why+'</p>'+
   '<p>Capacity: <b>'+run+' of '+ceiling+'</b> busy. '+
   (keys===0?'This deployment holds <b>no provider key</b>, so no bee can start at all.'
    :keys<limit?('The policy allows '+limit+' and this deployment holds <b>'+keys+
      ' provider key'+(keys===1?'':'s')+'</b> - one bee per key, so '+keys+' is the real ceiling.')
    :'Keys are not the limit here.')+'</p>'
  v.hidden=false

  $('flow').innerHTML=
   '<i'+(free>0?' class="on"':'')+'>1 pick</i><s>&#8594;</s>'+
   '<i'+(run>0?' class="on"':'')+'>2 branch</i><s>&#8594;</s>'+
   '<i'+(run>0?' class="on"':'')+'>3 work</i><s>&#8594;</s>'+
   '<i'+((by.review||0)>0?' class="on"':'')+'>4 verdict</i><s>&#8594;</s>'+
   '<i'+((by.done||0)>0?' class="on"':'')+'>5 land</i>'
  $('flow').hidden=false

  var mins=p.roundSeconds?Math.round(p.roundSeconds/60):null
  var tok=((p.inputTokens||0)+(p.outputTokens||0))/1000
  $('gauges').innerHTML=
   '<div class="g '+(run>0?'good':'bad')+'"><b>'+run+'</b><span class="lbl">bees working</span>'+
     '<div class="why">a bee is one model turn in its own checkout</div></div>'+
   '<div class="g '+(free>0?'good':'warn')+'"><b>'+free+'</b><span class="lbl">she may start</span>'+
     '<div class="why">an issue is delegatable once it names its files</div></div>'+
   '<div class="g '+(noBoundary>0?'warn':'')+'"><b>'+noBoundary+'</b><span class="lbl">no boundary</span>'+
     '<div class="why">nothing can be reserved for these</div></div>'+
   '<div class="g"><b>'+(p.rounds||0)+'</b><span class="lbl">rounds / 24h</span>'+
     '<div class="why">'+(mins?'wakes every '+mins+' min':'timer not set')+'</div></div>'+
   '<div class="g"><b>'+(p.bees||0)+'</b><span class="lbl">bees started / 24h</span>'+
     '<div class="why">'+(p.verdicts||0)+' verdicts given</div></div>'+
   '<div class="g"><b>'+tok.toFixed(1)+'k</b><span class="lbl">tokens / 24h</span>'+
     '<div class="why">absent where a turn reported none</div></div>'

  $('cols').innerHTML=(d.columns||[]).map(function(c){
    return '<div class="col"><b>'+(by[c.key]||0)+'</b><span>'+esc(c.title)+'</span></div>'
  }).join('')

  var interesting=d.cards.filter(function(c){
    return c.column==='running'||c.column==='review'||c.column==='blocked'})
  $('live').innerHTML=interesting.length===0
    ? '<div class="row"><span class="t">Nothing in flight and nothing waiting on a verdict.</span></div>'
    : interesting.map(function(c){
      return '<div class="row"><span class="k">'+esc(c.column)+'</span>'+
        '<span class="t"><a href="https://github.com/'+esc(d.repo)+'/issues/'+esc(c.number)+
        '" target="_blank" rel="noopener">#'+esc(c.number)+'</a> '+esc(c.title||'')+
        (c.detail?' &#183; '+esc(c.detail):'')+'</span></div>'
    }).join('')
  $('livepanel').hidden=false
  $('controls').hidden=false
  $('sub').textContent=d.cards.length+' issues from '+d.repo+
    ' &#183; '.replace('&#183;','\\u00b7')+'live'
 }

 function load(){
  if(!token){$('auth').hidden=false;return}
  $('err').textContent=''
  fetch('/queen/board',{headers:{Authorization:'Bearer '+token}})
   .then(function(r){
     if(r.status===401||r.status===403){throw new Error('That token was refused.')}
     if(!r.ok){throw new Error('The board answered '+r.status+'.')}
     return r.json()})
   .then(function(d){$('auth').hidden=true;draw(d)})
   .catch(function(e){$('err').textContent=String(e.message||e);$('auth').hidden=false})
 }

 $('go').addEventListener('click',function(){
   token=$('token').value.trim()
   if(!token)return
   ;($('remember').checked?localStorage:sessionStorage).setItem(KEY,token)
   load()
 })
 $('token').addEventListener('keydown',function(e){if(e.key==='Enter')$('go').click()})
 $('refresh').addEventListener('click',load)
 $('tick').addEventListener('click',function(){
   // The one action this page offers, and it is the one the operator kept
   // asking for by hand: wake her now instead of waiting out the timer.
   var b=$('tick'); b.disabled=true; $('tickmsg').textContent='running a round...'
   fetch('/queen/lease/tick',{method:'POST',headers:{Authorization:'Bearer '+token}})
    .then(function(r){return r.json()})
    .then(function(d){
      var c=(d&&d.choice)||{}
      $('tickmsg').textContent = c.chosen
        ? ('chose #'+c.chosen)
        : ('nothing started - '+(c.refusal||'no reason given'))
      load()
    })
    .catch(function(e){$('tickmsg').textContent='the round failed: '+(e.message||e)})
    .then(function(){b.disabled=false})
 })

 load()
 setInterval(load, 20000)
})()
</script>
</body></html>`

export function createQueenHqRoute() {
  return new Hono().get('/', (c) =>
    c.html(SHELL, 200, { 'Cache-Control': 'no-store' }),
  )
}
