# Native Editing Shortcuts Specification

Issue: T27-EPIC-001
Task: CHAT-EDIT-SHORTCUTS-001
Owner: Chat Input

## Purpose

Restore standard macOS editing shortcuts in the chat composer and every other
text control, including paste, copy, cut, select all, undo, and redo.

## Behavior

- The application installs a standard Edit menu backed by the responder chain.
- Command-V pastes, Command-C copies, Command-X cuts, and Command-A selects all.
- Command-Z performs undo and Command-Shift-Z performs redo.
- The chat text view provides a direct fallback for these commands when a panel
  style or menu-routing edge case bypasses the main responder chain.
- Option- or Control-modified variants are not misclassified as standard edits.
- Existing composer shortcuts keep their behavior.

## Tests

1. Resolve Command-C, V, X, A, and Z to their native editing commands.
2. Resolve Command-Shift-Z to redo.
3. Reject shortcuts without Command.
4. Reject conflicting Option and Control variants.
5. Preserve unrelated Command shortcuts for the composer handler.

## Invariants

- Clipboard content is handled only through standard AppKit APIs.
- Input-method composition and non-US text entry are not intercepted.
- The menu uses nil targets so commands follow the active responder.
- New Swift and Markdown content is English and ASCII-only.
