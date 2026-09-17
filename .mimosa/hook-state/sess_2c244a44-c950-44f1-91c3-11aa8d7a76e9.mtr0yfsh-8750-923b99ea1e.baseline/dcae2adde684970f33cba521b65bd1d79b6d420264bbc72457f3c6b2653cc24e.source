# Cycle 49 Plan — User-configurable LOGS tab noise profiles

> **Status:** Implemented and sealed on 2026-07-27.  
> **Report:** `.claude/plans/trios-cycle49-user-noise-profiles-report.md`

## Weak spot
After Cycle 48 the LOGS tab hides repetitive low-signal lines via a hard-coded `LogNoiseFilter`. This works for the known noisy events (`watchdog_heartbeat`, `drift_detected`, `Reclaiming stale task leases`), but it has three problems:

1. **No transparency** — the user cannot see which patterns are suppressed or why.
2. **No control** — a power user who wants to inspect heartbeats, or suppress a newly noisy pattern, must edit Swift source and rebuild.
3. **No learning signal** — the hard-coded list never improves from real usage, so the same server-side logging mistakes keep hiding behind a code change cycle.

## Competitor research summary
- **Datadog Log Patterns** auto-clusters messages, highlights constant vs. variable parts, and offers a one-click **Add Exclusion Filter** from the pattern side-panel. Excluded logs remain ingestable and can drive metrics.
- **Grafana Loki** provides LogQL `|>` / `!>` pattern operators and a **Patterns tab** with interactive **Include/Exclude** buttons, plus best-practice guidance to apply the most selective label matcher first.
- **Splunk** uses search-time filters, ingest actions, and Edge Processor pipelines to drop/mask events before indexing; the newer UI exposes regex-based filter and mask steps with live preview.

Common pattern across all three: **discover noisy lines → preview impact → add persistent exclusion rule → optionally still access suppressed lines on demand**.

## Three variants

### Variant A — Editable JSON profile (light)
Add a `LogNoiseProfile` Codable model stored at `.trinity/state/logs_noise_profile.json`. Expose a small settings sheet listing built-in + custom suppressions with per-pattern toggles and simple add/delete. Merge profile with the existing hard-coded defaults on load.

- **Pros:** Fastest to implement and test; full user control.
- **Cons:** User must manually type patterns; no contextual discovery from an actual noisy row.

### Variant B — Contextual "Hide events like this" with preview (medium)
Add a context menu to every log row: "Hide events like this". Derive a pattern from the row (event name if present, otherwise message stem / raw substring). Show a preview sheet with the count of currently loaded lines that would be hidden, plus editable pattern fields. Persist confirmed rules to a JSON profile and apply them via `LogNoiseFilter`.

- **Pros:** Best UX-to-effort ratio; matches Datadog/Loki one-click exclusion flow; teaches users what is being filtered.
- **Cons:** Slightly more UI work than a bare settings sheet.

### Variant C — Auto-pattern clustering + volume ranking (heavy)
Cluster loaded log lines by message structure, rank clusters by volume, and present a "Patterns" view where users can include/exclude clusters. Requires a local pattern-extraction algorithm.

- **Pros:** Most powerful; closest to Datadog/Loki.
- **Cons:** Large scope for one cycle; risk of over-engineering before user validation; pattern extraction on large files can be slow in SwiftUI main thread.

## Chosen variant
**Variant B (medium)** — contextual hide + preview. It directly addresses the weak spot, follows the proven competitor UX, and stays bounded enough to verify in one cycle.

## Decomposition
1. **Model** — add `LogNoiseProfile` (Codable, pattern rules with event/message/raw substring + enabled flag + id/label) and `LogNoiseProfileStore` actor that loads/saves JSON.
2. **Filter integration** — change `LogNoiseFilter` to accept a profile, merge hard-coded defaults with loaded user rules, and evaluate rules in order.
3. **Context menu** — add `.contextMenu` to `logRow` and `unifiedLogRow` with "Hide events like this".
4. **Pattern proposal** — add `LogNoisePatternProposer` that derives a rule from a `ParsedLogLine` (prefer event, then message stem, then raw substring).
5. **Preview sheet** — add `NoiseProfileEditSheet` showing proposed rule, editable fields, count of matching lines, list of sample lines, and Save/Cancel.
6. **Settings affordance** — add a small button to open a list of active rules so users can delete or disable them.
7. **Tests** — test store persistence, pattern proposal, profile merging, filtering with user rules, and preview counting.
8. **Gates** — `./build.sh`, `clade-build`, `clade-audit`, `clade-seal`, `clade-e2e`, `cargo test -p trios-mesh`, relaunch app.

## Acceptance criteria
- Build passes with 0 errors.
- clade-audit and clade-seal pass.
- A user can right-click a noisy row, see a proposed pattern, preview how many lines it hides, save it, and those lines disappear from the default Quiet view.
- Saved rules persist across app restarts.
- User can open a rule list to disable/delete saved rules.
- New unit tests compile and cover store + proposal + filtering.
- Menu-bar logo preserved after relaunch.

## Files expected to change
- `trios/rings/SR-02/LogParser.swift`
- `trios/BR-OUTPUT/LogsTabView.swift`
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`
