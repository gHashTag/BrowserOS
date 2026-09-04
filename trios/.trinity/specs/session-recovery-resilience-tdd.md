# Session Recovery Resilience — TDD Matrix

Task: `SESSION-RECOVERY-002`

## Build gates

| Command | Expected |
|---|---|
| `./build.sh` | zero exit, `trios.app` produced |
| `cargo run --bin clade-build` | zero exit, no new clade-audit hard gates |
| `cargo run --bin clade-e2e` | zero exit, screenshot captured |

## Swift unit / integration tests

| ID | Scenario | Expected |
|---|---|---|
| T1 | Export package, read manifest, verify every file matches SHA-256 | pass |
| T2 | Corrupt one file, import | throws `checksumMismatch`, names path |
| T3 | Delete manifest, import | throws `manifestFileMissing` |
| T4 | Save failure mid-import | zero new conversations in `UserDefaults` |
| T5 | Import same package twice, choose replace | conversation overwritten |
| T6 | Import same package twice, choose merge | messages appended, no duplicate IDs |
| T7 | Import same package twice, choose skip | original untouched |
| T8 | Export with >16 MiB log | placeholder note in archive, not full blob |
| T9 | Cancel export early | no partial destination archive |
| T10 | Manifest with unknown fields | imports successfully |
| T11 | Manifest with `minReaderVersion: 99` | throws `unsupportedSchemaVersion` |
| T12 | Duplicate detection default (no UI) | skips duplicate |

## UI / manual checklist

| ID | Action | Expected |
|---|---|---|
| U1 | Click Recovery → Export | save panel opens, defaults to `Trinity-Recovery-<date>-<uuid>.zip` |
| U2 | Export large session | determinate progress bar appears, Cancel stops export |
| U3 | Export finishes | Finder reveals archive, alert shows file count + size |
| U4 | Recovery → Import | open panel accepts `.zip` |
| U5 | Import corrupt zip | alert shows specific error, no local state change |
| U6 | Import package with duplicate conversations | sheet asks replace/merge/skip |
| U7 | Import large package | progress bar with Cancel, partial import cancels cleanly |
| U8 | After successful import | active conversation switches, history loaded, title normalized |
| U9 | Menu bar logo | still present after relaunch |

## L1-L7 law compliance

- L1 TRACEABILITY: commits reference the internal label `T27-EPIC-001` (never a leading `#`, never after a closing keyword; GitHub honors those only for numeric issue references).
- L2 GENERATION: spec is SSOT; code changes reviewed by Agent V.
- L3 PURITY: ASCII-only identifiers, English docs.
- L4 TESTABILITY: all build/e2e/tests pass.
- L5 IDENTITY: φ constants unchanged.
- L6 CEILING: no new UI SSOT files.
- L7 UNITY: no new `.sh` on critical path.
