# Central Black Glass Theme Specification

Issue: T27-EPIC-001
Task: UI-BLACK-GLASS-001
Owner: Visual System

## Purpose

Provide one source of truth for the black, transparent, blurred visual language
across compact, expanded, chat, tools, sheets, and secondary workspaces.

## Behavior

- All neutral backgrounds derive from one black glass theme profile.
- Root, surface, elevated, strong, sidebar, content, and composer layers remain
  transparent so the native backdrop blur stays visible.
- Native material tint, borders, dividers, highlights, shadows, and ambient
  bloom strength are controlled by the same profile.
- Compact and expanded composer metrics read their black opacity from the
  central theme instead of owning independent values.
- Legacy grok color aliases map to semantic black glass colors so existing tabs
  inherit the theme without per-view rewrites.
- Status, diff, warning, and success colors remain semantic accents.

## Tests

1. Every neutral fill opacity is below one and above zero.
2. Strong surfaces are darker than elevated and regular surfaces.
3. Compact composer remains darker than expanded composer.
4. Border and divider opacities remain subtle.
5. Chat glass and composer profiles resolve values from the central theme.
6. Opaque content fill remains disabled.

## Invariants

- Native NSVisualEffectView blur remains active in compact and full-screen mode.
- Text contrast remains white-on-black and interactive states remain visible.
- Changing the active profile in one file updates all semantic color aliases.
- New Swift and Markdown content is English and ASCII-only.
