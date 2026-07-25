# @browseros/agent-core

Host-bound agent core extracted from the retired TypeScript HTTP server
(wave 7 of the Rust consolidation). The HTTP/Hono surface was deleted:
the backend is the Rust `trios-server` (`trios/crates/trios-server`, axum),
which serves the same wire contract (A2A, memory/soul/skills/acl, monitoring,
provider probes) and passes the shared e2e suite. See
`trios/docs/TS_RETIREMENT.md` for the migration map.

What stays here (imported by `apps/eval` and the dev tooling):

- `./lib/clients/trios-server` — **the thin eval bridge** to the Rust agent
  loop (`POST /agent/run`, `GET /agent/tools`); `apps/eval` runs goals through
  it via the `rust-server` executor backend (wave 11)
- `./agent`, `./agent/tool-loop`, `./agent/types` — AI-SDK tool-loop agent
  (**legacy eval baseline only** — production loop is Rust `/agent/run`)
- `./browser`, `./browser/backends/cdp` — CDP browser driver (eval capture)
- `./tools/registry` — MCP tool implementations (legacy baseline)
- `./lib/clients/gateway` and other clients (klavis/strata included)
- `src/skills`, `src/monitoring` — skills catalog and run observability

Do not add new backend logic here; add it to the Rust crates instead.

> **Runtime:** [Bun](https://bun.sh) · **AI:** [Vercel AI SDK](https://sdk.vercel.ai) · **License:** [AGPL-3.0](../../../../LICENSE)

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         MCP Clients                                  │
│           (Agent UI, Claude Code, Gemini CLI, browseros-cli)         │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                │ HTTP / SSE / StreamableHTTP
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    BrowserOS Server (Bun)                             │
│                                                                      │
│   /mcp ─────── MCP tool endpoints (53+ tools)                       │
│   /chat ────── Agent streaming (AI SDK)                              │
│   /health ─── Health check                                           │
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  Agent Loop                                                  │   │
│   │  ├── Multi-provider AI SDK (OpenAI, Anthropic, Google, ...) │   │
│   │  ├── Session & conversation management                       │   │
│   │  ├── Context overflow handling + compaction                  │   │
│   │  └── MCP client for external tool servers                    │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  CDP-backed browser tools                                   │   │
│   │  (tabs, bookmarks, history, navigation, tab groups,         │   │
│   │   screenshots, DOM, network, console, input)                │   │
│   └─────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                │ Chrome DevTools Protocol
                                ▼
                     ┌─────────────────────┐
                     │   Chromium CDP      │
                     │  (port 9000)        │
                     │                     │
                     │  DOM, network,      │
                     │  input, screenshots │
                     └─────────────────────┘
```

## MCP Tools

53+ tools organized by category:

| Category | Tools |
|----------|-------|
| **Navigation** | `new_page`, `navigate`, `go_back`, `go_forward`, `reload` |
| **Input** | `click`, `type`, `press_key`, `hover`, `scroll`, `drag`, `fill`, `clear`, `focus`, `check`, `uncheck`, `select_option`, `upload_file` |
| **Observation** | `take_snapshot`, `take_enhanced_snapshot`, `extract_text`, `extract_links` |
| **Screenshots** | `take_screenshot`, `save_screenshot` |
| **Evaluation** | `evaluate_script` |
| **Pages** | `list_pages`, `active_page`, `close_page`, `new_hidden_page` |
| **Windows** | `window_list`, `window_create`, `window_close`, `window_activate` |
| **Bookmarks** | `bookmark_list`, `bookmark_create`, `bookmark_remove`, `bookmark_update`, `bookmark_move`, `bookmark_search` |
| **History** | `history_search`, `history_recent`, `history_delete`, `history_delete_range` |
| **Tab Groups** | `group_list`, `group_create`, `group_update`, `group_ungroup`, `group_close` |
| **Filesystem** | `ls`, `read`, `write`, `edit`, `find`, `grep`, `bash` |
| **Memory** | `read_core`, `update_core`, `read_soul`, `update_soul`, `search_memory`, `write_memory` |
| **DOM** | `dom`, `dom_search` |
| **Console** | `get_console_messages` |
| **Other** | `browseros_info`, `handle_dialog`, `wait_for`, `download`, `export_pdf`, `output_file`, `nudges` |

## Agent Loop

The agent loop uses the [Vercel AI SDK](https://sdk.vercel.ai) to orchestrate multi-step browser automation:

- **Multi-provider support** — OpenAI, Anthropic, Google, Azure, Bedrock, OpenRouter, Ollama, LM Studio, and any OpenAI-compatible endpoint
- **Session management** — conversations persist in a local SQLite database
- **Context overflow handling** — automatic message compaction when context windows fill up
- **MCP client** — connects to external MCP servers for additional tool access (40+ app integrations)
- **Tool adapter** — bridges MCP tool definitions to AI SDK tool format

### Provider Factory

The provider factory (`src/agent/provider-factory.ts`) creates AI SDK providers from runtime configuration, supporting hot-swapping between providers without restart.

## Skills System

Skills are custom instruction sets that shape agent behavior:

- **Catalog** (`src/skills/catalog.ts`) — registry of available skills
- **Defaults** (`src/skills/defaults/`) — built-in skill definitions
- **Loader** (`src/skills/loader.ts`) — loads skills from local and remote sources
- **Remote sync** (`src/skills/remote-sync.ts`) — syncs skills from the BrowserOS cloud

## Dependencies

Notable runtime dependencies worth calling out:

- **`@agentclientprotocol/sdk`** — Agent Client Protocol SDK. Powers the upcoming ACP bridge that drives chat, history, cancellation, and per-session realtime state by spawning `openclaw acp` as a child process and consuming JSON-RPC over stdio. Wiring code lands in `src/api/services/acp/` in subsequent commits.

## Directory Structure

```
packages/agent-core/
├── src/
│   ├── agent/                 # Agent loop
│   │   ├── ai-sdk-agent.ts    # Main agent implementation
│   │   ├── provider-factory.ts# LLM provider factory
│   │   ├── session-store.ts   # Conversation persistence
│   │   ├── compaction.ts      # Context window management
│   │   ├── mcp-builder.ts     # External MCP client setup
│   │   └── tool-adapter.ts    # MCP → AI SDK tool bridge
│   ├── browser/               # Browser connection layer
│   ├── tools/                 # Tool implementations
│   │   ├── navigation.ts
│   │   ├── input.ts
│   │   ├── snapshot.ts
│   │   ├── memory/
│   │   ├── filesystem/
│   │   └── ...
│   ├── skills/                # Skills system
│   └── lib/                   # Shared utilities
├── tests/
└── package.json
```

> Persistence (agents, OAuth tokens, produced files) lives in the Rust
> `trios-server` (`trios-store`, SeaORM/SQLite) — the former TS drizzle
> layer was removed with the retired TS server.

## Development

### Prerequisites

- [Bun](https://bun.sh) runtime
- A running BrowserOS instance (for CDP connectivity)

### Setup

```bash
# Copy environment files
cp .env.example .env.development

# Start the server (with hot reload)
bun run start
```

See the [agent monorepo README](../../README.md) for full environment variable reference and `dev:watch` setup.

### Testing

```bash
bun run test:tools          # Tool-level tests
bun run test:integration    # Full integration tests (requires running BrowserOS)
```

### Building

```bash
# Build cross-platform server binaries
bun run build

# Build for specific targets
bun scripts/build/server.ts --target=darwin-arm64,linux-x64

# Build without uploading to R2
bun scripts/build/server.ts --target=all --no-upload
```

## Ports

| Port | Env Variable | Purpose |
|------|-------------|---------|
| 9100 | `BROWSEROS_SERVER_PORT` | HTTP server (MCP, chat, health) |
| 9000 | `BROWSEROS_CDP_PORT` | Chromium CDP (server connects as client) |
| 9300 | `BROWSEROS_EXTENSION_PORT` | Legacy BrowserOS launch arg kept for compatibility |
