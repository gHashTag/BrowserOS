# Chat Composer Attachments

Task: `CHAT-ATTACHMENTS-001`

Issue: T27-EPIC-001

## Problem

The chat composer only accepts typed text. Users cannot drop screenshots,
images, or working files into the current task, cannot review the pending
selection, and cannot send a file-only request.

## Contract

1. The composer accepts file URLs and image representations through drag and
   drop and offers the same capability from its action menu.
2. Pending attachments appear above the editor as compact removable cards.
   Images show a thumbnail; other files show a semantic document icon.
3. A clear drop-target treatment appears over the composer while compatible
   content is hovering over it.
4. At most 10 unique attachments may be pending. Files larger than 100 MiB and
   in-memory images larger than 5 MiB are rejected with an inline explanation.
5. File URL attachments retain their canonical local paths. Image data without
   a stable file URL is written atomically to the application support
   Attachments directory before it becomes pending.
6. Sending is enabled when either text or at least one attachment is present.
   Accepted sends clear the pending attachments; stopping a response does not.
7. The outbound message includes an explicit untrusted-data manifest with each
   attachment name, kind, canonical path, media type, and size so agent tools
   can inspect the files without embedding their contents in the request.
8. Starting or switching a task clears pending attachments so files cannot
   leak into another conversation.

## Tests

- Image and non-image file classification is deterministic.
- Canonical-path duplicates are removed and the 10-item limit is enforced.
- Attachment-only outbound messages are valid and include the untrusted-data
  warning plus stable local paths.
- Plain text without attachments is unchanged.
- Size limits and user-facing rejection counts are deterministic.
- The Swift application compiles and the running health endpoint remains OK.

## Invariants

- Dropping content never executes or parses the file as instructions.
- File contents are not copied into chat history or logs.
- Existing text editing, paste, keyboard shortcuts, model selection, and stop
  behavior remain available.
- The centralized black glass theme remains the source of composer styling.
- Source and first-party documentation remain English and ASCII-only.
