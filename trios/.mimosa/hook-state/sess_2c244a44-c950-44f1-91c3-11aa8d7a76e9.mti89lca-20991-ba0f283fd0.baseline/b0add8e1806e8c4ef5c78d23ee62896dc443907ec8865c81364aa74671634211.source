# Cycle 24 Report — Persistent Volatility History for Adaptive Warmup

## Summary
Made the Cycle 23 adaptive warmup TTL/interval decisions survive app restarts by persisting `WarmupVolatilityTracker` windows to an encrypted JSON file alongside the encrypted `MemoryStore` database. The chat path already records cached-winner successes/failures; now those signals are durable across sessions instead of being reset to zero on every quit or update.

## Weak spots closed
1. **Restart amnesia.** `WarmupVolatilityTracker` previously kept its outcome windows only in actor-isolated memory. App restart wiped the failure-rate signal. Now `VolatilityHistoryStore` loads history at startup and saves after every recorded outcome.
2. **No visibility into learned history.** The Models tab showed cache freshness and failure rate but not whether any cross-session learning existed. Added a "Learning from N candidate(s)" indicator and a reset action.
3. **Binary outcome not enough (partially addressed).** The tracker still records success/failure, but the persisted record now carries a version and window size so future cycles can add failure-kind metadata without breaking existing snapshots.

## Competitor patterns applied
- **OpenRouter / Vercel AI Gateway:** production routers keep provider health signals across requests. TriOS now keeps its own per-endpoint volatility signal across sessions, giving a similar durable ranking input without relying on a cloud gateway.
- **LiteLLM:** deployment-level cooldowns and retry policies depend on accumulated failure state. Persisting volatility history lets TriOS compute adaptive TTL/interval the same way a stateful proxy would.
- **Zeph / Anyscale:** EMA and bandit routers learn over time. While TriOS still uses a simple bounded rolling window, persistence is the prerequisite for richer online learning in later cycles.

## Files changed
- **Created:**
  - `trios/rings/SR-00/VolatilityHistoryStore.swift` — encrypted JSON persistence for volatility records.
  - `trios/tests/TriOSKitTests/VolatilityHistoryStoreTests.swift` — round-trip, encryption, reset, corrupt-ciphertext handling.
- **Modified:**
  - `trios/rings/SR-00/WarmupVolatilityTracker.swift` — added `historyStore` injection, `loadHistory()`, async `record()` + `persist()`, `reset()`, stable candidate key, `hasHistory`, `learnedCandidateCount`.
  - `trios/rings/SR-00/ModelConfigurationStore.swift` — passes `VolatilityHistoryStore` into the tracker, loads history on init, exposes `hasWarmupVolatilityHistory`, `warmupVolatilityHistoryCount`, `resetWarmupVolatilityHistory()`.
  - `trios/BR-OUTPUT/ModelsTabView.swift` — shows learned-candidate count and a "Reset learning" button in the adaptive warmup section.
  - `trios/tests/TriOSKitTests/WarmupVolatilityTrackerTests.swift` — added persistence round-trip, mismatched-window-size discard, and reset-clears-disk tests.
  - `trios/.claude/plans/trios-cycle24-persistent-volatility-loop-024.md`.

## Key design decisions
1. **Single encrypted JSON blob keyed by stable candidate string.** Simpler than a schema migration and avoids mixing volatility telemetry with agent memory records. Migration is defensive: if parsing fails, history is discarded and relearned.
2. **Record stores outcome sequence newest-first plus window size.** This lets a future tracker reconstruct the exact bounded window on load. If the live tracker uses a different window size, the snapshot is ignored to avoid a mismatched signal.
3. **Async `record()` awaits persistence.** Avoids fire-and-forget Task races and gives tests deterministic round-trips. `ModelConfigurationStore.recordCachedWinnerOutcome` already awaited the tracker, so no call-site change was needed.
4. **Encryption via `TriOSEncryption(keyName: "warmup-volatility")`.** Reuses the existing Keychain-backed named-key stack; tests use `TriOSEncryption(keyURL:)` against temp files.
5. **File stored at `~/Library/Application Support/Trinity S3AI/AgentMemory/warmup-volatility.json.enc`.** Keeps encrypted runtime state alongside the encrypted MemoryStore database.

## Test results
- `bash build.sh` PASS (chat integration tests PASS).
- `cargo test --workspace` PASS (101 Rust tests pass).
- `cargo clippy --workspace` PASS.
- `cargo run --bin clade-audit` hard gates **0 findings**.
- `cargo run --bin clade-seal` **SEAL VALID**.
- `cargo run --bin clade-e2e` PASS.
- `open trios.app` relaunched; `/health` returns `{"status":"ok","cdpConnected":true}`; menu-bar logo present.
- `swift test` unavailable in this CommandLineTools-only environment; XCTest-style unit tests added and verified by compilation through the clade pipeline.

## Remaining weak spots
1. **Chat still blocks on synchronous warmup when no fresh cached winner exists.** Stale-while-revalidate would return a slightly stale winner immediately and refresh in the background.
2. **No per-conversation provider/model pinning.** Adaptive warmup and predictive selection still operate globally; a user can be silently switched to a model they did not expect for a specific thread.
3. **Failure signal is still binary.** Auth, rate-limit, network, and context-length failures are all treated the same. Future cycles can record failure kind and weight TTL/interval adjustments per kind.
4. **Persistence is not batched.** Every recorded outcome writes the whole snapshot. High-frequency usage could benefit from debounced batch writes.

## Next-loop variants (Cycle 25)
1. **Stale-while-revalidate send path** — return a slightly stale cached winner immediately while kicking off an async refresh; eliminates synchronous probe latency entirely.
2. **Per-conversation provider/model pinning** — let the user pin a provider/model per chat thread so adaptive warmup and predictive selection stay within allowed boundaries.
3. **Failure-kind-aware volatility** — record whether a cached-winner failure was auth, rate-limit, network, or context-length, and shrink/relax TTL/interval differently per kind.
