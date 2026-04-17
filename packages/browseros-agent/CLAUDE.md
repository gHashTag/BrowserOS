# ⚠️ WORKSPACE BOUNDARY - READ FIRST

## CORRECT WORKING DIRECTORY

For ALL Trinity A2A + relay-observer + experience hooks work:

**YOU MUST BE IN**: `/Users/playra/BrowserOS/packages/browseros-agent`

## FORBIDDEN DIRECTORY

**NEVER work in**: `/Users/playra/BrowserOS` (root)

Root `/Users/playra/BrowserOS` is for:
- Package-level configuration
- Dependencies
- Build scripts

Do NOT edit root files for Trinity A2A work. Stay in `packages/browseros-agent/`.

## PORT SSOT (Single Source of Truth)

All port configurations are defined in:
- `/Users/playra/BrowserOS/packages/browseros-agent/packages/shared/src/constants/ports.ts`

A2A WebSocket port: **9001** (not 3000, not 9100)

## VIOLATION DETECTION

If you find yourself in `/Users/playra/BrowserOS` (root):
1. STOP immediately
2. Switch to `/Users/playra/BrowserOS/packages/browseros-agent`
3. Re-read the task context

## AGENT COMMANDS — FOLLOW STRICTLY

1. **Work ONLY inside** `packages/browseros-agent/` — never in root
2. **DO NOT use** `localhost:3000` — this is NOT the A2A port
3. **DO NOT take ports from**: old logs, old INTEGRATION.md copies, ~/t27 duplicates, or guesses
4. **ALWAYS read** `packages/shared/src/constants/ports.ts` before ANY run
5. **Port 3001 is DEPRECATED** — A2A WebSocket is **9001** only

### Pre-Flight Checklist
Before running any A2A/Trinity task:
```bash
# 1. Verify you're in the right directory
pwd  # Must output: .../BrowserOS/packages/browseros-agent

# 2. Read actual ports
cat packages/shared/src/constants/ports.ts

# 3. Use ONLY those values — no assumptions
```

---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Coding guidelines

- **Use extensionless imports.** Do not use `.js` extensions in TypeScript imports. Bun resolves `.ts` files automatically.
  ```typescript
  // ✅ Correct
  import { foo } from './utils'
  import type { Bar } from '../types'

  // ❌ Wrong
  import { foo } from './utils.js'
  ```
- Write minimal code comments. Only add comments for non-obvious logic, complex algorithms, or critical warnings. Skip comments for self-explanatory code, obvious function names, and simple operations.
- Logger messages should not include `[prefix]` tags (e.g., `[Config]`, `[HTTP Server]`). Source tracking automatically adds file:line:function in development mode.
- Avoid magic constants scattered in the codebase. Use `@browseros/shared` for all shared configuration:
  - `@browseros/shared/constants/ports` - Port numbers (DEFAULT_PORTS, TEST_PORTS)
  - `@browseros/shared/constants/timeouts` - Timeout values (TIMEOUTS)
  - `@browseros/shared/constants/limits` - Rate limits, pagination, content limits (RATE_LIMITS, AGENT_LIMITS, etc.)
  - `@browseros/shared/constants/urls` - External service URLs (EXTERNAL_URLS)
  - `@browseros/shared/constants/paths` - File system paths (PATHS)
  - `@browseros/shared/types/logger` - Logger interface types (LoggerInterface, LogLevel)

## File Naming Convention

Use **kebab-case** for all file and folder names:

| Type | Convention | Example |
|------|------------|---------|
| Multi-word files | kebab-case | `gemini-agent.ts`, `mcp-context.ts` |
| Single-word files | lowercase | `types.ts`, `browser.ts`, `index.ts` |
| Test files | `.test.ts` suffix | `mcp-context.test.ts` |
| Folders | kebab-case | `rate-limiter/`, `browser-tools/` |

Classes remain PascalCase in code, but live in kebab-case files:
```typescript
// file: gemini-agent.ts
export class GeminiAgent { ... }
```

## Project Overview

**BrowserOS Server** - The automation engine inside BrowserOS. This MCP server powers the built-in AI agent and lets external tools like `claude-code` or `gemini-cli` control the browser. Starts automatically when BrowserOS launches.

## Trinity A2A / Relay Observer

This workspace also contains the Trinity A2A (Agent-to-Agent) relay observer and experience hooks.

### Key Components

- `apps/server/src/agent/portable/relay-observer.ts` — WebSocket relay observer implementation
- `apps/server/src/agent/portable/a2a-types.ts` — Type definitions for A2A communication
- `apps/server/src/agent/portable/INTEGRATION.md` — Multi-agent A2A scenarios documentation

### Port Configuration

See `packages/shared/src/constants/ports.ts` for the single source of truth.

- **A2A WebSocket**: 9001
- **CDP**: 9000 / 9005 / 9010
- **Server**: 9100 / 9105 / 9110
- **Extension**: 9300 / 9305 / 9310

## Bun Preferences

Default to using Bun instead of Node.js:

- Use `bun <file>` instead of `node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Bun automatically loads .env (no dotenv needed)

## Common Commands

```bash
# Start server (development)
bun run start                    # Loads .env.dev automatically

# Testing
bun run test                     # Run tool tests (requires BrowserOS running)
bun run test:tools               # Same as above
bun run test:integration         # Run integration tests
bun run test:sdk                 # Run SDK tests

# Run a single test file
bun --env-file=.env.development test apps/server/tests/path/to/file.test.ts

# Linting
bun run lint                     # Check with Biome
bun run lint:fix                 # Auto-fix with Biome

# Type checking
bun run typecheck                # TypeScript build check

# Build
bun run dev:server               # Build server for development
bun run dev:ext                  # Build extension for development
bun run dist:server              # Build server for production (all targets)
bun run dist:ext                 # Build extension for production

# Refresh models.dev data
bun run generate:models          # Fetches latest from models.dev/api.json
```

## Architecture

This is a monorepo with three packages in `apps/`:

### Server (`apps/server`)
The main MCP server that exposes browser automation tools via HTTP/SSE.

**Entry point:** `apps/server/src/index.ts` → `apps/server/src/main.ts`

**Key components:**
- `src/tools/` - MCP tool definitions, split into:
  - `cdp-based/` - Tools using Chrome DevTools Protocol (navigation, DOM interaction, network, console, emulation, input, etc.)
- `src/common/` - Shared utilities (McpContext, PageCollector, browser connection, identity, db)
- `src/agent/` - AI agent functionality (Gemini adapter, rate limiting, session management)
- `src/http/` - Hono HTTP server with MCP, health, and provider routes

**Tool types:**
- CDP tools require a direct CDP connection (`--cdp-port`)

### Shared (`packages/shared`)
Shared constants, types, and configuration used across packages. Avoids magic numbers.

**Structure:**
- `src/constants/` - Configuration values (ports, timeouts, limits, urls, paths)
- `src/types/` - Shared type definitions (logger)

**Exports:** `@browseros/shared/constants/*`, `@browseros/shared/types/*`

### Communication Flow

```
AI Agent/MCP Client → HTTP Server (Hono) → Tool Handler
                                              ↓
                                   CDP → BrowserOS / Chrome APIs
```

## Creating Packages

When creating new packages in this monorepo:

- **Location:** Packages go in `packages/`, apps go in `apps/`
- **No index.ts:** Don't create or export an `index.ts` - it inflates the bundle with all exports
- **Separate export files:** Keep exports in individual files (e.g., `logger.ts`, `ports.ts`)
- **Import pattern:** `import { X } from "@my-package/name/logger"` - only imports what's needed

**package.json exports:** Must include both `types` and `default` for TypeScript:
```json
"exports": {
  "./constants/ports": {
    "types": "./src/constants/ports.ts",
    "default": "./src/constants/ports.ts"
  },
  "./types/logger": {
    "types": "./src/types/logger.ts",
    "default": "./src/types/logger.ts"
  }
}
```

## Test Organization

Tests are in `apps/server/tests/`:
- `tools/` - Tool tests (require BrowserOS running with CDP), plus ACL scorer tests (standalone)
- `browser/` - Browser backend tests
- `agent/` - Agent tests (compaction, rate limiter)
- `sdk/` - Agent SDK tests
- `__helpers__/` - Test utilities and fixtures

## Self-Testing UI Changes

After making UI changes to the agent extension (`apps/agent/`), you can visually verify them using the CDP inspector script. This connects directly to the browser via Chrome DevTools Protocol and can inspect extension pages (side panel, new tab, etc.) that the agent's own tools cannot see.

### Prerequisites

The dev server must be running:
```bash
bun run dev:watch -- --new
```
Read the output to find the randomized CDP port, then:
```bash
export BROWSEROS_CDP_PORT=<port from output>
```

### Workflow

1. **List all targets** to see what's available:
   ```bash
   bun scripts/dev/inspect-ui.ts targets
   ```

2. **Open the side panel** if it's not already open:
   ```bash
   bun scripts/dev/inspect-ui.ts open-sidepanel
   ```

3. **Take a screenshot** of the side panel:
   ```bash
   bun scripts/dev/inspect-ui.ts screenshot sidepanel /tmp/panel.png
   ```
   Then read `/tmp/panel.png` to view the result.

4. **Get the accessibility tree** for structural verification:
   ```bash
   bun scripts/dev/inspect-ui.ts snapshot sidepanel
   ```

5. **Click an element** by its ID from the snapshot:
   ```bash
   bun scripts/dev/inspect-ui.ts click sidepanel 142
   ```

6. **Fill a text input** by its ID from the snapshot:
   ```bash
   bun scripts/dev/inspect-ui.ts fill sidepanel 85 "search query"
   ```

7. **Evaluate JavaScript** in the extension context:
   ```bash
   bun scripts/dev/inspect-ui.ts eval sidepanel "document.title"
   ```

### Interaction workflow

The typical loop is: snapshot → identify element IDs → click/fill → screenshot to verify.
Element IDs come from the `[number]` in snapshot output (these are `backendDOMNodeId` values).
This uses the same element resolution as the server's MCP tools — no coordinate guessing.

### Target selection

The `<target>` argument can be:
- An **index** from the `targets` output (e.g., `3`)
- A **URL substring** (e.g., `sidepanel`, `newtab`, `chrome-extension://`)
