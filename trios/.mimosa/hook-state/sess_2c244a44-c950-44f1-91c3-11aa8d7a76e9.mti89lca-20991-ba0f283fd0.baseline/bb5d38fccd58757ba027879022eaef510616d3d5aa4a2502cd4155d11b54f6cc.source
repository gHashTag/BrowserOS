# TriOS 15m Weak-Spot Loop — Plan 003

## Trigger
`/loop 15m` recurring audit + fix cycle for `/Users/playra/BrowserOS/trios`.

## Scope this cycle
Harden the `clade-meshd` HTTP and UDP transport attack surface — the highest-signal P0/P1 security issues found in the audit.

## Done this cycle
- [x] Added `security.rs` module with API-token authentication (`Authorization: Bearer`), request-size limits, payload/kind validation, loopback-only UDP policy, and seed-address collision detection.
- [x] Added `rand` and `subtle` deps to `clade-meshd/Cargo.toml`.
- [x] Replaced unbounded UDP channels in `transport.rs` with bounded channels (capacity 256) and a 1 KiB frame ceiling.
- [x] Moved chat-store persistence out of the async write lock in `run_frame_processor` to a background task.
- [x] Added `Authorization: Bearer` to all state-changing `clade-meshd` HTTP endpoints; health remains unauthenticated for liveness checks.
- [x] Replaced crypto-failure-detail responses (`format!("{:?}", e)`) with constant `decrypt failed` / `unauthorized` messages.
- [x] Enforced loopback-only UDP bind unless `TRIOS_MESH_UDP_EXTERNAL=true` is set.
- [x] Reject `/seed-peer` when the address is already mapped to a different peer.
- [x] Updated `run_mesh_chat_transport.sh` to extract generated API tokens and send them on all state-changing requests.
- [x] Verified `cargo clippy --workspace --all-targets` exit 0, `cargo test --workspace` all pass, `swift build` passes, `bash build.sh` passes, SSE E2E script passes, and mesh chat transport E2E passes.

## Backlog for next cycles (prioritized)

### P0 — build / ship blocking
- Convert remaining 29 ad-hoc Swift tests to XCTest and wire them into `Tests/TriOSKitTests/`.
- Integrate `swift build` / `swift test` into `build.sh` and `clade-build` gates.
- Resolve `build.sh` vs `clade-build` disagreement on canonical Swift source set.
- `QueenUILib` external dependency still requires sibling `gHashTag/trinity` checkout.

### P1 — security / reliability (remaining)
- Remove or gate `sudo` in `ServerManager.toggleFunnel()` (`BR-OUTPUT/ServerManager.swift:185`, `:195`).
- Harden `QueenStatusViewModel.runCommand()` allowlist/blocklist and argv tokenization.
- Move API keys from environment to Keychain (`LLMClient`, `GitHubAPIClient`).
- Replace force unwraps of `FileManager.default.urls(…).first!` and `URL(string:…)!` in BR-OUTPUT.
- Add per-session HELLO MAC key and freshness verification in `clade-meshd` `/hello` (currently hardcoded key + no replay guard).
- Replace static PSK sessions with Noise-XX ephemeral handshake + allow-list.
- Stop loading private mesh key from env var in production (`TRIOS_MESH_PRIVATE_KEY`).

### P2 — tech debt / observability
- Resolve contradictions in `.trinity/specs/` (response indicator black vs white, status bar existence, 999 shortcut mapping, composer opacity).
- Archive or integrate 13 dead untracked `BR-OUTPUT/*.swift` prototypes.
- Port SSE E2E bash script logic into XCTest.
- `MessageStore` re-serializes entire JSON on every message; add debounced flush or WAL.
- Add structured counters for UDP/crypto failures instead of silently dropping.

### P3 — cleanup
- `AGENT-V-WAIVER` files in `BR-OUTPUT/` expire 2026-07-28; seal or move.
- Stale `README.md` stats.
- `ChatViewModel` fire-and-forget `Task` in `init`.

## Competitor snapshot (July 2026)
Dedicated mesh/off-grid AI tools now compete directly with TriOS: Repowire (MCP/hook mesh), AgentHive (P2P CRDT + Noise), ClaudeMesh (E2E chat for Claude Code), IronMesh (LoRa/Ollama). Incumbents added local sandboxes: Claude Code Seatbelt, Cursor Run Modes, GitHub Copilot MXC + code-review firewall, Vigils SLSA/Sigstore. TriOS must ship: (1) OS-keychain secrets, (2) default-deny command sandbox, (3) E2E-encrypted mesh with TOFU pinning, (4) signed releases/SBOM.
