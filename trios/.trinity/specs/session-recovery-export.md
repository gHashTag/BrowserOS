# Session Recovery Export

Task: `SESSION-EXPORT-001`

Issue: T27-EPIC-001

## Problem

A running chat can contain the only complete record of an agent task. If the
agent, companion server, or application fails, the user needs one portable
artifact that another agent can inspect without reconstructing state from UI
screenshots or scattered local logs.

## Contract

1. Chat exposes one visible recovery-export action in compact and expanded
   workspaces.
2. Export creates a ZIP archive at a user-selected location.
3. The archive contains:
   - a machine-readable manifest with SHA-256 checksums;
   - every persisted conversation plus the unsaved active conversation state;
   - message content, reasoning segments, tool requests, tool results, errors,
     task metadata, and timestamps;
   - current BrowserOS messages and tool-call state;
   - provider, model, endpoint, token usage, connection state, active draft,
     app version, OS version, and active conversation identity;
   - a complete readable transcript and a handoff guide for another agent;
   - TriOS build, companion, system-process, Akashic, and runtime logs available
     at export time.
4. API keys, bearer tokens, passwords, cookies, and recognizable secret-token
   formats are replaced by `[REDACTED]` in chat content, tool payloads, context,
   and copied text logs.
5. Keychain values are never read into the export payload. Credential state may
   report only whether a key is configured and where it is stored.
6. Exact conversation JSON is canonical for restoration; Markdown is a human
   and agent-readable companion representation.
7. Export failure leaves no partial destination archive and shows a clear UI
   error. Cancellation makes no file.
8. A successful export is revealed in Finder and reports archive size, file
   count, and redaction count.

## Invariants

- Export never mutates or deletes chat history.
- Export never contains an API-key value retrieved from macOS Keychain.
- Every file listed in `manifest.json` has a matching SHA-256 digest.
- The active in-memory conversation wins over an older persisted copy.
- Log collection is read-only and limited to known TriOS diagnostic roots plus
  the current TriOS process log.
- Source and first-party documentation remain English and ASCII-only.

## TDD Cases

1. Redact authorization headers, JSON secret fields, environment assignments,
   OpenAI-style keys, Anthropic-style keys, GitHub tokens, and cookies.
2. Preserve ordinary text while returning an exact redaction count.
3. Sanitize message content, reasoning, tool input, tool output, and task text.
4. Render chronological transcript sections for content, reasoning, requests,
   results, errors, and task metadata.
5. Merge persisted conversations with the active in-memory conversation without
   duplication.
6. Build a deterministic portable filename ending in `.zip`.
7. Write an archive containing README, HANDOFF, JSON snapshots, diagnostics,
   copied logs, a system-process log, and a checksum manifest.

## Verification

- Run the dedicated Swift recovery-export tests.
- Run `./build.sh`.
- Relaunch the signed app and verify the export control in compact and expanded
  chat layouts.
- Create a real package, inspect its ZIP inventory, validate `manifest.json`,
  confirm secrets are absent, and confirm BrowserOS health remains OK.
