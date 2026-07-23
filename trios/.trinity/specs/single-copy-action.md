# Single Copy Action Specification

Issue: T27-EPIC-001
Task: CHAT-COPY-ACTION-001
Owner: Chat UI

## Purpose

Render exactly one visible copy action for each assistant response.

## Behavior

- A completed final assistant response uses the primary action bar, which
  contains copy, regenerate, and feedback controls.
- The hover-only copy action is not rendered when the primary action bar is
  present.
- A non-final or active assistant response with content may use the hover-only
  copy action as its fallback.
- An assistant response without content renders no copy action.

## Tests

1. Completed final content selects the primary action bar.
2. Primary action selection exposes one copy action.
3. Active or non-final content selects the hover fallback.
4. Hover fallback exposes one copy action.
5. Empty content selects no action and exposes zero copy actions.

## Invariants

- Copy behavior and pasteboard content remain unchanged.
- Regenerate and feedback remain available on completed final responses.
- Source and comments remain ASCII-only.
