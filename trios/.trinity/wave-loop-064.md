# WAVE-064 - Queen supervisor surface

Domain: Queen supervisor observability, control, autonomy
Context: WAVE-063 made delegation work end to end. This wave makes it legible:
the supervisor was invisible, every notice looked like an error, and nothing
woke the Queen to review finished work.

## Weak spots (audit)

| ID | Defect | Evidence |
|----|--------|----------|
| W1 | `AI_MissingToolResultsError` permanently poisons a conversation | 4 occurrences in `browseros-companion.log`, thrown from `convertToLanguageModelPrompt`. An aborted turn leaves a tool call with no result; every later send replays it |
| W2 | Error text hard to copy | Copy affordance only on hover, below the bubble |
| W3 | Every system message renders as a red error badge | Delegation, swarm listing and acceptance all show a warning triangle |
| W4 | Registry state and stream state can disagree | A task reads `running` after its stream died; nothing shows the difference |
| W5 | Nothing wakes the Queen | Finished work waits for a human to open the app |

## Literature takeaways

1. **Synthesize, do not strip** (AI SDK troubleshooting; vercel/ai#8216).
   Removing orphaned tool results leaves the model with no tool history and it
   loops calling tools it never sees results for. Inject a cancellation result.
2. **One request, one trace; per-worker `agent_session_id`** (RudderStack
   multi-agent event schema; Claude Managed Agents dashboard). Parent/child
   session linkage is what makes a supervisor view readable.
3. **Pull-based supervision beats streaming** (Why Observability Matters More
   Than Orchestration). Heartbeat -> structured log -> session doc -> dashboard.
   Matches the existing `TriosLogBus` JSONL stream.
4. **Query a running agent without interrupting it** (Datadog agent monitoring;
   claude-code-hooks-multi-agent-observability). The registry plus the runner's
   live conversation set gives this without touching the stream.

## Plan

P0 (landed this wave)
- W1 `repairOrphanToolCalls` -> `agent-server/apps/server/src/agent/message-validation.ts`
- W2 persistent copy button on warning/failure notices -> `BR-OUTPUT/MessageBubbleView.swift`
- W3 `SystemNoticeKind` + marker classifier -> `rings/SR-00/SystemNotice.swift`

P1 (landed this wave)
- W5 `QueenReviewScheduler` 30-minute wake + sleep catch-up -> `rings/SR-02/QueenReviewScheduler.swift`
- W4 live swarm strip with stream-vs-registry disagreement -> `BR-OUTPUT/QueenDashboardView.swift`

P2 (next wave)
- Per-worker token and cost accounting in the dashboard
- `/swarm --history` for accepted and cancelled work
- Stalled-worker auto-cancel with a report

P3-P5 (backlog)
- OTLP export of the `TriosLogBus` stream so external dashboards can read it
- Parent/child `agent_session_id` linkage end to end
- Observer agent that watches a bee and speaks up before it fails
