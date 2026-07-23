# Unified Chat Glass Specification

Issue: T27-EPIC-001
Task: CHAT-GLASS-001
Owner: Chat UI

## Purpose

Preserve the compact panel glass and ambient blur appearance when the TriOS
window expands or enters macOS full-screen.

## Behavior

- One background component spans the complete TriOS content area.
- Compact and expanded chat modes use the same material and ambient tint.
- The background extends through title bar, tabs, history, and conversation.
- Full-screen mode does not introduce an opaque replacement background.
- Sidebar and content overlays remain translucent and keep text readable.

## Visual contract

- Native active full-screen material remains the base blur.
- Subtle green and warm accent blooms preserve the compact visual identity.
- A restrained dark wash maintains contrast without hiding the glass.
- Background layers ignore safe-area edges and never intercept pointer events.

## Tests

1. Compact and expanded modes resolve to the same glass profile.
2. The profile does not allow an opaque content fill.
3. Sidebar and conversation overlay opacity remain below 0.25.

## Invariants

- Existing chat and history behavior is unchanged.
- The full-screen background contains no screenshot or captured user content.
- New Swift and Markdown content is English and ASCII-only.
- Existing unrelated worktree changes are preserved.
