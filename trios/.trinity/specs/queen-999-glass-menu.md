# QUEEN-999-GLASS-MENU-001

## Intent

Refine the canonical Queen 999 primary menu so it uses the shared Trios
matte-glass surface, removes persistent realm labels, and renders every idle
petal with one neutral treatment.

## Behavior

1. The main triangle does not render the persistent `RAZUM`, `MATERIYA`, or
   `DUKH` labels.
2. The `EXPLAIN` petal has no special blue pulse or idle fill.
3. Every idle petal uses the same translucent neutral fill.
4. Hover and active semantic feedback remain available.
5. Embedded Queen surfaces are transparent and reveal the centralized
   `UnifiedTriosGlassBackground`.
6. Standalone Queen keeps its canonical opaque background.

## Tests

- `TriangleMenuPresentation.showsRealmLabels` is false.
- `TriangleMenuPresentation.specialAnimatedPetal` is nil.
- `TriangleMenuPresentation.normalPetalOpacity` is translucent.
- `QueenSurfaceStyle.hostGlass` is transparent.
- `QueenSurfaceStyle.canonical` is opaque.
- The complete Queen test suite and Trios build pass.
- Compact and full-screen screenshots show the same matte-glass menu.

## Invariants

- The triangle retains all 27 hit targets and routes.
- Hosted Trios petal mappings remain unchanged.
- No generated output is hand-edited.
- New first-party source and documentation stay English and ASCII.
