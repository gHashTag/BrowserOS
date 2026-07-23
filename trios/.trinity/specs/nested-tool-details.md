# Nested Tool Details Specification

Issue: T27-EPIC-001
Task: TOOL-DETAILS-001
Owner: Chat UI

## Purpose

Render tool request arguments and results as readable hierarchical accordions
instead of one raw escaped text block.

## Behavior

- Valid JSON objects and arrays become recursive detail nodes.
- Object keys and array indexes form independently expandable rows.
- Nested JSON stored inside a string is parsed for up to three levels.
- Multiline or long strings become expandable text leaves with real line breaks.
- Short scalar values remain compact and visible beside their labels.
- Invalid JSON remains available as readable plain text.
- Expansion state is local to each row and never changes stored tool data.

## Visual contract

- Each hierarchy level receives consistent indentation and a subtle guide.
- Object, array, text, number, boolean, and null values have distinct summaries.
- Large text leaves use selectable monospaced text and horizontal scrolling.
- The outer tool card continues to expose one top-level expand/collapse control.

## Tests

1. Nested objects preserve keys and hierarchy.
2. Arrays preserve indexes and scalar types.
3. JSON encoded inside a string becomes a nested structure.
4. Escaped newlines in JSON strings become actual line breaks.
5. Invalid JSON falls back to a text leaf without losing content.

## Invariants

- Tool request and result payloads are not mutated.
- Rendering does not execute payload content.
- New Swift and Markdown content is English and ASCII-only.
- No generated file or unrelated worktree change is overwritten.
