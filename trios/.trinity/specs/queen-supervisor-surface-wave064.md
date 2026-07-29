# Spec: Queen supervisor surface (WAVE-064)

## Problem

The Queen's chat is the control room of a multi-agent system, and it read like
a crash log. Three separate causes:

1. A single aborted turn made a conversation permanently unusable. The AI SDK
   validates that every tool call has a result before the request leaves; an
   abort persists a call with no result, so every later send on that
   conversation throws `AI_MissingToolResultsError`.
2. Every system message rendered through one badge: red background, warning
   triangle. "Delegated #1086 to queen-swift" and an actual provider failure
   were visually identical, which trains the user to ignore the colour.
3. Nothing surfaced current state. The transcript says what happened, in order,
   forever; a supervisor also needs what is true right now, in one glance.

## Design

### Orphan tool-call repair

`repairOrphanToolCalls` runs inside `filterValidMessages`, so every path that
builds a prompt is covered without a new call site to forget. Any tool part not
in `output-available` or `output-error` is rewritten to `output-error` with an
explicit "interrupted" note.

The call itself is kept. Dropping call and result together leaves the model with
no record of what it attempted, and the observed failure mode is that it repeats
the same call forever without ever seeing an outcome.

### Notice severity

`SystemNoticeKind` is one of `success | info | warning | failure`.
`SystemNoticeClassifier` reads an ASCII marker prefix (`[ok] `, `[i] `, `[!] `,
`[x] `) and strips it before display.

Markers are inline rather than a field on `ChatMessage` because conversations
already on disk have no such field, and a rendering change must not require a
history migration. Unmarked legacy text falls back to a narrow keyword scan;
the phrase list is deliberately small so "Accepted ... probe rejection" is not
classed as a failure for containing the word "rejection".

Warning and failure notices carry a permanently visible copy button. Those are
the messages a user pastes into a bug report, and hiding that button behind
hover made the one message worth copying the hardest to copy.

### Review wake

`QueenReviewScheduler` fires every 30 minutes and on
`NSWorkspace.didWakeNotification`. It composes a digest through
`QueenReviewDigest` and posts it to the Queen's own conversation.

Two rules keep it from becoming noise:

- **Silence when idle.** `QueenReviewDigest.text` returns nil when nothing is
  running and nothing is waiting. A heartbeat that fires regardless of state is
  indistinguishable from noise and gets muted, and a muted supervisor reports
  to nobody.
- **Catch up only after a real gap.** On wake the scheduler reports only if a
  full interval has elapsed, so closing and opening a laptop lid does not spam
  the chat.

Every line carries an age, because a worker that has been "running" for hours is
far more likely to be stuck than busy.

### Swarm strip

`QueenDashboardView` renders above the transcript in the Queen's conversation
only; in a worker's chat it would be noise about other people's work.

Rows are ordered attention-first: work awaiting review, then work in progress.
A supervisor's screen should order by what it wants from you, not by creation
time.

The strip takes the runner's live conversation set alongside the registry. A
task can read `running` in the registry while its stream has already died; the
row then shows `no stream` in orange instead of a green dot that lies.

## Files

- `agent-server/apps/server/src/agent/message-validation.ts` - repair
- `agent-server/apps/server/src/agent/message-validation.test.ts` - 8 tests
- `rings/SR-00/SystemNotice.swift` - severity model
- `rings/SR-00/QueenReviewDigest.swift` - digest text
- `rings/SR-02/QueenReviewScheduler.swift` - wake
- `BR-OUTPUT/QueenDashboardView.swift` - swarm strip
- `BR-OUTPUT/MessageBubbleView.swift` - severity rendering, copy button
- `BR-OUTPUT/FullscreenChatWorkspace.swift` - strip mount
- `rings/SR-02/ChatViewModel.swift` - marked notices, scheduler wiring
- `build.sh` - dashboard added to the lean source list

## Verification

- `bun test apps/server/src/agent/message-validation.test.ts` - 8 pass
- chat SSE e2e - 144 ok, 0 not ok
- `make delegate-probe REVIEW=accept PATHS=docs TASK=...` - delegate, work,
  commit, accept, wake report
