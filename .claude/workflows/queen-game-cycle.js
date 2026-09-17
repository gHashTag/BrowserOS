export const meta = {
  name: 'queen-game-cycle',
  description: 'One research cycle of the Queen game loop: audit weak spots from two lenses, research competitors from two angles, scan for anomalies, then synthesize a decomposed backlog delta with acceptance criteria',
  whenToUse: 'When the queen-game-loop backlog is thin or every fourth cycle; args = { cycle, backlog: [...open task titles], liveFacts: "..." }',
  phases: [
    { title: 'Audit', detail: 'weak spots: player lens + engineering lens' },
    { title: 'Competitors', detail: 'agent-swarm visualisers + strategy HUD/UX patterns' },
    { title: 'Anomalies', detail: 'live surfaces vs claims' },
    { title: 'Plan', detail: 'synthesize backlog delta with acceptance criteria' },
  ],
}

const ctx = args || {}
const CONTEXT = `
THE SUBJECT: the Queen game at https://t27.ai/#/queen - a one-screen 4X-style command HUD over a live autonomous coding swarm (TriOS: the Queen supervisor dispatches "bee" agents on GitHub issues). Code: ~/trinity-game/apps/website/src/pages/Queen.tsx, src/components/Queen*.tsx, src/components/queenHud.ts (read them). Standing context with every decision and its measurement: /Users/playra/tri-27/docs/game/CONTEXT.md (read it first). Lessons: ~/skills/queen-game-loop/LESSONS.md.
Public endpoints (read-only, no write endpoint exists): https://trios-agent-server-production.up.railway.app/queen/{status,public-board,public-research,public-hardware,public-activity?since=0}.
HARD RULES the plan must respect: every number on screen is an endpoint field or a COPY key (absent data = dash, never zero); no fake actions (no END TURN); no engine, canvas2D; the mark is the cell; palette from the live Queen CSS; no TRI token minting; one slice per cycle, each slice verifiable by a command.
Cycle: ${ctx.cycle ?? '?'}. Open backlog now: ${JSON.stringify(ctx.backlog ?? [])}. Live facts this cycle: ${ctx.liveFacts ?? 'none given'}.
Return raw data for the synthesizer, not prose for a human.`

const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] }, evidence: { type: 'string' }, proposal: { type: 'string' }, effort: { type: 'string', enum: ['S', 'M', 'L'] } }, required: ['title', 'severity', 'evidence', 'proposal', 'effort'] } } }, required: ['findings'] }
const COMPETITORS = { type: 'object', properties: { entries: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, what: { type: 'string' }, takeaway: { type: 'string' }, applies: { type: 'boolean' } }, required: ['name', 'url', 'what', 'takeaway', 'applies'] } } }, required: ['entries'] }
const PLAN = { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', description: 'P0-1 .. P3-n; unique; reuse an existing id only to update it' }, title: { type: 'string' }, acceptance: { type: 'string', description: 'a command or an observable that proves it' }, evidence: { type: 'string' }, effort: { type: 'string', enum: ['S', 'M', 'L'] }, depends: { type: 'array', items: { type: 'string' } } }, required: ['id', 'title', 'acceptance', 'evidence', 'effort'] } }, findings: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, severity: { type: 'string' }, evidence: { type: 'string' } }, required: ['title', 'severity', 'evidence'] } }, variants: { type: 'array', items: { type: 'string' }, description: 'three cooperation variants for the next loop: what the user would do vs what the loop does, and why' } }, required: ['tasks', 'findings', 'variants'] }

phase('Audit')
const audit = await parallel([
  () => agent(`${CONTEXT}\nLENS: THE PLAYER. Open https://t27.ai/#/queen in a browser tool if one is available (BrowserOS neo preferred; otherwise fetch the endpoints with curl and read the code). Judge it as a strategy-game player and as an operator of the swarm: what does the screen fail to tell me, what is confusing, what has no feedback, what would make me come back? Cite the code line or the endpoint field for every weak spot; propose the smallest change that fixes it, with effort S/M/L. 6-10 findings, no filler.`, { label: 'audit:player', phase: 'Audit', schema: FINDINGS }),
  () => agent(`${CONTEXT}\nLENS: THE ENGINEER. Read the code. Find: data-honesty leaks (a value not traceable to an endpoint field), hooks/effects risks, performance (per-frame allocations, canvas backing size, 120-event feed reflow), accessibility, the 5 s/2 s polling load, mobile, error states when an endpoint fails, anything the viewport contract does not cover. Cite file:line for every finding; propose the smallest fix with effort S/M/L. 6-10 findings, no filler.`, { label: 'audit:engineer', phase: 'Audit', schema: FINDINGS }),
])

phase('Competitors')
const competitors = await parallel([
  () => agent(`${CONTEXT}\nRESEARCH: how do the best products VISUALISE a swarm of autonomous coding agents or a fleet of workers in real time? Look at agent dashboards and observability UIs (e.g. OpenHands, Devin, Cursor background agents, GitHub Copilot coding agent, Langfuse/AgentOps/LangSmith traces, Screeps as the programming MMO, Kubernetes/Grafana fleet views, Datadog Live). Use WebSearch/WebFetch (or BrowserOS neo if available). For each: name, URL, what they do that our HUD does not, one concrete takeaway that fits our hard rules, and whether it applies. 6-8 entries.`, { label: 'competitors:agent-viz', phase: 'Competitors', schema: COMPETITORS }),
  () => agent(`${CONTEXT}\nRESEARCH: strategy-game HUD and UX patterns that turn a live system into a game people return to: XCOM 2012 Mission Control/Geoscape, StarCraft II command card and minimap alerts, Stellaris outliner, Factorio production stats, Frostpunk book of laws, Slay the Spire map, Duolingo/Habitica streaks and rewards, EVE Online industry. Use WebSearch/WebFetch (or BrowserOS neo). For each: name, URL, the pattern, one concrete takeaway that fits our hard rules (no fake actions, honest numbers), whether it applies. 6-8 entries.`, { label: 'competitors:game-ux', phase: 'Competitors', schema: COMPETITORS }),
])

phase('Anomalies')
const anomalies = await agent(`${CONTEXT}\nANOMALY HUNT. Compare what the page CLAIMS with what the live surfaces SAY, right now: fetch the five endpoints with curl and read the code that renders each number; run 'python3 ~/skills/queen-game-loop/scripts/anomalies.py' and read its output; check that the served chunk at t27.ai is the one built from trinity main (curl the entry bundle, then the Queen-*.js it names); check the git state of ~/trinity-game. Report only discrepancies with evidence (a value, a header, a line), severity, and the smallest fix. Refute your own findings before reporting.`, { label: 'anomalies', phase: 'Anomalies', schema: FINDINGS })

phase('Plan')
const plan = await agent(`${CONTEXT}\nYOU ARE THE PLANNER. Inputs:\nAUDIT (player): ${JSON.stringify(audit[0]?.findings ?? [])}\nAUDIT (engineer): ${JSON.stringify(audit[1]?.findings ?? [])}\nCOMPETITORS (agent viz): ${JSON.stringify(competitors[0]?.entries ?? [])}\nCOMPETITORS (game UX): ${JSON.stringify(competitors[1]?.entries ?? [])}\nANOMALIES: ${JSON.stringify(anomalies?.findings ?? [])}\n\nProduce the decomposed plan as a backlog DELTA against the open backlog given above: tasks with ids P0-n (must land now: broken or dishonest), P1-n (next cycles: highest value per effort), P2-n, P3-n (research). Each task is ONE slice a single cycle can finish and verify with a command or an observable; write that acceptance criterion; name the evidence it comes from; effort S/M/L; dependencies by id. Prefer S tasks that move the game forward visibly. Do not include tasks that need a new backend endpoint unless marked P3 with the endpoint named. Also list the confirmed findings (severity, evidence) and THREE cooperation variants for the next loop (A/B/C: what the user would do vs what the loop does, and why it is worth it).`, { label: 'plan', phase: 'Plan', schema: PLAN })

return { audit, competitors, anomalies, plan }
