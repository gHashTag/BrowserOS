# Colored Code Diff Specification

Issue: T27-EPIC-001
Task: CHAT-DIFF-001
Owner: Chat UI

## Purpose

Render code changes inside tool details as a readable, line-oriented diff with
the visual hierarchy used by modern coding agents.

## Behavior

- Added lines use a green foreground and tinted green background.
- Removed lines use a red foreground and tinted red background.
- Hunk headers use an accent tone and file headers remain visually distinct.
- Old and new line-number gutters remain aligned while horizontally scrolling.
- Unified Git diffs and apply-patch payloads are detected without coloring
  ordinary multiline text as a diff.
- Common structured before/after edit arguments are converted into a diff.
- Local and BrowserOS tool cards share the same diff renderer.
- Raw structured details remain available when no credible diff is present.

## Tests

1. Parse file headers, hunk headers, context, additions, and deletions.
2. Track old and new line numbers through a hunk.
3. Recognize apply-patch payloads.
4. Reject ordinary text containing isolated plus or minus characters.
5. Build a structured diff from common old/new edit keys.
6. Preserve unchanged lines when synthesizing a before/after diff.

## Invariants

- Tool execution, streaming, and persisted payloads are unchanged.
- Diff parsing is deterministic and bounded for large before/after inputs.
- All diff text remains selectable and copyable.
- New Swift and Markdown content is English and ASCII-only.
