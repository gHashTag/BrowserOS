# TriOS 15m Weak-Spot Loop — Plan 002

## Trigger
`/loop 15m` recurring audit + fix cycle for `/Users/playra/BrowserOS-full/trios`.

## Scope this cycle
Build the Swift Package Manager infrastructure that the project is missing, and fix the broken SSE E2E script that tests the chat runtime.

## Done this cycle
- [x] Added root-level `Package.swift` with a `TriOSKit` library target.
- [x] `TriOSKit` includes `rings/SR-00`, `rings/SR-01`, `rings/SR-02` + the 7 `BR-OUTPUT` companion files required for type-checking.
- [x] `swift build` from repo root succeeds and links `TriOSKit`.
- [x] Converted 3 representative ad-hoc `@main` tests to `XCTest` in `Tests/TriOSKitTests/`:
  - `AssistantActionBarPolicyTests`
  - `TriosBrandingTests`
  - `ChatLogicTests`
- [x] Fixed `tests/swift/run_chat_sse_e2e.sh` to include missing `BR-OUTPUT` companions (`TriosTheme`, `GitHubModels`, `GitHubAPIClient`).
- [x] Verified `bash tests/swift/run_chat_sse_e2e.sh` passes all scenarios.
- [x] Verified `cargo clippy --workspace --all-targets` and `cargo test --workspace` still pass.

## Known environment limitation
`swift test` requires the full `XCTest` framework, which is present in Xcode.app but not in the CommandLineTools SDK available in this environment. `swift build` works. CI runners with Xcode will be able to run `swift test`.

## Backlog for next cycles (prioritized)

### P0 — build / ship blocking
- Convert remaining 29 ad-hoc Swift tests in `tests/swift/` to `XCTest` and add them to `Tests/TriOSKitTests/`.
- Integrate `swift build` (and `swift test` on CI/Xcode) into `build.sh` / `clade-build` so SPM is a first-class gate.
- Resolve `build.sh` vs `clade-build` disagreement on canonical Swift source set.
- `QueenUILib` external dependency still requires sibling `gHashTag/trinity` checkout.

### P1 — security / reliability
- Remove or gate `sudo` in `ServerManager.toggleFunnel()` (`BR-OUTPUT/ServerManager.swift:185`, `:195`).
- Harden `QueenStatusViewModel.runCommand()` allowlist/blocklist and validate argv tokenization.
- Move API keys from environment to Keychain (`LLMClient`, `GitHubAPIClient`).
- Replace force unwraps of `FileManager.default.urls(…).first!` and `URL(string:…)!` in BR-OUTPUT.
- Add authentication / origin token to `clade-meshd` HTTP API.

### P2 — tech debt / observability
- Resolve contradictions in `.trinity/specs/` (response indicator black vs white, status bar existence, 999 shortcut mapping, composer opacity).
- Archive or integrate 13 dead untracked `BR-OUTPUT/*.swift` prototypes.
- Port `tests/swift/run_chat_sse_e2e.sh` logic into an XCTest so it runs under `swift test`.
- `MessageStore` re-serializes entire JSON on every message; add debounced flush or WAL.

### P3 — cleanup
- `AGENT-V-WAIVER` files in `BR-OUTPUT/` expire 2026-07-28; seal or move.
- Stale `README.md` stats.
- `ChatViewModel` fire-and-forget `Task` in `init`.

## Competitor snapshot (July 2026)
See memory `trios-weakspot-backlog.md` for the full table. The key shift since the last loop: dedicated mesh/off-grid AI tools (`Repowire`, `AgentHive`, `ClaudeMesh`, `IronMesh`) now exist and compete directly with TriOS’s differentiation. TriOS must harden E2E crypto, hardware-radio readiness, and local-first governance to stay defensible.
