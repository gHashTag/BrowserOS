# Black Response Indicator Specification

Issue: T27-EPIC-001
Task: CHAT-LOADER-COLOR-001
Owner: Chat UI

## Purpose

Render the active response indicator with a clear black foreground instead of
the muted gray palette used for secondary metadata.

## Behavior

- The response indicator dots are black.
- The response indicator agent label is black.
- The dots and label use the same foreground tone.
- Other typing indicator call sites keep their existing default unless they
  explicitly request the response indicator tone.

## Tests

1. The response indicator tone resolves to black.
2. The single-loader placement and visibility rules remain unchanged.

## Invariants

- Streaming and animation behavior are unchanged.
- The response indicator remains centered in message flow.
- New Swift and Markdown content is English and ASCII-only.
