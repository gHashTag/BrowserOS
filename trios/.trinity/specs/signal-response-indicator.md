# Signal Response Indicator

## Intent

Replace the generic bouncing ellipsis with one centered, white signal-pulse indicator that reads as an active agent process without duplicating loading feedback.

## Contract

1. The indicator foreground and its label are white on every chat surface.
2. Each signal node is exactly 20 percent larger than the previous 6-point dot, producing a 7.2-point node.
3. The visual consists of three nodes joined by a thin signal rail; one node pulses at a time from left to right.
4. The indicator remains centered in the message flow and is rendered by the existing single-loader policy.
5. Reduced-motion mode renders the same signal rail and nodes without animation.

## Tests

- The layout policy selects the white foreground tone.
- The layout policy exposes the 1.2 scale and 7.2-point node diameter.
- The layout policy identifies the signal-pulse style.
- Existing single-loader and centered placement invariants remain true.

## Invariants

- No second overlay or assistant-bubble loader is introduced.
- Loading feedback remains visible against the centralized black glass theme.
- The implementation does not create a repeating timer owned by each message row.
