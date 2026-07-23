# Agent Tool Reliability: truthful execution, durable history, and verified outcomes

**Status:** Proposed for implementation
**Date:** 2026-07-24
**Scope:** BrowserOS agent server and TriOS Swift chat client
**Decision:** Implement all three reliability layers as one progressive system:

1. **A — Fail-closed guard:** never accept an unsupported claim of completed work.
2. **B — Reliable execution path:** one constrained retry, structured history, and safe compaction.
3. **C — Explicit execution state:** evidence-backed terminal outcomes and state-based verification.

## 1. Problem statement

The tools are present and callable in a fresh BrowserOS agent session, but a long or
restored conversation can degrade into text-only narration. The model may claim it
edited files, ran commands, or verified a build without producing a structured tool
call. The current server accepts such a turn as successful.

The failure is caused by a pipeline mismatch rather than a missing toolbox:

- TriOS constructs a rich `messages` history containing tool calls and results.
- `ChatRequestSchema` does not accept `messages`, so only the legacy flattened
  `previousConversation` reaches the server.
- New server sessions rehydrate that history as user/assistant text parts.
- compaction may remove old tool calls while leaving later assistant narration.
- `onFinish` persists the result without checking whether an action request produced
  execution evidence.
- an existing session is not rebuilt when provider, model, endpoint, reasoning
  configuration, or context-window size changes.

This creates a dangerous invariant violation:

> A terminal success claim can exist without a successful action and without a
> verification result.

## 2. Goals

1. Preserve normal text-only answers for genuinely conversational requests.
2. For action requests, require structured execution evidence before success.
3. Retry a zero-tool action turn at most once with a constrained tool set.
4. Fail honestly if execution still does not happen.
5. Preserve tool-call/result pairs across restart and compaction.
6. Rebuild sessions whenever execution-relevant model configuration changes.
7. Expose enough state and metrics to reproduce and measure failures.
8. Validate reliability through final environment state, not response wording.
9. Roll out safely without breaking streaming, approvals, aborts, or old clients.

## 3. Non-goals

- Requiring a tool call for every user message.
- Treating a model's prose plan as proof that work occurred.
- Guaranteeing that every arbitrary third-party tool has a domain-specific verifier
  in the first rollout.
- Replacing the AI SDK or rewriting the whole chat protocol at once.
- Persisting hidden chain-of-thought.
- Silently repeating irreversible external actions.

## 4. Scientific and engineering basis

The design follows five evidence-backed principles:

1. **Judge final state, not persuasive text.** τ-bench demonstrates that tool-agent
   success must be measured against environment state and repeated trials.
2. **Long context is not reliable memory.** Lost in the Middle shows that retrieval
   quality degrades depending on information position in long prompts.
3. **The agent-computer interface is part of the agent.** SWE-agent reports large
   gains from an interface designed for model interaction.
4. **Compress selectively.** Research on context compression for tool-using models
   supports keeping critical tool names and parameters verbatim while reducing bulky
   output.
5. **Evaluate relevance and hallucination explicitly.** BFCL-style cases distinguish
   valid tool use, missing tool use, and unsupported or irrelevant calls.

Primary sources:

- https://arxiv.org/abs/2406.12045
- https://aclanthology.org/2024.tacl-1.9.pdf
- https://papers.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf
- https://proceedings.iclr.cc/paper_files/paper/2024/file/28e50ee5b72e90b50e7196fde8ea260e-Paper-Conference.pdf
- https://aclanthology.org/2024.findings-acl.974.pdf
- https://gorilla.cs.berkeley.edu/leaderboard

## 5. Core invariants

These invariants are normative and must be enforced by tests.

### 5.1 Conversational invariant

A conversational request may finish with text and zero tool calls. The system must
not force a meaningless tool call merely to satisfy a counter.

### 5.2 Action invariant

An action request may finish as `succeeded` only when:

- at least one relevant action tool completed successfully;
- every tool call has a terminal result (`success`, `error`, `denied`, or `aborted`);
- required verification has completed, or the response explicitly labels the result
  as unverified;
- the final response is consistent with the evidence ledger.

### 5.3 Truthfulness invariant

If the agent claims a side effect occurred, the ledger must contain matching evidence.
If it does not, the server must not emit or persist a successful terminal outcome.

### 5.4 Atomic history invariant

A tool call and its result are one logical unit. Rehydration, sanitization, truncation,
and compaction must preserve or remove the unit atomically.

### 5.5 Retry invariant

An automatic retry:

- is permitted only for a retry-safe failure such as a zero-tool action attempt;
- happens at most once per user turn;
- cannot repeat an irreversible call that may already have succeeded;
- is visible in telemetry;
- cannot convert denial or abort into a retry.

### 5.6 Configuration invariant

A session can be reused only when its execution fingerprint matches the current
request.

## 6. Request contract and intent classification

Add an optional backward-compatible request field:

```ts
executionContract?: {
  intent: 'auto' | 'conversational' | 'action'
  expectedEffects?: Array<
    | 'read'
    | 'filesystem-change'
    | 'command-execution'
    | 'browser-change'
    | 'external-change'
  >
  verification?: 'auto' | 'required' | 'not-required'
}
```

Old clients behave as `intent: 'auto'`.

### 6.1 Classification precedence

1. An explicit client contract wins.
2. Read-only/chat mode cannot be classified as a mutating action.
3. A high-precision deterministic classifier handles clear imperatives and completion
   requests such as editing, creating, deleting, running, deploying, or sending.
4. Ambiguous requests remain `auto`; tools stay available but are not forced.
5. A terminal side-effect claim triggers the truthfulness invariant even when the
   initial classifier returned conversational.

The classifier must be conservative. A false negative can still be caught by the
terminal claim validator; a false positive would force unnecessary execution.

## 7. Tool capability metadata

Reliability must not depend on scattered string-prefix checks. Introduce a central
capability descriptor for registered tools:

```ts
type ToolEffect =
  | 'observe'
  | 'filesystem-read'
  | 'filesystem-write'
  | 'command'
  | 'browser-write'
  | 'external-write'
  | 'verify'

type ToolReliabilityMetadata = {
  effects: ToolEffect[]
  retrySafety: 'safe' | 'unsafe' | 'unknown'
  verificationRole?: 'evidence' | 'verifier'
}
```

Existing tools receive metadata at registration. Unknown MCP tools default to
`retrySafety: 'unknown'` and are never automatically repeated after invocation.

## 8. Per-turn execution state machine

Each user turn owns an `ExecutionRun`. It is independent from the long-lived agent
session.

```ts
type ExecutionPhase =
  | 'received'
  | 'classified'
  | 'executing'
  | 'awaiting-approval'
  | 'verifying'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'aborted'

type ExecutionRun = {
  runId: string
  conversationId: string
  userMessageId: string
  intent: 'conversational' | 'action'
  expectedEffects: string[]
  phase: ExecutionPhase
  retryBudget: 0 | 1
  evidence: ToolEvidence[]
  terminalReason?: string
}
```

Allowed high-level transitions:

```text
received
  -> classified(conversational)
      -> succeeded
  -> classified(action)
      -> executing
          -> awaiting-approval -> executing
          -> verifying -> succeeded
          -> retrying -> executing
          -> failed | denied | aborted
```

Invalid transitions are logged and rejected in tests. Denial and abort are terminal.

## 9. Evidence ledger

Every structured tool event updates an append-only per-turn ledger:

```ts
type ToolEvidence = {
  toolCallId: string
  toolName: string
  effects: ToolEffect[]
  retrySafety: 'safe' | 'unsafe' | 'unknown'
  status: 'requested' | 'success' | 'error' | 'denied' | 'aborted'
  argumentDigest: string
  outputDigest?: string
  startedAt: number
  finishedAt?: number
}
```

The ledger is operational evidence, not hidden reasoning. Sensitive raw arguments and
outputs remain governed by existing message persistence and redaction rules; telemetry
uses digests and safe metadata.

## 10. Layer A — fail-closed terminal guard

Before a turn is accepted as successful:

1. Count and classify structured tool evidence.
2. Compare it with the intent and expected effects.
3. Inspect the proposed terminal response for completion claims.
4. Apply the core invariants.

Outcomes:

- conversational + no side-effect claim: accept text response;
- action + sufficient evidence: proceed to verification/terminal success;
- action + zero tool calls + retry budget available: invoke Layer B retry;
- unsupported completion claim: suppress successful completion and produce a
  structured truthful failure;
- denied/aborted: preserve that terminal state without retry.

The guard runs before final session persistence so unsupported success cannot poison
future history.

## 11. Layer B — constrained recovery

### 11.1 Zero-tool retry

For an action request whose first attempt produces no tool call:

- append a short machine-generated instruction stating the required effect and that
  no action evidence was observed;
- narrow `activeTools` to tools whose capability metadata matches expected effects;
- use `toolChoice: 'required'` for the first retry step only;
- restore normal `toolChoice: 'auto'` after one relevant call;
- reuse the same `ExecutionRun` and decrement `retryBudget`;
- never retry after any unsafe/unknown mutating tool was requested.

If the retry still produces no relevant call, terminate as failed with a plain-language
message that no change was made.

### 11.2 Structured history transport

Extend `ChatRequestSchema` to accept AI-SDK-compatible structured messages under a
versioned field such as `conversationHistoryV2`.

Requirements:

- support text, tool-call, tool-result, approval, and error parts;
- validate tool-call/result IDs and roles;
- reject malformed or orphaned tool results;
- preserve the legacy `previousConversation` path for old clients;
- prefer V2 when both are present;
- never persist private chain-of-thought;
- cap size and binary payloads before acceptance.

TriOS sends V2 history rather than embedding tool facts into assistant prose.

### 11.3 Atomic compaction

Replace message-count-only tool pruning with turn-aware compaction:

- segment history into complete user turns;
- bind each tool call to its result;
- retain recent complete turns, not arbitrary message boundaries;
- summarize old completed turns into a structured facts ledger;
- preserve current intent, unresolved errors, approvals, changed paths, commands,
  verification results, and pending tasks;
- remove a tool unit only after its durable fact is represented in the summary;
- validate the compacted history before use.

## 12. Layer C — verified outcomes

### 12.1 Verification policy

`verification: 'required'` means a mutating task cannot become `succeeded` without
verifier evidence.

Initial verifier mapping:

- filesystem change -> read/stat/diff evidence for affected paths;
- command execution -> captured exit status;
- build/test request -> successful requested command and exit status;
- browser change -> post-action browser observation when supported;
- external mutation -> tool success receipt or provider identifier.

If no verifier exists, the result may be reported as `completed-unverified`, but never
as verified success.

### 12.2 Terminal result

The server produces an internal structured terminal result:

```ts
type ExecutionOutcome = {
  status:
    | 'answered'
    | 'succeeded'
    | 'completed-unverified'
    | 'failed'
    | 'denied'
    | 'aborted'
  summary: string
  evidenceIds: string[]
  retryCount: 0 | 1
}
```

The visible assistant text is streamed normally, but the outcome is the authoritative
record used for persistence, UI status, metrics, and tests.

## 13. Session execution fingerprint

Add a stable fingerprint containing:

- provider;
- model;
- base URL / upstream provider;
- reasoning configuration that changes provider behavior;
- context-window size;
- chat/agent mode;
- working directory;
- MCP tool set;
- approval configuration;
- relevant feature flags.

When it changes, rebuild the agent while sanitizing and preserving compatible
structured history. Never reuse an old `ToolLoopAgent` merely because the
`conversationId` is unchanged.

## 14. Context-window propagation

TriOS must send the selected model's known context-window size. The server must:

- validate reasonable bounds;
- use the supplied value for compaction;
- fall back to a provider/model registry value;
- use the current 200k default only as the last fallback;
- log the source of the chosen value.

## 15. Streaming and UI behavior

The existing token stream remains responsive. Reliability state is exposed through
small structured events:

- `execution-started`
- `execution-retrying`
- `execution-verifying`
- `execution-failed`
- `execution-complete`

The UI translates them into understandable statuses. It must not display a green
success state before the authoritative terminal outcome arrives.

Retry text from a discarded zero-tool attempt must not be rendered as a second final
answer. It may be represented as a compact “retrying execution” status.

## 16. Approval, abort, and concurrency rules

- Tool approval denial transitions to `denied`; no automatic retry.
- User abort transitions to `aborted`; pending tools are marked aborted.
- A late tool result after abort is recorded for diagnostics but cannot change the
  terminal outcome.
- Each user turn has one `runId`; duplicate completion callbacks are idempotent.
- Concurrent requests for one conversation are serialized or rejected explicitly.
- Retrying never bypasses approval configuration.
- Hidden-page cleanup executes for all terminal states.

## 17. Observability

Add structured metrics and safe logs:

- `agent_action_turn_total`
- `agent_zero_tool_action_total`
- `agent_zero_tool_retry_total`
- `agent_false_success_blocked_total`
- `agent_execution_outcome_total{status}`
- `agent_history_v2_rejected_total{reason}`
- `agent_compaction_tool_units_preserved`
- `agent_compaction_orphan_tool_parts_total`
- `agent_session_rebuild_total{reason}`

Every log includes `conversationId`, `runId`, model fingerprint hash, intent, retry
count, evidence count, and terminal reason, but not sensitive raw arguments.

## 18. Test strategy

Implementation is test-driven. No production behavior is changed before a failing
test demonstrates the expected contract.

### 18.1 Unit tests

- explicit conversational requests can answer with zero tools;
- explicit action requests cannot succeed with zero tools;
- completion claims without evidence are blocked;
- one and only one zero-tool retry occurs;
- denial, abort, and unsafe-call cases never retry;
- tool capability filtering selects only relevant retry tools;
- state transitions reject invalid and duplicate transitions;
- evidence ledger pairs call/result IDs and terminal statuses;
- execution fingerprint changes for every execution-relevant config field;
- context-window fallback precedence is deterministic.

### 18.2 Protocol tests

- V2 history round-trips text, tool calls, results, errors, and approvals;
- malformed/orphaned parts are rejected;
- old `previousConversation` clients remain supported;
- V2 takes precedence without double-injecting history;
- binary and oversized parts are bounded.

### 18.3 Compaction tests

- a tool call/result unit is preserved or removed atomically;
- a success claim cannot survive without a corresponding durable fact;
- unresolved failures and pending work survive compaction;
- recent turns are kept as complete turns;
- repeated compaction remains valid and idempotent.

### 18.4 Service and streaming tests

- successful action transitions through execution and verification;
- zero-tool attempt emits one retry status and one terminal answer;
- failed retry persists a truthful failure, not discarded success prose;
- approval denial, abort, late results, and duplicate callbacks are safe;
- session rebuilds on model/provider/endpoint/context changes;
- hidden-page cleanup occurs for every terminal path.

### 18.5 Swift tests

- `conversationHistoryV2` contains structured tool parts;
- actual model context size is sent;
- legacy compatibility can be feature-flagged;
- execution-state stream events map to stable UI states.

### 18.6 End-to-end reliability suite

Scenarios run in fresh, long, compacted, restarted, and model-switched conversations:

- inspect a file and answer;
- edit a file and verify exact content;
- run a passing and a failing command;
- request an action and simulate a zero-tool model response;
- deny approval and abort mid-tool;
- switch model and endpoint mid-conversation;
- compact history multiple times, then continue the task.

Acceptance:

- 0 unsupported success outcomes in deterministic test fixtures;
- 0 orphaned tool-call/result parts after compaction;
- exactly 1 retry for zero-tool action fixtures;
- 0 retries after denial, abort, or potentially completed unsafe mutation;
- 100% session rebuilds for fingerprint changes;
- repeated live-model evaluation reports `pass^1`, `pass^3`, and `pass^8`;
  rollout thresholds are set from the recorded baseline rather than invented.

## 19. Delivery waves

### Wave 1 — A: truthful terminal guard

- intent/action contract;
- tool capability metadata foundation;
- evidence ledger;
- zero-tool and unsupported-claim terminal guard;
- metrics;
- focused unit/service tests.

### Wave 2 — B1: constrained retry

- retry budget;
- first retry step with matching tools required;
- denial/abort/unsafe protections;
- streaming retry state;
- integration tests.

### Wave 3 — B2: durable history

- versioned structured history schema;
- Swift V2 serialization;
- server rehydration and validation;
- compatibility tests.

### Wave 4 — B3: safe compaction

- turn/tool-unit segmentation;
- structured durable facts;
- semantic compaction invariants;
- repeated-compaction tests.

### Wave 5 — C: state and verification

- full per-turn state machine;
- verifier mapping;
- authoritative structured outcome;
- UI status integration;
- concurrency and idempotency tests.

### Wave 6 — configuration and evaluation

- execution fingerprint;
- context-window propagation;
- pass^k state-based evaluation harness;
- operational diagnostics for duplicate local model daemons.

### Wave 7 — review and reusable skill

- full targeted and regression test runs;
- independent code review;
- before/after report;
- rollout/rollback documentation;
- save the verified debugging, evaluation, and implementation workflow as a reusable
  project skill.

## 20. Rollout and rollback

Use additive protocol changes and server flags:

- `agentExecutionGuard`
- `agentZeroToolRetry`
- `structuredHistoryV2`
- `atomicToolCompaction`
- `verifiedExecutionOutcome`

Recommended rollout:

1. guard in observe-only mode to establish a baseline;
2. block unsupported success for internal/TriOS traffic;
3. enable retry;
4. enable V2 history;
5. enable atomic compaction;
6. enable authoritative state machine and verification;
7. remove legacy behavior only after compatibility evidence.

Rollback disables individual layers without removing stored V2 history. Readers must
remain backward-compatible throughout the rollout.

## 21. Primary code areas

- `packages/browseros-agent/apps/server/src/api/types.ts`
- `packages/browseros-agent/apps/server/src/api/services/chat-service.ts`
- `packages/browseros-agent/apps/server/src/agent/ai-sdk-agent.ts`
- `packages/browseros-agent/apps/server/src/agent/session-store.ts`
- `packages/browseros-agent/apps/server/src/agent/compaction.ts`
- `packages/browseros-agent/apps/server/src/agent/compaction/*`
- `packages/browseros-agent/packages/shared/src/constants/limits.ts`
- `trios/rings/SR-02/ChatViewModel.swift`
- `trios/BR-OUTPUT/ChatPanelView.swift`
- corresponding TypeScript and Swift test targets.

New modules should be small and responsibility-focused, for example:

- `execution-contract.ts`
- `execution-run.ts`
- `execution-evidence.ts`
- `execution-terminal-guard.ts`
- `tool-reliability-metadata.ts`
- `structured-history.ts`

Exact placement is finalized by the implementation plan after spec review.

## 22. Definition of done

The work is complete only when:

- all normative invariants have automated tests;
- action requests cannot report success without matching evidence;
- conversational requests remain tool-optional;
- retry behavior is bounded and safe;
- V2 history survives restart;
- compaction cannot orphan a tool call or result;
- config changes rebuild sessions;
- context size is propagated and observable;
- approval, abort, streaming, and cleanup regressions pass;
- state-based live evaluation results are recorded;
- an independent review has no unresolved critical findings;
- the final report and reusable skill are saved.
