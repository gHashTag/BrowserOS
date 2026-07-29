# WAVE-065 - Autonomy, economics, archive, and a Queen who explains herself

Domain: Queen supervisor autonomy and legibility
Context: WAVE-064 made the swarm visible. This wave closes the three options it
offered, archives settled work, and changes how the Queen speaks.

## Weak spots (audit)

| ID | Defect | Evidence |
|----|--------|----------|
| W1 | Settled tasks never left the working view | Accepted work stayed in Swarm forever; the list answering "what needs me" was mostly things that did not |
| W2 | No cost signal at all | Nothing recorded what a bee spent, so an expensive stuck worker looked like a cheap fast one |
| W3 | A stalled bee held its slot forever | `running` with a dead stream never resolved; the hive silently shrank to zero capacity |
| W4 | Worker chats had no identity | Opening one showed a wall of text with no issue, branch, boundary or action |
| W5 | Reports read like a status table | Columns explain nothing; the reason to have a Queen is that she can say why |
| W6 | The log stream stopped at the local file | `TriosLogBus` is OTel-shaped and had no exporter, so the swarm was readable on one machine and nowhere else |

## Literature takeaways (carried from WAVE-064)

1. Per-worker `agent_session_id` and parent/child linkage make a supervisor view
   readable - RudderStack multi-agent event schema.
2. Pull-based supervision beats streaming: heartbeat -> structured log ->
   session doc -> dashboard.
3. OTLP/HTTP JSON logs are a small, stable shape; an SDK is not required to
   speak it.

## Plan

P0 (landed)
- W1 `DelegatedTaskState.isArchivable`, `registry.open` / `.archived`,
  `pruneArchive(limit:)`, collapsible Archive section
- W4 `QueenTaskBanner` above every worker chat, `QueenTaskStatusPill` shared by
  sidebar, strip and banner
- W5 `QueenReviewDigest` rewritten as prose with one explanatory analogy per
  report; every Queen notice now says why

P1 (landed)
- W2 usage captured from SSE `.usage`, accumulated across re-briefs, surfaced
  live in the banner, warned on past `workerTokenWarningThreshold`
- W3 `reapStalledWorkers` on every wake, with a report
- W6 `TriosOTLPExporter`, off unless `TRIOS_OTLP_ENDPOINT` is set

Autonomy: `qualifiesForAutoAccept` closes only work that stayed inside an
explicit boundary, committed something, and cost nothing unusual. Off unless
`TRIOS_QUEEN_AUTONOMY=1`.

P2 (next wave)
- Cost in currency, not tokens: per-provider price table
- `/swarm --history` with spend totals per worker over time
- Parent/child span linkage in the OTLP payload so a worker's trace nests under
  the Queen's
