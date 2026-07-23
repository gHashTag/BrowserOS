# Embedded Trinity Queen UI

Task: `QUEEN-TRINITY-EMBED-001`
Issue anchor: user request to install the complete `gHashTag/trinity` Queen interface in Trios.

## Problem

The Trios Queen tab is a small status dashboard. The canonical Trinity repository already contains a native `QueenUILib` with the 27-screen triangle interface, chat, operational screens, settings, and live `.trinity` bridges. Reimplementing those screens in Trios would drift from the source interface.

## Contract

1. Trios embeds the real `QueenUILib` instead of a visual approximation.
2. The embedded root renders the same `MainView`, triangle navigation, 27 screens, theme, shortcuts, and state bridges as the standalone Queen app.
3. The Trinity project root is explicit and never inferred from the Trios process working directory.
4. Standalone Queen behavior remains compatible: without an override, the runtime uses its current project directory.
5. Trios builds and bundles the Queen dynamic library inside `trios.app` with a relative runtime path.
6. The Queen tab must work in compact and full-screen Trios layouts without opening a second application window.
7. Existing Trios chat, Git, Mesh, and model integrations remain unchanged.

## Tests

- The Trios integration contract resolves `~/trinity`, `apps/queen`, `.trinity`, and the Queen library product consistently.
- The contract declares all 27 canonical screens across the three kingdoms.
- The Queen package exposes a dynamic `QueenUILib` product.
- The public embedded root accepts an explicit project root and injects the canonical watcher and services.
- The Queen source compiles and its existing test suite passes.
- The complete Trios application compiles, links, signs, launches, and renders the canonical triangle inside the Queen tab.

## Invariants

- No Queen screen is copied or rewritten inside Trios.
- No process-wide working-directory change is used.
- No absolute dynamic-library install name is shipped.
- Source identifiers and comments added by this task are English and ASCII.
- The bundled UI is sourced from `gHashTag/trinity/apps/queen`.

## Verification

- RED then GREEN Swift contract test.
- `swift test` for the Queen package.
- Trios full build and code-signature verification.
- Runtime health check and visual verification in compact and full-screen Queen tab.
