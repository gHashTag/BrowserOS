# TriOS 15m Weak-Spot Loop — Plan 004

## Trigger
`/loop 15m` recurring audit + fix cycle for `/Users/playra/BrowserOS-full/trios`.

## Scope this cycle
Fix the highest-signal mesh crypto issue found in the audit: **HELLO beacon MAC uses a hardcoded global key and an AEAD tag instead of a proper MAC**. This is a P0 security bug in `trios-mesh/src/discovery.rs` that breaks the authenticated-HELLO goal and contradicts the `mesh-panic-hardening` spec.

## Decomposed tasks

1. **P0 — Remove hardcoded `HELLO_MAC_KEY` fallback**
   - File: `rings/RUST-13/trios-mesh/src/discovery.rs`
   - Change `mac_key: &Option<[u8; 32]>` to `session_key: [u8; 32]` in `authenticated`, `compute_mac`, and `verify_mac`.
   - Delete the `HELLO_MAC_KEY` constant.
   - If no session key is available, fail closed (return `MeshError::CryptoInternal`) rather than fall back to a public constant.

2. **P1 — Replace AEAD-tag MAC with HMAC-SHA256**
   - Add `hmac = "0.12"` to `rings/RUST-13/trios-mesh/Cargo.toml`.
   - Derive a 32-byte HELLO MAC key from the session key via HKDF-Expand with info `"hello-mac"`.
   - Compute the 16-byte MAC as the first 16 bytes of `HMAC-SHA256(hello-mac-key, src || seq || ts || heard[])`.
   - Verify by recomputing and comparing in constant time (`subtle` is already used by `clade-meshd`; add it to `trios-mesh` too).

3. **P1 — Update all Rust callers**
   - `clade-meshd/src/main.rs` `hello_handler`: stop calling `Hello::authenticated` with a fake/None key; record ETX directly until the HTTP endpoint carries a real session key/MAC.
   - `trios-mesh/src/bin/trios_meshd.rs`: derive the per-peer session and pass it to `Hello::authenticated`.
   - `discovery.rs` tests: pass explicit session keys and assert MAC behavior still holds.

4. **P1 — Document spec reconciliation**
   - Note that `mesh-panic-hardening.md` claims per-session derived MAC and proper MAC primitive; the implementation now matches. If full Noise-XX is still simplified, that remains a separate P1 follow-up.

5. **Verification gates**
   - `cargo test --workspace` must pass.
   - `cargo clippy --workspace --all-targets` must be clean.
   - `bash rings/RUST-13/clade-meshd/tests/run_mesh_chat_transport.sh` must pass.
   - `swift build` and `bash build.sh` must remain green.

## Competitor snapshot (July 2026)
Dedicated mesh/off-grid AI agent tooling is now a real competitive vector:

- **AgentHive** (`shaiknoorullah/agenthive`) — Go + libp2p, true P2P with Noise XX, CRDT state sync, first-response-wins action gate. No cloud broker. Claude Code integration via `PreToolUse` hook.
- **Repowire** (`prassanna-ravishanker/repowire`, `repowire.io`) — local-first mesh with optional hosted relay for browser/phone. Supports Claude Code, Codex, Gemini CLI, OpenCode. Free/open source.
- **claude-mesh** (`pouriamrt/claude-mesh`) — TypeScript self-hosted HTTP/SSE relay for Claude-to-Claude messaging using Anthropic's `claude/channel` MCP feature.
- **claudemesh** (`alezmad/claudemesh`) — P2P substrate for Claude Code sessions, ed25519/libsodium, broker routes ciphertext only.

Incumbents added local sandboxing: Claude Code Seatbelt, Cursor Run Modes, GitHub Copilot Workspace MXC + code-review firewall.

TriOS must ship: (1) OS-keychain secrets, (2) default-deny command sandbox, (3) E2E-encrypted mesh with TOFU/allow-list pinning, (4) signed releases/SBOM, (5) spec-implementation consistency so marketing claims match code.
