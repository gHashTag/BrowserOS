# Cycle 50 Plan — Per-Source Noise Profiles

**Prompt:** "исследуй слабые места задачи, исследуй конкурентов по теме, создай декомпозированный план и реализуй все и в конце отчет и три варианта"  
**Closes:** gHashTag/trios#1084

## 1. Weak spot

Cycle 49 noise rules are **global**: the same event/message substring matches across every log source. In practice `browseros-companion.log`, `queen.log`, `cron.log`, and `event-log.jsonl` have different signal/noise definitions. Users cannot say "this pattern is noise only in companion logs".

## 2. Competitor research

| Product | Per-source / per-stream scoping | UX pattern |
|---|---|---|
| **Datadog** | Agent `log_processing_rules` placed under a log entry with `source:`/`service:`; index exclusion filters built from `source:`, `host:`, `service:` facets. | Scope by source/service/host in config or query. |
| **Grafana Loki** | Stream selector `{app="api", env="prod"}` combined with `!=`, `!~`, or `!>` pattern filters; Adaptive Logs drop rules include `stream_selector`. | Scope by label selector, then silence pattern. |
| **Splunk** | `props.conf` / `transforms.conf` stanzas like `host::` and `source::`; macros and filter macros per detection. | Scope transform by host/source metadata. |

Common pattern: **metadata scoping + content pattern**. TriOS lacks the metadata scoping layer.

## 3. Chosen variant

**Road B — Add optional `sourceIDs` scope to `LogNoiseRule`, default global, contextual action pre-fills the source.**

Reasons:
- Minimal backward-incompatible change (optional field).
- No backend or persistence format break.
- Builds directly on Cycle 49 model, filter, store, and sheet.
- Small, reviewable diff.

## 4. Decomposition

1. **Data model** — add `sourceIDs: [String]?` to `LogNoiseRule`; add `applies(toSourceID:)`; update `init`; ensure migration-safe decoding.
2. **Filter** — `LogNoiseFilter.matches` checks source scope before event/message/raw.
3. **Proposer** — `LogNoisePatternProposer.propose(from:sourceID:)` pre-fills scope.
4. **UI** — pass `availableSources` to `NoiseProfileSheet`; add source-scope menu in rule editor; update context menu to pass `line.sourceID`; show scope in preview card.
5. **Tests** — source-scoped filtering, global fallback, proposer, legacy JSON decoding, `filterNoise` integration.
6. **Verification** — clade-build, clade-e2e, clade-audit, clade-seal, cargo test -p trios-mesh, relaunch trios.app.

## 5. Spec

See `.trinity/specs/per-source-noise-profiles.md`.
