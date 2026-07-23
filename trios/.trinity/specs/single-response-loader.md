# Single Response Loader Specification

Issue: T27-EPIC-001
Task: CHAT-LOADER-002
Owner: Chat UI

## Purpose

Present one clear progress indicator for an active assistant response instead of
rendering both an empty assistant bubble loader and a chat-level loader.

## Behavior

- The chat-level centered indicator is the single source of loading feedback.
- An empty streaming assistant message does not render a message bubble.
- A streaming assistant message becomes visible as soon as it contains timeline
  content such as text, reasoning, or a tool call.
- Completed assistant messages remain visible even when their content is empty.
- Local and BrowserOS activity retain their own agent labels.

## Tests

1. Loading feedback is enabled in the chat stream.
2. Loading feedback is disabled inside assistant bubbles.
3. An empty streaming assistant bubble is hidden.
4. A streaming assistant bubble with timeline content is visible.
5. A completed assistant bubble remains visible.

## Invariants

- Streaming, cancellation, and tool execution behavior are unchanged.
- The indicator stays centered and participates in message flow.
- New Swift and Markdown content is English and ASCII-only.
