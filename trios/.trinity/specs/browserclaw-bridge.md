# BrowserClaw Bridge Contract

Issue: T27-EPIC-001
Status: implemented

## Goal

Connect the TRIOS MCP bridge to the current BrowserClaw Streamable HTTP MCP
endpoint without breaking installations that still expose the legacy BrowserOS
tool catalog.

## Contract

- BrowserClaw owns `http://127.0.0.1:9200/mcp`.
- The TRIOS MCP bridge owns `http://127.0.0.1:9203/mcp`.
- `TRIOS_BROWSERCLAW_MCP_URL` overrides the BrowserClaw endpoint.
- `TRIOS_BROWSEROS_MCP_URL` and `TRIONS_BROWSEROS_MCP_URL` remain legacy aliases.
- The bridge detects BrowserClaw from the `tabs` and `screenshot` tools.
- Current BrowserClaw calls map to `tabs`, `screenshot`, `snapshot`, `read`,
  `act`, `navigate`, and `tab_groups`.
- Legacy BrowserOS calls retain their existing tool names and arguments.
- TriOS starts the compatible chat companion when port 9105 is unhealthy.
- The companion discovers the active BrowserOS CDP port from the runtime config.
- An already healthy companion is adopted and never duplicated.
- Startup uses at most three attempts with exponential backoff.
- A companion owned by TriOS is terminated when TriOS exits.

## Tests

- Detect the current BrowserClaw catalog.
- Fall back to the legacy BrowserOS catalog.
- Parse current BrowserClaw tab listings with and without titles.
- Parse legacy BrowserOS page listings.
- Type-check the bridge after contract changes.
- Resolve current and legacy runtime config keys for the CDP port.
- Reject invalid ports and use the safe BrowserOS fallback port.

## Invariants

- BrowserClaw and the TRIOS bridge never bind the same default port.
- Contract detection is based on advertised tools, not a version string.
- A reconnect invalidates the cached contract and discovers it again.
- The legacy chat server may start with `BROWSEROS_SKIP_OPENCLAW=1`; an
  unavailable optional VM runtime must not block `/health` or `/chat`.
- TriOS chat uses an installed Ollama model when no paid-provider key exists.
