# Phase 0 Audit: TRIOS MCP Bridge — Dual-MCP + Vision

**Date**: 2026-04-18
**Status**: ✅ Complete

---

## 1. BrowserOS MCP Infrastructure (Existing)

### MCP Server
- **Location**: `apps/server/src/api/services/mcp/mcp-server.ts`
- **Transport**: Streamable HTTP via `@hono/mcp`
- **Endpoint**: `http://127.0.0.1:{port}/mcp`
- **Server name**: `browseros_mcp`
- **Tools registered**: 31+ browser automation tools

### Key Tools Available
| Tool | Description | File |
|------|-------------|------|
| `take_screenshot` | Screenshot of any page (PNG/JPEG/WebP) | `tools/snapshot.ts:142` |
| `take_snapshot` | Accessibility tree snapshot | `tools/snapshot.ts:11` |
| `take_enhanced_snapshot` | Detailed accessibility tree | `tools/snapshot.ts:28` |
| `get_page_content` | Page content as markdown | `tools/snapshot.ts:45` |
| `click` / `click_at` | Click elements | `tools/input.ts` |
| `fill` / `type_at` | Type text | `tools/input.ts` |
| `navigate_page` | Navigate to URL | `tools/navigation.ts` |
| `list_pages` | List open tabs | `tools/navigation.ts` |
| `evaluate_script` | Run JS on page | `tools/snapshot.ts` |

### Browser Control
- **CDP Backend**: `browser/backends/cdp.ts` — Full Chrome DevTools Protocol
- **Screenshot**: `browser/browser.ts:844` — `Page.captureScreenshot` via CDP
- **Snapshot**: `browser/snapshot.ts` — Accessibility tree via CDP

### MCP Client Support
- **Custom MCP servers**: Users can add via UI → stored in `mcpServerStorage`
- **Klavis Strata**: OAuth MCP servers (Gmail, Slack, etc.)
- **MCP Builder**: `agent/mcp-builder.ts` — Builds MCP client specs from browser context

## 2. GitButler Integration (Existing)

### GitButler CLI (`but`)
- **Location**: `/usr/local/bin/but`
- **App**: `/Applications/GitButler.app`
- **MCP Server**: `but mcp` (stdio) / `but mcp --internal` (granular tools)
- **Status**: ✅ Available and working

### GitButler CLI Commands
| Command | Description |
|---------|-------------|
| `but status` | Workspace status |
| `but commit -m "msg"` | Commit changes |
| `but stage <files>` | Stage files |
| `but branch new <name>` | Create virtual branch |
| `but branch list` | List branches |
| `but push` | Push stack |
| `but pull` | Pull latest |
| `but absorb` | Smart absorb into commits |
| `but discard` | Discard changes |
| `but diff` | Show diff |

### GitButler MCP (`but mcp`)
- **Default mode**: Single tool — commit with auto-generated message
- **Internal mode** (`--internal`): Granular tools for specific operations
- **Transport**: stdio (subprocess)

### Server-side GitButler Integration
| File | Description |
|------|-------------|
| `services/git/gitbutler/gitbutler-cli.ts` | CLI integration |
| `services/git/gitbutler/gitbutler-api.ts` | HTTP API client (port from GIT_CONSTANTS) |
| `services/git/gitbutler/gitbutler-fs.ts` | Filesystem watcher fallback |
| `services/git/gitbutler/index.ts` | Mode detection (cli → api → filewatch) |
| `services/git/git-orchestrator.ts` | Transaction-safe git operations |

### Existing Git Tools (LLM-callable)
| Tool | File |
|------|------|
| `git_status` | `tools/git/git-status.ts` |
| `git_branch` | `tools/git/git-branch.ts` |
| `git_checkout` | `tools/git/git-checkout.ts` |
| `git_commit` | `tools/git/git-commit.ts` |
| `git_pull` | `tools/git/git-pull.ts` |
| `git_push` | `tools/git/git-push.ts` |

## 3. What's Missing (The Gap)

The existing infrastructure has:
- ✅ Browser vision (screenshots, snapshots, DOM)
- ✅ GitButler CLI integration
- ✅ Basic git tools
- ✅ MCP server with 31+ tools
- ✅ Custom MCP server support

**Missing**:
- ❌ **Vision + GitButler bridge**: No tool that takes a screenshot of GitButler UI and analyzes it
- ❌ **High-level workflow tools**: No "commit what I see" or "create branch from selection"
- ❌ **GitButler MCP integration**: The `but mcp` server is not connected as an MCP client
- ❌ **Virtual branch awareness**: Current git tools don't understand GitButler's virtual branches

## 4. Bridge Architecture (Built)

```
trios-mcp-bridge/
├── package.json          # Dependencies: @hono/mcp, @modelcontextprotocol/sdk, hono, zod
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts           # Main entry — Hono HTTP server on port 9200
    ├── config.ts          # Config from env vars + CLI args
    ├── types.ts           # Shared types (ScreenshotResult, GitButlerStatus, etc.)
    ├── bridge-server.ts   # MCP server with 10 tools
    └── clients/
        ├── browseros-client.ts    # BrowserOS MCP client (HTTP)
        └── gitbutler-client.ts    # GitButler MCP client (stdio) + CLI fallback
```

### 10 Bridge Tools
| Tool | Type | Description |
|------|------|-------------|
| `gitbutler_analyze_ui` | Vision | Screenshot + snapshot + CLI status → full analysis |
| `gitbutler_screenshot` | Vision | Raw screenshot of GitButler tab |
| `gitbutler_workspace_status` | Data | Detailed file/branch status |
| `gitbutler_commit_visible` | Action | Commit changed files |
| `gitbutler_create_branch` | Action | Create virtual branch |
| `gitbutler_push_stack` | Action | Push stack to remote |
| `gitbutler_stage` | Action | Stage specific files |
| `gitbutler_absorb` | Action | Smart absorb into commits |
| `gitbutler_pull` | Action | Pull latest changes |
| `gitbutler_bridge_health` | Meta | Health check for both connections |

## 5. Test Results

```
✅ Bridge starts on port 9200
✅ GitButler MCP connected (internal mode)
⚠️  BrowserOS MCP not available (expected — BrowserOS not running)
✅ Health check endpoint works
✅ MCP endpoint responds
✅ CLI args parsing works
✅ --help output correct
```

## 6. Next Steps (Phase 2-4)

### Phase 2: Vision + Context (3 days)
- [ ] Test `gitbutler_analyze_ui` with actual GitButler open in BrowserOS
- [ ] Refine UI element parsing from accessibility tree
- [ ] Add LLM-based vision analysis (send screenshot to vision model)
- [ ] Extract: changed files, active branch, stacks, commit history

### Phase 3: Actions (3 days)
- [ ] Test all action tools end-to-end
- [ ] Add error recovery (reconnect on failure)
- [ ] Add undo support
- [ ] Integration tests

### Phase 4: Integration (2 days)
- [ ] Register bridge as custom MCP server in BrowserOS
- [ ] Add to BrowserOS MCP config
- [ ] End-to-end test: "See GitButler? Commit changes to new branch"
- [ ] Documentation + demo
