# Adaptive Black Chat Composer Specification

Issue: T27-EPIC-001
Task: CHAT-COMPOSER-001
Owner: Chat UI

## Purpose

Replace the oversized compact-window input stack with one responsive,
ChatGPT-style composer that remains dark, blurred, and easy to scan.

## Behavior

- Compact and expanded chat use one rounded composer component.
- The composer uses native backdrop blur under a stronger black wash.
- Compact mode uses a darker wash and tighter outer insets.
- The editor occupies the upper portion of the composer and grows only to a
  bounded maximum height.
- The lower toolbar contains a compact action menu, inline connection/provider
  state, and one circular send or stop button.
- Keyboard shortcuts move out of the persistent layout into the action menu.
- API-key absence is represented as a concise local-mode state instead of a
  large warning and placeholder.
- The placeholder remains short and action-oriented.

## Tests

1. Compact metrics use tighter spacing and a darker black wash.
2. Expanded metrics preserve the same visual language with a wider inset.
3. Neither mode shows a persistent shortcut strip.
4. Editor minimum and maximum heights remain bounded.
5. The composer uses inline status in both modes.

## Invariants

- Enter, Shift-Enter, history navigation, clear, focus, and cancellation keep
  their existing behavior.
- Server and API-key diagnostics remain discoverable through inline status help.
- The composer remains usable in both the mini window and full-screen workspace.
- New Swift and Markdown content is English and ASCII-only.
