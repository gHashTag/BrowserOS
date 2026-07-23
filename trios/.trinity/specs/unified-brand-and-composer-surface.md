# Unified Brand and Composer Surface Specification

Issue: T27-EPIC-001
Task: UI-BRAND-COMPOSER-001
Owner: Chat UI

## Purpose

Keep the compact input visually consistent with the shared Black Glass surface
and remove repeated assistant branding from the conversation timeline.

## Behavior

- The application title displays `Trinity S3AI`, rendered with a superscript
  three through an ASCII-safe Unicode escape in Swift source.
- The central display name appears once in the application title bar.
- Empty-state, full-screen, typing, status, and composer labels do not repeat the
  product name.
- Assistant and system messages do not render a sender label inside the chat
  timeline. User messages may keep the `You` label.
- The composer uses the content Black Glass opacity instead of a
  compact-specific near-opaque black layer.
- The composer uses the same popover material family as other glass cards.

## Tests

1. The central display name resolves to `Trinity S3AI` with a superscript three.
2. Assistant and system sender labels resolve to no visible label.
3. The user sender label resolves to `You`.
4. Compact and expanded composer opacity equals the content opacity.
5. Every composer opacity remains transparent.
6. Local typing and status labels resolve to no repeated product name.

## Invariants

- Source and comments remain ASCII-only.
- Native backdrop blur remains active.
- Runtime and BrowserOS Agent health remain unchanged.
