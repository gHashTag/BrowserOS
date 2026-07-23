# Aligned Glass Status Bar

Task: `CHAT-STATUS-BAR-001`

Issue: `#T27-EPIC-001`

## Problem

The chat status bar renders as an edge-to-edge rectangular strip while the
composer below it is an inset, rounded glass surface. Their different widths,
surface treatments, and vertical metrics make the lower chat chrome look
misaligned and visually unrelated.

## Contract

1. The status bar and composer use the same horizontal inset in compact and
   expanded workspaces.
2. The status bar is a floating rounded glass surface with native backdrop
   blur, the central black overlay, and a complete subtle border.
3. Compact status height is 32 points; expanded status height is 36 points.
4. Status content is vertically centered on one baseline with explicit icon
   sizes and quiet dividers.
5. Connectivity remains semantic through green or warning dots, while the CDP
   label uses the neutral text palette instead of an unrelated blue accent.
6. The gap above and below the status surface is balanced at 8 points.

## Tests

- Status horizontal insets equal composer horizontal insets for both modes.
- Status black overlay opacity equals the composer black overlay opacity.
- Status height, corner radius, border width, and vertical gaps match the
  declared geometry.
- Native blur is enabled and no opaque fill is introduced.

## Invariants

- Model, token, recovery, and connection controls remain available.
- Status details remain legible in compact and expanded modes.
- The centralized visual theme remains the only source of neutral colors.
- Source and first-party documentation remain English and ASCII-only.
