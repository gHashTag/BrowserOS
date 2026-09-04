# Memory Control Center

Task: `MEMORY-CONTROLS-001`

Issue: T27-EPIC-001

## Problem

Trios can search and use durable memory, but the memory drawer is read-only.
Users cannot browse recent records, forget one record, or clear memory for the
current task without deleting the whole conversation and its execution plan.
An in-flight recall can also reintroduce a record after a deletion action.

## Product Evidence

- ChatGPT exposes review, individual deletion, and delete-all controls:
  https://help.openai.com/en/articles/8590148-memory-faq
- Claude exposes project-scoped memory controls and incognito conversations:
  https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- Gemini exposes activity deletion and retention controls:
  https://support.google.com/gemini/answer/13278892
- Linear and Todoist require explicit destructive actions and make completion
  reversible:
  https://linear.app/docs/delete-archive-issues
  https://www.todoist.com/help/articles/introduction-to-tasks-080OAXric

## Scope

This wave implements a bounded control surface:

1. Browse the newest saved memories without entering a search query.
2. Forget one memory after an explicit confirmation.
3. Clear only memories created by the current conversation after an explicit
   confirmation.
4. Keep messages, conversation metadata, and the TODO plan unchanged.
5. Prevent stale recall or search results from restoring deleted records.

Memory enable/disable, temporary chat, retention periods, global erase, import,
and export are separate future waves.

## Storage Contract

- `recentMemories(limit:)` returns newest-first records with UUID as a stable
  tie-breaker and a hard maximum of 64.
- `deleteMemory(id:)` is idempotent and returns whether a row was deleted.
- `deleteMemories(conversationId:)` deletes only memory rows for that
  conversation and returns the deleted row count.
- Durable deletion uses parameterized SQLite statements inside transactions.
- Existing FTS5 delete triggers remove deleted rows from recall.
- Durable and volatile stores implement identical behavior.
- Plan rows and conversation history are never mutated by memory-only methods.

## Service and Lifecycle Contract

- Service deletion methods throw storage errors; they never report false
  success.
- Chat state removes a record from `recalledMemories` only after the store
  confirms deletion.
- Clearing current-task memory disables persistence for the current pending
  turn so that the same turn cannot recreate memory after the clear action.
- Every successful memory mutation increments a memory revision.
- Recall captured before a revision change is discarded before prompt
  construction.
- UI search captured before a revision change is discarded before display.

## Terminal Stream Contract

- Exhaustion of an asynchronous transport sequence is transport EOF, not proof
  that the agent completed its turn.
- Only an explicit `.finish` event completes the active plan and permits durable
  memory persistence for the turn.
- EOF without `.finish`, `.abort`, or `.error` fails the active plan with a
  stable protocol error, clears the assistant streaming indicator, and leaves
  chat in a visible error state.
- Partial assistant content from an interrupted stream may remain in
  conversation history for diagnosis, but it is never stored as durable memory.
- Explicit abort and error events retain their existing cancellation and
  failure semantics.
- Every terminal outcome clears `isStreaming` on active assistant messages
  before asynchronous cleanup or stream-generation invalidation.
- Explicit Stop and thrown transport errors use the same terminal UI finalizer
  as finish, abort, SSE error, and unterminated EOF.
- Every terminal outcome captures an immutable `(conversationId, messages)`
  snapshot before a long memory write or stream-generation invalidation.
- A completed response is persisted to its original conversation even when the
  user navigates away while long-term memory is still being written.
- Explicit Stop persists the finalized partial response to its original
  conversation before navigation or relaunch can discard the live UI state.
- Deleting an active conversation captures and finalizes its current history
  before stream invalidation. A successful privacy cleanup discards that
  snapshot; a failed cleanup persists the retained chat with a visible failure
  receipt.

## UI Contract

- The existing shared planner memory drawer serves compact and expanded chat.
- Opening the drawer loads recent memories automatically.
- Search remains explicit and bounded.
- Each memory row has a visible `Forget` action with an accessibility label and
  hint.
- `Clear task memory` states that messages and the execution plan remain.
- Individual and scoped deletion require destructive confirmation dialogs.
- Buttons are disabled while a mutation is running.
- UI records are removed only after confirmed storage success.
- Failure appears inline and the record remains visible.
- Success appears as a short receipt with the affected count.
- Memory rows use an internal bounded scroll area so compact chat keeps its
  composer visible.
- Switching conversations invalidates search and recent-load generations.
- Memory rows use accessibility containment so nested actions remain reachable.

## Tests

1. Recent SQLite records are bounded, deterministic, and survive reopen.
2. Forgetting one record removes it from canonical and FTS lookup while a
   neighboring record remains.
3. Forgetting an unknown UUID is an idempotent no-op.
4. Scoped clear removes only the selected conversation's memories.
5. Scoped clear preserves that conversation's TODO plan.
6. Volatile and durable stores implement the same deletion semantics.
7. Chat state removes recalled memory only after successful deletion.
8. Storage failure remains visible and does not optimistically remove memory.
9. Clearing during an in-flight turn prevents that turn from recreating memory.
10. Stale recall and search generations cannot restore a deleted record.
11. EOF without a terminal stream event fails the plan, creates no durable
    memory, clears streaming UI, and remains visibly failed.
12. Navigation during a completed-turn memory write preserves both durable
    memory and the user-plus-assistant history snapshot in the original chat.
13. Explicit Stop persists and reloads a finalized partial assistant response.
14. Failed active-conversation deletion retains and reloads the finalized
    partial response plus its failure receipt.
15. Successful active-conversation deletion does not restore a captured
    snapshot.
16. Full chat E2E, application build, signature, Keychain, SQLite, and live
    BrowserOS health checks pass.

## Invariants

- Memory deletion never deletes messages or TODO plans.
- Deleted memory is not used in any request accepted after deletion completes.
- No raw secret, goal prose, assistant prose, or HMAC fingerprint is displayed.
- No destructive action completes without explicit user confirmation.
- No plan or memory record reports success without an explicit terminal success
  event.
- New Swift and first-party Markdown are English and ASCII-only.
- No new shell script is introduced.
- Existing unrelated worktree changes are preserved.
