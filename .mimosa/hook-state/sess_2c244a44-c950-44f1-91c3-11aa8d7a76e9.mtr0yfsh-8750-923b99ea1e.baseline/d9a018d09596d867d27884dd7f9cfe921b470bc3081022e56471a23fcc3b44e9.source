# TriOS 15m Weak-Spot Loop — Combined Plan 005 (A + B + C)

## User choice
Reply to the previous loop report was **"все три"** — implement all three variants. The combined scope is larger than one 15-minute loop, so this plan does the **critical first slice of each variant** in a single cycle, leaving the remainder in the backlog for follow-up loops.

## Phase ordering
1. **A-first**: fix `build.sh` compile errors so the Swift build gate passes. This unblocks verification of B and C changes.
2. **C**: add mesh daemon token sharing and Bearer headers in the Swift mesh clients.
3. **B**: remove `sudo` and harden command execution in BR-OUTPUT.
4. **Verification**: run `cargo test`, `cargo clippy`, `swift build`, SSE E2E, mesh E2E, and `build.sh`.

---

## Phase A — Swift build/test harness (critical slice)

### A1. Fix `build.sh` Swift compile errors
- File: `BR-OUTPUT/ChatPanelView.swift`
- Problems from the last `build.sh` run:
  - `.onChange(of: viewModel.messages.count) { oldCount, newCount in ... }` triggers a SwiftUI arity/type mismatch under the `swiftc` toolchain used by `build.sh` (works under `swift build` Package.swift target).
  - `.onChange(of: viewModel.messages.last?.content)` returns `String?` and also fails arity inference.
  - `.onChange(of: browserOSVM.messages.count)` same issue.
  - `StableMessageView` is referenced but not defined.
- Fix strategy:
  - Wrap `viewModel.messages.count` and `browserOSVM.messages.count` into private `@State` or computed trigger properties that produce a plain `Equatable` value.
  - Use single-closure `.onChange(of: value) { _ in ... }` where supported, or replace with `onReceive` of a `PassthroughSubject`/`Notification` for older SwiftUI compatibility.
  - Provide a minimal `StableMessageView.swift` in `BR-OUTPUT` that forwards to `MessageBubbleView` if a full implementation is not available.

### A2. Convert next batch of ad-hoc tests to XCTest
- Pick 3–5 representative scripts from `tests/swift/` and convert them to `tests/TriOSKitTests/`.
- Examples: `chat_composer_style_test.swift`, `trios_branding_test.swift`, `chat_scroll_restoration_policy_test.swift`.
- Keep the conversions mechanical: extract assertions into `XCTestCase` methods.

### A3. Gate `swift build` / `swift test`
- Ensure `swift build` from repo root remains green.
- Add a `swift test` invocation to `build.sh` (commented-out fallback for CommandLineTools, but enabled for CI/Xcode).

---

## Phase C — Mesh auth end-to-end (critical slice)

### C1. Secure token sharing
- `clade-meshd` already loads/generates `TRIOS_MESH_API_TOKEN`. Swift UI needs the same token.
- Strategy: when `clade-meshd` is launched from the Swift app, pass `TRIOS_MESH_API_TOKEN` explicitly in the child-process environment. When launched standalone, require the env var (fail-closed) instead of auto-generating a token that the UI cannot know.
  - File: `rings/RUST-13/clade-meshd/src/main.rs` — if `TRIOS_MESH_API_TOKEN` is unset, print a clear error and exit instead of generating a random token.
  - File: `BR-OUTPUT/ServerManager.swift` — when launching the companion, also start `clade-meshd` (if managed) with `TRIOS_MESH_API_TOKEN` set from a Keychain-stored or env-provided value.

### C2. Add Bearer headers to mesh clients
- Files: `BR-OUTPUT/MeshChatViewModel.swift`, `BR-OUTPUT/MeshStatusViewModel.swift`.
- Add a `meshToken: String` initializer parameter with env fallback.
- Inject `Authorization: Bearer <meshToken>` into every mutating HTTP request (`/seed-peer`, `/messages/*`, `/conversations`, `/observe`, `/hello`, `/force-dead`, etc.).
- Health/status may remain unauthenticated to support liveness checks, but all state-changing paths must send the header.

### C3. CORS update
- File: `rings/RUST-13/clade-meshd/src/main.rs`
- Replace exact-string `allow_origin("http://127.0.0.1")` with `allow_any_origin()` because the auth header makes origin relaxation safe for local loopback, or enumerate origins/ports the UI uses.

---

## Phase B — BR-OUTPUT security hardening (critical slice)

### B1. Remove `sudo tailscale` from `ServerManager`
- File: `BR-OUTPUT/ServerManager.swift`, `toggleFunnel()`
- Replace automatic `sudo` execution with:
  - A user-visible alert/instructions to run `tailscale serve --https=443 http://127.0.0.1:<port>` manually, OR
  - Use Tailscale's macOS URL scheme / GUI API if available, OR
  - Use `SMJobBless`/`SMAppService` with a dedicated privileged helper tool (defer to a later P1 loop if not feasible in 15m).
- Minimum: stop spawning `/usr/bin/sudo tailscale` automatically from the app.

### B2. Harden `QueenStatusViewModel.runCommand()`
- File: `BR-OUTPUT/QueenStatusViewModel.swift`
- Replace `/usr/bin/env` dispatcher with a fixed `executableURL` map for each allowed high-level operation.
- Keep the blocklist as defense-in-depth, but the primary control becomes: literal executable path + literal argument array.
- Validate numeric PIDs and other user-influenced values before interpolation.

### B3. LLM/GitHub key validation
- File: `BR-OUTPUT/LLMClient.swift`
- Throw `missingAPIKey` immediately when no key is found; do not allow empty string.
- Update error text to mention both `TRIOS_API_KEY` and `OPENROUTER_API_KEY`.
- File: `BR-OUTPUT/GitHubAPIClient.swift`
- Add non-empty key guard and redact key from any logs.

### B4. Force-unwrap cleanup (first pass)
- Replace `URL(string: ...)!` in mesh clients with `guard let` + fallback.
- Replace `FileManager.default.urls(...).first!` with `guard let` where found.

---

## Backlog after this cycle

- Complete conversion of all ~29 ad-hoc Swift tests.
- Move API keys from env to macOS Keychain (`SecItemAdd`/`SecItemCopyMatching` wrapper).
- Implement full Noise-XX (`ee, es, se`) or correct spec claims.
- Add replay/freshness protection to HTTP `/hello` or move MAC validation to authenticated UDP path.
- Resolve contradictions in `.trinity/specs/` and archive dead `BR-OUTPUT` prototypes.
- Register or delete `trios-mesh/src/bin/trios_meshd.rs`.

## Verification gates
- `cargo test --workspace` — pass.
- `cargo clippy --workspace --all-targets` — clean.
- `bash rings/RUST-13/clade-meshd/tests/run_mesh_chat_transport.sh` — pass.
- `swift build` (repo root) — pass.
- `bash tests/swift/run_chat_sse_e2e.sh` — pass.
- `bash build.sh` — pass (this is the primary success criterion for Phase A).
