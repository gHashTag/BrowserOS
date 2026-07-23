# QUEEN-OPERATIONAL-WORKSPACES-001

## Issue

The Queen 999 menu opens concrete SwiftUI views for every petal, but the
non-hosted workspaces do not yet meet the operational quality of Trios Chat
and Models:

- neutral surfaces use an independent opaque palette instead of the shared
  translucent black-glass profile;
- dashboard state refresh is inconsistent between screens;
- action buttons can fail silently because their JSON transport and action
  catalog are not verified end to end;
- compact layouts have no shared operational status or action feedback.

## Scope

This change covers all 27 Queen 999 menu routes:

- six Trios-hosted workspaces remain the canonical Chat, Models, Git,
  Terminal, Mesh, and Settings implementations;
- the remaining 21 Queen workspaces retain their domain-specific content;
- all Queen workspaces consume one centralized glass palette and one action
  transport contract;
- every main-menu route remains reachable by pointer and keyboard.

## Behavioral contract

1. Menu indices 0 through 26 map to 27 unique concrete destinations.
2. No menu destination uses `ComingSoonScreen`.
3. Queen neutral window, card, elevated, sidebar, input, and border colors
   use the same opacity profile as the Trios black-glass theme.
4. Embedded Queen state refreshes while a canonical workspace is visible.
5. Every action ID referenced by a Queen screen is declared in one action
   catalog.
6. Action payloads use compact, decodable JSON and preserve parameters.
7. Every action produces visible queued, running, succeeded, or failed
   feedback; failures are never silent.
8. Risky actions require an explicit confirmation in the UI.
9. If a local executor is unavailable, the action remains durably queued and
   the UI explains that it is awaiting the Queen runtime.
10. The existing Chat and Models workspaces must not regress.

## Tests first

- Route coverage test: 27 unique menu destinations.
- Workspace catalog test: every non-hosted destination has an operational
  descriptor and no placeholder status.
- Theme test: Queen glass opacity values match the Trios profile.
- Action catalog test: all 17 action IDs currently referenced by screens are
  declared.
- Action codec test: queued actions round-trip through compact JSON with
  parameters intact.
- Action safety test: destructive actions are marked as confirmation-required.
- Existing Queen and Trios suites remain green.

## Verification

- `swift test` in `apps/queen`.
- focused Trios Swift tests for the 999 map and shared theme.
- `./build.sh` in Trios.
- code signature verification.
- BrowserOS health reports `status=ok` and `cdpConnected=true`.
- live compact screenshots from representative Brain, Body, and Spirit rows.
- keyboard route smoke test across all three rows.

## Non-goals

- Replacing domain-specific Queen dashboards with generic placeholders.
- Automatically executing destructive farm, cloud, git, or deployment
  operations without confirmation.
- Adding a new shell script or hand-editing generated output.

