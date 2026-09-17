# T27 Wave Loop - Plan WAVE-061

Domain: chat TODO/plan subsystem after the dynamic-steps change (WAVE-060 follow-up)
Context: Plans now grow with the observed work instead of a fixed three-step
template. That removed the original defect but introduced three new weak spots,
two of them in code this session added.

## Audit - weak spots

| ID | Weak spot | Evidence |
|----|-----------|----------|
| W1 | `shouldDisplayPlan` is dead code. It was added so a trivial turn renders no checklist, but nothing calls it - `grep` finds zero references outside its own file. The promised "no empty skeleton" behaviour does not happen. | `grep -rn shouldDisplayPlan` returns only the definition |
| W2 | Plan length is unbounded. `beginStep` appends on every new activity with no cap, so a long agent run can produce an arbitrarily long checklist that buries the active row and grows the persisted record without limit. | `TODOPlanner.beginStep`; no cap in the file |
| W3 | Write amplification. Every step transition calls `mutatePlan` -> `persist` -> `store.savePlan`, which writes to the SQLCipher-encrypted database. Steps used to change about twice per turn; they now change once per tool call. | `mutatePlan` always awaits `persist` |
| W4 | The planner itself has no unit tests. WAVE-060 tested the pure deriver (26 checks) but not the stateful transitions - exactly where W1-W3 live. | no `tests/swift/*todo_planner*` suite |

## Competitor research

- **LangChain agent streams** - the closest analogue to W3 on the read side:
  detailed messages, tool calls, and state changes stream only when a UI asks
  for them, so a dashboard shows high-level progress across a tree of work
  without paying wire cost for every token from every worker. Takeaway: the
  cheap summary and the expensive detail are different channels; do not pay
  detail cost for summary-level updates.
- **Deep Agents subagent snapshots** - a lightweight record says a subagent
  exists, where it sits, and its lifecycle state, without carrying streamed
  messages or tool calls. Takeaway for W2: a step should stay a cheap record;
  volume belongs behind a disclosure, not in the list.
- **assistant-ui multi-agent** - a tool call carrying a `messages` field renders
  as a nested thread, recursively. Takeaway: nesting is the accepted answer to
  list length, and it is the natural P1 once the list is bounded.
- **AgentScope PlanNotebook** - `create_plan`, `revise_current_plan`,
  `update_subtask_state`, `finish_subtask`, `finish_plan`. Takeaway: revision is
  a first-class operation, so the model must tolerate mid-run plan edits rather
  than assuming append-only.

## P0 (critical, must land now)

- W1 -> wire `shouldDisplayPlan` into `ChatPanelView.queenActivityFeed` so a
  one-step turn renders nothing.
- W2 -> cap the visible/persisted step count in `TODOPlanner`, coalescing the
  overflow rather than dropping it silently.
- W3 -> coalesce persistence: keep the in-memory plan authoritative and flush on
  terminal states or after a quiet interval, not on every step.
- W4 -> add `tests/swift/todo_planner_state_test.swift` covering the transitions.

## P1 (high, next wave)

- Nested sub-steps for delegated work, per assistant-ui's recursive tool-call
  threads.
- Plan revision: let the model reorder or rewrite pending steps mid-run.

## P2 (medium)

- Per-step duration and token cost, shown on the row.
- Persist a compact plan history so a finished turn can be reopened.

## P3-P5 (backlog / research)

- Cross-conversation plan templates learned from repeated workflows.
- Approval gate before execution, as AgentScope offers.
