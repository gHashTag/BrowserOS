# Integrated Composer Status

Task: `CHAT-STATUS-IN-COMPOSER-001`

Issue: `#T27-EPIC-001`

## Problem

The model, token, recovery, and connection status is rendered as a separate
surface above the chat composer. It duplicates information already present in
the composer, consumes vertical space, and visually splits one interaction
area into two unrelated bars.

## Contract

1. No standalone status surface is rendered between the message history and
   the composer.
2. Model selection, token usage, recovery export, server state, BrowserOS
   state, and the send action share the composer's bottom toolbar.
3. Expanded mode shows provider, model, input/output token detail, Recovery,
   and the CDP label. Compact mode keeps the model, compact token total,
   recovery icon, and both semantic connection dots.
4. Status controls use the same black glass surface, border, corner radius,
   outer inset, and drag-and-drop destination as the text editor.
5. Every interactive control retains its tooltip, accessibility label, and
   existing action.
6. No status value is duplicated inside the composer toolbar.

## Tests

- Both workspace modes report embedded placement and no standalone surface.
- Both modes expose model selection, tokens, recovery, and connection state.
- Expanded mode exposes provider, token breakdown, and CDP label.
- Compact mode uses condensed status labels.
- The Swift build, signature, runtime launch, and BrowserOS health pass.

## Invariants

- Text input, file attachments, drag and drop, keyboard shortcuts, model
  selection, recovery export, and response cancellation remain functional.
- The centralized black glass theme remains the only composer surface style.
- Source and first-party documentation remain English and ASCII-only.
