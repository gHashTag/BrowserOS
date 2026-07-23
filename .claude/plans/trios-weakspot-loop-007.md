# trios 15m loop — cycle 7 plan

Date: 2026-07-23 (loop continuation)
Branch: `feat/zai-provider`
Commit: `417158739`

## Weak spots researched

1. **API key leakage surface** — `LLMClient.swift` still fell back to reading cloud provider API keys from environment variables. This leaves keys in shell history, `launchctl`, and process args, directly enabling Grok Build-style exfiltration.
2. **Command injection in process management** — `QueenStatusViewModel.swift` used `pkill -f` with regexes and assembled shell strings from user/env input, creating shell-metacharacter and `sudo` injection paths.
3. **Build fragility from prototype drift** — snapshot commit `851f97d45` introduced duplicate `ChatViewModel` methods and a `ChatSidebarView.swift` extension that conflicted with the canonical model types, breaking `build.sh`.
4. **Missing runtime port wiring** — `clade-build` emitted MCP/A2A ports in `Info.plist` but did not emit `TRIOS_MESH_PORT` or `TRIOS_CANARY_MCP_PORT`, so sealed mesh/canary binaries could not discover their own ports.
5. **Decodable mismatch in analytics** — `AnalyticsEvent` contained `[String: Any]` properties, which cannot auto-synthesize `Decodable`, breaking Swift compilation once the type was exercised.
6. **Dead BR-OUTPUT prototypes** — `PluginAPI.swift` and `ToolCallFix.swift` carried broken type references and ObjC selector conflicts, repeatedly breaking the aggregate Swift build.

## Competitor snapshot (late July 2026)

- **Shofer** — agent IDE for mobile/web, local simulator orchestration.
- **Nori** — notebook-first agent workspace, strong in long-context research.
- **Codeg / Agent Orchestrator updates** — enterprise policy + human-in-the-loop approvals, OWASP AISVS-aligned.
- **OpenClaw v2026.7.1** — patched mDNS peer discovery after CVE-2026-26327; now requires pinned static keys.
- **Rookery v0.4.0** — mesh-aware agent roster with libp2p + QUIC.
- Persistent leaders: Claude Code W27, Cursor cloud agents/iOS beta, Copilot Workspace/app GA, Repowire durable jobs.

Lessons:
- NIST AI Agent Standards “least agency” — identity/authorization per tool call.
- OWASP Agentic Top 10 2026: ASI01 goal hijack, ASI02 tool misuse, ASI05 unexpected execution, ASI10 rogue agents.
- July incidents reiterate: no env API keys, no blind MCP config writes, no mDNS trust, no symlink writes.

## Implementation slices (A + B + C)

### A — Build / SPM hardening
- Fix duplicate `ChatViewModel` conversation-management methods; remove conflicting `ChatSidebarView` extension.
- Reconcile `ChatSidebarView.swift` with `ChatConversation` / `ChatMessage` canonical types.
- Archive non-compiling `PluginAPI.swift` and `ToolCallFix.swift` to `trios/.archive/BR-OUTPUT/`.
- Migrate `tests/swift/sse_usage_event_test.swift` → `tests/TriOSKitTests/SSEEventParserTests.swift`.
- Add `.archive/` to `.gitignore`.

### B — Security / sandboxing
- `LLMClient.swift`: `init(apiKey:)` no longer reads env; key must be supplied by Keychain caller. `LLMError.missingAPIKey` message points to Keychain.
- `QueenStatusViewModel.swift`: pid-based `terminateProcesses(named:matchingArguments:)`, `commandDenylist`, `isSafeEnvValue(_:)`, `isTrustedExecutable(_:)`, fixed system executable paths.
- `clade-build/src/main.rs`: `Variant` carries `mesh_port` and `canary_mcp_port`; Info.plist template emits both.
- `AnalyticsService.swift`: explicit `init(from:)` decoder for `properties: [String: Any]`.

### C — Cleanup / trust model
- `ChatViewModel.swift`: deduplicated `deleteConversation(_:)`, `renameConversation(_:to:)`, `togglePin(_:)`, `createNewConversation()`; added `selectConversation(_:)`.
- `README.md`: stats refreshed (~77k LOC / ~492 files / 7+ loops).

## Verification

- `cargo test --workspace` — 270+ tests passed.
- `cargo clippy --workspace --all-targets -- -D warnings` — clean.
- `bash build.sh` — QueenUILib + Swift aggregate build + app bundle + codesign OK.
- `swift test` skipped because XCTest is not present in the CLI toolchain (documented in `build.sh`).

## Remaining for future cycles

- `GitHubAPIClient` Keychain-only token supply.
- Full Noise-XX handshake or spec correction.
- HELLO replay/freshness on HTTP `/hello`.
- `.aiignore` defaults + agent-context scoping.
- LAN/mDNS peer pinning with static keys.
- `SafeFilePath` applied beyond CladeGuard.
- MCP/tool config change approval gate.
- Continue archiving remaining dead BR-OUTPUT prototypes.
- Resolve `.trinity/specs` contradictions before 2026-07-28 waiver expiry.
- Register or delete `trios-mesh/src/bin/trios_meshd.rs`.
