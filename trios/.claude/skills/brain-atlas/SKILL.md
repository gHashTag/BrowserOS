---
name: brain-atlas
description: The Trinity S3AI brain map - 23 neuroanatomical modules and which trios subsystem plays each role. Use when deciding where a new supervisor capability belongs, when naming a component, or when the Queen is asked how her own architecture maps onto the brain model.
---

# Brain atlas: the S3AI map and what trios already implements

Source of truth: `~/trinity/docs/BRAIN_ATLAS.md` and `~/trinity/src/brain/*.zig`
(23 modules, Zig, v5.1). This skill is the bridge - it says which brain region
each part of the trios Queen already plays, and which regions have no organ yet.

## Why the mapping matters

The brain model is not decoration. It is a checklist of the functions any
autonomous swarm needs, written by neuroanatomy rather than by whoever happened
to be building that week. Reading trios against it is how missing organs get
noticed: the Queen had no observer for months, and "reticular formation" is
exactly the name for what was absent.

## Region -> trios organ

| Brain region | Function | trios implementation | State |
|--------------|----------|---------------------|-------|
| Prefrontal cortex | Executive decision, planning | `QueenDelegationPolicy`, `QueenSystemPrompt` | present |
| Basal ganglia | Action selection, prevents duplicate work | `QueenDelegationRegistry` one-live-task-per-issue, `conflictingTasks` | present |
| Reticular formation | Broadcast alerting, event bus | `TriosLogBus` + `TriosOTLPExporter` | present |
| Locus coeruleus | Arousal, exponential backoff | `NetworkRetrier`, provider circuit breaker | present |
| Amygdala | Emotional salience, prioritises urgent | `QueenDelegationPolicy.reviewQueue` attention-first ordering | partial - ordering only, no learned salience |
| Hippocampus (persistence) | Memory, JSONL replay | `.trinity/logs/trios-app.jsonl`, `MemoryStore` | present |
| Hippocampus (health history) | Health trend snapshots | `ModelReliabilityService` EMA scorecard | present |
| Cerebellum (learning) | Motor learning, failure prediction | `ModelReliabilityService` + `PredictiveWarmup` | partial - predicts model health, not task outcome |
| Thalamus | Sensory relay | `LogParser`, LOGS tab | present |
| Corpus callosum (telemetry) | Time-series aggregation | `TokenUsage`, `spentToday` | partial |
| Corpus callosum (federation) | Leader election, CRDT sync | `A2ARegistryClient`, trios-mesh | partial - registration, no CRDT |
| Intraparietal sulcus | Numerical processing | `TokenEstimator`, `ChatRequestSizer` | present |
| Microglia | Immune surveillance, prunes damage | `QueenObserver` + `reapStalledWorkers` | present as of WAVE-065/066 |
| Hypothalamus | Admin, maintenance | `LogRotationPolicy`, `AuditRotationScheduler`, `pruneArchive` | present |
| Metrics dashboard | Command centre | `QueenDashboardView`, `QueenCompactSupervisorBar` | present |
| Alerts | Critical notification | `SystemNoticeKind` severity + observer concerns | present |
| State recovery | Persistence across restart | `SessionRecoverySnapshotFactory` | present |
| Evolution simulation | Deterministic evolution scenarios | **none** | missing |
| Simulation | Deterministic replay for testing | **none** - e2e is scripted, not simulated | missing |

## The two missing organs

1. **Evolution simulation.** `~/trinity/src/brain/evolution_simulation.zig` runs
   deterministic scenarios with PPL trends and Byzantine fault injection, after
   FoundationDB and TigerBeetle. trios has nothing equivalent: every change is
   validated by one live run against one provider on one machine. That is why
   flaky failures took whole sessions to characterise.
2. **Learned salience.** The amygdala weights events by learned urgency. The
   Queen orders her review queue by age and state only, so a task that has
   failed three times looks exactly like one that has never run.

## Using this skill

- Before adding a supervisor capability, find its region. If the region is
  already implemented, extend that organ instead of growing a second one.
- If a capability maps to no region, say so explicitly - it may be a real gap in
  the model or a sign the capability is not needed.
- Do not claim the brain is "connected" to trios. It is a separate Zig program
  that does not currently build here, and its `tri` CLI name collides with the
  Railway CLI on this machine's PATH. This skill is a map, not a link.
