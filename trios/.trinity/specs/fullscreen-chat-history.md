# Full-Screen Chat History Specification

Issue: T27-EPIC-001
Task: FULLSCREEN-CHAT-001
Owner: Chat UI

## Purpose

Provide a ChatGPT-like workspace when the TriOS window becomes wide or enters
macOS full-screen, while preserving the existing compact side-panel experience.

## Adaptive layout contract

- Widths below 760 points use the compact tab and chat layout.
- Widths at or above 760 points use the full-screen workspace for the Chat tab.
- The full-screen workspace has a persistent task-history sidebar and a centered
  conversation column with a maximum readable width.
- Non-Chat tabs retain their existing full-width content.
- The standard macOS full-screen action is reachable from the TriOS title bar.

## Task history contract

- Conversations load when the view model starts, not only after the first send.
- The sidebar supports new task, search, selection, relative update time, and
  deletion.
- The active conversation is visually selected.
- Switching or deleting the active conversation cancels in-flight streaming
  before replacing message state.
- Empty and search-no-result states are explicit.

## Visual contract

- Sidebar width is 272 points at standard desktop widths and can collapse.
- Conversation content is centered and capped at 900 points.
- Input remains pinned below the message scroll area.
- Existing colors, glass material, Markdown renderer, and status indicators are
  reused instead of introducing a second chat implementation.
- The Trinity brand mark appears only in the title bar; the task-history sidebar
  does not repeat it.

## Tests

1. Width 759 resolves to compact mode.
2. Width 760 resolves to full-screen mode.
3. Full-screen metrics provide a visible sidebar and a 900-point content cap.
4. Collapsed full-screen metrics remove sidebar width without changing mode.
5. Compact metrics never reserve history-sidebar width.

## Invariants

- `ChatPanelView` remains the single message and composer implementation.
- Full-screen mode does not duplicate or merge conversation data.
- Swift and first-party Markdown additions are English and ASCII-only.
- No new shell script is introduced.
- Existing unrelated worktree changes are preserved.
