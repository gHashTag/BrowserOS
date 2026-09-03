# Agent Memory and TODO Planner

Task: `AGENT-MEMORY-TODO-001`

Issue: T27-EPIC-001

## Goal

Give the primary Trios chat a durable, inspectable long-term memory and a
per-conversation execution plan that is created before a request is sent,
updated from real stream events, restored after restart, and rendered directly
above the composer.

## Storage Contract

- Durable records live in one SQLite database under the user's Application
  Support directory, never in the repository or `/tmp`.
- SQLite uses schema versioning, foreign keys, a busy timeout, and WAL mode.
- Memory and TODO writes use parameterized statements and transactions.
- The FTS5 index is kept consistent with the canonical memory table.
- UserDefaults stores presentation preferences only. It is not a shadow copy of
  memories, plans, or task status.
- Deleting a conversation deletes its plan and conversation-scoped memories.
- The application falls back to an in-memory store if the durable database
  cannot be opened; chat sending must remain available.

## Memory Contract

- A completed assistant turn stores one bounded summary containing the user
  goal and assistant result.
- The stored result is a derived completion outcome; raw assistant prose is not
  copied into memory.
- Raw goal prose is not copied either. The inspectable summary uses only a
  controlled topic vocabulary. Fuzzy recall uses HMAC-SHA256 character
  fingerprints whose random key is stored in macOS Keychain, never in SQLite
  or UserDefaults.
- Goals containing explicit attachment, browser-context, code-fence, diff, or
  file-boundary markers are rejected instead of being summarized.
- Reasoning, tool arguments, tool output, file contents, and raw browser
  context are never copied into long-term memory.
- Common credentials and bearer tokens are redacted before persistence.
- Search is bounded and runs off the main actor.
- FTS5 retrieves candidates and deterministic fuzzy scoring reranks them.
- Up to three relevant memories are added to the system prompt as untrusted
  historical notes. Current user instructions always take precedence.
- Empty, secret-only, or failed turns are not remembered.

## Planner Contract

- Each conversation has at most one active plan.
- Sending a non-empty request creates and persists a three-step plan before the
  transport request begins: understand, execute, verify.
- Starting the stream completes understand and starts execute.
- Tool events keep execute active and update its detail without inventing
  completion.
- A successful stream completes execute and verify.
- A successful stream does not complete tasks that the user added after the
  three generated lifecycle steps.
- Cancellation marks the active item cancelled. Errors mark it failed.
- Switching conversations loads that conversation's latest plan.
- Users can add a task, toggle task completion, complete the current task, clear
  a plan, and retry a failed or cancelled task.

## UI Contract

- One collapsible planner card appears between message history and the composer.
- The card shows goal, completed count, percentage, a progress bar, current
  state, recalled memory count, and task rows.
- Task state is communicated by text and icon, not color alone.
- The memory drawer supports an explicit query and shows bounded results.
- The active card uses restrained pulse, glow, insertion, progress, and
  completion effects. Reduce Motion disables spatial and repeating animation.
- When the planner card has keyboard focus, Command-T adds a task and
  Command-Return completes the current task. The composer retains its existing
  Command-Return send behavior.
- Every action has an accessibility label, value, and keyboard or VoiceOver
  path.

## Tests

1. A real temporary SQLite database creates schema version 1 in WAL mode.
2. A memory survives closing and reopening the store.
3. Parameterized storage round-trips quotes and Unicode safely.
4. Secret-like values are redacted before storage.
5. Misspelled queries retrieve a relevant memory through fuzzy reranking.
6. Search result count is bounded and deterministic.
7. A generated plan has three ordered items and persists across store reload.
8. Completing, cancelling, and failing items produce correct plan progress.
9. Clearing a conversation removes its plan and scoped memories.
10. Chat send creates a plan before transport and includes relevant recalled
    memory as an untrusted system note.
11. Successful, cancelled, and failed streams update the plan correctly.
12. Full application build, signature verification, health check, and live UI
    inspection pass.

## Invariants

- No raw secret, reasoning trace, tool payload, or file content is persisted as
  memory.
- Memory recall never becomes an instruction channel.
- TODO progress is derived from persisted item states.
- Planner failure never blocks chat transport.
- Planner persistence failure is visible in the planner card. Conversation
  deletion does not remove message history unless private memory cleanup
  succeeds.
- New Swift source and first-party Markdown are English and ASCII-only.
- No new shell script is introduced.
- Existing unrelated worktree changes are preserved.
