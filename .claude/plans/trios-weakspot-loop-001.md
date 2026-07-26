# TriOS 15m Weak-Spot Loop — Plan 001

## Trigger
`/loop 15m` recurring audit + fix cycle for `/Users/playra/BrowserOS/trios`.

## Scope this cycle
Fix the highest-signal, lowest-risk blockers discovered by the audit:
1. Workspace clippy gate (P0).
2. Test hygiene in `clade-meshd` (hardcoded `/tmp`, temp-dir collisions) (P2).
3. `clade-meshd` wide-open CORS (P1).
4. Hardcoded Tailscale public hostname in `main.swift` (P1).

## Done this cycle
- [x] `clade-meshd` now compiles clean under `cargo clippy --workspace --all-targets`.
- [x] Tests use isolated `temp_dir()` subdirectories per test and clean up.
- [x] `clade-meshd` CORS restricted to `http://127.0.0.1` (daemon already binds loopback).
- [x] `main.swift` `openPublic()` reads `TRIOS_PUBLIC_HOST` with a safe fallback.

## Backlog for next cycles (prioritized)

### P0 — build / ship blocking
- `QueenUILib` dependency: `build.sh` requires external `gHashTag/trinity` checkout. Either vendor dylib, add submodule, or remove dependency.
- No `Package.swift` / XCTest harness: `swift test` cannot run; `tests/swift/*.swift` are ad-hoc scripts.
- `build.sh` vs `clade-build` disagree on which `BR-OUTPUT` files are canonical source vs prototype scratchpad.

### P1 — security / reliability
- `clade-meshd` HTTP API has no authentication or origin token; restrict CORS further or add API token.
- `ServerManager` uses `sudo tailscale serve`; replace with privileged helper or user-guided setup.
- `QueenStatusViewModel` command runner is bypassable; align with `TerminalCommandSanitizer`.
- API keys read from env, not macOS Keychain (UI claims Keychain).
- `RecursionGuard` `NSAppleScript` fallback fails silently without Accessibility permission.

### P2 — tech debt / observability
- `MessageStore` re-serializes entire JSON on every message; add debounced flush or WAL.
- UDP transport silently breaks on error; add metrics and bounded retry.
- `run_frame_processor` silently drops failures; add counters.
- UDP port auto-assignment wraps for large `node_id`.
- E2E is a bash script (`e2e/trios_e2e_flow.sh`) violating L7 UNITY; port to `clade-e2e`.

### P3 — cleanup
- Stale `README.md` stats.
- `AGENT-V-WAIVER` files in `BR-OUTPUT/` expire 2026-07-28; seal or move.
- `ChatViewModel` fire-and-forget `Task` in `init`.
- `ChatRequestBuilder.defaultModel` hardcodes possibly-invalid model names.

## Competitor snapshot (July 2026)
| Tool | Strength vs TriOS | Gap TriOS can exploit |
|------|-------------------|------------------------|
| Claude Code | Best terminal agentic loop, 1M context, 87.6% SWE-bench | No native mesh/off-grid collaboration; no hardware-radio integration |
| Cursor Composer | IDE-native visual diffs, cloud agents | Locked to Cursor editor; no local mesh daemon |
| GitHub Copilot Workspace | Issue-to-PR governance, enterprise SSO | Cloud-only; no offline/mesh operation |

TriOS differentiation: local-first, mesh-networked, hardware-radio-ready AI workspace. Next loop should harden the local/mesh trust model so this differentiation is defensible.
