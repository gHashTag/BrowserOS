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

- normalized evidence covers every expected effect, not merely one relevant tool;
- transport, execution, and effect status are successful for the covered effects;
- every tool call has a terminal result (`success`, `error`, `denied`, or `aborted`);
- required verification has passed, or verification was explicitly not required by
  policy;
- the final response is consistent with the evidence ledger.

If any effect may already have occurred before a later failure, the terminal result
must retain `effectState: 'partial' | 'complete' | 'unknown'` and the applied evidence
IDs. Failure must never imply that all side effects were rolled back.

### 5.3 Truthfulness invariant

If the agent claims a side effect occurred, the ledger must contain matching evidence.
If it does not, the server must not emit or persist a successful terminal outcome.
Prose claim detection is defense-in-depth; the hard guarantee for a classified action
comes from the execution coordinator and terminal gate.

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

### 5.7 Authoritative terminal invariant

For action turns, client-visible success exists only after an authoritative structured
terminal outcome. A normal stream EOF, SDK `finish` chunk, or completed callback is not
success by itself. EOF without the authoritative outcome is an interrupted failure.

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

1. An explicit client contract may tighten intent to `action`, but it cannot downgrade
   a high-confidence server classification or observed action evidence to
   `conversational`.
2. Read-only/chat mode cannot be classified as a mutating action.
3. A high-precision deterministic classifier handles clear imperatives and completion
   requests such as editing, creating, deleting, running, deploying, or sending.
4. Ambiguous requests remain `auto`; tools stay available but are not forced.
5. A terminal side-effect claim triggers the truthfulness invariant even when the
   initial classifier returned conversational.

Request history and client classification are untrusted hints. Intent is monotonic
within a run: action evidence can promote intent, but nothing can demote a run after an
action tool is requested. The classifier must be conservative. A false negative may be
caught by the terminal claim validator; a false positive would force unnecessary
execution.

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

Start with a curated map for high-value BrowserOS and filesystem tools. Missing
metadata fails conservatively; complete metadata coverage for every integration is not
a prerequisite for the first enforcement rollout.

The SDK resolving a tool promise is only transport evidence. At every BrowserOS and
MCP adapter boundary, normalize the result into four independent dimensions:

```ts
type NormalizedToolResult = {
  transportStatus: 'received' | 'failed'
  executionStatus: 'success' | 'error' | 'denied' | 'aborted'
  effectStatus: 'none' | 'applied' | 'partial' | 'unknown'
  verificationStatus: 'not-run' | 'passed' | 'failed' | 'not-required'
}
```

BrowserOS `isError`, MCP error payloads, approval denial, abort, structured receipts,
and verifier results must be interpreted explicitly. Empty output or the literal
fallback `"Success"` is never proof that an effect occurred.

## 8. Per-turn execution state machine

Each user turn owns an `ExecutionRun`. The run is logically independent from the
long-lived agent, but it is stored in `AgentSession` so it survives approval
round-trips and is resumed only by a matching approval ID.

```ts
type ExecutionRun = {
  runId: string
  conversationId: string
  userMessageId: string
  intent: 'conversational' | 'action'
  expectedEffects: string[]
  phase: 'planned' | 'running' | 'verifying' | 'succeeded' | 'failed'
  waitingFor?: { kind: 'approval'; approvalId: string }
  attempt: 0 | 1
  evidence: EvidenceEvent[]
  failureReason?: 'denied' | 'aborted' | 'no-evidence' | 'execution-error'
  effectState: 'none' | 'partial' | 'complete' | 'unknown'
}
```

Allowed high-level transitions:

```text
planned(conversational) -> running -> succeeded
planned(action) -> running
  -> waitingFor(approval) -> running
  -> running(attempt=1)
  -> verifying -> succeeded
  -> failed(reason=denied|aborted|no-evidence|execution-error)
```

Invalid transitions are logged and rejected in tests. Denial and abort are terminal
failure reasons. `attempt: 1` represents retry without adding another phase.
The minimal state machine ships before enforcement because terminal gating, approval
continuation, retry budget, idempotency, and abort protection all depend on it.

## 9. Evidence ledger

Every structured tool event appends an immutable event to a per-turn ledger. Current
status is derived by folding events; prior events are never mutated:

```ts
type EvidenceEvent = {
  eventId: string
  toolCallId: string
  toolName: string
  kind: 'requested' | 'settled' | 'verification'
  effects: ToolEffect[]
  retrySafety: 'safe' | 'unsafe' | 'unknown'
  result?: NormalizedToolResult
  argumentDigest: string
  outputDigest?: string
  recordedAt: number
}
```

The ledger is operational evidence, not hidden reasoning. Sensitive raw arguments and
outputs remain governed by existing message persistence and redaction rules; telemetry
uses digests and safe metadata.

The ledger is server-owned and independent of AI SDK/UI messages. Structured history
may project safe facts into the model context, but rehydrated history can never satisfy
the current run's evidence requirements.

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

The guard cannot be an `onFinish`-only check because AI SDK text has already reached the
client by then. Introduce an `ExecutionCoordinator` at the stream boundary:

- conversational turns retain normal token streaming;
- action turns stream tool and progress events immediately but buffer terminal
  assistant prose for the current attempt;
- the coordinator withholds the SDK `finish` chunk;
- after validation it emits either the accepted buffered answer or a server-generated
  truthful failure;
- exactly one authoritative terminal outcome follows;
- only the accepted result is persisted.

This trades token-by-token terminal prose for truthful action completion. Tool progress
remains live. Unsupported first-attempt prose is never rendered, persisted, or included
as assistant history for retry.

## 11. Layer B — constrained recovery

### 11.1 Zero-tool retry

`ToolLoopAgent.prepareStep` cannot recover after a zero-tool final step. A retry is a
second model generation owned by `ExecutionCoordinator`, using the same run, abort
signal, and frozen reliability policy.

For an explicit or high-confidence action request whose first attempt produces no
structured invocation:

- append a short machine-generated instruction stating the required effect and that
  no action evidence was observed;
- narrow `activeTools` to tools whose capability metadata matches expected effects;
- use `toolChoice: 'required'` for the first retry step only when the candidate set is
  non-empty and all candidates are retry-safe;
- restore normal `toolChoice: 'auto'` after one relevant call;
- reuse the same `ExecutionRun` with `attempt: 1`;
- never retry after any unsafe/unknown mutating tool was requested.

Distinguish three cases:

- **no invocation:** retry may be allowed;
- **irrelevant invocation:** fail or correct without claiming success;
- **invocation without a terminal result:** fail with unknown effect state and never
  retry automatically.

If matching candidates are unknown or unsafe, keep `toolChoice: 'auto'` with the
corrective instruction or fail honestly. Denial, abort, approval suspension, or any
possibly applied effect disables retry.

If the retry still produces no relevant call, terminate as failed with a plain-language
message that no change was made.

### 11.2 Structured history transport

Extend `ChatRequestSchema` to accept a BrowserOS-owned versioned DTO under
`conversationHistoryV2`. Convert this stable wire format into the current AI SDK
representation only inside the server.

The V2 wire shape is frozen as complete turns containing atomic tool units:

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

type HistoricalToolOutcomeV2 =
  | { status: 'success'; output: JsonValue }
  | { status: 'error'; code?: string; message: string }
  | { status: 'denied'; reason?: string }
  | { status: 'aborted' }

type HistoricalAssistantPartV2 =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool-unit'
      callId: string
      toolName: string
      input: JsonValue
      outcome: HistoricalToolOutcomeV2
    }
  | { kind: 'error'; code?: string; message: string }

type ConversationHistoryV2 = {
  version: 2
  turns: Array<{
    turnId: string
    user: { messageId: string; text: string }
    assistant?: {
      messageId: string
      parts: HistoricalAssistantPartV2[]
      outcome?: ExecutionOutcome
    }
  }>
}
```

Pending approvals and non-terminal tool calls are active session state and are not
accepted as restored client history. Historical approval decisions are represented by
the terminal tool outcome.

Requirements:

- support text, tool-call, tool-result, approval, and error parts;
- validate tool-call/result IDs and roles;
- reject malformed or orphaned tool results;
- define explicit part/status enums and size limits in the JSON schema;
- preserve the legacy `previousConversation` path for old clients;
- prefer V2 when both are present;
- omit private reasoning entirely rather than flattening it into prose;
- cap size and binary payloads before acceptance.

Initial safety limits are 500 turns, 1,000 tool units, 256 KiB per text part,
512 KiB per tool input/output, and 5 MiB total serialized V2 history. Values live in
shared limits and are covered by boundary tests. Only JSON values are allowed; binary
payloads and non-finite numbers are rejected.

TriOS sends V2 history rather than embedding tool facts into assistant prose.

### 11.3 Atomic compaction

Replace message-count-only tool pruning with turn-aware compaction:

- segment history into complete user turns;
- bind each tool call to its result;
- retain recent complete turns, not arbitrary message boundaries;
- summarize old completed turns into a structured facts ledger;
- preserve current intent, unresolved errors, approvals, changed paths, commands,
  verification results, and pending tasks;
- never compact the active run, pending approval, unresolved tool unit, or verifier
  evidence;
- remove a tool unit only after its durable fact is represented in the summary;
- validate the compacted history before use.

The facts record is structured and validated outside the LLM summary. If a safe valid
representation cannot fit the context budget, fail context preparation explicitly
instead of silently dropping evidence.

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

If verification is required and no verifier exists, the run fails with the possibly
applied effects preserved. When policy explicitly marks verification `not-required`,
successful effect evidence may complete the run with
`verificationStatus: 'not-required'`.

### 12.2 Terminal result

The server produces an internal structured terminal result:

```ts
type ExecutionOutcome = {
  status: 'answered' | 'succeeded' | 'failed'
  failureReason?: 'denied' | 'aborted' | 'no-evidence' | 'execution-error'
  effectState: 'none' | 'partial' | 'complete' | 'unknown'
  verificationStatus: 'passed' | 'failed' | 'not-run' | 'not-required'
  summary: string
  evidenceIds: string[]
  retryCount: 0 | 1
}
```

For an action, `succeeded` means all expected effects are covered and verification
either passed or was explicitly not required. An execution error after a mutation is
`failed` with non-`none` effect state and applied evidence IDs.

The outcome is the authoritative record used for persistence, UI status, metrics, and
tests. Action terminal prose is released only after the outcome passes the gate.

## 13. Session execution fingerprint

Derive a stable fingerprint from every constructor-bound `AiSdkAgentConfig` input
rather than maintaining a partial hand-written list. It includes provider-specific
endpoint/resource/region/account identity, credential revision digest, model,
reasoning configuration, context-window size, system prompt, image support, mode,
origin, scheduled mode, declined/connected apps, working directory, tool set, approval
configuration, normalization behavior, and the frozen reliability level.

Raw secrets and reversible secret material are never logged or included directly. A
credential revision/version digest provides change detection.

When it changes, rebuild the agent while sanitizing and preserving compatible
structured history. Never reuse an old `ToolLoopAgent` merely because the
`conversationId` is unchanged. Fingerprint support ships before automatic retry so a
retry cannot execute against stale model or tool configuration.

## 14. Context-window propagation

TriOS must send the selected model's known context-window size. The server must:

- accept only finite integers from 4,096 through 2,000,000 tokens;
- use the supplied value for compaction;
- fall back to the existing provider/model configuration registry used by
  `providerTemplates.ts` and persisted provider settings;
- use the current 200k default only as the last fallback;
- log the source of the chosen value.

Precedence is request value -> persisted provider/model capability -> template
capability -> global default. Tests cover exact boundary values and reject invalid,
negative, fractional, or extreme inputs.

## 15. Streaming and UI behavior

Conversational token streaming remains unchanged. Action turns stream tool calls,
results, approvals, and progress immediately; only terminal assistant prose is held
until validation.

Reliability state uses valid AI SDK custom `data-execution` chunks. Transient parts
drive progress; the authoritative outcome is a non-transient data part or message
metadata:

- `started`
- `waiting-approval`
- `retrying`
- `verifying`
- `failed`
- `complete`

The UI translates them into understandable statuses. It must not display a green
success state before the authoritative terminal outcome arrives.

Retry text from a discarded zero-tool attempt must not be rendered as a second final
answer. It may be represented as a compact “retrying execution” status.

TriOS must parse the authoritative outcome and preserve `finishReason`. A transport EOF,
SDK finish, `streamComplete`, or `streamAborted` without that outcome cannot transition
an action to successful/idle. It becomes interrupted or failed. Older clients may
ignore progress chunks, but enforcement is enabled only after terminal-outcome
capability negotiation.

## 16. Approval, abort, and concurrency rules

- An active `ExecutionRun` is stored in the session with pending approval IDs. A later
  approval response may resume only the matching run; waiting for approval is
  suspension, not completion.
- Tool approval denial produces `failed(reason=denied)`; no automatic retry.
- User abort produces `failed(reason=aborted)`; pending tools are marked aborted.
- Browser and MCP adapters combine the request abort signal with their timeout signal
  (for example via `AbortSignal.any`) instead of replacing it.
- Once any tool starts, an abort records `effectState: unknown` unless evidence proves
  otherwise and prohibits retry.
- A late tool result after abort is recorded for diagnostics but cannot change the
  terminal outcome.
- Each user turn has one `runId`; duplicate completion callbacks are idempotent.
- A per-conversation turn lease rejects overlapping user turns with an explicit busy
  response; only the matching approval continuation bypasses the lease.
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

Primary new/expanded targets:

- `apps/server/tests/agent/execution-contract.test.ts`
- `apps/server/tests/agent/execution-retry.test.ts`
- `apps/server/tests/agent/execution-run.test.ts`
- `apps/server/tests/agent/structured-history.test.ts`
- `apps/server/tests/agent/session-fingerprint.test.ts`
- `apps/server/tests/agent/ai-sdk-agent.test.ts`
- `apps/server/tests/api/services/chat-service.test.ts`
- `apps/server/tests/api/types.test.ts`
- `apps/server/tests/agent/compaction.test.ts`
- `apps/server/tests/agent/compaction-e2e.test.ts`
- `trios/tests/TriOSKitTests/ChatRequestBuilderTests.swift`
- `trios/tests/TriOSKitTests/SSEEventParserTests.swift`
- `trios/tests/swift/ChatSSEEndToEndTest.swift`

Service streaming tests consume actual SSE response bytes. A mocked `onFinish` callback
alone cannot prove that unsupported prose was withheld from the client.

### 18.1 Unit tests

- explicit conversational requests can answer with zero tools;
- explicit action requests cannot succeed with zero tools;
- completion claims without evidence are blocked;
- one and only one zero-tool retry occurs;
- denial, abort, and unsafe-call cases never retry;
- tool capability filtering selects only relevant retry tools;
- state transitions reject invalid and duplicate transitions;
- evidence folding distinguishes transport, execution, effect, and verification
  status, including BrowserOS `isError`, MCP semantic errors, empty output, denial,
  abort, and late results;
- evidence ledger pairs call/result IDs and terminal statuses;
- every expected effect must be covered; irrelevant successful tools cannot satisfy
  action intent;
- execution fingerprint changes for every execution-relevant config field;
- context-window fallback precedence is deterministic.

### 18.2 Protocol tests

- V2 history round-trips text, tool calls, results, errors, and approvals;
- malformed/orphaned, duplicate/conflicting, non-terminal, reasoning, binary, and
  oversized parts are rejected before agent invocation;
- old `previousConversation` clients remain supported;
- V2 takes precedence without double-injecting history;
- binary and oversized parts are bounded.

### 18.3 Compaction tests

- a tool call/result unit is preserved or removed atomically;
- every compaction stage, including sliding window, pruning, reduction, and
  summarization, runs the structural validator;
- multi-call/multi-result messages retain exact matching IDs;
- active runs, pending approvals, failures, and unfinished work remain pinned;
- a structurally changed prune result is applied even when message count is unchanged;
- fixtures use deterministic matching call/result IDs and an invariant helper checks
  every surviving unit;
- a success claim cannot survive without a corresponding durable fact;
- unresolved failures and pending work survive compaction;
- recent turns are kept as complete turns;
- repeated compaction remains valid and idempotent.

### 18.4 Service and streaming tests

- successful action transitions through execution and verification;
- zero-tool attempt emits one retry status and one terminal answer;
- actual SSE bytes contain no discarded first-attempt success prose and exactly one
  authoritative terminal outcome;
- failed retry persists a truthful failure, not discarded success prose;
- approval denial, abort, late results, and duplicate callbacks are safe;
- overlapping turns are rejected while matching approval continuation resumes;
- pre-stream exception and every terminal path release the turn lease and clean up
  hidden pages;
- session rebuilds on model/provider/endpoint/context changes;
- hidden-page cleanup occurs for every terminal path.

### 18.5 Swift tests

- `conversationHistoryV2` contains structured tool parts;
- actual model context size is sent;
- legacy compatibility can be feature-flagged;
- `data-execution` events and authoritative outcomes map to stable UI states;
- `finishReason` is retained;
- EOF, abort, or transport completion without an authoritative action outcome cannot
  become idle success.

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
- response wire contains 0 bytes of discarded success prose;
- 0 retries after denial, abort, or potentially completed unsafe mutation;
- 100% session rebuilds for fingerprint changes;
- repeated live-model evaluation reports `pass^1`, `pass^3`, and `pass^8`;
  rollout thresholds are set from the recorded baseline rather than invented.

The live metric `pass^k` is the fraction of tasks for which all `k` independent,
environment-reset trials pass their state verifier. Record sample count, task/model
seed, fingerprint, per-trial result, and confidence interval. Deterministic invariants
remain 100%; live rollout thresholds are frozen only after a baseline run.

## 19. Delivery waves

### Wave 1 — shared safety foundation

- per-conversation turn lease;
- request abort propagation through BrowserOS/MCP tools;
- minimal persistent `ExecutionRun` and immutable evidence ledger;
- tool capability metadata foundation;
- normalized tool result semantics;
- complete session fingerprint;
- observe-only outcomes and metrics;
- focused unit/service tests.

### Wave 2 — A: truthful terminal guard

- intent/action contract;
- action-turn stream coordinator and terminal-text buffer;
- authoritative outcome protocol and TriOS parsing;
- unsupported-claim/no-evidence enforcement for explicit actions;
- metrics;
- wire-level streaming and UI state tests.

### Wave 3 — B1: durable history

- BrowserOS-owned versioned structured history schema;
- Swift V2 serialization;
- server rehydration and validation;
- compatibility tests.

### Wave 4 — B2: safe compaction

- turn/tool-unit segmentation;
- structured durable facts;
- semantic compaction invariants;
- repeated-compaction tests.

### Wave 5 — B3: constrained retry

- second-generation retry coordinator;
- safe matching-tool selection;
- denial/abort/unsafe protections;
- retry progress state;
- integration tests.

### Wave 6 — C: verified execution and evaluation

- verifier mapping;
- context-window propagation;
- pass^k state-based evaluation harness;
- full end-to-end regression matrix.

### Wave 7 — review and reusable skill

- full targeted and regression test runs;
- independent code review;
- before/after report;
- rollout/rollback documentation;
- save the verified debugging, evaluation, and implementation workflow as a reusable
  project skill.

## 20. Rollout and rollback

Use one monotonic server reliability level:

```text
off -> observe -> enforce -> retry -> verified
```

Freeze the level at run start. Keep emergency retry and verifier kill switches. Treat
`historyV2` as a separately negotiated protocol capability, not a freely combinable
behavior flag.

Recommended rollout:

1. run the foundation and terminal classification in observe mode;
2. negotiate authoritative outcomes and V2 history with TriOS;
3. enforce unsupported-success blocking for explicit action contracts;
4. enable atomic compaction;
5. enable bounded retry;
6. enable domain verifiers and verified level;
7. remove legacy behavior only after compatibility evidence.

Rollback disables individual layers without removing stored V2 history. Readers must
remain backward-compatible throughout the rollout.

## 21. Primary code areas

- `packages/browseros-agent/apps/server/src/api/types.ts`
- `packages/browseros-agent/apps/server/src/api/services/chat-service.ts`
- `packages/browseros-agent/apps/server/src/agent/ai-sdk-agent.ts`
- `packages/browseros-agent/apps/server/src/agent/tool-adapter.ts`
- `packages/browseros-agent/apps/server/src/agent/message-validation.ts`
- `packages/browseros-agent/apps/server/src/agent/session-store.ts`
- `packages/browseros-agent/apps/server/src/agent/compaction.ts`
- `packages/browseros-agent/apps/server/src/agent/compaction/*`
- `packages/browseros-agent/apps/server/src/tools/response.ts`
- `packages/browseros-agent/apps/agent/entrypoints/sidepanel/index/useExecutionHistoryTracker.ts`
- `packages/browseros-agent/packages/shared/src/constants/limits.ts`
- `trios/rings/SR-01/ChatEvents.swift`
- `trios/rings/SR-02/ChatViewModel.swift`
- `trios/rings/SR-02/UIMessageStreamParser.swift`
- `trios/rings/SR-02/ConversationStateMachine.swift`
- `trios/rings/SR-02/ChatMessage.swift`
- `trios/BR-OUTPUT/ChatPanelView.swift`
- corresponding TypeScript and Swift test targets.

New modules should be small and responsibility-focused, for example:

- `execution-contract.ts`
- `execution-run.ts`
- `execution-evidence.ts`
- `execution-coordinator.ts`
- `execution-terminal-gate.ts`
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
