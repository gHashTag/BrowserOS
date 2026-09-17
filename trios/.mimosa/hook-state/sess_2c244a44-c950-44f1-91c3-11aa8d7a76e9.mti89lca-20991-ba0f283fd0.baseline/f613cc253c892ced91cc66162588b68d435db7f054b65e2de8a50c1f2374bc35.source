# Cycle 35 — Budget-Aware Draft Composer

## Weak spots of the current task
- After Cycle 34, each conversation can pin its own `requestedOutputTokens` and `contextWindowMargin`, but the composer shows the impact of those choices only **after** the user presses Send.
- A long draft can silently exceed the pinned context margin, causing an unexpected `.trimHistory` (history dropped) or `.tooLargeEvenEmpty` error only at send time.
- The existing `contextUtilizationPercent` in the composer reflects the **last sent** request, not the current unsent draft, so users have no pre-send feedback.
- There is no disabled-state guard that prevents sending a draft that is guaranteed to fail the "too large even empty" check.

## Competitor / prior-art observations
- ChatGPT/Claude web composers do **not** show real-time context-utilization badges; feedback appears only as post-send errors.
- Some local LLM frontends (e.g., Ollama Web UI, LM Studio) show token counts, but usually globally, not against a per-conversation margin.
- TriOS Cycle 27 already added post-send utilization badges and Cycle 34 added per-conversation margin pinning. Cycle 35 closes the loop by making the composer draft itself budget-aware.

## Decomposition
1. **Expose synchronous advertised profile** — make `ModelContextService.advertisedProfile(for:provider:)` public so the UI can compute a cheap, synchronous upper bound without waiting for learned-limit lookups.
2. **Add draft sizing helper** — extend `ChatRequestSizer` with a synchronous `draftContextUtilization(...)` static helper and a `DraftContextStatus` value type carrying `estimatedInputTokens`, `usableWindow`, `utilizationPercent`, and `isTooLarge`.
3. **Publish draft status from ChatViewModel** — add reactive `draftContextStatus`, `draftContextUtilizationPercent`, and `isDraftContextLimitExceeded` accessors that depend on `inputText`, `messages`, and the effective conversation margin.
4. **Render draft status in ChatPanelView** — add a compact pre-send indicator next to the existing output-budget control; use the same color bands (green/yellow/red) and a help tooltip that shows estimated tokens vs. usable window.
5. **Block guaranteed-failure sends** — disable the send button when `isDraftContextLimitExceeded` is true, matching the `tooLargeEvenEmpty` routing outcome.
6. **Add unit tests** — prove the draft sizing math, color thresholds, and "too large" flag with small, deterministic inputs.
7. **Run Trinity gates** — `build.sh`, `cargo test -p trios-mesh`, `clade-build`, `clade-audit`, `clade-seal`.
8. **Save experience** — write the episode JSON and update `.trinity/experience.md`.
9. **Produce three Cycle 36 options**.

## Files expected to change
- `trios/rings/SR-00/ModelContextService.swift`
- `trios/rings/SR-00/ChatRequestSizer.swift`
- `trios/rings/SR-02/ChatViewModel.swift`
- `trios/BR-OUTPUT/ChatPanelView.swift`
- `trios/tests/TriOSKitTests/ChatRequestSizerTests.swift`
- `trios/.claude/plans/trios-cycle35-budget-aware-draft-composer-report.md`
- `trios/.trinity/experience/2026-07-27_budget-aware-draft-composer-loop-035.json`
