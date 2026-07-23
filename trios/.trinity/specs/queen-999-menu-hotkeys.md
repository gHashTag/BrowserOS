# QUEEN-999-HOTKEYS-001

## Intent

Provide deterministic keyboard access to all 27 petals while the Queen 999
triangle is visible, without stealing shortcuts from any opened workspace.

## Behavior

1. `Command+1...9` opens petals `0...8`.
2. `Option+1...9` opens petals `9...17`.
3. `Control+1...9` opens petals `18...26`.
4. Digit shortcuts are handled only when the main triangle is visible.
5. Once any hosted or canonical screen is open, all three digit shortcut rows
   are passed through unchanged.
6. Mixed modifiers, Shift combinations, zero, and out-of-range digits are not
   menu shortcuts.
7. Every petal tooltip shows the combination derived from its row and column.

## Tests

- All 27 modifier and digit combinations resolve to the expected petal.
- The same 27 combinations return no route when the main menu is hidden.
- Mixed and shifted modifiers return no route.
- Labels resolve to `Cmd+1`, `Option+1`, and `Control+1` at row boundaries.
- Queen tests, Trios route-map tests, and the Trios build pass.
- Runtime smoke tests confirm navigation and no in-screen interception.

## Invariants

- The triangle retains exactly 27 hit targets.
- Existing mouse navigation and hosted routes remain unchanged.
- `Command+0` continues to return to the main menu.
- No generated file is hand-edited.
- New source, tests, and documentation use English ASCII text.
