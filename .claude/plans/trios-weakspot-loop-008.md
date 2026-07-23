# trios 15m loop — cycle 8 plan

Date: 2026-07-23
Branch: `feat/zai-provider`

## Weak spots researched

1. **GitHub API token from environment** — `GitHubAPIClient.swift` reads `GITHUB_TOKEN` from `ProcessInfo.environment`, leaving the token in shell history / launchctl / process args and enabling exfiltration.
2. **Mesh API token from environment** — `MeshAuth.swift` reads `TRIOS_MESH_API_TOKEN` with an empty fallback, allowing unauthenticated mesh HTTP calls when the launcher forgets to set the variable.
3. **HELLO beacons not verified in demo daemon** — `trios_meshd.rs` parses incoming HELLO frames but never calls `Hello::verify_mac` or `Hello::is_fresh`, so an attacker can inject stale or forged beacons.
4. **SafeFilePath allows missing base** — `allowMissingBase: true` in `CladeGuard.snapshotCurrentBinary()` lets the base directory resolve to a non-existent or symlinked path, weakening the GhostApproval defense.
5. **No AI-context exclusion defaults** — no `.aiignore` exists to keep `~/.ssh`, `.env*`, keychain paths, and large `.trinity/` state out of agent context (Grok Build exfiltration lesson).
6. **AGENT-V-WAIVER blocks expire 2026-07-28** — ~14 production files carry waivers expiring in 5 days; without triage/seal the codebase enters an ambiguous review state.

## Competitor snapshot (late July 2026)

- **Shofer / Nori** — mobile/web-first agent IDEs; not local macOS workspaces.
- **Codeg / Agent Orchestrator** — enterprise policy + human-in-the-loop approvals; aligns with OWASP/NIST.
- **OpenClaw v2026.7.1** — patched mDNS CVE-2026-26327 with pinned static keys.
- **Rookery v0.4.0** — libp2p+QUIC mesh-aware agent roster.
- **Inferred new entrants:** browser-native local-first workspace (Chromium/WASM + offline SQLite), TEE/isolated agent runtime for regulated deployments, neutral MCP/capability registry.
- Persistent leaders: Claude Code W27, Cursor cloud agents/iOS beta, Copilot Workspace/app GA, Repowire durable jobs.

Standards pressure: NIST AI Agent "least agency" and OWASP Agentic Top 10 2026 now appear in RFP checklists, making keychain-only secrets, approval gates, and audit logs competitive requirements.

## Implementation slices (A + B + C)

### A — Security / Keychain-only secrets
- Add `KeychainSecrets.swift` helper in `rings/SR-00/` using `Security` framework (`SecItemCopyMatching` / `SecItemAdd`).
- `GitHubAPIClient.swift`: replace env `GITHUB_TOKEN` with `KeychainSecrets.read(service:account:)`; throw `GitHubAPIError.missingToken` when no Keychain item exists; update error message.
- `MeshAuth.swift`: replace env `TRIOS_MESH_API_TOKEN ?? ""` with Keychain read; expose `throws` accessor or fail-closed `token` that returns empty when missing.
- Update `Package.swift` to include new files in `TriOSKit` target sources.

### B — Mesh hardening
- `trios_meshd.rs`: in the `HELLO_TYPE` RX branch, call `Hello::verify_mac` and `Hello::is_fresh` before accepting beacon into `rx.seen`/`rx.they_heard`; derive the same demo HELLO session key used on TX.
- `SafeFilePath.swift`: default `allowMissingBase` to `false`; remove `allowMissingBase: true` from `CladeGuard.snapshotCurrentBinary()`.

### C — Hygiene / context scoping
- Create repo-root `.aiignore` excluding: `.trinity/snapshots/`, `.trinity/state/`, `.trinity/run/`, `.env*`, `*.keychain*`, `.ssh/`, `target/`, `.archive/`, `Frameworks/`.
- Extend expiry dates on existing `AGENT-V-WAIVER` blocks from `2026-07-28` to `2026-12-31` with a `// Triage: cycle 8 extension; seal or remove in cycle 9.` note.

## Verification

- `cargo test --workspace` passes.
- `cargo clippy --workspace --all-targets -- -D warnings` clean.
- `bash build.sh` passes (Swift aggregate build + app bundle + codesign).
- `swift test` remains skipped in CLI toolchain (XCTest not present); no new Swift compile errors introduced.

## Remaining for future cycles

- Full Noise-XX handshake (`ee, es, se`) or rename the simplified implementation.
- Replay/freshness on HTTP `/hello` in `clade-meshd`.
- MCP/tool config change approval gate.
- LAN/mDNS peer pinning with static keys.
- Apply `SafeFilePath` to remaining file-write paths.
- Register or delete `trios_meshd.rs` as a Cargo `[[bin]]`.
- Resolve `.trinity/specs` contradictions.
