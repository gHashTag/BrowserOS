---
name: clade-guard
domain: Kernel
agent: K
priority: P0
status: active
claim_id: CLADEGUARD-001
task_id: CLADEGUARD-001
issue: "#T27-EPIC-001"
---

# Spec: CladeGuard - Sovereign/Canary Health Monitor and Atomic Rollback

## Purpose

Monitor the health of the BrowserOS Agent server (Sovereign) and the canary instance. If Sovereign becomes persistently unhealthy after a boot grace period, atomically roll back to a previously verified snapshot. CladeGuard must never kill or restart the running trios process.

## Invariants

### INV-1: No Process Relaunch
CladeGuard must never kill, relaunch, or `Process()`-spawn trios. Rollback replaces the binary on disk only; a human or the clade-monitor watchdog decides when to restart.

### INV-2: Verified Snapshots Only
A snapshot is trusted only if its `.sha256` sidecar exists and matches the computed SHA-256 of the snapshot file. Missing or mismatched checksums reject the snapshot.

### INV-3: Atomic Replacement
Replacing the on-disk binary must use a temporary file next to the target and `FileManager.replaceItemAt(_:withItemAt:)` (or `NSFileCoordinator`) so the target path is never left without a runnable binary.

### INV-4: Boot Grace Period
Rollbacks are suppressed for `bootGracePeriod` seconds after `init` to avoid false positives during cold start.

### INV-5: Consecutive-Failure Threshold
At least `maxConsecutiveFailures` consecutive failed health checks must occur before rollback is considered.

### INV-6: Rollback Cooldown
Rollbacks cannot happen more frequently than `rollbackCooldown` seconds.

### INV-7: Snapshot Directory Inside Trinity
All snapshots live under `ProjectPaths.trinity/snapshots` so paths remain project-relative.

## Interface

```swift
@MainActor
final class CladeGuard: ObservableObject {
    init(sovereignHealthURL: URL?, canaryHealthURL: URL?, snapshotDir: String?)
    func startMonitoring(interval: TimeInterval)
    func stopMonitoring()
    func snapshotCurrentBinary() async
    func verifyChecksum(_ snapshotPath: String) -> Bool
    func emergencyRollback() async
    func bootProbe(timeoutSeconds: UInt64) async -> Bool
}
```

## Health Check Targets

| Target | Default URL | Source |
|---|---|---|
| Sovereign | `ProjectPaths.browserOSHealthURL` | `HealthCheckTransport` |
| Canary | `ProjectPaths.canaryHealthURL` | `HealthCheckTransport` |

## Rollback Decision Flow

1. Every `interval` seconds, check Sovereign and Canary health.
2. If Sovereign is healthy, reset `consecutiveFailures`.
3. If Sovereign is unhealthy, increment `consecutiveFailures`.
4. Skip rollback if still within `bootGracePeriod`.
5. Skip rollback if `consecutiveFailures < maxConsecutiveFailures`.
6. Skip rollback if `rollbackCooldown` has not elapsed since the last rollback.
7. Trigger rollback:
   - Prefer `lastSnapshotPath` if it exists and verifies.
   - Otherwise pick the newest snapshot in `snapshotDir` whose checksum verifies.
   - If no verified snapshot exists, log and abort.
8. Apply snapshot atomically to each target:
   - `ProjectPaths.triosBinary`
   - `ProjectPaths.appBundle/Contents/MacOS/trios`
9. Boot probe the current runtime's Sovereign health after replacement.

## Snapshot Format

- Binary: `trios_app-<ISO8601_timestamp>-<clade_id>`
- Checksum: `<binary_name>.sha256`
- Max retained snapshots: `maxSnapshots` (default 10)

## Tests

### T-1: Unit Tests
Create or extend `tests/swift/clade_guard_test.swift` covering:
- `verifyChecksum_missingSidecar_returnsFalse`
- `verifyChecksum_mismatch_returnsFalse`
- `verifyChecksum_matchingHash_returnsTrue`

### T-2: Build Pass
`./build.sh` must compile all Swift sources without errors.

### T-3: Rust Verification
`cargo test --workspace` and `cargo clippy --all-targets --all-features` must pass.

## Constraints

- ASCII-only source; English identifiers and comments.
- No hardcoded absolute paths (use `ProjectPaths`).
- No new shell scripts (L7 UNITY).
- Use `[weak self]` in `Timer` closures to avoid retain cycles.

## Change Flow

Any change to this spec or `BR-OUTPUT/CladeGuard.swift` must pass:

1. Spec update (this file).
2. t27-creator implementation.
3. t27-verifier L1-L7 verdict.
4. `/t27-tri-pipeline seal`.
5. Land with `Closes #T27-EPIC-001`.
6. `/t27-experience-save`.
