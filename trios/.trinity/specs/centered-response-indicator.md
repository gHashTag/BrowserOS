# Centered Response Indicator Specification

Issue: T27-EPIC-001
Task: CHAT-LOADING-001
Owner: Chat UI

## Purpose

Center the active response indicator within the conversation column instead of
anchoring it to the assistant message edge.

## Behavior

- The dots and agent label form one centered indicator group.
- Centering is relative to the chat column, not the complete window or sidebar.
- Local and BrowserOS streaming states use the same alignment.
- The indicator remains in message flow so scrolling behavior is unchanged.

## Tests

1. The loading layout resolves to center alignment.
2. The layout keeps dots and label in one group.
3. The layout remains in flow rather than becoming a screen overlay.

## Invariants

- Streaming state and cancellation behavior are unchanged.
- Compact and expanded layouts share the same indicator.
- New Swift and Markdown content is English and ASCII-only.
