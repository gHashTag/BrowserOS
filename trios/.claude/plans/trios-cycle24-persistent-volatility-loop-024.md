# Cycle 24 — Persistent Volatility History for Adaptive Warmup

## Context
Cycle 23 added `WarmupVolatilityTracker` to shrink/relax predictive warmup TTL and scheduler interval based on whether cached winners succeed or fail on real chat sends. The tracker is currently in-memory only; any app restart wipes the signal and the system relearns provider flakiness from scratch. This cycle persists that history into the encrypted SQLCipher-backed `MemoryStore` so adaptive warmup remembers across sessions.

## Goals
- [x] `WarmupVolatilityTracker` windows survive app restarts.
- [x] History is encrypted at rest using the existing trios encryption stack.
- [x] Load/save is transparent to `ModelConfigurationStore` and `ChatViewModel`.
- [x] The persisted data can be inspected and reset from the UI.
- [x] All Trinity gates remain at zero findings.

## Tasks
- [x] **1. Spec persisted record schema**
  - Define `WarmupVolatilityRecord` (candidate fields, window outcomes as `[Bool]`, updatedAt, version).
  - Decision: single JSON blob under a well-known key in `~/Library/Application Support/Trinity S3AI/AgentMemory/warmup-volatility.json.enc`. Candidate key is ASCII-only and stable.

- [x] **2. Create `VolatilityHistoryStore` actor**
  - File: `trios/rings/SR-00/VolatilityHistoryStore.swift`.
  - Uses `TriOSEncryption(keyName: "warmup-volatility")` and writes/reads the encrypted JSON file.
  - `load()`, `save(_:)`, `reset()` implemented; corrupt/missing files fail gracefully.

- [x] **3. Extend `WarmupVolatilityTracker` with persistence**
  - Added optional `historyStore: VolatilityHistoryStore?` and `loadHistory()` / `persist()` helpers.
  - Added `CrossProviderModelCandidate.stableKey` and init from stable key.
  - `record()` is now async and persists after updating the in-memory window.
  - Added `hasHistory`, `learnedCandidateCount`, and async `reset()`.

- [x] **4. Wire into `ModelConfigurationStore`**
  - `ModelConfigurationStore` injects a default `VolatilityHistoryStore` into the tracker unless a tracker is provided.
  - History is loaded in a startup `Task`.
  - Exposes `hasWarmupVolatilityHistory`, `warmupVolatilityHistoryCount`, `resetWarmupVolatilityHistory()`.

- [x] **5. Add UI indicator and reset action**
  - `ModelsTabView.adaptiveWarmupSection` shows "Learning from N candidate(s)" when history exists.
  - Added a "Reset learning" button.

- [x] **6. Tests**
  - `VolatilityHistoryStoreTests.swift` — round-trip, encryption, reset, corrupt discard, overwrite.
  - Extended `WarmupVolatilityTrackerTests.swift` — load restores windows, mismatched window size ignored, reset clears disk.

- [x] **7. Seal**
  - `bash build.sh` PASS; `cargo test --workspace` PASS; `cargo clippy --workspace` PASS; `cargo run --bin clade-audit` 0 findings; `cargo run --bin clade-seal` SEAL VALID; `cargo run --bin clade-e2e` PASS; `open trios.app` relaunched, menu-bar logo present.

- [x] **8. Report + experience save**
  - Report: `.claude/plans/trios-cycle24-persistent-volatility-loop-024-report.md`.
  - Updated `.trinity/experience.md` and created `.trinity/experience/2026-07-26_persistent-volatility-history-loop-024.json`.
  - Proposed three Cycle 25 variants.

## Risks / Mitigations
- **Migration hazard:** Version field + discard-on-parsing-failure prevents old/corrupt snapshots from crashing startup.
- **Encryption key unavailability in CLI tests:** `TriOSEncryption(keyURL:)` used in tests avoids Keychain prompts.
- **Concurrency:** Async `record()` awaits persistence inside actor isolation; `persist()` reads the current `windows` so the final persisted state is always the latest.

## Next-loop variants
1. **Cycle 25 — Stale-while-revalidate send path:** Return a slightly stale cached winner immediately while refreshing in the background, eliminating synchronous probe latency entirely.
2. **Cycle 25 — Per-conversation provider/model pinning:** Let the user pin a model per chat thread; adaptive warmup only pre-warms and falls back within allowed boundaries.
3. **Cycle 25 — Failure-kind-aware volatility:** Record whether a cached-winner failure was auth, rate-limit, network, or context-length, and adjust TTL/interval differently per kind.
