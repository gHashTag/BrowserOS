# Assistant Event Timeline Specification

Issue: T27-EPIC-001
Task: CHAT-TIMELINE-001
Owner: Chat UI

## Purpose

Render assistant text and tool activity in the order received instead of always
placing the complete answer above all tool cards.

## Behavior

- Text deltas create or extend a text item at their stream position.
- Tool starts create a timeline reference to the matching tool card.
- Reasoning, tool calls, and later text retain chronological order.
- Final answer text received after tools appears below those tools.
- Legacy persisted messages without timeline references render reasoning, then
  tools, then the final answer.
- Tool output updates the referenced card without moving it.

## Tests

1. Preamble, tool, and final answer preserve their event order.
2. Multiple tools remain between preamble and final answer.
3. Legacy messages place final content after tools.
4. Tool references prevent duplicate tool cards.

## Invariants

- Existing message decoding remains backward compatible.
- Tool arguments and results are not duplicated or mutated.
- Search, copy, persistence, and streaming continue to work.
- New Swift and Markdown content is English and ASCII-only.
