# Reasoning Header Deduplication Specification

Issue: T27-EPIC-001
Task: CHAT-THINKING-001
Owner: Chat UI

## Purpose

Remove the redundant standalone Thinking status when structured reasoning
accordions already communicate the same state.

## Behavior

- Reasoning segments render only through their collapsible cards.
- The assistant sender label remains visible at the start of the group.
- Streaming without a reasoning segment continues to use the centered loading
  indicator supplied by the chat panel.
- Completed reasoning remains available inside the existing cards.

## Tests

1. A message with reasoning cards does not request a standalone header.
2. Reasoning cards remain enabled.
3. Empty reasoning does not request a standalone header.

## Invariants

- Reasoning content is not removed or altered.
- Streaming and persistence behavior are unchanged.
- New Swift and Markdown content is English and ASCII-only.
