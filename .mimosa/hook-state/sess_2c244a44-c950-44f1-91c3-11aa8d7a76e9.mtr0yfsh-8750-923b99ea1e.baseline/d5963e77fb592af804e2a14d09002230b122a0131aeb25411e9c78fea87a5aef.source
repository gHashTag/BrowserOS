# trios 15m loop — cycle 6 plan

**Date:** 2026-07-22  
**Branch:** feat/zai-provider  
**Trigger:** recurring `/loop 15m` hardening command + "реализуй все"

## 1. Weak spots researched

### Build / ship (P0)
- Root `Package.swift` exists but only includes a curated source set. `CladeGuard.swift` is not in it, so its ad-hoc test in `tests/swift/clade_guard_test.swift` has not been migrated to XCTest.
- `build.sh` does not run `swift test`.
- `tests/swift/` still contains 31+ ad-hoc `@main` tests; only 4 XCTest files exist in `tests/TriOSKitTests/`.

### Security / reliability (P1) — July 2026 incidents make these urgent
- **Grok Build exfiltration** (July 2026): tool marketed as "local-first" silently uploaded repos + SSH keys. TriOS still falls back to env API keys and has no `.aiignore`/scoped-context defaults.
- **GhostApproval symlink attack** (CVE class, July 2026): malicious repos redirect agent writes to `~/.ssh/authorized_keys` via symlinks. TriOS code writes snapshots, sidecars, and temp files without symlink/traversal validation.
- **AWS Kiro RCE** (CVE-2026-10591): agent rewriting its own MCP config without prompting → arbitrary code execution. TriOS has no explicit approval gate for tool/MCP config changes.
- **OpenClaw mDNS CVE-2026-26327**: unauthenticated mDNS TXT records redirect clients to attacker endpoints. TriOS discovery currently trusts LAN/mDNS.
- `ModelConfigurationStore` still reads cloud provider API keys from environment variables (`TRIOS_API_KEY`, `OPENAI_API_KEY`, etc.) after Keychain miss.
- `ModelProvider.environmentFallback(...)` exposes the same env fallback for runtime config.

### Tech debt (P2)
- `trios-mesh/src/bin/trios_meshd.rs` is still unregistered / not compiled.
- `.trinity/specs` contradictions unresolved.
- 20 untracked BR-OUTPUT prototypes and expiring waivers (2026-07-28).

## 2. Competitor snapshot (July 2026)

| Tool | Strength vs TriOS | Gap TriOS can exploit | New risk / lesson |
|---|---|---|---|
| Claude Code | 1M ctx, ~64.3% SWE-bench Pro, background subagents | Terminal/cloud only; no native macOS UI or mesh | TriOS should wrap Claude Code, not compete on model |
| Cursor Composer | Cloud agents, iOS beta, agent swarm research | Locked to Cursor; cloud-first | Own the "no cloud required" narrative |
| GitHub Copilot Workspace / app | GA desktop app, MCP, enterprise SSO | SaaS-only, no local-first privacy | Add policy/audit controls without SaaS dependency |
| Repowire | Mature MCP mesh, durable jobs, webhook federation | Not native macOS; no radio | Design mesh federation/event ingress now |
| AgentHive + peat-mesh | libp2p CRDT sync, Ed25519/X25519/ChaCha20-Poly1305 | Not a Swift macOS coding workspace | CRDT shared memory is a credible differentiator |
| ClaudeMesh | Drop-in E2E chat for Claude Code | Broker WebSocket, no radio | Mesh must work without broker |
| IronMesh | First-class Reticulum/LoRa, CrewAI/Ollama bridge | Not a macOS workspace | Professionalize LoRa/Reticulum UX |
| Lantor | Local-first macOS workspace, SQLite memory | No mesh/radio | Validates demand; TriOS differentiates on mesh |
| M1K3 | On-device MLX inference | Not multi-agent/off-grid | Plan MLX/Ollama fallback for off-grid |
| Workcell | Colima VM + hardened container runtime | Not a workspace UI | Runtime isolation is now a feature |
| MeshClaw / DARKNODE | LLM agents over Meshtastic LoRa | Hobbyist UX | TriOS can professionalize radio dev workflow |

**Key security lessons from July 2026 incidents:**
1. Never let "local-first" be marketing only — ship verifiable isolation (network inspector, `.aiignore` defaults, bounded runtime).
2. Resolve and validate every write path; reject symlinks outside workspace and sensitive-path redirects.
3. Require explicit user approval for MCP/tool config changes and sensitive file writes.
4. Do not trust mDNS/LAN discovery metadata alone; pin peer static keys out-of-band.
5. Use a standard Noise pattern and document exact crypto semantics; align with OWASP AISVS/ASVS V12.

## 3. Decomposed plan for cycle 6 (realistic 15m slice)

Because "реализуй все" is impossible in one loop, cycle 6 takes the highest-ROI first slice across three vectors:

### A — Swift XCTest harness expansion (P0)
- Add `CladeGuard.swift` and required companion `HealthCheckTransport.swift` to root `Package.swift`.
- Convert `tests/swift/clade_guard_test.swift` to `tests/TriOSKitTests/CladeGuardTests.swift` as a proper `XCTestCase` subclass.
- Add `swift test` invocation to `build.sh` after the binary build, guarded by a `TRIOS_SKIP_SWIFT_TEST` opt-out.

### B — Remove cloud API key environment fallbacks (P1)
- `ModelConfigurationStore`: stop reading `TRIOS_API_KEY`, `OPENAI_API_KEY`, etc. from `environment`. Only Keychain (or no key for ollama) is acceptable.
- Update `credentialStatus` to never advertise "Loaded from environment".
- `ModelProvider.environmentFallback(...)` no longer resolves provider API keys from env.
- Keep env overrides for provider/model/baseURL selection because those are not secrets.

### C — Defend against GhostApproval-style symlink/path attacks (P1)
- Add `TriOSKit/SafeFilePath.swift` under `rings/SR-00/` with:
  - `validateWritePath(candidate:base:)` that resolves realpath, rejects symlinks, rejects paths outside base, rejects sensitive directories (`~/.ssh`, `~/.aws`, Keychain dirs, shell rc files).
  - `validateNoSymlinkJump(_:)` helper.
- Apply the guard in `CladeGuard.snapshotCurrentBinary()` and `applySnapshot()` before writing snapshots or replacing the binary.
- Add a default `.aiignore` helper/pattern list so agent context excludes `~/.ssh`, `~/.aws`, `.env`, keychain, history, and canary tokens.

## 4. Implementation order
1. Write/update plan file (this doc).
2. Update `Package.swift` to include `CladeGuard.swift` + `HealthCheckTransport.swift`.
3. Create `CladeGuardTests.swift` from the ad-hoc test logic.
4. Harden `ModelConfigurationStore.swift` and `ModelProvider.swift` (remove env API key reads).
5. Add `SafeFilePath.swift` and apply it in `CladeGuard.swift`.
6. Update `build.sh` to run `swift test`.
7. Run gates: `cargo test --workspace`, `cargo clippy --workspace --all-targets`, `swift build`, `swift test`, `build.sh`, mesh E2E, SSE E2E.
8. Commit and write final report with three cooperation options.

## 5. Out-of-scope for this loop (backlog for cycle 7)
- Full Noise-XX handshake (`ee, es, se`) or removal of the claim.
- Replay/freshness protection for HELLO frames.
- MCP config change approval gate (Kiro RCE defense UI).
- mDNS discovery authentication/pinned keys (OpenClaw CVE defense).
- Runtime isolation / Colima VM integration.
- Porting remaining ~30 ad-hoc Swift tests to XCTest.
- Resolving `build.sh` vs `clade-build` canonical source disagreement.
- Registering or deleting `trios-mesh/src/bin/trios_meshd.rs`.
- Archiving dead BR-OUTPUT prototypes and updating README stats.
